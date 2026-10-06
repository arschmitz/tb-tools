import { INTERACTIVE } from "./config.js";
import {
  createColorAssignments,
  getAccessibleAssigneePillStyle,
} from "./meta-board-colors.js";
import { renderMarkdown } from "./markdown.js";
import {
  openSprintCreateDialog,
  setSprintStoryMembership,
  showSprint,
} from "./sprints.js";
import { setConsoleRoute } from "./view-router.js";

const tab = document.querySelector(".meta-boards-tab");
const panel = document.querySelector(".meta-boards-panel");
const status = panel?.querySelector(".meta-boards-status");
const loadingIndicator = panel?.querySelector(".meta-boards-loading");
const loadingText = panel?.querySelector(".meta-boards-loading-text");
const controls = panel?.querySelector(".meta-board-controls");
const select = panel?.querySelector(".meta-board-select");
const rootLinks = panel?.querySelector(".meta-board-root-links");
const assigneeFilter = panel?.querySelector(".meta-board-assignee-filter");
const metaFilter = panel?.querySelector(".meta-board-meta-filter");
const sprintSelect = panel?.querySelector(".meta-board-sprint-select");
const newSprint = panel?.querySelector(".meta-board-new-sprint");
const refresh = panel?.querySelector(".meta-board-refresh");
const error = panel?.querySelector(".meta-boards-error");
const empty = panel?.querySelector(".meta-board-empty");
const kanban = panel?.querySelector(".meta-board-kanban");
const managerDialog = document.getElementById("meta-board-manager-dialog");
const managerForm = managerDialog?.querySelector(".meta-board-manager-form");
const managerId = managerDialog?.querySelector(".meta-board-manager-id");
const managerStatus = managerDialog?.querySelector(".meta-board-manager-status");
const managerList = managerDialog?.querySelector(".meta-board-manager-list");
const managerClose = managerDialog?.querySelector(".meta-board-manager-close");
const managerCancel = managerDialog?.querySelector(".meta-board-manager-cancel");
const dialog = document.getElementById("meta-board-dialog");
const detailForm = dialog?.querySelector(".meta-board-detail-form");
const detailTitle = dialog?.querySelector(".meta-board-detail-title");
const detailLinks = dialog?.querySelector(".meta-board-detail-links");
const detailBugzilla = dialog?.querySelector(".meta-board-detail-bugzilla");
const detailStatus = dialog?.querySelector(".meta-board-detail-status");
const detailSummary = dialog?.querySelector(".meta-board-detail-summary");
const detailPoints = dialog?.querySelector(".meta-board-detail-points");
const detailAssignee = dialog?.querySelector(".meta-board-detail-assignee");
const detailAssigneeOptions = dialog?.querySelector("#meta-board-assignees");
const detailDependsLinks = dialog?.querySelector(".meta-board-detail-depends-links");
const detailBlocksLinks = dialog?.querySelector(".meta-board-detail-blocks-links");
const detailDescription = dialog?.querySelector(".meta-board-detail-description");
const detailDescriptionRendered = dialog?.querySelector(".meta-board-detail-description-rendered");
const detailDescriptionEdit = dialog?.querySelector(".meta-board-description-edit");
const detailComments = dialog?.querySelector(".meta-board-detail-comments");
const detailCommentsCount = dialog?.querySelector(".meta-board-detail-comments-count");
const detailCommentsList = dialog?.querySelector(".meta-board-detail-comments-list");
const detailError = dialog?.querySelector(".meta-board-detail-error");
const detailSave = dialog?.querySelector(".meta-board-detail-save");
const detailSprintMembership = dialog?.querySelector(".meta-board-detail-sprint-membership");
const detailClose = dialog?.querySelector(".meta-board-detail-close");
const detailCancel = dialog?.querySelector(".meta-board-detail-cancel");
const relationAddButtons = dialog?.querySelectorAll(".meta-board-relation-add");
const relationDialog = document.getElementById("meta-board-relation-dialog");
const relationAddForm = relationDialog?.querySelector(".meta-board-relation-add-form");
const relationAddTitle = relationDialog?.querySelector(".meta-board-relation-add-title");
const relationAddId = relationDialog?.querySelector(".meta-board-relation-add-id");
const relationAddError = relationDialog?.querySelector(".meta-board-relation-add-error");
const relationAddClose = relationDialog?.querySelector(".meta-board-relation-add-close");
const relationAddCancel = relationDialog?.querySelector(".meta-board-relation-add-cancel");

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
const META_COLORS = [
  "#2563eb",
  "#16a34a",
  "#9333ea",
  "#ca8a04",
  "#dc2626",
  "#0891b2",
  "#7c3aed",
  "#db2777",
];
const BUGZILLA_ICON_URL = "https://bugzilla.mozilla.org/extensions/BMO/web/images/bugzilla.png";

const state = {
  boards: [],
  currentBoard: null,
  currentBoardId: "",
  currentDetail: null,
  detailRelations: { dependsOn: [], blocks: [] },
  activeSprintId: "",
  relationAddType: "",
  loading: false,
  assigneeColors: new Map(),
  metaColors: new Map(),
  pendingCardIds: new Set(),
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
    throw new Error(result.error || "Meta board request failed.");
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

function setManagerStatus(message = "") {
  if (managerStatus) {
    managerStatus.textContent = message;
  }
}

function setManagerBusy(isBusy) {
  managerForm?.querySelectorAll(
    ".meta-board-manager-id, .meta-board-review-group, .meta-board-add, [data-meta-board-action]",
  ).forEach((element) => {
    element.disabled = isBusy;
  });
}

function formatPoints(points) {
  return points === null || points === undefined || points === ""
    ? "No points"
    : `${points} point${Number(points) === 1 ? "" : "s"}`;
}

function getBugUrl(bugId) {
  return `https://bugzilla.mozilla.org/show_bug.cgi?id=${encodeURIComponent(bugId)}`;
}

function createExternalLink({ href, text = "Bugzilla" }) {
  const link = document.createElement("a");

  link.className = "meta-board-external-link";
  link.href = href;
  link.textContent = text;
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function createBugNumberLink(bug) {
  const link = document.createElement("a");

  link.className = "meta-board-card-id";
  link.href = bug.url;
  link.textContent = `Bug ${bug.id}`;
  link.title = `Open Bug ${bug.id} in Bugzilla`;
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function createInternalBugButton(bug) {
  const button = document.createElement("button");

  button.className = "meta-board-internal-link";
  button.type = "button";
  button.textContent = `Bug ${bug.id}`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openBugDetail(bug.id, { standalone: state.detailStandalone }).catch(showDetailError);
  });
  return button;
}

function createCardMetaButton(meta) {
  const button = document.createElement("button");

  button.className = "meta-board-card-parent-link";
  button.type = "button";
  button.textContent = meta.summary;
  button.title = `Open Bug ${meta.id}: ${meta.summary}`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openBugDetail(meta.id).catch(showDetailError);
  });
  return button;
}

export function createBugzillaIconLink(bug) {
  const link = document.createElement("a");
  const icon = document.createElement("img");

  link.className = "meta-board-bugzilla-icon";
  link.href = bug.url;
  link.title = `Open Bug ${bug.id} in Bugzilla`;
  link.setAttribute("aria-label", link.title);
  link.addEventListener("click", (event) => event.stopPropagation());
  icon.alt = "";
  icon.src = BUGZILLA_ICON_URL;
  link.append(icon);
  return link;
}

function getPatchStatusKind(patch) {
  const status = `${patch.status || ""} ${patch.statusName || ""}`.toLowerCase();

  if (status.includes("accept")) {
    return "accepted";
  }

  if (status.includes("reject") || status.includes("change")) {
    return "changes";
  }

  if (status.includes("review")) {
    return "review";
  }

  if (status.includes("close") || status.includes("abandon")) {
    return "closed";
  }

  return "open";
}

function createPatchLink(patch) {
  const link = document.createElement("a");
  const status = patch.statusName || patch.status || "Unknown";

  link.className = "meta-board-patch-link";
  link.dataset.status = getPatchStatusKind(patch);
  link.href = patch.url;
  link.textContent = `${patch.id} ${status}`;
  link.title = patch.title ? `${patch.id}: ${patch.title} (${status})` : `${patch.id}: ${status}`;
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function createCardPatchLinks(patches = []) {
  const container = document.createElement("div");
  const visiblePatches = patches.filter((patch) => patch.id && patch.url);

  if (!visiblePatches.length) {
    return null;
  }

  container.className = "meta-board-card-patches";
  visiblePatches.forEach((patch) => container.append(createPatchLink(patch)));
  return container;
}

function createBugLinks(bug) {
  const links = document.createElement("span");

  links.className = "meta-board-bug-links";
  links.append(createInternalBugButton(bug));
  links.append(createBugzillaIconLink(bug));
  return links;
}

function createRelationOpenButton(bug) {
  const button = document.createElement("button");
  const id = document.createElement("span");
  const summary = document.createElement("span");

  button.className = "meta-board-relation-open";
  button.type = "button";
  button.title = `Open Bug ${bug.id}: ${bug.summary}`;
  id.className = "meta-board-relation-id";
  id.textContent = `Bug ${bug.id}`;
  summary.className = "meta-board-relation-summary";
  summary.textContent = bug.summary;
  button.append(id, summary);
  button.addEventListener("click", () => {
    openBugDetail(bug.id).catch(showDetailError);
  });
  return button;
}

function createRelationRemoveButton(bug, relationType) {
  const button = document.createElement("button");
  const relationLabel = relationType === "dependsOn" ? "Blocked By" : "Blocks";

  button.className = "meta-board-relation-remove";
  button.type = "button";
  button.textContent = "-";
  button.title = `Remove Bug ${bug.id} from ${relationLabel}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () => removeRelation(relationType, bug.id));
  return button;
}

function createCard(card) {
  const element = document.createElement("article");
  const heading = document.createElement("div");
  const id = createBugNumberLink(card);
  const title = document.createElement("h4");
  const meta = document.createElement("div");
  const parent = document.createElement("div");
  const patches = createCardPatchLinks(card.patches || []);

  element.className = "meta-board-card";
  element.tabIndex = 0;
  element.style.setProperty(
    "--meta-board-card-color",
    state.metaColors.get(card.parentMeta.id) || META_COLORS[0],
  );
  heading.className = "meta-board-card-heading";
  if (state.pendingCardIds.has(card.id)) {
    const pending = document.createElement("span");

    pending.className = "meta-board-card-pending";
    pending.setAttribute("aria-label", "Saving Bugzilla update");
    pending.setAttribute("role", "status");
    pending.title = "Saving Bugzilla update";
    heading.append(pending);
  }
  title.textContent = card.summary;
  meta.className = "meta-board-card-meta";
  meta.append(document.createTextNode(formatPoints(card.points)));

  if (card.assignee) {
    const assignee = document.createElement("span");
    const pillStyle = getAccessibleAssigneePillStyle(
      state.assigneeColors.get(card.assignee.email) || ASSIGNEE_COLORS[0],
    );

    assignee.className = "meta-board-assignee";
    assignee.style.setProperty(
      "--meta-board-assignee-accent",
      pillStyle.accent,
    );
    assignee.style.setProperty("--meta-board-assignee-background", pillStyle.background);
    assignee.style.setProperty("--meta-board-assignee-foreground", pillStyle.foreground);
    assignee.textContent = card.assignee.name;
    meta.append(assignee);
  }

  parent.className = "meta-board-card-parent";
  parent.append(createCardMetaButton(card.parentMeta));
  parent.append(createBugzillaIconLink(card.parentMeta));
  heading.append(id);
  element.append(heading, title, meta);
  if (patches) {
    element.append(patches);
  }
  element.append(parent);
  element.addEventListener("click", () => openBugDetail(card.id).catch(showDetailError));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openBugDetail(card.id).catch(showDetailError);
    }
  });
  return element;
}

function getFilteredCards(column) {
  const cards = state.currentBoard?.columns?.[column] || [];
  const assignee = assigneeFilter?.value || "";
  const meta = metaFilter?.value || "";

  return cards.filter((card) => (
    (!assignee || card.assignee?.email === assignee) &&
    (!meta || card.parentMeta.id === meta)
  ));
}

function getPointTotal(cards) {
  return cards.reduce((total, card) => {
    const points = Number(card.points);

    return card.points === null || card.points === undefined || !Number.isFinite(points)
      ? total
      : total + points;
  }, 0);
}

function formatPointTotal(points) {
  return `${points} point${points === 1 ? "" : "s"}`;
}

function renderColumns() {
  if (!kanban) {
    return;
  }

  kanban.querySelectorAll(".meta-board-column").forEach((column) => {
    const cards = getFilteredCards(column.dataset.metaBoardColumn);
    const count = column.querySelector(".meta-board-column-count");
    const points = column.querySelector(".meta-board-column-points");
    const container = column.querySelector(".meta-board-cards");

    count.textContent = String(cards.length);
    if (points) {
      points.hidden = column.dataset.metaBoardColumn === "backlog";
      points.textContent = formatPointTotal(getPointTotal(cards));
    }
    clear(container);

    if (!cards.length) {
      const emptyColumn = document.createElement("p");

      emptyColumn.className = "meta-board-column-empty";
      emptyColumn.textContent = "No stories";
      container.append(emptyColumn);
      return;
    }

    cards.forEach((card) => container.append(createCard(card)));
  });
}

function populateSelect(selectElement, entries, {
  getLabel,
  getValue,
  initialLabel,
} = {}) {
  if (!selectElement) {
    return;
  }

  const previous = selectElement.value;

  clear(selectElement);
  const initial = document.createElement("option");

  initial.value = "";
  initial.textContent = initialLabel;
  selectElement.append(initial);
  entries.forEach((entry) => {
    const option = document.createElement("option");

    option.value = getValue(entry);
    option.textContent = getLabel(entry);
    selectElement.append(option);
  });
  selectElement.value = Array.from(selectElement.options).some(
    (option) => option.value === previous,
  ) ? previous : "";
}

function renderBoardSelect() {
  if (!select) {
    return;
  }

  const previous = state.currentBoardId;

  clear(select);
  state.boards.forEach((board) => {
    const option = document.createElement("option");
    const cached = state.currentBoard?.id === board.id ? state.currentBoard : null;
    const summary = cached?.metaBug?.summary || board.summary;

    option.value = board.id;
    option.textContent = summary
      ? `Bug ${board.metaBugId}: ${summary}`
      : `Bug ${board.metaBugId}`;
    select.append(option);
  });
  select.value = state.boards.some((board) => board.id === previous)
    ? previous
    : state.boards[0]?.id || "";
}

function mergeMetaBoardAssignees(...lists) {
  return Array.from(new Map(lists.flat()
    .filter((assignee) => assignee?.email)
    .map((assignee) => [assignee.email.toLowerCase(), assignee])).values())
    .sort((first, second) => first.name.localeCompare(second.name));
}

function renderBoardManager() {
  if (!managerList) {
    return;
  }

  clear(managerList);

  if (!state.boards.length) {
    const emptyMessage = document.createElement("p");

    emptyMessage.className = "meta-board-manager-empty";
    emptyMessage.textContent = "No saved boards.";
    managerList.append(emptyMessage);
    return;
  }

  state.boards.forEach((board) => {
    const row = document.createElement("div");
    const title = createExternalLink({
      href: getBugUrl(board.metaBugId),
      text: board.summary
        ? `Bug ${board.metaBugId}: ${board.summary}`
        : `Bug ${board.metaBugId}`,
    });
    const settings = document.createElement("label");
    const settingLabel = document.createElement("span");
    const reviewGroup = document.createElement("input");
    const actions = document.createElement("div");
    const saveReviewGroup = document.createElement("button");
    const refreshReviewGroup = document.createElement("button");
    const open = document.createElement("button");
    const removeButton = document.createElement("button");

    row.className = "meta-board-manager-row";
    row.classList.toggle("current", board.id === state.currentBoardId);
    settings.className = "meta-board-manager-settings";
    settingLabel.textContent = "Review group";
    reviewGroup.autocomplete = "off";
    reviewGroup.className = "meta-board-review-group";
    reviewGroup.dataset.boardId = board.id;
    reviewGroup.placeholder = "#review-group";
    reviewGroup.spellcheck = false;
    reviewGroup.type = "text";
    reviewGroup.value = board.reviewGroup ? `#${board.reviewGroup}` : "";
    reviewGroup.setAttribute("aria-label", `Review group for Bug ${board.metaBugId}`);
    settings.append(settingLabel, reviewGroup);
    actions.className = "meta-board-manager-row-actions";
    saveReviewGroup.className = "meta-board-review-group-save";
    saveReviewGroup.dataset.metaBoardAction = "save-review-group";
    saveReviewGroup.dataset.boardId = board.id;
    saveReviewGroup.type = "button";
    saveReviewGroup.textContent = "Save";
    refreshReviewGroup.className = "meta-board-review-group-save";
    refreshReviewGroup.dataset.metaBoardAction = "refresh-review-group";
    refreshReviewGroup.dataset.boardId = board.id;
    refreshReviewGroup.disabled = !board.reviewGroup;
    refreshReviewGroup.title = board.reviewGroup
      ? `Refresh #${board.reviewGroup} members from Phabricator`
      : "Save a review group before refreshing its members";
    refreshReviewGroup.type = "button";
    refreshReviewGroup.textContent = "Refresh members";
    open.className = "meta-board-internal-link";
    open.dataset.metaBoardAction = "open";
    open.dataset.boardId = board.id;
    open.type = "button";
    open.textContent = "Open";
    removeButton.className = "meta-board-remove";
    removeButton.dataset.metaBoardAction = "remove";
    removeButton.dataset.boardId = board.id;
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    actions.append(saveReviewGroup, refreshReviewGroup, open, removeButton);
    row.append(title, settings, actions);
    managerList.append(row);
  });
}

function renderBoard() {
  const board = state.currentBoard;
  const hasBoard = Boolean(board);

  controls.hidden = !hasBoard;
  empty.hidden = hasBoard;
  kanban.hidden = !hasBoard;

  if (!hasBoard) {
    return;
  }

  // JSON responses contain separate copies in cards and columns. Use the same
  // card objects so edits also update the cards displayed in each column.
  const cardsById = new Map(board.cards.map((card) => [card.id, card]));

  for (const [column, cards] of Object.entries(board.columns || {})) {
    board.columns[column] = cards.map((card) => cardsById.get(card.id) || card);
  }
  board.assignees = mergeMetaBoardAssignees(
    board.assignees || [],
    board.cards.map((card) => card.assignee),
  );
  state.metaColors = new Map(Object.entries(board.metaColors || {}));
  state.assigneeColors = createColorAssignments(
    board.cards.map((card) => card.assignee?.email),
    ASSIGNEE_COLORS,
  );
  renderBoardSelect();
  clear(rootLinks);
  rootLinks?.append(createBugLinks(board.metaBug));
  populateSelect(assigneeFilter, board.assignees || [], {
    getLabel: (assignee) => assignee.name,
    getValue: (assignee) => assignee.email,
    initialLabel: "All assignees",
  });
  populateSelect(metaFilter, board.childMetas || [], {
    getLabel: (meta) => `Bug ${meta.id}: ${meta.summary}`,
    getValue: (meta) => meta.id,
    initialLabel: "All child metas",
  });
  populateSelect(sprintSelect, board.sprints || [], {
    getLabel: (sprint) => `${sprint.summary} (${sprint.deadline || "no end date"})`,
    getValue: (sprint) => sprint.id,
    initialLabel: "Open a sprint...",
  });
  setError((board.errors || []).join("\n"));
  setStatus(`Bug ${board.metaBug.id}: ${board.metaBug.summary}`);
  renderColumns();
}

function setLoading(isLoading, message = "") {
  state.loading = isLoading;
  panel?.classList.toggle("is-loading", isLoading);
  panel?.setAttribute("aria-busy", String(isLoading));
  loadingIndicator.hidden = !isLoading;

  if (isLoading && loadingText) {
    loadingText.textContent = message || "Loading meta bug board...";
  }

  if (refresh) {
    refresh.disabled = isLoading;
    refresh.textContent = isLoading ? "Refreshing..." : "Refresh";
  }

  if (isLoading && message) {
    setStatus(message);
  }
}

async function loadBoards() {
  const result = await request("/api/meta-boards");

  state.boards = result.boards || [];
  return state.boards;
}

function getSavedBoard(boardId = state.currentBoardId) {
  return state.boards.find((board) => (
    board.id === boardId || board.metaBugId === boardId
  ));
}

function updateMetaBoardRoute() {
  const board = getSavedBoard();
  const metaBugId = board?.metaBugId || state.currentBoard?.metaBug?.id;

  setConsoleRoute({ boardId: metaBugId || "", view: "meta-boards" });
}

async function loadBoard(boardId, { force = false, updateLocation = true } = {}) {
  if (!boardId || state.loading) {
    return;
  }

  setLoading(true, "Loading meta bug board...");
  setError("");

  try {
    const result = await request(`/api/meta-boards/${encodeURIComponent(boardId)}`, {
      parameters: { force: force ? "1" : "" },
    });

    state.currentBoard = result;
    state.currentBoardId = boardId;
    renderBoard();
    if (updateLocation) {
      updateMetaBoardRoute();
    }
  } catch (requestError) {
    setError(requestError.message || String(requestError));
  } finally {
    setLoading(false);
  }
}

async function loadReviewGroupAssignees(boardId, board) {
  if (!board.reviewGroup?.slug) {
    return;
  }

  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(boardId)}/review-group-assignees`,
    );

    if (state.currentBoardId !== boardId || state.currentBoard !== board) {
      return;
    }

    if (result.error) {
      board.errors = [...(board.errors || []), result.error];
      setError(board.errors.join("\n"));
      return;
    }

    board.assignees = mergeMetaBoardAssignees(board.assignees || [], result.assignees);
    renderBoard();
    renderDetailAssigneeOptions();
  } catch (requestError) {
    if (state.currentBoardId === boardId && state.currentBoard === board) {
      const message = requestError?.message || String(requestError);

      board.errors = [...(board.errors || []), message];
      setError(board.errors.join("\n"));
    }
  }
}

function showDetailError(requestError) {
  if (!dialog?.open) {
    dialog?.showModal();
  }

  detailError.textContent = requestError?.message || String(requestError);
}

function renderRelationLinks(container, bugs = [], relationType) {
  clear(container);

  if (!bugs.length) {
    const noBugs = document.createElement("span");

    noBugs.className = "meta-board-no-relations";
    noBugs.textContent = "None";
    container.append(noBugs);
    return;
  }

  bugs.forEach((bug) => {
    const relation = document.createElement("div");
    const actions = document.createElement("div");

    relation.className = "meta-board-relation-link";
    actions.className = "meta-board-relation-actions";
    actions.append(
      createRelationRemoveButton(bug, relationType),
      createBugzillaIconLink(bug),
    );
    relation.append(createRelationOpenButton(bug), actions);
    container.append(relation);
  });
}

function renderDetailRelations() {
  renderRelationLinks(
    detailDependsLinks,
    state.detailRelations.dependsOn,
    "dependsOn",
  );
  renderRelationLinks(
    detailBlocksLinks,
    state.detailRelations.blocks,
    "blocks",
  );
}

function removeRelation(relationType, bugId) {
  state.detailRelations[relationType] = state.detailRelations[relationType]
    .filter((bug) => bug.id !== String(bugId));
  renderDetailRelations();
}

function renderNotionLinks(notion) {
  const stories = Array.isArray(notion?.stories)
    ? notion.stories.filter((story) => story?.url)
    : [];

  stories.forEach((story) => {
    detailLinks.append(createExternalLink({
      href: story.url,
      text: story.title ? `Notion: ${story.title}` : "Notion",
    }));
  });
}

function renderDetailDescription(description) {
  detailDescription.value = description || "";
  detailDescription.hidden = true;
  detailDescriptionRendered.hidden = false;
  setDetailDescriptionEditing(false);
  renderMarkdown(detailDescriptionRendered, description);
}

function formatBugCommentTimestamp(value) {
  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return value || "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function renderDetailComments(comments = []) {
  const items = Array.isArray(comments) ? comments : [];

  if (detailComments) {
    detailComments.open = false;
  }
  if (detailCommentsCount) {
    detailCommentsCount.textContent = `(${items.length})`;
  }
  if (!detailCommentsList) {
    return;
  }

  if (!items.length) {
    const emptyMessage = document.createElement("p");

    emptyMessage.className = "meta-board-detail-comments-empty";
    emptyMessage.textContent = "No Bugzilla comments were returned for this bug.";
    detailCommentsList.replaceChildren(emptyMessage);
    return;
  }

  detailCommentsList.replaceChildren(...items.map((item) => {
    const comment = document.createElement("article");
    const header = document.createElement("header");
    const author = document.createElement("strong");
    const metadata = document.createElement("span");
    const body = document.createElement("pre");

    comment.className = "meta-board-detail-comment";
    author.textContent = item.author || item.email || "Unknown user";
    metadata.className = "meta-board-detail-comment-meta";
    metadata.textContent = [
      item.email && item.email !== item.author ? item.email : "",
      formatBugCommentTimestamp(item.createdAt),
      item.isPrivate ? "Private" : "",
    ].filter(Boolean).join(" | ");
    body.textContent = item.text || "(No comment text.)";
    header.append(author);
    if (metadata.textContent) {
      header.append(metadata);
    }
    comment.append(header, body);
    return comment;
  }));
}

function setDetailDescriptionEditing(isEditing) {
  const editIcon = detailDescriptionEdit.querySelector('[data-mode="edit"]');
  const renderIcon = detailDescriptionEdit.querySelector('[data-mode="render"]');

  detailDescriptionEdit.dataset.mode = isEditing ? "editing" : "rendered";
  detailDescriptionEdit.setAttribute("aria-pressed", String(isEditing));
  detailDescriptionEdit.setAttribute(
    "aria-label",
    isEditing ? "Show rendered description" : "Edit description",
  );
  detailDescriptionEdit.title = isEditing
    ? "Show rendered description"
    : "Edit description";
  editIcon.hidden = isEditing;
  renderIcon.hidden = !isEditing;
}

function editDetailDescription() {
  detailDescription.hidden = false;
  detailDescriptionRendered.hidden = true;
  setDetailDescriptionEditing(true);
  detailDescription.focus();
}

function renderEditedDetailDescription() {
  detailDescription.hidden = true;
  detailDescriptionRendered.hidden = false;
  setDetailDescriptionEditing(false);
  renderMarkdown(detailDescriptionRendered, detailDescription.value);
}

function toggleDetailDescription() {
  if (detailDescription.hidden) {
    editDetailDescription();
  } else {
    renderEditedDetailDescription();
  }
}

function renderDetailAssigneeOptions() {
  clear(detailAssigneeOptions);
  (state.currentBoard?.assignees || []).forEach((assignee) => {
    const option = document.createElement("option");

    option.value = assignee.email;
    option.label = assignee.name;
    detailAssigneeOptions.append(option);
  });
}

function renderDetail(detail) {
  state.currentDetail = detail;
  state.detailRelations = {
    dependsOn: [...(detail.dependsOn || [])],
    blocks: [...(detail.blocks || [])],
  };
  detailTitle.textContent = `Bug ${detail.id}: ${detail.summary}`;
  clear(detailLinks);
  clear(detailBugzilla);
  detailBugzilla.append(createBugzillaIconLink(detail));
  renderNotionLinks(detail.notion);
  detailStatus.textContent = [detail.status, detail.resolution]
    .filter((value) => value && value !== "---")
    .join(" | ") || "Open";
  detailSummary.value = detail.summary;
  detailPoints.value = detail.points ?? "";
  detailAssignee.value = detail.assignee?.email || "";
  renderDetailDescription(detail.description || "");
  renderDetailComments(detail.comments);
  detailError.textContent = "";
  renderDetailRelations();
  renderDetailAssigneeOptions();
  renderDetailSprintMembership();
}

function isCurrentDetailInSprint() {
  return state.detailRelations.blocks.some((bug) => bug.id === state.activeSprintId);
}

function renderDetailSprintMembership() {
  if (!detailSprintMembership) {
    return;
  }

  const hasSprint = Boolean(state.activeSprintId && state.currentDetail);

  detailSprintMembership.hidden = !hasSprint;
  if (hasSprint) {
    detailSprintMembership.textContent = isCurrentDetailInSprint()
      ? "Remove from Sprint"
      : "Add to Sprint";
  }
}

async function openBugDetail(bugId, { sprintId = "", standalone = false } = {}) {
  if (!standalone && !state.currentBoardId) {
    return;
  }

  state.detailStandalone = standalone;
  state.currentDetail = null;
  state.activeSprintId = String(sprintId || "");
  if (!dialog.open) {
    dialog.showModal();
  }
  detailTitle.textContent = `Bug ${bugId}`;
  detailStatus.textContent = "Loading bug details...";
  detailError.textContent = "";
  detailSave.disabled = true;

  try {
    const detail = await request(
      standalone ? `/api/bugs/${encodeURIComponent(bugId)}` : `/api/meta-boards/${encodeURIComponent(state.currentBoardId)}/bugs/${encodeURIComponent(bugId)}`,
    );

    renderDetail(detail);
    if (!standalone) void loadReviewGroupAssignees(state.currentBoardId, state.currentBoard);
  } catch (requestError) {
    showDetailError(requestError);
  } finally {
    detailSave.disabled = false;
  }
}

export async function openDashboardBugDetail(bugId) {
  initializeMetaBoards();
  return openBugDetail(bugId, { standalone: true });
}

export async function openMetaBoardBugDetail(bugId, {
  boardId = state.currentBoardId,
  sprintId = "",
} = {}) {
  if (boardId && boardId !== state.currentBoardId) {
    state.currentBoardId = boardId;
  }

  return openBugDetail(bugId, { sprintId });
}

async function toggleDetailSprintMembership() {
  if (!state.currentDetail || !state.currentBoardId || !state.activeSprintId) {
    return;
  }

  if (Object.keys(getDetailChanges()).length) {
    detailError.textContent = "Save the other bug changes before changing sprint membership.";
    return;
  }

  const member = !isCurrentDetailInSprint();

  detailSprintMembership.disabled = true;
  detailError.textContent = "";
  detailStatus.textContent = member ? "Adding to sprint..." : "Removing from sprint...";
  try {
    await setSprintStoryMembership({
      boardId: state.currentBoardId,
      member,
      sprintId: state.activeSprintId,
      storyId: state.currentDetail.id,
    });
    const relation = state.currentBoard?.sprints?.find((sprint) => sprint.id === state.activeSprintId) || {
      id: state.activeSprintId,
      summary: `Sprint ${state.activeSprintId}`,
      url: getBugUrl(state.activeSprintId),
    };

    state.detailRelations.blocks = member
      ? [...state.detailRelations.blocks, relation]
      : state.detailRelations.blocks.filter((bug) => bug.id !== state.activeSprintId);
    state.currentDetail.blocks = [...state.detailRelations.blocks];
    detailStatus.textContent = member ? "Added to sprint." : "Removed from sprint.";
    renderDetailRelations();
    renderDetailSprintMembership();
  } catch (requestError) {
    detailError.textContent = requestError?.message || String(requestError);
  } finally {
    detailSprintMembership.disabled = false;
  }
}

function getRelationLabel(relationType) {
  return relationType === "dependsOn" ? "Blocked By" : "Blocks";
}

function openRelationAddDialog(relationType) {
  if (!state.currentDetail || !relationDialog) {
    return;
  }

  state.relationAddType = relationType;
  relationAddTitle.textContent = `Add Bug to ${getRelationLabel(relationType)}`;
  relationAddId.value = "";
  relationAddError.textContent = "";
  if (!relationDialog.open) {
    relationDialog.showModal();
  }
  relationAddId.focus();
}

function addRelation(event) {
  event.preventDefault();

  const bugId = relationAddId.value.trim();
  const relationType = state.relationAddType;

  if (!/^\d{4,10}$/.test(bugId)) {
    relationAddError.textContent = "Enter a valid Bugzilla bug ID.";
    relationAddId.focus();
    return;
  }

  if (state.detailRelations[relationType].some((bug) => bug.id === bugId)) {
    relationAddError.textContent = `Bug ${bugId} is already listed.`;
    relationAddId.focus();
    return;
  }

  state.detailRelations[relationType].push({
    id: bugId,
    summary: `Bug ${bugId}`,
    url: getBugUrl(bugId),
  });
  renderDetailRelations();
  relationDialog.close();
}

function getDetailChanges() {
  const original = state.currentDetail;
  const changes = {};
  const originalAssignee = original.assignee?.email || "";
  const originalDepends = (original.dependsOn || []).map((bug) => bug.id).join(", ");
  const originalBlocks = (original.blocks || []).map((bug) => bug.id).join(", ");
  const nextDepends = state.detailRelations.dependsOn.map((bug) => bug.id).join(", ");
  const nextBlocks = state.detailRelations.blocks.map((bug) => bug.id).join(", ");

  if (detailSummary.value.trim() !== original.summary) {
    changes.summary = detailSummary.value;
  }

  if (detailPoints.value.trim() !== String(original.points ?? "")) {
    changes.points = detailPoints.value;
  }

  if (detailAssignee.value.trim() !== originalAssignee) {
    changes.assignee = detailAssignee.value;
  }

  if (nextDepends !== originalDepends) {
    changes.dependsOn = nextDepends;
  }

  if (nextBlocks !== originalBlocks) {
    changes.blocks = nextBlocks;
  }

  if (detailDescription.value.trim() !== (original.description || "").trim()) {
    changes.description = detailDescription.value;
  }

  return changes;
}

function getBoardCard(id) {
  return state.currentBoard?.cards?.find((card) => card.id === String(id)) || null;
}

function getBoardCardColumn(card) {
  return Object.entries(state.currentBoard?.columns || {}).find(([, cards]) => cards.includes(card))?.[0] || "";
}

function getOptimisticColumn(card) {
  if (["complete", "in-progress", "in-review"].includes(card.column)) {
    return card.column;
  }

  if (card.assignee) {
    return "assigned";
  }

  return card.points === null || card.points === undefined ? "backlog" : "ready";
}

function getAssignee(email) {
  if (email && typeof email === "object") {
    return { ...email };
  }

  const normalizedEmail = String(email || "").trim();

  if (!normalizedEmail) {
    return null;
  }

  return state.currentBoard?.assignees?.find((assignee) => assignee.email === normalizedEmail) || {
    email: normalizedEmail,
    name: normalizedEmail,
  };
}

function moveBoardCard(card, fromColumn, toColumn) {
  if (!card || !fromColumn || !toColumn || fromColumn === toColumn) {
    return;
  }

  const source = state.currentBoard.columns[fromColumn] || [];
  const destination = state.currentBoard.columns[toColumn] || [];
  const sourceIndex = source.indexOf(card);

  if (sourceIndex !== -1) {
    source.splice(sourceIndex, 1);
  }
  destination.push(card);
  card.column = toColumn;
}

function applyCardChanges(card, changes) {
  if (Object.hasOwn(changes, "summary")) {
    card.summary = String(changes.summary || "").trim();
  }

  if (Object.hasOwn(changes, "points")) {
    const value = String(changes.points ?? "").trim();

    card.points = value ? Number(value) : null;
  }

  if (Object.hasOwn(changes, "assignee")) {
    card.assignee = getAssignee(changes.assignee);
  }
}

function beginOptimisticCardUpdate(detail, changes) {
  const card = getBoardCard(detail.id);

  if (!card || !state.currentBoard) {
    return () => {};
  }

  const original = {
    assignee: card.assignee ? { ...card.assignee } : null,
    column: getBoardCardColumn(card),
    points: card.points,
    summary: card.summary,
  };
  const originalIndex = state.currentBoard.columns[original.column]?.indexOf(card) ?? -1;

  state.pendingCardIds.add(card.id);
  applyCardChanges(card, changes);
  moveBoardCard(card, original.column, getOptimisticColumn(card));
  renderColumns();

  return ({ detail: savedDetail, revert = false } = {}) => {
    if (revert) {
      applyCardChanges(card, original);
      const currentColumn = getBoardCardColumn(card);

      moveBoardCard(card, currentColumn, original.column);
      const cards = state.currentBoard.columns[original.column] || [];
      const currentIndex = cards.indexOf(card);

      if (currentIndex !== -1 && originalIndex >= 0) {
        cards.splice(currentIndex, 1);
        cards.splice(originalIndex, 0, card);
      }
    } else if (savedDetail) {
      applyCardChanges(card, savedDetail);
      moveBoardCard(card, getBoardCardColumn(card), getOptimisticColumn(card));
    }

    state.pendingCardIds.delete(card.id);
    renderBoard();
  };
}

async function saveDetail(event) {
  event.preventDefault();

  if (!state.currentDetail || (!state.detailStandalone && !state.currentBoardId)) {
    return;
  }

  const changes = getDetailChanges();

  if (!Object.keys(changes).length) {
    dialog.close();
    return;
  }

  detailSave.disabled = true;
  detailError.textContent = "";
  detailStatus.textContent = "Saving Bugzilla changes...";
  const finishOptimisticUpdate = beginOptimisticCardUpdate(state.currentDetail, changes);

  try {
    const detail = await request(
      state.detailStandalone ? `/api/bugs/${encodeURIComponent(state.currentDetail.id)}` : `/api/meta-boards/${encodeURIComponent(state.currentBoardId)}/bugs/${encodeURIComponent(state.currentDetail.id)}`,
      { method: "PUT", body: { changes } },
    );

    renderDetail(detail);
    finishOptimisticUpdate({ detail });
  } catch (requestError) {
    finishOptimisticUpdate({ revert: true });
    detailError.textContent = requestError?.message || String(requestError);
  } finally {
    detailSave.disabled = false;
  }
}

async function addBoard(metaBugId) {
  const normalizedMetaBugId = metaBugId.trim();

  if (!normalizedMetaBugId) {
    return;
  }

  setManagerBusy(true);
  setManagerStatus("Adding meta bug board...");
  setError("");

  try {
    const result = await request("/api/meta-boards", {
      method: "POST",
      body: { metaBugId: normalizedMetaBugId },
    });

    state.boards = result.boards || [];
    state.currentBoard = result.board;
    state.currentBoardId = result.board.id;
    managerId.value = "";
    renderBoard();
    updateMetaBoardRoute();
    renderBoardManager();
    setManagerStatus(`Added Bug ${normalizedMetaBugId}.`);
  } catch (requestError) {
    setError(requestError?.message || String(requestError));
    setManagerStatus(requestError?.message || String(requestError));
  } finally {
    setManagerBusy(false);
  }
}

async function removeBoard(boardId) {
  if (!boardId) {
    return;
  }

  setManagerBusy(true);
  setManagerStatus("Removing meta bug board...");

  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(boardId)}`,
      { method: "DELETE", body: {} },
    );

    state.boards = result.boards || [];
    const wasCurrentBoard = state.currentBoardId === boardId;

    if (wasCurrentBoard) {
      state.currentBoard = null;
      state.currentBoardId = state.boards[0]?.id || "";
    }

    renderBoardManager();
    setManagerStatus("Board removed.");

    if (wasCurrentBoard && state.currentBoardId) {
      await loadBoard(state.currentBoardId);
      return;
    }

    if (wasCurrentBoard) {
      setStatus("Add a Bugzilla meta bug to create a board.");
      setConsoleRoute({ view: "meta-boards" });
    }
    renderBoard();
  } catch (requestError) {
    setError(requestError?.message || String(requestError));
    setManagerStatus(requestError?.message || String(requestError));
  } finally {
    setManagerBusy(false);
  }
}

async function saveBoardReviewGroup(boardId, reviewGroup) {
  if (!boardId) {
    return;
  }

  setManagerBusy(true);
  setManagerStatus("Saving review group...");
  setError("");

  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(boardId)}`,
      { method: "PUT", body: { reviewGroup } },
    );

    state.boards = result.boards || [];

    if (state.currentBoardId === boardId) {
      state.currentBoard = result.board;
      renderBoard();
    }

    renderBoardManager();
    setManagerStatus(
      result.board.reviewGroup?.slug
        ? `Review group #${result.board.reviewGroup.slug} saved.`
        : "Review group cleared.",
    );
  } catch (requestError) {
    setError(requestError?.message || String(requestError));
    setManagerStatus(requestError?.message || String(requestError));
  } finally {
    setManagerBusy(false);
  }
}

async function refreshBoardReviewGroup(boardId) {
  const board = getSavedBoard(boardId);

  if (!board?.reviewGroup) {
    return;
  }

  setManagerBusy(true);
  setManagerStatus(`Refreshing #${board.reviewGroup} members...`);
  setError("");

  try {
    const result = await request(
      `/api/meta-boards/${encodeURIComponent(boardId)}/review-group-assignees`,
      { parameters: { force: "1" } },
    );

    if (result.error) {
      throw new Error(result.error);
    }

    if (state.currentBoardId === boardId && state.currentBoard) {
      state.currentBoard.assignees = mergeMetaBoardAssignees(
        state.currentBoard.assignees || [],
        result.assignees || [],
      );
      renderBoard();
      renderDetailAssigneeOptions();
    }

    setManagerStatus(`Refreshed #${board.reviewGroup} members.`);
  } catch (requestError) {
    setError(requestError?.message || String(requestError));
    setManagerStatus(requestError?.message || String(requestError));
  } finally {
    setManagerBusy(false);
  }
}

async function submitBoardManager(event) {
  event.preventDefault();
  await addBoard(managerId.value);
}

async function handleBoardManagerClick(event) {
  const action = event.target.closest("[data-meta-board-action]");

  if (!action) {
    return;
  }

  const boardId = action.dataset.boardId;

  if (action.dataset.metaBoardAction === "remove") {
    await removeBoard(boardId);
    return;
  }

  if (action.dataset.metaBoardAction === "open") {
    state.currentBoardId = boardId;
    state.currentBoard = null;
    managerDialog.close();
    await showMetaBoards();
    return;
  }

  if (action.dataset.metaBoardAction === "save-review-group") {
    const row = action.closest(".meta-board-manager-row");
    const reviewGroup = row?.querySelector(".meta-board-review-group");

    await saveBoardReviewGroup(boardId, reviewGroup?.value || "");
    return;
  }

  if (action.dataset.metaBoardAction === "refresh-review-group") {
    await refreshBoardReviewGroup(boardId);
  }
}

export async function openMetaBoardManager({ focusAdd = false } = {}) {
  if (!managerDialog) {
    return;
  }

  setManagerStatus("Loading saved boards...");
  try {
    await loadBoards();
    renderBoardManager();
    setManagerStatus("");
  } catch (requestError) {
    setManagerStatus(requestError?.message || String(requestError));
  }

  if (!managerDialog.open) {
    managerDialog.showModal();
  }
  if (focusAdd) {
    managerId?.focus();
  }
}

export function hideMetaBoards() {
  if (panel) {
    panel.hidden = true;
  }

  tab?.classList.remove("active");
}

export async function showMetaBoards({ boardId = "", updateLocation = true } = {}) {
  if (!panel || !tab) {
    return;
  }

  document.body.classList.remove("graph-view-active");
  document.querySelectorAll(".tab, .panel").forEach((node) => {
    node.classList.remove("active");
  });
  document.querySelector(".dashboard-panel")?.setAttribute("hidden", "");
  document.querySelector(".phabricator-cache-panel")?.setAttribute("hidden", "");
  document.querySelector(".sprint-panel")?.setAttribute("hidden", "");
  document.querySelector(".test-output-panel")?.setAttribute("hidden", "");
  tab.classList.add("active");
  panel.hidden = false;

  if (!state.boards.length) {
    setLoading(true, "Loading available meta bug boards...");

    try {
      await loadBoards();
    } catch (requestError) {
      setError(requestError?.message || String(requestError));
      return;
    } finally {
      setLoading(false);
    }
  }

  if (boardId) {
    const requestedBoard = getSavedBoard(boardId);

    if (!requestedBoard) {
      state.currentBoard = null;
      state.currentBoardId = "";
      renderBoard();
      setError(`No saved meta bug board matches ${boardId}.`);
      return;
    }

    if (state.currentBoardId !== requestedBoard.id) {
      state.currentBoard = null;
    }
    state.currentBoardId = requestedBoard.id;
  }

  if (!state.currentBoardId && state.boards.length) {
    state.currentBoardId = state.boards[0].id;
  }

  if (state.currentBoardId && !state.currentBoard) {
    await loadBoard(state.currentBoardId, { updateLocation });
  } else {
    renderBoard();
    if (updateLocation) {
      updateMetaBoardRoute();
    }
  }
}

let initialized = false;
export function initializeMetaBoards() {
  if (initialized || !panel || !tab || !INTERACTIVE.enabled) {
    return;
  }

  initialized = true;
  tab.addEventListener("click", () => showMetaBoards());
  select.addEventListener("change", () => loadBoard(select.value));
  assigneeFilter.addEventListener("change", renderColumns);
  metaFilter.addEventListener("change", renderColumns);
  sprintSelect?.addEventListener("change", () => {
    if (sprintSelect.value) {
      showSprint({
        boardId: state.currentBoardId,
        sprintId: sprintSelect.value,
      });
    }
  });
  newSprint?.addEventListener("click", () => openSprintCreateDialog(state.currentBoardId));
  refresh.addEventListener("click", () => loadBoard(state.currentBoardId, { force: true }));
  managerForm.addEventListener("submit", submitBoardManager);
  managerList.addEventListener("click", handleBoardManagerClick);
  managerClose.addEventListener("click", () => managerDialog.close());
  managerCancel.addEventListener("click", () => managerDialog.close());
  detailForm.addEventListener("submit", saveDetail);
  detailSprintMembership?.addEventListener("click", () => {
    toggleDetailSprintMembership();
  });
  detailClose.addEventListener("click", () => dialog.close());
  detailCancel.addEventListener("click", () => dialog.close());
  detailDescriptionEdit.addEventListener("click", toggleDetailDescription);
  relationAddButtons.forEach((button) => {
    button.addEventListener("click", () => openRelationAddDialog(button.dataset.relation));
  });
  relationAddForm.addEventListener("submit", addRelation);
  relationAddClose.addEventListener("click", () => relationDialog.close());
  relationAddCancel.addEventListener("click", () => relationDialog.close());
}
