import {
  DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  INTERACTIVE,
  amendDialog,
  amendForm,
  commitClose,
  commitForm,
  commitReviewerInput,
  commitReviewerPills,
  contextMenu,
  graphStates,
  interactiveRebaseEnd,
  interactiveRebaseForm,
  landClose,
  landDialog,
  landInputForm,
  landStart,
  newPatchClose,
  newPatchForm,
  patchDialog,
  patchForm,
  patchRaw,
  phabAuthCancel,
  phabAuthClose,
  phabAuthSignOut,
  phabAuthStart,
  submitClose,
  submitDialog,
  testClose,
  testDialog,
  testForm,
  testOutputPanel,
  testOutputTab,
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
  renderOriginMainStatus,
  setGraphOptionsMenuOpen,
  setMachOutputPanel,
  dismissCommandStatus,
  startGraphLintAction,
  startGraphMachAction,
  submitTryDialog,
  toggleGraphSubmenu,
  hasActiveTestSession,
  hasActiveTrySession,
  openTryDialog,
  updateTryDialogFields,
} from "./command-sessions.js";
import {
  initializeUpdateScopeDialog,
  openUpdateScopeDialog,
} from "./update-scope-dialog.js";
import {
  initializeCheckoutTransferDialog,
  openCheckoutTransferDialog,
} from "./checkout-transfer-dialog.js";
import {
  initializeReviewSyncDialog,
  openReviewSyncDialog,
} from "./review-sync-dialog.js";
import {
  answerLandPrompt,
  cancelOrCloseLandDialog,
  openLandDialog,
  startGraphLandSession,
  submitLandInputPrompt,
} from "./landing-dialog.js";
import {
  cancelOrCloseNewPatchDialog,
  openNewPatchDialog,
  startGraphNewPatchSession,
} from "./new-patch-dialog.js";
import {
  answerPatchPrompt,
  cancelOrClosePatchDialog,
  openPatchDialog,
  startGraphPatchSession,
  updatePatchDialogFields,
} from "./patch-dialog.js";
import {
  cancelGraphTestSession,
  handleTestOutputClick,
  openTestDialog,
  showTestOutputTab,
  startGraphTestSession,
} from "./test-dialog.js";
import {
  hideMetaBoards,
  initializeMetaBoards,
  openMetaBoardBugDetail,
  openMetaBoardManager,
  showMetaBoards,
} from "./meta-boards.js";
import {
  hideSprints,
  initializeSprints,
  showSprint,
} from "./sprints.js";
import {
  answerSubmitPrompt,
  cancelSubmitSession,
  checkoutSelectedCommit,
  closeAmendDialog,
  continueRebaseDialog,
  closeSubmitDialog,
  loadSelectedCommitReviewForCurrentSelection,
  openAmendDialog,
  openSubmitDialog,
  runCommitAction,
  showDiff,
  submitAmendDialog,
} from "./commit-actions.js";
import {
  closeCommitDialog,
  handleCommitReviewerPillEvent,
  handleCommitReviewerInputKeydown,
  openCommitDialog,
  submitCommitDialog,
} from "./commit-dialog.js";
import { initializeDashboard, showDashboard } from "./dashboard.js";
import {
  initializePatchUpdateDialog,
  openPatchUpdateDialog,
} from "./patch-update-dialog.js";
import { initializePatchReviewDialog } from "./patch-review-dialog.js";
import {
  cancelPhabricatorAuthentication,
  closePhabricatorAuthDialog,
  openPhabricatorAuthDialog,
  signOutOfPhabricator,
  startPhabricatorAuthentication,
} from "./phab-auth-dialog.js";
import {
  closeRebaseDialog,
  handleRebaseDialogClick,
} from "./rebase-dialog.js";
import {
  closeInteractiveRebaseDialog,
  handleInteractiveRebaseDialogClick,
  openInteractiveRebaseDialog,
  submitInteractiveRebaseDialog,
  updateInteractiveRebaseRange,
} from "./interactive-rebase-dialog.js";
import { handleDiffContextClick } from "./diff-context.js";
import { markBugForCheckin } from "./diff-viewer.js";
import { hideCommitContextMenu } from "./lane-renderer.js";
import { clearConsoleRoute, getConsoleRoute } from "./view-router.js";

function openLinkInNewTab(link) {
  if (!link?.hasAttribute("href")) {
    return;
  }

  link.target = "_blank";
  link.relList.add("noopener", "noreferrer");
}

function openLinksInNewTabs(root) {
  if (root.matches?.("a[href]")) {
    openLinkInNewTab(root);
  }

  root.querySelectorAll?.("a[href]").forEach(openLinkInNewTab);
}

openLinksInNewTabs(document);

const linkTargetObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach(openLinksInNewTabs);
  });
});

linkTargetObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

document.addEventListener("click", (event) => {
  openLinkInNewTab(event.target.closest("a[href]"));
}, true);

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

    if (menuAction === "commit") {
      openCommitDialog();
    }

    if (menuAction === "phabricator-auth") {
      openPhabricatorAuthDialog();
    }

    if (menuAction === "meta-boards-add") {
      openMetaBoardManager({ focusAdd: true });
    }

    if (menuAction === "meta-boards-manage") {
      openMetaBoardManager();
    }

    if (menuAction === "lint-all" || menuAction === "lint-outgoing") {
      startGraphLintAction(menuAction.replace(/^lint-/, ""));
    }

    if (menuAction === "try") {
      openTryDialog();
    }

    if (menuAction === "new-patch") {
      openNewPatchDialog();
    }

    if (menuAction === "pull-patch") {
      openPatchDialog();
    }

    if (menuAction === "test") {
      openTestDialog();
    }

    if (menuAction === "land") {
      openLandDialog();
    }

    if (menuAction === "review-sync") {
      openReviewSyncDialog();
    }

    return;
  }

  const checkoutButton = event.target.closest(".checkout-commit");
  const loadReviewButton = event.target.closest(".load-commit-review");

  if (loadReviewButton) {
    void loadSelectedCommitReviewForCurrentSelection(loadReviewButton);
    return;
  }

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

  const patchUpdateButton = event.target.closest(".patch-update-commit");
  if (patchUpdateButton) {
    openPatchUpdateDialog({
      patch: {
        id: patchUpdateButton.dataset.revision,
        title: patchUpdateButton.dataset.title,
        url: patchUpdateButton.dataset.url,
      },
      graphIndex: Number(patchUpdateButton.dataset.graphIndex),
    });
    return;
  }

  const checkinButton = event.target.closest(".checkin-needed-button");
  if (checkinButton) {
    markBugForCheckin(checkinButton);
    return;
  }

  const updateButton = event.target.closest(".update-action");
  if (updateButton) {
    openUpdateScopeDialog(updateButton.dataset.mode);
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
    if (hasActiveTestSession()) {
      cancelGraphTestSession();
    } else {
      cancelGraphMachAction();
    }
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

  if (handleTestOutputClick(event)) {
    return;
  }

  if (handleDiffContextClick(event)) {
    return;
  }

  if (handleRebaseDialogClick(event)) {
    return;
  }

  if (handleInteractiveRebaseDialogClick(event)) {
    return;
  }

  const rebaseContinue = event.target.closest(".rebase-continue");
  if (rebaseContinue) {
    continueRebaseDialog();
    return;
  }

  const rebaseClose = event.target.closest(".rebase-close");
  if (rebaseClose) {
    closeRebaseDialog();
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
  const actionState = {
    ...uiState.contextMenuState,
    rebaseMode: button.dataset.rebaseMode || "",
  };
  hideCommitContextMenu();

  if (button.dataset.action === "interactive-rebase") {
    openInteractiveRebaseDialog(actionState);
    return;
  }

  if (button.dataset.action === "copy") {
    openCheckoutTransferDialog(actionState);
    return;
  }

  runCommitAction(button.dataset.action, actionState);
});

amendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAmendDialog();
});

amendDialog
  .querySelector(".amend-cancel")
  .addEventListener("click", closeAmendDialog);
interactiveRebaseForm.addEventListener("submit", submitInteractiveRebaseDialog);
interactiveRebaseEnd.addEventListener("change", updateInteractiveRebaseRange);
interactiveRebaseForm
  .querySelector(".interactive-rebase-close")
  .addEventListener("click", closeInteractiveRebaseDialog);
commitForm.addEventListener("submit", submitCommitDialog);
commitClose.addEventListener("click", closeCommitDialog);
commitReviewerInput.addEventListener(
  "keydown",
  handleCommitReviewerInputKeydown,
);
commitReviewerPills.addEventListener("click", (event) => {
  handleCommitReviewerPillEvent(event);
});
phabAuthClose.addEventListener("click", closePhabricatorAuthDialog);
phabAuthCancel.addEventListener("click", cancelPhabricatorAuthentication);
phabAuthSignOut.addEventListener("click", signOutOfPhabricator);
phabAuthStart.addEventListener("click", startPhabricatorAuthentication);
submitClose.addEventListener("click", closeSubmitDialog);
submitDialog.querySelector(".submit-cancel").addEventListener("click", cancelSubmitSession);
submitDialog.querySelectorAll("button[data-answer]").forEach((button) => {
  button.addEventListener("click", () =>
    answerSubmitPrompt(button.dataset.answer === "true"),
  );
});
trySelector.addEventListener("change", updateTryDialogFields);
tryForm.addEventListener("submit", submitTryDialog);
tryDialog.querySelector(".try-cancel").addEventListener("click", () => {
  if (!hasActiveTrySession()) {
    tryDialog.close();
  }
});
landStart.addEventListener("click", () => {
  if (landStart.dataset.landAnswer) {
    answerLandPrompt(landStart.dataset.landAnswer);
    return;
  }

  startGraphLandSession();
});
landClose.addEventListener("click", () => {
  if (landClose.dataset.landAnswer) {
    answerLandPrompt(landClose.dataset.landAnswer);
    return;
  }

  cancelOrCloseLandDialog();
});
landInputForm.addEventListener("submit", submitLandInputPrompt);
newPatchForm.addEventListener("submit", startGraphNewPatchSession);
newPatchClose.addEventListener("click", cancelOrCloseNewPatchDialog);
patchForm.addEventListener("submit", startGraphPatchSession);
patchRaw.addEventListener("change", updatePatchDialogFields);
patchDialog
  .querySelector(".patch-close")
  .addEventListener("click", cancelOrClosePatchDialog);
patchDialog.querySelectorAll("button[data-answer]").forEach((button) => {
  button.addEventListener("click", () =>
    answerPatchPrompt(button.dataset.answer === "true"),
  );
});
testForm.addEventListener("submit", startGraphTestSession);
testClose.addEventListener("click", () => {
  testDialog.close();
});
testOutputTab.addEventListener("click", showTestOutputTab);
landDialog.addEventListener("click", (event) => {
  const button = event.target.closest("[data-land-answer], .land-choice");

  if (!button) {
    return;
  }

  const answer =
    button.dataset.answerType === "boolean"
      ? button.dataset.landAnswer === "true"
      : button.dataset.landAnswer || button.dataset.answer;

  answerLandPrompt(answer);
});

window.addEventListener(
  "scroll",
  () => {
    hideCommitContextMenu();
    closeGraphOptionsMenu();
  },
  { passive: true },
);
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
      !document
        .querySelector('.panel[data-index="' + index + '"]')
        .classList.contains("active")
    ) {
      continue;
    }

    state.sentinelReady = false;
    state.scrolledTowardBottom = false;
    loadMoreCommits(index);
  }
}

uiState.loadObserver = INTERACTIVE.enabled
  ? new IntersectionObserver(handleSentinelIntersections, {
      rootMargin: "0px 0px 240px 0px",
    })
  : null;

export function trackScrollDirection() {
  if (!INTERACTIVE.enabled) {
    return;
  }

  const activePanel = document.querySelector(".panel.active");
  if (!activePanel) {
    return;
  }

  const index = Number(activePanel.dataset.index);
  if (!Number.isInteger(index)) {
    return;
  }

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
      void loadMoreCommits(index).then(() => selectCurrentCommit(index));
    } else {
      renderLoadedGraph(index);
      selectCurrentCommit(index);
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
    state.currentHash =
      getCurrentCommitHash(state.commits) || state.currentHash;
    renderLaneGraph(index, state.commits);
    scheduleGraphEnhancements(index);
    state.rendered = true;
  } catch (error) {
    showError(
      container,
      error && error.message ? error.message : String(error),
    );
  }
}

function selectCurrentCommit(index) {
  const state = graphStates[index];

  if (state.selectedHash || !state.currentHash) {
    return;
  }

  const currentCommit = state.commits.find((commit) => (
    commit.hash === state.currentHash
  ));

  if (currentCommit) {
    void showDiff(state.graph, index, currentCommit);
  }
}

let lastGraphTabIndex = Number(
  document.querySelector(".tab[data-index].active")?.dataset.index || 0,
);
const graphViewTab = document.querySelector(".graph-view-tab");

function getGraphRepository(graph = {}) {
  return String(graph.repository || graph.label || "").trim().toLowerCase();
}

function getGraphIndexForCheckout(repository, checkout) {
  return graphStates.findIndex(({ graph }) => (
    getGraphRepository(graph) === repository &&
    (graph.checkout || "working") === checkout
  ));
}

function updateCheckoutModeSwitch() {
  document.querySelectorAll(".checkout-mode-button").forEach((button) => {
    const active = button.dataset.checkout === uiState.checkoutMode;

    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function updateRepositorySwitch(repository) {
  document.querySelectorAll(".repository-button").forEach((button) => {
    const active = button.dataset.repository === repository;

    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function switchCheckoutMode(checkout) {
  if (!checkout || checkout === uiState.checkoutMode) {
    return;
  }

  const currentGraph = graphStates[lastGraphTabIndex]?.graph;
  const currentRepository = getGraphRepository(currentGraph) || "comm";
  const index = getGraphIndexForCheckout(currentRepository, checkout);
  const fallbackIndex = graphStates.findIndex(({ graph }) => (
    (graph.checkout || "working") === checkout
  ));

  if (index === -1 && fallbackIndex === -1) {
    return;
  }

  uiState.checkoutMode = checkout;
  uiState.originMainStatuses = [];
  uiState.rustUpstreamStatus = null;
  showTab(index === -1 ? fallbackIndex : index);
  void refreshOriginMainStatus();
}

export function showTab(index) {
  const graph = graphStates[index]?.graph;

  if (!graph) {
    return;
  }

  lastGraphTabIndex = index;
  document.body.classList.add("graph-view-active");
  uiState.checkoutMode = graph.checkout || "working";
  clearConsoleRoute();
  document
    .querySelectorAll(".tab, .panel")
    .forEach((node) => node.classList.remove("active"));
  const dashboardPanel = document.querySelector(".dashboard-panel");

  if (dashboardPanel) {
    dashboardPanel.hidden = true;
  }
  hideMetaBoards();
  hideSprints();
  testOutputPanel.hidden = true;
  testOutputTab.classList.remove("active");
  const repository = getGraphRepository(graph);
  const tab = document.querySelector(
    '.tab[data-repository="' + repository + '"]',
  ) || document.querySelector('.tab[data-index="' + index + '"]');

  tab?.classList.add("active");
  graphViewTab?.classList.add("active");
  document
    .querySelector('.panel[data-index="' + index + '"]')
    .classList.add("active");
  updateCheckoutModeSwitch();
  updateRepositorySwitch(repository);
  renderOriginMainStatus(uiState.originMainStatuses);
  restoreGraphPaneWidth(index);
  renderGraph(index);
  scheduleGraphEnhancements(index);
}

document.querySelectorAll(".tab[data-index]").forEach((tab) => {
  tab.addEventListener("click", () => showTab(Number(tab.dataset.index)));
});

document.querySelectorAll(".tab[data-repository]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const index = getGraphIndexForCheckout(
      String(tab.dataset.repository || "").toLowerCase(),
      uiState.checkoutMode,
    );

    if (index !== -1) {
      showTab(index);
    }
  });
});

document.querySelectorAll(".checkout-mode-button").forEach((button) => {
  button.addEventListener("click", () => switchCheckoutMode(button.dataset.checkout));
});

graphViewTab?.addEventListener("click", () => showTab(lastGraphTabIndex));

initializeDashboard();
initializePatchUpdateDialog();
initializePatchReviewDialog();
initializeUpdateScopeDialog();
initializeCheckoutTransferDialog();
initializeReviewSyncDialog();
initializeMetaBoards();
initializeSprints({ openBugDetail: openMetaBoardBugDetail });

function applyConsoleRoute() {
  const route = getConsoleRoute();

  if (route?.view === "dashboard") {
    showDashboard({ updateLocation: false });
    return;
  }

  if (route?.view === "meta-boards") {
    showMetaBoards({ boardId: route.boardId, updateLocation: false });
    return;
  }

  if (route?.view === "sprint") {
    showSprint({
      boardId: route.boardId,
      sprintId: route.sprintId,
      sprintView: route.sprintView,
      updateLocation: false,
    });
    return;
  }

  if (!window.location.hash) {
    showTab(lastGraphTabIndex);
  }
}

window.addEventListener("hashchange", applyConsoleRoute);
window.addEventListener("popstate", applyConsoleRoute);
applyConsoleRoute();

document.querySelectorAll(".pane-resizer").forEach((resizer) => {
  resizer.addEventListener("pointerdown", startPaneResize);
  resizer.addEventListener("keydown", resizePaneFromKeyboard);
});

window.addEventListener("scroll", trackScrollDirection, { passive: true });
window.addEventListener("tb-phab-authenticated", () => {
  graphStates.forEach((state, index) => {
    const commit = state.commits.find((item) => item.hash === state.selectedHash);

    if (commit) {
      showDiff(state.graph, index, commit).catch(() => {});
    }
  });
});
window.addEventListener(
  "resize",
  () => {
    const activePanel = document.querySelector(".panel.active");

    if (activePanel) {
      restoreGraphPaneWidth(Number(activePanel.dataset.index));
    }
  },
  { passive: true },
);

if (INTERACTIVE.enabled) {
  function createClientId() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  const clientId = createClientId();
  let closeSignalSent = false;

  function getClientPayload() {
    return JSON.stringify({ token: INTERACTIVE.token, clientId });
  }

  function clearInteractiveTimers() {
    clearInterval(heartbeat);
    clearInterval(graphPoll);
    clearInterval(originMainStatusPoll);
    if (uiState.machPollTimer) {
      window.clearTimeout(uiState.machPollTimer);
    }
    if (uiState.lintPollTimer) {
      window.clearTimeout(uiState.lintPollTimer);
    }
    if (uiState.newPatchPollTimer) {
      window.clearTimeout(uiState.newPatchPollTimer);
    }
    if (uiState.patchPollTimer) {
      window.clearTimeout(uiState.patchPollTimer);
    }
    if (uiState.testPollTimer) {
      window.clearTimeout(uiState.testPollTimer);
    }
    if (uiState.landPollTimer) {
      window.clearTimeout(uiState.landPollTimer);
    }
    if (uiState.commandElapsedTimer) {
      window.clearInterval(uiState.commandElapsedTimer);
    }
    if (uiState.originMainStatusRetryTimer) {
      window.clearTimeout(uiState.originMainStatusRetryTimer);
    }
  }

  function sendCloseSignal() {
    if (closeSignalSent) {
      return;
    }

    closeSignalSent = true;
    const payload = getClientPayload();

    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/close",
        new Blob([payload], { type: "application/json" }),
      );
      return;
    }

    fetch("/api/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    });
  }

  function sendHeartbeat() {
    return fetch("/api/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: getClientPayload(),
      keepalive: true,
    }).catch(() => {});
  }

  function showServerStopped(reason = "") {
    document.title = "Thunderbird Desktop Console stopped";
    document.body.classList.add("server-stopped");
    document.body.replaceChildren();

    const message = document.createElement("main");
    const title = document.createElement("h1");
    const detail = document.createElement("p");

    title.textContent = "Thunderbird Desktop Console stopped";
    detail.textContent = reason || "The local console server has shut down.";
    message.className = "server-stopped-message";
    message.append(title, detail);
    document.body.append(message);
  }

  async function listenForServerShutdown() {
    while (!closeSignalSent) {
      try {
        const response = await fetch(
          "/api/shutdown-events?token=" + encodeURIComponent(INTERACTIVE.token) +
            "&clientId=" + encodeURIComponent(clientId),
          { cache: "no-store" },
        );
        const result = await response.json();

        if (!response.ok) {
          return;
        }

        if (!result.closing) {
          continue;
        }

        closeSignalSent = true;
        clearInteractiveTimers();

        if (result.closeTabs && INTERACTIVE.closeTabsOnShutdown !== false) {
          window.close();
          window.setTimeout(() => showServerStopped(result.reason), 250);
        } else {
          showServerStopped(result.reason);
        }
        return;
      } catch {
        return;
      }
    }
  }

  const heartbeat = setInterval(sendHeartbeat, 2000);
  const graphPoll = setInterval(pollGraphUpdates, INTERACTIVE.pollIntervalMs);
  const originMainStatusPoll = setInterval(
    refreshOriginMainStatus,
    Math.max(INTERACTIVE.pollIntervalMs, DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS),
  );

  sendHeartbeat();
  refreshOriginMainStatus();
  listenForServerShutdown();

  window.addEventListener(
    "pagehide",
    () => {
      clearInteractiveTimers();
      sendCloseSignal();
    },
    { once: true },
  );
}

restoreGraphPaneWidth(0);
renderGraph(0);
