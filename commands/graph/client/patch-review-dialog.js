import { setDialogCommitTitle, setLiveText, replaceChangedChildren, hasSelectedText } from "./live-text.js";
import { createReviewHandledButton } from "./review-handled.js";
import { registerAiTaskDialog, enableTaskNotifications } from "./ai-task-tray.js";
import { createReviewAttentionScroller } from "./review-attention.js";
import { INTERACTIVE, graphStates } from "./config.js";
import { startOrResumePatchSession } from "./patch-session-resume.js";
import { createCodexRunStatus } from "./codex-run-status.js";
import { applyGraphSnapshot, getLoadedGitCommitLimit } from "./command-sessions.js";
import { appendInlineReviewComment, findReviewLine } from "./review-viewer.js";
import { openRebaseFailureDialog } from "./rebase-dialog.js";

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
const actionNotice = document.createElement("p");
actionNotice.className = "patch-review-action-notice";
actionNotice.setAttribute("role", "status");
actionNotice.hidden = true;
status?.after(actionNotice);
const applyConflictSection = document.createElement("section");
applyConflictSection.hidden = true;
applyConflictSection.className = "patch-review-apply-conflict";
const applyConflictMessage = document.createElement("p");
applyConflictMessage.textContent = "This patch stack does not apply cleanly to current main. Resolve the conflicts locally, try only this patch, or ask the author to rebase.";
const resolveApplyConflict = document.createElement("button");
resolveApplyConflict.type = "button";
resolveApplyConflict.textContent = "Resolve conflicts locally";
resolveApplyConflict.addEventListener("click", async () => {
  const result = await runAction("resolve-conflicts");
  if (result?.rebaseConflict) openRebaseFailureDialog(result.rebaseConflict);
});
const applySinglePatch = document.createElement("button");
applySinglePatch.type = "button";
applySinglePatch.textContent = "Try applying only this patch";
applySinglePatch.addEventListener("click", async () => {
  const result = await runAction("apply-single");
  if (result?.rebaseConflict) openRebaseFailureDialog(result.rebaseConflict);
});
const singlePatchNotice = document.createElement("p");
singlePatchNotice.textContent = "This review applies only the selected patch on main. Parent patches are omitted.";
singlePatchNotice.hidden = true;
const rebaseRequestInput = document.createElement("textarea");
rebaseRequestInput.rows = 3;
rebaseRequestInput.setAttribute("aria-label", "Comment asking the author to rebase");
const requestRebase = document.createElement("button");
requestRebase.type = "button";
requestRebase.textContent = "Post comment asking for a rebase";
requestRebase.addEventListener("click", () => void runAction("request-rebase", { message: rebaseRequestInput.value }));
applyConflictSection.append(applyConflictMessage, resolveApplyConflict, applySinglePatch, rebaseRequestInput, requestRebase);
dialog?.querySelector(".patch-review-sidebar")?.prepend(applyConflictSection);
dialog?.querySelector(".patch-review-sidebar")?.prepend(singlePatchNotice);
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
  source.className = "line-code";
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
  String(currentSource).split(/\r?\n/).forEach((line, index) => {
    body.append(createSuggestedDiffLine({
      content: line,
      lineNumber: Number(lineNumber) + index,
      type: "delete",
    }));
  });
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

function createSuggestionEditor({ currentSource, lineNumber, replacement, label = "Suggested code replacement" }) {
  const section = document.createElement("section");
  section.className = "patch-review-code-editor";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "patch-review-suggestion-toggle";
  toggle.textContent = replacement === undefined ? "Add code suggestion" : "Edit code suggestion";
  const field = document.createElement("label");
  field.className = "patch-review-inline-field";
  field.append(label);
  field.hidden = true;
  const surface = document.createElement("div");
  surface.className = "patch-review-code-surface";
  const gutter = document.createElement("pre");
  gutter.className = "patch-review-code-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const input = document.createElement("textarea");
  input.className = "patch-review-inline-suggestion-input";
  input.rows = 5;
  input.spellcheck = false;
  input.wrap = "off";
  input.value = replacement ?? currentSource;
  surface.append(gutter, input);
  field.append(surface);
  const done = document.createElement("button");
  done.type = "button";
  done.className = "patch-review-suggestion-done";
  done.textContent = "Done";
  done.hidden = true;
  const preview = document.createElement("section");
  preview.className = "patch-review-inline-suggested-diff";
  preview.hidden = replacement === undefined;
  const heading = document.createElement("h4");
  heading.textContent = "Suggested source update";
  const diff = document.createElement("div");
  diff.className = "patch-review-inline-suggested-diff-content";
  preview.append(heading, diff);
  const update = () => {
    gutter.textContent = input.value.split(/\r?\n/).map((_, index) => Number(lineNumber) + index).join("\n");
    input.rows = Math.min(18, Math.max(5, input.value.split(/\r?\n/).length));
    renderSuggestedSourceDiff(diff, { currentSource, lineNumber, replacement: input.value });
  };
  toggle.addEventListener("click", () => {
    section.dataset.enabled = "true";
    toggle.hidden = true;
    preview.hidden = true;
    field.hidden = false;
    done.hidden = false;
    update();
    input.focus();
  });
  done.addEventListener("click", () => {
    update();
    field.hidden = true;
    done.hidden = true;
    preview.hidden = false;
    toggle.hidden = false;
    toggle.textContent = "Edit code suggestion";
    toggle.focus();
  });
  input.addEventListener("input", () => { input.dataset.edited = "true"; update(); });
  input.addEventListener("scroll", () => { gutter.scrollTop = input.scrollTop; });
  input.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  section.dataset.enabled = String(replacement !== undefined);
  section.append(toggle, field, done, preview);
  update();
  return { section, input, setSource(source, start) {
    currentSource = source;
    lineNumber = start;
    if (!input.dataset.edited) input.value = source;
    update();
  } };
}

function getReviewRangeSource(file, start, end) {
  return Array.from(file.querySelectorAll(".diff-line[data-new-line]"))
    .filter(line => Number(line.dataset.newLine) >= start && Number(line.dataset.newLine) <= end)
    .map(line => line.querySelector(".line-content")?.textContent || "").join("\n");
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
  for (const rating of ["up", "down"]) {
    const button = finding.querySelector(`[data-review-inline-action="feedback-${rating}"]`);
    if (button) {
      button.disabled = actionPending;
      button.setAttribute("aria-pressed", String(issue.feedback?.rating === rating));
    }
  }
  const feedbackStatus = finding.querySelector(".patch-review-feedback-status");
  if (feedbackStatus) feedbackStatus.textContent = issue.feedback?.rating
    ? `Saved thumbs ${issue.feedback.rating}.` : "No rating yet.";
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
    const suggestion = createSuggestionEditor({
      currentSource, lineNumber, replacement: issue.codeSuggestion || "",
    });
    finding.append(suggestion.section);
  }

  actions.className = "patch-review-inline-actions";
  actions.append(
    createInlineFindingButton("apply", "Apply in Review Checkout"),
    createInlineFindingButton("inline-comment", "Save Inline Comment Draft"),
    createInlineFindingButton("inline-suggestion", "Save Reply + Code Suggestion Draft"),
    createInlineFindingButton("skip", "Skip Finding"),
  );
  finding.append(actions);
  finding.append(createFindingFeedback(issue));
  return finding;
}

function createFindingFeedback(issue) {
  const feedback = document.createElement("div");
  feedback.className = "patch-review-finding-feedback";
  feedback.setAttribute("role", "group");
  feedback.setAttribute("aria-label", "Rate this review finding");
  const up = createInlineFindingButton("feedback-up", "👍 Useful finding");
  const down = createInlineFindingButton("feedback-down", "👎 Poor finding");
  up.setAttribute("aria-pressed", String(issue.feedback?.rating === "up"));
  down.setAttribute("aria-pressed", String(issue.feedback?.rating === "down"));
  const feedbackLabel = document.createElement("label");
  feedbackLabel.textContent = "Reason (optional) ";
  const reason = document.createElement("input");
  reason.className = "patch-review-feedback-reason";
  reason.maxLength = 2000;
  reason.value = issue.feedback?.reason || "";
  feedbackLabel.append(reason);
  const feedbackStatus = document.createElement("span");
  feedbackStatus.className = "patch-review-feedback-status";
  feedbackStatus.setAttribute("role", "status");
  feedbackStatus.textContent = issue.feedback?.rating ? `Saved thumbs ${issue.feedback.rating}.` : "No rating yet.";
  feedback.append(up, down, feedbackLabel, feedbackStatus);
  return feedback;
}

function appendEarlierFindingFeedback(currentIssue) {
  const earlier = (session?.issues || []).filter(issue => issue.id !== currentIssue?.id &&
    ["pending", "posted", "skipped"].includes(issue.state));
  if (!earlier.length) return;
  const section = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Rate earlier findings (${earlier.length})`;
  section.append(summary);
  for (const issue of earlier) {
    const article = document.createElement("article");
    article.className = "patch-review-inline-finding";
    article.dataset.issueId = issue.id;
    const title = document.createElement("h3");
    title.textContent = issue.title || "Review finding";
    const comment = document.createElement("p");
    comment.textContent = issue.originalSuggestion?.comment
      ? `Generated comment: ${issue.originalSuggestion.comment}`
      : "This older session did not retain the original suggestion.";
    article.append(title, comment, createFindingFeedback(issue));
    section.append(article);
  }
  patchDiffContent.append(section);
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
    currentSource: getReviewRangeSource(row.closest(".pretty-file"), issue.lineNumber,
      issue.lineNumber + (issue.lineLength || 1) - 1),
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

function enableAdditionalReviewComments() {
  if (session.status !== "review" || getCurrentIssue()) return;
  for (const row of patchDiffContent.querySelectorAll(".pretty-file .diff-line[data-new-line]")) {
    if (!row.dataset.newLine || row.closest(".patch-review-working-diff")) continue;
    const cell = row.querySelector(".new-line");
    if (!cell || cell.querySelector("button")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.reviewAddComment = "true";
    button.textContent = row.dataset.newLine;
    button.setAttribute("aria-label", `Add comment on line ${row.dataset.newLine}`);
    cell.replaceChildren(button);
  }
}

function highlightReviewRange(file, start, end) {
  for (const line of file.querySelectorAll(".diff-line[data-new-line]")) {
    const number = Number(line.dataset.newLine);
    line.classList.toggle("patch-review-context-line", number >= start && number <= end);
  }
}

function updateManualReviewRange(editor, file) {
  const start = Number(editor.dataset.startLine);
  const end = Number(editor.dataset.endLine);
  editor.querySelector("h3").textContent = start === end
    ? `Add comment on line ${start}` : `Add comment on lines ${start}–${end}`;
  highlightReviewRange(file, start, end);
  editor.reviewSuggestion.setSource(getReviewRangeSource(file, start, end), start);
}

function openAdditionalReviewComment(row, extend = false, endRow = row) {
  if (pendingAction || session.status !== "review" || getCurrentIssue()) return;
  const existing = patchDiffContent.querySelector(".patch-review-manual-comment");
  if (existing) {
    if (extend && existing.dataset.filePath === row.closest(".pretty-file").dataset.filePath) {
      const first = Number(existing.dataset.firstLine);
      const last = Number(row.dataset.newLine);
      existing.dataset.startLine = String(Math.min(first, last));
      existing.dataset.endLine = String(Math.max(first, last));
      existing.querySelector("h3").textContent = `Add comment on lines ${existing.dataset.startLine}–${existing.dataset.endLine}`;
      updateManualReviewRange(existing, row.closest(".pretty-file"));
    }
    return;
  }
  const editor = document.createElement("article");
  editor.className = "patch-review-manual-comment patch-review-inline-finding";
  editor.dataset.filePath = row.closest(".pretty-file").dataset.filePath;
  editor.dataset.firstLine = row.dataset.newLine;
  editor.dataset.startLine = String(Math.min(Number(row.dataset.newLine), Number(endRow.dataset.newLine)));
  editor.dataset.endLine = String(Math.max(Number(row.dataset.newLine), Number(endRow.dataset.newLine)));
  const heading = document.createElement("h3");
  heading.textContent = `Add comment on line ${row.dataset.newLine}`;
  const commentLabel = document.createElement("label");
  commentLabel.className = "patch-review-inline-field";
  commentLabel.append("Comment");
  const comment = document.createElement("textarea");
  comment.rows = 4;
  comment.className = "patch-review-inline-comment-input";
  commentLabel.append(comment);
  const suggestion = createSuggestionEditor({
    currentSource: getReviewRangeSource(row.closest(".pretty-file"), Number(editor.dataset.startLine), Number(editor.dataset.endLine)),
    lineNumber: Number(editor.dataset.startLine), label: "Code replacement (optional)",
  });
  editor.reviewSuggestion = suggestion;
  const replacement = suggestion.input;
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save Additional Inline Draft";
  save.disabled = true;
  comment.addEventListener("input", () => { save.disabled = !comment.value.trim(); });
  save.addEventListener("click", async () => {
    save.disabled = true;
    await runAction("inline", {
      anchor: { filePath: editor.dataset.filePath, lineNumber: Number(editor.dataset.startLine), lineLength: Number(editor.dataset.endLine) - Number(editor.dataset.startLine) + 1 },
      kind: suggestion.section.dataset.enabled === "true" && replacement.value ? "suggestion" : "comment",
      message: comment.value,
      codeSuggestion: suggestion.section.dataset.enabled === "true" ? replacement.value : "",
    });
    if (editor.isConnected) save.disabled = false;
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    editor.remove();
    patchDiffContent.querySelectorAll(".patch-review-context-line").forEach(line => line.classList.remove("patch-review-context-line"));
    renderSession(session);
  });
  const help = document.createElement("p");
  help.textContent = "Drag across lines or Shift-click another line to select a range.";
  const actions = document.createElement("div");
  actions.className = "patch-review-inline-actions";
  actions.append(save, cancel);
  editor.append(heading, help, commentLabel, suggestion.section, actions);
  let thread = row.nextElementSibling;
  if (!thread?.classList.contains("review-inline-thread")) {
    thread = document.createElement("tr");
    thread.className = "review-inline-thread";
    const cell = document.createElement("td");
    cell.colSpan = 3;
    thread.append(cell);
    row.after(thread);
  }
  thread.firstElementChild.append(editor);
  row.closest(".diff-table").classList.add("has-review-comments");
  updateManualReviewRange(editor, row.closest(".pretty-file"));
  finalButtons?.forEach(button => { button.disabled = true; });
  comment.focus();
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
  appendEarlierFindingFeedback(issue);
  appendReviewCheckoutDiff();
  enableAdditionalReviewComments();
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
    feedback: "Saving finding feedback...",
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
  applyConflictSection.hidden = !session.applyConflict || session.status !== "paused";
  if (rebaseRequestInput.dataset.sessionId !== session.id || session.applyConflict && !rebaseRequestInput.value) {
    rebaseRequestInput.dataset.sessionId = session.id;
    rebaseRequestInput.value = session.rebaseRequestMessage || "";
  }
  resolveApplyConflict.disabled = actionPending;
  applySinglePatch.disabled = actionPending || Boolean(session.rebaseConflict);
  singlePatchNotice.hidden = !session.singlePatchOnly;
  requestRebase.disabled = actionPending;
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
  if (session.commitTitle) setDialogCommitTitle(title, session.commitTitle);
  renderReviewLinks(session);
  const separateActionError = Boolean(session.error && actionError);
  setLiveText(status, getActionStatus() || session.error || actionError || session.message || "");
  status.classList.toggle("error", session.status === "error" || Boolean(actionError && !session.error));
  actionNotice.hidden = !separateActionError;
  setLiveText(actionNotice, separateActionError ? `The request was not accepted: ${actionError}` : "");
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
  for (const finding of session.issues || []) updateInlineFindingActions(finding);

  const canSteer = session.aiEnabled && (
    session.status === "review" ||
    (session.status === "error" && session.canRetry) ||
    (session.status === "reviewing" && Boolean(session.codexTurnId))
  );

  if (steer) {
    steer.hidden = !canSteer;
  }
  if (steerSubmit) {
    steerSubmit.disabled = actionPending || !steerInput?.value.trim();
    steerSubmit.textContent = pendingAction === "steer" ? "Sending..." : session.status === "error" ? "Resume" : "Send";
  }

  finalSection.hidden = !completeReview;
  if (!completeReview) {
    finalSection.open = false;
  }
  finalButtons?.forEach((button) => {
    setButton(button, {
      hidden: !completeReview,
      disabled: actionPending || Boolean(patchDiffContent.querySelector(".patch-review-manual-comment")),
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
    if (["submit", "request-rebase"].includes(action) && result.status === "complete") await closePatchReview();
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
  setDialogCommitTitle(title, patch.title);
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
    if (dialog.open) return;
    window.clearTimeout(pollTimer);
    setPageScrollLocked(false);
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
  let lineDrag = null;
  let suppressLineClickUntil = 0;
  patchDiffContent?.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.pointerType === "touch" || pendingAction) return;
    const button = event.target.closest("[data-review-add-comment]");
    if (!button && event.target.closest("button, a, textarea, input, label")) return;
    const row = event.target.closest(".diff-line[data-new-line]");
    if (!row?.querySelector("[data-review-add-comment]")) return;
    const file = row.closest(".pretty-file");
    const existing = patchDiffContent.querySelector(".patch-review-manual-comment");
    if (existing && existing.dataset.filePath !== file.dataset.filePath) return;
    lineDrag = { row, last: row, file, pointerId: event.pointerId, extend: event.shiftKey, gutter: Boolean(button) };
    patchDiffContent.setPointerCapture(event.pointerId);
    if (button) event.preventDefault();
  });
  patchDiffContent?.addEventListener("pointermove", event => {
    if (!lineDrag || event.pointerId !== lineDrag.pointerId) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest(".diff-line[data-new-line]");
    if (!row?.querySelector("[data-review-add-comment]") || row.closest(".pretty-file") !== lineDrag.file) return;
    lineDrag.last = row;
    highlightReviewRange(lineDrag.file,
      Math.min(Number(lineDrag.row.dataset.newLine), Number(row.dataset.newLine)),
      Math.max(Number(lineDrag.row.dataset.newLine), Number(row.dataset.newLine)));
  });
  patchDiffContent?.addEventListener("pointerup", event => {
    if (!lineDrag || event.pointerId !== lineDrag.pointerId) return;
    const { row, last, file, extend, gutter } = lineDrag;
    lineDrag = null;
    patchDiffContent.releasePointerCapture(event.pointerId);
    if (!gutter && row === last && hasSelectedText(patchDiffContent)) return;
    if (row !== last) window.getSelection()?.removeAllRanges();
    suppressLineClickUntil = performance.now() + 200;
    const existing = patchDiffContent.querySelector(".patch-review-manual-comment");
    if (existing && row !== last) {
      const first = extend ? Number(existing.dataset.firstLine) : Number(row.dataset.newLine);
      existing.dataset.firstLine = String(first);
      existing.dataset.startLine = String(Math.min(first, Number(last.dataset.newLine)));
      existing.dataset.endLine = String(Math.max(first, Number(last.dataset.newLine)));
      updateManualReviewRange(existing, file);
    } else {
      openAdditionalReviewComment(row, extend, last);
    }
  });
  patchDiffContent?.addEventListener("pointercancel", () => {
    lineDrag = null;
    patchDiffContent.querySelectorAll(".patch-review-context-line").forEach(line => line.classList.remove("patch-review-context-line"));
    const existing = patchDiffContent.querySelector(".patch-review-manual-comment");
    if (existing) updateManualReviewRange(existing, Array.from(patchDiffContent.querySelectorAll(".pretty-file"))
      .find(file => file.dataset.filePath === existing.dataset.filePath));
  });
  patchDiffContent?.addEventListener("click", (event) => {
    const lineButton = event.target.closest("[data-review-add-comment]");
    const row = event.target.closest(".diff-line[data-new-line]");
    if (row && event.detail > 0 && performance.now() < suppressLineClickUntil) return;
    if (lineButton || (row && !event.target.closest("button, a") && !hasSelectedText(patchDiffContent))) {
      if (row?.querySelector("[data-review-add-comment]")) openAdditionalReviewComment(row, event.shiftKey);
      return;
    }
    const button = event.target.closest("[data-review-inline-action]");
    const issue = session?.issues?.find(issue => issue.id === button?.closest(".patch-review-inline-finding")?.dataset.issueId);

    if (!button || !issue || button.closest(".patch-review-inline-finding")?.dataset.issueId !== issue.id) {
      return;
    }

    const finding = button.closest(".patch-review-inline-finding");
    if (!button.dataset.reviewInlineAction.startsWith("feedback-") && issue.id !== getCurrentIssue()?.id) return;
    const commentInput = finding?.querySelector(".patch-review-inline-comment-input");
    const suggestionInput = finding?.querySelector(".patch-review-inline-suggestion-input");

    if (button.dataset.reviewInlineAction.startsWith("feedback-")) {
      const rating = button.dataset.reviewInlineAction.slice("feedback-".length);
      void runAction("feedback", { itemId: issue.id,
        rating: issue.feedback?.rating === rating ? "" : rating,
        reason: finding.querySelector(".patch-review-feedback-reason")?.value || "" });
    } else if (button.dataset.reviewInlineAction === "apply") {
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
