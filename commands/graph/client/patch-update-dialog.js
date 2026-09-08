import { GRAPHS, INTERACTIVE, graphStates } from "./config.js";
import {
  applyGraphSnapshot,
  getLoadedGitCommitLimit,
} from "./command-sessions.js";
import { openSubmitDialog } from "./commit-actions.js";
import { appendInlineReviewComment } from "./review-viewer.js";

const dialog = document.getElementById("patch-update-dialog");
const title = dialog?.querySelector(".patch-update-title");
const status = dialog?.querySelector(".patch-update-status");
const activityProgress = dialog?.querySelector(".patch-update-progress");
const patchContext = dialog?.querySelector(".patch-update-context");
const patchContextToggle = dialog?.querySelector(".patch-update-context-toggle");
const patchContextDetails = dialog?.querySelector(".patch-update-context-details");
const patchContextPurpose = dialog?.querySelector(".patch-update-context-purpose");
const patchContextContract = dialog?.querySelector(".patch-update-context-contract");
const patchContextStack = dialog?.querySelector(".patch-update-context-stack");
const patchContextStackText = dialog?.querySelector(".patch-update-context-stack-text");
const patchContextEvidence = dialog?.querySelector(".patch-update-context-evidence");
const patchContextEvidenceText = dialog?.querySelector(".patch-update-context-evidence-text");
const patchContextValidation = dialog?.querySelector(".patch-update-context-validation");
const patchContextValidationText = dialog?.querySelector(".patch-update-context-validation-text");
const reviewColumn = dialog?.querySelector(".patch-update-review-column");
const output = dialog?.querySelector(".patch-update-output");
const outputToggle = dialog?.querySelector(".patch-update-output-toggle");
const activity = dialog?.querySelector(".patch-update-activity");
const activityLatest = dialog?.querySelector(".patch-update-activity-latest");
const activityFilters = dialog?.querySelectorAll("[data-activity-filter]");
const activityList = dialog?.querySelector(".patch-update-activity-list");
const steer = dialog?.querySelector(".patch-update-steer");
const steerLabel = dialog?.querySelector(".patch-update-steer-label");
const steerInput = dialog?.querySelector(".patch-update-steer-input");
const steerSubmit = dialog?.querySelector(".patch-update-steer-submit");
const comment = dialog?.querySelector(".patch-update-comment");
const commentAuthor = dialog?.querySelector(".patch-update-comment-author");
const commentKind = dialog?.querySelector(".patch-update-comment-kind");
const commentLink = dialog?.querySelector(".patch-update-comment-link");
const commentLocation = dialog?.querySelector(".patch-update-comment-location");
const feedbackHeading = dialog?.querySelector(".patch-update-feedback-heading");
const commentContent = dialog?.querySelector(".patch-update-comment-content");
const suggestion = dialog?.querySelector(".patch-update-suggestion");
const codeSuggestion = dialog?.querySelector(".patch-update-code-suggestion");
const commentContext = dialog?.querySelector(".patch-update-comment-context");
const commentContextLocation = dialog?.querySelector(".patch-update-comment-context-location");
const commentContextDiff = dialog?.querySelector(".patch-update-comment-context-diff");
const analysis = dialog?.querySelector(".patch-update-analysis");
const analysisHeading = analysis?.querySelector("h3");
const recommendation = dialog?.querySelector(".patch-update-recommendation");
const assessment = dialog?.querySelector(".patch-update-assessment");
const rationale = dialog?.querySelector(".patch-update-rationale");
const rationaleText = dialog?.querySelector(".patch-update-rationale-text");
const validation = dialog?.querySelector(".patch-update-validation");
const validationText = dialog?.querySelector(".patch-update-validation-text");
const changePlan = dialog?.querySelector(".patch-update-change-plan");
const changeSummary = dialog?.querySelector(".patch-update-change-summary");
const proposedDiff = dialog?.querySelector(".patch-update-proposed-diff");
const proposedDiffContent = dialog?.querySelector(".patch-update-proposed-diff-content");
const replyLabel = dialog?.querySelector(".patch-update-reply-label");
const reply = dialog?.querySelector(".patch-update-reply");
const keep = dialog?.querySelector(".patch-update-keep");
const revert = dialog?.querySelector(".patch-update-revert");
const post = dialog?.querySelector(".patch-update-post");
const handled = dialog?.querySelector(".patch-update-handled");
const amend = dialog?.querySelector(".patch-update-amend");
const submit = dialog?.querySelector(".patch-update-submit");

let session;
let pollTimer;
let outputVisible = false;
let activityFilter = "notes";
let activityFollowsLatest = true;
let appliedSnapshotKey = "";
let pendingAction = "";
let patchContextExpanded = false;
let patchContextKey = "";
let workingTreeDiff = {
  error: "",
  html: "",
  key: "",
  loading: false,
  text: "",
};
let workingTreeDiffRequest = "";
let activeWorkingTreeDiffItemKey = "";
const expandedActivityCommandIds = new Set();

function isBusy(currentSession = session) {
  return ["preparing", "reviewing", "applying", "amending"].includes(currentSession?.status);
}

function getCurrentItem(currentSession = session) {
  if (!currentSession?.items?.length) {
    return null;
  }

  return currentSession.items.slice(currentSession.currentItemIndex || 0)
    .find((item) => item.state !== "handled") || null;
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
  document.documentElement.classList.toggle("patch-update-open", isLocked);
  document.body.classList.toggle("patch-update-open", isLocked);
}

function isCommandActivity(entry) {
  return /\bcommand\b/i.test(String(entry?.title || ""));
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

function getActivitySummary(entry) {
  const title = String(entry?.title || "Codex activity");
  const detail = String(entry?.detail || "").trim()
    ? getActivityCommandPreview(entry.detail)
    : "";

  return detail ? `${title}: ${detail}` : title;
}

function renderActivityFilter() {
  activityFilters?.forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.activityFilter === activityFilter),
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
  const title = document.createElement("strong");
  const preview = document.createElement("span");
  const detail = document.createElement("code");

  details.className = "patch-update-activity-command-disclosure";
  details.open = expandedActivityCommandIds.has(entry.id);
  summary.className = "patch-update-activity-command-summary";
  title.textContent = entry.title || "Command";
  preview.className = "patch-update-activity-command-preview";
  preview.textContent = getActivityCommandPreview(entry.detail);
  detail.textContent = entry.detail;
  summary.append(title, preview);
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
  const title = document.createElement("strong");
  const command = isCommandActivity(entry);

  row.className = `patch-update-activity-entry patch-update-activity-${entry.kind || "status"}` +
    (command ? " patch-update-activity-command-row" : "");

  if (command && entry.detail) {
    row.append(createCommandActivityDisclosure(entry));
    return row;
  }

  title.textContent = entry.title || "Codex activity";
  row.append(title);

  if (entry.detail) {
    const detail = document.createElement("code");

    detail.textContent = entry.detail;
    row.append(detail);
  }

  return row;
}

function createActivityPlaceholder(text) {
  const placeholder = document.createElement("li");

  placeholder.className = "patch-update-activity-empty";
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
      ? getActivitySummary(items[items.length - 1])
      : "Waiting for Codex activity...";
  }
  activityList.replaceChildren(...(
    visibleEntries.length
      ? visibleEntries.map(createActivityEntry)
      : [createActivityPlaceholder(
        items.length && activityFilter === "notes"
          ? "No Codex notes yet. Select All to include other activity."
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

function getPatchUpdateOutput(currentSession = session) {
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

  if (patchContextToggle) {
    patchContextToggle.setAttribute("aria-expanded", String(patchContextExpanded));
  }

  if (patchContextDetails) {
    patchContextDetails.hidden = !patchContextExpanded;
  }
}

function setPatchContext(context) {
  if (!patchContext) {
    return;
  }

  const value = context || {};
  const purpose = formatDisplayValue(value.purpose);
  const behaviorContract = formatDisplayValue(value.behaviorContract);
  const stackContext = formatDisplayValue(value.stackContext);
  const evidence = formatDisplayValue(value.evidence);
  const validationText = formatDisplayValue(value.validation);
  const hasContext = Boolean(purpose || behaviorContract);
  const key = [purpose, behaviorContract, stackContext, evidence, validationText].join("\u0000");

  if (key !== patchContextKey) {
    patchContextKey = key;
    patchContextExpanded = false;
  }

  patchContext.hidden = !hasContext;
  patchContextPurpose.textContent = purpose;
  patchContextContract.textContent = behaviorContract;
  patchContextStack.hidden = !stackContext;
  patchContextStackText.textContent = stackContext;
  patchContextEvidence.hidden = !evidence;
  patchContextEvidenceText.textContent = evidence;
  patchContextValidation.hidden = !validationText;
  patchContextValidationText.textContent = validationText;
  setPatchContextExpanded(hasContext && patchContextExpanded);
}

function updateReviewColumnVisibility() {
  if (reviewColumn) {
    reviewColumn.hidden = Boolean(patchContext?.hidden && comment?.hidden);
  }
}

function getCommentContextRows(item) {
  if (!commentContextDiff) {
    return [];
  }

  const lineStart = Number(item?.lineNumber);
  const lineLength = Math.max(1, Number(item?.lineLength) || 1);
  const side = item?.contextLineSide === "old" ? "old" : "new";

  if (!Number.isInteger(lineStart) || lineStart < 1) {
    return [];
  }

  const rows = [];

  for (let line = lineStart; line < lineStart + lineLength; line++) {
    for (const row of commentContextDiff.querySelectorAll(
      `.diff-line[data-${side}-line="${line}"]`,
    )) {
      row.classList.add("comment-context-line");
      rows.push(row);
    }
  }

  return rows;
}

function setCommentContext(item) {
  if (!commentContext || !commentContextLocation || !commentContextDiff) {
    return;
  }

  const html = String(item?.contextDiffHtml || "");

  commentContext.hidden = !html;
  commentContextLocation.textContent = item?.filePath
    ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    : "";
  commentContextDiff.innerHTML = html;
  const [anchor] = getCommentContextRows(item);

  if (anchor && item?.type === "inline") {
    appendInlineReviewComment(anchor, {
      action: "comment",
      author: item.author,
      codeSuggestion: item.codeSuggestion ? {
        content: item.codeSuggestion,
        url: item.url,
      } : null,
      content: item.content,
      dateCreated: item.dateCreated,
    });
  }
}

function getWorkingTreeDiffKey(item) {
  if (!session?.id) {
    return "";
  }

  return [
    session.id,
    session.graphIndex,
    session.currentHash,
    session.workingTreeDiffVersion,
    session.currentItemIndex,
    item?.id || "working-tree",
    item?.changeApplied || false,
    item?.changeAccepted || false,
  ].join(":");
}

function resetWorkingTreeDiffForActiveComment(item) {
  const itemKey = item
    ? [session?.id, session?.currentItemIndex, item.id].join(":")
    : "";

  if (itemKey === activeWorkingTreeDiffItemKey) {
    return;
  }

  activeWorkingTreeDiffItemKey = itemKey;
  // A review item change can mean that Codex changed the checkout for the
  // preceding item. Do not reuse its diff for the next review item.
  workingTreeDiff = {
    error: "",
    html: "",
    key: "",
    loading: false,
    text: "",
  };
  workingTreeDiffRequest = "";
}

function loadWorkingTreeDiff(item) {
  const key = getWorkingTreeDiffKey(item);

  if (!key || workingTreeDiffRequest === key || workingTreeDiff.key === key) {
    return;
  }

  workingTreeDiffRequest = key;
  workingTreeDiff = {
    error: "",
    html: "",
    key,
    loading: true,
    text: "",
  };
  void fetch(
    "/api/graph/" + encodeURIComponent(session.graphIndex) +
      "/diff/uncommitted-changes?token=" + encodeURIComponent(INTERACTIVE.token),
    { cache: "no-store" },
  ).then(async (response) => {
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load the working-tree diff.");
    }

    return result;
  }).then((result) => {
    if (workingTreeDiffRequest !== key) {
      return;
    }

    workingTreeDiff = {
      error: "",
      html: String(result.html || ""),
      key,
      loading: false,
      text: String(result.text || ""),
    };
  }).catch((error) => {
    if (workingTreeDiffRequest !== key) {
      return;
    }

    workingTreeDiff = {
      error: error?.message || String(error),
      html: "",
      key,
      loading: false,
      text: "",
    };
  }).finally(() => {
    if (workingTreeDiffRequest === key) {
      workingTreeDiffRequest = "";
      renderSession(session);
    }
  });
}

function setWorkingTreeDiff(item) {
  resetWorkingTreeDiffForActiveComment(item);
  const key = getWorkingTreeDiffKey(item);
  const currentDiff = workingTreeDiff.key === key ? workingTreeDiff : null;
  const workingDiff = String(currentDiff?.text || "").trim();
  const workingDiffHtml = currentDiff?.html || "";
  const hasWorkingDiff = Boolean(workingDiff || workingDiffHtml);
  const needsChange = Boolean(
    item?.requiresChanges ||
    item?.changeApplied ||
    item?.changeReverted ||
    hasWorkingDiff,
  );
  const hasPatchUpdateSession = Boolean(session?.id);
  const shouldLoadWorkingTreeDiff = Boolean(
    key && !hasWorkingDiff && !currentDiff?.loading && !currentDiff?.error,
  );

  // The working-tree diff is the source of truth. It must remain available
  // while this Patch Update session exists, even between review comments.
  proposedDiff.hidden = !hasPatchUpdateSession;
  if (!hasPatchUpdateSession) {
    proposedDiffContent.replaceChildren();
  } else if (hasWorkingDiff) {
    if (workingDiffHtml) {
      proposedDiffContent.innerHTML = workingDiffHtml;
    } else {
      // Rendering must never hide a real source change. Keep the unified diff
      // available even if the enhanced renderer cannot recognize its format.
      const rawDiff = document.createElement("pre");

      rawDiff.className = "patch-update-proposed-diff-raw";
      rawDiff.textContent = workingDiff;
      proposedDiffContent.replaceChildren(rawDiff);
    }
  } else if (currentDiff?.loading || shouldLoadWorkingTreeDiff) {
    const loadingDiff = document.createElement("p");

    loadingDiff.className = "patch-update-proposed-diff-loading";
    loadingDiff.textContent = "Loading the actual uncommitted diff from the current checkout...";
    proposedDiffContent.replaceChildren(loadingDiff);
  } else if (currentDiff?.error) {
    const failedDiff = document.createElement("p");

    failedDiff.className = "patch-update-proposed-diff-missing";
    failedDiff.textContent = `Could not load the actual uncommitted diff: ${currentDiff.error}`;
    proposedDiffContent.replaceChildren(failedDiff);
  } else {
    const missingDiff = document.createElement("p");

    missingDiff.className = "patch-update-proposed-diff-missing";
    missingDiff.textContent = item?.changeReverted
      ? "The candidate was reverted, so there is no remaining working-tree diff for this comment."
      : "There are no uncommitted changes in the current checkout.";
    proposedDiffContent.replaceChildren(missingDiff);
  }

  if (shouldLoadWorkingTreeDiff) {
    loadWorkingTreeDiff(item);
  }

  return { needsChange };
}

function setComment(item) {
  if (!comment) {
    return;
  }

  const { needsChange } = setWorkingTreeDiff(item);

  comment.hidden = !item;

  if (!item) {
    setCommentContext(null);
    // The diff lives inside the analysis column, so do not hide its parent
    // when the active item advances or all comments have been handled.
    analysis.hidden = !session?.id;
    analysisHeading.hidden = true;
    recommendation.hidden = true;
    recommendation.textContent = "";
    assessment.hidden = true;
    assessment.textContent = "";
    rationale.hidden = true;
    rationaleText.textContent = "";
    validation.hidden = true;
    validationText.textContent = "";
    if (changePlan) {
      changePlan.hidden = true;
    }
    if (changeSummary) {
      changeSummary.textContent = "";
    }
    if (replyLabel) {
      replyLabel.hidden = true;
    }
    updateReviewColumnVisibility();
    return;
  }

  commentAuthor.textContent = item.author;
  commentKind.textContent = item.feedbackType;
  const isInlineInContext = item.type === "inline" && Boolean(item.contextDiffHtml);

  feedbackHeading.hidden = !item.content || isInlineInContext;
  commentContent.hidden = !item.content || isInlineInContext;
  commentContent.textContent = item.content;
  commentLocation.hidden = !item.filePath || isInlineInContext;
  commentLocation.textContent = item.filePath
    ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    : "";
  suggestion.hidden = !item.codeSuggestion || isInlineInContext;
  codeSuggestion.textContent = item.codeSuggestion || "";
  setCommentContext(item);
  commentLink.hidden = !item.url;
  commentLink.href = item.url || "";
  const hasAnalysis = Boolean(
    item.assessment ||
    item.rationale ||
    item.validation ||
    needsChange,
  );

  analysis.hidden = !hasAnalysis;
  analysisHeading.hidden = false;
  recommendation.hidden = false;
  recommendation.textContent = getRecommendationLabel(item);
  assessment.hidden = false;
  assessment.textContent = item.assessment || (
    needsChange
      ? "Codex recommended a source change. The actual working-tree diff is shown below when one is prepared."
      : ""
  );
  rationale.hidden = !item.rationale;
  rationaleText.textContent = item.rationale || "";
  validation.hidden = !item.validation;
  validationText.textContent = item.validation || "";

  if (changePlan) {
    changePlan.hidden = !needsChange;
  }
  if (changeSummary) {
    changeSummary.textContent = item.changeApplied
      ? item.changeAccepted
        ? "This working-tree change is kept and will be included when you amend the patch."
        : "Codex changed the working checkout. Review the actual uncommitted diff below, then keep or revert this candidate."
      : item.changeReverted
        ? "This candidate change was reverted."
        : item.state === "applying"
          ? "Codex is applying the recommended source change in the working checkout."
          : item.changeSummary || "Codex did not prepare a source change for this comment.";
  }

  if (reply && document.activeElement !== reply) {
    reply.value = item.suggestedReply || "";
  }
  if (replyLabel) {
    replyLabel.hidden = false;
  }
  updateReviewColumnVisibility();
}

function getRecommendationLabel(item) {
  const labels = {
    change: "Make the planned source change",
    reply: "Reply without changing source",
    "no-action": "No additional action is recommended",
    discussion: "Discuss this before changing source",
  };

  return labels[item.recommendation] || "Codex completed its review";
}

function resetPatchUpdateDialog(patch) {
  session = undefined;
  pendingAction = "";
  outputVisible = false;
  activityFilter = "notes";
  activityFollowsLatest = true;
  appliedSnapshotKey = "";
  patchContextExpanded = false;
  patchContextKey = "";
  workingTreeDiff = {
    error: "",
    html: "",
    key: "",
    loading: false,
    text: "",
  };
  workingTreeDiffRequest = "";
  activeWorkingTreeDiffItemKey = "";
  expandedActivityCommandIds.clear();
  window.clearTimeout(pollTimer);
  title.textContent = `${patch.id} update`;
  status.classList.remove("error");
  status.textContent = "Preparing update...";
  if (activityProgress) {
    activityProgress.open = true;
  }
  setPatchContext(null);
  output.textContent = "";
  output.hidden = true;
  dialog.classList.remove("output-expanded");
  outputToggle.hidden = true;
  outputToggle.textContent = "Output";
  if (steer) {
    steer.hidden = true;
  }
  if (steerInput) {
    steerInput.value = "";
  }
  if (steerSubmit) {
    steerSubmit.disabled = true;
  }
  renderActivityFilter();
  renderActivity([]);
  setComment(null);

  if (commentAuthor) {
    commentAuthor.textContent = "";
  }
  if (commentKind) {
    commentKind.textContent = "";
  }
  if (commentLink) {
    commentLink.hidden = true;
    commentLink.href = "";
  }
  if (commentLocation) {
    commentLocation.hidden = true;
    commentLocation.textContent = "";
  }
  if (feedbackHeading) {
    feedbackHeading.hidden = true;
  }
  if (commentContent) {
    commentContent.textContent = "";
  }
  if (suggestion) {
    suggestion.hidden = true;
  }
  if (codeSuggestion) {
    codeSuggestion.textContent = "";
  }
  setCommentContext(null);
  if (analysis) {
    analysis.hidden = true;
  }
  if (recommendation) {
    recommendation.textContent = "";
  }
  if (assessment) {
    assessment.textContent = "";
  }
  if (rationale) {
    rationale.hidden = true;
  }
  if (rationaleText) {
    rationaleText.textContent = "";
  }
  if (validation) {
    validation.hidden = true;
  }
  if (validationText) {
    validationText.textContent = "";
  }
  if (changePlan) {
    changePlan.hidden = true;
  }
  if (changeSummary) {
    changeSummary.textContent = "";
  }
  if (proposedDiff) {
    proposedDiff.hidden = true;
  }
  if (proposedDiffContent) {
    proposedDiffContent.replaceChildren();
  }
  if (reply) {
    reply.value = "";
  }
  if (replyLabel) {
    replyLabel.hidden = true;
  }
  setButton(keep, { hidden: true, text: "Keep and Amend" });
  setButton(revert, { hidden: true, text: "Revert Change" });
  setButton(post, { hidden: true, text: "Save Reply Draft" });
  setButton(handled, { hidden: true, text: "Mark Handled" });
  setButton(amend, { hidden: true, text: "Amend Patch" });
  setButton(submit, { hidden: true, text: "Submit Patch" });
}

function renderSession(currentSession) {
  session = currentSession;
  const busy = isBusy();
  const actionPending = Boolean(pendingAction);
  const item = getCurrentItem();
  const visibleOutput = getPatchUpdateOutput(session);
  const hasOutput = Boolean(visibleOutput);
  const allHandled = session.items?.length && !item;
  const needsAmend = session.items?.some((candidate) => (
    candidate.changeApplied && candidate.changeAccepted && !candidate.changesAmended
  ));

  if (session.snapshot) {
    const snapshotKey = `${session.id}:${session.currentHash}`;

    if (snapshotKey !== appliedSnapshotKey) {
      appliedSnapshotKey = snapshotKey;
      applyGraphSnapshot(session.graphIndex, session.snapshot, { force: true });
    }
  }

  title.textContent = `${session.revision} update`;
  status.textContent = session.message || session.error || "";
  status.classList.toggle("error", session.status === "error" || Boolean(item?.error));
  output.textContent = visibleOutput;
  output.hidden = !outputVisible || !hasOutput;
  outputToggle.hidden = !hasOutput;
  outputToggle.textContent = outputVisible ? "Back to Review" : "Output";
  dialog.classList.toggle("output-expanded", outputVisible && hasOutput);
  renderActivity(session.activity);
  setPatchContext(session.patchContext);
  setComment(busy ? null : item);
  const canGuideCurrentComment = session.aiEnabled && !busy &&
    session.status !== "error" && Boolean(item) && !item.changeApplied;
  const canSteer = session.aiEnabled && (
    (session.status === "reviewing" && Boolean(session.codexTurnId)) ||
    canGuideCurrentComment
  );

  if (steer) {
    steer.hidden = !canSteer;
  }
  if (steerLabel) {
    steerLabel.textContent = canGuideCurrentComment
      ? "Guide Codex on this comment"
      : "Guide Codex";
  }
  if (steerInput && document.activeElement !== steerInput) {
    steerInput.placeholder = canGuideCurrentComment
      ? "Ask Codex to reconsider, explain, or revise this assessment."
      : "Add context, question an assumption, or change direction.";
  }
  if (steerSubmit) {
    steerSubmit.disabled = actionPending || !steerInput?.value.trim();
    steerSubmit.textContent = pendingAction === "steer" || pendingAction === "feedback"
      ? "Sending..."
      : "Send";
  }
  const replyValue = reply?.value || "";

  const canUseAi = session.aiEnabled && !busy && session.status !== "error";
  const hasPreparedChange = Boolean(item?.changeApplied && !item?.changeReverted);
  setButton(keep, {
    hidden: !hasPreparedChange || item?.changeAccepted || !canUseAi,
    disabled: actionPending,
    text: pendingAction === "keep" ? "Amending..." : "Keep and Amend",
  });
  setButton(revert, {
    hidden: !hasPreparedChange || !canUseAi,
    disabled: actionPending,
    text: pendingAction === "revert" ? "Reverting..." : "Revert Change",
  });
  setButton(post, {
    hidden: !item?.assessment || !canUseAi || item.state === "handled",
    disabled: actionPending || (item?.changeApplied && !item?.changeAccepted) || !replyValue.trim() || (
      item?.draftReply === replyValue && item?.draftSaved
    ),
    text: pendingAction === "comment"
      ? "Saving Reply..."
      : item?.draftReply === replyValue && item?.draftSaved
      ? "Reply Draft Saved"
      : "Save Reply Draft",
  });
  setButton(handled, {
    hidden: !item || !canUseAi || busy,
    disabled: actionPending || (item?.changeApplied && !item?.changeAccepted),
    text: pendingAction === "handled" ? "Marking..." : "Mark Handled",
  });
  setButton(amend, {
    hidden: !session.aiEnabled || !needsAmend,
    disabled: actionPending || busy || !allHandled,
    text: pendingAction === "amend" || session.status === "amending"
      ? "Amending..."
      : "Amend Patch",
  });
  setButton(submit, {
    hidden: !session.aiEnabled || busy || session.status === "error" || (!allHandled && session.items?.length),
    disabled: actionPending || !session.currentHash || needsAmend,
    text: needsAmend ? "Amend changes before submitting" : "Submit Patch",
  });
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(loadSession, 500);
}

async function loadSession() {
  if (!session?.id) {
    return;
  }

  try {
    const response = await fetch(
      `/api/patch-update/${encodeURIComponent(session.id)}?token=${encodeURIComponent(INTERACTIVE.token)}`,
      { cache: "no-store" },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load patch update status.");
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
  if (!session?.id || pendingAction) {
    return null;
  }

  pendingAction = action;
  renderSession(session);

  try {
    const response = await fetch(
      `/api/patch-update/${encodeURIComponent(session.id)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: INTERACTIVE.token, ...body }),
      },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Could not ${action} this comment.`);
    }

    pendingAction = "";
    renderSession(result);

    if (isBusy(result)) {
      schedulePoll();
    }
    return result;
  } catch (error) {
    pendingAction = "";
    renderSession(session);
    status.classList.add("error");
    status.textContent = error?.message || String(error);
    return null;
  }
}

export async function openPatchUpdateDialog({ patch, graphIndex }) {
  if (!dialog || !patch?.id) {
    return;
  }

  resetPatchUpdateDialog(patch);
  setPageScrollLocked(true);
  dialog.showModal();

  try {
    const response = await fetch("/api/patch-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        graphIndex,
        revision: patch.id,
        snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not start patch update.");
    }

    renderSession(result);
    schedulePoll();
  } catch (error) {
    status.classList.add("error");
    status.textContent = error?.message || String(error);
  }
}

export function initializePatchUpdateDialog() {
  if (!dialog) {
    return;
  }

  dialog.querySelector(".patch-update-close").addEventListener("click", () => {
    window.clearTimeout(pollTimer);
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    setPageScrollLocked(false);
  });
  outputToggle?.addEventListener("click", () => {
    outputVisible = !outputVisible;
    renderSession(session);
  });
  activityFilters?.forEach((button) => {
    button.addEventListener("click", () => {
      setActivityFilter(button.dataset.activityFilter);
    });
  });
  activityList?.addEventListener("scroll", updateActivityFollowState, { passive: true });
  patchContextToggle?.addEventListener("click", () => {
    if (!patchContext?.hidden) {
      setPatchContextExpanded(!patchContextExpanded);
    }
  });
  steer?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = steerInput?.value.trim();

    if (!value) {
      return;
    }

    const item = getCurrentItem();
    const isCommentFeedback = session?.aiEnabled && !isBusy() &&
      session.status !== "error" && Boolean(item);
    const result = await runAction(
      isCommentFeedback ? "feedback" : "steer",
      isCommentFeedback
        ? { itemId: item.id, instruction: value }
        : { instruction: value },
    );

    if (result) {
      steerInput.value = "";
      renderSession(session);
    }
  });
  steerInput?.addEventListener("input", () => renderSession(session));
  keep?.addEventListener("click", () => {
    const item = getCurrentItem();

    if (item) {
      runAction("keep", { itemId: item.id });
    }
  });
  revert?.addEventListener("click", () => {
    const item = getCurrentItem();

    if (item) {
      runAction("revert", { itemId: item.id });
    }
  });
  post?.addEventListener("click", () => {
    const item = getCurrentItem();

    if (item) {
      runAction("comment", { itemId: item.id, message: reply?.value || "" });
    }
  });
  handled?.addEventListener("click", () => {
    const item = getCurrentItem();

    if (item) {
      runAction("handled", { itemId: item.id });
    }
  });
  amend?.addEventListener("click", () => {
    runAction("amend", {
      snapshotLimit: getLoadedGitCommitLimit(graphStates[session.graphIndex]),
    });
  });
  reply?.addEventListener("input", () => {
    const item = getCurrentItem();

    if (item) {
      item.suggestedReply = reply.value;
    }

    renderSession(session);
  });
  submit?.addEventListener("click", () => {
    if (!session?.currentHash) {
      return;
    }

    const button = document.createElement("button");

    button.dataset.graphIndex = String(session.graphIndex);
    button.dataset.hash = session.currentHash;
    button.dataset.label = GRAPHS[session.graphIndex]?.label || "comm";
    openSubmitDialog(button, { patchUpdateSessionId: session.id });
  });
}
