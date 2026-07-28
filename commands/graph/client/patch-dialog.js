import {
  INTERACTIVE,
  patchApplyTo,
  patchClose,
  patchDialog,
  patchForm,
  patchLinks,
  patchOutput,
  patchPrompt,
  patchQuestion,
  patchRaw,
  patchRevision,
  patchStatus,
  patchSubmit,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshot,
  getSnapshotLimits,
  hasActiveCommandSession,
  hasActivePatchSession,
  setMachCancelButton,
  setMachOutputPanel,
  setUpdateBusy,
  setUpdateStatus,
} from "./command-sessions.js";

export function updatePatchDialogFields() {
  if (patchRaw.checked) {
    patchApplyTo.value = "";
  }

  patchApplyTo.disabled = patchSubmit.disabled || patchRaw.checked || hasActivePatchSession();
}

export function setPatchDialogBusy(busy) {
  patchForm.querySelectorAll("input, select").forEach((field) => {
    field.disabled = busy;
  });
  patchClose.disabled = false;
  patchClose.textContent = busy ? "Cancel" : "Close";
  patchSubmit.disabled = busy;
  updatePatchDialogFields();
}

export function getPatchDialogOptions() {
  return {
    revision: patchDialog.querySelector(".patch-revision").value,
    bug: patchDialog.querySelector(".patch-bug").value,
    checkpoint: patchDialog.querySelector(".patch-checkpoint").checked,
    rollback: patchDialog.querySelector(".patch-rollback").checked,
    applyTo: patchDialog.querySelector(".patch-apply-to").value,
    raw: patchDialog.querySelector(".patch-raw").checked,
    diffId: patchDialog.querySelector(".patch-diff-id").value,
    name: patchDialog.querySelector(".patch-name").value,
    noCommit: patchDialog.querySelector(".patch-no-commit").checked,
    noBookmark: patchDialog.querySelector(".patch-no-bookmark").checked,
    noTopic: patchDialog.querySelector(".patch-no-topic").checked,
    noBranch: patchDialog.querySelector(".patch-no-branch").checked,
    skipDependencies: patchDialog.querySelector(".patch-skip-dependencies").checked,
    includeAbandoned: patchDialog.querySelector(".patch-include-abandoned").checked,
    safeMode: patchDialog.querySelector(".patch-safe-mode").checked,
    forceVcs: patchDialog.querySelector(".patch-force-vcs").checked,
  };
}

export function setPatchLinks(links = []) {
  patchLinks.replaceChildren();

  if (!links.length) {
    patchLinks.hidden = true;
    return;
  }

  for (const linkInfo of links) {
    const link = document.createElement("a");

    link.href = linkInfo.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = linkInfo.label || linkInfo.url;
    patchLinks.append(link);
  }

  patchLinks.hidden = false;
}

export function renderPatchPrompt(prompt) {
  if (!prompt) {
    patchPrompt.hidden = true;
    patchQuestion.textContent = "";
    patchPrompt.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
    return;
  }

  patchPrompt.hidden = false;
  patchQuestion.textContent = prompt.message || "";
  patchPrompt.querySelectorAll("button").forEach((button) => {
    button.disabled = false;
  });
}

export function getPatchSessionStatusText(session) {
  if (session.status === "complete") {
    return session.message || "Patch pulled.";
  }

  if (session.status === "error") {
    return session.error || session.message || "Patch pull failed.";
  }

  if (session.status === "canceled") {
    return session.message || "Patch pull canceled.";
  }

  return session.message || "Pulling patch...";
}

export function renderGraphPatchSession(session) {
  const active = session.status === "running" || session.status === "prompt";

  uiState.activePatchSession = active ? session : null;
  uiState.lastMachSession = session;
  setMachCancelButton(null);
  setMachOutputPanel(session);
  setUpdateStatus(getPatchSessionStatusText(session), {
    error: session.status === "error",
    busy: active,
  });

  patchStatus.textContent = getPatchSessionStatusText(session);
  patchStatus.classList.toggle("error", session.status === "error");
  patchOutput.textContent = session.output || "";
  patchOutput.scrollTop = patchOutput.scrollHeight;
  renderPatchPrompt(session.prompt);
  setPatchLinks(session.links || []);
  setPatchDialogBusy(active);

  if (
    session.snapshot &&
    uiState.patchDialogState &&
    !uiState.patchDialogState.appliedSnapshot
  ) {
    uiState.patchDialogState.appliedSnapshot = true;
    applyGraphSnapshot(session.graphIndex, session.snapshot, { force: true });
  }
}

export async function pollGraphPatchSession() {
  if (!uiState.patchDialogState) {
    return;
  }

  try {
    const response = await fetch(
      "/api/patch/" + encodeURIComponent(uiState.patchDialogState.sessionId) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphPatchSession(result);

    if (result.status === "running") {
      uiState.patchPollTimer = window.setTimeout(pollGraphPatchSession, 500);
    }
  } catch (error) {
    uiState.activePatchSession = null;
    setMachOutputPanel();
    patchStatus.classList.add("error");
    patchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export function openPatchDialog() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  uiState.patchDialogState = null;
  uiState.activePatchSession = null;
  patchStatus.classList.remove("error");
  patchStatus.textContent = "Ready to pull a Phabricator patch.";
  patchPrompt.hidden = true;
  patchQuestion.textContent = "";
  patchOutput.textContent = "";
  setPatchLinks([]);
  setPatchDialogBusy(false);
  patchDialog.showModal();
  patchRevision.focus();
}

export function closePatchDialog() {
  if (uiState.patchPollTimer) {
    window.clearTimeout(uiState.patchPollTimer);
    uiState.patchPollTimer = null;
  }

  patchDialog.close();
}

export async function cancelOrClosePatchDialog() {
  if (!hasActivePatchSession()) {
    closePatchDialog();
    return;
  }

  const sessionId = uiState.patchDialogState?.sessionId;

  if (!sessionId) {
    closePatchDialog();
    return;
  }

  if (uiState.patchPollTimer) {
    window.clearTimeout(uiState.patchPollTimer);
    uiState.patchPollTimer = null;
  }

  patchStatus.classList.remove("error");
  patchStatus.textContent = "Canceling patch pull...";
  setUpdateStatus("Canceling patch pull...", { busy: true });

  try {
    const response = await fetch(
      "/api/patch/" + encodeURIComponent(sessionId) + "/cancel",
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

    renderGraphPatchSession(result);
  } catch (error) {
    patchStatus.classList.add("error");
    patchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function startGraphPatchSession(event) {
  event.preventDefault();

  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  if (uiState.patchPollTimer) {
    window.clearTimeout(uiState.patchPollTimer);
    uiState.patchPollTimer = null;
  }

  setPatchDialogBusy(true);
  patchStatus.classList.remove("error");
  patchStatus.textContent = "Starting patch pull...";
  patchOutput.textContent = "";
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("Patch pull starting...", { busy: true });

  try {
    const response = await fetch("/api/patch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options: getPatchDialogOptions(),
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.patchDialogState = {
      sessionId: result.id,
      appliedSnapshot: false,
    };
    renderGraphPatchSession(result);

    if (result.status === "running") {
      uiState.patchPollTimer = window.setTimeout(pollGraphPatchSession, 500);
    }
  } catch (error) {
    patchStatus.classList.add("error");
    patchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActivePatchSession()) {
      setPatchDialogBusy(false);
      setUpdateBusy(false);
    }
  }
}

export async function answerPatchPrompt(answer) {
  if (!uiState.patchDialogState || !uiState.activePatchSession?.prompt) {
    return;
  }

  const promptId = uiState.activePatchSession.prompt.id;

  patchPrompt.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });

  try {
    const response = await fetch(
      "/api/patch/" + encodeURIComponent(uiState.patchDialogState.sessionId) + "/answer",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: INTERACTIVE.token,
          promptId,
          answer,
        }),
      }
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphPatchSession(result);

    if (result.status === "running") {
      uiState.patchPollTimer = window.setTimeout(pollGraphPatchSession, 500);
    }
  } catch (error) {
    patchStatus.classList.add("error");
    patchStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}
