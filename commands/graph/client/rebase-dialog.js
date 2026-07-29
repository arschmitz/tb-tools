import {
  rebaseConflictFiles,
  rebaseContinue,
  rebaseDialog,
  rebaseError,
  rebaseOutput,
  rebaseStatus,
  rebaseSummary,
  uiState,
} from "./config.js";

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

  rebaseStatus.classList.remove("error");
  rebaseStatus.textContent = conflict?.reason === "conflict-markers"
    ? "Conflict markers are still present. Remove them before continuing."
    : conflict?.type === "conflict"
      ? "Resolve the conflicts, then continue the rebase."
      : "The rebase failed.";
  rebaseSummary.textContent = conflict?.message ||
    fallbackMessage ||
    "The rebase could not complete.";
  if (conflict?.type === "conflict") {
    rebaseSummary.textContent = conflict?.reason === "conflict-markers"
      ? "These files still contain conflict markers for " + commitLabel + "."
      : "Conflict while applying " + commitLabel + " in " +
        (conflict.label || "checkout") + ".";
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
  uiState.rebaseDialogState = null;
  rebaseError.textContent = "";
  rebaseDialog.close();
}

export function setRebaseDialogBusy(message) {
  rebaseContinue.disabled = true;
  rebaseStatus.classList.remove("error");
  rebaseStatus.textContent = message;
  rebaseError.textContent = "";
}

export function setRebaseDialogError(message) {
  rebaseContinue.disabled = false;
  rebaseStatus.classList.add("error");
  rebaseError.textContent = message;
}

export function handleRebaseDialogClick(event) {
  const copy = event.target.closest(".rebase-copy-path");

  if (!copy) {
    return false;
  }

  if (navigator.clipboard) {
    navigator.clipboard.writeText(copy.dataset.path || "");
  }

  return true;
}
