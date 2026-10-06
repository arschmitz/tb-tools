import { createReviewHandledButton } from "./review-handled.js";
import { openDashboardBugDetail, createBugzillaIconLink } from "./meta-boards.js";
import { GRAPHS, INTERACTIVE, uiState } from "./config.js";
import { openPatchUpdateDialog } from "./patch-update-dialog.js";
import { openPatchReviewDialog } from "./patch-review-dialog.js";
import { setConsoleRoute } from "./view-router.js";
import { createImplementButton, refreshImplementations } from "./implement.js";

const dashboardTab = document.querySelector(".dashboard-tab");
const dashboardPanel = document.querySelector(".dashboard-panel");
const dashboardStatus = dashboardPanel?.querySelector(".dashboard-status");
const dashboardRefresh = dashboardPanel?.querySelector(".dashboard-refresh");
const dashboardLoading = dashboardPanel?.querySelector(".dashboard-loading");
const dashboardLoadingText = dashboardPanel?.querySelector(".dashboard-loading-text");
const dashboardErrors = dashboardPanel?.querySelector(".dashboard-errors");

const sections = new Map([
  ["handled-reviews", "handledReviews"],
  ["own-needs-revision", "ownNeedsRevision"],
  ["direct-review", "directlyAssignedWaitingOnReview"],
  ["own-needs-review", "ownNeedsReview"],
  ["own-approved", "ownApproved"],
  ["group-first-review", "groupWaitingForFirstReview"],
  ["needinfo-bugs", "needinfoBugs"],
  ["in-progress-bugs", "inProgressBugs"],
  ["assigned-bugs", "assignedBugs"],
]);

let lastDashboard;
window.addEventListener("review-status-changed", event => {
  if (!lastDashboard) return;
  const { revision, statusName } = event.detail;
  renderDashboard({ ...lastDashboard,
    directlyAssignedWaitingOnReview: (lastDashboard.directlyAssignedWaitingOnReview || []).filter(patch => patch.id !== revision),
    groupWaitingForFirstReview: (lastDashboard.groupWaitingForFirstReview || []).filter(patch => patch.id !== revision),
  });
  dashboardStatus.textContent = `${revision}: ${statusName}.`;
});
window.addEventListener("review-handled-changed", event => {
  if (!lastDashboard) return;
  const moveFocus = dashboardPanel?.contains(document.activeElement) && document.activeElement.matches(".review-handled-toggle");
  const handled = new Set(event.detail.map(patch => patch.id));
  const all = new Map([...lastDashboard.directlyAssignedWaitingOnReview || [],
    ...lastDashboard.groupWaitingForFirstReview || [], ...lastDashboard.handledReviews || []].map(patch => [patch.id, patch]));
  const restored = (lastDashboard.handledReviews || []).filter(patch => !handled.has(patch.id));
  renderDashboard({ ...lastDashboard,
    directlyAssignedWaitingOnReview: (lastDashboard.directlyAssignedWaitingOnReview || []).filter(patch => !handled.has(patch.id)),
    groupWaitingForFirstReview: (lastDashboard.groupWaitingForFirstReview || []).filter(patch => !handled.has(patch.id)),
    handledReviews: event.detail.map(patch => ({ ...all.get(patch.id), ...patch })),
  });
  if (moveFocus) dashboardPanel.querySelector('[data-dashboard-section="handled-reviews"] summary')?.focus();
  dashboardStatus.textContent = restored.length ? "Review restored. Refreshing the queue..." : "Review marked handled.";
  // Reload cached server data so undo restores the original direct and group queues.
  void loadDashboard();
});
let hasLoadedDashboard = false;
let loadingDashboard = false;

function formatAge(ageMs = 0) {
  const minutes = Math.max(0, Math.floor(Number(ageMs || 0) / 60000));

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 48) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function clearElement(element) {
  element?.replaceChildren();
}

function createLink({ href, text, className = "" }) {
  const link = document.createElement("a");

  link.href = href;
  link.className = className;
  link.textContent = text;
  return link;
}

let patchActionRunning = false;

async function runDashboardPatchAction(patch, action) {
  const { applyGraphSnapshot, hasActiveCommandSession, pollGraphTrySession, renderGraphTrySession } =
    await import("./command-sessions.js");
  if (patchActionRunning || hasActiveCommandSession()) {
    dashboardStatus.textContent = "Wait for the active checkout operation to finish.";
    return;
  }
  patchActionRunning = true;
  dashboardStatus.textContent = `${action === "rebase" ? "Rebasing" : "Submitting a Try run for"} ${patch.id}...`;
  try {
    const response = await fetch("/api/dashboard/patch-action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: INTERACTIVE.token, revision: patch.id, action }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.rebaseConflict) {
        const { openRebaseFailureDialog } = await import("./rebase-dialog.js");
        openRebaseFailureDialog(result.rebaseConflict, { fallbackMessage: result.error });
      }
      throw new Error(result.error || response.statusText);
    }
    if (action === "ci-verify") {
      renderGraphTrySession(result);
      if (result.status === "running") uiState.tryPollTimer = window.setTimeout(pollGraphTrySession, 500);
      dashboardStatus.textContent = `${patch.id}: ${result.message}`;
    } else {
      if (result.snapshot) applyGraphSnapshot(result.graphIndex, result.snapshot, { force: true });
      dashboardStatus.textContent = result.message;
    }
  } catch (error) {
    dashboardStatus.textContent = error.message;
  } finally {
    patchActionRunning = false;
  }
}

function createPatchRow(
  patch,
  { canUpdate = false, canReview = false, showAuthor = false } = {},
) {
  const row = document.createElement("article");
  const heading = document.createElement("div");
  const primary = document.createElement("div");
  const links = document.createElement("div");
  const title = document.createElement("a");
  const meta = document.createElement("div");
  const status = document.createElement("span");

  row.className = [
    "dashboard-row",
    "dashboard-patch-row",
    patch.ageState ? `dashboard-row-${patch.ageState}` : "",
  ].filter(Boolean).join(" ");
  heading.className = "dashboard-row-heading";
  primary.className = "dashboard-row-primary";
  links.className = "dashboard-row-links";
  title.className = "dashboard-patch-title";
  title.href = patch.url;
  title.textContent = patch.title;
  primary.append(title);
  links.append(createLink({ href: patch.url, text: patch.id, className: "dashboard-link" }));

  if (patch.bugId) {
    const bug = { id: patch.bugId };
    links.append(createBugButton(bug, `Bug ${bug.id}`), createBugzillaLink(bug));
  }

  heading.append(primary, links);
  meta.className = "dashboard-row-meta";
  status.className = "dashboard-state";
  status.textContent = patch.statusName;
  meta.append(status);

  if (showAuthor && patch.authorName) {
    const author = document.createElement("span");

    author.className = "dashboard-author";
    author.textContent = `Author: ${patch.authorName}`;
    meta.append(author);
  }

  if (patch.groups?.length) {
    const groups = document.createElement("span");

    groups.className = "dashboard-groups";
    groups.textContent = patch.groups.join(", ");
    meta.append(groups);
  }

  if (patch.ageLabel) {
    const age = document.createElement("span");

    age.className = `dashboard-age ${patch.ageState || ""}`.trim();
    age.textContent = `${patch.ageLabel} ${formatAge(patch.ageMs)}`;
    meta.append(age);
  }

  if (canUpdate) {
    const actions = document.createElement("details");
    const toggle = document.createElement("summary");
    const menu = document.createElement("div");
    actions.className = "dashboard-patch-actions";
    toggle.textContent = "Actions";
    toggle.setAttribute("aria-label", `Actions for ${patch.id}`);
    menu.className = "dashboard-patch-action-menu";
    menu.setAttribute("popover", "auto");
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", event => {
      event.preventDefault();
      if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
      actions.open = true;
      menu.showPopover();
      const bounds = toggle.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
      toggle.setAttribute("aria-expanded", "true");
      menu.querySelector("button:not(:disabled)")?.focus();
    });
    menu.addEventListener("toggle", event => {
      if (event.newState === "closed") {
        actions.open = false;
        toggle.setAttribute("aria-expanded", "false");
      }
    });
    for (const [label, mode, needsAi] of [
      ["Update", "freeform", true], ["Review Update", "update", true],
      ["Verify", "verify", true], ["Rebase", "rebase", false], ["CI Verify", "ci-verify", false],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.patchAction = mode;
      button.disabled = needsAi && !INTERACTIVE.aiEnabled;
      if (button.disabled) button.title = "Enable AI in the console to use this action.";
      button.addEventListener("click", () => {
        menu.hidePopover();
        actions.open = false;
        toggle.focus();
        if (needsAi) {
          if (!INTERACTIVE.aiEnabled) return;
          const graphIndex = GRAPHS.findIndex(graph =>
            String(graph.repository || graph.label || "").toLowerCase() === "comm" && graph.checkout !== "review");
          openPatchUpdateDialog({ patch, mode, graphIndex: graphIndex === -1 ? 0 : graphIndex });
        } else {
          void runDashboardPatchAction(patch, mode);
        }
      });
      menu.append(button);
    }
    actions.addEventListener("keydown", event => {
      if (event.key === "Escape") { menu.hidePopover(); actions.open = false; toggle.focus(); }
    });
    actions.append(toggle, menu);
    heading.append(actions);
  }

  if (canReview) {
    const review = document.createElement("button");

    review.className = "dashboard-patch-review";
    review.type = "button";
    review.textContent = "Review";
    review.disabled = !INTERACTIVE.aiEnabled;
    if (review.disabled) review.title = "Enable AI in the console to use this action.";
    review.addEventListener("click", () => { if (INTERACTIVE.aiEnabled) openPatchReviewDialog({ patch }); });
    heading.append(review, createReviewHandledButton(patch, {
      onError: error => { dashboardStatus.textContent = error.message; },
    }));
  }

  row.append(heading, meta);
  return row;
}

function createBugButton(bug, text = `Bug ${bug.id}: ${bug.summary}`) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dashboard-bug-title";
  button.textContent = text;
  button.addEventListener("click", () => {
    openDashboardBugDetail(bug.id).catch(error => { dashboardStatus.textContent = error.message; });
  });
  return button;
}

function createBugzillaLink(bug) {
  const link = createBugzillaIconLink({ ...bug, url: `https://bugzilla.mozilla.org/show_bug.cgi?id=${encodeURIComponent(bug.id)}` });
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function createAssignedBugRow(bug) {
  const row = document.createElement("article");
  const heading = document.createElement("div");
  const title = createBugButton(bug);
  const meta = document.createElement("div");
  const patchState = document.createElement("div");

  row.className = "dashboard-row dashboard-bug-row";
  heading.className = "dashboard-row-heading";
  heading.append(title, createBugzillaLink(bug));
  meta.className = "dashboard-row-meta";
  meta.textContent = [bug.status, bug.component].filter(Boolean).join(" | ");
  patchState.className = "dashboard-bug-patches";

  if (!bug.hasPatch) {
    patchState.textContent = "No open Phabricator patch";
  } else {
    for (const patch of bug.patches) {
      const patchLink = createLink({
        href: patch.url,
        text: `${patch.id} ${patch.statusName}`,
        className: "dashboard-link dashboard-patch-link",
      });

      patchState.append(patchLink);
    }
  }

  row.append(heading, meta, patchState);
  const implement = createImplementButton(bug);
  if (implement) row.append(implement);
  return row;
}

function createNeedinfoBugRow(bug) {
  const row = document.createElement("article");
  const heading = document.createElement("div");
  const title = createBugButton(bug);
  const meta = document.createElement("div");
  const requester = document.createElement("span");
  const age = document.createElement("span");

  row.className = [
    "dashboard-row",
    "dashboard-needinfo-row",
    bug.ageState ? `dashboard-row-${bug.ageState}` : "",
  ].filter(Boolean).join(" ");
  heading.className = "dashboard-row-heading";
  heading.append(title, createBugzillaLink(bug));
  meta.className = "dashboard-row-meta";
  meta.textContent = [bug.status, bug.component].filter(Boolean).join(" | ");
  requester.className = "dashboard-needinfo-requester";
  requester.textContent = bug.requestedBy
    ? `Requested by ${bug.requestedBy}`
    : "Needinfo request";
  age.className = `dashboard-age ${bug.ageState || ""}`.trim();
  age.textContent = formatAge(bug.ageMs);

  row.append(heading, meta, requester, age);
  return row;
}

function renderSection(sectionName, rows = []) {
  const section = dashboardPanel?.querySelector(
    `[data-dashboard-section="${sectionName}"]`,
  );

  if (!section) {
    return;
  }

  const count = section.querySelector(".dashboard-count");
  const container = section.querySelector(".dashboard-rows");

  const wasEmpty = section.classList.contains("is-empty");
  section.classList.toggle("is-empty", rows.length === 0);
  if (!rows.length) {
    if (!wasEmpty) section.dataset.openBeforeEmpty = String(section.open);
    section.open = false;
  } else if (wasEmpty) {
    section.open = section.dataset.openBeforeEmpty === "true";
  }
  count.textContent = String(rows.length);
  count.setAttribute(
    "aria-label",
    `${rows.length} ${rows.length === 1 ? "item" : "items"}`,
  );
  clearElement(container);

  if (!rows.length) {
    const empty = document.createElement("p");

    empty.className = "dashboard-empty";
    empty.textContent = "None";
    container.append(empty);
    return;
  }

  for (const row of rows) {
    container.append(
      sectionName === "assigned-bugs" || sectionName === "in-progress-bugs"
        ? createAssignedBugRow(row)
        : sectionName === "needinfo-bugs"
          ? createNeedinfoBugRow(row)
          : createPatchRow(row, {
            canUpdate: sectionName === "own-needs-revision" ||
              sectionName === "own-needs-review" || sectionName === "own-approved",
            canReview: sectionName === "direct-review" ||
              sectionName === "group-first-review" || sectionName === "handled-reviews",
            showAuthor: sectionName === "direct-review" ||
              sectionName === "group-first-review" || sectionName === "handled-reviews",
          }),
    );
  }
}

function updateDashboardSectionSizes() {
  for (const column of dashboardPanel.querySelectorAll(".dashboard-column-sections, .dashboard-bug-sections")) {
    column.style.setProperty("--dashboard-section-rows", [...column.children].map(section =>
      section.open ? "minmax(0, 1fr)" : "auto").join(" "));
  }
}

dashboardPanel?.addEventListener("toggle", event => {
  if (event.target.matches("[data-dashboard-section]")) updateDashboardSectionSizes();
}, true);

function renderDashboard(result) {
  lastDashboard = result;
  for (const [sectionName, resultKey] of sections) {
    renderSection(sectionName, result[resultKey] || []);
  }

  updateDashboardSectionSizes();

  const errors = result.errors || [];

  dashboardErrors.hidden = !errors.length;
  dashboardErrors.textContent = errors.join("\n");
  const status = result.user?.name
    ? `Open patches and bugs for ${result.user.name}.`
    : "Open patches and assigned bugs.";

  dashboardStatus.textContent = result.warning
    ? `${status} ${result.warning}`
    : status;
}

function setDashboardLoading(isLoading, message = "") {
  loadingDashboard = isLoading;
  dashboardPanel?.classList.toggle("is-loading", isLoading);
  dashboardPanel?.setAttribute("aria-busy", String(isLoading));
  dashboardRefresh.disabled = isLoading;
  dashboardRefresh.textContent = isLoading ? "Refreshing..." : "Refresh";
  dashboardLoading.hidden = !isLoading;

  if (isLoading && dashboardLoadingText) {
    dashboardLoadingText.textContent = message || "Loading dashboard...";
  }

  if (isLoading) {
    dashboardStatus.textContent = "Loading open patches, review queues, and assigned bugs...";
  }
}

export async function loadDashboard({ force = false } = {}) {
  if (!dashboardPanel || !INTERACTIVE.enabled || loadingDashboard) {
    return;
  }

  setDashboardLoading(
    true,
    force ? "Refreshing dashboard..." : "Loading dashboard...",
  );

  try {
    const response = await fetch(
      "/api/dashboard?token=" + encodeURIComponent(INTERACTIVE.token) +
        (force ? "&force=1" : ""),
      { cache: "no-store" },
    );
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not load the dashboard.");
    }

    renderDashboard(result);
    hasLoadedDashboard = true;
  } catch (error) {
    dashboardStatus.textContent = error?.message || String(error);
  } finally {
    setDashboardLoading(false);
  }
}

export function showDashboard({ updateLocation = true } = {}) {
  if (!dashboardPanel || !dashboardTab) {
    return;
  }

  document.body.classList.remove("graph-view-active");
  document.querySelectorAll(".tab, .panel").forEach((node) => {
    node.classList.remove("active");
  });
  document.querySelector(".meta-boards-panel").hidden = true;
  document.querySelector(".phabricator-cache-panel").hidden = true;
  document.querySelector(".sprint-panel").hidden = true;
  document.querySelector(".test-output-panel").hidden = true;
  dashboardTab.classList.add("active");
  dashboardPanel.hidden = false;
  void refreshImplementations();

  if (updateLocation) {
    setConsoleRoute({ view: "dashboard" });
  }

  if (!hasLoadedDashboard) {
    loadDashboard();
  }
}

function initializeDashboardReview() {
  const button = dashboardPanel.querySelector(".dashboard-review");
  const dialog = dashboardPanel.querySelector(".dashboard-review-dialog");
  if (!INTERACTIVE.aiEnabled || !button || !dialog) return;
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const error = dialog.querySelector('[role="alert"]');

  button.addEventListener("click", () => {
    form.reset();
    error.textContent = "";
    dialog.showModal();
    input.focus();
  });
  dialog.querySelector(".dashboard-review-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = input.value.trim();
    let revision = value.match(/^D?([1-9]\d*)$/i)?.[1];
    if (!revision) {
      try {
        const url = new URL(value);
        if (["http:", "https:"].includes(url.protocol)) {
          revision = url.pathname.match(/^\/D([1-9]\d*)(?:\/|$)/i)?.[1];
        }
      } catch {
        // Show the same input error for invalid links and revision numbers.
      }
    }
    if (!revision) {
      error.textContent = "Enter a patch link or D number, such as D123456.";
      input.focus();
      return;
    }
    dialog.close();
    void openPatchReviewDialog({ patch: { id: "D" + revision } });
  });
}

export function initializeDashboard() {
  if (!dashboardTab || !dashboardPanel) {
    return;
  }

  dashboardTab.addEventListener("click", showDashboard);
  dashboardRefresh.addEventListener("click", () => loadDashboard({ force: true }));
  initializeDashboardReview();
}
