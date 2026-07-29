import {
  INTERACTIVE,
  amendDialog,
  amendError,
  amendMessage,
  amendSubmit,
  graphStates,
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
  applyGraphSnapshot,
  confirmRemoteBuildRustWarning,
  getLoadedGitCommitLimit,
  refreshGraphFromServer,
} from "./command-sessions.js";

export async function showDiff(graph, index, commit) {
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
  amendButton.textContent = isWorkingTreeCommit(commit) ? "Amend" : "Amend Message";
  amendButton.dataset.graphIndex = String(index);
  amendButton.dataset.hash = commit.hash;
  amendButton.dataset.label = graph.label;
  amendButton.dataset.changeId = commit.changeId || "";
  amendButton.dataset.includeChanges = String(isWorkingTreeCommit(commit));
  submitButton.hidden = !INTERACTIVE.enabled || isWorkingTreeCommit(commit) || !isCurrentCommit(commit);
  submitButton.disabled = false;
  submitButton.dataset.graphIndex = String(index);
  submitButton.dataset.hash = commit.hash;
  submitButton.dataset.label = graph.label;
  checkoutStatus.classList.remove("error");
  checkoutStatus.textContent = "";
  setDiffStats(stats, null);

  if (INTERACTIVE.enabled) {
    setDiffText(body, "Loading diff...");
    loadSelectedCommitMessage(index, commit, commitMessage);
    loadSelectedCommitIntegrationStatus(index, commit, integrationStatus);

    try {
      const response = await fetch(
        "/api/graph/" + index + "/diff/" + encodeURIComponent(commit.hash) +
          "?token=" + encodeURIComponent(INTERACTIVE.token)
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || response.statusText);
      }

      setDiffStats(stats, result);
      if (result.html) {
        setDiffHtml(body, result.html);
      } else {
        setDiffText(body, result.text || "No diff for this commit.");
      }
    } catch (error) {
      setDiffStats(stats, null);
      setDiffText(body, error && error.message ? error.message : String(error));
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
  { rebaseMode = "", workingTree = false } = {},
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
  });
  const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

  if (!confirm(details.confirm)) {
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

export function renderSubmitSession(session) {
  submitStatus.textContent = session.message || session.status || "";
  submitStatus.classList.toggle("error", session.status === "error");
  submitClose.disabled = session.status === "running" || session.status === "prompt";
  submitOutput.textContent = session.output || "";
  submitOutput.scrollTop = submitOutput.scrollHeight;

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
}

export async function pollSubmitSession() {
  if (!uiState.submitDialogState) {
    return;
  }

  try {
    const response = await fetch(
      "/api/submit/" + encodeURIComponent(uiState.submitDialogState.sessionId) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderSubmitSession(result);

    if (result.status === "running") {
      uiState.submitPollTimer = window.setTimeout(pollSubmitSession, 500);
    }
  } catch (error) {
    submitStatus.classList.add("error");
    submitStatus.textContent = error && error.message ? error.message : String(error);
  }
}

export async function openSubmitDialog(button) {
  const graphIndex = Number(button.dataset.graphIndex);
  const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

  if (!confirm("Submit the currently checked out commit in " + button.dataset.label + "?")) {
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
        snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.submitDialogState = {
      graphIndex,
      sessionId: result.id,
      promptId: "",
      appliedSnapshot: false,
    };
    submitTitle.textContent = "Submit " + button.dataset.label + " current commit";
    submitPrompt.hidden = true;
    submitQuestion.textContent = "";
    submitLinks.hidden = true;
    submitLinks.replaceChildren();
    submitOutput.textContent = "";
    renderSubmitSession(result);
    status.textContent = "";
    submitDialog.showModal();
    pollSubmitSession();
  } catch (error) {
    status.classList.add("error");
    status.textContent = error && error.message ? error.message : String(error);
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
    pollSubmitSession();
  } catch (error) {
    submitStatus.classList.add("error");
    submitStatus.textContent = error && error.message ? error.message : String(error);
  }
}
