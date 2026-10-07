import { setLiveText, hasSelectedText } from "./live-text.js";
import {
  INTERACTIVE,
  graphStates,
  tryDialog,
  tryQueryField,
  trySelector,
  tryStatus,
  tryTasksField,
  uiState,
} from "./config.js";
import {
  getCurrentCommitHash,
  getSnapshotFingerprint,
  isWorkingTreeCommit,
  placeWorkingTreeCommits,
} from "./commit-model.js";
import { getGraphContainer, setGraphSummary } from "./dom.js";
import {
  renderLoadedGraph,
  setGraphStatus,
} from "./lane-renderer.js";
import {
  clearDiffSelection,
  loadSelectedCommitIntegrationStatus,
} from "./diff-viewer.js";
import {
  showSystemChoice,
  showSystemConfirmation,
  showSystemNotice,
} from "./system-dialog.js";
import { openRebaseFailureDialog } from "./rebase-dialog.js";

export function getLoadedGitCommitLimit(state) {
  const loadedGitCommits = state.commits.filter((commit) => !isWorkingTreeCommit(commit)).length;

  return Math.max(INTERACTIVE.pageSize, loadedGitCommits);
}

export function getSnapshotLimits() {
  return graphStates.map(getLoadedGitCommitLimit);
}

export function getActiveGraphIndex() {
  const index = Number(document.querySelector(".panel.active")?.dataset.index);

  return Number.isInteger(index) ? index : 0;
}

export function getUpdateActionLabel(mode) {
  return mode === "rebase" ? "Rebase" : "Pull";
}

export function setUpdateBusy(busy) {
  document.querySelectorAll(".update-action, .mach-action, .graph-menu-command[data-menu-action='build'], .graph-menu-command[data-menu-action='commit'], .graph-menu-command[data-menu-action='lint-all'], .graph-menu-command[data-menu-action='lint-outgoing'], .graph-menu-command[data-menu-action='new-patch'], .graph-menu-command[data-menu-action='pull-patch'], .graph-menu-command[data-menu-action='test'], .graph-menu-command[data-menu-action='try'], .graph-menu-command[data-menu-action='land'], .graph-menu-command[data-menu-action='review-sync']").forEach((button) => {
    button.disabled = busy;
  });
}

export function setGraphOptionsMenuOpen(open) {
  const button = document.querySelector(".graph-menu-button");
  const menu = document.querySelector(".graph-options-menu");

  if (!button || !menu) {
    return;
  }

  menu.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");

  if (!open) {
    document.querySelectorAll(".graph-menu-submenu.open").forEach((submenu) => {
      submenu.classList.remove("open");
    });
    document.querySelectorAll(".graph-submenu-trigger").forEach((trigger) => {
      trigger.setAttribute("aria-expanded", "false");
    });
  }
}

export function closeGraphOptionsMenu() {
  setGraphOptionsMenuOpen(false);
}

export function toggleGraphSubmenu(trigger) {
  const submenu = trigger.closest(".graph-menu-submenu");

  if (!submenu) {
    return;
  }

  const open = !submenu.classList.contains("open");
  document.querySelectorAll(".graph-menu-submenu.open").forEach((item) => {
    item.classList.remove("open");
  });
  document.querySelectorAll(".graph-submenu-trigger").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });

  submenu.classList.toggle("open", open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
}

export function hasActiveMachSession() {
  return Boolean(uiState.activeMachSession && uiState.activeMachSession.status === "running");
}

export function hasActiveTrySession() {
  return Boolean(uiState.activeTrySession && uiState.activeTrySession.status === "running");
}

export function hasActiveLintSession() {
  return Boolean(uiState.activeLintSession && uiState.activeLintSession.status === "running");
}

export function hasActiveTestSession() {
  return Boolean(uiState.activeTestSession && uiState.activeTestSession.status === "running");
}

export function hasActivePatchSession() {
  return Boolean(
    uiState.activePatchSession &&
    (uiState.activePatchSession.status === "running" || uiState.activePatchSession.status === "prompt")
  );
}

export function hasActiveNewPatchSession() {
  return Boolean(uiState.activeNewPatchSession && uiState.activeNewPatchSession.status === "running");
}

export function hasActiveLandSession() {
  return Boolean(
    uiState.activeLandSession &&
    (uiState.activeLandSession.status === "running" || uiState.activeLandSession.status === "prompt")
  );
}

export function hasActiveCommandSession() {
  return hasActiveLintSession() ||
    hasActiveTestSession() ||
    hasActiveNewPatchSession() ||
    hasActivePatchSession() ||
    hasActiveTrySession() ||
    hasActiveLandSession();
}

export function isMachRunSession(session) {
  return Boolean(session && session.phase === "running");
}

export function getMachCancelLabel(session) {
  return isMachRunSession(session) ? "Close" : "Cancel Build";
}

export function setMachCancelButton(session) {
  const button = document.querySelector(".mach-cancel");

  if (!button) {
    return;
  }

  const canCancel = Boolean(session && session.canCancel);
  button.hidden = !canCancel;
  button.disabled = false;

  if (canCancel) {
    button.textContent = getMachCancelLabel(session);
  }
}

export function setMachOutputPanel(session = uiState.lastMachSession) {
  const toggle = document.querySelector(".mach-output-toggle");
  const panel = document.querySelector(".mach-output-panel");
  const output = document.querySelector(".mach-output");
  const text = session && session.output ? session.output : "";
  const hasOutput = Boolean(text);

  if (toggle) {
    toggle.hidden = !hasOutput;
    toggle.textContent = uiState.machOutputVisible ? "Hide" : "Output";
    toggle.setAttribute("aria-expanded", hasOutput && uiState.machOutputVisible ? "true" : "false");
  }

  if (panel) {
    panel.hidden = !hasOutput || !uiState.machOutputVisible;
  }

  if (output) {
    setLiveText(output, text);

    if (hasOutput && uiState.machOutputVisible) {
      if (!hasSelectedText(output)) output.scrollTop = output.scrollHeight;
    }
  }
}

function clearCommandStatusOutput() {
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
}

function setCommandStatusOutputFromResult(result) {
  uiState.lastMachSession = result?.output ? { output: result.output } : null;
  setMachOutputPanel(uiState.lastMachSession);
}

export function formatCommandElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours) {
    return hours + ":" + String(minutes).padStart(2, "0") + ":" + paddedSeconds;
  }

  return minutes + ":" + paddedSeconds;
}

export function updateCommandElapsed() {
  const elapsed = document.querySelector(".command-elapsed");

  if (!elapsed) {
    return;
  }

  elapsed.textContent = uiState.commandStatusStartedAt
    ? formatCommandElapsed(Date.now() - uiState.commandStatusStartedAt)
    : "";
}

export function setCommandStatusBarActive(active, { visible = active } = {}) {
  const statusBar = document.querySelector(".command-status-bar");
  const shouldShow = visible || active;

  document.body.classList.toggle("has-command-status", shouldShow);

  if (statusBar) {
    statusBar.hidden = !shouldShow;
  }

  if (active) {
    if (!uiState.commandElapsedTimer) {
      uiState.commandStatusStartedAt = Date.now();
      updateCommandElapsed();
      uiState.commandElapsedTimer = window.setInterval(updateCommandElapsed, 1000);
    }

    return;
  }

  if (uiState.commandElapsedTimer) {
    window.clearInterval(uiState.commandElapsedTimer);
    uiState.commandElapsedTimer = null;
    updateCommandElapsed();
  }

  if (!shouldShow) {
    uiState.commandStatusStartedAt = 0;
    updateCommandElapsed();
  }
}

export function dismissCommandStatus() {
  uiState.machOutputVisible = false;
  setMachOutputPanel();
  setUpdateStatus("");
}

export function setUpdateStatus(message, { error = false, busy = false } = {}) {
  const status = document.querySelector(".update-status");
  const statusBar = document.querySelector(".command-status-bar");
  const closeButton = document.querySelector(".command-status-close");
  const hasMessage = Boolean(message);
  const visible = busy || hasMessage;

  setUpdateBusy(busy);
  setCommandStatusBarActive(busy, { visible });

  if (statusBar) {
    statusBar.classList.toggle("busy", busy);
    statusBar.classList.toggle("error", error && visible);
    statusBar.classList.toggle("has-message", hasMessage);
  }

  if (closeButton) {
    closeButton.hidden = busy || !visible;
  }

  if (!status) {
    return;
  }

  status.classList.toggle("error", error && visible);
  status.hidden = !hasMessage;
  status.textContent = hasMessage ? message : "";
}

export function shortHash(hash) {
  return hash ? String(hash).slice(0, 12) : "unknown";
}

export function getOriginMainDisplayLabel(statusOrLabel) {
  const status = typeof statusOrLabel === "object" ? statusOrLabel : null;
  const label = status ? status.label : statusOrLabel;
  const normalized = String(status?.repository || label || "").toLowerCase();

  if (normalized === "rust" || normalized === "rust-upstream") {
    return "Rust deps";
  }

  if (normalized === "comm") {
    return "Thunderbird";
  }

  if (normalized === "firefox") {
    return "Firefox";
  }

  return label || "origin/main";
}

export function getOriginMainBadgeText(status) {
  const label = getOriginMainDisplayLabel(status);
  const isRustStatus = status && status.type === "rust-upstream";

  if (!status || status.state === "checking") {
    return label + ": checking";
  }

  if (status.state === "current") {
    return label + ": current";
  }

  if (isRustStatus && status.state === "warning") {
    return label + ": out of sync";
  }

  if (status.state === "stale") {
    return label + ": needs fetch";
  }

  return label + ": unknown";
}

export function getOriginMainBadgeTitle(status) {
  if (!status) {
    return "";
  }

  if (status.type === "rust-upstream") {
    const mismatches = Array.isArray(status.mismatches) && status.mismatches.length
      ? " Mismatched files: " + status.mismatches.map((item) => item.file).join(", ") + "."
      : "";
    const hashes = status.commLocalHash && status.firefoxRemoteHash
      ? " Thunderbird origin/main " + shortHash(status.commLocalHash) +
        " Firefox remote " + shortHash(status.firefoxRemoteHash) + "."
      : "";

    return (status.message || "") + hashes + mismatches;
  }

  if (status.state === "current" || status.state === "stale") {
    return getOriginMainDisplayLabel(status) + " origin/main local " + shortHash(status.localHash) +
      " remote " + shortHash(status.remoteHash);
  }

  return status.message || "";
}

export function renderOriginMainStatus(statuses) {
  const container = document.querySelector(".origin-main-status");

  if (!container) {
    return;
  }

  const hasStatuses = Array.isArray(statuses) && statuses.length;
  const items = hasStatuses
    ? statuses
    : [
      ...graphStates
        .filter(({ graph }) => (graph.checkout || "working") === uiState.checkoutMode)
        .map(({ graph }) => ({
          label: graph.label,
          repository: graph.repository,
          checkout: graph.checkout,
          state: "checking",
        })),
      {
        label: "rust",
        type: "rust-upstream",
        checkout: uiState.checkoutMode,
        state: "checking",
      },
    ];
  uiState.originMainStatuses = hasStatuses ? statuses : [];
  uiState.rustUpstreamStatus = hasStatuses
    ? items.find((status) => (
      status.type === "rust-upstream" &&
      (!status.checkout || status.checkout === uiState.checkoutMode)
    )) || null
    : null;
  const visibleItems = items.filter((status) => {
    if (status.type === "rust-upstream") {
      return !status.checkout || status.checkout === uiState.checkoutMode;
    }

    return !status.checkout || status.checkout === uiState.checkoutMode;
  });

  container.replaceChildren(...visibleItems.map((status) => {
    const badge = document.createElement("span");
    const state = status.state || "error";

    badge.className = "origin-main-badge " + state;
    badge.textContent = getOriginMainBadgeText(status);
    badge.title = getOriginMainBadgeTitle(status);
    return badge;
  }));
}

export function hasCheckingOriginMainStatus(statuses = []) {
  return statuses.some((status) => status && status.state === "checking");
}

export function scheduleOriginMainStatusRetry(statuses = []) {
  if (!hasCheckingOriginMainStatus(statuses) || uiState.originMainStatusRetryTimer) {
    return;
  }

  uiState.originMainStatusRetryTimer = window.setTimeout(() => {
    uiState.originMainStatusRetryTimer = null;
    refreshOriginMainStatus();
  }, 1000);
}

export async function refreshOriginMainStatus({ force = false } = {}) {
  if (!INTERACTIVE.enabled) {
    return;
  }

  if (uiState.originMainStatusLoading) {
    uiState.originMainStatusRefreshQueued = true;
    return;
  }

  uiState.originMainStatusLoading = true;
  const checkout = uiState.checkoutMode;

  try {
    const response = await fetch(
      "/api/origin-main-status?token=" + encodeURIComponent(INTERACTIVE.token) +
        "&checkout=" + encodeURIComponent(checkout) +
        (force ? "&force=1" : "")
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    if (checkout !== uiState.checkoutMode) {
      return result.statuses || [];
    }

    renderOriginMainStatus(result.statuses);
    scheduleOriginMainStatusRetry(result.statuses || []);
    return result.statuses || [];
  } catch (error) {
    if (checkout !== uiState.checkoutMode) {
      return [];
    }

    uiState.rustUpstreamStatus = null;
    renderOriginMainStatus([{
      label: "origin/main",
      state: "error",
      message: error && error.message ? error.message : String(error),
    }]);
    return [];
  } finally {
    uiState.originMainStatusLoading = false;

    if (
      uiState.originMainStatusRefreshQueued ||
      checkout !== uiState.checkoutMode
    ) {
      uiState.originMainStatusRefreshQueued = false;
      void refreshOriginMainStatus();
    }
  }
}

export function getRustRemoteBuildWarning(status = uiState.rustUpstreamStatus) {
  if (!status || status.type !== "rust-upstream") {
    return "";
  }

  if (status.state === "error") {
    return status.message
      ? "Rust dependency status could not be checked: " + status.message
      : "Rust dependency status could not be checked.";
  }

  if (status.state === "checking") {
    return "Rust dependency status is still checking.";
  }

  if (status.state !== "warning") {
    return "";
  }

  const files = Array.isArray(status.mismatches) && status.mismatches.length
    ? "\n\nMismatched files:\n" + status.mismatches.map((item) => "- " + item.file).join("\n")
    : "";

  return (status.message || "Rust dependencies are out of sync with Firefox remote main.") + files;
}

export async function confirmRemoteBuildRustWarning(actionLabel) {
  const warning = getRustRemoteBuildWarning();
  if (!warning) {
    return true;
  }

  return showSystemConfirmation({
    title: "Rust dependencies are out of date",
    message: warning + "\n\nRemote builds may fail. Continue with " + actionLabel + "?",
    confirmLabel: "Continue",
  });
}

export function getMachActionLabel(action) {
  if (action === "build") {
    return "Build";
  }

  if (action === "run") {
    return "Run";
  }

  if (action === "build-run") {
    return "Build and run";
  }

  return "Mach action";
}

export function getMachSessionStatusText(session) {
  if (session.message) {
    return session.message;
  }

  return getMachActionLabel(session.action) + (session.status === "running" ? " running..." : "");
}

function renderMachStatus(session) {
  let panel = document.querySelector(".build-status");
  if (!panel) {
    panel = document.createElement("section");
    panel.className = "build-status";
    panel.setAttribute("aria-label", "Build and run status");
    panel.innerHTML = `<span class="build-status-message" role="status"></span>
      <button class="build-cancel" type="button">Cancel Build</button>
      <button class="build-dismiss" type="button" hidden>Dismiss</button>
      <details><summary>Build output</summary><pre class="build-output"></pre></details>`;
    document.querySelector(".command-status-bar")?.before(panel);
    panel.querySelector(".build-cancel").addEventListener("click", () => void cancelGraphMachAction());
    panel.querySelector(".build-dismiss").addEventListener("click", () => { panel.hidden = true; });
  }
  panel.hidden = false;
  panel.querySelector(".build-status-message").textContent = session.message || "";
  const cancel = panel.querySelector(".build-cancel");
  cancel.hidden = !session.canCancel;
  cancel.disabled = false;
  cancel.textContent = getMachCancelLabel(session);
  panel.querySelector(".build-dismiss").hidden = session.status === "running";
  panel.querySelector(".build-output").textContent = session.output || "";
}

export function renderGraphMachSession(session) {
  uiState.activeMachSession = session.status === "running" ? session : null;
  renderMachStatus(session);
}

export async function pollGraphMachSession() {
  if (!uiState.activeMachSession) {
    return;
  }

  try {
    const response = await fetch(
      "/api/mach-action/" + encodeURIComponent(uiState.activeMachSession.id) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphMachSession(result);

    if (result.status === "running") {
      uiState.machPollTimer = window.setTimeout(pollGraphMachSession, 500);
    }
  } catch (error) {
    uiState.activeMachSession = null;
    renderMachStatus({ status: "error", message: error && error.message ? error.message : String(error) });
  }
}

export async function startGraphMachAction(action) {
  if (hasActiveMachSession()) {
    await showSystemNotice({
      title: "Build or run already active",
      message: "Wait for the current command to finish or cancel it before starting another one.",
    });
    return;
  }

  if (uiState.machPollTimer) {
    window.clearTimeout(uiState.machPollTimer);
    uiState.machPollTimer = null;
  }

  renderMachStatus({ message: getMachActionLabel(action) + " starting...", status: "running" });

  try {
    const response = await fetch("/api/mach-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        action,
        graphIndex: getActiveGraphIndex(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphMachSession(result);

    if (result.status === "running") {
      uiState.machPollTimer = window.setTimeout(pollGraphMachSession, 500);
    }
  } catch (error) {
    uiState.activeMachSession = null;
    renderMachStatus({ ...uiState.activeMachSession, status: "error", message: error && error.message ? error.message : String(error) });
  }
}

export async function cancelGraphMachAction() {
  if (!uiState.activeMachSession) {
    return;
  }

  const sessionId = uiState.activeMachSession.id;
  const cancelButton = document.querySelector(".build-cancel");

  if (cancelButton) {
    cancelButton.disabled = true;
  }

  renderMachStatus({ ...uiState.activeMachSession, canCancel: false, message: isMachRunSession(uiState.activeMachSession) ? "Closing run..." : "Canceling build..." });

  try {
    const response = await fetch("/api/mach-action/" + encodeURIComponent(sessionId) + "/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: INTERACTIVE.token }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphMachSession(result);

    if (result.status === "running") {
      uiState.machPollTimer = window.setTimeout(pollGraphMachSession, 500);
    }
  } catch (error) {
    renderMachStatus({ ...uiState.activeMachSession, status: "error", message: error && error.message ? error.message : String(error) });
  }
}

export function getLintActionLabel(mode) {
  return mode === "all" ? "Lint all" : "Lint changed files";
}

export function getLintSessionStatusText(session) {
  if (session.message) {
    return session.message;
  }

  return getLintActionLabel(session.mode) + (session.status === "running" ? " running..." : "");
}

export function renderGraphLintSession(session) {
  uiState.activeLintSession = session.status === "running" ? session : null;
  uiState.lastMachSession = session;
  setMachCancelButton(null);
  setMachOutputPanel(session);
  setUpdateStatus(getLintSessionStatusText(session), {
    error: session.status === "error",
    busy: session.status === "running",
  });
}

export async function pollGraphLintSession() {
  if (!uiState.activeLintSession) {
    return;
  }

  try {
    const response = await fetch(
      "/api/lint/" + encodeURIComponent(uiState.activeLintSession.id) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphLintSession(result);

    if (result.status === "running") {
      uiState.lintPollTimer = window.setTimeout(pollGraphLintSession, 500);
    }
  } catch (error) {
    uiState.activeLintSession = null;
    setMachOutputPanel();
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function startGraphLintAction(mode) {
  if (hasActiveCommandSession()) {
    await showSystemNotice({
      title: "Command already active",
      message: "Wait for the current command to finish or cancel it before starting another one.",
    });
    return;
  }

  const normalizedMode = mode === "all" ? "all" : "outgoing";

  if (uiState.lintPollTimer) {
    window.clearTimeout(uiState.lintPollTimer);
    uiState.lintPollTimer = null;
  }

  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus(getLintActionLabel(normalizedMode) + " starting...", { busy: true });

  try {
    const response = await fetch("/api/lint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        mode: normalizedMode,
        graphIndex: getActiveGraphIndex(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphLintSession(result);

    if (result.status === "running") {
      uiState.lintPollTimer = window.setTimeout(pollGraphLintSession, 500);
    }
  } catch (error) {
    uiState.activeLintSession = null;
    setMachCancelButton(null);
    setMachOutputPanel();
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveLintSession()) {
      setUpdateBusy(false);
    }
  }
}

export function updateTryDialogFields() {
  const selector = trySelector.value;

  tryQueryField.hidden = selector !== "fuzzy";
  tryTasksField.hidden = selector !== "auto";
}

export function setTryDialogBusy(busy) {
  tryDialog.querySelectorAll("input, select, button").forEach((field) => {
    field.disabled = busy;
  });
}

export function getTryDialogOptions() {
  return {
    selector: tryDialog.querySelector(".try-selector").value,
    query: tryDialog.querySelector(".try-query").value,
    "tasks-regex": tryDialog.querySelector(".try-tasks-regex").value,
    preset: tryDialog.querySelector(".try-preset").value,
    artifact: tryDialog.querySelector(".try-artifact").checked,
    comment: tryDialog.querySelector(".try-comment").checked,
  };
}

export async function openTryDialog() {
  if (hasActiveCommandSession()) {
    await showSystemNotice({
      title: "Command already active",
      message: "Wait for the current command to finish or cancel it before starting another one.",
    });
    return;
  }

  tryStatus.classList.remove("error");
  tryStatus.textContent = "This will submit the current comm checkout state.";
  setTryDialogBusy(false);
  updateTryDialogFields();
  tryDialog.showModal();
  trySelector.focus();
}

export function getTrySessionStatusText(session) {
  if (session.tryRun && session.tryRun.url) {
    return "Try run submitted: " + session.tryRun.url;
  }

  return session.message || (session.status === "running" ? "Try run running..." : "Try run complete.");
}

export function renderGraphTrySession(session) {
  uiState.activeTrySession = session.status === "running" ? session : null;
  uiState.lastMachSession = session;
  setMachCancelButton(null);
  setMachOutputPanel(session);
  setUpdateStatus(getTrySessionStatusText(session), {
    error: session.status === "error",
    busy: session.status === "running",
  });

  if (session.status === "complete" && session.snapshot) {
    applyGraphSnapshot(session.graphIndex, session.snapshot, { force: true });
    const state = graphStates[session.graphIndex];

    if (state && state.selectedHash) {
      const commit = state.commits.find((item) => item.hash === state.selectedHash);
      const viewer = document.getElementById("diff-" + session.graphIndex);
      const integrationStatus = viewer && viewer.querySelector(".integration-status");

      if (commit && integrationStatus) {
        loadSelectedCommitIntegrationStatus(session.graphIndex, commit, integrationStatus);
      }
    }
  }
}

export async function pollGraphTrySession() {
  if (!uiState.activeTrySession) {
    return;
  }

  try {
    const response = await fetch(
      "/api/try/" + encodeURIComponent(uiState.activeTrySession.id) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphTrySession(result);

    if (result.status === "running") {
      uiState.tryPollTimer = window.setTimeout(pollGraphTrySession, 500);
    }
  } catch (error) {
    uiState.activeTrySession = null;
    setMachOutputPanel();
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function submitTryDialog(event) {
  event.preventDefault();

  if (hasActiveCommandSession()) {
    await showSystemNotice({
      title: "Command already active",
      message: "Wait for the current command to finish or cancel it before starting another one.",
    });
    return;
  }

  if (!await confirmRemoteBuildRustWarning("the try run")) {
    return;
  }

  if (uiState.tryPollTimer) {
    window.clearTimeout(uiState.tryPollTimer);
    uiState.tryPollTimer = null;
  }

  setTryDialogBusy(true);
  tryStatus.classList.remove("error");
  tryStatus.textContent = "Starting try run...";
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("Try run starting...", { busy: true });

  try {
    const response = await fetch("/api/try", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options: getTryDialogOptions(),
        graphIndex: getActiveGraphIndex(),
        snapshotLimit: getLoadedGitCommitLimit(
          graphStates[getActiveGraphIndex()],
        ),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    tryDialog.close();
    renderGraphTrySession(result);

    if (result.status === "running") {
      uiState.tryPollTimer = window.setTimeout(pollGraphTrySession, 500);
    }
  } catch (error) {
    tryStatus.classList.add("error");
    tryStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    setTryDialogBusy(false);
    if (!hasActiveTrySession()) {
      setUpdateBusy(false);
    }
  }
}

export async function promptForPostUpdateMachAction() {
  if (hasActiveMachSession() || hasActiveCommandSession()) {
    return;
  }

  const answer = await showSystemChoice({
    title: "Update complete",
    message: "Choose what to do next.",
    choices: [
      {
        value: "build",
        label: "Build",
        description: "Build Thunderbird without starting it.",
      },
      {
        value: "run",
        label: "Build and run",
        description: "Build Thunderbird, then start it.",
      },
    ],
    cancelLabel: "Skip",
  });

  if (!answer) {
    return;
  }

  if (answer === "build") {
    await startGraphMachAction("build");
    return;
  }

  if (answer === "run") {
    await startGraphMachAction("run");
    return;
  }

}

export function formatDirtyCheckoutList(dirty) {
  return dirty
    .map((item) => {
      const files = Array.isArray(item.files) ? item.files : [];
      const visibleFiles = files.slice(0, 5);
      const remaining = files.length - visibleFiles.length;
      const detail = visibleFiles.length
        ? "\n  " + visibleFiles.join("\n  ") +
          (remaining ? "\n  ... and " + remaining + " more" : "")
        : "";

      return item.label + " (" + item.path + ")" + detail;
    })
    .join("\n\n");
}

function refreshDirtyCheckoutGraphs(dirty) {
  for (const item of dirty) {
    const index = Number(item?.index);
    const state = graphStates[index];

    if (!state) {
      continue;
    }

    const loadedGitCommits = state.commits.filter(
      (commit) => !isWorkingTreeCommit(commit),
    ).length;
    void refreshGraphFromServer(index, {
      force: true,
      limit: Math.max(1, loadedGitCommits),
    });
  }
}

export async function promptForDirtyUpdateAction(dirty) {
  refreshDirtyCheckoutGraphs(dirty);
  return showSystemChoice({
    title: "Uncommitted changes found",
    message: formatDirtyCheckoutList(dirty) +
      "\n\nThe matching Uncommitted changes row is being refreshed in the affected Tree. Choose how to proceed with the update.",
    choices: [
      {
        value: "shelf",
        label: "Shelf changes",
        description: "Temporarily stash changes, then restore them after the update.",
      },
      {
        value: "amend",
        label: "Amend current commit",
        description: "Include changes in the checked-out commit before updating.",
      },
      {
        value: "discard",
        label: "Discard working changes",
        description: "Hard reset to HEAD and remove untracked files. This cannot be undone.",
      },
    ],
    cancelLabel: "Cancel update",
  });
}

export function applyGraphSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) {
    return;
  }

  snapshots.forEach((snapshot, index) => {
    if (snapshot) {
      applyGraphSnapshot(index, snapshot, { force: true });
    }
  });
}

export async function unshelfGraphUpdateChanges(shelves) {
  clearCommandStatusOutput();
  setUpdateStatus("Unshelving changes...", { busy: true });

  try {
    const response = await fetch("/api/unshelf-graphs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        shelves,
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    setCommandStatusOutputFromResult(result);

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    await refreshOriginMainStatus({ force: true });
    setUpdateStatus(result.message || "Unshelved changes.");
  } catch (error) {
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    setUpdateBusy(false);
  }
}

export async function readGraphUpdateResponse(response) {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    return response.json();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result;
  const readEvent = (line) => {
    if (!line.trim()) {
      return;
    }
    const event = JSON.parse(line);
    if (event.type === "output") {
      setCommandStatusOutputFromResult(event);
    } else if (event.type === "status") {
      setUpdateStatus(event.message, { busy: true });
    } else if (event.type === "result") {
      result = event;
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
  if (!result) {
    throw new Error("The connection closed before the update finished.");
  }
  return result;
}

export async function runGraphUpdate(
  mode,
  dirtyAction = "",
  scope = "current",
  graphIndex = getActiveGraphIndex(),
) {
  clearCommandStatusOutput();
  setUpdateStatus(getUpdateActionLabel(mode) + " running...", { busy: true });

  try {
    const response = await fetch("/api/update-graphs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        stream: true,
        mode,
        dirtyAction,
        scope,
        graphIndex,
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await readGraphUpdateResponse(response);

    setCommandStatusOutputFromResult(result);

    if (!response.ok || result.ok === false) {
      if (result.rebaseConflict) {
        openRebaseFailureDialog(result.rebaseConflict, {
          fallbackMessage: result.error || response.statusText,
        });
        setUpdateStatus("Rebase paused for conflicts.", { error: true });
        return;
      }

      if (!dirtyAction && Array.isArray(result.dirty) && result.dirty.length) {
        const nextDirtyAction = await promptForDirtyUpdateAction(result.dirty);

        if (nextDirtyAction) {
          await runGraphUpdate(mode, nextDirtyAction, scope, graphIndex);
        } else {
          setUpdateStatus(getUpdateActionLabel(mode) + " canceled.");
        }
        return;
      }

      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    setUpdateStatus(result.message || getUpdateActionLabel(mode) + " complete.");
    void refreshOriginMainStatus({ force: true });

    if (Array.isArray(result.shelves) && result.shelves.length) {
      const shouldUnshelf = await showSystemConfirmation({
        title: "Restore shelved changes",
        message: "Unshelf " + result.shelves.length + " shelved checkout" +
          (result.shelves.length === 1 ? "" : "s") + " now?",
        confirmLabel: "Unshelf",
      });

      if (shouldUnshelf) {
        await unshelfGraphUpdateChanges(result.shelves);
      }
    }

    await promptForPostUpdateMachAction();
  } catch (error) {
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    setUpdateBusy(false);
  }
}

export function resetRenderedGraph(index) {
  const state = graphStates[index];

  state.rendered = false;
  getGraphContainer(index).replaceChildren();
}

export function applyGraphSnapshot(index, snapshot, { force = false } = {}) {
  if (snapshot.taskWorktree) {
    void refreshGraphFromServer(index, { force: true }).catch(error => console.error("Could not refresh the repository graph:", error));
    return false;
  }
  const state = graphStates[index];
  const nextSignature = getSnapshotFingerprint(snapshot);

  if (!force && state.snapshotSignature === nextSignature) {
    return false;
  }

  const previousSelectedHash = state.selectedHash;
  state.graph.label = snapshot.label || state.graph.label;
  state.graph.path = snapshot.path || state.graph.path;
  state.graph.branch = snapshot.branch || "";
  state.graph.commitCount = snapshot.commitCount || 0;
  state.graph.workingTreeCount = snapshot.workingTreeCount || 0;
  state.graph.diffs = {};
  state.commits = placeWorkingTreeCommits(snapshot.commits || []);
  state.graph.commits = state.commits;
  state.offset = snapshot.nextOffset || state.commits.length;
  state.hasMore = Boolean(snapshot.hasMore);
  state.workingTreeCount = snapshot.workingTreeCount || 0;
  state.currentHash = getCurrentCommitHash(state.commits);
  state.snapshotSignature = nextSignature;
  setGraphSummary(index);
  resetRenderedGraph(index);
  renderLoadedGraph(index);

  if (!previousSelectedHash) {
    return true;
  }

  const selectedCommit = state.commits.find((commit) => commit.hash === previousSelectedHash);

  if (!selectedCommit) {
    clearDiffSelection(index, "Graph updated. The selected commit is no longer loaded.");
  } else if (selectedCommit.tryRuns?.some(run => run.monitorId)) {
    const container = document.getElementById("diff-" + index)?.querySelector(".integration-status");
    if (container) void loadSelectedCommitIntegrationStatus(index, selectedCommit, container);
  }

  return true;
}

export async function refreshGraphFromServer(index, {
  force = false,
  limit = 0,
} = {}) {
  const state = graphStates[index];

  if (!INTERACTIVE.enabled || state.loading || state.refreshing || state.graph.error) {
    return false;
  }

  state.refreshing = true;

  try {
    const snapshotLimit = Number(limit) > 0
      ? Math.max(1, Number(limit))
      : getLoadedGitCommitLimit(state);
    const response = await fetch(
      "/api/graph/" + index + "/snapshot?limit=" +
        snapshotLimit +
        "&token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    return applyGraphSnapshot(index, result, { force });
  } catch (error) {
    setGraphStatus(index, error && error.message ? error.message : String(error), { error: true });
    return false;
  } finally {
    state.refreshing = false;
  }
}

export function pollGraphUpdates() {
  if (!INTERACTIVE.enabled) {
    return;
  }

  graphStates.forEach((state, index) => {
    if (state.rendered || state.commits.length) {
      refreshGraphFromServer(index);
    }
  });
}
