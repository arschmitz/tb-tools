import {
  INTERACTIVE,
  reviewSyncCancel,
  reviewSyncClose,
  reviewSyncConfirmation,
  reviewSyncDialog,
  reviewSyncForm,
  reviewSyncStatus,
  reviewSyncSubmit,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshots,
  getSnapshotLimits,
  refreshOriginMainStatus,
} from "./command-sessions.js";

const REVIEW_SYNC_CONFIRMATION = "SYNC REVIEW";

function setReviewSyncBusy(busy) {
  reviewSyncConfirmation.disabled = busy;
  reviewSyncCancel.disabled = busy;
  reviewSyncClose.disabled = busy;

  if (busy) {
    reviewSyncSubmit.disabled = true;
    return;
  }

  updateReviewSyncSubmit();
}

function updateReviewSyncSubmit() {
  reviewSyncSubmit.disabled =
    reviewSyncConfirmation.value.trim() !== REVIEW_SYNC_CONFIRMATION ||
    reviewSyncConfirmation.disabled;
}

function closeReviewSyncDialog() {
  uiState.reviewSyncState = null;

  if (reviewSyncDialog.open) {
    reviewSyncDialog.close();
  }
}

async function submitReviewSync() {
  if (reviewSyncConfirmation.value.trim() !== REVIEW_SYNC_CONFIRMATION) {
    reviewSyncStatus.classList.add("error");
    reviewSyncStatus.textContent = `Type ${REVIEW_SYNC_CONFIRMATION} to continue.`;
    return;
  }

  setReviewSyncBusy(true);
  reviewSyncStatus.classList.remove("error");
  reviewSyncStatus.textContent = "Replacing the Review checkout and copying build artifacts...";

  try {
    const response = await fetch("/api/review-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        confirmation: REVIEW_SYNC_CONFIRMATION,
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    await refreshOriginMainStatus({ force: true });
    closeReviewSyncDialog();
  } catch (error) {
    reviewSyncStatus.classList.add("error");
    reviewSyncStatus.textContent = error?.message || String(error);
  } finally {
    setReviewSyncBusy(false);
  }
}

export function openReviewSyncDialog() {
  uiState.reviewSyncState = {};
  reviewSyncConfirmation.value = "";
  reviewSyncStatus.classList.remove("error");
  reviewSyncStatus.textContent = "";
  setReviewSyncBusy(false);
  reviewSyncDialog.showModal();
  reviewSyncConfirmation.focus();
}

export function initializeReviewSyncDialog() {
  reviewSyncConfirmation.addEventListener("input", updateReviewSyncSubmit);
  reviewSyncForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitReviewSync();
  });
  reviewSyncCancel.addEventListener("click", closeReviewSyncDialog);
  reviewSyncClose.addEventListener("click", closeReviewSyncDialog);
  reviewSyncDialog.addEventListener("close", () => {
    uiState.reviewSyncState = null;
  });
}
