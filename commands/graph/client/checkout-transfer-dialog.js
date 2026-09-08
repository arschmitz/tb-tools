import {
  INTERACTIVE,
  checkoutTransferBranch,
  checkoutTransferCancel,
  checkoutTransferClose,
  checkoutTransferDescription,
  checkoutTransferDialog,
  checkoutTransferDiscard,
  checkoutTransferForm,
  checkoutTransferStatus,
  checkoutTransferSubmit,
  checkoutTransferTitle,
  graphStates,
  uiState,
} from "./config.js";
import { applyGraphSnapshots } from "./command-sessions.js";

function getCheckoutName(graph = {}) {
  return graph.checkout === "review" ? "Review" : "Working";
}

function getDestinationIndex(sourceGraphIndex) {
  const source = graphStates[sourceGraphIndex]?.graph;

  if (!source) {
    return -1;
  }

  return graphStates.findIndex(({ graph }, graphIndex) => (
    graphIndex !== sourceGraphIndex &&
    graph.repository === source.repository &&
    (graph.checkout || "working") !== (source.checkout || "working")
  ));
}

function closeCheckoutTransferDialog() {
  uiState.checkoutTransferState = null;

  if (checkoutTransferDialog.open) {
    checkoutTransferDialog.close();
  }
}

function setCheckoutTransferBusy(busy) {
  checkoutTransferBranch.disabled = busy;
  checkoutTransferSubmit.disabled = busy;
  checkoutTransferDiscard.disabled = busy;
  checkoutTransferCancel.disabled = busy;
  checkoutTransferClose.disabled = busy;
}

function getSelectedMode() {
  return checkoutTransferForm.querySelector("input[name='checkout-transfer-mode']:checked")?.value || "commit";
}

async function submitCheckoutTransfer(discardDirty = false) {
  const state = uiState.checkoutTransferState;

  if (!state) {
    return;
  }

  setCheckoutTransferBusy(true);
  checkoutTransferStatus.classList.remove("error");
  checkoutTransferStatus.textContent = "Copying commits...";

  try {
    const response = await fetch("/api/checkout-transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        sourceGraphIndex: state.sourceGraphIndex,
        destinationGraphIndex: state.destinationGraphIndex,
        hash: state.hash,
        mode: getSelectedMode(),
        branch: checkoutTransferBranch.value.trim(),
        discardDirty,
        snapshotLimits: graphStates.map((state) => state.commits.length || 80),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      if (result.transfer?.reason === "destination-dirty" && !discardDirty) {
        checkoutTransferDiscard.hidden = false;
      }

      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    closeCheckoutTransferDialog();
  } catch (error) {
    checkoutTransferStatus.classList.add("error");
    checkoutTransferStatus.textContent = error?.message || String(error);
  } finally {
    setCheckoutTransferBusy(false);
  }
}

export function openCheckoutTransferDialog(actionState) {
  const sourceGraphIndex = Number(actionState?.graphIndex);
  const destinationGraphIndex = getDestinationIndex(sourceGraphIndex);
  const source = graphStates[sourceGraphIndex]?.graph;
  const destination = graphStates[destinationGraphIndex]?.graph;

  if (!source || !destination) {
    return;
  }

  uiState.checkoutTransferState = {
    sourceGraphIndex,
    destinationGraphIndex,
    hash: actionState.hash,
  };
  checkoutTransferTitle.textContent = `Copy ${actionState.hash.slice(0, 12)}`;
  checkoutTransferDescription.textContent =
    `Copy from ${getCheckoutName(source)} ${source.repository} to ${getCheckoutName(destination)} ${destination.repository}. The destination branch starts from its local origin/main.`;
  checkoutTransferBranch.value = /^Bug-\d{4,8}(?:_\d+)?$/.test(actionState.preferredBranch || "")
    ? actionState.preferredBranch
    : "";
  checkoutTransferStatus.classList.remove("error");
  checkoutTransferStatus.textContent = "";
  checkoutTransferDiscard.hidden = true;
  setCheckoutTransferBusy(false);
  checkoutTransferDialog.showModal();
}

export function initializeCheckoutTransferDialog() {
  checkoutTransferForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitCheckoutTransfer();
  });
  checkoutTransferDiscard.addEventListener("click", () => {
    void submitCheckoutTransfer(true);
  });
  checkoutTransferCancel.addEventListener("click", closeCheckoutTransferDialog);
  checkoutTransferClose.addEventListener("click", closeCheckoutTransferDialog);
  checkoutTransferDialog.addEventListener("close", () => {
    uiState.checkoutTransferState = null;
  });
}
