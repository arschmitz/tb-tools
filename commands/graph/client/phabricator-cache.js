import { INTERACTIVE } from "./config.js";
import { setConsoleRoute } from "./view-router.js";

const panel = document.querySelector(".phabricator-cache-panel");
const status = panel?.querySelector(".phabricator-cache-status");
const reload = panel?.querySelector(".phabricator-cache-reload");
let hasLoaded = false;

function setStatus(message) {
  if (status) {
    status.textContent = message;
  }
}

function setBusy(busy) {
  panel?.classList.toggle("is-loading", busy);

  if (reload) {
    reload.disabled = busy;
  }

  panel?.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
}

function setCategoryCount(category, value) {
  const row = panel?.querySelector(
    `[data-phabricator-cache-category="${category}"]`,
  );
  const count = row?.querySelector(".phabricator-cache-count");

  if (count) {
    count.textContent = `${Number(value || 0)} stored`;
  }
}

function renderCacheStatus({ cache = {}, dashboard = {}, dashboardTimelines = {} } = {}) {
  const categories = cache.categories || {};

  setCategoryCount("identities", categories.identities?.entries);
  setCategoryCount("revision-status", categories["revision-status"]?.entries);
  setCategoryCount("revision-history", categories["revision-history"]?.entries);
  setCategoryCount("dashboard-timelines", dashboardTimelines.entries);
  setCategoryCount("dashboard-results", dashboard.entries);

  if (!cache.enabled) {
    setStatus("Persistent Phabricator caching is disabled for this console.");
    return;
  }

  setStatus("Cache is stored locally and shared by every console tab and server restart.");
}

async function requestCacheStatus() {
  const response = await fetch(
    `/api/phabricator-cache?token=${encodeURIComponent(INTERACTIVE.token)}`,
    { cache: "no-store" },
  );
  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Could not read the Phabricator cache.");
  }

  return result;
}

async function loadCacheStatus() {
  if (!panel) {
    return;
  }

  setBusy(true);
  setStatus("Reading local cache details...");

  try {
    renderCacheStatus(await requestCacheStatus());
    hasLoaded = true;
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function clearCacheCategory(category) {
  if (!panel) {
    return;
  }

  setBusy(true);
  setStatus("Updating local cache...");

  try {
    const response = await fetch("/api/phabricator-cache", {
      body: JSON.stringify({ category, token: INTERACTIVE.token }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not update the Phabricator cache.");
    }

    renderCacheStatus(result);
    setStatus("The selected local cache data was cleared. Future views will fetch only what they need.");
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    setBusy(false);
  }
}

export function hidePhabricatorCache() {
  panel?.classList.remove("active");
  panel?.setAttribute("hidden", "");
}

export function showPhabricatorCache({ updateLocation = true } = {}) {
  if (!panel) {
    return;
  }

  document.body.classList.remove("graph-view-active");
  document.querySelectorAll(".tab, .panel").forEach((node) => {
    node.classList.remove("active");
  });
  document.querySelector(".dashboard-panel")?.setAttribute("hidden", "");
  document.querySelector(".meta-boards-panel")?.setAttribute("hidden", "");
  document.querySelector(".sprint-panel")?.setAttribute("hidden", "");
  document.querySelector(".test-output-panel")?.setAttribute("hidden", "");
  panel.classList.add("active");
  panel.hidden = false;

  if (updateLocation) {
    setConsoleRoute({ view: "phabricator-cache" });
  }

  if (!hasLoaded) {
    void loadCacheStatus();
  }
}

export function initializePhabricatorCache() {
  if (!panel) {
    return;
  }

  reload?.addEventListener("click", () => void loadCacheStatus());
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-phabricator-cache-clear]");

    if (button) {
      void clearCacheCategory(button.dataset.phabricatorCacheClear);
    }
  });
}
