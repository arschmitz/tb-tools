import { INTERACTIVE, graphStates } from "./config.js";
import { applyGraphSnapshot, getLoadedGitCommitLimit } from "./command-sessions.js";
import { appendInlineReviewComment, findReviewLine } from "./review-viewer.js";

const dialog = document.getElementById("patch-review-dialog");
const title = dialog?.querySelector(".patch-review-title");
const status = dialog?.querySelector(".patch-review-status");
const close = dialog?.querySelector(".patch-review-close");
const activityProgress = dialog?.querySelector(".patch-review-progress");
const activity = dialog?.querySelector(".patch-review-activity");
const activityLatest = dialog?.querySelector(".patch-review-activity-latest");
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
const patchDiffLocation = dialog?.querySelector(".patch-review-context-diff-location");
const patchDiffContent = dialog?.querySelector(".patch-review-context-diff-content");
const coverage = dialog?.querySelector(".patch-review-coverage");
const coverageSummary = dialog?.querySelector(".patch-review-summary");
const coverageAccessibility = dialog?.querySelector(".patch-review-accessibility");
const coverageCodeRabbit = dialog?.querySelector(".patch-review-coderabbit");
const coverageStatic = dialog?.querySelector(".patch-review-static");
const coverageRuntime = dialog?.querySelector(".patch-review-runtime");
const coverageContext = dialog?.querySelector(".patch-review-context");
const issueSection = dialog?.querySelector(".patch-review-issue");
const severity = dialog?.querySelector(".patch-review-severity");
const issueTitle = dialog?.querySelector(".patch-review-issue-title");
const position = dialog?.querySelector(".patch-review-position");
const rationale = dialog?.querySelector(".patch-review-rationale");
const validation = dialog?.querySelector(".patch-review-validation");
const comment = dialog?.querySelector(".patch-review-comment");
const suggestionField = dialog?.querySelector(".patch-review-suggestion-field");
const suggestion = dialog?.querySelector(".patch-review-suggestion");
const experimentDiff = dialog?.querySelector(".patch-review-experiment-diff");
const experimentDiffContent = dialog?.querySelector(".patch-review-experiment-diff-content");
const applySuggestion = dialog?.querySelector(".patch-review-apply-suggestion");
const pendingComment = dialog?.querySelector(".patch-review-pending-comment");
const pendingSuggestion = dialog?.querySelector(".patch-review-pending-suggestion");
const skip = dialog?.querySelector(".patch-review-skip");
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
let activeIssueKey = "";
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

function getActivitySummary(entry = {}) {
  const heading = String(entry.title || "Codex activity");
  const detail = String(entry.detail || "").trim();

  return detail ? `${heading}: ${getActivityCommandPreview(detail)}` : heading;
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
  if (activityLatest) {
    activityLatest.textContent = items.length
      ? getActivitySummary(items.at(-1))
      : "Waiting for Codex activity...";
  }
  activityList.replaceChildren(...(
    visibleEntries.length
      ? visibleEntries.map(createActivityEntry)
      : [createActivityPlaceholder(
        items.length && activityFilter === "notes"
          ? "No Codex notes yet. Select All to include commands and file changes."
          : "Waiting for Codex activity...",
      )]
  ));

  if (followOutput) {
    window.requestAnimationFrame(() => {
      activityList.scrollTop = activityList.scrollHeight;
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
  if (item.codeSuggestion?.content) {
    const code = document.createElement("pre");

    code.textContent = item.codeSuggestion.content;
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

function renderDiscussion(currentDiscussion) {
  if (!discussion || !discussionList || !discussionCount) {
    return;
  }

  const value = currentDiscussion || {};
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

function appendCurrentIssue(issue) {
  if (!issue) {
    return null;
  }

  const row = findReviewLine(patchDiffContent, issue);

  if (!row) {
    return null;
  }

  row.classList.add("patch-review-context-line");
  const inline = appendInlineReviewComment(row, {
    action: "proposed review comment",
    author: "Codex",
    codeSuggestion: issue.codeSuggestion ? { content: issue.codeSuggestion } : null,
    content: issue.suggestedComment,
    dateCreated: 0,
  });

  inline.classList.add("patch-review-proposed-inline");
  return row;
}

function setPatchDiff(issue) {
  if (!patchDiffContent || !patchDiff || !patchDiffLocation) {
    return;
  }

  const key = getIssueDiffKey(issue);
  const contextKey = getReviewContextKey();

  if (!contextKey) {
    patchDiffLocation.textContent = "";
    patchDiffContent.replaceChildren();
    const loading = document.createElement("p");

    loading.className = "patch-review-diff-notice";
    loading.textContent = "Waiting for the exact Phabricator patch...";
    patchDiffContent.append(loading);
    return;
  }

  if (reviewContext.loading || reviewContext.key !== contextKey) {
    patchDiffLocation.textContent = "";
    patchDiffContent.replaceChildren();
    const loading = document.createElement("p");

    loading.className = "patch-review-diff-notice";
    loading.textContent = "Loading the exact Phabricator patch...";
    patchDiffContent.append(loading);
    loadReviewContext();
    return;
  }

  if (reviewContext.error) {
    patchDiffLocation.textContent = "";
    patchDiffContent.replaceChildren();
    const failed = document.createElement("p");

    failed.className = "patch-review-diff-notice error";
    failed.textContent = `Could not load the exact patch diff: ${reviewContext.error}`;
    patchDiffContent.append(failed);
    return;
  }

  if (!reviewContext.rawPatchHtml) {
    patchDiffLocation.textContent = "";
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
  const anchor = appendCurrentIssue(issue);

  patchDiffLocation.textContent = issue?.filePath
    ? `${issue.filePath}:${issue.lineNumber}`
    : "Exact Phabricator patch";
  renderDiscussion(reviewContext.reviewDiscussion);

  if (anchor && activeIssueKey !== key) {
    activeIssueKey = key;
    window.requestAnimationFrame(() => {
      anchor.scrollIntoView({ block: "center" });
    });
  }
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
      renderSession(session);
    }
  });
}

function renderExperimentDiff() {
  if (!experimentDiff || !experimentDiffContent) {
    return;
  }

  const key = getExperimentDiffKey();
  const current = experimentDiffState.key === key ? experimentDiffState : null;

  experimentDiff.hidden = !session?.id;
  experimentDiffContent.replaceChildren();
  if (!session?.id) {
    return;
  }

  if (current?.html) {
    experimentDiffContent.innerHTML = current.html;
  } else if (current?.text) {
    const raw = document.createElement("pre");

    raw.className = "patch-review-experiment-diff-raw";
    raw.textContent = current.text;
    experimentDiffContent.append(raw);
  } else {
    const message = document.createElement("p");

    message.className = current?.error
      ? "patch-review-diff-notice error"
      : "patch-review-diff-notice";
    message.textContent = current?.error
      ? `Could not load the Review checkout diff: ${current.error}`
      : current?.loading
        ? "Loading Review checkout changes..."
        : "No uncommitted experiment changes in the Review checkout.";
    experimentDiffContent.append(message);
  }

  if (!current?.html && !current?.text && !current?.loading && !current?.error) {
    loadExperimentDiff();
  }
}

function renderCoverage(value) {
  const current = value || {};
  const hasCoverage = Object.values(current).some(Boolean);

  coverage.hidden = !hasCoverage;
  coverageSummary.textContent = current.summary || "";
  coverageAccessibility.textContent = current.accessibility || "";
  coverageCodeRabbit.textContent = current.codeRabbit || "";
  coverageStatic.textContent = current.static || "";
  coverageRuntime.textContent = current.runtime || "";
  coverageContext.textContent = current.context || "";
}

function renderIssue(issue) {
  issueSection.hidden = !issue;

  if (!issue) {
    return;
  }

  severity.textContent = issue.severity || "nit";
  issueTitle.textContent = issue.title || "Review finding";
  position.textContent = `${issue.filePath}:${issue.lineNumber}`;
  rationale.textContent = issue.rationale || "";
  validation.textContent = issue.validation || "";
  if (document.activeElement !== comment) {
    comment.value = issue.suggestedComment || "";
  }
  const hasSuggestion = Boolean(issue.codeSuggestion);

  suggestionField.hidden = !hasSuggestion;
  if (document.activeElement !== suggestion) {
    suggestion.value = issue.codeSuggestion || "";
  }
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
  const busy = isBusy();
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
  status.textContent = getActionStatus() || actionError || session.message || session.error || "";
  status.classList.toggle("error", Boolean(actionError) || session.status === "error");
  output.textContent = visibleOutput;
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
  const hasCompletedReview = Boolean(
    session.patchContext || session.coverage || session.issues?.length,
  );

  setPatchDiff(hasCompletedReview ? issue : null);
  renderCoverage(session.coverage);
  renderIssue(hasCompletedReview ? issue : null);
  renderExperimentDiff();

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

  const canUseAi = session.aiEnabled && !busy && session.status !== "error";
  setButton(applySuggestion, {
    hidden: !issue?.codeSuggestion || !canUseAi || issue.state !== "ready",
    disabled: actionPending,
    text: pendingAction === "apply" ? "Applying..." : "Apply in Review Checkout",
  });
  setButton(pendingComment, {
    hidden: !issue || !canUseAi,
    disabled: actionPending || !comment?.value.trim(),
    text: pendingAction === "inline" ? "Saving Draft..." : "Add Comment as Pending",
  });
  setButton(pendingSuggestion, {
    hidden: !issue?.codeSuggestion || !canUseAi,
    disabled: actionPending || !comment?.value.trim() || !suggestion?.value.trim(),
    text: pendingAction === "inline" ? "Saving Draft..." : "Add Comment + Code Suggestion as Pending",
  });
  setButton(skip, {
    hidden: !issue || !canUseAi,
    disabled: actionPending,
    text: pendingAction === "skip" ? "Skipping..." : "Skip Issue",
  });

  finalSection.hidden = !completeReview;
  finalButtons?.forEach((button) => {
    setButton(button, {
      hidden: !completeReview,
      disabled: actionPending,
      text: pendingAction === "submit" ? "Posting..." : getFinalButtonText(button),
    });
  });
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(loadSession, 500);
}

async function loadSession() {
  if (!session?.id) {
    return null;
  }

  try {
    const response = await fetch(
      `/api/review/${encodeURIComponent(session.id)}?token=${encodeURIComponent(INTERACTIVE.token)}`,
      { cache: "no-store" },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load patch review status.");
    }

    renderSession(result);
    if (isBusy(result)) {
      schedulePoll();
    }
    return result;
  } catch (error) {
    status.classList.add("error");
    status.textContent = error?.message || String(error);
    return null;
  }
}

async function runAction(action, body = {}) {
  if (!session?.id) {
    return null;
  }

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

    pendingAction = "";
    if (action === "steer" && steerInput) {
      steerInput.value = "";
    }
    renderSession(result);
    if (isBusy(result)) {
      schedulePoll();
    }
    return result;
  } catch (error) {
    pendingAction = "";
    actionError = error?.message || String(error);
    renderSession(session);
    return null;
  }
}

function resetPatchReviewDialog(patch) {
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
  activeIssueKey = "";
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
  patchDiffLocation.textContent = "";
  patchDiffContent.replaceChildren();
  renderCoverage(null);
  renderIssue(null);
  experimentDiff.hidden = true;
  experimentDiffContent.replaceChildren();
  finalSection.hidden = true;
  finalMessage.value = "";
  setButton(applySuggestion, { hidden: true, text: "Apply in Review Checkout" });
  setButton(cancelPull, { hidden: true, text: "Cancel Pull" });
  setButton(pendingComment, { hidden: true, text: "Add Comment as Pending" });
  setButton(pendingSuggestion, { hidden: true, text: "Add Comment + Code Suggestion as Pending" });
  setButton(skip, { hidden: true, text: "Skip Issue" });
  finalButtons?.forEach((button) => setButton(button, { hidden: true }));
}

export async function openPatchReviewDialog({ patch }) {
  if (!dialog || !patch?.id) {
    return;
  }

  resetPatchReviewDialog(patch);
  setPageScrollLocked(true);
  dialog.showModal();

  try {
    const reviewGraphIndex = graphStates.findIndex((state) => (
      state.graph.checkout === "review" && state.graph.repository === "comm"
    ));
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        revision: patch.id,
        snapshotLimit: reviewGraphIndex === -1
          ? undefined
          : getLoadedGitCommitLimit(graphStates[reviewGraphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not start patch review.");
    }

    renderSession(result);
    schedulePoll();
  } catch (error) {
    status.classList.add("error");
    status.textContent = error?.message || String(error);
  }
}

export function initializePatchReviewDialog() {
  if (!dialog) {
    return;
  }

  close.addEventListener("click", () => {
    if (session?.status === "pulling") {
      void runAction("cancel");
    }
    dialog.close();
  });
  dialog.addEventListener("close", () => {
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
  comment.addEventListener("input", () => renderSession(session));
  suggestion.addEventListener("input", () => renderSession(session));
  steerInput?.addEventListener("input", () => renderSession(session));
  steerSubmit?.addEventListener("click", () => {
    void runAction("steer", { instruction: steerInput.value });
  });
  pendingComment.addEventListener("click", () => {
    const issue = getCurrentIssue();

    if (issue) {
      void runAction("inline", {
        itemId: issue.id,
        kind: "comment",
        message: comment.value,
      });
    }
  });
  applySuggestion?.addEventListener("click", () => {
    const issue = getCurrentIssue();

    if (issue) {
      void runAction("apply", { itemId: issue.id });
    }
  });
  pendingSuggestion.addEventListener("click", () => {
    const issue = getCurrentIssue();

    if (issue) {
      void runAction("inline", {
        itemId: issue.id,
        kind: "suggestion",
        message: comment.value,
        codeSuggestion: suggestion.value,
      });
    }
  });
  skip.addEventListener("click", () => {
    const issue = getCurrentIssue();

    if (issue) {
      void runAction("skip", { itemId: issue.id });
    }
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
