import {
  INTERACTIVE,
  commitBranchStatus,
  commitBug,
  commitBugField,
  commitClose,
  commitDialog,
  commitForm,
  commitReviewerInput,
  commitReviewerList,
  commitReviewerPills,
  commitStatus,
  commitSubmit,
  commitSummary,
  uiState,
} from "./config.js";
import {
  applyGraphSnapshots,
  getSnapshotLimits,
  hasActiveCommandSession,
  setMachOutputPanel,
  setUpdateBusy,
  setUpdateStatus,
} from "./command-sessions.js";

const MIN_REVIEWER_QUERY_LENGTH = 3;
const REVIEWER_SEARCH_DEBOUNCE_MS = 300;

function createCommitDialogState() {
  return {
    metadata: null,
    reviewers: [],
    results: [],
    visibleResults: [],
    activeResultIndex: -1,
    searchCache: new Map(),
    searchTimer: null,
    searchController: null,
  };
}

function setCommitDialogBusy(busy) {
  commitForm.querySelectorAll("input, button").forEach((field) => {
    field.disabled = busy;
  });
  commitClose.disabled = false;
  commitSubmit.disabled = busy;
}

function setCommitStatus(message, { error = false } = {}) {
  commitStatus.textContent = message;
  commitStatus.classList.toggle("error", error);
}

function getCommitDialogState() {
  if (!uiState.commitDialogState) {
    uiState.commitDialogState = createCommitDialogState();
  }

  return uiState.commitDialogState;
}

function getReviewerInputText(value = "") {
  return String(value || "")
    .trim()
    .replace(/^r=/i, "");
}

function hasReviewerBlockingMarker(value = "") {
  const text = getReviewerInputText(value).trim();

  return text.endsWith("!");
}

function stripReviewerBlockingMarker(value = "") {
  return getReviewerInputText(value).trim().replace(/!+$/, "").trim();
}

function normalizeReviewerInputValue(value = "") {
  let normalized = stripReviewerBlockingMarker(value);
  const blocking = hasReviewerBlockingMarker(value);

  if (!normalized) {
    return { value: "", blocking };
  }

  if (normalized.startsWith("#")) {
    normalized = "#" + normalized.replace(/^#+/, "");
  }

  return { value: normalized, blocking };
}

function getReviewerKey(reviewer) {
  return String(reviewer?.value || "").toLowerCase();
}

function getReviewerResultVariants(reviewer) {
  const normalized = normalizeReviewerInputValue(reviewer?.value || reviewer);

  if (!normalized.value) {
    return [];
  }

  const base = {
    ...reviewer,
    value: normalized.value,
    label: reviewer?.label || normalized.value,
  };

  return [
    {
      ...base,
      blocking: false,
    },
    {
      ...base,
      blocking: true,
      label: (base.label || base.value) + "!",
      description: [base.description || base.type || "", "blocking review"]
        .filter(Boolean)
        .join(" - "),
    },
  ];
}

function setReviewerResultsExpanded(expanded) {
  commitReviewerInput.setAttribute(
    "aria-expanded",
    expanded ? "true" : "false",
  );
  commitReviewerList.hidden = !expanded;
}

function renderCommitReviewerPills() {
  const state = getCommitDialogState();

  commitReviewerPills.replaceChildren(
    ...state.reviewers.map((reviewer) => {
      const pill = document.createElement("span");
      const label = document.createElement("span");
      const blocking = document.createElement("button");
      const remove = document.createElement("button");

      pill.className =
        "commit-reviewer-pill" + (reviewer.blocking ? " blocking" : "");
      label.textContent = reviewer.value + (reviewer.blocking ? "!" : "");
      blocking.type = "button";
      blocking.className = "commit-reviewer-blocking";
      blocking.dataset.value = reviewer.value;
      blocking.setAttribute(
        "aria-label",
        "Toggle blocking review for " + reviewer.value,
      );
      blocking.setAttribute(
        "aria-pressed",
        reviewer.blocking ? "true" : "false",
      );
      blocking.title = "Toggle blocking review";
      blocking.textContent = "!";
      remove.type = "button";
      remove.className = "commit-reviewer-remove";
      remove.dataset.value = reviewer.value;
      remove.setAttribute("aria-label", "Remove " + reviewer.value);
      remove.textContent = "x";
      pill.append(label, blocking, remove);
      return pill;
    }),
  );
}

function renderCommitReviewerResults() {
  const state = getCommitDialogState();
  const selected = new Set(state.reviewers.map(getReviewerKey));
  const results = state.results
    .filter((result) => !selected.has(getReviewerKey(result)))
    .flatMap(getReviewerResultVariants);

  state.visibleResults = results;
  state.activeResultIndex = results.length
    ? Math.max(0, Math.min(state.activeResultIndex, results.length - 1))
    : -1;
  commitReviewerList.replaceChildren(
    ...results.map((result, index) => {
      const option = document.createElement("button");
      const label = document.createElement("span");
      const description = document.createElement("span");

      option.type = "button";
      option.className =
        "commit-reviewer-option" + (result.blocking ? " blocking" : "");
      option.dataset.index = String(index);
      option.dataset.value = result.value;
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        index === state.activeResultIndex ? "true" : "false",
      );
      label.className = "commit-reviewer-option-label";
      label.textContent = result.label || result.value;
      description.className = "commit-reviewer-option-description";
      description.textContent = result.description || result.type || "";
      option.append(label, description);
      return option;
    }),
  );

  setReviewerResultsExpanded(Boolean(results.length));
}

function addCommitReviewer(reviewer) {
  const normalized = normalizeReviewerInputValue(reviewer?.value || reviewer);
  const value = normalized.value;
  const blocking = Boolean(reviewer?.blocking || normalized.blocking);

  if (!value) {
    return false;
  }

  const state = getCommitDialogState();
  const key = value.toLowerCase();

  if (state.reviewers.some((item) => getReviewerKey(item) === key)) {
    if (blocking) {
      const existing = state.reviewers.find(
        (item) => getReviewerKey(item) === key,
      );
      existing.blocking = true;
      renderCommitReviewerPills();
      renderCommitReviewerResults();
    }
    commitReviewerInput.value = "";
    setReviewerResultsExpanded(false);
    return false;
  }

  state.reviewers.push({
    type: reviewer?.type || (value.startsWith("#") ? "group" : "user"),
    value,
    label: reviewer?.label || value,
    description: reviewer?.description || "",
    blocking,
  });
  commitReviewerInput.value = "";
  state.activeResultIndex = -1;
  renderCommitReviewerPills();
  renderCommitReviewerResults();
  return true;
}

export function handleCommitReviewerPillEvent(event) {
  const removeButton = event.target.closest(".commit-reviewer-remove");
  const blockingButton = event.target.closest(".commit-reviewer-blocking");

  if (!removeButton && !blockingButton) {
    return false;
  }

  const state = getCommitDialogState();
  const key = String(
    (removeButton || blockingButton).dataset.value || "",
  ).toLowerCase();

  if (removeButton) {
    state.reviewers = state.reviewers.filter(
      (reviewer) => getReviewerKey(reviewer) !== key,
    );
  } else {
    const reviewer = state.reviewers.find(
      (item) => getReviewerKey(item) === key,
    );

    if (reviewer) {
      reviewer.blocking = !reviewer.blocking;
    }
  }

  renderCommitReviewerPills();
  renderCommitReviewerResults();
  commitReviewerInput.focus();
  return true;
}

function getReviewerSearchCacheKey(query = "") {
  return stripReviewerBlockingMarker(query).toLowerCase();
}

function getReviewerSearchTokens(query = "") {
  return getReviewerSearchCacheKey(query)
    .replace(/^#/, "")
    .split(/[\s#,_-]+/)
    .filter(Boolean);
}

function isReviewerGroupSearchQuery(query = "") {
  return stripReviewerBlockingMarker(query).startsWith("#");
}

function getReviewerSearchTarget(query = "") {
  return isReviewerGroupSearchQuery(query) ? "review groups" : "reviewers";
}

function getReviewerHaystack(reviewer = {}) {
  return [reviewer.value, reviewer.label, reviewer.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterCachedReviewerResults(results = [], query = "") {
  const tokens = getReviewerSearchTokens(query);

  if (!tokens.length) {
    return results;
  }

  return results.filter((reviewer) => {
    const haystack = getReviewerHaystack(reviewer);

    return tokens.every((token) => haystack.includes(token));
  });
}

function renderCachedReviewerPrefixResults(query) {
  const state = getCommitDialogState();
  const key = getReviewerSearchCacheKey(query);
  const prefixes = [...state.searchCache.keys()]
    .filter((cachedKey) => key.startsWith(cachedKey) && cachedKey.length >= 2)
    .sort((first, second) => second.length - first.length);

  for (const prefix of prefixes) {
    const filtered = filterCachedReviewerResults(
      state.searchCache.get(prefix),
      query,
    );

    if (filtered.length) {
      state.results = filtered;
      state.activeResultIndex = 0;
      renderCommitReviewerResults();
      return true;
    }
  }

  return false;
}

export async function searchCommitReviewers() {
  const state = getCommitDialogState();
  const query = commitReviewerInput.value.trim();
  const cacheKey = getReviewerSearchCacheKey(query);

  if (cacheKey.length < MIN_REVIEWER_QUERY_LENGTH) {
    if (state.searchController) {
      state.searchController.abort();
      state.searchController = null;
    }

    state.results = [];
    state.activeResultIndex = -1;
    renderCommitReviewerResults();
    setCommitStatus(
      `Type at least ${MIN_REVIEWER_QUERY_LENGTH} characters to search reviewers. Press Enter to add an exact reviewer.`,
    );
    return;
  }

  if (state.searchCache.has(cacheKey)) {
    state.results = state.searchCache.get(cacheKey);
    state.activeResultIndex = state.results.length ? 0 : -1;
    renderCommitReviewerResults();
    setCommitStatus("Reviewer results loaded from cache.");
    return;
  }

  renderCachedReviewerPrefixResults(query);

  if (state.searchController) {
    state.searchController.abort();
  }

  state.searchController = new AbortController();

  try {
    const response = await fetch(
      "/api/commit/reviewers?query=" +
        encodeURIComponent(query) +
        "&limit=20&token=" +
        encodeURIComponent(INTERACTIVE.token),
      { signal: state.searchController.signal },
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    state.results = Array.isArray(result.reviewers) ? result.reviewers : [];
    if (!result.rateLimited) {
      state.searchCache.set(cacheKey, state.results);
    }
    state.activeResultIndex = state.results.length ? 0 : -1;
    renderCommitReviewerResults();

    if (result.rateLimited) {
      const seconds = Math.max(
        1,
        Math.ceil(Number(result.retryAfterMs || 0) / 1000),
      );
      setCommitStatus(
        `Phabricator ${getReviewerSearchTarget(query)} search is rate limited. Try again in about ${seconds} seconds, or press Enter to add an exact reviewer.`,
        { error: true },
      );
      return;
    }

    if (state.results.length) {
      setCommitStatus("Reviewer results loaded.");
      return;
    }

    setCommitStatus(
      `No matching ${getReviewerSearchTarget(query)} found. ${isReviewerGroupSearchQuery(query) ? "" : "Start group searches with #."}`,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }

    state.results = [];
    renderCommitReviewerResults();
    setCommitStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
  }
}

export function scheduleCommitReviewerSearch() {
  const state = getCommitDialogState();

  if (state.searchTimer) {
    window.clearTimeout(state.searchTimer);
  }

  state.searchTimer = window.setTimeout(() => {
    state.searchTimer = null;
    searchCommitReviewers();
  }, REVIEWER_SEARCH_DEBOUNCE_MS);
}

function moveCommitReviewerSelection(direction) {
  const state = getCommitDialogState();
  const results = state.visibleResults || [];

  if (!results.length) {
    return;
  }

  state.activeResultIndex =
    (state.activeResultIndex + direction + results.length) % results.length;
  renderCommitReviewerResults();
}

export function handleCommitReviewerInputKeydown(event) {
  const state = getCommitDialogState();

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveCommitReviewerSelection(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveCommitReviewerSelection(-1);
    return;
  }

  if (event.key === "Escape") {
    setReviewerResultsExpanded(false);
    return;
  }

  if (event.key !== "Enter" && event.key !== ",") {
    return;
  }

  event.preventDefault();

  const results = state.visibleResults || [];
  const result = results[state.activeResultIndex];

  if (result) {
    addCommitReviewer(result);
    return;
  }

  addCommitReviewer(commitReviewerInput.value);
}

export function addCommitReviewerFromEvent(event) {
  const option = event.target.closest(".commit-reviewer-option");

  if (!option) {
    return false;
  }

  const state = getCommitDialogState();
  const reviewer = (state.visibleResults || [])[Number(option.dataset.index)];

  if (reviewer) {
    addCommitReviewer(reviewer);
    commitReviewerInput.focus();
  }

  return true;
}

function renderCommitMetadata(metadata) {
  const branch = metadata.branch || "(detached)";

  commitBranchStatus.textContent = metadata.bugRequired
    ? branch + " needs a Bugzilla bug ID."
    : branch + " will commit as " + metadata.prefix + ".";
  commitBugField.hidden = !metadata.bugRequired;
  commitBug.required = Boolean(metadata.bugRequired);
  commitBug.value = metadata.bugRequired ? "" : metadata.bugId || "";
}

export async function openCommitDialog() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  uiState.commitDialogState = createCommitDialogState();
  commitSummary.value = "";
  commitReviewerInput.value = "";
  commitReviewerList.replaceChildren();
  setReviewerResultsExpanded(false);
  renderCommitReviewerPills();
  commitBranchStatus.textContent = "Loading checkout...";
  setCommitStatus("Ready to commit changes.");
  setCommitDialogBusy(false);
  commitDialog.showModal();
  commitSummary.focus();

  try {
    const response = await fetch(
      "/api/commit/metadata?token=" + encodeURIComponent(INTERACTIVE.token),
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    getCommitDialogState().metadata = result.metadata;
    renderCommitMetadata(result.metadata);
  } catch (error) {
    setCommitStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
  }
}

export function closeCommitDialog() {
  const state = getCommitDialogState();

  if (state.searchTimer) {
    window.clearTimeout(state.searchTimer);
  }

  if (state.searchController) {
    state.searchController.abort();
  }

  commitDialog.close();
}

function getCommitDialogOptions() {
  const state = getCommitDialogState();

  return {
    bugId: commitBugField.hidden ? "" : commitBug.value,
    summary: commitSummary.value,
    reviewers: state.reviewers.map((reviewer) => ({
      value: reviewer.value,
      blocking: Boolean(reviewer.blocking),
    })),
  };
}

export async function submitCommitDialog(event) {
  event.preventDefault();

  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  setCommitDialogBusy(true);
  setCommitStatus("Creating commit...");
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("Commit running...", { busy: true });

  try {
    const response = await fetch("/api/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options: getCommitDialogOptions(),
        snapshotLimits: getSnapshotLimits(),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    applyGraphSnapshots(result.snapshots);
    uiState.lastMachSession = result.output ? { output: result.output } : null;
    setMachOutputPanel(uiState.lastMachSession);
    setCommitStatus(
      result.commitMessage || result.message || "Commit created.",
    );
    setUpdateStatus(result.message || "Commit complete.");
  } catch (error) {
    setCommitStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
    setUpdateStatus(error && error.message ? error.message : String(error), {
      error: true,
    });
  } finally {
    setCommitDialogBusy(false);
    setUpdateBusy(false);
  }
}
