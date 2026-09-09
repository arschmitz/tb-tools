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
  openBugDetail: null,
  pendingRollover: null,
  pendingStoryIds: new Set(),
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

function compareCardsByAssignee(left, right) {
  const leftAssignee = left.assignee?.name || "Unassigned";
  const rightAssignee = right.assignee?.name || "Unassigned";
  const assigneeComparison = leftAssignee.localeCompare(rightAssignee);

  if (assigneeComparison) {
    return assigneeComparison;
  }

  return left.summary.localeCompare(right.summary) || left.id.localeCompare(right.id);
}

function matchesFilters(card) {
  return (
    (!assigneeFilter?.value || card.assignee?.email === assigneeFilter.value) &&
    (!metaFilter?.value || card.parentMeta?.id === metaFilter.value)
  );
}

function createSprintBugLink(card) {
  const link = document.createElement("a");

  link.className = "sprint-story-id";
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

  state.openBugDetail(card.id, { boardId: state.boardId, sprintId: state.sprintId });
}

function createStoryRow(card) {
  const element = document.createElement("article");
  const summary = document.createElement("button");
  const meta = document.createElement("div");

  element.className = "sprint-story-row";
  summary.className = "sprint-story-summary";
  summary.type = "button";
  summary.textContent = card.summary;
  summary.addEventListener("click", () => openBug(card));
  meta.className = "sprint-story-meta";
  if (state.pendingStoryIds.has(card.id)) {
    const pending = document.createElement("span");

    pending.className = "sprint-story-pending";
    pending.setAttribute("aria-label", "Saving sprint membership");
    pending.setAttribute("role", "status");
    pending.title = "Saving sprint membership";
    meta.append(pending);
  }
  meta.append(document.createTextNode(formatPoints(card.points)));

  if (card.assignee) {
    const assignee = document.createElement("span");
    const pillStyle = getAccessibleAssigneePillStyle(
      state.assigneeColors.get(card.assignee.email) || ASSIGNEE_COLORS[0],
    );

    assignee.className = "sprint-story-assignee";
    assignee.style.setProperty("--sprint-story-assignee-accent", pillStyle.accent);
    assignee.style.setProperty("--sprint-story-assignee-background", pillStyle.background);
    assignee.style.setProperty("--sprint-story-assignee-foreground", pillStyle.foreground);
    assignee.textContent = card.assignee.name;
    meta.append(assignee);
  }

  element.append(createSprintBugLink(card), summary, meta);
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
    group.cards.filter(matchesFilters).forEach((card) => cards.append(createStoryRow(card)));
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
    const orderedCards = columnId === "sprint" ? cards.sort(compareCardsByAssignee) : cards;

    clear(container);
    headerValue.textContent = formatPoints(getCardPoints(cards));

    orderedCards.forEach((card) => {
      container.append(createStoryRow(card));
    });

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

function getSprintStoryLocation(storyId) {
  return Object.entries(state.current?.columns || {}).find(([, column]) => (
    column.cards.some((card) => card.id === String(storyId))
  ))?.[0] || "";
}

function getSprintPlanningColumn(card) {
  if (!card) {
    return "";
  }

  return ["assigned", "in-progress", "in-review", "complete"].includes(card.column)
    ? "assigned"
    : card.column;
}

function getSprintStoryCards() {
  return state.current?.columns?.sprint?.cards || [];
}

function updateSprintDerivedData() {
  const cards = getSprintStoryCards();
  const groups = new Map();
  const people = new Map();
  const totalPoints = getCardPoints(cards);
  const completePoints = getCardPoints(cards.filter((card) => card.column === "complete"));
  const inProgressPoints = getCardPoints(cards.filter((card) => (
    ["in-progress", "in-review"].includes(card.column)
  )));

  cards.forEach((card) => {
    const assignee = card.assignee || { email: "", name: "Unassigned" };
    const key = assignee.email || "unassigned";
    const group = groups.get(key) || { cards: [], name: assignee.name || "Unassigned", points: 0 };
    const person = people.get(key) || {
      completePoints: 0,
      name: assignee.name || "Unassigned",
      points: 0,
      remainingPoints: 0,
    };
    const points = Number(card.points) || 0;

    group.cards.push(card);
    group.points += points;
    person.points += points;
    if (card.column === "complete") {
      person.completePoints += points;
    } else {
      person.remainingPoints += points;
    }
    groups.set(key, group);
    people.set(key, person);
  });
  state.current.cards = [...cards];
  state.current.groups = Array.from(groups.values()).sort((first, second) => (
    first.name.localeCompare(second.name)
  ));
  state.current.stats = {
    ...state.current.stats,
    completePoints,
    inProgressPoints,
    people: Array.from(people.values()).sort((first, second) => first.name.localeCompare(second.name)),
    peopleWithPoints: Array.from(people.values()).filter((person) => person.points > 0).length,
    remainingPoints: Math.max(0, totalPoints - completePoints),
    totalPoints,
  };
}

export async function setSprintStoryMembership({ boardId, member, sprintId, storyId } = {}) {
  const hasCurrentSprint = Boolean(
    state.current && state.boardId === String(boardId) && state.sprintId === String(sprintId),
  );
  const snapshot = hasCurrentSprint
    ? {
      cards: [...(state.current?.cards || [])],
      columns: Object.fromEntries(Object.entries(state.current?.columns || {}).map(([id, column]) => [
        id,
        [...column.cards],
      ])),
      groups: [...(state.current?.groups || [])],
      stats: { ...state.current?.stats },
    }
    : null;

  if (hasCurrentSprint) {
    const sourceColumn = getSprintStoryLocation(storyId);
    const destinationColumn = member
      ? "sprint"
      : getSprintPlanningColumn(
        state.current.columns.sprint.cards.find((card) => card.id === String(storyId)),
      );
    const source = state.current.columns[sourceColumn]?.cards || [];
    const destination = state.current.columns[destinationColumn]?.cards || [];
    const story = source.find((card) => card.id === String(storyId));

    if (!story || !destinationColumn || sourceColumn === destinationColumn) {
      throw new Error("The story is not available for this sprint membership change.");
    }

    source.splice(source.indexOf(story), 1);
    destination.push(story);
    state.pendingStoryIds.add(story.id);
    updateSprintDerivedData();
    render();
  }

  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(boardId)}/sprints/${encodeURIComponent(sprintId)}/stories/${encodeURIComponent(storyId)}`,
      { body: { member }, method: "PUT" },
    );

    if (hasCurrentSprint) {
      state.pendingStoryIds.delete(String(storyId));
      state.current = result.sprint;
      render();
    }
    return result.sprint;
  } catch (requestError) {
    if (hasCurrentSprint && snapshot) {
      state.current.cards = snapshot.cards;
      Object.entries(snapshot.columns).forEach(([id, cards]) => {
        state.current.columns[id].cards = cards;
      });
      state.current.groups = snapshot.groups;
      state.current.stats = snapshot.stats;
      state.pendingStoryIds.delete(String(storyId));
      render();
    }
    throw requestError;
  }
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

  document.body.classList.remove("graph-view-active");
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
