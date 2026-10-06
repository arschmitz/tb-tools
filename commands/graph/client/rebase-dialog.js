import { registerAiTaskDialog, enableTaskNotifications } from "./ai-task-tray.js";
import {
  INTERACTIVE,
  rebaseConflictFiles,
  rebaseContinue,
  rebaseDialog,
  rebaseError,
  rebaseOutput,
  rebaseStatus,
  rebaseSummary,
  uiState,
} from "./config.js";

const resolveButton = rebaseDialog.querySelector(".rebase-resolve");
const closeButton = rebaseDialog.querySelector(".rebase-close");
const review = rebaseDialog.querySelector(".rebase-resolution-review");
const diff = rebaseDialog.querySelector(".rebase-resolution-diff");
let busy = false;
const taskView = registerAiTaskDialog({ kind: "rebase", dialog: rebaseDialog,
  title: () => "AI conflict resolution", endpoint: () => undefined,
  restore: value => {
    uiState.rebaseDialogState = value.rebaseState;
    rebaseContinue.disabled = value.status === "complete";
    resolveButton.disabled = value.status === "complete";
    if (!rebaseDialog.open) rebaseDialog.showModal();
  },
});

rebaseDialog.addEventListener("cancel", event => {
  if (busy || uiState.rebaseDialogState?.resolutionId) {
    event.preventDefault();
    if (!busy) void cancelResolution();
  }
});

async function resolutionRequest(suffix = "") {
  const state = uiState.rebaseDialogState;
  const response = await fetch("/api/rebase/" + encodeURIComponent(state.sessionId) + "/resolution" + suffix, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: INTERACTIVE.token, resolutionId: state.resolutionId, stream: !suffix }),
  });
  const result = await readResolutionResponse(response);
  if (!response.ok || !result.ok) throw new Error(result.error || response.statusText);
  return result;
}

async function readResolutionResponse(response) {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result;
  const readEvent = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "result") result = event;
    if (event.type === "progress") {
      const elapsed = Number(event.elapsedSeconds) || 0;
      const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
      const output = event.outputCharacters ? ` · ${event.outputCharacters.toLocaleString()} characters received` : "";
      rebaseStatus.textContent = `${event.message} (${time})${output}`;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop();
      lines.forEach(readEvent);
      if (done) {
        readEvent(pending);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("The connection closed before conflict resolution finished.");
  return result;
}

async function resolveConflicts() {
  void enableTaskNotifications();
  setRebaseDialogBusy("AI is resolving all conflicted files...");
  try {
    const { resolution } = await resolutionRequest();
    uiState.rebaseDialogState.resolutionId = resolution.id;
    diff.innerHTML = resolution.html;
    review.hidden = false;
    resolveButton.hidden = true;
    closeButton.textContent = "Cancel";
    rebaseContinue.textContent = "Continue";
    rebaseStatus.textContent = "All conflicted files are resolved. Review the changes below.";
  } catch (error) {
    setRebaseDialogError(error.message);
  } finally {
    setBusy(false);
  }
}

async function cancelResolution() {
  setRebaseDialogBusy("Undoing the AI conflict resolution...");
  try {
    await resolutionRequest("/cancel");
    openRebaseFailureDialog(uiState.rebaseDialogState.conflict);
  } catch (error) {
    setRebaseDialogError(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  busy = value;
  rebaseContinue.disabled = value;
  resolveButton.disabled = value;
  closeButton.disabled = value;
  if (uiState.rebaseDialogState?.sessionId) taskView.update({ id: uiState.rebaseDialogState.sessionId,
    status: value ? "applying" : "review", rebaseState: uiState.rebaseDialogState });
}

function getVscodeUrl(absolutePath = "") {
  if (!absolutePath) {
    return "#";
  }

  return "vscode://file/" + absolutePath.replace(/\\/g, "/");
}

function createConflictFileRow(file) {
  const row = document.createElement("div");
  const pathLabel = document.createElement("code");
  const actions = document.createElement("div");
  const copy = document.createElement("button");
  const open = document.createElement("a");

  row.className = "rebase-conflict-file";
  pathLabel.className = "rebase-conflict-path";
  pathLabel.textContent = file.path || file.absolutePath || "Unknown path";
  pathLabel.title = file.absolutePath || file.path || "";
  actions.className = "rebase-conflict-actions";
  copy.className = "rebase-copy-path";
  copy.type = "button";
  copy.dataset.path = file.path || file.absolutePath || "";
  copy.textContent = "Copy path";
  open.className = "rebase-open-vscode";
  open.href = getVscodeUrl(file.absolutePath);
  open.rel = "noreferrer";
  open.textContent = "VS Code";
  actions.append(copy, open);
  row.append(pathLabel, actions);
  return row;
}

export function openRebaseFailureDialog(conflict, { fallbackMessage = "" } = {}) {
  const files = Array.isArray(conflict?.files) ? conflict.files : [];
  const conflictCommit = conflict?.conflictCommit || "";
  const commitLabel = conflictCommit ? conflictCommit.substring(0, 12) : "selected commit";

  uiState.rebaseDialogState = {
    conflict,
    graphIndex: Number(conflict?.graphIndex),
    sessionId: conflict?.id || "",
  };

  setBusy(false);
  review.hidden = true;
  diff.textContent = "";
  closeButton.textContent = "Close";
  resolveButton.hidden = !INTERACTIVE.aiEnabled || conflict?.type !== "conflict" || !conflict?.id || !files.length;
  rebaseStatus.classList.remove("error");
  rebaseStatus.textContent = conflict?.reason === "conflict-markers"
    ? "Conflict markers are still present. Remove them before continuing."
    : conflict?.type === "conflict"
      ? "Resolve the conflicts, then continue the rebase."
      : conflict?.type === "edit"
        ? "Interactive rebase paused for manual work."
        : "The rebase failed.";
  rebaseSummary.textContent = conflict?.message ||
    fallbackMessage ||
    "The rebase could not complete.";
  if (conflict?.type === "conflict") {
    rebaseSummary.textContent = conflict?.reason === "conflict-markers"
      ? "These files still contain conflict markers for " + commitLabel + "."
      : "Conflict while applying " + commitLabel + " in " +
        (conflict.label || "checkout") + ".";
  } else if (conflict?.type === "edit") {
    rebaseSummary.textContent = conflict?.reason === "dirty-edit-stop"
      ? "Commit or amend the manual work for " + commitLabel + ", then continue."
      : "Make any manual changes for " + commitLabel + ", amend if needed, then continue.";
  }

  rebaseConflictFiles.replaceChildren();
  if (files.length) {
    rebaseConflictFiles.classList.remove("empty");
    files.forEach((file) => rebaseConflictFiles.append(createConflictFileRow(file)));
  } else {
    rebaseConflictFiles.classList.add("empty");
    rebaseConflictFiles.textContent = "No conflicted files were reported by git.";
  }

  rebaseOutput.textContent = conflict?.output || fallbackMessage || "";
  rebaseError.textContent = "";
  rebaseContinue.hidden = !conflict?.canContinue || !conflict?.id;
  rebaseContinue.disabled = false;
  rebaseContinue.textContent = "Continue Rebase";

  if (!rebaseDialog.open) {
    rebaseDialog.showModal();
  }
}

export function closeRebaseDialog() {
  if (busy) return;
  if (uiState.rebaseDialogState?.resolutionId) {
    void cancelResolution();
    return;
  }
  uiState.rebaseDialogState = null;
  rebaseError.textContent = "";
  rebaseDialog.close();
}

export function setRebaseDialogBusy(message) {
  setBusy(true);
  rebaseStatus.classList.remove("error");
  rebaseStatus.textContent = message;
  rebaseError.textContent = "";
}

export function setRebaseDialogError(message) {
  setBusy(false);
  rebaseStatus.classList.add("error");
  rebaseError.textContent = message;
}

export function handleRebaseDialogClick(event) {
  if (event.target.closest(".rebase-resolve")) {
    if (!busy && INTERACTIVE.aiEnabled) void resolveConflicts();
    return true;
  }
  const copy = event.target.closest(".rebase-copy-path");

  if (!copy) {
    return false;
  }

  if (navigator.clipboard) {
    navigator.clipboard.writeText(copy.dataset.path || "");
  }

  return true;
}

export function finishRebaseDialog() {
  setBusy(false);
  if (uiState.rebaseDialogState?.sessionId) taskView.update({ id: uiState.rebaseDialogState.sessionId,
    status: "complete", rebaseState: uiState.rebaseDialogState });
  if (uiState.rebaseDialogState) delete uiState.rebaseDialogState.resolutionId;
  closeRebaseDialog();
}
