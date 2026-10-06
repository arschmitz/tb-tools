import { setLiveText, replaceChangedChildren, hasSelectedText } from "./live-text.js";
import { createReviewHandledButton } from "./review-handled.js";
import { registerAiTaskDialog, enableTaskNotifications } from "./ai-task-tray.js";
import { createReviewAttentionScroller } from "./review-attention.js";
import { INTERACTIVE, graphStates } from "./config.js";
import { startOrResumePatchSession } from "./patch-session-resume.js";
import { createCodexRunStatus } from "./codex-run-status.js";
import { applyGraphSnapshot, getLoadedGitCommitLimit } from "./command-sessions.js";
import { appendInlineReviewComment, findReviewLine } from "./review-viewer.js";

const dialog = document.getElementById("patch-review-dialog");
const runStatus = createCodexRunStatus(dialog);
const taskView = registerAiTaskDialog({ kind: "review", dialog, title: value => `${value.revision} Review`,
  restore: restorePatchReviewTask, onUpdate: renderSession,
  recover: task => openPatchReviewDialog({ patch: { id: task.revision }, graphIndex: task.graphIndex, mode: task.mode }),
});
let viewGeneration = 0;
const title = dialog?.querySelector(".patch-review-title");
let reviewLinkContext = {};
function renderReviewLinks(value, reset = false) {
  if (reset) {
    reviewLinkContext = {};
    dialog.querySelector(".review-handled-toggle")?.remove();
  }
  const revision = value.revision || value.id || "";
  const bugId = value.bugId || value.title?.match(/\bBug\s+(\d+)/i)?.[1];
  if (revision) reviewLinkContext.revision = revision;
  if (/^D[1-9]\d*$/.test(revision) && dialog.querySelector(".review-handled-toggle")?.dataset.revision !== revision) {
    dialog.querySelector(".review-handled-toggle")?.remove();
    title.after(createReviewHandledButton({ id: revision, title: value.title }, {
      load: true, onError: error => { status.textContent = error.message; },
    }));
  }
  if (bugId) reviewLinkContext.bugId = String(bugId);
  let links = dialog.querySelector(".patch-review-links");
  if (!links) {
    links = document.createElement("nav");
    links.className = "patch-review-links";
    links.setAttribute("aria-label", "Patch and bug links");
    links.style.cssText = "display:flex;gap:12px;margin-top:8px";
    title.after(links);
  }
  links.replaceChildren();
  const append = (text, href) => {
    const link = document.createElement("a");
    link.textContent = text; link.href = href;
    link.target = "_blank"; link.rel = "noopener noreferrer";
    links.append(link);
  };
  if (/^D\d+$/.test(reviewLinkContext.revision)) append(`Patch ${reviewLinkContext.revision}`, `https://phabricator.services.mozilla.com/${reviewLinkContext.revision}`);
  if (/^\d+$/.test(reviewLinkContext.bugId || "")) append(`Bug ${reviewLinkContext.bugId}`, `https://bugzilla.mozilla.org/show_bug.cgi?id=${reviewLinkContext.bugId}`);
}
const status = dialog?.querySelector(".patch-review-status");
const close = dialog?.querySelector(".patch-review-close");
const activityProgress = dialog?.querySelector(".patch-review-progress");
const activity = dialog?.querySelector(".patch-review-activity");
const activityFilters = dialog?.querySelectorAll("[data-review-activity-filter]");
const activityList = dialog?.querySelector(".patch-review-activity-list");
const output = dialog?.querySelector(".patch-review-output");
const outputToggle = dialog?.querySelector(".patch-review-output-toggle");
const cancelPull = dialog?.querySelector(".patch-review-cancel");
const steer = dialog?.querySelector(".patch-review-steer");
const steerInput = dialog?.querySelector(".patch-review-steer-input");
const steerSubmit = dialog?.querySelector(".patch-review-steer-submit");
const patchContext = dialog?.querySelector(".patch-review-patch-context");
const patchContextToggle = dialog?.querySelector(".patch-review-patch-context-toggle");
const patchContextDetails = dialog?.querySelector(".patch-review-patch-context-details");
const patchContextPurpose = dialog?.querySelector(".patch-review-patch-context-purpose");
const patchContextContract = dialog?.querySelector(".patch-review-patch-context-contract");
const patchContextStack = dialog?.querySelector(".patch-review-patch-context-stack");
const patchContextEvidence = dialog?.querySelector(".patch-review-patch-context-evidence");
const patchContextValidation = dialog?.querySelector(".patch-review-patch-context-validation");
const discussion = dialog?.querySelector(".patch-review-discussion");
const discussionCount = dialog?.querySelector(".patch-review-discussion-count");
const discussionList = dialog?.querySelector(".patch-review-discussion-list");
const patchDiff = dialog?.querySelector(".patch-review-context-diff");
const patchDiffContent = dialog?.querySelector(".patch-review-context-diff-content");
const coverage = dialog?.querySelector(".patch-review-coverage");
const coverageSummary = dialog?.querySelector(".patch-review-summary");
const coverageAccessibility = dialog?.querySelector(".patch-review-accessibility");
const coverageCodeRabbit = dialog?.querySelector(".patch-review-coderabbit");
const coverageStatic = dialog?.querySelector(".patch-review-static");
const coverageRuntime = dialog?.querySelector(".patch-review-runtime");
const coverageContext = dialog?.querySelector(".patch-review-context");
const finalSection = dialog?.querySelector(".patch-review-final");
const finalMessage = dialog?.querySelector(".patch-review-final-message");
const finalButtons = dialog?.querySelectorAll("[data-review-outcome]");

let session;
let pollTimer;
let outputVisible = false;
let activityFilter = "notes";
let activityFollowsLatest = true;
let appliedSnapshotKey = "";
let pendingAction = "";
let actionError = "";
let patchContextExpanded = false;
let patchContextKey = "";
let renderedPatchDiffKey = "";
const scrollToAttention = createReviewAttentionScroller();
let reviewContext = {
  error: "",
  key: "",
  loading: false,
  rawPatchHtml: "",
  reviewDiscussion: null,
};
let reviewContextRequest = "";
let experimentDiffState = {
  error: "",
  html: "",
  key: "",
  loading: false,
  text: "",
};
let experimentDiffRequest = "";
const expandedActivityCommandIds = new Set();

function isBusy(value = session) {
  return ["pulling", "reviewing", "posting"].includes(value?.status);
}

function getCurrentIssue(value = session) {
  return value?.issues?.slice(value.currentIssueIndex || 0)
    .find((issue) => ["ready", "applied"].includes(issue.state)) || null;
}

function setButton(button, { hidden, disabled = false, text } = {}) {
  if (!button) {
    return;
  }

  button.hidden = Boolean(hidden);
  button.disabled = Boolean(disabled);
  if (text) {
    button.textContent = text;
  }
}

function setPageScrollLocked(isLocked) {
  document.documentElement.classList.toggle("patch-review-open", isLocked);
  document.body.classList.toggle("patch-review-open", isLocked);
}

function isCommandActivity(entry) {
  return entry?.kind === "command" || /\bcommand\b/i.test(String(entry?.title || ""));
}

function isCodexNoteActivity(entry) {
  return entry?.kind === "note" || String(entry?.title || "").trim() === "Codex note";
}

function getActivityCommandPreview(detail) {
  const firstLine = String(detail || "").split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "Command details";

  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

function renderActivityFilter() {
  activityFilters?.forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.reviewActivityFilter === activityFilter),
    );
  });
}

function setActivityFilter(filter) {
  activityFilter = filter === "all" ? "all" : "notes";
  activityFollowsLatest = true;
  renderActivityFilter();
  renderActivity(session?.activity || []);
}

function createCommandActivityDisclosure(entry) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const heading = document.createElement("strong");
  const preview = document.createElement("span");
  const detail = document.createElement("code");

  details.className = "patch-review-activity-command-disclosure";
  details.open = expandedActivityCommandIds.has(entry.id);
  summary.className = "patch-review-activity-command-summary";
  heading.textContent = entry.title || "Command";
  preview.className = "patch-review-activity-command-preview";
  preview.textContent = getActivityCommandPreview(entry.detail);
  detail.textContent = entry.detail;
  summary.append(heading, preview);
  details.append(summary, detail);
  details.addEventListener("toggle", () => {
    if (details.open) {
      expandedActivityCommandIds.add(entry.id);
    } else {
      expandedActivityCommandIds.delete(entry.id);
    }
  });

  return details;
}

function createActivityEntry(entry) {
  const row = document.createElement("li");
  const commandActivity = isCommandActivity(entry);

  row.className = `patch-review-activity-entry patch-review-activity-${entry.kind || "status"}` +
    (commandActivity ? " patch-review-activity-command-row" : "");

  if (commandActivity && entry.detail) {
    row.append(createCommandActivityDisclosure(entry));
    return row;
  }

  const heading = document.createElement("strong");

  heading.textContent = entry.title || "Codex activity";
  row.append(heading);
  if (entry.detail) {
    const detail = document.createElement("code");

    detail.textContent = entry.detail;
    row.append(detail);
  }
  return row;
}

function createActivityPlaceholder(text) {
  const placeholder = document.createElement("li");

  placeholder.className = "patch-review-activity-empty";
  placeholder.textContent = text;
  return placeholder;
}

function renderActivity(entries = []) {
  if (!activity || !activityList) {
    return;
  }

  const items = Array.isArray(entries) ? entries : [];
  const visibleEntries = activityFilter === "all"
    ? items
    : items.filter(isCodexNoteActivity);
  const hadEntries = activityList.childElementCount > 0;
  const followOutput = activityFollowsLatest || !hadEntries;

  activity.hidden = false;
  const activityChanged = replaceChangedChildren(activityList, ...(
    visibleEntries.length
      ? visibleEntries.map(createActivityEntry)
      : [createActivityPlaceholder(
        items.length && activityFilter === "notes"
          ? "No Codex notes yet. Select All to include commands and file changes."
          : "Waiting for Codex activity...",
      )]
  ));

  if (activityChanged && followOutput && !hasSelectedText(activityList)) {
    window.requestAnimationFrame(() => {
      if (!hasSelectedText(activityList)) activityList.scrollTop = activityList.scrollHeight;
    });
  }
}

function updateActivityFollowState() {
  if (!activityList) {
    return;
  }

  activityFollowsLatest = activityList.scrollHeight - activityList.scrollTop -
    activityList.clientHeight < 24;
}

function getPatchReviewOutput(currentSession = session) {
  const activityOutput = (currentSession?.activity || []).map((entry) => {
    const heading = `[${entry.title || "Codex activity"}]`;

    return entry.detail ? `${heading}\n${entry.detail}` : heading;
  }).join("\n\n");
  const processOutput = String(currentSession?.output || "").trim();

  return [
    activityOutput,
    processOutput ? `Raw process output\n${processOutput}` : "",
  ].filter(Boolean).join("\n\n---\n\n");
}

function formatDisplayValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(formatDisplayValue).filter(Boolean).join("\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, detail]) => {
      const text = formatDisplayValue(detail);

      return text ? `${key}: ${text}` : "";
    }).filter(Boolean).join("\n");
  }

  return value === null || value === undefined ? "" : String(value);
}

function setPatchContextExpanded(expanded) {
  patchContextExpanded = Boolean(expanded);
  patchContext?.classList.toggle("is-expanded", patchContextExpanded);
  patchContextToggle?.setAttribute("aria-expanded", String(patchContextExpanded));
  if (patchContextDetails) {
    patchContextDetails.hidden = !patchContextExpanded;
  }
}

function setPatchContext(context) {
  if (!patchContext) {
    return;
  }

  const current = context || {};
  const purpose = formatDisplayValue(current.purpose);
  const contract = formatDisplayValue(current.behaviorContract);
  const stack = formatDisplayValue(current.stackContext);
  const evidence = formatDisplayValue(current.evidence);
  const validationText = formatDisplayValue(current.validation);
  const hasContext = Boolean(purpose || contract);
  const key = [purpose, contract, stack, evidence, validationText].join("\u0000");

  if (key !== patchContextKey) {
    patchContextKey = key;
    patchContextExpanded = false;
  }

  patchContext.hidden = !hasContext;
  patchContextPurpose.textContent = purpose;
  patchContextContract.textContent = contract;
  patchContextStack.hidden = !stack;
  patchContextStack.lastElementChild.textContent = stack;
  patchContextEvidence.hidden = !evidence;
  patchContextEvidence.lastElementChild.textContent = evidence;
  patchContextValidation.hidden = !validationText;
  patchContextValidation.lastElementChild.textContent = validationText;
  setPatchContextExpanded(hasContext && patchContextExpanded);
}

function createDiscussionEntry(item) {
  const article = document.createElement("article");
  const header = document.createElement("header");
  const author = document.createElement("strong");
  const location = document.createElement("span");
  const text = document.createElement("p");

  article.className = "patch-review-discussion-entry";
  author.textContent = item.author || "Unknown reviewer";
  location.textContent = item.filePath
    ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    : item.action || "Comment";
  header.append(author, location);
  text.textContent = item.content || "Code suggestion";
  article.append(header, text);
  if (item.codeSuggestion?.content || item.codeSuggestion?.isDeletion) {
    const code = document.createElement("pre");

    code.textContent = item.codeSuggestion.isDeletion ? "Delete the marked lines." : item.codeSuggestion.content;
    article.append(code);
  }
  if (item.url) {
    const link = document.createElement("a");

    link.href = item.url;
    link.rel = "noreferrer";
    link.target = "_blank";
    link.textContent = "Open in Phabricator";
    article.append(link);
  }
  return article;
}

let renderedDiscussion = "";

function renderDiscussion(currentDiscussion) {
  if (!discussion || !discussionList || !discussionCount) {
    return;
  }

  const value = currentDiscussion || {};
  const key = JSON.stringify(value);
  if (key === renderedDiscussion) return;
  renderedDiscussion = key;
  const comments = Array.isArray(value.comments) ? value.comments : [];
  const inlineComments = Array.isArray(value.inlineComments) ? value.inlineComments : [];
  const count = comments.length + inlineComments.length;

  discussion.hidden = !count && !value.error && !value.historyTruncated;
  discussionCount.textContent = count ? `(${count})` : "";
  const entries = comments.length ? comments : inlineComments;

  discussionList.replaceChildren(...entries.map(createDiscussionEntry));
  if (value.historyTruncated) {
    const notice = document.createElement("p");

    notice.className = "patch-review-discussion-notice";
    notice.textContent = "Phabricator returned a limited discussion history.";
    discussionList.append(notice);
  }
  if (value.error) {
    const warning = document.createElement("p");

    warning.className = "patch-review-discussion-notice error";
    warning.textContent = value.error;
    discussionList.append(warning);
  }
}

function getReviewContextKey(value = session) {
  if (!value?.id || !value.rawPatchReady || !value.rawPatchHash) {
    return "";
  }

  return `${value.id}:${value.rawPatchHash}:${value.reviewContextVersion || 0}`;
}

function loadReviewContext() {
  const key = getReviewContextKey();

  if (!key || reviewContextRequest === key || reviewContext.key === key) {
    return;
  }

  reviewContextRequest = key;
  reviewContext = {
    error: "",
    key,
    loading: true,
    rawPatchHtml: "",
    reviewDiscussion: null,
  };
  void fetch(
    `/api/review/${encodeURIComponent(session.id)}/context?token=${encodeURIComponent(INTERACTIVE.token)}`,
    { cache: "no-store" },
  ).then(async (response) => {
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load the exact patch diff.");
    }

    return result;
  }).then((result) => {
    if (reviewContextRequest !== key) {
      return;
    }

    reviewContext = {
      error: "",
      key,
      loading: false,
      rawPatchHtml: String(result.rawPatchHtml || ""),
      reviewDiscussion: result.reviewDiscussion || null,
    };
  }).catch((error) => {
    if (reviewContextRequest !== key) {
      return;
    }

    reviewContext = {
      error: error?.message || String(error),
      key,
      loading: false,
      rawPatchHtml: "",
      reviewDiscussion: null,
    };
  }).finally(() => {
    if (reviewContextRequest === key) {
      reviewContextRequest = "";
      renderSession(session);
    }
  });
}

function getIssueDiffKey(issue) {
  return [
    getReviewContextKey(),
    issue?.id || "no-issue",
    issue?.state || "",
    getExperimentDiffKey(),
  ].join(":");
}

function appendExistingInlineComments() {
  const comments = reviewContext.reviewDiscussion?.inlineComments || [];

  for (const item of comments) {
    const row = findReviewLine(patchDiffContent, item);

    if (!row) {
      continue;
    }

    const inline = appendInlineReviewComment(row, item);

    inline.classList.add("patch-review-existing-inline");
  }
}

function createSuggestedDiffLine({ content, lineNumber, type }) {
  const line = document.createElement("tr");
  const oldLine = document.createElement("td");
  const newLine = document.createElement("td");
  const source = document.createElement("td");
  const marker = document.createElement("span");
  const text = document.createElement("span");

  line.className = `diff-line ${type} patch-review-suggested-diff-line`;
  oldLine.className = "line-number old-line";
  newLine.className = "line-number new-line";
  source.className = "line-source";
  marker.className = "line-marker";
  text.className = "line-content";
  marker.textContent = type === "delete" ? "-" : "+";
  text.textContent = content;
  if (type === "delete") {
    oldLine.textContent = String(lineNumber);
  } else {
    newLine.textContent = String(lineNumber);
  }
  source.append(marker, text);
  line.append(oldLine, newLine, source);
  return line;
}

function renderSuggestedSourceDiff(container, {
  currentSource = "",
  lineNumber,
  replacement = "",
} = {}) {
  container.replaceChildren();
  const table = document.createElement("table");
  const body = document.createElement("tbody");
  const replacementLines = replacement ? String(replacement).split(/\r?\n/) : [];

  table.className = "diff-table patch-review-suggested-diff-table";
  if (currentSource) {
    body.append(createSuggestedDiffLine({
      content: currentSource,
      lineNumber,
      type: "delete",
    }));
  }
  replacementLines.forEach((line, index) => {
    body.append(createSuggestedDiffLine({
      content: line,
      lineNumber: Number(lineNumber) + index,
      type: "insert",
    }));
  });
  table.append(body);
  container.append(table);
}

function createInlineFindingButton(action, text) {
  const button = document.createElement("button");

  button.dataset.reviewInlineAction = action;
  button.type = "button";
  button.textContent = text;
  return button;
}

function getInlineFinding(issue) {
  return Array.from(patchDiffContent?.querySelectorAll(".patch-review-inline-finding") || [])
    .find((finding) => finding.dataset.issueId === issue?.id) || null;
}

function setInlineFindingButton(finding, action, {
  disabled = false,
  hidden = false,
  text,
} = {}) {
  const button = finding?.querySelector(`[data-review-inline-action="${action}"]`);

  setButton(button, { disabled, hidden, text });
}

function updateInlineFindingActions(issue) {
  const finding = getInlineFinding(issue);

  if (!finding || !issue) {
    return;
  }

  const commentInput = finding.querySelector(".patch-review-inline-comment-input");
  const suggestionInput = finding.querySelector(".patch-review-inline-suggestion-input");
  const hasSuggestion = Boolean(issue.codeSuggestion || issue.isDeletion);
  const canPostInline = finding.dataset.inlineAvailable === "true";
  const actionPending = Boolean(pendingAction);

  setInlineFindingButton(finding, "apply", {
    disabled: actionPending,
    hidden: !hasSuggestion || issue.state !== "ready" || !canPostInline,
    text: pendingAction === "apply" ? "Applying..." : "Apply in Review Checkout",
  });
  setInlineFindingButton(finding, "inline-comment", {
    disabled: actionPending || !canPostInline || !commentInput?.value.trim(),
    text: !canPostInline
      ? "New-side Anchor Required"
      : pendingAction === "inline" ? "Saving Draft..." : "Save Inline Comment Draft",
  });
  setInlineFindingButton(finding, "inline-suggestion", {
    disabled: actionPending || !canPostInline || !commentInput?.value.trim() || (!suggestionInput?.value.trim() && !issue.isDeletion),
    hidden: !hasSuggestion || !canPostInline,
    text: pendingAction === "inline" ? "Saving Draft..." : "Save Reply + Code Suggestion Draft",
  });
  setInlineFindingButton(finding, "skip", {
    disabled: actionPending,
    text: pendingAction === "skip" ? "Skipping..." : "Skip Finding",
  });
}

function createInlineFinding(issue, {
  currentSource = "",
  inlineAvailable = true,
  lineNumber = issue.lineNumber,
} = {}) {
  const finding = document.createElement("article");
  const header = document.createElement("header");
  const severity = document.createElement("span");
  const title = document.createElement("h3");
  const rationale = document.createElement("p");
  const validation = document.createElement("p");
  const commentLabel = document.createElement("label");
  const commentInput = document.createElement("textarea");
  const actions = document.createElement("div");

  finding.className = "patch-review-inline-finding";
  finding.dataset.issueId = issue.id;
  finding.dataset.currentSource = currentSource;
  finding.dataset.inlineAvailable = String(inlineAvailable);
  finding.dataset.lineNumber = String(lineNumber || "");
  severity.className = "patch-review-severity";
  severity.textContent = issue.severity || "nit";
  title.textContent = issue.title || "Review finding";
  const source = document.createElement("strong");
  source.textContent = "Codex analysis";
  header.append(source, severity, title);
  rationale.className = "patch-review-inline-rationale";
  rationale.textContent = issue.rationale || "";
  validation.className = "patch-review-inline-validation";
  validation.textContent = issue.validation || "";
  commentLabel.className = "patch-review-inline-field";
  commentLabel.append("Suggested inline reply");
  commentInput.className = "patch-review-inline-comment-input";
  commentInput.rows = 4;
  commentInput.value = issue.suggestedComment || "";
  commentLabel.append(commentInput);
  finding.append(header);
  if (rationale.textContent) {
    finding.append(rationale);
  }
  if (validation.textContent) {
    finding.append(validation);
  }
  finding.append(commentLabel);

  if (issue.codeSuggestion || issue.isDeletion) {
    const suggestionLabel = document.createElement("label");
    const suggestionInput = document.createElement("textarea");
    const suggestionDiff = document.createElement("section");
    const suggestionHeading = document.createElement("h4");

    suggestionLabel.className = "patch-review-inline-field";
    suggestionLabel.append("Suggested code replacement");
    suggestionInput.className = "patch-review-inline-suggestion-input";
    suggestionInput.rows = 4;
    suggestionInput.spellcheck = false;
    suggestionInput.value = issue.codeSuggestion;
    suggestionLabel.append(suggestionInput);
    suggestionDiff.className = "patch-review-inline-suggested-diff";
    suggestionHeading.textContent = "Suggested source update";
    suggestionDiff.append(suggestionHeading);
    const suggestionDiffContent = document.createElement("div");

    suggestionDiffContent.className = "patch-review-inline-suggested-diff-content";
    suggestionDiff.append(suggestionDiffContent);
    renderSuggestedSourceDiff(suggestionDiffContent, {
      currentSource,
      lineNumber,
      replacement: issue.codeSuggestion,
    });
    finding.append(suggestionLabel, suggestionDiff);
  }

  actions.className = "patch-review-inline-actions";
  actions.append(
    createInlineFindingButton("apply", "Apply in Review Checkout"),
    createInlineFindingButton("inline-comment", "Save Inline Comment Draft"),
    createInlineFindingButton("inline-suggestion", "Save Reply + Code Suggestion Draft"),
    createInlineFindingButton("skip", "Skip Finding"),
  );
  finding.append(actions);
  return finding;
}

function appendInlineFinding(row, issue) {
  row.closest(".diff-table")?.classList.add("has-review-comments");
  let thread = row.nextElementSibling;

  if (!thread?.classList.contains("review-inline-thread")) {
    thread = document.createElement("tr");
    const cell = document.createElement("td");

    thread.className = "review-inline-thread";
    cell.colSpan = 3;
    thread.append(cell);
    row.after(thread);
  }

  const finding = createInlineFinding(issue, {
    currentSource: row.querySelector(".line-content")?.textContent || "",
  });

  thread.firstElementChild.append(finding);
  updateInlineFindingActions(issue);
  return finding;
}

function appendUnanchoredFinding(issue) {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  const notice = document.createElement("p");
  const finding = createInlineFinding(issue, { inlineAvailable: false });

  section.className = "patch-review-unanchored-finding-container";
  heading.textContent = "Review finding needs a new-side patch anchor";
  notice.textContent = `Codex gave ${issue.filePath}:${issue.lineNumber}, but that changed new-side line is not in the exact Phabricator patch. The finding and its suggested update are shown here, but TB Tools will not post it to the wrong side of the diff.`;
  section.append(heading, notice, finding);
  patchDiffContent.append(section);
  updateInlineFindingActions(issue);
  return section;
}

function appendCurrentIssue(issue) {
  if (!issue) {
    return null;
  }

  const row = findReviewLine(patchDiffContent, issue, { newSideOnly: true });

  if (!row) {
    return appendUnanchoredFinding(issue);
  }

  row.classList.add("patch-review-context-line");
  appendInlineFinding(row, issue);
  return row;
}

function appendReviewCheckoutDiff() {
  if (!session?.id) {
    return;
  }

  const key = getExperimentDiffKey();
  const current = experimentDiffState.key === key ? experimentDiffState : null;
  const section = document.createElement("section");
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  const description = document.createElement("p");
  const content = document.createElement("div");

  section.className = "patch-review-working-diff";
  heading.textContent = "Review checkout validation changes";
  description.className = "patch-review-working-diff-description";
  description.textContent = "These are local experiments that Codex made only to inspect or validate the patch. They are not an author-facing code suggestion and cannot be posted. Any change to request from the author appears inline in the patch with its own actions.";
  header.append(heading, description);
  content.className = "patch-review-working-diff-content";
  if (current?.html) {
    content.innerHTML = current.html;
  } else if (current?.text) {
    const raw = document.createElement("pre");

    raw.className = "patch-review-experiment-diff-raw";
    raw.textContent = current.text;
    content.append(raw);
  } else {
    const notice = document.createElement("p");

    notice.className = current?.error
      ? "patch-review-diff-notice error"
      : "patch-review-diff-notice";
    notice.textContent = current?.error
      ? `Could not load Review checkout validation changes: ${current.error}`
      : current?.loading
        ? "Loading Review checkout validation changes..."
        : current
          ? "No uncommitted changes in the Review checkout."
          : "Loading Review checkout validation changes...";
    content.append(notice);
  }
  section.append(header, content);
  patchDiffContent.append(section);

  if (!current?.html && !current?.text && !current?.loading && !current?.error) {
    loadExperimentDiff();
  }
}

function setPatchDiff(issue) {
  if (!patchDiffContent || !patchDiff) {
    return;
  }

  const key = getIssueDiffKey(issue);
  const contextKey = getReviewContextKey();

  if (!contextKey) {
    patchDiffContent.replaceChildren();
    const loading = document.createElement("p");

    loading.className = "patch-review-diff-notice";
    loading.textContent = "Waiting for the exact Phabricator patch...";
    patchDiffContent.append(loading);
    return;
  }

  if (reviewContext.loading || reviewContext.key !== contextKey) {
    patchDiffContent.replaceChildren();
    const loading = document.createElement("p");

    loading.className = "patch-review-diff-notice";
    loading.textContent = "Loading the exact Phabricator patch...";
    patchDiffContent.append(loading);
    loadReviewContext();
    return;
  }

  if (reviewContext.error) {
    patchDiffContent.replaceChildren();
    const failed = document.createElement("p");

    failed.className = "patch-review-diff-notice error";
    failed.textContent = `Could not load the exact patch diff: ${reviewContext.error}`;
    patchDiffContent.append(failed);
    return;
  }

  if (!reviewContext.rawPatchHtml) {
    patchDiffContent.replaceChildren();
    const missing = document.createElement("p");

    missing.className = "patch-review-diff-notice";
    missing.textContent = "The revision did not return a renderable unified patch.";
    patchDiffContent.append(missing);
    return;
  }

  if (renderedPatchDiffKey === key) {
    return;
  }

  renderedPatchDiffKey = key;
  patchDiffContent.innerHTML = reviewContext.rawPatchHtml;
  appendExistingInlineComments();
  appendCurrentIssue(issue);
  appendReviewCheckoutDiff();
  renderDiscussion(reviewContext.reviewDiscussion);


}

function getExperimentDiffKey(value = session) {
  if (!value?.id || (value?.graphIndex === undefined || value?.graphIndex === null)) {
    return "";
  }

  return [
    value.id,
    value.graphIndex,
    value.currentHash,
    value.workingTreeDiffVersion,
  ].join(":");
}

function loadExperimentDiff() {
  const key = getExperimentDiffKey();

  if (!key || experimentDiffRequest === key || experimentDiffState.key === key) {
    return;
  }

  experimentDiffRequest = key;
  experimentDiffState = {
    error: "",
    html: "",
    key,
    loading: true,
    text: "",
  };
  void fetch(
    `/api/graph/${encodeURIComponent(session.graphIndex)}/diff/uncommitted-changes?token=${encodeURIComponent(INTERACTIVE.token)}`,
    { cache: "no-store" },
  ).then(async (response) => {
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load the Review checkout diff.");
    }

    return result;
  }).then((result) => {
    if (experimentDiffRequest !== key) {
      return;
    }

    experimentDiffState = {
      error: "",
      html: String(result.html || ""),
      key,
      loading: false,
      text: String(result.text || ""),
    };
  }).catch((error) => {
    if (experimentDiffRequest !== key) {
      return;
    }

    experimentDiffState = {
      error: error?.message || String(error),
      html: "",
      key,
      loading: false,
      text: "",
    };
  }).finally(() => {
    if (experimentDiffRequest === key) {
      experimentDiffRequest = "";
      renderedPatchDiffKey = "";
      renderSession(session);
    }
  });
}

function renderCoverage(value) {
  const current = value || {};
  const hasCoverage = Object.values(current).some(Boolean);

  coverage.hidden = !hasCoverage;
  setLiveText(coverageSummary, current.summary || "");
  setLiveText(coverageAccessibility, current.accessibility || "");
  setLiveText(coverageCodeRabbit, current.codeRabbit || "");
  setLiveText(coverageStatic, current.static || "");
  setLiveText(coverageRuntime, current.runtime || "");
  setLiveText(coverageContext, current.context || "");
}

function getActionStatus() {
  const labels = {
    apply: "Applying code suggestion in the Review checkout...",
    cancel: "Cancelling Review checkout pull...",
    inline: "Saving inline comment draft...",
    skip: "Skipping review finding...",
    steer: "Sending guidance to Codex...",
    submit: "Posting the Phabricator review...",
  };

  return labels[pendingAction] || "";
}

function getFinalButtonText(button) {
  const labels = {
    accept: "Accept",
    comment: "Post Comment",
    "request-changes": "Request Changes",
  };

  return labels[button.dataset.reviewOutcome] || "Post Review";
}

function renderSession(value) {
  session = value;
  taskView.update(session, isBusy(session) || Boolean(pendingAction));
  runStatus.update(session, isBusy() || Boolean(pendingAction));
  const issue = getCurrentIssue();
  const completeReview = session.aiEnabled && session.status === "review" && !issue;
  const actionPending = Boolean(pendingAction);
  const visibleOutput = getPatchReviewOutput(session);
  const hasOutput = Boolean(visibleOutput);

  if (session.snapshot) {
    const snapshotKey = `${session.id}:${session.currentHash}:${session.workingTreeDiffVersion}`;

    if (snapshotKey !== appliedSnapshotKey) {
      appliedSnapshotKey = snapshotKey;
      applyGraphSnapshot(session.graphIndex, session.snapshot, { force: true });
    }
  }

  title.textContent = `${session.revision} review`;
  renderReviewLinks(session);
  setLiveText(status, getActionStatus() || actionError || session.error || session.message || "");
  status.classList.toggle("error", Boolean(actionError) || session.status === "error");
  setLiveText(output, visibleOutput);
  output.hidden = !outputVisible || !hasOutput;
  outputToggle.hidden = !hasOutput;
  outputToggle.textContent = outputVisible ? "Back to Review" : "Output";
  dialog.classList.toggle("output-expanded", outputVisible && hasOutput);
  setButton(cancelPull, {
    hidden: session.status !== "pulling",
    disabled: actionPending,
    text: pendingAction === "cancel" ? "Cancelling..." : "Cancel Pull",
  });
  renderActivity(session.activity || []);
  setPatchContext(session.patchContext);
  setPatchDiff(issue);
  renderCoverage(session.coverage);
  if (completeReview && finalSection.hidden) coverage.open = true;
  updateInlineFindingActions(issue);

  const canSteer = session.aiEnabled && (
    session.status === "review" ||
    (session.status === "reviewing" && Boolean(session.codexTurnId))
  );

  if (steer) {
    steer.hidden = !canSteer;
  }
  if (steerSubmit) {
    steerSubmit.disabled = actionPending || !steerInput?.value.trim();
    steerSubmit.textContent = pendingAction === "steer" ? "Sending..." : "Send";
  }

  finalSection.hidden = !completeReview;
  if (!completeReview) {
    finalSection.open = false;
  }
  finalButtons?.forEach((button) => {
    setButton(button, {
      hidden: !completeReview,
      disabled: actionPending,
      text: pendingAction === "submit" ? "Posting..." : getFinalButtonText(button),
    });
  });
  const finding = getInlineFinding(issue);
  const attention = issue ? finding?.querySelector(".patch-review-inline-actions") : finalSection;
  scrollToAttention(
    `${session.id}:${issue?.id || "submit"}:${issue?.state}:${issue?.body}:${actionError || session.error || ""}`,
    attention,
    session.status === "review" && !actionPending && !outputVisible && dialog.open,
  );
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  if (dialog.open) pollTimer = window.setTimeout(loadSession, 500);
}

async function loadSession() {
  if (!session?.id) {
    return null;
  }

  const requestedId = session.id;
  try {
    const response = await fetch(
      `/api/review/${encodeURIComponent(session.id)}?token=${encodeURIComponent(INTERACTIVE.token)}`,
      { cache: "no-store" },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load patch review status.");
    }

    if (session?.id !== requestedId) { taskView.background(result); return result; }
    renderSession(result);
    if (isBusy(result)) {
      schedulePoll();
    }
    return result;
  } catch (error) {
    if (session?.id !== requestedId) return null;
    runStatus.disconnected();
    status.classList.add("error");
    status.textContent = error?.message || String(error);
    return null;
  }
}

async function runAction(action, body = {}) {
  if (!session?.id) {
    return null;
  }

  const requestedId = session.id;
  pendingAction = action;
  actionError = "";
  renderSession(session);
  try {
    const response = await fetch(
      `/api/review/${encodeURIComponent(session.id)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: INTERACTIVE.token, ...body }),
      },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not update the patch review.");
    }

    if (result.reviewStatusChange) {
      window.dispatchEvent(new CustomEvent("review-status-changed", { detail: result.reviewStatusChange }));
    }
    if (session?.id !== requestedId) { taskView.background(result); return null; }
    pendingAction = "";
    if (action === "steer" && steerInput) {
      steerInput.value = "";
    }
    renderSession(result);
    if (action === "submit" && result.status === "complete") await closePatchReview();
    if (isBusy(result)) {
      schedulePoll();
    }
    return result;
  } catch (error) {
    if (session?.id !== requestedId) return null;
    pendingAction = "";
    actionError = error?.message || String(error);
    renderSession(session);
    return null;
  }
}

function resetPatchReviewDialog(patch) {
  viewGeneration++;
  session = undefined;
  pendingAction = "";
  actionError = "";
  outputVisible = false;
  activityFilter = "notes";
  activityFollowsLatest = true;
  appliedSnapshotKey = "";
  patchContextExpanded = false;
  patchContextKey = "";
  renderedPatchDiffKey = "";
  scrollToAttention("", null);
  reviewContext = {
    error: "",
    key: "",
    loading: false,
    rawPatchHtml: "",
    reviewDiscussion: null,
  };
  reviewContextRequest = "";
  experimentDiffState = {
    error: "",
    html: "",
    key: "",
    loading: false,
    text: "",
  };
  experimentDiffRequest = "";
  expandedActivityCommandIds.clear();
  window.clearTimeout(pollTimer);
  title.textContent = `${patch.id} review`;
  renderReviewLinks(patch, true);
  status.classList.remove("error");
  status.textContent = "Preparing review...";
  if (activityProgress) {
    activityProgress.open = true;
  }
  output.textContent = "";
  output.hidden = true;
  outputToggle.hidden = true;
  outputToggle.textContent = "Output";
  dialog.classList.remove("output-expanded");
  renderActivityFilter();
  renderActivity([]);
  if (steer) {
    steer.hidden = true;
  }
  if (steerInput) {
    steerInput.value = "";
  }
  if (steerSubmit) {
    steerSubmit.disabled = true;
  }
  setPatchContext(null);
  renderDiscussion(null);
  patchDiffContent.replaceChildren();
  renderCoverage(null);
  finalSection.hidden = true;
  finalSection.open = false;
  finalMessage.value = "";
  setButton(cancelPull, { hidden: true, text: "Cancel Pull" });
  finalButtons?.forEach((button) => setButton(button, { hidden: true }));
}


function restorePatchReviewTask(value) {
  if (session?.id !== value.id) resetPatchReviewDialog({ id: value.revision });
  renderSession(value);
  title.textContent = `${value.revision} Review`;
  renderReviewLinks(value);
  setPageScrollLocked(true);
  if (!dialog.open) dialog.showModal();
  schedulePoll();
}
export async function openPatchReviewDialog({ patch }) {
  if (!dialog || !patch?.id) {
    return;
  }

  void enableTaskNotifications();
  if (dialog.open || session) taskView.minimize();
  resetPatchReviewDialog(patch);
  const generation = viewGeneration;
  setPageScrollLocked(true);
  dialog.showModal();

  try {
    const reviewGraphIndex = graphStates.findIndex((state) => (
      state.graph.checkout === "review" && state.graph.repository === "comm"
    ));
    const result = await startOrResumePatchSession("/api/review", {
        token: INTERACTIVE.token,
        revision: patch.id,
        snapshotLimit: reviewGraphIndex === -1
          ? undefined
          : getLoadedGitCommitLimit(graphStates[reviewGraphIndex]),
    });
    if (generation !== viewGeneration) { if (result) taskView.background(result); return; }
    if (!result) {
      dialog.close();
      return;
    }

    renderSession(result);
    schedulePoll();
  } catch (error) {
    if (generation !== viewGeneration) return;
    status.classList.add("error");
    status.textContent = error?.message || String(error);
  }
}

async function closePatchReview() {
  if (pendingAction) return;
  const requestedId = session?.id;
  if (session && !["complete", "cancelled", "error"].includes(session.status)) {
    const result = await runAction("cancel");
    if (!result || session?.id !== requestedId) return;
  }
  taskView.dismiss();
  session = null;
  viewGeneration++;
}

export function initializePatchReviewDialog() {
  if (!dialog) {
    return;
  }

  close.addEventListener("click", () => {
    void closePatchReview();
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    void closePatchReview();
  });
  dialog.addEventListener("close", () => {
    window.clearTimeout(pollTimer);
    if (!dialog.open) setPageScrollLocked(false);
  });
  activityList?.addEventListener("scroll", updateActivityFollowState);
  activityFilters?.forEach((button) => {
    button.addEventListener("click", () => setActivityFilter(button.dataset.reviewActivityFilter));
  });
  outputToggle?.addEventListener("click", () => {
    outputVisible = !outputVisible;
    renderSession(session);
  });
  cancelPull?.addEventListener("click", () => {
    void runAction("cancel");
  });
  patchContextToggle?.addEventListener("click", () => {
    setPatchContextExpanded(!patchContextExpanded);
  });
  patchDiffContent?.addEventListener("input", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }

    const finding = target.closest(".patch-review-inline-finding");
    const issue = getCurrentIssue();

    if (!finding || !issue || finding.dataset.issueId !== issue.id) {
      return;
    }

    if (target.classList.contains("patch-review-inline-suggestion-input")) {
      const diff = finding.querySelector(".patch-review-inline-suggested-diff-content");

      if (diff) {
        renderSuggestedSourceDiff(diff, {
          currentSource: finding.dataset.currentSource,
          lineNumber: finding.dataset.lineNumber,
          replacement: target.value,
        });
      }
    }
    updateInlineFindingActions(issue);
  });
  patchDiffContent?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-review-inline-action]");
    const issue = getCurrentIssue();

    if (!button || !issue || button.closest(".patch-review-inline-finding")?.dataset.issueId !== issue.id) {
      return;
    }

    const finding = button.closest(".patch-review-inline-finding");
    const commentInput = finding?.querySelector(".patch-review-inline-comment-input");
    const suggestionInput = finding?.querySelector(".patch-review-inline-suggestion-input");

    if (button.dataset.reviewInlineAction === "apply") {
      void runAction("apply", { itemId: issue.id });
    } else if (button.dataset.reviewInlineAction === "inline-comment") {
      void runAction("inline", {
        itemId: issue.id,
        kind: "comment",
        message: commentInput?.value,
      });
    } else if (button.dataset.reviewInlineAction === "inline-suggestion") {
      void runAction("inline", {
        itemId: issue.id,
        kind: "suggestion",
        message: commentInput?.value,
        codeSuggestion: suggestionInput?.value,
      });
    } else if (button.dataset.reviewInlineAction === "skip") {
      void runAction("skip", { itemId: issue.id });
    }
  });
  steerInput?.addEventListener("input", () => renderSession(session));
  steerSubmit?.addEventListener("click", () => {
    void runAction("steer", { instruction: steerInput.value });
  });
  finalButtons?.forEach((button) => {
    button.addEventListener("click", () => {
      void runAction("submit", {
        outcome: button.dataset.reviewOutcome,
        message: finalMessage.value,
      });
    });
  });
}
