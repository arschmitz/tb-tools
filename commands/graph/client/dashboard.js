import { GRAPHS, INTERACTIVE } from "./config.js";
import { openPatchUpdateDialog } from "./patch-update-dialog.js";
import { openPatchReviewDialog } from "./patch-review-dialog.js";
import { setConsoleRoute } from "./view-router.js";

const dashboardTab = document.querySelector(".dashboard-tab");
const dashboardPanel = document.querySelector(".dashboard-panel");
const dashboardStatus = dashboardPanel?.querySelector(".dashboard-status");
const dashboardRefresh = dashboardPanel?.querySelector(".dashboard-refresh");
const dashboardLoading = dashboardPanel?.querySelector(".dashboard-loading");
const dashboardLoadingText = dashboardPanel?.querySelector(".dashboard-loading-text");
const dashboardErrors = dashboardPanel?.querySelector(".dashboard-errors");

const sections = new Map([
  ["own-needs-revision", "ownNeedsRevision"],
  ["direct-review", "directlyAssignedWaitingOnReview"],
  ["own-needs-review", "ownNeedsReview"],
  ["group-first-review", "groupWaitingForFirstReview"],
  ["needinfo-bugs", "needinfoBugs"],
  ["in-progress-bugs", "inProgressBugs"],
  ["assigned-bugs", "assignedBugs"],
]);

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
    links.append(createLink({
      href: `https://bugzilla.mozilla.org/show_bug.cgi?id=${patch.bugId}`,
      text: `Bug ${patch.bugId}`,
      className: "dashboard-link",
    }));
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
    const update = document.createElement("button");

    update.className = "dashboard-patch-update";
    update.type = "button";
    update.textContent = "Update";
    update.addEventListener("click", () => {
      const graphIndex = GRAPHS.findIndex((graph) => (
        String(graph.repository || graph.label || "").toLowerCase() === "comm" &&
        graph.checkout !== "review"
      ));

      openPatchUpdateDialog({
        patch,
        graphIndex: graphIndex === -1 ? 0 : graphIndex,
      });
    });
    heading.append(update);
  }

  if (canReview) {
    const review = document.createElement("button");

    review.className = "dashboard-patch-review";
    review.type = "button";
    review.textContent = "Review";
    review.addEventListener("click", () => openPatchReviewDialog({ patch }));
    heading.append(review);
  }

  row.append(heading, meta);
  return row;
}

function createAssignedBugRow(bug) {
  const row = document.createElement("article");
  const heading = document.createElement("div");
  const title = document.createElement("a");
  const meta = document.createElement("div");
  const patchState = document.createElement("div");

  row.className = "dashboard-row dashboard-bug-row";
  heading.className = "dashboard-row-heading";
  title.className = "dashboard-bug-title";
  title.href = bug.url;
  title.textContent = `Bug ${bug.id}: ${bug.summary}`;
  heading.append(title);
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
  return row;
}

function createNeedinfoBugRow(bug) {
  const row = document.createElement("article");
  const heading = document.createElement("div");
  const title = document.createElement("a");
  const meta = document.createElement("div");
  const requester = document.createElement("span");
  const age = document.createElement("span");

  row.className = [
    "dashboard-row",
    "dashboard-needinfo-row",
    bug.ageState ? `dashboard-row-${bug.ageState}` : "",
  ].filter(Boolean).join(" ");
  heading.className = "dashboard-row-heading";
  title.className = "dashboard-bug-title";
  title.href = bug.url;
  title.textContent = `Bug ${bug.id}: ${bug.summary}`;
  heading.append(title);
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
              sectionName === "own-needs-review",
            canReview: sectionName === "direct-review" ||
              sectionName === "group-first-review",
            showAuthor: sectionName === "direct-review" ||
              sectionName === "group-first-review",
          }),
    );
  }
}

function renderDashboard(result) {
  for (const [sectionName, resultKey] of sections) {
    renderSection(sectionName, result[resultKey] || []);
  }

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
  document.querySelector(".test-output-panel").hidden = true;
  dashboardTab.classList.add("active");
  dashboardPanel.hidden = false;

  if (updateLocation) {
    setConsoleRoute({ view: "dashboard" });
  }

  if (!hasLoadedDashboard) {
    loadDashboard();
  }
}

export function initializeDashboard() {
  if (!dashboardTab || !dashboardPanel) {
    return;
  }

  dashboardTab.addEventListener("click", showDashboard);
  dashboardRefresh.addEventListener("click", () => loadDashboard({ force: true }));
}
