import { uiState } from "./config.js";
import { openRebaseFailureDialog } from "./rebase-dialog.js";
import { setLiveText, replaceChangedChildren, hasSelectedText } from "./live-text.js";
import { createActivityEntry as createSharedActivityEntry, bindAiFeedbackForm } from "./ai-dialog-controls.js";
import { registerAiTaskDialog, enableTaskNotifications } from "./ai-task-tray.js";
import { showSystemConfirmation } from "./system-dialog.js";
import { createReviewAttentionScroller } from "./review-attention.js";
import { GRAPHS, INTERACTIVE, graphStates, BUGZILLA_BUG_URL, PHABRICATOR_REVISION_URL } from "./config.js";
import {
  applyGraphSnapshot,
  getLoadedGitCommitLimit,
} from "./command-sessions.js";
import { openSubmitDialog } from "./commit-actions.js";
import { appendInlineReviewComment, findReviewLine } from "./review-viewer.js";
import { startOrResumePatchSession } from "./patch-session-resume.js";
import { createCodexRunStatus } from "./codex-run-status.js";

const dialog = document.getElementById("patch-update-dialog");
const runStatus = createCodexRunStatus(dialog);
const taskView = registerAiTaskDialog({ kind: "update", dialog, title: value => `${value.revision} ${value.mode === "verify" ? "Verify" : value.mode === "freeform" ? "Update" : "Review Update"}`,
  restore: restorePatchUpdateTask, onUpdate: renderSession,
  recover: task => openPatchUpdateDialog({ patch: { id: task.revision }, graphIndex: task.graphIndex, mode: task.mode }),
});
let viewGeneration = 0;
const title = dialog?.querySelector(".patch-update-title");
const phabLink = dialog?.querySelector(".patch-update-phab-link");
const bugLink = dialog?.querySelector(".patch-update-bug-link");

function setPatchLinks(revision, bugId) {
  const revisionId = String(revision || "").match(/^D?(\d+)$/)?.[1];
  phabLink.hidden = !revisionId;
  if (revisionId) {
    phabLink.href = `${PHABRICATOR_REVISION_URL}${revisionId}`;
  }
  if (bugId !== undefined) {
    const id = String(bugId || "").match(/^\d+$/)?.[0];
    bugLink.hidden = !id;
    if (id) {
      bugLink.href = `${BUGZILLA_BUG_URL}${id}`;
      bugLink.textContent = `Bug ${id}`;
    }
  }
}
const status = dialog?.querySelector(".patch-update-status");
const retry = dialog?.querySelector(".patch-update-retry");
const rollback = dialog?.querySelector(".patch-update-rollback");
const chat = dialog?.querySelector(".patch-update-chat");
let renderedChat = "";
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
const output = dialog?.querySelector(".patch-update-output");
const outputToggle = dialog?.querySelector(".patch-update-output-toggle");
const activity = dialog?.querySelector(".patch-update-activity");
const activityLatest = dialog?.querySelector(".patch-update-activity-latest");
const activityFilters = dialog?.querySelectorAll("[data-activity-filter]");
const activityList = dialog?.querySelector(".patch-update-activity-list");
const results = dialog?.querySelector(".patch-update-results");
const resultItems = dialog?.querySelector(".patch-update-results-items");
const followUpAnswer = dialog?.querySelector(".patch-update-follow-up-answer");
const steer = dialog?.querySelector(".patch-update-steer");
const steerLabel = dialog?.querySelector(".patch-update-steer-label");
const steerInput = dialog?.querySelector(".patch-update-steer-input");
const steerSubmit = dialog?.querySelector(".patch-update-steer-submit");
const patchDiff = dialog?.querySelector(".patch-update-context-diff");
const patchDiffContent = dialog?.querySelector(".patch-update-context-diff-content");
const amend = dialog?.querySelector(".patch-update-amend");
const submit = dialog?.querySelector(".patch-update-submit");

let session;
let pollTimer;
let outputVisible = false;
let activityFilter = "notes";
let activityFollowsLatest = true;
let appliedSnapshotKey = "";
let pendingAction = "";
let submitError = "";
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
let workingTreeDiffAbortController = null;
let activeWorkingTreeDiffItemKey = "";
let patchDiffState = {
  error: "",
  html: "",
  key: "",
  loading: false,
  text: "",
};
let patchDiffRequest = "";
let renderedPatchDiffKey = "";
const scrollToAttention = createReviewAttentionScroller();
const expandedActivityCommandIds = new Set();

function getWorkingTreeDiffTimeoutMs() {
  const testTimeout = Number(globalThis.__TB_TOOLS_TEST_WORKING_TREE_DIFF_TIMEOUT_MS__);

  return Number.isFinite(testTimeout) && testTimeout > 0
    ? testTimeout
    : 5_000;
}

function cancelWorkingTreeDiffRequest() {
  workingTreeDiffAbortController?.abort("The active comment changed.");
  workingTreeDiffAbortController = null;
}

function isBusy(currentSession = session) {
  return ["preparing", "reviewing", "applying", "amending"].includes(currentSession?.status);
}

function getCurrentItem(currentSession = session) {
  if (!currentSession?.items?.length) {
    return null;
  }

  return currentSession.items.slice(currentSession.currentItemIndex || 0)
    .find((item) => item.state !== "handled" && item.state !== "skipped") || null;
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
    setLiveText(activityLatest, items.length
      ? getActivitySummary(items[items.length - 1])
      : "Waiting for Codex activity...");
  }
  const activityChanged = replaceChangedChildren(activityList, ...(
    visibleEntries.length
      ? visibleEntries.map(entry => createSharedActivityEntry(entry, expandedActivityCommandIds))
      : [createActivityPlaceholder(
        items.length && activityFilter === "notes"
          ? "No Codex notes yet. Select All to include other activity."
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

function getPatchDiffKey(value = session) {
  if (!value?.id || value.graphIndex === undefined || !value.currentHash) {
    return "";
  }

  return [value.id, value.graphIndex, value.currentHash].join(":");
}

function loadPatchDiff() {
  const key = getPatchDiffKey();

  if (!key || patchDiffRequest === key || patchDiffState.key === key) {
    return;
  }

  patchDiffRequest = key;
  patchDiffState = {
    error: "",
    html: "",
    key,
    loading: true,
    text: "",
  };
  void fetch(
    `/api/graph/${encodeURIComponent(session.graphIndex)}/diff/${encodeURIComponent(session.currentHash)}?token=${encodeURIComponent(INTERACTIVE.token)}&patchUpdateSession=${encodeURIComponent(session.id)}`,
    { cache: "no-store" },
  ).then(async (response) => {
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load the patch diff.");
    }

    return result;
  }).then((result) => {
    if (patchDiffRequest !== key) {
      return;
    }

    patchDiffState = {
      error: "",
      html: String(result.html || ""),
      key,
      loading: false,
      text: String(result.text || ""),
    };
  }).catch((error) => {
    if (patchDiffRequest !== key) {
      return;
    }

    patchDiffState = {
      error: error?.message || String(error),
      html: "",
      key,
      loading: false,
      text: "",
    };
  }).finally(() => {
    if (patchDiffRequest === key) {
      patchDiffRequest = "";
      renderedPatchDiffKey = "";
      renderSession(session);
    }
  });
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

  cancelWorkingTreeDiffRequest();
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
  const controller = new AbortController();
  const timeoutMs = getWorkingTreeDiffTimeoutMs();
  const timeout = window.setTimeout(() => {
    controller.abort(`The local working-tree diff did not finish within ${timeoutMs / 1_000} seconds.`);
  }, timeoutMs);

  workingTreeDiffAbortController = controller;
  workingTreeDiff = {
    error: "",
    html: "",
    key,
    loading: true,
    text: "",
  };
  void fetch(
    "/api/graph/" + encodeURIComponent(session.graphIndex) +
      "/diff/uncommitted-changes?token=" + encodeURIComponent(INTERACTIVE.token) +
      "&patchUpdateSession=" + encodeURIComponent(session.id),
    { cache: "no-store", signal: controller.signal },
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
      error: controller.signal.aborted
        ? String(controller.signal.reason || "The local working-tree diff request was canceled.")
        : error?.message || String(error),
      html: "",
      key,
      loading: false,
      text: "",
    };
  }).finally(() => {
    window.clearTimeout(timeout);
    if (workingTreeDiffAbortController === controller) {
      workingTreeDiffAbortController = null;
    }
    if (workingTreeDiffRequest === key) {
      workingTreeDiffRequest = "";
      renderedPatchDiffKey = "";
      renderSession(session);
    }
  });
}

function getWorkingTreeDiffState(item) {
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
  const shouldLoadWorkingTreeDiff = Boolean(
    key && !hasWorkingDiff && !currentDiff?.loading && !currentDiff?.error,
  );

  if (shouldLoadWorkingTreeDiff) {
    loadWorkingTreeDiff(item);
  }

  return {
    currentDiff,
    hasWorkingDiff,
    needsChange,
    shouldLoadWorkingTreeDiff,
  };
}

function getRecommendationLabel(item) {
  const labels = {
    change: "Suggested action: Update the source.",
    reply: "Suggested action: Send a reply. Do not change the source.",
    "no-action": "Suggested action: Do not change the source.",
    discussion: "Suggested action: Discuss this before you change the source.",
  };

  return labels[item.recommendation] || "Codex completed the review.";
}

function hasGraphChangeRecommendation(item) {
  return item?.recommendation === "change" &&
    Boolean(String(item?.assessment || "").trim()) &&
    Boolean(String(item?.changeSummary || "").trim());
}

function getChangeSummary(item) {
  if (item.changesAmended) {
    return "The source update was amended into the current patch.";
  }
  if (item.changeApplied) {
    return "Codex changed the source. Review the working-tree diff, then amend or revert it.";
  }


  if (item.changeReverted) {
    return "Codex reverted this source update.";
  }

  if (item.state === "applying") {
    return "Codex is preparing the source update.";
  }

  return item.changeSummary || "No source update is suggested for this comment.";
}

function createInlineAction(action, text) {
  const button = document.createElement("button");

  button.dataset.updateInlineAction = action;
  button.type = "button";
  button.textContent = text;
  return button;
}

function getInlineFinding(item) {
  return Array.from(patchDiffContent?.querySelectorAll(".patch-update-inline-finding") || [])
    .find((finding) => finding.dataset.itemId === item?.id) || null;
}

function setInlineFindingButton(finding, action, options) {
  setButton(
    finding?.querySelector(`[data-update-inline-action="${action}"]`),
    options,
  );
}

function updateInlineFindingActions(item) {
  const finding = getInlineFinding(item);

  if (!finding || !item) {
    return;
  }

  // Assessments can arrive after the diff. Refresh the text with the actions.
  const textFields = {
    ".patch-update-comment-author": session?.mode === "freeform" ? "Your update" : session?.mode === "verify" ? "Verify finding" : `Comment from ${item.author || "Unknown reviewer"}`,
    ".patch-update-inline-assessment": item.assessment || "Codex has not completed an assessment for this comment yet.",
    ".patch-update-inline-rationale": item.rationale ? `Reason: ${item.rationale}` : "",
    ".patch-update-inline-validation": item.validation ? `Checks: ${item.validation}` : "",
    ".patch-update-inline-change-summary": getChangeSummary(item),
    ".patch-update-inline-recommendation": getRecommendationLabel(item),
  };
  for (const [selector, text] of Object.entries(textFields)) {
    const element = finding.querySelector(selector);
    if (element) {
      element.textContent = text;
      element.hidden = !text;
    }
  }

  const replyInput = finding.querySelector(".patch-update-inline-reply");
  const canUseAi = session?.aiEnabled && !isBusy() && session.status !== "error";
  const actionPending = Boolean(pendingAction);
  const hasPreparedChange = Boolean(item.changeApplied && !item.changeReverted && !item.changesAmended);
  const replyValue = replyInput?.value || "";
  const canSaveInlineReply = session?.mode !== "verify" && item.type === "inline" && Boolean(item.parentCommentPHID);
  for (const element of finding.querySelectorAll(".patch-update-inline-reply-label, .patch-update-unanchored-reply-note")) {
    if (session?.mode === "verify") element.hidden = true;
  }
  const complete = item.state === "handled" || item.state === "skipped";
  const canMakeChange = hasGraphChangeRecommendation(item) &&
    !item.changeApplied && !item.changesAmended;

  if (replyInput) {
    replyInput.readOnly = complete;
  }

  setInlineFindingButton(finding, "apply", {
    disabled: actionPending,
    hidden: complete || !canMakeChange || !canUseAi,
    text: pendingAction === "apply" ? "Preparing..." : "Make Change",
  });
  setInlineFindingButton(finding, "keep", {
    disabled: actionPending,
    hidden: complete || !hasPreparedChange || !canUseAi,
    text: pendingAction === "keep" ? "Amending..." : "Amend Change",
  });
  setInlineFindingButton(finding, "revert", {
    disabled: actionPending,
    hidden: complete || !hasPreparedChange || !canUseAi,
    text: pendingAction === "revert" ? "Reverting..." : "Revert Change",
  });
  setInlineFindingButton(finding, "comment", {
    disabled: actionPending || hasPreparedChange ||
      !replyValue.trim() || (item.draftReply === replyValue && item.draftSaved),
    hidden: complete || !item.assessment || !canUseAi || !canSaveInlineReply,
    text: pendingAction === "comment"
      ? "Posting..."
      : item.draftReply === replyValue && item.draftSaved
        ? "Comment Posted"
        : "Comment",
  });
  setInlineFindingButton(finding, "handled", {
    disabled: actionPending || hasPreparedChange,
    hidden: complete || !canUseAi || isBusy(),
    text: pendingAction === "handled" ? "Marking..." : "Mark Done",
  });
  setInlineFindingButton(finding, "skip", {
    disabled: actionPending || hasPreparedChange,
    hidden: complete || !canUseAi || isBusy(),
    text: pendingAction === "skip" ? "Skipping..." : "Skip",
  });
}

function createCommentAuthor(item) {
  const author = document.createElement("p");
  author.className = "patch-update-comment-author";
  author.textContent = session?.mode === "freeform" ? "Your update" : session?.mode === "verify" ? "Verify finding" : `Comment from ${item.author || "Unknown reviewer"}`;
  return author;
}

function appendUpdateFinding(row, item) {
  const reviewerComment = appendInlineReviewComment(row, {
    action: "comment",
    author: item.author,
    codeSuggestion: item.codeSuggestion || item.isDeletion ? {
      content: item.codeSuggestion,
      isDeletion: item.isDeletion === true,
      url: item.url,
    } : null,
    content: item.content,
    dateCreated: item.dateCreated,
  });
  const finding = document.createElement("article");
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  const recommendation = document.createElement("p");
  const assessment = document.createElement("p");
  const rationale = document.createElement("p");
  const validation = document.createElement("p");
  const changeSummary = document.createElement("p");
  const replyLabel = document.createElement("label");
  const replyInput = document.createElement("textarea");
  const actions = document.createElement("div");

  reviewerComment.classList.add("patch-update-reviewer-comment");
  finding.className = "patch-update-inline-finding";
  finding.dataset.itemId = item.id;
  heading.textContent = "Codex analysis";
  recommendation.className = "patch-update-inline-recommendation";
  recommendation.textContent = getRecommendationLabel(item);
  header.append(createCommentAuthor(item), heading, recommendation);
  assessment.className = "patch-update-inline-assessment";
  assessment.textContent = item.assessment || "Codex has not completed an assessment for this comment yet.";
  rationale.className = "patch-update-inline-rationale";
  rationale.textContent = item.rationale ? `Reason: ${item.rationale}` : "";
  validation.className = "patch-update-inline-validation";
  validation.textContent = item.validation ? `Checks: ${item.validation}` : "";
  changeSummary.className = "patch-update-inline-change-summary";
  changeSummary.textContent = getChangeSummary(item);
  replyLabel.className = "patch-update-inline-reply-label";
  replyLabel.append(item.type === "inline" ? "Suggested inline reply" : "Suggested overall reply");
  replyInput.className = "patch-update-inline-reply";
  replyInput.rows = 4;
  replyInput.value = item.suggestedReply || "";
  replyLabel.append(replyInput);
  actions.className = "patch-update-inline-actions";
  actions.append(
    createInlineAction("apply", "Make Change"),
    createInlineAction("keep", "Amend Change"),
    createInlineAction("revert", "Revert Change"),
    ...(session?.mode === "verify" ? [] : [createInlineAction("comment", "Comment")]),
    createInlineAction("handled", "Mark Done"),
    createInlineAction("skip", "Skip"),
  );
  finding.append(header, assessment);
  finding.append(rationale, validation);
  finding.append(changeSummary);
  if (session?.mode !== "verify") finding.append(replyLabel);
  finding.append(actions);
  reviewerComment.parentElement?.append(finding);
  updateInlineFindingActions(item);
  return finding;
}

function appendUnanchoredFinding(item) {
  const finding = document.createElement("article");
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  const location = document.createElement("p");
  const reviewerFeedback = document.createElement("p");
  const assessment = document.createElement("p");
  const rationale = document.createElement("p");
  const validation = document.createElement("p");
  const changeSummary = document.createElement("p");
  const replyLabel = document.createElement("label");
  const replyInput = document.createElement("textarea");
  const replyNote = document.createElement("p");
  const actions = document.createElement("div");

  finding.className = "patch-update-unanchored-finding patch-update-inline-finding";
  finding.dataset.itemId = item.id;
  heading.textContent = session?.mode === "freeform" ? "Your update" : session?.mode === "verify" ? "Verify finding" : item.type === "inline"
    ? "Inline comment location was not found"
    : "Reviewer feedback";
  location.textContent = item.filePath
    ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    : "This comment is not attached to a source line.";
  reviewerFeedback.className = "patch-update-unanchored-feedback";
  reviewerFeedback.textContent = item.content || "No prose feedback was supplied.";
  assessment.className = "patch-update-inline-assessment";
  assessment.textContent = item.assessment || "Codex has not completed an assessment for this comment yet.";
  rationale.className = "patch-update-inline-rationale";
  rationale.textContent = item.rationale ? `Reason: ${item.rationale}` : "";
  validation.className = "patch-update-inline-validation";
  validation.textContent = item.validation ? `Checks: ${item.validation}` : "";
  changeSummary.className = "patch-update-inline-change-summary";
  changeSummary.textContent = getChangeSummary(item);
  replyLabel.className = "patch-update-inline-reply-label";
  replyLabel.append(item.type === "inline" ? "Suggested inline reply" : "Suggested update reply");
  replyInput.className = "patch-update-inline-reply";
  replyInput.rows = 4;
  replyInput.value = item.suggestedReply || "";
  replyLabel.append(replyInput);
  replyNote.className = "patch-update-unanchored-reply-note";
  replyNote.hidden = item.type === "inline" && Boolean(item.parentCommentPHID);
  replyNote.textContent = "This revision-level feedback has no inline thread. Include this response in the patch update summary, then mark the feedback handled.";
  actions.className = "patch-update-inline-actions";
  actions.append(
    createInlineAction("apply", "Make Change"),
    createInlineAction("keep", "Amend Change"),
    createInlineAction("revert", "Revert Change"),
    ...(session?.mode === "verify" ? [] : [createInlineAction("comment", "Comment")]),
    createInlineAction("handled", "Mark Done"),
    createInlineAction("skip", "Skip"),
  );
  header.append(createCommentAuthor(item), heading, location);
  finding.append(header, reviewerFeedback, assessment);
  finding.append(rationale, validation);
  finding.append(changeSummary);
  if (session?.mode !== "verify") finding.append(replyLabel, replyNote);
  finding.append(actions);
  patchDiffContent.prepend(finding);
  updateInlineFindingActions(item);
  return finding;
}

function appendWorkingTreeCandidate(item) {
  const finding = document.createElement("article");
  const heading = document.createElement("h3");
  const assessment = document.createElement("p");
  const summary = document.createElement("p");
  const actions = document.createElement("div");

  finding.className = "patch-update-inline-finding patch-update-working-tree-candidate";
  finding.dataset.itemId = item.id;
  heading.textContent = "Codex source update";
  assessment.className = "patch-update-inline-assessment";
  assessment.textContent = item.assessment || "Codex prepared this source update for the reviewer comment.";
  summary.className = "patch-update-inline-change-summary";
  summary.textContent = getChangeSummary(item);
  actions.className = "patch-update-inline-actions";
  actions.append(
    createInlineAction("keep", "Amend Change"),
    createInlineAction("revert", "Revert Change"),
  );
  finding.append(createCommentAuthor(item), heading, assessment, summary, actions);
  patchDiffContent.append(finding);
  updateInlineFindingActions(item);
  return finding;
}

function appendWorkingTreeDiff(item) {
  const { currentDiff, hasWorkingDiff, shouldLoadWorkingTreeDiff } = getWorkingTreeDiffState(item);
  const section = document.createElement("section");
  const header = document.createElement("header");
  const heading = document.createElement("h3");
  const content = document.createElement("div");

  section.className = "patch-update-working-diff";
  heading.textContent = "Working tree changes";
  content.className = "patch-update-working-diff-content";
  header.append(heading);
  if (hasWorkingDiff && currentDiff?.html) {
    content.innerHTML = currentDiff.html;
  } else if (hasWorkingDiff) {
    const rawDiff = document.createElement("pre");

    rawDiff.className = "patch-update-proposed-diff-raw";
    rawDiff.textContent = currentDiff.text;
    content.append(rawDiff);
  } else {
    const notice = document.createElement("p");

    notice.className = currentDiff?.error
      ? "patch-update-diff-notice error"
      : "patch-update-diff-notice";
    notice.textContent = currentDiff?.error
      ? `Could not load the actual uncommitted diff: ${currentDiff.error}`
      : currentDiff?.loading || shouldLoadWorkingTreeDiff
        ? "Loading the actual uncommitted diff from the current checkout..."
        : item?.changeReverted
          ? "The candidate was reverted, so no working-tree diff remains for this comment."
          : "There are no uncommitted changes in the current checkout.";
    content.append(notice);
  }
  section.append(header, content);
  patchDiffContent.append(section);
}

function setPatchDiff(item) {
  if (!patchDiff || !patchDiffContent) {
    return;
  }

  const key = getPatchDiffKey();
  const currentDiff = patchDiffState.key === key ? patchDiffState : null;
  const hasPatchDiff = Boolean(currentDiff?.html || currentDiff?.text);
  const renderKey = [key, item?.id || "no-comment", currentDiff?.loading || false,
    currentDiff?.error || "", getWorkingTreeDiffKey(item), item?.changeApplied || false,
    item?.changesAmended || false, item?.changeReverted || false, item?.state || ""].join(":");

  if (renderedPatchDiffKey === renderKey) {
    updateInlineFindingActions(item);
    return;
  }

  renderedPatchDiffKey = renderKey;
  patchDiffContent.replaceChildren();
  const showWorkingTreeCandidate = Boolean(
    item && !item.changesAmended && (item.changeApplied || item.state === "applying") && !item.changeReverted,
  );
  patchDiffContent.classList.toggle("showing-working-tree", showWorkingTreeCandidate);

  if (showWorkingTreeCandidate) {
    appendWorkingTreeCandidate(item);
    appendWorkingTreeDiff(item);
    return;
  }

  if (hasPatchDiff && currentDiff?.html) {
    patchDiffContent.innerHTML = currentDiff.html;
  } else if (hasPatchDiff) {
    const raw = document.createElement("pre");

    raw.className = "patch-update-proposed-diff-raw";
    raw.textContent = currentDiff.text;
    patchDiffContent.append(raw);
  } else if (item?.contextDiffHtml) {
    patchDiffContent.innerHTML = item.contextDiffHtml;
  } else {
    const notice = document.createElement("p");

    notice.className = currentDiff?.error
      ? "patch-update-diff-notice error"
      : "patch-update-diff-notice";
    notice.textContent = currentDiff?.error
      ? `Could not load the patch diff: ${currentDiff.error}`
      : "Loading the current patch diff...";
    patchDiffContent.append(notice);
  }

  if (item) {
    const anchor = ["inline", "finding"].includes(item.type) ? findReviewLine(patchDiffContent, item) : null;

    if (anchor) {
      anchor.classList.add("patch-update-context-line");
      appendUpdateFinding(anchor, item);
    } else {
      appendUnanchoredFinding(item);
    }
  }

  if (!hasPatchDiff && !currentDiff?.loading && !currentDiff?.error) {
    loadPatchDiff();
  }
}

function resetPatchUpdateDialog(patch) {
  submitError = "";
  viewGeneration++;
  session = undefined;
  renderedChat = "";
  chat?.replaceChildren();
  setButton(rollback, { hidden: true });
  pendingAction = "";
  outputVisible = false;
  activityFilter = "notes";
  activityFollowsLatest = true;
  appliedSnapshotKey = "";
  patchContextExpanded = false;
  patchContextKey = "";
  cancelWorkingTreeDiffRequest();
  workingTreeDiff = {
    error: "",
    html: "",
    key: "",
    loading: false,
    text: "",
  };
  workingTreeDiffRequest = "";
  activeWorkingTreeDiffItemKey = "";
  patchDiffState = {
    error: "",
    html: "",
    key: "",
    loading: false,
    text: "",
  };
  patchDiffRequest = "";
  renderedPatchDiffKey = "";
  scrollToAttention("", null);
  expandedActivityCommandIds.clear();
  window.clearTimeout(pollTimer);
  title.textContent = `${patch.id} Review Update`;
  setPatchLinks(patch.id, patch.bugId || patch.title?.match(/\bBug\s+(\d+)/i)?.[1] || "");
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
  patchDiffContent?.replaceChildren();
  setButton(amend, { hidden: true, text: "Amend Patch" });
  setButton(submit, { hidden: true, text: "Submit Patch" });
}

function renderSession(currentSession) {
  session = currentSession;
  taskView.update(session, isBusy(session) || Boolean(pendingAction));
  dialog.classList.toggle("patch-verify", session.mode === "verify");
  const freeform = session.mode === "freeform";
  dialog.classList.toggle("patch-freeform", freeform);
  chat.hidden = !freeform;
  if (freeform) {
    const key = JSON.stringify(session.chat || []);
    if (key !== renderedChat) {
      const follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
      renderedChat = key;
      replaceChangedChildren(chat, ...(session.chat || []).map(message => {
        const entry = document.createElement("section");
        const heading = document.createElement("strong");
        const text = document.createElement("p");
        heading.textContent = message.role === "user" ? "You" : "Codex";
        text.textContent = message.text;
        entry.append(heading, text);
        return entry;
      }));
      if (follow) window.requestAnimationFrame(() => {
        if (!hasSelectedText(chat)) chat.scrollTop = chat.scrollHeight;
      });
    }
  }
  runStatus.update(session, isBusy() || Boolean(pendingAction));
  const busy = isBusy();
  const actionPending = Boolean(pendingAction);
  const item = getCurrentItem();
  const visibleOutput = getPatchUpdateOutput(session);
  const hasOutput = Boolean(visibleOutput);
  const allHandled = session.items?.length && !item;
  const needsAmend = session.items?.some((candidate) => (
    candidate.changeApplied && candidate.changeAccepted && !candidate.changesAmended
  ));

  if (session.rebaseConflict && session.rebaseConflict.id !== uiState.lastUpdateRebaseId) {
    uiState.lastUpdateRebaseId = session.rebaseConflict.id;
    openRebaseFailureDialog(session.rebaseConflict, { fallbackMessage: session.error });
  }
  if (session.snapshot) {
    const snapshotKey = `${session.id}:${session.currentHash}`;

    if (snapshotKey !== appliedSnapshotKey) {
      appliedSnapshotKey = snapshotKey;
      applyGraphSnapshot(session.graphIndex, session.snapshot, { force: true });
    }
  }

  title.textContent = `${session.revision} ${session.mode === "verify" ? "Verify" : session.mode === "freeform" ? "Update" : "Review Update"}`;
  setPatchLinks(session.revision, session.bugId || undefined);
  setLiveText(status, submitError || session.message || session.error || "");
  status.classList.toggle("error", Boolean(submitError) || session.status === "error" || Boolean(item?.error));
  setLiveText(output, visibleOutput);
  output.hidden = !outputVisible || !hasOutput;
  outputToggle.hidden = freeform || !hasOutput;
  outputToggle.textContent = outputVisible ? "Back to Review" : "Output";
  dialog.classList.toggle("output-expanded", outputVisible && hasOutput);
  renderActivity(session.activity);
  setPatchContext(session.patchContext);
  setPatchDiff(freeform && !item?.changeApplied ? null : item);
  const canGuideCurrentComment = session.aiEnabled && !busy &&
    session.status !== "error" && Boolean(item);
  const canAskAboutUpdate = session.aiEnabled && !busy && ["review", "complete"].includes(session.status);
  if (results) {
    results.hidden = freeform || Boolean(item) || !session.aiEnabled;
    replaceChangedChildren(resultItems, ...(session.items || []).map((entry) => {
      const detail = document.createElement("details");
      detail.open = true;
      const heading = document.createElement("summary");
      heading.textContent = `${entry.filePath || entry.id}: ${entry.state}`;
      const evidence = document.createElement("p");
      evidence.style.whiteSpace = "pre-wrap";
      evidence.textContent = [
        `Change: ${entry.appliedSummary || "No source change recorded."}`,
        `Validation: ${entry.validation || "No validation recorded."}`,
      ].join("\n\n");
      detail.append(heading, evidence);
      return detail;
    }));
    setLiveText(followUpAnswer, session.followUpAnswer || "Ask Codex below to verify the final patch or explain a result.");
  }
  setButton(retry, { hidden: !session.canRetryAssessment, disabled: actionPending || busy });
  const canSteer = session.aiEnabled && (
    session.canRetryAssessment ||
    (session.status === "reviewing" && Boolean(session.codexTurnId)) ||
    canAskAboutUpdate
  );

  if (steer) {
    steer.hidden = freeform ? false : !canSteer;
  }
  if (steerLabel) {
    steerLabel.textContent = session.canRetryAssessment ? "Guide Codex and retry the assessment" : freeform ? "Ask Codex for an update" : canGuideCurrentComment
      ? item.changeApplied && !item.changesAmended
        ? "Guide Codex on this change"
        : session.mode === "verify" ? "Guide Codex on this finding" : "Guide Codex on this comment"
      : canAskAboutUpdate ? `Ask Codex about ${session.mode === "verify" ? "Verify" : session.mode === "freeform" ? "Update" : "Review Update"}` : "Guide Codex";
  }
  if (steerInput && document.activeElement !== steerInput) {
    steerInput.placeholder = freeform ? "Ask a question or describe the changes you want." : canGuideCurrentComment
      ? item.changeApplied && !item.changesAmended
        ? "Ask Codex to revise the working-tree change."
        : "Ask Codex to reconsider, explain, or revise this assessment."
      : canAskAboutUpdate ? "Ask a question, request checks, or tell Codex what to change." : "Add context, question an assumption, or change direction.";
  }
  if (steerSubmit) {
    steerSubmit.disabled = actionPending || (freeform && busy) || !steerInput?.value.trim();
    steerSubmit.textContent = pendingAction === "steer" || pendingAction === "feedback" || pendingAction === "revise"
      ? "Sending..."
      : "Send";
  }
  updateInlineFindingActions(item);
  setButton(amend, {
    hidden: true,
    disabled: actionPending || busy || !allHandled,
    text: pendingAction === "amend" || session.status === "amending"
      ? "Amending..."
      : "Amend Patch",
  });
  setButton(submit, {
    hidden: !freeform && (!session.aiEnabled || busy || session.status === "error" || (!allHandled && session.items?.length)),
    disabled: actionPending || busy || !session.currentHash || (!freeform && needsAmend),
    text: !freeform && needsAmend ? "Amend changes before submitting" : "Submit Patch",
  });
  setButton(rollback, { hidden: !freeform, disabled: busy || actionPending || !session.canRollback,
    text: pendingAction === "rollback" ? "Rolling Back..." : "Roll Back" });
  const finding = getInlineFinding(item);
  const attention = item ? finding?.querySelector(".patch-update-inline-actions") : submit;
  scrollToAttention(
    `${session.id}:${item?.id || "submit"}:${item?.state}:${item?.changeApplied}:${item?.changesAmended}:${item?.assessment}:${item?.error || session.error || ""}`,
    attention,
    !busy && !actionPending && !outputVisible && dialog.open,
  );
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  if (dialog.open) pollTimer = window.setTimeout(loadSession, 500);
}

async function loadSession() {
  if (!session?.id) {
    return;
  }

  const requestedId = session.id;
  try {
    const response = await fetch(
      `/api/patch-update/${encodeURIComponent(session.id)}?token=${encodeURIComponent(INTERACTIVE.token)}`,
      { cache: "no-store" },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load patch update status.");
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
  if (!session?.id || pendingAction) {
    return null;
  }

  const requestedId = session.id;
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

    if (session?.id !== requestedId) { taskView.background(result); return null; }
    pendingAction = "";
    renderSession(result);

    if (isBusy(result)) {
      schedulePoll();
    }
    return result;
  } catch (error) {
    if (session?.id !== requestedId) return null;
    pendingAction = "";
    renderSession(session);
    status.classList.add("error");
    status.textContent = error?.message || String(error);
    return null;
  }
}


function restorePatchUpdateTask(value) {
  if (session?.id !== value.id) resetPatchUpdateDialog({ id: value.revision });
  renderSession(value);
  title.textContent = `${value.revision} ${value.mode === "verify" ? "Verify" : value.mode === "freeform" ? "Update" : "Review Update"}`;
  setPageScrollLocked(true);
  if (!dialog.open) dialog.showModal();
  schedulePoll();
}
export async function openPatchUpdateDialog({ patch, graphIndex, mode = "update" }) {
  if (!dialog || !patch?.id) {
    return;
  }

  void enableTaskNotifications();
  if (dialog.open || session) taskView.minimize();
  resetPatchUpdateDialog(patch);
  const generation = viewGeneration;
  setPageScrollLocked(true);
  dialog.showModal();
  title.textContent = `${patch.id} ${mode === "verify" ? "Verify" : mode === "freeform" ? "Update" : "Review Update"}`;
  status.textContent = mode === "verify" ? "Preparing verification..." : "Preparing review update...";

  try {
    const result = await startOrResumePatchSession("/api/patch-update", {
        token: INTERACTIVE.token,
        graphIndex,
        revision: patch.id,
        mode,
        snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
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

export function initializePatchUpdateDialog() {
  if (!dialog) {
    return;
  }

  dialog.querySelector(".patch-update-close").addEventListener("click", () => {
    window.clearTimeout(pollTimer);
    taskView.minimize();
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) setPageScrollLocked(false);
  });
  retry?.addEventListener("click", () => {
    void runAction("steer", { instruction: "Return the complete assessment for every supplied Comment ID. Reuse the saved research." });
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
  bindAiFeedbackForm(steer, {
    onInput: () => { if (session) renderSession(session); },
    onSend: async value => {
      const item = getCurrentItem();
      const isCommentFeedback = session?.mode !== "freeform" && session?.aiEnabled && !isBusy() &&
        session.status !== "error" && Boolean(item);
      const action = isCommentFeedback && item.changeApplied && !item.changesAmended
        ? "revise"
        : isCommentFeedback
          ? "feedback"
          : "steer";
      const result = await runAction(
        action,
        isCommentFeedback
          ? { itemId: item.id, instruction: value }
          : { instruction: value },
      );

      return Boolean(result);
    },
  });
  patchDiffContent?.addEventListener("input", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains("patch-update-inline-reply")) {
      return;
    }

    const item = getCurrentItem();

    if (!item || target.closest(".patch-update-inline-finding")?.dataset.itemId !== item.id) {
      return;
    }

    item.suggestedReply = target.value;
    updateInlineFindingActions(item);
  });
  patchDiffContent?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-update-inline-action]");
    const item = getCurrentItem();

    if (!button || !item || button.closest(".patch-update-inline-finding")?.dataset.itemId !== item.id) {
      return;
    }

    const action = button.dataset.updateInlineAction;
    const replyInput = button.closest(".patch-update-inline-finding")
      ?.querySelector(".patch-update-inline-reply");

    if (action === "comment") {
      void runAction(action, { itemId: item.id, message: replyInput?.value || "" });
    } else {
      void runAction(action, { itemId: item.id });
    }
  });
  amend?.addEventListener("click", () => {
    runAction("amend", {
      snapshotLimit: getLoadedGitCommitLimit(graphStates[session.graphIndex]),
    });
  });
  rollback?.addEventListener("click", async () => {
    if (await showSystemConfirmation({ title: "Roll back this Update?",
      message: "Restore the patch contents from when this Update session started, including amended changes. This changes only the local patch.",
      confirmLabel: "Roll Back", danger: true })) {
      await runAction("rollback");
    }
  });
  submit?.addEventListener("click", async () => {
    if (!session?.currentHash) {
      return;
    }

    if (session.mode === "freeform") {
      const candidate = session.items.find(item => item.changeApplied && !item.changesAmended);
      if (candidate) {
        if (!await showSystemConfirmation({ title: "Amend before submitting?",
          message: "Amend the displayed working-tree changes into this patch, then open Submit.",
          confirmLabel: "Amend and Continue" })) return;
        if (!await runAction("keep", { itemId: candidate.id })) return;
      }
    }
    const button = document.createElement("button");

    button.dataset.graphIndex = String(session.graphIndex);
    button.dataset.hash = session.currentHash;
    button.dataset.label = GRAPHS[session.graphIndex]?.label || "comm";
    const id = session.id;
    submitError = "";
    openSubmitDialog(button, { patchUpdateSessionId: id,
      onStarted: () => { if (session?.id === id) taskView.minimize(); },
      onError: message => {
        if (session?.id !== id) return;
        submitError = message;
        status.classList.add("error");
        status.textContent = message;
      },
    });
  });
}
