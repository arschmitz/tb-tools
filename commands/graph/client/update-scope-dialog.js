import {
  graphStates,
  uiState,
  updateScopeBoth,
  updateScopeClose,
  updateScopeCurrent,
  updateScopeDescription,
  updateScopeDialog,
  updateScopeTitle,
} from "./config.js";
import { runGraphUpdate } from "./command-sessions.js";

function getActiveGraphIndex() {
  const index = Number(document.querySelector(".panel.active")?.dataset.index);

  return Number.isInteger(index) ? index : 0;
}

function getCheckoutLabel(graph = {}) {
  return graph.checkout === "review" ? "Review" : "Working";
}

function hasMultipleCheckoutPairs() {
  return new Set(graphStates.map(({ graph }) => graph.checkout || "working")).size > 1;
}

function closeUpdateScopeDialog() {
  uiState.updateScopeState = null;

  if (updateScopeDialog.open) {
    updateScopeDialog.close();
  }
}

async function runScopedUpdate(scope) {
  const state = uiState.updateScopeState;

  if (!state) {
    return;
  }

  closeUpdateScopeDialog();
  await runGraphUpdate(state.mode, "", scope, state.graphIndex);
}

export function openUpdateScopeDialog(mode) {
  const graphIndex = getActiveGraphIndex();
  const graph = graphStates[graphIndex]?.graph;

  if (!graph) {
    return;
  }

  if (!hasMultipleCheckoutPairs()) {
    runGraphUpdate(mode, "", "current", graphIndex);
    return;
  }

  const action = mode === "rebase" ? "Rebase" : "Pull";
  const checkoutLabel = getCheckoutLabel(graph);

  uiState.updateScopeState = { mode, graphIndex };
  updateScopeTitle.textContent = action;
  updateScopeDescription.textContent =
    `Choose whether to update the ${checkoutLabel.toLowerCase()} Firefox and comm pair or both independent checkout pairs.`;
  updateScopeCurrent.textContent = `${action} ${checkoutLabel} checkout`;
  updateScopeBoth.textContent = `${action} both checkout pairs`;
  updateScopeDialog.showModal();
}

export function initializeUpdateScopeDialog() {
  updateScopeCurrent.addEventListener("click", () => runScopedUpdate("current"));
  updateScopeBoth.addEventListener("click", () => runScopedUpdate("both"));
  updateScopeClose.addEventListener("click", closeUpdateScopeDialog);
  updateScopeDialog.addEventListener("close", () => {
    uiState.updateScopeState = null;
  });
}
