import {
  INTERACTIVE,
  commitBranchStatus,
  commitBug,
  commitBugField,
  commitClose,
  commitDialog,
  commitForm,
  commitReviewerInput,
  commitReviewerPills,
  commitStatus,
  commitSubmit,
  commitSummary,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshots,
  getSnapshotLimits,
  hasActiveCommandSession,
  setMachOutputPanel,
  setUpdateBusy,
  setUpdateStatus,
} from "./command-sessions.js";
import { showSystemNotice } from "./system-dialog.js";

function createCommitDialogState() {
  return {
    metadata: null,
    reviewers: [],
  };
}

function setCommitDialogBusy(busy) {
  commitForm.querySelectorAll("input, button").forEach((field) => {
    field.disabled = busy;
  });
  commitClose.disabled = false;
  commitSubmit.disabled = busy;
}

function setCommitStatus(message, { error = false } = {}) {
  commitStatus.textContent = message;
  commitStatus.classList.toggle("error", error);
}

function getCommitDialogState() {
  if (!uiState.commitDialogState) {
    uiState.commitDialogState = createCommitDialogState();
  }

  return uiState.commitDialogState;
}

function getReviewerInputText(value = "") {
  return String(value || "")
    .trim()
    .replace(/^r=/i, "");
}

function hasReviewerBlockingMarker(value = "") {
  const text = getReviewerInputText(value).trim();

  return text.endsWith("!");
}

function stripReviewerBlockingMarker(value = "") {
  return getReviewerInputText(value).trim().replace(/!+$/, "").trim();
}

function normalizeReviewerInputValue(value = "") {
  let normalized = stripReviewerBlockingMarker(value);
  const blocking = hasReviewerBlockingMarker(value);

  if (!normalized) {
    return { value: "", blocking };
  }

  if (normalized.startsWith("#")) {
    normalized = "#" + normalized.replace(/^#+/, "");
  }

  return { value: normalized, blocking };
}

function getReviewerKey(reviewer) {
  return String(reviewer?.value || "").toLowerCase();
}

function renderCommitReviewerPills() {
  const state = getCommitDialogState();

  commitReviewerPills.replaceChildren(
    ...state.reviewers.map((reviewer) => {
      const pill = document.createElement("span");
      const label = document.createElement("span");
      const blocking = document.createElement("button");
      const remove = document.createElement("button");

      pill.className =
        "commit-reviewer-pill" + (reviewer.blocking ? " blocking" : "");
      label.textContent = reviewer.value + (reviewer.blocking ? "!" : "");
      blocking.type = "button";
      blocking.className = "commit-reviewer-blocking";
      blocking.dataset.value = reviewer.value;
      blocking.setAttribute(
        "aria-label",
        "Toggle blocking review for " + reviewer.value,
      );
      blocking.setAttribute(
        "aria-pressed",
        reviewer.blocking ? "true" : "false",
      );
      blocking.title = "Toggle blocking review";
      blocking.textContent = "!";
      remove.type = "button";
      remove.className = "commit-reviewer-remove";
      remove.dataset.value = reviewer.value;
      remove.setAttribute("aria-label", "Remove " + reviewer.value);
      remove.textContent = "x";
      pill.append(label, blocking, remove);
      return pill;
    }),
  );
}

function addCommitReviewer(reviewer) {
  const normalized = normalizeReviewerInputValue(reviewer?.value || reviewer);
  const value = normalized.value;
  const blocking = Boolean(reviewer?.blocking || normalized.blocking);

  if (!value) {
    return false;
  }

  const state = getCommitDialogState();
  const key = value.toLowerCase();

  if (state.reviewers.some((item) => getReviewerKey(item) === key)) {
    if (blocking) {
      const existing = state.reviewers.find(
        (item) => getReviewerKey(item) === key,
      );
      existing.blocking = true;
      renderCommitReviewerPills();
    }
    commitReviewerInput.value = "";
    return false;
  }

  state.reviewers.push({
    type: reviewer?.type || (value.startsWith("#") ? "group" : "user"),
    value,
    label: reviewer?.label || value,
    description: reviewer?.description || "",
    blocking,
  });
  commitReviewerInput.value = "";
  renderCommitReviewerPills();
  return true;
}

export function handleCommitReviewerPillEvent(event) {
  const removeButton = event.target.closest(".commit-reviewer-remove");
  const blockingButton = event.target.closest(".commit-reviewer-blocking");

  if (!removeButton && !blockingButton) {
    return false;
  }

  const state = getCommitDialogState();
  const key = String(
    (removeButton || blockingButton).dataset.value || "",
  ).toLowerCase();

  if (removeButton) {
    state.reviewers = state.reviewers.filter(
      (reviewer) => getReviewerKey(reviewer) !== key,
    );
  } else {
    const reviewer = state.reviewers.find(
      (item) => getReviewerKey(item) === key,
    );

    if (reviewer) {
      reviewer.blocking = !reviewer.blocking;
    }
  }

  renderCommitReviewerPills();
  commitReviewerInput.focus();
  return true;
}

export function handleCommitReviewerInputKeydown(event) {
  if (event.key !== "Enter" && event.key !== ",") {
    return;
  }

  event.preventDefault();
  addCommitReviewer(commitReviewerInput.value);
}

function renderCommitMetadata(metadata) {
  const branch = metadata.branch || "(detached)";

  commitBranchStatus.textContent = metadata.bugRequired
    ? branch + " needs a Bugzilla bug ID."
    : branch + " will commit as " + metadata.prefix + ".";
  commitBugField.hidden = !metadata.bugRequired;
  commitBug.required = Boolean(metadata.bugRequired);
  commitBug.value = metadata.bugRequired ? "" : metadata.bugId || "";
}

export async function openCommitDialog() {
  if (hasActiveCommandSession()) {
    await showSystemNotice({
      title: "Command already active",
      message: "Wait for the current command to finish or cancel it before starting another one.",
    });
    return;
  }

  uiState.commitDialogState = createCommitDialogState();
  commitSummary.value = "";
  commitReviewerInput.value = "";
  renderCommitReviewerPills();
  commitBranchStatus.textContent = "Loading checkout...";
  setCommitStatus("Ready to commit changes.");
  setCommitDialogBusy(false);
  commitDialog.showModal();
  commitSummary.focus();

  try {
    const response = await fetch(
      "/api/commit/metadata?token=" + encodeURIComponent(INTERACTIVE.token),
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    getCommitDialogState().metadata = result.metadata;
    renderCommitMetadata(result.metadata);
  } catch (error) {
    setCommitStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
  }
}

export function closeCommitDialog() {
  commitDialog.close();
}

function getCommitDialogOptions() {
  const state = getCommitDialogState();

  return {
    bugId: commitBugField.hidden ? "" : commitBug.value,
    summary: commitSummary.value,
    reviewers: state.reviewers.map((reviewer) => ({
      value: reviewer.value,
      blocking: Boolean(reviewer.blocking),
    })),
  };
}

export async function submitCommitDialog(event) {
  event.preventDefault();

  if (hasActiveCommandSession()) {
    await showSystemNotice({
      title: "Command already active",
      message: "Wait for the current command to finish or cancel it before starting another one.",
    });
    return;
  }

  setCommitDialogBusy(true);
  setCommitStatus("Creating commit...");
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("Commit running...", { busy: true });

  try {
    const response = await fetch("/api/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options: getCommitDialogOptions(),
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    uiState.lastMachSession = result.output ? { output: result.output } : null;
    setMachOutputPanel(uiState.lastMachSession);
    setCommitStatus(
      result.commitMessage || result.message || "Commit created.",
    );
    setUpdateStatus(result.message || "Commit complete.");
  } catch (error) {
    setCommitStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
    setUpdateStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
  } finally {
    setCommitDialogBusy(false);
    setUpdateBusy(false);
  }
}
