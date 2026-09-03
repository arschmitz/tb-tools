import { INTERACTIVE } from "./config.js";
import {
  createColorAssignments,
  getAccessibleAssigneePillStyle,
} from "./meta-board-colors.js";
import { setConsoleRoute } from "./view-router.js";

const panel = document.querySelector(".sprint-panel");
const status = panel?.querySelector(".sprint-status");
const error = panel?.querySelector(".sprint-error");
const refresh = panel?.querySelector(".sprint-refresh");
const backToBoard = panel?.querySelector(".sprint-back-to-board");
const bugzillaLink = panel?.querySelector(".sprint-bugzilla-link");
const nameInput = panel?.querySelector(".sprint-name-input");
const startDate = panel?.querySelector(".sprint-start-date");
const deadlineInput = panel?.querySelector(".sprint-deadline-input");
const saveDetails = panel?.querySelector(".sprint-save-details");
const overview = panel?.querySelector(".sprint-overview");
const planning = panel?.querySelector(".sprint-planning");
const viewTabs = panel?.querySelectorAll(".sprint-view-tab");
const totalPoints = panel?.querySelector(".sprint-total-points");
const remainingPoints = panel?.querySelector(".sprint-remaining-points");
const inProgressPoints = panel?.querySelector(".sprint-in-progress-points");
const completePoints = panel?.querySelector(".sprint-complete-points");
const peopleCount = panel?.querySelector(".sprint-people-count");
const daysRemaining = panel?.querySelector(".sprint-days-remaining");
const burnDown = panel?.querySelector(".sprint-burndown");
const burnDownCaption = panel?.querySelector(".sprint-burndown-caption");
const people = panel?.querySelector(".sprint-people");
const overviewStoryPoints = panel?.querySelector(".sprint-overview-story-points");
const overviewStoryGroups = panel?.querySelector(".sprint-overview-story-groups");
const assigneeFilter = panel?.querySelector(".sprint-assignee-filter");
const metaFilter = panel?.querySelector(".sprint-meta-filter");
const createDialog = document.getElementById("sprint-create-dialog");
const createForm = createDialog?.querySelector(".sprint-create-form");
const createName = createDialog?.querySelector(".sprint-create-name");
const createDeadline = createDialog?.querySelector(".sprint-create-deadline");
const createError = createDialog?.querySelector(".sprint-create-error");
const createClose = createDialog?.querySelector(".sprint-create-close");
const createCancel = createDialog?.querySelector(".sprint-create-cancel");
const createSubmit = createDialog?.querySelector(".sprint-create-submit");
const rolloverDialog = document.getElementById("sprint-rollover-dialog");
const rolloverForm = rolloverDialog?.querySelector(".sprint-rollover-form");
const rolloverSummary = rolloverDialog?.querySelector(".sprint-rollover-summary");
const rolloverStories = rolloverDialog?.querySelector(".sprint-rollover-stories");
const rolloverError = rolloverDialog?.querySelector(".sprint-rollover-error");
const rolloverClose = rolloverDialog?.querySelector(".sprint-rollover-close");
const rolloverCancel = rolloverDialog?.querySelector(".sprint-rollover-cancel");
const rolloverSubmit = rolloverDialog?.querySelector(".sprint-rollover-submit");

const ASSIGNEE_COLORS = [
  "#0f766e",
  "#a21caf",
  "#1d4ed8",
  "#b45309",
  "#be123c",
  "#047857",
  "#7c3aed",
  "#c2410c",
];

const state = {
  assigneeColors: new Map(),
  boardId: "",
  current: null,
  loading: false,
  metaColors: new Map(),
  openBugDetail: null,
  pendingRollover: null,
  sprintId: "",
  view: "overview",
};

function getApiUrl(path, parameters = {}) {
  const url = new URL(path, window.location.origin);

  url.searchParams.set("token", INTERACTIVE.token);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

async function request(path, {
  body,
  method = "GET",
  parameters,
} = {}) {
  const response = await fetch(getApiUrl(path, parameters), {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify({ token: INTERACTIVE.token, ...body }) : undefined,
  });
  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Sprint request failed.");
  }

  return result;
}

function clear(node) {
  node?.replaceChildren();
}

function setStatus(message = "") {
  if (status) {
    status.textContent = message;
  }
}

function setError(message = "") {
  if (!error) {
    return;
  }

  error.hidden = !message;
  error.textContent = message;
}

function formatPoints(points) {
  return `${points || 0} point${Number(points || 0) === 1 ? "" : "s"}`;
}

function formatDate(value) {
  if (!value) {
    return "Not set";
  }

  const timestamp = Date.parse(`${value}T12:00:00Z`);

  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp)
    : value;
}

function getDefaultDeadline(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysUntilFriday = (5 - date.getDay() + 7) % 7;

  date.setDate(date.getDate() + daysUntilFriday + 14);
  return date.toISOString().slice(0, 10);
}

function getCardPoints(cards = []) {
  return cards.reduce((total, card) => total + (Number(card.points) || 0), 0);
}

function matchesFilters(card) {
  return (
    (!assigneeFilter?.value || card.assignee?.email === assigneeFilter.value) &&
    (!metaFilter?.value || card.parentMeta?.id === metaFilter.value)
  );
}

function createBugLink(card) {
  const link = document.createElement("a");

  link.className = "meta-board-card-id";
  link.href = card.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = `Bug ${card.id}`;
  link.title = `Open Bug ${card.id} in Bugzilla`;
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function openBug(card) {
  if (!state.openBugDetail) {
    return;
  }

  state.openBugDetail(card.id, { boardId: state.boardId });
}

function createCard(card, { member = false } = {}) {
  const element = document.createElement("article");
  const heading = document.createElement("div");
  const title = document.createElement("h4");
  const meta = document.createElement("div");
  const parent = document.createElement("div");
  const parentButton = document.createElement("button");
  const action = document.createElement("button");

  element.className = "meta-board-card sprint-card";
  element.tabIndex = 0;
  element.style.setProperty(
    "--meta-board-card-color",
    state.metaColors.get(card.parentMeta?.id) || "#2563eb",
  );
  heading.className = "meta-board-card-heading";
  heading.append(createBugLink(card));
  title.textContent = card.summary;
  meta.className = "meta-board-card-meta";
  meta.append(document.createTextNode(formatPoints(card.points)));

  if (card.assignee) {
    const assignee = document.createElement("span");
    const pillStyle = getAccessibleAssigneePillStyle(
      state.assigneeColors.get(card.assignee.email) || ASSIGNEE_COLORS[0],
    );

    assignee.className = "meta-board-assignee";
    assignee.style.setProperty("--meta-board-assignee-accent", pillStyle.accent);
    assignee.style.setProperty("--meta-board-assignee-background", pillStyle.background);
    assignee.style.setProperty("--meta-board-assignee-foreground", pillStyle.foreground);
    assignee.textContent = card.assignee.name;
    meta.append(assignee);
  }

  parent.className = "meta-board-card-parent";
  parentButton.className = "meta-board-card-parent-link";
  parentButton.type = "button";
  parentButton.textContent = card.parentMeta?.summary || "Meta board";
  parentButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openBug({ id: card.parentMeta?.id });
  });
  parent.append(parentButton);
  action.className = "sprint-card-membership";
  action.type = "button";
  action.textContent = member ? "Remove" : "Add to Sprint";
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    setMembership(card.id, !member).catch((requestError) => setError(requestError.message));
  });
  element.append(heading, title, meta, parent, action);
  element.addEventListener("click", () => openBug(card));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openBug(card);
    }
  });
  return element;
}

function populateSelect(select, entries, { getLabel, getValue, initialLabel }) {
  if (!select) {
    return;
  }

  const previous = select.value;

  clear(select);
  const initial = document.createElement("option");

  initial.value = "";
  initial.textContent = initialLabel;
  select.append(initial);
  entries.forEach((entry) => {
    const option = document.createElement("option");

    option.value = getValue(entry);
    option.textContent = getLabel(entry);
    select.append(option);
  });
  select.value = Array.from(select.options).some((option) => option.value === previous)
    ? previous
    : "";
}

function setView(view, { updateLocation = true } = {}) {
  state.view = view === "planning" ? "planning" : "overview";
  overview.hidden = state.view !== "overview";
  planning.hidden = state.view !== "planning";
  viewTabs?.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.sprintView === state.view);
  });

  if (updateLocation && state.boardId && state.sprintId) {
    setConsoleRoute({
      boardId: state.boardId,
      sprintId: state.sprintId,
      sprintView: state.view,
      view: "sprint",
    });
  }
}

function renderBurnDown(series = []) {
  clear(burnDown);

  if (!series.length) {
    burnDownCaption.textContent = "Set an end date to show the burndown.";
    return;
  }

  const values = series.flatMap((item) => [item.ideal, item.actual].filter(Number.isFinite));
  const maximum = Math.max(1, ...values);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const width = 700;
  const height = 180;
  const padding = 22;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const point = (index, value) => {
    const x = padding + (series.length === 1 ? plotWidth : (plotWidth * index) / (series.length - 1));
    const y = height - padding - (plotHeight * value) / maximum;

    return `${x},${y}`;
  };
  const ideal = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  const actual = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  const latest = series.findLast((item) => Number.isFinite(item.actual));

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("sprint-burndown-chart");
  ideal.classList.add("sprint-burndown-ideal");
  ideal.setAttribute("points", series.map((item, index) => point(index, item.ideal)).join(" "));
  actual.classList.add("sprint-burndown-actual");
  actual.setAttribute("points", series
    .map((item, index) => Number.isFinite(item.actual) ? point(index, item.actual) : "")
    .filter(Boolean)
    .join(" "));
  svg.append(ideal, actual);

  if (latest) {
    const index = series.indexOf(latest);
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const [cx, cy] = point(index, latest.actual).split(",");

    marker.classList.add("sprint-burndown-marker");
    marker.setAttribute("cx", cx);
    marker.setAttribute("cy", cy);
    marker.setAttribute("r", "5");
    svg.append(marker);
  }

  burnDown.append(svg);
  burnDownCaption.textContent = latest
    ? `Ideal plan and ${latest.actual} points remaining today.`
    : "Ideal plan.";
}

function renderPeople(items = []) {
  clear(people);

  if (!items.length) {
    const empty = document.createElement("p");

    empty.className = "sprint-empty";
    empty.textContent = "No sprint stories are assigned yet.";
    people.append(empty);
    return;
  }

  items.forEach((person) => {
    const row = document.createElement("div");
    const name = document.createElement("strong");
    const totals = document.createElement("span");

    row.className = "sprint-person";
    name.textContent = person.name;
    totals.textContent = `${person.completePoints} complete, ${person.remainingPoints} remaining`;
    row.append(name, totals);
    people.append(row);
  });
}

function renderOverviewGroups(groups = []) {
  clear(overviewStoryGroups);

  if (!groups.length) {
    const empty = document.createElement("p");

    empty.className = "sprint-empty";
    empty.textContent = "No stories are in this sprint.";
    overviewStoryGroups.append(empty);
    return;
  }

  groups.forEach((group) => {
    const section = document.createElement("section");
    const heading = document.createElement("header");
    const title = document.createElement("h4");
    const points = document.createElement("span");
    const cards = document.createElement("div");

    section.className = "sprint-story-group";
    cards.className = "sprint-story-group-cards";
    title.textContent = group.name;
    points.textContent = formatPoints(group.points);
    heading.append(title, points);
    group.cards.filter(matchesFilters).forEach((card) => cards.append(createCard(card, { member: true })));
    if (!cards.childElementCount) {
      cards.textContent = "No matching stories";
    }
    section.append(heading, cards);
    overviewStoryGroups.append(section);
  });
}

function renderPlanning() {
  if (!state.current) {
    return;
  }

  panel.querySelectorAll(".sprint-column").forEach((column) => {
    const columnId = column.dataset.sprintColumn;
    const cards = (state.current.columns?.[columnId]?.cards || []).filter(matchesFilters);
    const headerValue = column.querySelector("header span");
    const container = column.querySelector(".sprint-cards");

    clear(container);
    headerValue.textContent = formatPoints(getCardPoints(cards));

    if (columnId !== "sprint") {
      cards.forEach((card) => container.append(createCard(card)));
    } else {
      state.current.groups.forEach((group) => {
        const groupCards = group.cards.filter(matchesFilters);

        if (!groupCards.length) {
          return;
        }

        const groupElement = document.createElement("section");
        const heading = document.createElement("header");
        const name = document.createElement("h4");
        const points = document.createElement("span");

        groupElement.className = "sprint-story-group";
        name.textContent = group.name;
        points.textContent = formatPoints(getCardPoints(groupCards));
        heading.append(name, points);
        groupElement.append(heading);
        groupCards.forEach((card) => groupElement.append(createCard(card, { member: true })));
        container.append(groupElement);
      });
    }

    if (!container.childElementCount) {
      const empty = document.createElement("p");

      empty.className = "sprint-empty";
      empty.textContent = "No stories";
      container.append(empty);
    }
  });
}

function render() {
  const sprint = state.current;

  if (!sprint) {
    return;
  }

  state.metaColors = new Map(Object.entries(sprint.metaColors || {}));
  state.assigneeColors = createColorAssignments(
    [
      ...(sprint.cards || []),
      ...Object.values(sprint.columns || {}).flatMap((column) => column.cards || []),
    ].map((card) => card.assignee?.email),
    ASSIGNEE_COLORS,
  );
  setStatus(`${sprint.summary} | ${formatDate(sprint.startDate)} to ${formatDate(sprint.endDate)}`);
  bugzillaLink.hidden = !sprint.url;
  bugzillaLink.href = sprint.url;
  nameInput.value = sprint.name;
  startDate.value = formatDate(sprint.startDate);
  deadlineInput.value = sprint.endDate || "";
  totalPoints.textContent = formatPoints(sprint.stats.totalPoints);
  remainingPoints.textContent = formatPoints(sprint.stats.remainingPoints);
  inProgressPoints.textContent = formatPoints(sprint.stats.inProgressPoints);
  completePoints.textContent = formatPoints(sprint.stats.completePoints);
  peopleCount.textContent = `${sprint.stats.peopleWithPoints}`;
  daysRemaining.textContent = sprint.daysRemaining === null
    ? "Not set"
    : `${sprint.daysRemaining}`;
  overviewStoryPoints.textContent = formatPoints(sprint.stats.totalPoints);
  populateSelect(assigneeFilter, sprint.assignees || [], {
    getLabel: (assignee) => assignee.name,
    getValue: (assignee) => assignee.email,
    initialLabel: "All assignees",
  });
  populateSelect(metaFilter, sprint.childMetas || [], {
    getLabel: (meta) => `Bug ${meta.id}: ${meta.summary}`,
    getValue: (meta) => meta.id,
    initialLabel: "All child metas",
  });
  renderBurnDown(sprint.burnDown);
  renderPeople(sprint.stats.people);
  renderOverviewGroups(sprint.groups);
  renderPlanning();
  setView(state.view, { updateLocation: false });
}

function setLoading(isLoading, message = "") {
  state.loading = isLoading;
  refresh.disabled = isLoading;
  saveDetails.disabled = isLoading;

  if (isLoading && message) {
    setStatus(message);
  }
}

async function loadSprint({ force = false } = {}) {
  if (!state.boardId || !state.sprintId || state.loading) {
    return;
  }

  setLoading(true, "Loading sprint...");
  setError("");

  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(state.boardId)}/sprints/${encodeURIComponent(state.sprintId)}`,
      { parameters: { force: force ? "1" : "" } },
    );

    state.current = result.sprint;
    render();
  } catch (requestError) {
    setError(requestError?.message || String(requestError));
  } finally {
    setLoading(false);
  }
}

async function setMembership(storyId, member) {
  if (!state.current) {
    return;
  }

  setError("");
  setStatus(member ? "Adding story to sprint..." : "Removing story from sprint...");
  const result = await request(
    `/api/meta-boards/${encodeURIComponent(state.boardId)}/sprints/${encodeURIComponent(state.sprintId)}/stories/${encodeURIComponent(storyId)}`,
    { body: { member }, method: "PUT" },
  );

  state.current = result.sprint;
  render();
}

async function saveSprintDetails() {
  if (!state.current) {
    return;
  }

  const changes = {};

  if (nameInput.value.trim() !== state.current.name) {
    changes.name = nameInput.value;
  }

  if (deadlineInput.value !== (state.current.endDate || "")) {
    changes.deadline = deadlineInput.value;
  }

  if (!Object.keys(changes).length) {
    return;
  }

  setLoading(true, "Saving sprint details...");
  setError("");
  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(state.boardId)}/sprints/${encodeURIComponent(state.sprintId)}`,
      { body: { changes }, method: "PUT" },
    );

    state.current = result.sprint;
    render();
  } catch (requestError) {
    setError(requestError?.message || String(requestError));
  } finally {
    setLoading(false);
  }
}

function getPreviousSprintOpenStories() {
  const rollover = state.pendingRollover;
  const cards = new Map(Object.values(rollover?.sprint?.columns || {})
    .flatMap((column) => column.cards || [])
    .map((card) => [card.id, card]));

  return (rollover?.previousSprint?.dependsOn || [])
    .map((id) => cards.get(id))
    .filter((card) => card && card.column !== "complete");
}

function getRolloverMode() {
  return rolloverDialog?.querySelector('input[name="sprint-rollover"]:checked')?.value || "all";
}

function renderRolloverStories() {
  const mode = getRolloverMode();
  const stories = getPreviousSprintOpenStories();

  rolloverStories.hidden = mode !== "selected";
  clear(rolloverStories);

  stories.forEach((story) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const text = document.createElement("span");

    checkbox.checked = true;
    checkbox.type = "checkbox";
    checkbox.value = story.id;
    text.textContent = `Bug ${story.id}: ${story.summary} (${formatPoints(story.points)})`;
    label.append(checkbox, text);
    rolloverStories.append(label);
  });
}

function openRolloverDialog() {
  const previous = state.pendingRollover?.previousSprint;
  const stories = getPreviousSprintOpenStories();

  rolloverError.textContent = "";
  rolloverSummary.textContent = previous
    ? `${previous.summary} has ${stories.length} open board stories. Choose how to finish it.`
    : "";
  renderRolloverStories();
  rolloverDialog.showModal();
}

async function submitRollover(event) {
  event.preventDefault();

  const mode = getRolloverMode();
  const stories = getPreviousSprintOpenStories();
  const storyIds = mode === "all"
    ? stories.map((story) => story.id)
    : mode === "selected"
      ? Array.from(rolloverStories.querySelectorAll("input:checked"), (input) => input.value)
      : [];

  rolloverSubmit.disabled = true;
  rolloverError.textContent = "";
  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(state.pendingRollover.boardId)}/sprints/${encodeURIComponent(state.pendingRollover.sprint.id)}/rollover`,
      {
        body: {
          previousSprintId: state.pendingRollover.previousSprint.id,
          removeStoryIds: stories.map((story) => story.id),
          storyIds,
        },
        method: "POST",
      },
    );

    state.pendingRollover = null;
    rolloverDialog.close();
    state.current = result.sprint;
    state.boardId = result.sprint.boardId;
    state.sprintId = result.sprint.id;
    setView("planning");
    render();
  } catch (requestError) {
    rolloverError.textContent = requestError?.message || String(requestError);
  } finally {
    rolloverSubmit.disabled = false;
  }
}

function deferRollover() {
  const pending = state.pendingRollover;

  if (!pending) {
    rolloverDialog.close();
    return;
  }

  state.pendingRollover = null;
  rolloverDialog.close();
  state.current = pending.sprint;
  state.boardId = pending.boardId;
  state.sprintId = pending.sprint.id;
  setView("planning");
  render();
  setError("The previous sprint remains open and keeps its current stories.");
}

export function openSprintCreateDialog(boardId) {
  if (!boardId || !createDialog) {
    return;
  }

  state.boardId = boardId;
  createName.value = "";
  createDeadline.value = getDefaultDeadline();
  createError.textContent = "";
  createDialog.showModal();
  createName.focus();
}

async function submitSprintCreate(event) {
  event.preventDefault();

  createSubmit.disabled = true;
  createError.textContent = "";
  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(state.boardId)}/sprints`,
      {
        body: {
          deadline: createDeadline.value,
          name: createName.value,
        },
        method: "POST",
      },
    );

    createDialog.close();
    state.current = result.sprint;
    state.sprintId = result.sprint.id;
    state.view = "planning";
    if (result.previousSprint) {
      state.pendingRollover = {
        boardId: state.boardId,
        previousSprint: result.previousSprint,
        sprint: result.sprint,
      };
      openRolloverDialog();
      return;
    }

    await showSprint({
      boardId: state.boardId,
      sprintId: state.sprintId,
      sprintView: "planning",
    });
  } catch (requestError) {
    createError.textContent = requestError?.message || String(requestError);
  } finally {
    createSubmit.disabled = false;
  }
}

export function hideSprints() {
  panel?.setAttribute("hidden", "");
}

export async function showSprint({
  boardId,
  sprintId,
  sprintView = "overview",
  updateLocation = true,
} = {}) {
  if (!panel || !boardId || !sprintId) {
    return;
  }

  document.querySelectorAll(".tab, .panel").forEach((node) => node.classList.remove("active"));
  document.querySelector(".dashboard-panel")?.setAttribute("hidden", "");
  document.querySelector(".meta-boards-panel")?.setAttribute("hidden", "");
  document.querySelector(".test-output-panel")?.setAttribute("hidden", "");
  panel.hidden = false;
  state.boardId = boardId;
  state.sprintId = sprintId;
  setView(sprintView, { updateLocation });
  await loadSprint();
}

export function initializeSprints({ openBugDetail } = {}) {
  if (!panel || !INTERACTIVE.enabled) {
    return;
  }

  state.openBugDetail = openBugDetail;
  refresh.addEventListener("click", () => loadSprint({ force: true }));
  backToBoard.addEventListener("click", () => {
    setConsoleRoute({ boardId: state.boardId, view: "meta-boards" });
  });
  saveDetails.addEventListener("click", saveSprintDetails);
  assigneeFilter.addEventListener("change", () => {
    renderOverviewGroups(state.current?.groups);
    renderPlanning();
  });
  metaFilter.addEventListener("change", () => {
    renderOverviewGroups(state.current?.groups);
    renderPlanning();
  });
  viewTabs.forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.sprintView)));
  createForm.addEventListener("submit", submitSprintCreate);
  createClose.addEventListener("click", () => createDialog.close());
  createCancel.addEventListener("click", () => createDialog.close());
  rolloverForm.addEventListener("submit", submitRollover);
  rolloverDialog.querySelectorAll('input[name="sprint-rollover"]').forEach((input) => {
    input.addEventListener("change", renderRolloverStories);
  });
  rolloverClose.addEventListener("click", deferRollover);
  rolloverCancel.addEventListener("click", deferRollover);
  rolloverDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    deferRollover();
  });
}
