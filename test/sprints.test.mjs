import assert from "node:assert/strict";
import { test } from "node:test";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import {
  createSprint,
  formatSprintSummary,
  getSprintData,
  getSprintDeadlineDefault,
  isSprintMetaBug,
  rolloverSprint,
  setSprintStoryMembership,
} from "../commands/graph/sprints.mjs";

function makeCard({
  id,
  column = "ready",
  points = 0,
  assignee = null,
  parentMeta = { id: "900100", summary: "Stories" },
} = {}) {
  return {
    assignee,
    column,
    id: String(id),
    parentMeta,
    points,
    summary: `Story ${id}`,
    url: `https://bugzilla.mozilla.org/show_bug.cgi?id=${id}`,
  };
}

function makeBoard() {
  const alice = { email: "alice@example.com", name: "Alice" };
  const bob = { email: "bob@example.com", name: "Bob" };
  const cards = [
    makeCard({ id: "100001", points: 3, assignee: alice }),
    makeCard({ id: "100002", column: "in-progress", points: 2, assignee: bob }),
    makeCard({ id: "100003", column: "complete", points: 5, assignee: alice }),
    makeCard({ id: "100004", column: "backlog" }),
  ];

  return {
    assignees: [alice, bob],
    cards,
    childMetas: [{ id: "900100", summary: "Stories" }],
    id: "900000",
    metaBug: {
      component: "Frontend",
      id: "900000",
      opSys: "All",
      platform: "All",
      product: "Thunderbird",
      summary: "Desktop work",
      version: "unspecified",
    },
    sprints: [
      {
        createdAt: "2026-08-17T10:00:00Z",
        deadline: "2026-08-28",
        dependsOn: ["100001", "100002", "100003", "999999"],
        id: "900200",
        isOpen: true,
        name: "August 2",
        summary: "[SPRINT] - August 2",
        url: "https://bugzilla.mozilla.org/show_bug.cgi?id=900200",
      },
      {
        createdAt: "2026-08-31T10:00:00Z",
        deadline: "2026-09-11",
        dependsOn: [],
        id: "900201",
        isOpen: true,
        name: "September 1",
        summary: "[SPRINT] - September 1",
        url: "https://bugzilla.mozilla.org/show_bug.cgi?id=900201",
      },
    ],
  };
}

test("sprints require a tagged meta bug and normalize the summary", () => {
  assert.equal(isSprintMetaBug({
    keywords: ["meta"],
    whiteboard: "[tb-desktop-sprint] calendar",
  }), true);
  assert.equal(isSprintMetaBug({
    keywords: ["meta"],
    whiteboard: "calendar",
  }), false);
  assert.equal(isSprintMetaBug({
    keywords: [],
    whiteboard: "[tb-desktop-sprint]",
  }), false);
  assert.equal(formatSprintSummary("[SPRINT] - Calendar hardening"), "[SPRINT] - Calendar hardening");
  assert.equal(
    getSprintDeadlineDefault(new Date("2026-08-21T12:00:00Z")),
    "2026-09-04",
  );
});

test("sprint data only includes board stories and calculates planning totals", () => {
  const sprint = getSprintData({
    board: makeBoard(),
    now: new Date("2026-08-21T12:00:00Z"),
    sprintId: "900200",
  });

  assert.deepEqual(sprint.cards.map((card) => card.id), ["100001", "100002", "100003"]);
  assert.deepEqual(sprint.columns.ready.cards.map((card) => card.id), []);
  assert.deepEqual(sprint.columns.backlog.cards.map((card) => card.id), ["100004"]);
  assert.deepEqual(sprint.columns.sprint.cards.map((card) => card.id), ["100001", "100003", "100002"]);
  assert.equal(sprint.stats.totalPoints, 10);
  assert.equal(sprint.stats.remainingPoints, 5);
  assert.equal(sprint.stats.inProgressPoints, 2);
  assert.equal(sprint.stats.completePoints, 5);
  assert.equal(sprint.stats.peopleWithPoints, 2);
  assert.deepEqual(sprint.groups.map((group) => group.name), ["Alice", "Bob"]);
  assert.ok(sprint.burnDown.length > 0);
});

test("sprint burndown uses Bugzilla membership and completion history", () => {
  const historyByBugId = new Map([
    ["900200", {
      history: [{
        changes: [{
          added: "100001, 100002, 100003",
          field_name: "depends_on",
          removed: "",
        }],
        when: "2026-08-18T09:00:00Z",
      }],
      id: "900200",
    }],
    ["100003", {
      history: [{
        changes: [{
          added: "RESOLVED",
          field_name: "status",
          removed: "NEW",
        }],
        when: "2026-08-20T14:00:00Z",
      }],
      id: "100003",
    }],
  ]);
  const sprint = getSprintData({
    board: makeBoard(),
    historyByBugId,
    now: new Date("2026-08-21T12:00:00Z"),
    sprintId: "900200",
  });
  const actualByDate = new Map(sprint.burnDown.map((item) => [item.date, item.actual]));

  assert.equal(actualByDate.get("2026-08-17"), 0);
  assert.equal(actualByDate.get("2026-08-18"), 10);
  assert.equal(actualByDate.get("2026-08-20"), 5);
  assert.equal(actualByDate.get("2026-08-21"), 5);
});

test("creating a sprint uses the board's Bugzilla component and sprint metadata", async () => {
  const calls = [];
  const id = await createSprint({
    board: makeBoard(),
    createBug: async (fields) => {
      calls.push(fields);
      return { id: "900202" };
    },
    deadline: "2026-09-11",
    name: "September 2",
  });

  assert.equal(id, "900202");
  assert.deepEqual(calls, [{
    blocks: ["900000"],
    component: "Frontend",
    deadline: "2026-09-11",
    description: "Sprint for Bug 900000: Desktop work",
    keywords: ["meta"],
    op_sys: "All",
    platform: "All",
    product: "Thunderbird",
    summary: "[SPRINT] - September 2",
    type: "task",
    version: "unspecified",
    whiteboard: "[tb-desktop-sprint]",
  }]);
});

test("rolling over a sprint batches the relationship changes and closes the old sprint", async () => {
  const board = makeBoard();
  const updates = [];

  await rolloverSprint({
    board,
    nextSprintId: "900201",
    previousSprintId: "900200",
    removeStoryIds: ["100001", "100002"],
    storyIds: ["100001", "100002"],
    updateBug: async (id, changes) => updates.push({ changes, id }),
  });

  assert.deepEqual(updates, [
    { changes: { depends_on: { set: ["100003", "999999"] } }, id: "900200" },
    { changes: { depends_on: { set: ["100001", "100002"] } }, id: "900201" },
    { changes: { resolution: "FIXED", status: "RESOLVED" }, id: "900200" },
  ]);
});

test("sprint membership accepts only stories from the selected meta board", async () => {
  const updates = [];

  await setSprintStoryMembership({
    board: makeBoard(),
    member: false,
    sprintId: "900200",
    storyId: "100002",
    updateBug: async (id, changes) => updates.push({ changes, id }),
  });

  assert.deepEqual(updates, [{
    changes: { depends_on: { set: ["100001", "100003", "999999"] } },
    id: "900200",
  }]);
  await assert.rejects(
    setSprintStoryMembership({
      board: makeBoard(),
      member: true,
      sprintId: "900200",
      storyId: "123456",
      updateBug: async () => {},
    }),
    /Choose a story from this meta board/,
  );
});

test("interactive graph server creates and updates a sprint through board-scoped APIs", async (t) => {
  let created = false;
  let historyRequests = 0;
  const updates = [];
  const serverInfo = await startInteractiveGraphServer({
    assignMetaBoardColors: async () => ({ "900100": "#2563eb" }),
    createSprint: async () => {
      created = true;
      return "900201";
    },
    getMetaBoardData: async () => {
      const board = makeBoard();

      board.sprints = created ? board.sprints : [board.sprints[0]];
      return board;
    },
    getBugHistoryByIds: async () => {
      historyRequests++;
      return [];
    },
    graphs: [],
    html: "<!doctype html><p>graph</p>",
    readMetaBoardStore: async () => ({
      boards: [{ id: "900000", metaBugId: "900000" }],
    }),
    token: "secret",
    updateBug: async (id, changes) => updates.push({ changes, id }),
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const createEndpoint = new URL("api/meta-boards/900000/sprints", serverInfo.url);
  const createResponse = await fetch(createEndpoint, {
    body: JSON.stringify({
      deadline: "2026-09-11",
      name: "September 1",
      token: "secret",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const createdSprint = await createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.equal(createdSprint.sprint.id, "900201");
  assert.equal(createdSprint.previousSprint.id, "900200");

  const sprintEndpoint = new URL("api/meta-boards/900000/sprints/900200?token=secret", serverInfo.url);
  await fetch(sprintEndpoint);
  await fetch(sprintEndpoint);
  assert.equal(historyRequests, 1);

  const membershipEndpoint = new URL(
    "api/meta-boards/900000/sprints/900201/stories/100004",
    serverInfo.url,
  );
  const membershipResponse = await fetch(membershipEndpoint, {
    body: JSON.stringify({ member: true, token: "secret" }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const updatedSprint = await membershipResponse.json();

  assert.equal(membershipResponse.ok, true);
  assert.deepEqual(updates, [{
    changes: { depends_on: { set: ["100004"] } },
    id: "900201",
  }]);
  assert.deepEqual(updatedSprint.sprint.cards.map((card) => card.id), []);
});
