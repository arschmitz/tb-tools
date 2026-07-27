import {
  DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  INTERACTIVE,
  amendDialog,
  amendForm,
  contextMenu,
  graphStates,
  submitClose,
  submitDialog,
  tryDialog,
  tryForm,
  trySelector,
  uiState,
} from "./config.js";
import { getCurrentCommitHash } from "./commit-model.js";
import { showError } from "./dom.js";
import {
  resizePaneFromKeyboard,
  restoreGraphPaneWidth,
  startPaneResize,
} from "./pane-resizer.js";
import {
  loadMoreCommits,
  renderLaneGraph,
  scheduleGraphEnhancements,
  renderLoadedGraph,
} from "./lane-renderer.js";
import {
  cancelGraphMachAction,
  closeGraphOptionsMenu,
  pollGraphUpdates,
  refreshOriginMainStatus,
  runGraphUpdate,
  setGraphOptionsMenuOpen,
  setMachOutputPanel,
  dismissCommandStatus,
  startGraphMachAction,
  submitTryDialog,
  toggleGraphSubmenu,
  hasActiveTrySession,
  openTryDialog,
  updateTryDialogFields,
} from "./command-sessions.js";
import {
  answerSubmitPrompt,
  checkoutSelectedCommit,
  closeAmendDialog,
  closeSubmitDialog,
  openAmendDialog,
  openSubmitDialog,
  runCommitAction,
  submitAmendDialog,
} from "./commit-actions.js";
import { markBugForCheckin } from "./diff-viewer.js";
import { hideCommitContextMenu } from "./lane-renderer.js";

document.addEventListener("click", (event) => {
  if (!event.target.closest(".context-menu")) {
    hideCommitContextMenu();
  }

  if (!event.target.closest(".graph-options")) {
    closeGraphOptionsMenu();
  }

  const graphMenuButton = event.target.closest(".graph-menu-button");
  if (graphMenuButton) {
    const menu = document.querySelector(".graph-options-menu");
    setGraphOptionsMenuOpen(Boolean(menu && menu.hidden));
    return;
  }

  const graphSubmenuTrigger = event.target.closest(".graph-submenu-trigger");
  if (graphSubmenuTrigger) {
    toggleGraphSubmenu(graphSubmenuTrigger);
    return;
  }

  const graphMenuCommand = event.target.closest(".graph-menu-command");
  if (graphMenuCommand && event.target.closest(".graph-options-menu")) {
    const menuAction = graphMenuCommand.dataset.menuAction;
    closeGraphOptionsMenu();

    if (menuAction === "build") {
      startGraphMachAction("build");
    }

    if (menuAction === "try") {
      openTryDialog();
    }

    return;
  }

  const checkoutButton = event.target.closest(".checkout-commit");
  if (checkoutButton) {
    checkoutSelectedCommit(checkoutButton);
    return;
  }

  const amendButton = event.target.closest(".amend-commit");
  if (amendButton) {
    openAmendDialog(amendButton);
    return;
  }

  const submitButton = event.target.closest(".submit-commit");
  if (submitButton) {
    openSubmitDialog(submitButton);
    return;
  }

  const checkinButton = event.target.closest(".checkin-needed-button");
  if (checkinButton) {
    markBugForCheckin(checkinButton);
    return;
  }

  const updateButton = event.target.closest(".update-action");
  if (updateButton) {
    runGraphUpdate(updateButton.dataset.mode);
    return;
  }

  const machButton = event.target.closest(".mach-action");
  if (machButton) {
    closeGraphOptionsMenu();
    startGraphMachAction(machButton.dataset.action);
    return;
  }

  const machCancelButton = event.target.closest(".mach-cancel");
  if (machCancelButton) {
    cancelGraphMachAction();
    return;
  }

  const machOutputToggle = event.target.closest(".mach-output-toggle");
  if (machOutputToggle) {
    uiState.machOutputVisible = !uiState.machOutputVisible;
    setMachOutputPanel();
    return;
  }

  const commandStatusClose = event.target.closest(".command-status-close");
  if (commandStatusClose) {
    dismissCommandStatus();
    return;
  }

  const button = event.target.closest(".copy-path");
  if (!button) {
    return;
  }

  if (navigator.clipboard) {
    navigator.clipboard.writeText(button.dataset.path);
  }
});

contextMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");

  if (!button || !uiState.contextMenuState) {
    return;
  }

  event.stopPropagation();
  const actionState = uiState.contextMenuState;
  hideCommitContextMenu();
  runCommitAction(button.dataset.action, actionState);
});

amendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAmendDialog();
});

amendDialog.querySelector(".amend-cancel").addEventListener("click", closeAmendDialog);
submitClose.addEventListener("click", closeSubmitDialog);
submitDialog.querySelectorAll("button[data-answer]").forEach((button) => {
  button.addEventListener("click", () => answerSubmitPrompt(button.dataset.answer === "true"));
});
trySelector.addEventListener("change", updateTryDialogFields);
tryForm.addEventListener("submit", submitTryDialog);
tryDialog.querySelector(".try-cancel").addEventListener("click", () => {
  if (!hasActiveTrySession()) {
    tryDialog.close();
  }
});

window.addEventListener("scroll", () => {
  hideCommitContextMenu();
  closeGraphOptionsMenu();
}, { passive: true });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideCommitContextMenu();
    closeGraphOptionsMenu();
  }
});

export function handleSentinelIntersections(entries) {
  for (const entry of entries) {
    const index = Number(entry.target.dataset.index);
    const state = graphStates[index];

    if (!entry.isIntersecting) {
      state.sentinelReady = true;
      continue;
    }

    if (
      !state.sentinelReady ||
      !state.scrolledTowardBottom ||
      !document.querySelector('.panel[data-index="' + index + '"]').classList.contains("active")
    ) {
      continue;
    }

    state.sentinelReady = false;
    state.scrolledTowardBottom = false;
    loadMoreCommits(index);
  }
}

uiState.loadObserver = INTERACTIVE.enabled
  ? new IntersectionObserver(handleSentinelIntersections, { rootMargin: "0px 0px 240px 0px" })
  : null;

export function trackScrollDirection() {
  if (!INTERACTIVE.enabled) {
    return;
  }

  const activePanel = document.querySelector(".panel.active");
  const index = Number(activePanel.dataset.index);
  const state = graphStates[index];

  if (window.scrollY > state.lastScrollY) {
    state.scrolledTowardBottom = true;
  }

  state.lastScrollY = window.scrollY;
}

export function renderGraph(index) {
  const state = graphStates[index];
  const graph = state.graph;
  const container = document.getElementById("graph-" + index);

  if (graph.error) {
    showError(container, graph.error);
    return;
  }

  if (INTERACTIVE.enabled) {
    if (!state.commits.length) {
      loadMoreCommits(index);
    } else {
      renderLoadedGraph(index);
    }

    return;
  }

  if (state.rendered) {
    return;
  }

  if (!state.commits.length) {
    container.textContent = "No commits found.";
    state.rendered = true;
    return;
  }

  try {
    state.currentHash = getCurrentCommitHash(state.commits) || state.currentHash;
    renderLaneGraph(index, state.commits);
    scheduleGraphEnhancements(index);
    state.rendered = true;
  } catch (error) {
    showError(container, error && error.message ? error.message : String(error));
  }
}

export function showTab(index) {
  document.querySelectorAll(".tab, .panel").forEach((node) => node.classList.remove("active"));
  document.querySelector('.tab[data-index="' + index + '"]').classList.add("active");
  document.querySelector('.panel[data-index="' + index + '"]').classList.add("active");
  restoreGraphPaneWidth(index);
  renderGraph(index);
  scheduleGraphEnhancements(index);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => showTab(Number(tab.dataset.index)));
});

document.querySelectorAll(".pane-resizer").forEach((resizer) => {
  resizer.addEventListener("pointerdown", startPaneResize);
  resizer.addEventListener("keydown", resizePaneFromKeyboard);
});

window.addEventListener("scroll", trackScrollDirection, { passive: true });
window.addEventListener("resize", () => {
  const activePanel = document.querySelector(".panel.active");

  if (activePanel) {
    restoreGraphPaneWidth(Number(activePanel.dataset.index));
  }
}, { passive: true });

if (INTERACTIVE.enabled) {
  function sendCloseSignal() {
    const payload = JSON.stringify({ token: INTERACTIVE.token });

    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/close", new Blob([payload], { type: "application/json" }));
      return;
    }

    fetch("/api/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    });
  }

  const heartbeat = setInterval(() => {
    fetch("/api/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: INTERACTIVE.token }),
      keepalive: true,
    }).catch(() => {});
  }, 2000);
  const graphPoll = setInterval(pollGraphUpdates, INTERACTIVE.pollIntervalMs);
  const originMainStatusPoll = setInterval(
    refreshOriginMainStatus,
    Math.max(INTERACTIVE.pollIntervalMs, DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS)
  );

  refreshOriginMainStatus();

  window.addEventListener("pagehide", () => {
    clearInterval(heartbeat);
    clearInterval(graphPoll);
    clearInterval(originMainStatusPoll);
    if (uiState.machPollTimer) {
      window.clearTimeout(uiState.machPollTimer);
    }
    if (uiState.commandElapsedTimer) {
      window.clearInterval(uiState.commandElapsedTimer);
    }
    if (uiState.originMainStatusRetryTimer) {
      window.clearTimeout(uiState.originMainStatusRetryTimer);
    }
    sendCloseSignal();
  }, { once: true });
  window.addEventListener("beforeunload", sendCloseSignal, { once: true });
}

restoreGraphPaneWidth(0);
renderGraph(0);
