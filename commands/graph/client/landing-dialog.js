import {
  INTERACTIVE,
  landChoiceList,
  landClose,
  landDetail,
  landDialog,
  landInput,
  landInputForm,
  landLinks,
  landOutput,
  landPrompt,
  landQuestion,
  landStart,
  landStatus,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshots,
  getSnapshotLimits,
  hasActiveCommandSession,
  hasActiveLandSession,
  setMachCancelButton,
  setMachOutputPanel,
  setUpdateBusy,
  setUpdateStatus,
} from "./command-sessions.js";

export function setLandDialogBusy(busy) {
  landDialog.querySelectorAll(".land-lando-repo, .land-relbranch").forEach((field) => {
    field.disabled = busy;
  });
  landStart.disabled = busy;
  landClose.disabled = false;
  landClose.textContent = busy ? "Cancel" : "Close";
}

export function getLandDialogOptions() {
  return {
    landoRepo: landDialog.querySelector(".land-lando-repo").value,
    relbranch: landDialog.querySelector(".land-relbranch").value,
  };
}

export function setLandLinks(links = []) {
  landLinks.replaceChildren();

  if (!links.length) {
    landLinks.hidden = true;
    return;
  }

  for (const linkInfo of links) {
    const link = document.createElement("a");

    link.href = linkInfo.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = linkInfo.label || linkInfo.url;
    landLinks.append(link);
  }

  landLinks.hidden = false;
}

export function createLandChoiceButton(choice) {
  if (choice.separator) {
    const section = document.createElement("div");

    section.className = "land-choice-section";
    section.textContent = choice.label || "";
    return section;
  }

  const button = document.createElement("button");

  button.className = "land-choice" + (choice.kind ? " " + choice.kind : "");
  button.type = "button";
  button.dataset.answer = choice.id;
  button.textContent = choice.label || choice.id;
  return button;
}

export function renderLandPrompt(prompt, links = []) {
  if (!prompt) {
    landPrompt.hidden = !links.length;
    landQuestion.textContent = "";
    landChoiceList.replaceChildren();
    landDetail.textContent = "";
    landInputForm.hidden = true;
    setLandLinks(links);
    return;
  }

  landPrompt.hidden = false;
  landQuestion.textContent = prompt.message || "";
  landDetail.textContent = prompt.detail || "";
  setLandLinks(prompt.links || []);

  if (prompt.type === "input") {
    landChoiceList.replaceChildren();
    landInputForm.hidden = false;
    landInputForm.querySelectorAll("input, button").forEach((field) => {
      field.disabled = false;
    });
    landInput.value = prompt.defaultValue || "";
    window.setTimeout(() => {
      landInput.focus();
      landInput.select();
    }, 0);
    return;
  }

  landInputForm.hidden = true;

  const choices = prompt.type === "confirm"
    ? [
      { id: "true", label: "Yes", kind: "accepted", answerValue: true },
      { id: "false", label: "No", answerValue: false },
    ]
    : prompt.choices || [];

  landChoiceList.replaceChildren(...choices.map((choice) => {
    const element = createLandChoiceButton(choice);

    if (!choice.separator && Object.hasOwn(choice, "answerValue")) {
      element.dataset.answer = String(choice.answerValue);
      element.dataset.answerType = "boolean";
    }

    return element;
  }));
}

export function getLandSessionStatusText(session) {
  if (session.status === "complete") {
    return session.message || "Landing complete.";
  }

  if (session.status === "error") {
    return session.error || session.message || "Landing failed.";
  }

  if (session.status === "canceled") {
    return session.message || "Landing canceled.";
  }

  return session.message || "Landing running...";
}

export function renderGraphLandSession(session) {
  const active = session.status === "running" || session.status === "prompt";

  uiState.activeLandSession = active ? session : null;
  uiState.lastMachSession = session;
  setMachCancelButton(null);
  setMachOutputPanel(session);
  setUpdateStatus(getLandSessionStatusText(session), {
    error: session.status === "error",
    busy: active,
  });

  landStatus.textContent = getLandSessionStatusText(session);
  landStatus.classList.toggle("error", session.status === "error");
  landOutput.textContent = session.output || "";
  landOutput.scrollTop = landOutput.scrollHeight;
  renderLandPrompt(session.prompt, session.links || []);
  setLandDialogBusy(active);

  if (
    session.status === "complete" &&
    session.snapshots &&
    uiState.landDialogState &&
    !uiState.landDialogState.appliedSnapshots
  ) {
    uiState.landDialogState.appliedSnapshots = true;
    applyGraphSnapshots(session.snapshots);
  }
}

export async function pollGraphLandSession() {
  if (!uiState.landDialogState) {
    return;
  }

  try {
    const response = await fetch(
      "/api/land/" + encodeURIComponent(uiState.landDialogState.sessionId) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphLandSession(result);

    if (result.status === "running") {
      uiState.landPollTimer = window.setTimeout(pollGraphLandSession, 500);
    }
  } catch (error) {
    uiState.activeLandSession = null;
    setMachOutputPanel();
    landStatus.classList.add("error");
    landStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export function openLandDialog() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  uiState.landDialogState = null;
  uiState.activeLandSession = null;
  landStatus.classList.remove("error");
  landStatus.textContent = "Ready to land patches marked for checkin.";
  landPrompt.hidden = true;
  landChoiceList.replaceChildren();
  landDetail.textContent = "";
  landOutput.textContent = "";
  setLandLinks([]);
  setLandDialogBusy(false);
  landDialog.showModal();
  landStart.focus();
}

export function closeLandDialog() {
  if (uiState.landPollTimer) {
    window.clearTimeout(uiState.landPollTimer);
    uiState.landPollTimer = null;
  }

  landDialog.close();
}

export async function cancelOrCloseLandDialog() {
  if (!hasActiveLandSession()) {
    closeLandDialog();
    return;
  }

  const sessionId = uiState.landDialogState?.sessionId;

  if (!sessionId) {
    closeLandDialog();
    return;
  }

  if (uiState.landPollTimer) {
    window.clearTimeout(uiState.landPollTimer);
    uiState.landPollTimer = null;
  }

  landStatus.classList.remove("error");
  landStatus.textContent = "Canceling landing...";
  setUpdateStatus("Canceling landing...", { busy: true });

  try {
    const response = await fetch(
      "/api/land/" + encodeURIComponent(sessionId) + "/cancel",
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

    renderGraphLandSession(result);
    closeLandDialog();
  } catch (error) {
    landStatus.classList.add("error");
    landStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function startGraphLandSession() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  if (uiState.landPollTimer) {
    window.clearTimeout(uiState.landPollTimer);
    uiState.landPollTimer = null;
  }

  setLandDialogBusy(true);
  landStatus.classList.remove("error");
  landStatus.textContent = "Starting landing...";
  landOutput.textContent = "";
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("Landing starting...", { busy: true });

  try {
    const response = await fetch("/api/land", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options: getLandDialogOptions(),
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    uiState.landDialogState = {
      sessionId: result.id,
      promptId: "",
      appliedSnapshots: false,
    };
    renderGraphLandSession(result);

    if (result.status === "running") {
      uiState.landPollTimer = window.setTimeout(pollGraphLandSession, 500);
    }
  } catch (error) {
    landStatus.classList.add("error");
    landStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveLandSession()) {
      setLandDialogBusy(false);
      setUpdateBusy(false);
    }
  }
}

export async function answerLandPrompt(answer) {
  if (!uiState.landDialogState || !uiState.activeLandSession?.prompt) {
    return;
  }

  const promptId = uiState.activeLandSession.prompt.id;

  landChoiceList.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  landInputForm.querySelectorAll("input, button").forEach((field) => {
    field.disabled = true;
  });

  try {
    const response = await fetch(
      "/api/land/" + encodeURIComponent(uiState.landDialogState.sessionId) + "/answer",
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

    renderGraphLandSession(result);

    if (result.status === "running") {
      uiState.landPollTimer = window.setTimeout(pollGraphLandSession, 500);
    }
  } catch (error) {
    landStatus.classList.add("error");
    landStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export function submitLandInputPrompt(event) {
  event.preventDefault();
  answerLandPrompt(landInput.value);
}
