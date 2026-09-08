import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getMetaBoardBugDetail,
  getMetaBoardData,
  parseMetaBoardBugIds,
  updateMetaBoardBug,
} from "../commands/graph/meta-boards.mjs";
import {
  addMetaBoard,
  assignMetaBoardColors,
  readMetaBoardStore,
  removeMetaBoard,
  setMetaBoardReviewGroup,
} from "../commands/graph/meta-board-store.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

function makeBug({
  id,
  summary = `Bug ${id}`,
  dependsOn = [],
  blocks = [],
  points = null,
  assignee = "",
  keywords = [],
  isOpen = true,
  resolution = "---",
  creationTime = "",
}) {
  return {
    id: String(id),
    summary,
    depends_on: dependsOn,
    blocks,
    cf_fx_points: points,
    assigned_to: assignee,
    assigned_to_detail: assignee
      ? { email: assignee, real_name: assignee.replace(/@.*/, "") }
      : {},
    keywords,
    is_open: isOpen,
    resolution,
    status: isOpen ? "NEW" : "RESOLVED",
    creation_time: creationTime,
  };
}

test("meta board store saves independent boards by root meta bug", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-meta-boards-"));

  t.after(() => rm(directory, { force: true, recursive: true }));

  await addMetaBoard({ homeDirectory: directory, metaBugId: "100001" });
  await addMetaBoard({ homeDirectory: directory, metaBugId: "100002" });
  await addMetaBoard({ homeDirectory: directory, metaBugId: "100001" });

  assert.deepEqual(
    (await readMetaBoardStore({ homeDirectory: directory })).boards.map((board) => board.id),
    ["100001", "100002"],
  );

  await removeMetaBoard({ boardId: "100001", homeDirectory: directory });

  assert.deepEqual(
    (await readMetaBoardStore({ homeDirectory: directory })).boards.map((board) => board.id),
    ["100002"],
  );
});

test("meta board store keeps unique child meta colors stable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-meta-colors-"));

  t.after(() => rm(directory, { force: true, recursive: true }));

  const first = await assignMetaBoardColors({
    homeDirectory: directory,
    metaBugIds: ["2061185", "2061195"],
  });
  const expanded = await assignMetaBoardColors({
    homeDirectory: directory,
    metaBugIds: ["1000000", "2061185", "2061195"],
  });

  assert.notEqual(first["2061185"], first["2061195"]);
  assert.equal(expanded["2061185"], first["2061185"]);
  assert.equal(expanded["2061195"], first["2061195"]);
  assert.notEqual(expanded["1000000"], first["2061185"]);
  assert.notEqual(expanded["1000000"], first["2061195"]);
});

test("meta board store saves a review group for each board", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-meta-review-groups-"));

  t.after(() => rm(directory, { force: true, recursive: true }));

  await addMetaBoard({ homeDirectory: directory, metaBugId: "100001" });
  await addMetaBoard({ homeDirectory: directory, metaBugId: "100002" });
  await setMetaBoardReviewGroup({
    boardId: "100001",
    homeDirectory: directory,
    reviewGroup: "#Thunderbird-Front-End-Reviewers",
  });

  assert.deepEqual(
    (await readMetaBoardStore({ homeDirectory: directory })).boards.map((board) => ({
      id: board.id,
      reviewGroup: board.reviewGroup,
    })),
    [
      { id: "100001", reviewGroup: "thunderbird-front-end-reviewers" },
      { id: "100002", reviewGroup: "" },
    ],
  );

  await setMetaBoardReviewGroup({
    boardId: "100001",
    homeDirectory: directory,
    reviewGroup: "",
  });

  assert.equal(
    (await readMetaBoardStore({ homeDirectory: directory })).boards[0].reviewGroup,
    "",
  );
});

test("meta board derives every story column from points, ownership, patches, reviews, and completion", async () => {
  const bugs = new Map([
    ["900000", makeBug({ id: "900000", summary: "Calendar meta", dependsOn: ["900100", "900200"] })],
    ["900100", makeBug({
      id: "900100",
      summary: "Core stories",
      dependsOn: ["100001", "100002", "100003", "100004"],
      keywords: ["meta"],
    })],
    ["900200", makeBug({
      id: "900200",
      summary: "Polish stories",
      dependsOn: ["100005", "100006"],
      keywords: ["meta"],
    })],
    ["100001", makeBug({ id: "100001", summary: "Backlog story" })],
    ["100002", makeBug({ id: "100002", summary: "Ready story", points: 3 })],
    ["100003", makeBug({ id: "100003", summary: "Assigned story", points: 5, assignee: "alice@example.com" })],
    ["100004", makeBug({ id: "100004", summary: "Patch story", points: 2, assignee: "bob@example.com" })],
    ["100005", makeBug({ id: "100005", summary: "Review story", points: 1, assignee: "alice@example.com" })],
    ["100006", makeBug({ id: "100006", summary: "Complete story", keywords: ["checkin-needed-tb"] })],
  ]);
  const attachmentIds = new Map([
    ["100004", ["200004"]],
    ["100005", ["200005"]],
  ]);
  const requestedFields = [];
  const data = await getMetaBoardData({
    metaBugId: "900000",
    getBugsByIds: async (ids, { includeFields }) => {
      requestedFields.push(includeFields);

      return ids.map((id) => bugs.get(String(id))).filter(Boolean);
    },
    getBugsWithAttachmentsByIds: async (ids) => ids.map((id) => ({
      id,
      attachments: (attachmentIds.get(String(id)) || []).map((revision) => ({
        content_type: "text/x-phabricator-request",
        file_name: `request-D${revision}`,
      })),
    })),
    phab: async ({ route, params }) => {
      if (route === "differential.query") {
        return {
          result: params.ids.map((id) => ({
            id: String(id),
            status: "status-needs-review",
            statusName: "Needs Review",
            title: `Revision ${id}`,
            uri: `https://phabricator.services.mozilla.com/D${id}`,
          })),
        };
      }

      return {
        result: {
          200004: [],
          200005: [{ action: "accept", authorPHID: "PHID-USER-reviewer" }],
        },
      };
    },
  });

  assert.deepEqual(data.columns.backlog.map((card) => card.id), ["100001"]);
  assert.deepEqual(data.columns.ready.map((card) => card.id), ["100002"]);
  assert.deepEqual(data.columns.assigned.map((card) => card.id), ["100003"]);
  assert.deepEqual(data.columns["in-progress"].map((card) => card.id), ["100004"]);
  assert.deepEqual(data.columns["in-review"].map((card) => card.id), ["100005"]);
  assert.deepEqual(data.columns.complete.map((card) => card.id), ["100006"]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(data.columns)
        .filter(([column]) => column !== "backlog")
        .map(([column, cards]) => [
          column,
          cards.reduce((total, card) => total + (Number(card.points) || 0), 0),
        ]),
    ),
    {
      ready: 3,
      assigned: 5,
      "in-progress": 2,
      "in-review": 1,
      complete: 0,
    },
  );
  assert.equal(data.columns["in-review"][0].parentMeta.summary, "Polish stories");
  assert.deepEqual(data.assignees.map((assignee) => assignee.email), [
    "alice@example.com",
    "bob@example.com",
  ]);
  assert.ok(requestedFields.every((fields) => fields.includes("cf_fx_points")));
});

test("meta boards do not classify ordinary bugs with dependencies as child metas", async () => {
  const root = makeBug({
    id: "900000",
    dependsOn: ["900100", "100001"],
  });
  const bugs = new Map([
    [root.id, root],
    ["900100", makeBug({
      id: "900100",
      summary: "Actual child meta",
      dependsOn: ["100002"],
      keywords: ["meta"],
    })],
    ["100001", makeBug({
      id: "100001",
      summary: "Story with a prerequisite",
      dependsOn: ["100003"],
    })],
    ["100002", makeBug({ id: "100002", summary: "Story under child meta" })],
    ["100003", makeBug({ id: "100003", summary: "Nested prerequisite" })],
  ]);
  const data = await getMetaBoardData({
    metaBugId: root.id,
    getBugsByIds: async (ids) => ids.map((id) => bugs.get(String(id))).filter(Boolean),
    getBugsWithAttachmentsByIds: async () => [],
    phab: async () => ({ result: [] }),
  });

  assert.deepEqual(data.childMetas.map((meta) => meta.id), ["900100"]);
  assert.deepEqual(data.cards.map((card) => card.id), ["100001", "100002", "100003"]);
  assert.equal(data.cards.find((card) => card.id === "100001").parentMeta.id, root.id);
  assert.equal(data.cards.find((card) => card.id === "100003").parentMeta.id, root.id);
});

test("meta boards do not treat sprint membership as board membership", async () => {
  const root = makeBug({ id: "900000", dependsOn: ["900100", "900200"] });
  const sprint = {
    ...makeBug({
      id: "900200",
      summary: "[SPRINT] - September 1",
      dependsOn: ["100002"],
      keywords: ["meta"],
    }),
    whiteboard: "[tb-desktop-sprint]",
  };
  const bugs = new Map([
    [root.id, root],
    ["900100", makeBug({
      id: "900100",
      summary: "Board stories",
      dependsOn: ["100001"],
      keywords: ["meta"],
    })],
    [sprint.id, sprint],
    ["100001", makeBug({ id: "100001", summary: "Board story" })],
    ["100002", makeBug({ id: "100002", summary: "Outside story" })],
  ]);
  const data = await getMetaBoardData({
    metaBugId: root.id,
    getBugsByIds: async (ids) => ids.map((id) => bugs.get(String(id))).filter(Boolean),
    getBugsWithAttachmentsByIds: async () => [],
    phab: async () => ({ result: [] }),
  });

  assert.deepEqual(data.cards.map((card) => card.id), ["100001"]);
  assert.deepEqual(data.sprints.map((item) => item.id), ["900200"]);
});

test("meta boards request and display a configured story points field", async () => {
  const root = makeBug({ id: "900000", dependsOn: ["100001"] });
  const story = {
    ...makeBug({ id: "100001", summary: "Configured points" }),
    cf_custom_points: 8,
  };
  const bugs = new Map([[root.id, root], [story.id, story]]);
  const requestedFields = [];
  const data = await getMetaBoardData({
    metaBugId: root.id,
    appConfig: { bugzilla: { storyPointsField: "cf_custom_points" } },
    getBugsByIds: async (ids, { includeFields }) => {
      requestedFields.push(includeFields);

      return ids.map((id) => bugs.get(String(id))).filter(Boolean);
    },
    getBugsWithAttachmentsByIds: async () => [],
    phab: async () => ({ result: [] }),
  });

  assert.equal(data.cards[0].points, 8);
  assert.deepEqual(data.columns.ready.map((card) => card.id), ["100001"]);
  assert.ok(requestedFields.every((fields) => fields.includes("cf_custom_points")));
});

test("meta boards sort story cards oldest first", async () => {
  const root = makeBug({
    id: "900000",
    dependsOn: ["100001", "100003", "100002"],
  });
  const bugs = new Map([
    [root.id, root],
    ["100001", makeBug({ id: "100001", summary: "First", creationTime: "2024-01-01T00:00:00Z" })],
    ["100002", makeBug({ id: "100002", summary: "Second", creationTime: "2025-01-01T00:00:00Z" })],
    ["100003", makeBug({ id: "100003", summary: "Third", creationTime: "2026-01-01T00:00:00Z" })],
  ]);
  const data = await getMetaBoardData({
    metaBugId: root.id,
    getBugsByIds: async (ids) => ids.map((id) => bugs.get(String(id))).filter(Boolean),
    getBugsWithAttachmentsByIds: async () => [],
    phab: async () => ({ result: [] }),
  });

  assert.deepEqual(data.columns.backlog.map((card) => card.id), [
    "100001",
    "100002",
    "100003",
  ]);
});

test("meta board details retain the latest saved description and update editable fields", async () => {
  const bug = makeBug({
    id: "100001",
    summary: "Story",
    dependsOn: ["100002"],
    blocks: ["100003"],
    points: 2,
    assignee: "alice@example.com",
  });
  const relations = new Map([
    ["100001", bug],
    ["100002", makeBug({ id: "100002", summary: "Prerequisite" })],
    ["100003", makeBug({ id: "100003", summary: "Dependent" })],
  ]);
  const detail = await getMetaBoardBugDetail({
    bugId: "100001",
    getBugsByIds: async (ids) => ids.map((id) => relations.get(String(id))).filter(Boolean),
    getBugComments: async () => [
      {
        count: 0,
        creator: "reporter@example.com",
        creator_detail: { real_name: "Reporter" },
        creation_time: "2026-09-07T12:00:00Z",
        text: "Original description",
      },
      {
        count: 1,
        creator: "alice@example.com",
        creation_time: "2026-09-07T13:00:00Z",
        is_private: true,
        text: "TB-Tools story description:\n\nCurrent description",
      },
    ],
    getNotionStoriesByBugId: async () => ({
      stories: [{ title: "Story", url: "https://www.notion.so/story" }],
    }),
  });
  const updates = [];

  await updateMetaBoardBug({
    bugId: "100001",
    changes: {
      summary: "Renamed story",
      points: "5",
      assignee: "bob@example.com",
      dependsOn: "100004, 100005",
      blocks: "100006",
      description: "Rewritten description",
    },
    updateBug: async (id, update) => updates.push({ id, update }),
  });

  assert.equal(detail.description, "Current description");
  assert.deepEqual(detail.comments, [
    {
      id: "0",
      author: "Reporter",
      email: "reporter@example.com",
      createdAt: "2026-09-07T12:00:00Z",
      isPrivate: false,
      text: "Original description",
    },
    {
      id: "1",
      author: "alice@example.com",
      email: "alice@example.com",
      createdAt: "2026-09-07T13:00:00Z",
      isPrivate: true,
      text: "TB-Tools story description:\n\nCurrent description",
    },
  ]);
  assert.equal(detail.dependsOn[0].summary, "Prerequisite");
  assert.equal(detail.blocks[0].summary, "Dependent");
  assert.equal(detail.notion.stories[0].url, "https://www.notion.so/story");
  assert.deepEqual(updates, [{
    id: "100001",
    update: {
      summary: "Renamed story",
      cf_fx_points: 5,
      assigned_to: "bob@example.com",
      depends_on: { set: ["100004", "100005"] },
      blocks: { set: ["100006"] },
      comment: { body: "TB-Tools story description:\n\nRewritten description" },
    },
  }]);
  assert.deepEqual(parseMetaBoardBugIds("100004, 100005 100004"), ["100004", "100005"]);
});

test("interactive graph server manages meta board endpoints and invalidates updates", async (t) => {
  let boards = [{ id: "900000", metaBugId: "900000" }];
  let boardLoads = 0;
  const updates = [];
  const serverInfo = await startInteractiveGraphServer({
    getMetaBoardData: async ({ metaBugId }) => {
      boardLoads++;
      return {
        id: metaBugId,
        metaBug: { id: metaBugId, summary: "Calendar meta" },
        cards: [{ parentMeta: { id: "100001" } }],
        columns: {},
      };
    },
    getBugsByIds: async (ids) => ids.map((id) => ({
      id,
      summary: id === "900000" ? "Calendar meta" : `Bug ${id}`,
    })),
    getMetaBoardBugDetail: async ({ bugId }) => ({
      id: bugId,
      summary: "Story",
      dependsOn: [],
      blocks: [],
      notion: null,
    }),
    graphs: [],
    html: "<!doctype html><p>graph</p>",
    assignMetaBoardColors: async () => ({ "100001": "#2563eb" }),
    readMetaBoardStore: async () => ({ boards }),
    removeMetaBoard: async ({ boardId }) => {
      boards = boards.filter((board) => board.id !== boardId);
      return { boards };
    },
    token: "secret",
    updateMetaBoardBug: async (options) => updates.push(options),
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const boardEndpoint = new URL("api/meta-boards/900000?token=secret", serverInfo.url);
  const boardsEndpoint = new URL("api/meta-boards?token=secret", serverInfo.url);
  const boardList = await (await fetch(boardsEndpoint)).json();
  const firstBoard = await (await fetch(boardEndpoint)).json();

  assert.deepEqual(boardList.boards, [{
    id: "900000",
    metaBugId: "900000",
    summary: "Calendar meta",
  }]);
  assert.equal(firstBoard.metaBug.summary, "Calendar meta");
  assert.equal(firstBoard.metaColors["100001"], "#2563eb");
  assert.equal(boardLoads, 1);
  await fetch(boardEndpoint);
  assert.equal(boardLoads, 1);

  const detailEndpoint = new URL(
    "api/meta-boards/900000/bugs/100001?token=secret",
    serverInfo.url,
  );
  const updateResponse = await fetch(detailEndpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", changes: { summary: "Updated" } }),
  });

  assert.equal(updateResponse.ok, true);
  assert.equal(updates.length, 1);
  await fetch(boardEndpoint);
  assert.equal(boardLoads, 2);
});

test("interactive graph server loads review group assignees without delaying the board", async (t) => {
  let boards = [{ id: "900000", metaBugId: "900000", reviewGroup: "" }];
  const serverInfo = await startInteractiveGraphServer({
    assignMetaBoardColors: async () => ({ "100001": "#2563eb" }),
    getMetaBoardData: async ({ metaBugId }) => ({
      assignees: [{ email: "outside@example.com", name: "Outside" }],
      cards: [{ parentMeta: { id: "100001" } }],
      columns: {},
      id: metaBugId,
      metaBug: { id: metaBugId, summary: "Calendar meta" },
    }),
    getBugsByIds: async (ids) => ids.map((id) => ({
      id,
      summary: id === "900000" ? "Calendar meta" : `Bug ${id}`,
    })),
    getReviewGroupAssignees: async ({ reviewGroup }) => {
      assert.equal(reviewGroup, "thunderbird-reviewers");
      return [{ email: "reviewer@example.com", name: "Review Group Member" }];
    },
    graphs: [],
    html: "<!doctype html><p>graph</p>",
    readMetaBoardStore: async () => ({ boards }),
    setMetaBoardReviewGroup: async ({ boardId, reviewGroup }) => {
      boards = boards.map((board) => (
        board.id === boardId
          ? { ...board, reviewGroup: reviewGroup.replace(/^#/, "").toLowerCase() }
          : board
      ));
      return { boards };
    },
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const boardEndpoint = new URL("api/meta-boards/900000?token=secret", serverInfo.url);
  const initialBoard = await (await fetch(boardEndpoint)).json();

  assert.deepEqual(initialBoard.assignees, [{ email: "outside@example.com", name: "Outside" }]);

  const updateResponse = await fetch(boardEndpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reviewGroup: "#thunderbird-reviewers",
      token: "secret",
    }),
  });
  const updatedBoard = await updateResponse.json();

  assert.equal(updateResponse.ok, true);
  assert.deepEqual(
    updatedBoard.board.assignees,
    [{ email: "outside@example.com", name: "Outside" }],
  );
  assert.deepEqual(updatedBoard.board.reviewGroup, {
    slug: "thunderbird-reviewers",
  });

  const assigneesEndpoint = new URL(
    "api/meta-boards/900000/review-group-assignees?token=secret",
    serverInfo.url,
  );
  const mappedAssignees = await (await fetch(assigneesEndpoint)).json();

  assert.deepEqual(mappedAssignees.assignees, [
    { email: "reviewer@example.com", name: "Review Group Member" },
  ]);
});
