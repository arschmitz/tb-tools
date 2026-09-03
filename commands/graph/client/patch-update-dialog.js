import { GRAPHS, INTERACTIVE, graphStates } from "./config.js";
import {
  applyGraphSnapshot,
  getLoadedGitCommitLimit,
} from "./command-sessions.js";
import { openSubmitDialog } from "./commit-actions.js";

const dialog = document.getElementById("patch-update-dialog");
const title = dialog?.querySelector(".patch-update-title");
const status = dialog?.querySelector(".patch-update-status");
const output = dialog?.querySelector(".patch-update-output");
const outputToggle = dialog?.querySelector(".patch-update-output-toggle");
const activity = dialog?.querySelector(".patch-update-activity");
const activityCount = dialog?.querySelector(".patch-update-activity-count");
const activityList = dialog?.querySelector(".patch-update-activity-list");
const comment = dialog?.querySelector(".patch-update-comment");
const commentAuthor = dialog?.querySelector(".patch-update-comment-author");
const commentKind = dialog?.querySelector(".patch-update-comment-kind");
const commentLink = dialog?.querySelector(".patch-update-comment-link");
const commentLocation = dialog?.querySelector(".patch-update-comment-location");
const feedbackHeading = dialog?.querySelector(".patch-update-feedback-heading");
const commentContent = dialog?.querySelector(".patch-update-comment-content");
const suggestion = dialog?.querySelector(".patch-update-suggestion");
const codeSuggestion = dialog?.querySelector(".patch-update-code-suggestion");
const analysis = dialog?.querySelector(".patch-update-analysis");
const recommendation = dialog?.querySelector(".patch-update-recommendation");
const assessment = dialog?.querySelector(".patch-update-assessment");
const rationale = dialog?.querySelector(".patch-update-rationale");
const rationaleText = dialog?.querySelector(".patch-update-rationale-text");
const changePlan = dialog?.querySelector(".patch-update-change-plan");
const changeSummary = dialog?.querySelector(".patch-update-change-summary");
const proposedDiff = dialog?.querySelector(".patch-update-proposed-diff");
const proposedDiffContent = dialog?.querySelector(".patch-update-proposed-diff-content");
const instruction = dialog?.querySelector(".patch-update-instruction");
const reply = dialog?.querySelector(".patch-update-reply");
const feedback = dialog?.querySelector(".patch-update-feedback");
const apply = dialog?.querySelector(".patch-update-apply");
const post = dialog?.querySelector(".patch-update-post");
const handled = dialog?.querySelector(".patch-update-handled");
const submit = dialog?.querySelector(".patch-update-submit");

let session;
let pollTimer;
let outputVisible = false;
let activityFollowsLatest = true;
let appliedSnapshotKey = "";

function isBusy(currentSession = session) {
  return ["preparing", "reviewing", "applying"].includes(currentSession?.status);
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

function renderActivity(entries = []) {
  if (!activity || !activityList) {
    return;
  }

  const items = Array.isArray(entries) ? entries : [];
  const hadEntries = activityList.childElementCount > 0;
  const followOutput = activityFollowsLatest || !hadEntries;

  activity.hidden = !items.length;
  activityCount.textContent = items.length ? `${items.length} step${items.length === 1 ? "" : "s"}` : "";
  activityList.replaceChildren(...items.map((entry) => {
    const row = document.createElement("li");
    const title = document.createElement("strong");

    row.className = `patch-update-activity-entry patch-update-activity-${entry.kind || "status"}`;
    title.textContent = entry.title || "Codex activity";
    row.append(title);

    if (entry.detail) {
      const detail = document.createElement("code");

      detail.textContent = entry.detail;
      row.append(detail);
    }

    return row;
  }));

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

function setComment(item) {
  if (!comment) {
    return;
  }

  comment.hidden = !item;

  if (!item) {
    return;
  }

  commentAuthor.textContent = item.author;
  commentKind.textContent = item.feedbackType;
  feedbackHeading.hidden = !item.content;
  commentContent.hidden = !item.content;
  commentContent.textContent = item.content;
  commentLocation.hidden = !item.filePath;
  commentLocation.textContent = item.filePath
    ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    : "";
  suggestion.hidden = !item.codeSuggestion;
  codeSuggestion.textContent = item.codeSuggestion || "";
  commentLink.hidden = !item.url;
  commentLink.href = item.url || "";
  analysis.hidden = !item.assessment;
  recommendation.textContent = getRecommendationLabel(item);
  assessment.textContent = item.assessment || "";
  rationale.hidden = !item.rationale;
  rationaleText.textContent = item.rationale || "";
  changePlan.hidden = !item.changeSummary;
  changeSummary.textContent = item.changeSummary || "";
  proposedDiff.hidden = !item.proposedDiffHtml;
  proposedDiffContent.innerHTML = item.proposedDiffHtml || "";
  if (instruction && document.activeElement !== instruction) {
    instruction.value = item.instruction || "";
  }
  if (reply && document.activeElement !== reply) {
    reply.value = item.suggestedReply || "";
  }
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
  outputVisible = false;
  activityFollowsLatest = true;
  appliedSnapshotKey = "";
  window.clearTimeout(pollTimer);
  title.textContent = `${patch.id} update`;
  status.classList.remove("error");
  status.textContent = "Preparing update...";
  output.textContent = "";
  output.hidden = true;
  outputToggle.hidden = true;
  outputToggle.textContent = "Output";
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
  if (instruction) {
    instruction.value = "";
  }

  setButton(feedback, { hidden: true, text: "Send to Codex" });
  setButton(apply, { hidden: true, text: "Apply Change" });
  setButton(post, { hidden: true, text: "Save Reply Draft" });
  setButton(handled, { hidden: true, text: "Mark Handled" });
  setButton(submit, { hidden: true, text: "Submit Patch" });
}

function renderSession(currentSession) {
  session = currentSession;
  const busy = isBusy();
  const item = getCurrentItem();
  const hasOutput = Boolean(session.output);
  const allHandled = session.items?.length && !item;

  if (session.snapshot) {
    const snapshotKey = `${session.id}:${session.currentHash}`;

    if (snapshotKey !== appliedSnapshotKey) {
      appliedSnapshotKey = snapshotKey;
      applyGraphSnapshot(session.graphIndex, session.snapshot, { force: true });
    }
  }

  title.textContent = `${session.revision} update`;
  status.textContent = session.message || session.error || "";
  status.classList.toggle("error", session.status === "error");
  output.textContent = session.output || "";
  output.hidden = !outputVisible || !hasOutput;
  outputToggle.hidden = !hasOutput;
  outputToggle.textContent = outputVisible ? "Hide Output" : "Output";
  renderActivity(session.activity);
  setComment(busy ? null : item);
  const instructionValue = instruction?.value || "";
  const replyValue = reply?.value || "";

  const canUseAi = session.aiEnabled && !busy && session.status !== "error";
  setButton(feedback, {
    hidden: !item || !canUseAi || item.state === "handled",
    disabled: !instructionValue.trim(),
    text: "Send to Codex",
  });
  setButton(apply, {
    hidden: !item?.requiresChanges || !item?.proposedDiffHtml || !canUseAi || item.state === "handled",
    disabled: item?.state === "applying",
    text: item?.state === "applying" ? "Applying..." : "Apply Change",
  });
  setButton(post, {
    hidden: !item?.assessment || !canUseAi || item.state === "handled",
    disabled: !replyValue.trim() || (
      item?.draftReply === replyValue && item?.draftSaved
    ),
    text: item?.draftReply === replyValue && item?.draftSaved
      ? "Reply Draft Saved"
      : "Save Reply Draft",
  });
  setButton(handled, {
    hidden: !item || !canUseAi || busy,
    disabled: false,
    text: "Mark Handled",
  });
  setButton(submit, {
    hidden: !session.aiEnabled || busy || session.status === "error" || (!allHandled && session.items?.length),
    disabled: !session.currentHash,
    text: "Submit Patch",
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
  if (!session?.id) {
    return;
  }

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

    renderSession(result);

    if (isBusy(result)) {
      schedulePoll();
    }
  } catch (error) {
    status.classList.add("error");
    status.textContent = error?.message || String(error);
  }
}

export async function openPatchUpdateDialog({ patch, graphIndex }) {
  if (!dialog || !patch?.id) {
    return;
  }

  resetPatchUpdateDialog(patch);
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
  outputToggle?.addEventListener("click", () => {
    outputVisible = !outputVisible;
    renderSession(session);
  });
  activityList?.addEventListener("scroll", updateActivityFollowState, { passive: true });
  feedback?.addEventListener("click", () => {
    const item = getCurrentItem();

    if (item && instruction?.value.trim()) {
      runAction("feedback", { itemId: item.id, instruction: instruction.value });
    }
  });
  apply?.addEventListener("click", () => {
    const item = getCurrentItem();

    if (item) {
      runAction("apply", { itemId: item.id });
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
  reply?.addEventListener("input", () => {
    const item = getCurrentItem();

    if (item) {
      item.suggestedReply = reply.value;
    }

    renderSession(session);
  });
  instruction?.addEventListener("input", () => {
    const item = getCurrentItem();

    if (item) {
      item.instruction = instruction.value;
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
