import {
  INTERACTIVE,
  graphStates,
  interactiveRebaseDialog,
  interactiveRebaseEnd,
  interactiveRebaseError,
  interactiveRebaseStatus,
  interactiveRebaseSubmit,
  interactiveRebaseTodo,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshot,
  getLoadedGitCommitLimit,
  refreshGraphFromServer,
} from "./command-sessions.js";
import { selectCommitActionResult } from "./diff-viewer.js";
import { openRebaseFailureDialog } from "./rebase-dialog.js";

const INTERACTIVE_REBASE_ACTIONS = [
  ["pick", "Pick"],
  ["squash", "Squash"],
  ["fixup", "Fixup"],
  ["edit", "Stop"],
  ["drop", "Drop"],
];

function getCommitLabel(commit) {
  return commit.shortHash + " " + commit.subject;
}

function setInteractiveRebaseError(message = "") {
  interactiveRebaseError.textContent = message;
  interactiveRebaseStatus.classList.toggle("error", Boolean(message));
}

function getPlanEndIndex() {
  const state = uiState.interactiveRebaseDialogState;
  const commits = state?.plan?.commits || [];
  const selectedHash = interactiveRebaseEnd.value;
  const index = commits.findIndex((commit) => commit.hash === selectedHash);

  return index === -1 ? commits.length - 1 : index;
}

function getEditableRows() {
  return Array.from(
    interactiveRebaseTodo.querySelectorAll(".interactive-rebase-row"),
  );
}

function createActionSelect(commit, index) {
  const select = document.createElement("select");

  select.className = "interactive-rebase-action";
  select.setAttribute("aria-label", "Rebase action for " + commit.shortHash);

  for (const [value, label] of INTERACTIVE_REBASE_ACTIONS) {
    const option = document.createElement("option");

    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  select.value = index === 0 &&
    ["squash", "fixup"].includes(commit.action)
    ? "pick"
    : commit.action || "pick";

  return select;
}

function createMoveButton(direction, label) {
  const button = document.createElement("button");

  button.className = "interactive-rebase-move";
  button.type = "button";
  button.dataset.move = direction;
  button.textContent = label;

  return button;
}

function createTodoRow(commit, index, total) {
  const row = document.createElement("div");
  const controls = document.createElement("div");
  const hash = document.createElement("code");
  const subject = document.createElement("span");

  row.className = "interactive-rebase-row";
  row.dataset.hash = commit.hash;
  controls.className = "interactive-rebase-row-controls";
  hash.className = "interactive-rebase-hash";
  hash.textContent = commit.shortHash;
  subject.className = "interactive-rebase-subject";
  subject.textContent = commit.subject;

  const up = createMoveButton("up", "Up");
  const down = createMoveButton("down", "Down");

  up.disabled = index === 0;
  down.disabled = index === total - 1;
  controls.append(createActionSelect(commit, index), up, down);
  row.append(controls, hash, subject);

  return row;
}

function updateMoveButtons() {
  const rows = getEditableRows();

  rows.forEach((row, index) => {
    const up = row.querySelector('[data-move="up"]');
    const down = row.querySelector('[data-move="down"]');

    up.disabled = index === 0;
    down.disabled = index === rows.length - 1;
  });
}

function renderInteractiveRebaseTodo() {
  const state = uiState.interactiveRebaseDialogState;
  const commits = state?.plan?.commits || [];
  const endIndex = getPlanEndIndex();
  const editableCommits = commits.slice(0, endIndex + 1);
  const laterCommits = commits.slice(endIndex + 1);

  interactiveRebaseTodo.replaceChildren();

  for (const [index, commit] of editableCommits.entries()) {
    interactiveRebaseTodo.append(createTodoRow(
      commit,
      index,
      editableCommits.length,
    ));
  }

  if (laterCommits.length) {
    const note = document.createElement("div");

    note.className = "interactive-rebase-after-range";
    note.textContent = laterCommits.length + " later descendant" +
      (laterCommits.length === 1 ? "" : "s") +
      " will replay as pick after the editable range.";
    interactiveRebaseTodo.append(note);
  }

  setInteractiveRebaseError("");
}

function populateInteractiveRebaseEndSelect(plan) {
  interactiveRebaseEnd.replaceChildren();

  for (const commit of plan.commits || []) {
    const option = document.createElement("option");

    option.value = commit.hash;
    option.textContent = getCommitLabel(commit);
    interactiveRebaseEnd.append(option);
  }

  interactiveRebaseEnd.value = plan.commits.at(-1)?.hash || "";
}

export function closeInteractiveRebaseDialog() {
  uiState.interactiveRebaseDialogState = null;
  setInteractiveRebaseError("");
  interactiveRebaseSubmit.disabled = false;
  interactiveRebaseDialog.close();
}

export async function openInteractiveRebaseDialog({
  graphIndex,
  hash,
  label,
  preferredBranch = "",
} = {}) {
  if (!INTERACTIVE.enabled) {
    return;
  }

  uiState.interactiveRebaseDialogState = null;
  interactiveRebaseStatus.classList.remove("error");
  interactiveRebaseStatus.textContent = "Loading commits...";
  interactiveRebaseTodo.replaceChildren();
  interactiveRebaseEnd.replaceChildren();
  interactiveRebaseSubmit.disabled = true;
  setInteractiveRebaseError("");

  if (!interactiveRebaseDialog.open) {
    interactiveRebaseDialog.showModal();
  }

  try {
    const params = new URLSearchParams({
      token: INTERACTIVE.token,
      graphIndex: String(graphIndex),
      hash,
      preferredBranch,
    });
    const response = await fetch("/api/interactive-rebase/plan?" + params);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.interactiveRebaseDialogState = {
      graphIndex: Number(graphIndex),
      hash,
      label,
      preferredBranch,
      plan: result.plan,
    };
    populateInteractiveRebaseEndSelect(result.plan);
    renderInteractiveRebaseTodo();
    interactiveRebaseStatus.textContent = "Editing " +
      (result.plan.commits.length || 0) +
      " commit" + (result.plan.commits.length === 1 ? "" : "s") +
      " from " + (label || result.plan.label) + ".";
    interactiveRebaseSubmit.disabled = false;
  } catch (error) {
    setInteractiveRebaseError(error && error.message ? error.message : String(error));
  }
}

function getInteractiveRebaseItems() {
  const state = uiState.interactiveRebaseDialogState;
  const commits = state?.plan?.commits || [];
  const endIndex = getPlanEndIndex();
  const editableRows = getEditableRows();
  let hasPreviousCommit = false;
  const editableItems = editableRows.map((row) => {
    const action = row.querySelector(".interactive-rebase-action").value;

    if (!hasPreviousCommit && ["squash", "fixup"].includes(action)) {
      throw new Error("The first interactive rebase row cannot use squash or fixup.");
    }

    if (action !== "drop") {
      hasPreviousCommit = true;
    }

    return {
      hash: row.dataset.hash,
      action,
    };
  });
  const laterItems = commits.slice(endIndex + 1).map((commit) => ({
    hash: commit.hash,
    action: "pick",
  }));

  return [...editableItems, ...laterItems];
}

export async function submitInteractiveRebaseDialog(event) {
  event.preventDefault();
  const state = uiState.interactiveRebaseDialogState;

  if (!state) {
    return;
  }

  let items;

  try {
    items = getInteractiveRebaseItems();
  } catch (error) {
    setInteractiveRebaseError(error && error.message ? error.message : String(error));
    return;
  }

  interactiveRebaseSubmit.disabled = true;
  interactiveRebaseStatus.classList.remove("error");
  interactiveRebaseStatus.textContent = "Starting interactive rebase...";
  setInteractiveRebaseError("");

  try {
    const response = await fetch("/api/interactive-rebase", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        graphIndex: state.graphIndex,
        hash: state.hash,
        preferredBranch: state.preferredBranch,
        items,
        snapshotLimit: getLoadedGitCommitLimit(graphStates[state.graphIndex]),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      if (result.rebaseConflict) {
        closeInteractiveRebaseDialog();
        openRebaseFailureDialog(result.rebaseConflict, {
          fallbackMessage: result.error || response.statusText,
        });
        return;
      }

      throw new Error(result.error || response.statusText);
    }

    if (result.branch) {
      graphStates[state.graphIndex].graph.branch = result.branch;
    }
    if (result.currentHash) {
      graphStates[state.graphIndex].currentHash = result.currentHash;
    }

    if (result.snapshot) {
      applyGraphSnapshot(state.graphIndex, result.snapshot, { force: true });
    } else {
      await refreshGraphFromServer(state.graphIndex, { force: true });
    }

    closeInteractiveRebaseDialog();
    selectCommitActionResult(state.graphIndex, result.currentHash, result.message);
  } catch (error) {
    interactiveRebaseSubmit.disabled = false;
    setInteractiveRebaseError(error && error.message ? error.message : String(error));
  }
}

export function updateInteractiveRebaseRange() {
  if (!uiState.interactiveRebaseDialogState) {
    return;
  }

  renderInteractiveRebaseTodo();
}

export function handleInteractiveRebaseDialogClick(event) {
  const move = event.target.closest(".interactive-rebase-move");

  if (!move) {
    return false;
  }

  const row = move.closest(".interactive-rebase-row");

  if (!row) {
    return false;
  }

  if (move.dataset.move === "up" && row.previousElementSibling?.classList.contains("interactive-rebase-row")) {
    interactiveRebaseTodo.insertBefore(row, row.previousElementSibling);
  } else if (move.dataset.move === "down" && row.nextElementSibling?.classList.contains("interactive-rebase-row")) {
    interactiveRebaseTodo.insertBefore(row.nextElementSibling, row);
  }

  updateMoveButtons();
  setInteractiveRebaseError("");
  return true;
}
