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

const LAND_TRY_STATUS_CONCURRENCY = 2;
const landTryStatusQueue = [];
const queuedLandTryStatusKeys = new Set();
const loadedLandTryStatusKeys = new Set();
let activeLandTryStatusRequests = 0;
let landTryStatusObserver = null;

export function setLandDialogBusy(busy) {
  const prompt = uiState.activeLandSession?.prompt;
  const footerActions = prompt?.kind === "patch-select" && Array.isArray(prompt.actions);
  const primaryAction = footerActions ? prompt.actions.find((action) => action.id === "continue") : null;
  const secondaryAction = footerActions ? prompt.actions.find((action) => action.id === "abort") : null;

  landDialog.querySelectorAll(".land-lando-repo, .land-relbranch").forEach((field) => {
    field.disabled = busy;
  });

  if (primaryAction) {
    landStart.disabled = false;
    landStart.textContent = primaryAction.label || "Continue";
    landStart.dataset.landAnswer = primaryAction.id;
    landStart.classList.toggle("danger", primaryAction.kind === "danger");
  } else {
    landStart.disabled = busy;
    landStart.textContent = "Start Landing";
    delete landStart.dataset.landAnswer;
    landStart.classList.remove("danger");
  }

  landClose.disabled = false;
  if (secondaryAction) {
    landClose.textContent = secondaryAction.label || "Abort";
    landClose.dataset.landAnswer = secondaryAction.id;
    landClose.classList.toggle("danger", secondaryAction.kind === "danger");
  } else {
    landClose.textContent = busy ? "Cancel" : "Close";
    delete landClose.dataset.landAnswer;
    landClose.classList.remove("danger");
  }
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

function createLandLinkPill(linkInfo) {
  const link = document.createElement("a");

  link.className = "land-patch-link";
  link.href = linkInfo.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = linkInfo.label || linkInfo.url;
  return link;
}

function createLandPatchTryStatus(choice) {
  const wrapper = document.createElement("div");
  const tryStatus = choice.tryStatus || {};

  wrapper.className = "land-patch-try";
  wrapper.dataset.landTryStatus = "";
  renderLandPatchTryStatus(wrapper, tryStatus);
  return wrapper;
}

function renderLandPatchTryStatus(wrapper, tryStatus = {}) {
  const latestTryRun = tryStatus.latestTryRun;

  wrapper.replaceChildren();
  wrapper.dataset.landTryStatus = tryStatus.state || "";

  if (latestTryRun?.url) {
    const tryLink = createLandLinkPill({
      label: "Try latest",
      url: latestTryRun.url,
    });

    tryLink.classList.add("try");
    wrapper.append(tryLink);
  }

  if (tryStatus.warning) {
    const warning = document.createElement("span");

    warning.className = "land-patch-warning";
    warning.textContent = tryStatus.warning;
    wrapper.append(warning);
  } else if (latestTryRun?.url) {
    const current = document.createElement("span");

    current.className = "land-patch-current";
    current.textContent = "Treeherder try run found";
    wrapper.append(current);
  } else if (tryStatus.state === "loading") {
    const loading = document.createElement("span");

    loading.className = "land-patch-current loading";
    loading.textContent = "Checking Treeherder try status...";
    wrapper.append(loading);
  } else if (tryStatus.state === "pending") {
    const pending = document.createElement("span");

    pending.className = "land-patch-current pending";
    pending.textContent = "Treeherder try status pending";
    wrapper.append(pending);
  }
}

function createLandPatchCard(choice) {
  const card = document.createElement("article");
  const content = document.createElement("div");
  const header = document.createElement("div");
  const title = document.createElement("strong");
  const meta = document.createElement("div");
  const links = document.createElement("div");
  const mergeButton = document.createElement("button");

  card.className = "land-patch-card " + (choice.statusKind || "");
  card.dataset.landBugId = choice.bugId || "";
  card.dataset.landPatchId = choice.patchId || "";
  content.className = "land-patch-content";
  header.className = "land-patch-header";
  title.className = "land-patch-title";
  meta.className = "land-patch-meta";
  links.className = "land-patch-links";
  mergeButton.className = "land-patch-merge";
  mergeButton.type = "button";
  mergeButton.dataset.landAnswer = choice.mergeAnswer || choice.id;
  mergeButton.textContent = "Merge Patch";

  title.textContent = choice.title || choice.label || `D${choice.patchId}`;
  meta.textContent = [
    choice.statusName || "Unknown",
    (choice.reviewers || []).length ? `reviewers: ${choice.reviewers.join(", ")}` : "reviewers: none",
  ].filter(Boolean).join(" - ");
  links.append(...(choice.links || []).map(createLandLinkPill));
  header.append(title, meta);
  content.append(header, links, createLandPatchTryStatus(choice));
  card.append(content, mergeButton);
  return card;
}

function getLandTryStatusKey(card) {
  return [
    uiState.landDialogState?.sessionId || "",
    card.dataset.landBugId || "",
    card.dataset.landPatchId || "",
  ].join(":");
}

function queueLandPatchTryStatus(card) {
  const key = getLandTryStatusKey(card);

  if (
    !uiState.landDialogState?.sessionId ||
    !card.dataset.landBugId ||
    !card.dataset.landPatchId ||
    queuedLandTryStatusKeys.has(key) ||
    loadedLandTryStatusKeys.has(key)
  ) {
    return;
  }

  queuedLandTryStatusKeys.add(key);
  landTryStatusQueue.push({ card, key });
  drainLandPatchTryStatusQueue();
}

function drainLandPatchTryStatusQueue() {
  while (
    activeLandTryStatusRequests < LAND_TRY_STATUS_CONCURRENCY &&
    landTryStatusQueue.length
  ) {
    const item = landTryStatusQueue.shift();

    if (!item.card.isConnected) {
      queuedLandTryStatusKeys.delete(item.key);
      continue;
    }

    activeLandTryStatusRequests++;
    loadLandPatchTryStatus(item.card, item.key).finally(() => {
      activeLandTryStatusRequests--;
      drainLandPatchTryStatusQueue();
    });
  }
}

async function loadLandPatchTryStatus(card, key) {
  const status = card.querySelector(".land-patch-try");

  if (status) {
    renderLandPatchTryStatus(status, { state: "loading" });
  }

  try {
    const response = await fetch(
      "/api/land/" + encodeURIComponent(uiState.landDialogState.sessionId) +
        "/patch/" + encodeURIComponent(card.dataset.landBugId) +
        "/" + encodeURIComponent(card.dataset.landPatchId) +
        "/try-status?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    loadedLandTryStatusKeys.add(key);
    if (status && card.isConnected) {
      renderLandPatchTryStatus(status, result.tryStatus || {});
    }
  } catch (error) {
    if (status && card.isConnected) {
      renderLandPatchTryStatus(status, {
        state: "unknown",
        latestTryRun: null,
        warning: error && error.message ? error.message : String(error),
      });
    }
  } finally {
    queuedLandTryStatusKeys.delete(key);
  }
}

function observeLandPatchTryStatuses() {
  if (landTryStatusObserver) {
    landTryStatusObserver.disconnect();
    landTryStatusObserver = null;
  }

  const cards = Array.from(landChoiceList.querySelectorAll(".land-patch-card"));

  if (!cards.length) {
    return;
  }

  if (!("IntersectionObserver" in window)) {
    cards.forEach(queueLandPatchTryStatus);
    return;
  }

  landTryStatusObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      landTryStatusObserver.unobserve(entry.target);
      queueLandPatchTryStatus(entry.target);
    }
  }, {
    root: landChoiceList,
    rootMargin: "160px",
  });

  cards.forEach((card) => landTryStatusObserver.observe(card));
}

export function createLandChoiceButton(choice) {
  if (choice.separator) {
    const section = document.createElement("div");

    section.className = "land-choice-section";
    section.textContent = choice.label || "";
    return section;
  }

  if (choice.kind === "patch-card") {
    return createLandPatchCard(choice);
  }

  const button = document.createElement("button");

  button.className = "land-choice" + (choice.kind ? " " + choice.kind : "");
  button.type = "button";
  button.dataset.answer = choice.id;
  button.dataset.landAnswer = choice.id;
  button.textContent = choice.label || choice.id;
  return button;
}

export function renderLandPrompt(prompt, links = []) {
  if (!prompt) {
    landPrompt.hidden = !links.length;
    landQuestion.textContent = "";
    landChoiceList.replaceChildren();
    landChoiceList.classList.remove("patch-card-list");
    landDetail.textContent = "";
    landInputForm.hidden = true;
    setLandLinks(links);
    return;
  }

  landPrompt.hidden = false;
  landQuestion.textContent = prompt.message || "";
  landDetail.textContent = prompt.detail || "";
  landChoiceList.classList.toggle("patch-card-list", prompt.kind === "patch-select");
  setLandLinks(prompt.links || []);
  if (prompt.kind !== "patch-select" && landTryStatusObserver) {
    landTryStatusObserver.disconnect();
    landTryStatusObserver = null;
  }

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
      element.dataset.landAnswer = String(choice.answerValue);
      element.dataset.answerType = "boolean";
    }

    return element;
  }));

  if (prompt.kind === "patch-select") {
    observeLandPatchTryStatuses();
  }
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
  queuedLandTryStatusKeys.clear();
  loadedLandTryStatusKeys.clear();
  landTryStatusQueue.length = 0;
  if (landTryStatusObserver) {
    landTryStatusObserver.disconnect();
    landTryStatusObserver = null;
  }
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
  landDialog.querySelectorAll("[data-land-answer]").forEach((button) => {
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
