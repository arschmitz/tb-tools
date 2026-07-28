import {
  INTERACTIVE,
  newPatchBug,
  newPatchClose,
  newPatchDialog,
  newPatchForm,
  newPatchLinks,
  newPatchOutput,
  newPatchStatus,
  newPatchSubmit,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshots,
  getSnapshotLimits,
  hasActiveCommandSession,
  hasActiveNewPatchSession,
  setMachCancelButton,
  setMachOutputPanel,
  setUpdateBusy,
  setUpdateStatus,
} from "./command-sessions.js";

export function setNewPatchDialogBusy(busy) {
  newPatchForm.querySelectorAll("input").forEach((field) => {
    field.disabled = busy;
  });
  newPatchClose.disabled = false;
  newPatchClose.textContent = busy ? "Cancel" : "Close";
  newPatchSubmit.disabled = busy;
}

export function getNewPatchDialogOptions() {
  return {
    bugId: newPatchDialog.querySelector(".new-patch-bug").value,
    update: newPatchDialog.querySelector(".new-patch-update").checked,
  };
}

export function setNewPatchLinks(links = []) {
  newPatchLinks.replaceChildren();

  if (!links.length) {
    newPatchLinks.hidden = true;
    return;
  }

  for (const linkInfo of links) {
    const link = document.createElement("a");

    link.href = linkInfo.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = linkInfo.label || linkInfo.url;
    newPatchLinks.append(link);
  }

  newPatchLinks.hidden = false;
}

export function getNewPatchSessionStatusText(session) {
  if (session.status === "complete") {
    return session.message || "New patch created.";
  }

  if (session.status === "error") {
    return session.error || session.message || "New patch failed.";
  }

  if (session.status === "canceled") {
    return session.message || "New patch canceled.";
  }

  return session.message || "Creating new patch...";
}

export function renderGraphNewPatchSession(session) {
  const active = session.status === "running";

  uiState.activeNewPatchSession = active ? session : null;
  uiState.lastMachSession = session;
  setMachCancelButton(null);
  setMachOutputPanel(session);
  setUpdateStatus(getNewPatchSessionStatusText(session), {
    error: session.status === "error",
    busy: active,
  });

  newPatchStatus.textContent = getNewPatchSessionStatusText(session);
  newPatchStatus.classList.toggle("error", session.status === "error");
  newPatchOutput.textContent = session.output || "";
  newPatchOutput.scrollTop = newPatchOutput.scrollHeight;
  setNewPatchLinks(session.links || []);
  setNewPatchDialogBusy(active);

  if (
    session.snapshots &&
    uiState.newPatchDialogState &&
    !uiState.newPatchDialogState.appliedSnapshots
  ) {
    uiState.newPatchDialogState.appliedSnapshots = true;
    applyGraphSnapshots(session.snapshots);
  }
}

export async function pollGraphNewPatchSession() {
  if (!uiState.newPatchDialogState) {
    return;
  }

  try {
    const response = await fetch(
      "/api/new-patch/" + encodeURIComponent(uiState.newPatchDialogState.sessionId) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphNewPatchSession(result);

    if (result.status === "running") {
      uiState.newPatchPollTimer = window.setTimeout(pollGraphNewPatchSession, 500);
    }
  } catch (error) {
    uiState.activeNewPatchSession = null;
    setMachOutputPanel();
    newPatchStatus.classList.add("error");
    newPatchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export function openNewPatchDialog() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  uiState.newPatchDialogState = null;
  uiState.activeNewPatchSession = null;
  newPatchStatus.classList.remove("error");
  newPatchStatus.textContent = "Ready to create a new patch branch.";
  newPatchOutput.textContent = "";
  setNewPatchLinks([]);
  setNewPatchDialogBusy(false);
  newPatchDialog.showModal();
  newPatchBug.focus();
}

export function closeNewPatchDialog() {
  if (uiState.newPatchPollTimer) {
    window.clearTimeout(uiState.newPatchPollTimer);
    uiState.newPatchPollTimer = null;
  }

  newPatchDialog.close();
}

export async function cancelOrCloseNewPatchDialog() {
  if (!hasActiveNewPatchSession()) {
    closeNewPatchDialog();
    return;
  }

  const sessionId = uiState.newPatchDialogState?.sessionId;

  if (!sessionId) {
    closeNewPatchDialog();
    return;
  }

  if (uiState.newPatchPollTimer) {
    window.clearTimeout(uiState.newPatchPollTimer);
    uiState.newPatchPollTimer = null;
  }

  newPatchStatus.classList.remove("error");
  newPatchStatus.textContent = "Canceling new patch...";
  setUpdateStatus("Canceling new patch...", { busy: true });

  try {
    const response = await fetch(
      "/api/new-patch/" + encodeURIComponent(sessionId) + "/cancel",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: INTERACTIVE.token }),
      }
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphNewPatchSession(result);
  } catch (error) {
    newPatchStatus.classList.add("error");
    newPatchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function startGraphNewPatchSession(event) {
  event.preventDefault();

  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  if (uiState.newPatchPollTimer) {
    window.clearTimeout(uiState.newPatchPollTimer);
    uiState.newPatchPollTimer = null;
  }

  setNewPatchDialogBusy(true);
  newPatchStatus.classList.remove("error");
  newPatchStatus.textContent = "Starting new patch...";
  newPatchOutput.textContent = "";
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("New patch starting...", { busy: true });

  try {
    const response = await fetch("/api/new-patch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options: getNewPatchDialogOptions(),
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.newPatchDialogState = {
      sessionId: result.id,
      appliedSnapshots: false,
    };
    renderGraphNewPatchSession(result);

    if (result.status === "running") {
      uiState.newPatchPollTimer = window.setTimeout(pollGraphNewPatchSession, 500);
    }
  } catch (error) {
    newPatchStatus.classList.add("error");
    newPatchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveNewPatchSession()) {
      setNewPatchDialogBusy(false);
      setUpdateBusy(false);
    }
  }
}
