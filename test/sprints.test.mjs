import assert from "node:assert/strict";
import { test } from "node:test";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import {
  createSprint,
  formatSprintSummary,
  getSprintData,
  getSprintPatchCompletionDates,
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

test("landing keeps the check-in completion date and the ideal reaches the deadline", () => {
  const historyByBugId = new Map([["100003", { history: [
    { when: "2026-08-18T10:00:00Z", changes: [{ field_name: "keywords", added: "checkin-needed-tb", removed: "" }] },
    { when: "2026-08-20T10:00:00Z", changes: [
      { field_name: "status", added: "RESOLVED", removed: "NEW" },
      { field_name: "resolution", added: "FIXED", removed: "" },
      { field_name: "keywords", added: "", removed: "checkin-needed-tb" },
    ] },
  ] }]]);
  const sprint = getSprintData({ board: makeBoard(), historyByBugId, now: new Date("2026-08-21T12:00:00Z"), sprintId: "900200" });
  const daily = new Map(sprint.burnDown.map(point => [point.date, point]));
  assert.equal(daily.get("2026-08-17").actual, 10);
  assert.equal(daily.get("2026-08-18").actual, 5);
  assert.equal(daily.get("2026-08-20").actual, 5);
  assert.equal(daily.get("2026-08-21").actual, sprint.stats.remainingPoints);
  assert.equal(daily.get("2026-08-22").actual, null);
  assert.equal(sprint.burnDown.at(-1).date, "2026-08-28");
  assert.equal(sprint.burnDown.at(-1).ideal, 0);
});

test("overdue sprints show current remaining points and flag undated completions", () => {
  const sprint = getSprintData({ board: makeBoard(), now: new Date("2026-09-01T12:00:00Z"), sprintId: "900200" });
  assert.equal(sprint.burnDown.at(-1).date, "2026-09-01");
  assert.equal(sprint.burnDown.at(-1).actual, 5);
  assert.equal(sprint.burnDown.at(-1).historyIncomplete, true);
  assert.ok(sprint.burnDown.slice(0, -1).every(point => point.actual === null));
});

test("approved patches use the status transition date, including multiple patches and reapproval", async () => {
  const board = makeBoard();
  const card = board.cards.find(card => card.id === "100003");
  card.patches = [{ id: "D1" }, { id: "D2" }];
  const patchCompletionDates = await getSprintPatchCompletionDates({
    cards: board.cards,
    phab: async ({ params }) => ({ result: { data: [
      { type: "status", fields: { new: "accepted" }, dateCreated: Date.parse("2026-08-18T10:00:00Z") / 1000 },
      ...(params.objectIdentifier === "D2" ? [
        { type: "status", fields: { new: "needs-review" }, dateCreated: Date.parse("2026-08-19T10:00:00Z") / 1000 },
        { type: "status", fields: { new: "accepted" }, dateCreated: Date.parse("2026-08-20T10:00:00Z") / 1000 },
      ] : []),
    ], cursor: {} } }),
  });
  assert.equal(patchCompletionDates.get(card.id), "2026-08-20");
  const sprint = getSprintData({ board, patchCompletionDates, now: new Date("2026-08-21T12:00:00Z"), sprintId: "900200" });
  const daily = new Map(sprint.burnDown.map(point => [point.date, point.actual]));
  assert.equal(daily.get("2026-08-19"), 10);
  assert.equal(daily.get("2026-08-20"), 5);
  assert.equal(sprint.burnDown.find(point => point.date === "2026-08-21").historyIncomplete, false);
  assert.equal((await getSprintPatchCompletionDates({ cards: board.cards, phab: async () => { throw new Error("Unavailable"); } })).size, 0);
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
    { changes: { depends_on: { add: ["100001", "100002"] } }, id: "900201" },
    { changes: { depends_on: { remove: ["100001", "100002"] } }, id: "900200" },
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
    tryMonitor: null,
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

test("failed rollover leaves old membership and status intact when adding fails", async () => {
  const calls = [];
  await assert.rejects(rolloverSprint({
    board: makeBoard(), previousSprintId: "900200", nextSprintId: "900201",
    removeStoryIds: ["100001"], storyIds: ["100001"],
    updateBug: async (id, changes) => { calls.push({ id, changes }); throw new Error("Could not add"); },
  }), /Could not add/);
  assert.deepEqual(calls, [{ id: "900201", changes: { depends_on: { add: ["100001"] } } }]);
});

test("successful creation does not depend on a follow-up board read", async t => {
  let reads = 0;
  const server = await startInteractiveGraphServer({
    tryMonitor: null,
    graphs: [], html: "", token: "secret",
    readMetaBoardStore: async () => ({ boards: [{ id: "900000", metaBugId: "900000" }] }),
    assignMetaBoardColors: async () => ({}),
    getMetaBoardData: async () => {
      if (++reads > 1) throw new Error("Board refresh failed");
      return makeBoard();
    },
    createSprint: async () => "900202",
  });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const response = await fetch(new URL("api/meta-boards/900000/sprints", server.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", name: "Next", deadline: "2026-10-09" }),
  });
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.equal(result.sprint.id, "900202");
  assert.equal(result.previousSprint.id, "900201");
  assert.equal(reads, 1);
});


test("both burndowns count down unstarted work and count unestimated stories", () => {
  const board = makeBoard();
  board.cards.find(card => card.id === "100002").points = null;
  const patchProgressDates = new Map([["100002", "2026-08-18"], ["100003", "2026-08-19"]]);
  const patchCompletionDates = new Map([["100003", "2026-08-20"]]);
  const sprint = getSprintData({ board, patchProgressDates, patchCompletionDates,
    now: new Date("2026-08-21T12:00:00Z"), sprintId: "900200" });
  const stories = new Map(sprint.storyBurnDown.map(point => [point.date, point]));
  const points = new Map(sprint.burnDown.map(point => [point.date, point]));
  assert.equal(stories.get("2026-08-17").ideal, 3);
  assert.equal(stories.get("2026-08-17").actual, 3);
  assert.equal(stories.get("2026-08-17").notStarted, 3);
  assert.equal(stories.get("2026-08-18").notStarted, 2);
  assert.equal(stories.get("2026-08-20").notStarted, 1);
  assert.equal(stories.get("2026-08-21").actual, 2);
  assert.equal(points.get("2026-08-21").actual, 3);
  assert.equal(points.get("2026-08-21").notStarted, 3);
  assert.equal(stories.get("2026-08-22").notStarted, null);
  assert.equal(stories.get("2026-08-22").actual, null);
  assert.equal(stories.get("2026-08-28").ideal, 0);
});

test("unknown start dates hide historical progress but preserve current totals", () => {
  const sprint = getSprintData({ board: makeBoard(), now: new Date("2026-09-01T12:00:00Z"), sprintId: "900200" });
  for (const [series, expected] of [[sprint.burnDown, 3], [sprint.storyBurnDown, 1]]) {
    assert.equal(series.at(-1).notStarted, expected);
    assert.equal(series.at(-1).progressHistoryIncomplete, true);
    assert.ok(series.slice(0, -1).every(point => point.notStarted === null));
  }
});

test("patch creation dates include stories still in progress", async () => {
  const card = makeCard({ id: "100002", column: "in-progress", points: 2 });
  card.patches = [{ id: "D1" }];
  const patchProgressDates = new Map();
  await getSprintPatchCompletionDates({ cards: [card], patchProgressDates,
    phab: async () => ({ result: { data: [{ type: "create", dateCreated: Date.parse("2026-08-18T10:00:00Z") / 1000 }], cursor: {} } }),
  });
  assert.equal(patchProgressDates.get(card.id), "2026-08-18");
});
