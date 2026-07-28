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
import { showDiff } from "./commit-actions.js";

export function getLoadedGitCommitLimit(state) {
  const loadedGitCommits = state.commits.filter((commit) => !isWorkingTreeCommit(commit)).length;

  return Math.max(INTERACTIVE.pageSize, loadedGitCommits);
}

export function getSnapshotLimits() {
  return graphStates.map(getLoadedGitCommitLimit);
}

export function getUpdateActionLabel(mode) {
  return mode === "rebase" ? "Update and rebase" : "Update";
}

export function setUpdateBusy(busy) {
  document.querySelectorAll(".update-action, .mach-action, .graph-menu-command[data-menu-action='build'], .graph-menu-command[data-menu-action='lint-all'], .graph-menu-command[data-menu-action='lint-outgoing'], .graph-menu-command[data-menu-action='new-patch'], .graph-menu-command[data-menu-action='pull-patch'], .graph-menu-command[data-menu-action='test'], .graph-menu-command[data-menu-action='try'], .graph-menu-command[data-menu-action='land']").forEach((button) => {
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
  return hasActiveMachSession() ||
    hasActiveLintSession() ||
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
    output.textContent = text;

    if (hasOutput && uiState.machOutputVisible) {
      output.scrollTop = output.scrollHeight;
    }
  }
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

export function getOriginMainDisplayLabel(label) {
  const normalized = String(label || "").toLowerCase();

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
  const label = getOriginMainDisplayLabel(status && status.label);
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
    return getOriginMainDisplayLabel(status.label) + " origin/main local " + shortHash(status.localHash) +
      " remote " + shortHash(status.remoteHash);
  }

  return status.message || "";
}

export function renderOriginMainStatus(statuses) {
  const container = document.querySelector(".origin-main-status");

  if (!container) {
    return;
  }

  const items = Array.isArray(statuses) && statuses.length
    ? statuses
    : [{ label: "origin/main", state: "checking" }];
  uiState.rustUpstreamStatus = items.find((status) => status.type === "rust-upstream") || null;

  container.replaceChildren(...items.map((status) => {
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
  if (!INTERACTIVE.enabled || (uiState.originMainStatusLoading && !force)) {
    return;
  }

  uiState.originMainStatusLoading = true;

  try {
    const response = await fetch(
      "/api/origin-main-status?token=" + encodeURIComponent(INTERACTIVE.token) +
        (force ? "&force=1" : "")
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderOriginMainStatus(result.statuses);
    scheduleOriginMainStatusRetry(result.statuses || []);
    return result.statuses || [];
  } catch (error) {
    uiState.rustUpstreamStatus = null;
    renderOriginMainStatus([{
      label: "origin/main",
      state: "error",
      message: error && error.message ? error.message : String(error),
    }]);
    return [];
  } finally {
    uiState.originMainStatusLoading = false;
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
  await refreshOriginMainStatus({ force: true });

  const warning = getRustRemoteBuildWarning();
  if (!warning) {
    return true;
  }

  return confirm(warning + "\n\nRemote builds may fail. Continue with " + actionLabel + "?");
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

export function renderGraphMachSession(session) {
  uiState.activeMachSession = session;
  uiState.lastMachSession = session;
  setMachCancelButton(session);
  setMachOutputPanel(session);
  setUpdateStatus(getMachSessionStatusText(session), {
    error: session.status === "error",
    busy: session.status === "running",
  });

  if (session.status !== "running") {
    uiState.activeMachSession = null;
    setMachCancelButton(null);
  }
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
    setMachCancelButton(null);
    setMachOutputPanel();
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function startGraphMachAction(action) {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  if (uiState.machPollTimer) {
    window.clearTimeout(uiState.machPollTimer);
    uiState.machPollTimer = null;
  }

  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus(getMachActionLabel(action) + " starting...", { busy: true });

  try {
    const response = await fetch("/api/mach-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        action,
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
    setMachCancelButton(null);
    setMachOutputPanel();
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveMachSession()) {
      setUpdateBusy(false);
    }
  }
}

export async function cancelGraphMachAction() {
  if (!uiState.activeMachSession) {
    return;
  }

  const sessionId = uiState.activeMachSession.id;
  const cancelButton = document.querySelector(".mach-cancel");

  if (cancelButton) {
    cancelButton.disabled = true;
  }

  setUpdateStatus(isMachRunSession(uiState.activeMachSession) ? "Closing run..." : "Canceling build...", { busy: true });

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
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveMachSession()) {
      setUpdateBusy(false);
    }
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
    alert("A command is already active.");
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

export function openTryDialog() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
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
    alert("A command is already active.");
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
        snapshotLimit: getLoadedGitCommitLimit(graphStates[0]),
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
  if (hasActiveCommandSession()) {
    return;
  }

  const answer = window.prompt(
    "Update complete. Type 'build' to build, type 'run' to build and run, or leave blank to skip.",
    ""
  );

  if (answer === null || !answer.trim()) {
    return;
  }

  const normalized = answer.trim().toLowerCase();

  if (normalized === "build") {
    await startGraphMachAction("build");
    return;
  }

  if (normalized === "run" || normalized === "build-run") {
    await startGraphMachAction("run");
    return;
  }

  alert("Use 'build', 'run', or leave it blank.");
}

export function formatDirtyCheckoutList(dirty) {
  return dirty
    .map((item) => item.label + " (" + item.path + ")")
    .join(", ");
}

export function promptForDirtyUpdateAction(dirty) {
  const answer = window.prompt(
    "Uncommitted changes were found in " + formatDirtyCheckoutList(dirty) + ". Type 'shelf' to temporarily stash them for the update, type 'amend' to amend them into the current commit, or leave blank to cancel.",
    "shelf"
  );

  if (answer === null || !answer.trim()) {
    return "";
  }

  const normalized = answer.trim().toLowerCase();

  if (normalized === "stash" || normalized === "shelve") {
    return "shelf";
  }

  if (normalized === "shelf" || normalized === "amend") {
    return normalized;
  }

  alert("Use 'shelf' or 'amend'.");
  return "";
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

export async function runGraphUpdate(mode, dirtyAction = "") {
  setUpdateStatus(getUpdateActionLabel(mode) + " running...", { busy: true });

  try {
    const response = await fetch("/api/update-graphs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        mode,
        dirtyAction,
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      if (!dirtyAction && Array.isArray(result.dirty) && result.dirty.length) {
        const nextDirtyAction = promptForDirtyUpdateAction(result.dirty);

        if (nextDirtyAction) {
          await runGraphUpdate(mode, nextDirtyAction);
        } else {
          setUpdateStatus(getUpdateActionLabel(mode) + " canceled.");
        }
        return;
      }

      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    await refreshOriginMainStatus({ force: true });
    setUpdateStatus(result.message || getUpdateActionLabel(mode) + " complete.");

    if (Array.isArray(result.shelves) && result.shelves.length) {
      const shouldUnshelf = confirm("Unshelf " + result.shelves.length + " shelved checkout" + (result.shelves.length === 1 ? "" : "s") + " now?");

      if (shouldUnshelf) {
        await unshelfGraphUpdateChanges(result.shelves);
      }
    }

    await promptForPostUpdateMachAction();
  } catch (error) {
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveMachSession()) {
      setUpdateBusy(false);
    }
  }
}

export function resetRenderedGraph(index) {
  const state = graphStates[index];

  state.rendered = false;
  getGraphContainer(index).replaceChildren();
}

export function applyGraphSnapshot(index, snapshot, { force = false } = {}) {
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

  if (selectedCommit) {
    showDiff(state.graph, index, selectedCommit);
  } else {
    clearDiffSelection(index, "Graph updated. The selected commit is no longer loaded.");
  }

  return true;
}

export async function refreshGraphFromServer(index, { force = false } = {}) {
  const state = graphStates[index];

  if (!INTERACTIVE.enabled || state.loading || state.refreshing || state.graph.error) {
    return false;
  }

  state.refreshing = true;

  try {
    const response = await fetch(
      "/api/graph/" + index + "/snapshot?limit=" + getLoadedGitCommitLimit(state) +
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
