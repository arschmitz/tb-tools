import { getBugUrl } from "../../lib/workflow.mjs";

export const SPRINT_WHITEBOARD_TAG = "[tb-desktop-sprint]";
export const SPRINT_TITLE_PREFIX = "[SPRINT] - ";
const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueIds(values = []) {
  return Array.from(new Set(values
    .map((value) => String(value || "").trim())
    .filter((value) => /^\d+$/.test(value))));
}

function getDateOnly(value) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

function getPoints(card) {
  const points = Number(card?.points);

  return Number.isFinite(points) ? points : 0;
}

function getHistoryEntries(history = {}) {
  return Array.isArray(history?.history)
    ? [...history.history].sort((first, second) => (
      String(first.when || "").localeCompare(String(second.when || ""))
    ))
    : [];
}

function getHistoryValue(historyByBugId, id) {
  if (historyByBugId instanceof Map) {
    return historyByBugId.get(String(id));
  }

  return historyByBugId?.[String(id)];
}

function getChangedIds(value) {
  return String(value || "").match(/\d+/g) || [];
}

function isClosedStatus(status) {
  return /^(resolved|verified|closed)$/i.test(String(status || "").trim());
}

function isOpenStatus(status) {
  return /^(unconfirmed|new|assigned|reopened)$/i.test(String(status || "").trim());
}

function isComplete(card) {
  return card?.column === "complete";
}

function sortByName(first, second) {
  return String(first?.name || first?.summary || first?.id || "").localeCompare(
    String(second?.name || second?.summary || second?.id || ""),
  );
}

function sortSprintCardsByAssignee(first, second) {
  const assigneeComparison = String(first?.assignee?.name || "Unassigned").localeCompare(
    String(second?.assignee?.name || "Unassigned"),
  );

  return assigneeComparison || sortByName(first, second);
}

export function isSprintMetaBug(bug = {}) {
  const whiteboard = String(bug.whiteboard || "").toLowerCase();
  const keywords = Array.isArray(bug.keywords) ? bug.keywords : [];

  return whiteboard.includes(SPRINT_WHITEBOARD_TAG) && keywords.some((keyword) => (
    String(keyword).trim().toLowerCase() === "meta"
  ));
}

export function normalizeSprintName(value) {
  const name = String(value || "")
    .trim()
    .replace(/^\[sprint\]\s*-\s*/i, "");

  if (!name) {
    const error = new Error("Enter a sprint name.");

    error.statusCode = 400;
    throw error;
  }

  return name;
}

export function formatSprintSummary(name) {
  return `${SPRINT_TITLE_PREFIX}${normalizeSprintName(name)}`;
}

export function normalizeSprintDeadline(value) {
  const deadline = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !getDateOnly(`${deadline}T12:00:00Z`)) {
    const error = new Error("Enter a valid sprint end date.");

    error.statusCode = 400;
    throw error;
  }

  return deadline;
}

export function normalizeSprintMeta(bug = {}) {
  const summary = String(bug.summary || `Bug ${bug.id}`).trim();

  return {
    id: String(bug.id),
    summary,
    name: summary.replace(/^\[sprint\]\s*-\s*/i, ""),
    url: getBugUrl(bug.id),
    deadline: getDateOnly(bug.deadline),
    createdAt: bug.creation_time || "",
    isOpen: bug.is_open !== false,
    status: bug.status || "",
    dependsOn: uniqueIds(bug.depends_on),
  };
}

export function getSprintDeadlineDefault(now = new Date()) {
  const date = new Date(now);
  const daysUntilFriday = (5 - date.getDay() + 7) % 7;

  date.setDate(date.getDate() + daysUntilFriday + 14);
  return date.toISOString().slice(0, 10);
}

function getSprintPeople(cards = []) {
  const people = new Map();

  for (const card of cards) {
    if (!card.assignee?.email) {
      continue;
    }

    const key = card.assignee.email.toLowerCase();
    const current = people.get(key) || {
      email: card.assignee.email,
      name: card.assignee.name || card.assignee.email,
      completePoints: 0,
      points: 0,
      remainingPoints: 0,
      stories: 0,
    };
    const points = getPoints(card);

    current.points += points;
    current.stories++;
    if (isComplete(card)) {
      current.completePoints += points;
    } else {
      current.remainingPoints += points;
    }
    people.set(key, current);
  }

  return Array.from(people.values()).sort(sortByName);
}

function getSprintMembershipStartDate({ sprint, card, startDate, historyByBugId }) {
  let memberSince = startDate;

  for (const entry of getHistoryEntries(getHistoryValue(historyByBugId, sprint.id))) {
    const date = getDateOnly(entry.when);

    for (const change of entry.changes || []) {
      if (change.field_name !== "depends_on") {
        continue;
      }

      if (getChangedIds(change.added).includes(card.id)) {
        memberSince = date || memberSince;
      }

      if (getChangedIds(change.removed).includes(card.id)) {
        memberSince = "";
      }
    }
  }

  return memberSince || startDate;
}

function getStoryCompletionDate({ card, fallbackDate, historyByBugId }) {
  let completionDate = "";

  for (const entry of getHistoryEntries(getHistoryValue(historyByBugId, card.id))) {
    const date = getDateOnly(entry.when);

    for (const change of entry.changes || []) {
      if (change.field_name === "status") {
        if (isClosedStatus(change.added)) {
          completionDate = date || completionDate;
        } else if (isOpenStatus(change.added)) {
          completionDate = "";
        }
      }

      if (change.field_name === "resolution") {
        if (String(change.added || "").trim()) {
          completionDate = date || completionDate;
        } else if (String(change.removed || "").trim()) {
          completionDate = "";
        }
      }

      if (change.field_name === "keywords") {
        if (/checkin-needed-tb/i.test(String(change.added || ""))) {
          completionDate = date || completionDate;
        } else if (/checkin-needed-tb/i.test(String(change.removed || ""))) {
          completionDate = "";
        }
      }
    }
  }

  return isComplete(card) ? completionDate || fallbackDate : "";
}

function getBurnDown({
  cards,
  endDate,
  historyByBugId,
  now,
  sprint,
  startDate,
  totalPoints,
}) {
  const start = Date.parse(`${startDate || ""}T00:00:00Z`);
  const end = Date.parse(`${endDate || ""}T23:59:59Z`);
  const today = new Date(now).toISOString().slice(0, 10);
  const current = Date.parse(`${today}T00:00:00Z`);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return [];
  }

  const visibleEnd = Math.min(end, Math.max(start, current));
  const duration = Math.max(DAY_MS, end - start);
  const memberships = new Map(cards.map((card) => [card.id, {
    completeAt: getStoryCompletionDate({
      card,
      fallbackDate: today,
      historyByBugId,
    }),
    memberSince: getSprintMembershipStartDate({
      card,
      historyByBugId,
      sprint,
      startDate,
    }),
  }]));
  const series = [];

  for (let timestamp = start; timestamp <= visibleEnd; timestamp += DAY_MS) {
    const ratio = Math.min(1, Math.max(0, (timestamp - start) / duration));

    const date = new Date(timestamp).toISOString().slice(0, 10);
    const actual = cards.reduce((remaining, card) => {
      const history = memberships.get(card.id);

      if (history.memberSince > date || (history.completeAt && history.completeAt <= date)) {
        return remaining;
      }

      return remaining + getPoints(card);
    }, 0);

    series.push({
      date,
      ideal: Math.max(0, totalPoints * (1 - ratio)),
      actual,
    });
  }

  return series;
}

export function getSprintData({
  board,
  historyByBugId = new Map(),
  now = new Date(),
  sprintId,
} = {}) {
  const sprint = (board?.sprints || []).find((item) => item.id === String(sprintId));

  if (!sprint) {
    const error = new Error(`Bug ${sprintId} is not a sprint in this meta board.`);

    error.statusCode = 404;
    throw error;
  }

  const cardsById = new Map((board.cards || []).map((card) => [card.id, card]));
  const memberIds = uniqueIds(sprint.dependsOn);
  const memberCards = memberIds.map((id) => cardsById.get(id)).filter(Boolean);
  const memberIdSet = new Set(memberCards.map((card) => card.id));
  const sourceCards = (board.cards || []).filter((card) => !memberIdSet.has(card.id));
  const columns = {
    assigned: sourceCards.filter((card) => (
      ["assigned", "in-progress", "in-review", "complete"].includes(card.column)
    )),
    backlog: sourceCards.filter((card) => card.column === "backlog"),
    ready: sourceCards.filter((card) => card.column === "ready"),
    sprint: [...memberCards].sort(sortSprintCardsByAssignee),
  };
  const totalPoints = memberCards.reduce((total, card) => total + getPoints(card), 0);
  const completePoints = memberCards
    .filter(isComplete)
    .reduce((total, card) => total + getPoints(card), 0);
  const inProgressPoints = memberCards
    .filter((card) => ["in-progress", "in-review"].includes(card.column))
    .reduce((total, card) => total + getPoints(card), 0);
  const remainingPoints = Math.max(0, totalPoints - completePoints);
  const sprintGroups = new Map();

  for (const card of memberCards) {
    const assignee = card.assignee || { email: "", name: "Unassigned" };
    const key = assignee.email || "unassigned";
    const group = sprintGroups.get(key) || {
      email: assignee.email,
      name: assignee.name || "Unassigned",
      cards: [],
      points: 0,
    };

    group.cards.push(card);
    group.points += getPoints(card);
    sprintGroups.set(key, group);
  }

  const startDate = getDateOnly(sprint.createdAt);
  const endDate = sprint.deadline;
  const today = new Date(now).toISOString().slice(0, 10);
  const endTimestamp = Date.parse(`${endDate || ""}T23:59:59Z`);
  const todayTimestamp = Date.parse(`${today}T00:00:00Z`);

  return {
    ...sprint,
    boardId: board.id,
    board: board.metaBug,
    metaColors: board.metaColors || {},
    cards: memberCards,
    columns: Object.fromEntries(Object.entries(columns).map(([id, cards]) => [id, {
      cards,
      points: cards.reduce((total, card) => total + getPoints(card), 0),
    }])),
    groups: Array.from(sprintGroups.values()).sort(sortByName),
    assignees: board.assignees || [],
    childMetas: board.childMetas || [],
    stats: {
      totalPoints,
      remainingPoints,
      inProgressPoints,
      completePoints,
      people: getSprintPeople(memberCards),
      peopleWithPoints: getSprintPeople(memberCards).filter((person) => person.points > 0).length,
    },
    startDate,
    endDate,
    daysRemaining: Number.isFinite(endTimestamp) && Number.isFinite(todayTimestamp)
      ? Math.ceil((endTimestamp - todayTimestamp) / DAY_MS)
      : null,
    burnDown: getBurnDown({
      cards: memberCards,
      startDate,
      endDate,
      totalPoints,
      historyByBugId,
      now,
      sprint,
    }),
  };
}

export async function createSprint({
  board,
  name,
  deadline,
  createBug,
} = {}) {
  const product = String(board?.metaBug?.product || "").trim();
  const component = String(board?.metaBug?.component || "").trim();

  if (!product || !component) {
    const error = new Error("The meta board must have a Bugzilla product and component before creating a sprint.");

    error.statusCode = 400;
    throw error;
  }

  const result = await createBug({
    blocks: [String(board.metaBug.id)],
    component,
    deadline: normalizeSprintDeadline(deadline),
    description: `Sprint for Bug ${board.metaBug.id}: ${board.metaBug.summary}`,
    keywords: ["meta"],
    op_sys: board.metaBug.opSys || "All",
    platform: board.metaBug.platform || "All",
    product,
    summary: formatSprintSummary(name),
    type: "task",
    version: board.metaBug.version || "unspecified",
    whiteboard: SPRINT_WHITEBOARD_TAG,
  });
  const id = String(result?.id || result?.ids?.[0] || "").trim();

  if (!/^\d+$/.test(id)) {
    throw new Error("Bugzilla did not return the new sprint bug ID.");
  }

  return id;
}

export async function rolloverSprint({
  board,
  previousSprintId,
  nextSprintId,
  removeStoryIds = [],
  storyIds = [],
  updateBug,
} = {}) {
  const previous = (board?.sprints || []).find((sprint) => sprint.id === String(previousSprintId));
  const next = (board?.sprints || []).find((sprint) => sprint.id === String(nextSprintId));

  if (!previous || !next) {
    const error = new Error("Both the current and next sprint must belong to this meta board.");

    error.statusCode = 400;
    throw error;
  }

  const boardStoryIds = new Set((board.cards || []).map((card) => card.id));
  const oldMembers = uniqueIds(previous.dependsOn);
  const eligible = oldMembers.filter((id) => boardStoryIds.has(id));
  const removed = uniqueIds(removeStoryIds).filter((id) => eligible.includes(id));
  const removedSet = new Set(removed);
  const selected = uniqueIds(storyIds).filter((id) => removedSet.has(id));
  const nextMembers = uniqueIds([...(next.dependsOn || []), ...selected]);
  const oldMembersAfterRollover = oldMembers.filter((id) => !removedSet.has(id));

  await updateBug(previous.id, {
    depends_on: { set: oldMembersAfterRollover },
  });
  await updateBug(next.id, {
    depends_on: { set: nextMembers },
  });
  await updateBug(previous.id, {
    resolution: "FIXED",
    status: "RESOLVED",
  });

  return {
    eligibleStoryIds: eligible,
    movedStoryIds: selected,
    removedStoryIds: Array.from(removedSet),
  };
}

export async function updateSprint({ sprint, changes = {}, updateBug } = {}) {
  const updates = {};

  if (Object.hasOwn(changes, "name")) {
    updates.summary = formatSprintSummary(changes.name);
  }

  if (Object.hasOwn(changes, "deadline")) {
    updates.deadline = normalizeSprintDeadline(changes.deadline);
  }

  if (!Object.keys(updates).length) {
    return null;
  }

  return updateBug(sprint.id, updates);
}

export async function setSprintStoryMembership({
  board,
  sprintId,
  storyId,
  member,
  updateBug,
} = {}) {
  const sprint = (board?.sprints || []).find((item) => item.id === String(sprintId));
  const normalizedStoryId = uniqueIds([storyId])[0];
  const isBoardStory = (board?.cards || []).some((card) => card.id === normalizedStoryId);

  if (!sprint || !normalizedStoryId || !isBoardStory) {
    const error = new Error("Choose a story from this meta board.");

    error.statusCode = 400;
    throw error;
  }

  const members = new Set(uniqueIds(sprint.dependsOn));

  if (member) {
    members.add(normalizedStoryId);
  } else {
    members.delete(normalizedStoryId);
  }

  return updateBug(sprint.id, {
    depends_on: { set: Array.from(members) },
  });
}
