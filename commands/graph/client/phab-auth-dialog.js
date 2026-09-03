import {
  INTERACTIVE,
  phabAuthCancel,
  phabAuthClose,
  phabAuthDialog,
  phabAuthError,
  phabAuthSignOut,
  phabAuthStart,
  phabAuthStatus,
  uiState,
} from "./config.js";

const AUTH_POLL_INTERVAL_MS = 1000;
let latestAuthenticationRequest = 0;

function clearAuthenticationPoll() {
  if (!uiState.phabAuthPollTimer) {
    return;
  }

  window.clearTimeout(uiState.phabAuthPollTimer);
  uiState.phabAuthPollTimer = null;
}

function setAuthenticationBusy(busy) {
  phabAuthStart.disabled = busy;
  phabAuthCancel.disabled = busy;
  phabAuthSignOut.disabled = busy;
  phabAuthClose.disabled = false;
}

function renderAuthenticationStatus(result = {}) {
  const state = String(result.state || "disconnected");
  const wasConnected = uiState.phabAuthState === "connected";

  uiState.phabAuthState = state;
  phabAuthStatus.textContent = result.message || "Not connected to Phabricator.";
  phabAuthStatus.classList.toggle("error", state === "error");
  phabAuthError.textContent = state === "error" ? result.message || "Authentication failed." : "";
  phabAuthCancel.hidden = state !== "pending";
  phabAuthSignOut.hidden = state !== "connected";
  phabAuthStart.hidden = state === "pending" || state === "connected";

  if (!wasConnected && state === "connected") {
    window.dispatchEvent(new CustomEvent("tb-phab-authenticated"));
  }
}

async function getAuthenticationStatus() {
  const response = await fetch(
    "/api/phabricator/auth?token=" + encodeURIComponent(INTERACTIVE.token),
  );
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || response.statusText);
  }

  return result;
}

async function postAuthenticationAction(action) {
  const response = await fetch("/api/phabricator/auth/" + action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: INTERACTIVE.token }),
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || response.statusText);
  }

  return result;
}

function scheduleAuthenticationStatusPoll() {
  clearAuthenticationPoll();
  uiState.phabAuthPollTimer = window.setTimeout(
    () => refreshAuthenticationStatus({ poll: true }),
    AUTH_POLL_INTERVAL_MS,
  );
}

async function refreshAuthenticationStatus({
  poll = false,
  requestId = ++latestAuthenticationRequest,
} = {}) {
  try {
    const result = await getAuthenticationStatus();

    if (requestId !== latestAuthenticationRequest) {
      return;
    }

    renderAuthenticationStatus(result);
    setAuthenticationBusy(false);
    if (poll && result.state === "pending") {
      scheduleAuthenticationStatusPoll();
    }
  } catch (error) {
    if (requestId !== latestAuthenticationRequest) {
      return;
    }

    clearAuthenticationPoll();
    renderAuthenticationStatus({
      state: "error",
      message: error?.message || String(error),
    });
    setAuthenticationBusy(false);
  }
}

export async function openPhabricatorAuthDialog() {
  const requestId = ++latestAuthenticationRequest;

  clearAuthenticationPoll();
  setAuthenticationBusy(false);
  renderAuthenticationStatus({
    state: "checking",
    message: "Checking Phabricator authentication...",
  });
  phabAuthDialog.showModal();
  await refreshAuthenticationStatus({ poll: true, requestId });
}

export function closePhabricatorAuthDialog() {
  latestAuthenticationRequest++;
  clearAuthenticationPoll();
  phabAuthDialog.close();
}

export async function startPhabricatorAuthentication() {
  const requestId = ++latestAuthenticationRequest;

  clearAuthenticationPoll();
  setAuthenticationBusy(true);

  try {
    const result = await postAuthenticationAction("start");

    if (requestId !== latestAuthenticationRequest) {
      return;
    }

    renderAuthenticationStatus(result);
    setAuthenticationBusy(false);
    if (result.state === "pending") {
      scheduleAuthenticationStatusPoll();
    }
  } catch (error) {
    if (requestId !== latestAuthenticationRequest) {
      return;
    }

    renderAuthenticationStatus({
      state: "error",
      message: error?.message || String(error),
    });
    setAuthenticationBusy(false);
  }
}

export async function cancelPhabricatorAuthentication() {
  const requestId = ++latestAuthenticationRequest;

  clearAuthenticationPoll();
  setAuthenticationBusy(true);

  try {
    const result = await postAuthenticationAction("cancel");

    if (requestId === latestAuthenticationRequest) {
      renderAuthenticationStatus(result);
    }
  } catch (error) {
    if (requestId !== latestAuthenticationRequest) {
      return;
    }

    renderAuthenticationStatus({
      state: "error",
      message: error?.message || String(error),
    });
  } finally {
    setAuthenticationBusy(false);
  }
}

export async function signOutOfPhabricator() {
  const requestId = ++latestAuthenticationRequest;

  clearAuthenticationPoll();
  setAuthenticationBusy(true);

  try {
    const result = await postAuthenticationAction("sign-out");

    if (requestId === latestAuthenticationRequest) {
      renderAuthenticationStatus(result);
    }
  } catch (error) {
    if (requestId !== latestAuthenticationRequest) {
      return;
    }

    renderAuthenticationStatus({
      state: "error",
      message: error?.message || String(error),
    });
  } finally {
    setAuthenticationBusy(false);
  }
}
