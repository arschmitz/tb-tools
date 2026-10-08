import { setLiveText, hasSelectedText } from "./live-text.js";
import { registerAiTaskDialog } from "./ai-task-tray.js";
import {
  INTERACTIVE,
  PHABRICATOR_REVISION_URL,
  amendDialog,
  amendError,
  amendMessage,
  amendSubmit,
  graphStates,
  submitCancel,
  submitClose,
  submitDialog,
  submitLinks,
  submitOutput,
  submitPrompt,
  submitQuestion,
  submitStatus,
  submitTitle,
  uiState,
} from "./config.js";
import {
  formatCommitMeta,
  formatCommitTitle,
  isCurrentCommit,
  isWorkingTreeCommit,
} from "./commit-model.js";
import { updateCommitRowStates } from "./lane-renderer.js";
import {
  clearIntegrationStatus,
  loadSelectedCommitIntegrationStatus,
  loadSelectedCommitMessage,
  selectCommitActionResult,
  setCommitMessage,
  setDiffHtml,
  setDiffStats,
  setDiffText,
} from "./diff-viewer.js";
import {
  fetchSelectedCommitReview,
  renderSelectedCommitReview,
} from "./review-viewer.js";
import {
  applyGraphSnapshot,
  confirmRemoteBuildRustWarning,
  getLoadedGitCommitLimit,
  refreshGraphFromServer,
} from "./command-sessions.js";
import { showSystemConfirmation } from "./system-dialog.js";
import {
  finishRebaseDialog,
  openRebaseFailureDialog,
  setRebaseDialogBusy,
  setRebaseDialogError,
} from "./rebase-dialog.js";

function getCommitPhabricatorRevision(commit, message = "") {
  const haystack = [
    commit?.subject,
    ...(commit?.refs || []),
    message,
  ].filter(Boolean).join("\n");
  const match = haystack.match(/\b(?:phab-)?(D\d{4,})\b/i);

  return match ? match[1].toUpperCase() : "";
}

function configurePatchUpdateButton(button, { graph, index, commit, message = "" }) {
  if (!button) {
    return;
  }

  const revision = getCommitPhabricatorRevision(commit, message);
  const repository = String(graph.repository || graph.label || "").toLowerCase();
  const canUpdate = INTERACTIVE.aiEnabled && repository === "comm" &&
    graph.checkout !== "review" && !isWorkingTreeCommit(commit) &&
    Boolean(revision);

  button.hidden = !canUpdate;

  if (!canUpdate) {
    return;
  }

  button.dataset.graphIndex = String(index);
  button.dataset.revision = revision;
  button.dataset.title = commit.subject || revision;
  button.dataset.url = PHABRICATOR_REVISION_URL + revision.slice(1);
}

function isCommitReachableFromLoadedOriginMain(index, commit) {
  const commits = graphStates[index]?.commits || [];
  const commitsByHash = new Map(commits.map((candidate) => [candidate.hash, candidate]));
  const reachable = new Set();
  const pending = commits
    .filter((candidate) => Array.isArray(candidate.refs) && candidate.refs.includes("origin/main"))
    .map((candidate) => candidate.hash);

  while (pending.length) {
    const hash = pending.pop();

    if (!hash || reachable.has(hash)) {
      continue;
    }

    reachable.add(hash);
    const current = commitsByHash.get(hash);

    for (const parent of current?.parents || []) {
      if (commitsByHash.has(parent)) {
        pending.push(parent);
      }
    }
  }

  return reachable.has(commit.hash);
}

export async function showDiff(
  graph,
  index,
  commit,
  { loadCurrentIntegration = false, loadIntegration = false } = {},
) {
  const viewer = document.getElementById("diff-" + index);
  const title = viewer.querySelector(".diff-title");
  const meta = viewer.querySelector(".diff-meta");
  const commitMessage = viewer.querySelector(".diff-message");
  const integrationStatus = viewer.querySelector(".integration-status");
  const stats = viewer.querySelector(".diff-stats");
  const body = viewer.querySelector(".diff-body");
  const checkoutButton = viewer.querySelector(".checkout-commit");
  const amendButton = viewer.querySelector(".amend-commit");
  const submitButton = viewer.querySelector(".submit-commit");
  const patchUpdateButton = viewer.querySelector(".patch-update-commit");
  const patchVerifyButton = viewer.querySelector(".patch-verify-commit");
  const patchFreeformButton = viewer.querySelector(".patch-freeform-commit");
  const loadReviewButton = viewer.querySelector(".load-commit-review");
  const checkoutStatus = viewer.querySelector(".checkout-status");
  const diff = graph.diffs && graph.diffs[commit.hash];

  graphStates[index].selectedHash = commit.hash;
  updateCommitRowStates(index);

  title.textContent = formatCommitTitle(commit);
  meta.textContent = formatCommitMeta(commit);
  setCommitMessage(commitMessage, "");
  clearIntegrationStatus(integrationStatus);
  checkoutButton.hidden = !INTERACTIVE.enabled || isWorkingTreeCommit(commit);
  checkoutButton.disabled = false;
  checkoutButton.dataset.graphIndex = String(index);
  checkoutButton.dataset.hash = commit.hash;
  checkoutButton.dataset.label = graph.label;
  amendButton.hidden = !INTERACTIVE.enabled;
  amendButton.disabled = false;
  amendButton.textContent = isWorkingTreeCommit(commit) || commit.tryFixup ? "Amend" : "Amend Message";
  amendButton.dataset.tryFixup = String(Boolean(commit.tryFixup));
  amendButton.dataset.graphIndex = String(index);
  amendButton.dataset.hash = commit.hash;
  amendButton.dataset.label = graph.label;
  amendButton.dataset.changeId = commit.changeId || "";
  amendButton.dataset.includeChanges = String(isWorkingTreeCommit(commit));
  submitButton.hidden = !INTERACTIVE.enabled || isWorkingTreeCommit(commit) ||
    isCommitReachableFromLoadedOriginMain(index, commit);
  submitButton.disabled = false;
  submitButton.dataset.graphIndex = String(index);
  submitButton.dataset.hash = commit.hash;
  submitButton.dataset.label = graph.label;
  submitButton.dataset.isCurrent = String(isCurrentCommit(commit));
  for (const button of [patchUpdateButton, patchVerifyButton, patchFreeformButton]) {
    configurePatchUpdateButton(button, {
      graph,
      index,
      commit,
      message: commit.subject,
    });
  }
  if (loadReviewButton) {
    loadReviewButton.hidden = !INTERACTIVE.enabled || isWorkingTreeCommit(commit);
    loadReviewButton.disabled = true;
    loadReviewButton.textContent = "Load Review";
    loadReviewButton.dataset.graphIndex = String(index);
    loadReviewButton.dataset.hash = commit.hash;
  }
  checkoutStatus.classList.remove("error");
  checkoutStatus.textContent = "";
  setDiffStats(stats, null);

  if (INTERACTIVE.enabled) {
    setDiffText(body, "Loading diff...");
    void loadSelectedCommitMessage(index, commit, commitMessage).then((message) => {
      if (graphStates[index].selectedHash !== commit.hash) {
        return;
      }

      for (const button of [patchUpdateButton, patchVerifyButton, patchFreeformButton]) {
        configurePatchUpdateButton(button, { graph, index, commit, message });
      }

      if (
        loadCurrentIntegration &&
        !isWorkingTreeCommit(commit) &&
        getCommitPhabricatorRevision(commit, message)
      ) {
        void loadSelectedCommitIntegrationStatus(index, commit, integrationStatus);
      }
    });

    if (loadIntegration && !isWorkingTreeCommit(commit)) {
      void loadSelectedCommitIntegrationStatus(index, commit, integrationStatus);
    }

    try {
      const response = await fetch(
        "/api/graph/" + index + "/diff/" + encodeURIComponent(commit.hash) +
          "?token=" + encodeURIComponent(INTERACTIVE.token)
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || response.statusText);
      }

      if (graphStates[index].selectedHash !== commit.hash) {
        return;
      }

      setDiffStats(stats, result);
      if (result.html) {
        setDiffHtml(body, result.html);
      } else {
        setDiffText(body, result.text || "No diff for this commit.");
      }

      if (loadReviewButton) {
        loadReviewButton.disabled = false;
      }
    } catch (error) {
      if (graphStates[index].selectedHash !== commit.hash) {
        return;
      }

      setDiffStats(stats, null);
      setDiffText(body, error && error.message ? error.message : String(error));
      if (loadReviewButton) {
        loadReviewButton.disabled = false;
      }
    }

    return;
  }

  if (!diff) {
    setDiffText(body, "Diff data was not embedded for this commit.");
    return;
  }

  if (diff.error) {
    setDiffText(body, diff.error);
    return;
  }

  setDiffStats(stats, diff);
  if (diff.html) {
    setDiffHtml(body, diff.html);
    return;
  }

  setDiffText(body, diff.text || "No diff for this commit.");
}

export async function loadSelectedCommitReviewForCurrentSelection(button) {
  const index = Number(button?.dataset.graphIndex);
  const hash = button?.dataset.hash || "";
  const state = graphStates[index];
  const commit = state?.commits.find((candidate) => candidate.hash === hash);
  const viewer = document.getElementById("diff-" + index);
  const body = viewer?.querySelector(".diff-body");

  if (!commit || !body || state.selectedHash !== hash) {
    return;
  }

  button.disabled = true;
  button.textContent = "Loading Review...";
  const review = await fetchSelectedCommitReview(index, commit);

  if (state.selectedHash !== hash) {
    return;
  }

  renderSelectedCommitReview(index, commit, body, review);
  if (review?.error) {
    button.disabled = false;
    button.textContent = "Retry Review";
    return;
  }

  button.hidden = true;
}

function getRebaseModeLabel(mode = "") {
  if (mode === "selected") {
    return "selected commit";
  }

  if (mode === "children") {
    return "selected commit plus child stack";
  }

  if (mode === "stack") {
    return "whole local stack";
  }

  return "selected commit plus descendants";
}

export function getCommitActionDetails(
  action,
  label,
  hash,
  { rebaseMode = "", workingTree = false, preferredBranch = "" } = {},
) {
  const shortHash = hash.substring(0, 12);

  if (action === "checkout") {
    return {
      confirm: "Checkout " + shortHash + " in " + label + "? Branch tips will check out the branch; other commits will use detached HEAD.",
      progress: "Checking out...",
    };
  }

  if (action === "rebase") {
    const modeLabel = getRebaseModeLabel(rebaseMode);

    return {
      confirm: "Rebase " + modeLabel + " from " + shortHash + " in " + label + " onto the current checkout?",
      progress: "Rebasing...",
    };
  }

  if (action === "prune") {
    if (workingTree) {
      return {
        confirm: "Discard all uncommitted changes in " + label + "? This will reset the current checkout and remove untracked files.",
        progress: "Discarding uncommitted changes...",
      };
    }

    return {
      confirm: "Prune commit " + shortHash + " from local branch history in " + label + "?",
      progress: "Pruning commit...",
    };
  }

  if (action === "remove-branch") {
    return {
      confirm: "Remove local branch ref " + preferredBranch + " in " + label + "? This keeps the commit and does not change commit history. Branches checked out in a worktree cannot be removed.",
      progress: "Removing branch ref...",
    };
  }

  if (action === "branch") {
    return {
      confirm: "Create a Bug branch at " + shortHash + " in " + label + "?",
      progress: "Creating branch...",
    };
  }

  return {
    confirm: "Run " + action + " on " + shortHash + " in " + label + "?",
    progress: "Running...",
  };
}

export async function runCommitAction(
  action,
  {
    graphIndex,
    hash,
    label,
    preferredBranch = "",
    rebaseMode = "",
    workingTree = false,
  },
) {
  const details = getCommitActionDetails(action, label, hash, {
    rebaseMode,
    workingTree,
    preferredBranch,
  });
  const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

  if (!await showSystemConfirmation({
    title: "Confirm " + details.progress.replace(/\.\.\.$/, ""),
    message: details.confirm,
    confirmLabel: details.progress.replace(/\.\.\.$/, ""),
    danger: action === "prune" || action === "remove-branch",
  })) {
    return;
  }

  status.classList.remove("error");
  status.textContent = details.progress;

  try {
    const response = await fetch("/api/commit-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        graphIndex,
        hash,
        action,
        preferredBranch,
        rebaseMode,
        snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      if (action === "rebase" && result.rebaseConflict) {
        openRebaseFailureDialog(result.rebaseConflict, {
          fallbackMessage: result.error || response.statusText,
        });
        status.classList.add("error");
        status.textContent = "Rebase paused for conflicts.";
        return;
      }

      throw new Error(result.error || response.statusText);
    }

    if (result.branch) {
      graphStates[graphIndex].graph.branch = result.branch;
    }
    if (result.currentHash) {
      graphStates[graphIndex].currentHash = result.currentHash;
    } else if (action === "checkout") {
      graphStates[graphIndex].currentHash = hash;
    }
    updateCommitRowStates(graphIndex);

    if (result.snapshot) {
      applyGraphSnapshot(graphIndex, result.snapshot, { force: true });
    } else {
      await refreshGraphFromServer(graphIndex, { force: true });
    }

    status.textContent = result.message;
  } catch (error) {
    status.classList.add("error");
    status.textContent = error && error.message ? error.message : String(error);
  }
}

export async function continueRebaseDialog() {
  const dialogState = uiState.rebaseDialogState;

  if (!dialogState?.sessionId) {
    return;
  }

  const graphIndex = Number(dialogState.graphIndex);

  setRebaseDialogBusy("Continuing rebase...");

  try {
    const response = await fetch(
      "/api/rebase/" + encodeURIComponent(dialogState.sessionId) + "/continue",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: INTERACTIVE.token,
          snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
          resolutionId: dialogState.resolutionId,
        }),
      }
    );
    const result = await response.json();

    if (!response.ok) {
      if (result.rebaseConflict) {
        openRebaseFailureDialog(result.rebaseConflict, {
          fallbackMessage: result.error || response.statusText,
        });
        return;
      }

      throw new Error(result.error || response.statusText);
    }

    if (result.branch) {
      graphStates[graphIndex].graph.branch = result.branch;
    }
    if (result.currentHash) {
      graphStates[graphIndex].currentHash = result.currentHash;
    }

    if (result.snapshot) {
      applyGraphSnapshot(graphIndex, result.snapshot, { force: true });
    } else {
      await refreshGraphFromServer(graphIndex, { force: true });
    }

    finishRebaseDialog();
    selectCommitActionResult(graphIndex, result.currentHash, result.message);
  } catch (error) {
    setRebaseDialogError(error && error.message ? error.message : String(error));
  }
}

export async function checkoutSelectedCommit(button) {
  button.disabled = true;

  try {
    await runCommitAction("checkout", {
      graphIndex: Number(button.dataset.graphIndex),
      hash: button.dataset.hash,
      label: button.dataset.label,
    });
  } finally {
    button.disabled = false;
  }
}

export function closeAmendDialog() {
  uiState.amendDialogState = null;
  amendError.textContent = "";
  amendSubmit.disabled = false;
  amendDialog.close();
}

export async function openAmendDialog(button) {
  const graphIndex = Number(button.dataset.graphIndex);
  const hash = button.dataset.hash || "HEAD";
  const includeChanges = button.dataset.includeChanges === "true";
  const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

  button.disabled = true;
  status.classList.remove("error");
  status.textContent = "Loading commit message...";

  try {
    if (button.dataset.tryFixup === "true") {
      status.textContent = "Amending the patch with its Try fixup...";
      const response = await fetch("/api/amend-try-fixup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: INTERACTIVE.token, graphIndex, hash,
          snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      applyGraphSnapshot(graphIndex, result.snapshot);
      status.textContent = result.message;
      return;
    }
    const response = await fetch(
      "/api/graph/" + graphIndex + "/message/" + encodeURIComponent(hash) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.amendDialogState = {
      graphIndex,
      hash,
      changeId: button.dataset.changeId || "",
      includeChanges,
      label: button.dataset.label,
    };
    amendDialog.querySelector(".amend-title").textContent = includeChanges
      ? "Amend " + button.dataset.label + " current commit"
      : "Amend " + button.dataset.label + " commit " + hash.substring(0, 12);
    amendMessage.value = result.message || "";
    amendError.textContent = "";
    status.textContent = "";
    amendDialog.showModal();
    amendMessage.focus();
    amendMessage.setSelectionRange(amendMessage.value.length, amendMessage.value.length);
  } catch (error) {
    status.classList.add("error");
    status.textContent = error && error.message ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

export async function submitAmendDialog() {
  if (!uiState.amendDialogState) {
    return;
  }

  const message = amendMessage.value;

  if (!message.trim()) {
    amendError.textContent = "Commit message cannot be empty.";
    return;
  }

  amendSubmit.disabled = true;
  amendError.textContent = "Amending...";

  try {
    const response = await fetch("/api/amend-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        graphIndex: uiState.amendDialogState.graphIndex,
        hash: uiState.amendDialogState.hash,
        expectedChangeId: uiState.amendDialogState.changeId,
        includeChanges: uiState.amendDialogState.includeChanges,
        message,
        snapshotLimit: getLoadedGitCommitLimit(graphStates[uiState.amendDialogState.graphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    const graphIndex = uiState.amendDialogState.graphIndex;

    closeAmendDialog();

    if (result.snapshot) {
      applyGraphSnapshot(graphIndex, result.snapshot, { force: true });
    } else {
      await refreshGraphFromServer(graphIndex, { force: true });
    }

    selectCommitActionResult(graphIndex, result.rewrittenHash || result.currentHash, result.message);
  } catch (error) {
    amendError.textContent = error && error.message ? error.message : String(error);
  } finally {
    amendSubmit.disabled = false;
  }
}

export function closeSubmitDialog() {
  if (uiState.submitPollTimer) {
    window.clearTimeout(uiState.submitPollTimer);
    uiState.submitPollTimer = null;
  }

  submitDialog.close();
}

function isActiveSubmitSession(session) {
  return session && (session.status === "running" || session.status === "prompt");
}

function scheduleSubmitSessionPoll() {
  if (!uiState.submitDialogState || uiState.submitPollTimer) {
    return;
  }

  uiState.submitPollTimer = window.setTimeout(pollSubmitSession, 500);
}

export function setSubmitLinkNodes(links) {
  submitLinks.replaceChildren();

  if (!links || !links.length) {
    submitLinks.hidden = true;
    return;
  }

  for (const linkInfo of links) {
    const link = document.createElement("a");
    link.href = linkInfo.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = linkInfo.label || linkInfo.url;
    submitLinks.append(link);
  }

  submitLinks.hidden = false;
}

const submitTask = registerAiTaskDialog({ kind: "submit", dialog: submitDialog,
  title: value => `Submit ${value.graphIndex === undefined ? "patch" : "patch in " + (graphStates[value.graphIndex]?.graph.label || "comm")}`,
  endpoint: value => `/api/submit/${encodeURIComponent(value.id)}`,
  onUpdate: renderSubmitSession,
  restore(value) {
    uiState.submitDialogState = { graphIndex: value.graphIndex, sessionId: value.id, promptId: "", status: value.status,
      patchUpdateSessionId: value.patchUpdateSessionId || "" };
    renderSubmitSession(value, { autoClose: false });
    if (!submitDialog.open) submitDialog.showModal();
    if (isActiveSubmitSession(value)) scheduleSubmitSessionPoll();
  },
});

export function renderSubmitSession(session, { autoClose = true } = {}) {
  const active = isActiveSubmitSession(session);
  submitTask.update(session);

  if (uiState.submitDialogState) {
    uiState.submitDialogState.status = session.status;
  }

  submitStatus.textContent = session.message || session.status || "";
  submitStatus.classList.toggle("error", session.status === "error");
  submitClose.disabled = active;
  submitCancel.hidden = !active;
  submitCancel.disabled = false;
  setLiveText(submitOutput, session.output || "");
  if (!hasSelectedText(submitOutput)) submitOutput.scrollTop = submitOutput.scrollHeight;

  if (session.prompt) {
    submitPrompt.hidden = false;
    submitQuestion.textContent = session.prompt.message;
    uiState.submitDialogState.promptId = session.prompt.id;
  } else {
    submitPrompt.hidden = true;
    submitQuestion.textContent = "";
    uiState.submitDialogState.promptId = "";
  }

  setSubmitLinkNodes(session.links || []);

  if (session.status === "complete" && session.snapshot && !uiState.submitDialogState.appliedSnapshot) {
    uiState.submitDialogState.appliedSnapshot = true;
    applyGraphSnapshot(uiState.submitDialogState.graphIndex, session.snapshot, { force: true });
  }
  if (autoClose && session.status === "complete" && uiState.submitDialogState?.patchUpdateSessionId) closeSubmitDialog();
}

export async function pollSubmitSession() {
  if (!uiState.submitDialogState) {
    return;
  }

  uiState.submitPollTimer = null;
  const requestedId = uiState.submitDialogState.sessionId;

  try {
    const response = await fetch(
      "/api/submit/" + encodeURIComponent(uiState.submitDialogState.sessionId) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    if (uiState.submitDialogState?.sessionId !== requestedId) { submitTask.background(result); return; }
    renderSubmitSession(result);

    if (isActiveSubmitSession(result)) {
      scheduleSubmitSessionPoll();
    }
  } catch (error) {
    if (uiState.submitDialogState?.sessionId !== requestedId) return;
    submitStatus.classList.add("error");
    submitStatus.textContent = error && error.message ? error.message : String(error);
  }
}

export async function openSubmitDialog(button, { patchUpdateSessionId = "", onStarted, onError } = {}) {
  const graphIndex = Number(button.dataset.graphIndex);
  const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");
  const isCurrent = button.dataset.isCurrent === "true";
  const commitLabel = String(button.dataset.hash || "").slice(0, 12);

  if (!await showSystemConfirmation({
    title: "Submit patch",
    message: isCurrent
      ? "Submit the currently checked out commit in " + button.dataset.label + "?"
      : "Check out " + commitLabel + " in " + button.dataset.label + " and submit it?",
    confirmLabel: "Submit",
  })) {
    return;
  }

  if (!await confirmRemoteBuildRustWarning("submit")) {
    return;
  }

  button.disabled = true;
  status.classList.remove("error");
  status.textContent = "Starting submit...";

  try {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        graphIndex,
        hash: button.dataset.hash,
        patchUpdateSessionId,
        snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.submitDialogState = {
      patchUpdateSessionId,
      graphIndex,
      sessionId: result.id,
      promptId: "",
      appliedSnapshot: false,
      status: result.status,
    };
    onStarted?.();
    submitTitle.textContent = "Submit " + button.dataset.label + " " + commitLabel;
    submitPrompt.hidden = true;
    submitQuestion.textContent = "";
    submitLinks.hidden = true;
    submitLinks.replaceChildren();
    submitOutput.textContent = "";
    renderSubmitSession(result);
    status.textContent = "";
    if (result.status !== "complete" || !patchUpdateSessionId) submitDialog.showModal();
    pollSubmitSession();
  } catch (error) {
    status.classList.add("error");
    status.textContent = error && error.message ? error.message : String(error);
    onError?.(status.textContent);
  } finally {
    button.disabled = false;
  }
}

export async function answerSubmitPrompt(answer) {
  if (!uiState.submitDialogState || !uiState.submitDialogState.promptId) {
    return;
  }

  submitStatus.classList.remove("error");
  submitStatus.textContent = "Running submit...";
  submitPrompt.hidden = true;

  if (uiState.submitPollTimer) {
    window.clearTimeout(uiState.submitPollTimer);
    uiState.submitPollTimer = null;
  }

  try {
    const response = await fetch(
      "/api/submit/" + encodeURIComponent(uiState.submitDialogState.sessionId) + "/answer",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: INTERACTIVE.token,
          promptId: uiState.submitDialogState.promptId,
          answer,
        }),
      }
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderSubmitSession(result);
    if (isActiveSubmitSession(result)) {
      pollSubmitSession();
    }
  } catch (error) {
    submitStatus.classList.add("error");
    submitStatus.textContent = error && error.message ? error.message : String(error);
  }
}

export async function cancelSubmitSession() {
  if (!uiState.submitDialogState || !isActiveSubmitSession(uiState.submitDialogState)) {
    return;
  }

  const { sessionId } = uiState.submitDialogState;

  submitCancel.disabled = true;
  submitStatus.classList.remove("error");
  submitStatus.textContent = "Canceling submit...";

  if (uiState.submitPollTimer) {
    window.clearTimeout(uiState.submitPollTimer);
    uiState.submitPollTimer = null;
  }

  try {
    const response = await fetch(
      "/api/submit/" + encodeURIComponent(sessionId) + "/cancel",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: INTERACTIVE.token }),
      }
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderSubmitSession(result);
  } catch (error) {
    submitCancel.disabled = false;
    submitStatus.classList.add("error");
    submitStatus.textContent = error && error.message ? error.message : String(error);
  }
}
