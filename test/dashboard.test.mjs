import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getDashboardAgeState,
  getDashboardData,
} from "../commands/graph/dashboard.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = 1_750_000_000_000;
const ME = "PHID-USER-me";
const OTHER = "PHID-USER-other";
const REVIEWER = "PHID-USER-reviewer";
const GROUP = "PHID-PROJ-reviewers";

function makeRevision({
  id,
  authorPHID = ME,
  bugId,
  dateModified = NOW - HOUR,
  statusName,
}) {
  return {
    id: String(id),
    phid: `PHID-DREV-${id}`,
    title: `Bug ${bugId} - Revision ${id}`,
    status: `status-${statusName.toLowerCase().replaceAll(" ", "-")}`,
    statusName,
    authorPHID,
    dateCreated: String(dateModified - HOUR),
    dateModified: String(dateModified),
    reviewers: { [GROUP]: GROUP },
  };
}

function transaction({
  authorPHID,
  content = "",
  dateCreated,
  type,
}) {
  return { action: type, authorPHID, content, dateCreated };
}

test("dashboard age states use green below 24 hours, orange below 48, then red", () => {
  assert.equal(getDashboardAgeState(NOW - (23 * HOUR), NOW).ageState, "fresh");
  assert.equal(getDashboardAgeState(NOW - (30 * HOUR), NOW).ageState, "attention");
  assert.equal(getDashboardAgeState(NOW - (49 * HOUR), NOW).ageState, "overdue");
});

test("dashboard categorizes open patches, queues, and assigned bugs from live API shapes", async () => {
  const mine = [
    makeRevision({
      bugId: "1001",
      dateModified: NOW - (72 * HOUR),
      id: 1001,
      statusName: "Needs Revision",
    }),
    makeRevision({
      bugId: "1002",
      dateModified: NOW - (30 * HOUR),
      id: 1002,
      statusName: "Needs Review",
    }),
    makeRevision({
      bugId: "1003",
      dateModified: NOW - (4 * HOUR),
      id: 1003,
      statusName: "Accepted",
    }),
    makeRevision({
      bugId: "1004",
      dateModified: NOW - (36 * HOUR),
      id: 1004,
      statusName: "Needs Review",
    }),
  ];
  const groupRevisions = [
    makeRevision({
      authorPHID: OTHER,
      bugId: "2001",
      dateModified: NOW - (10 * HOUR),
      id: 2001,
      statusName: "Needs Review",
    }),
    makeRevision({
      authorPHID: OTHER,
      bugId: "2002",
      dateModified: NOW - (55 * HOUR),
      id: 2002,
      statusName: "Needs Review",
    }),
    makeRevision({
      authorPHID: OTHER,
      bugId: "2003",
      dateModified: NOW - (72 * HOUR),
      id: 2003,
      statusName: "Needs Review",
    }),
  ];
  const directlyAssignedRevision = makeRevision({
    authorPHID: OTHER,
    bugId: "2004",
    dateModified: NOW - (20 * HOUR),
    id: 2004,
    statusName: "Needs Review",
  });
  directlyAssignedRevision.reviewers = { [ME]: ME };
  const transactions = new Map([
    ["PHID-DREV-1001", [
      transaction({ authorPHID: ME, dateCreated: NOW - (72 * HOUR), type: "update" }),
      transaction({ authorPHID: REVIEWER, dateCreated: NOW - (2 * HOUR), type: "reject" }),
    ]],
    ["PHID-DREV-1002", [
      transaction({ authorPHID: ME, dateCreated: NOW - (30 * HOUR), type: "update" }),
    ]],
    ["PHID-DREV-1003", [
      transaction({ authorPHID: ME, dateCreated: NOW - (4 * HOUR), type: "update" }),
    ]],
    ["PHID-DREV-1004", [
      transaction({ authorPHID: ME, dateCreated: NOW - (36 * HOUR), type: "update" }),
      transaction({
        authorPHID: REVIEWER,
        content: "Please clarify the intent in the comment.",
        dateCreated: NOW - (8 * HOUR),
        type: "comment",
      }),
    ]],
    ["PHID-DREV-2001", [
      transaction({ authorPHID: ME, dateCreated: NOW - (20 * HOUR), type: "accept" }),
      transaction({ authorPHID: OTHER, dateCreated: NOW - (10 * HOUR), type: "update" }),
    ]],
    ["PHID-DREV-2002", [
      transaction({ authorPHID: OTHER, dateCreated: NOW - (55 * HOUR), type: "update" }),
    ]],
    ["PHID-DREV-2003", [
      transaction({ authorPHID: OTHER, dateCreated: NOW - (72 * HOUR), type: "update" }),
      transaction({
        authorPHID: REVIEWER,
        content: "Reviewed.",
        dateCreated: NOW - (2 * HOUR),
        type: "comment",
      }),
    ]],
    ["PHID-DREV-2004", [
      transaction({ authorPHID: ME, dateCreated: NOW - (30 * HOUR), type: "accept" }),
      transaction({ authorPHID: OTHER, dateCreated: NOW - (20 * HOUR), type: "update" }),
    ]],
  ]);
  let attachmentRevisionQueries = 0;
  const dashboard = await getDashboardData({
    appConfig: {
      bugzilla: { user: "me@example.com" },
      phabricator: { user: "me" },
    },
    getAssignedOpenBugs: async () => [
      { id: 3001, is_open: true, status: "ASSIGNED", summary: "No patch" },
      { id: 3002, is_open: true, status: "NEW", summary: "Has patch" },
    ],
    getNeedinfoOpenBugs: async () => [
      {
        component: "Account Hub",
        flags: [{
          creation_date: "2025-06-01T12:00:00Z",
          name: "needinfo",
          setter: "reviewer@example.com",
          status: "?",
        }],
        id: 4001,
        is_open: true,
        product: "Thunderbird",
        status: "NEW",
        summary: "Need more implementation detail",
      },
      {
        component: "Calendar",
        flags: [{
          creation_date: "2025-06-03T12:00:00Z",
          name: "needinfo",
          setter: "triage@example.com",
          status: "?",
        }],
        id: 4002,
        is_open: true,
        product: "Thunderbird",
        status: "ASSIGNED",
        summary: "Need reproduction details",
      },
    ],
    getBugsByIds: async (ids) => ids.map((id) => ({
      id: Number(id),
      keywords: [],
    })),
    getBugsWithAttachmentsByIds: async () => [
      {
        attachments: [{
          content_type: "text/x-phabricator-request",
          file_name: "D2002.diff",
        }],
        id: 3002,
      },
    ],
    now: NOW,
    phab: async ({ params, route }) => {
      if (route === "user.query" && params.usernames) {
        return { result: [{ phid: ME, realName: "Me", userName: "me" }] };
      }

      if (route === "user.query" && params.phids) {
        return {
          result: params.phids.map((phid) => ({
            phid,
            realName: phid === OTHER ? "Other Author" : phid,
            userName: phid === OTHER ? "other" : phid,
          })),
        };
      }

      if (route === "project.search") {
        return {
          result: {
            data: [{
              phid: GROUP,
              fields: { name: "Reviewers", slug: "reviewers" },
            }],
          },
        };
      }

      if (route === "differential.query" && params.authors) {
        return { result: mine };
      }

      if (route === "differential.query" && params.reviewers) {
        return {
          result: [directlyAssignedRevision, ...groupRevisions],
        };
      }

      if (route === "differential.query" && params.ids) {
        attachmentRevisionQueries++;
        const revisions = [
          ...mine,
          ...groupRevisions,
          directlyAssignedRevision,
        ].filter((revision) => (
          params.ids.includes(Number(revision.id))
        ));

        return { result: revisions };
      }

      if (route === "differential.getrevisioncomments") {
        return {
          result: Object.fromEntries(params.ids.map((id) => [
            id,
            transactions.get(`PHID-DREV-${id}`) || [],
          ])),
        };
      }

      throw new Error(`Unexpected request: ${route}`);
    },
  });

  assert.deepEqual(dashboard.ownNeedsRevision.map((patch) => patch.id), ["D1004", "D1001"]);
  assert.equal(dashboard.ownNeedsRevision[0].ageState, "fresh");
  assert.deepEqual(dashboard.ownNeedsReview.map((patch) => patch.id), ["D1002"]);
  assert.equal(dashboard.ownNeedsReview[0].ageState, "attention");
  assert.deepEqual(
    dashboard.directlyAssignedWaitingOnReview.map((patch) => patch.id),
    ["D2004"],
  );
  assert.equal(
    dashboard.directlyAssignedWaitingOnReview[0].authorName,
    "Other Author",
  );
  assert.deepEqual(
    dashboard.groupWaitingForFirstReview.map((patch) => patch.id),
    ["D2002"],
  );
  assert.equal(
    dashboard.groupWaitingForFirstReview[0].authorName,
    "Other Author",
  );
  assert.equal(dashboard.groupWaitingForFirstReview[0].ageState, "overdue");
  assert.deepEqual(dashboard.assignedBugs.map((bug) => bug.id), ["3001"]);
  assert.equal(dashboard.assignedBugs[0].hasPatch, false);
  assert.deepEqual(dashboard.inProgressBugs.map((bug) => bug.id), ["3002"]);
  assert.equal(dashboard.inProgressBugs[0].hasPatch, true);
  assert.deepEqual(dashboard.needinfoBugs.map((bug) => bug.id), ["4001", "4002"]);
  assert.equal(dashboard.needinfoBugs[0].requestedBy, "reviewer@example.com");
  assert.equal(
    attachmentRevisionQueries,
    0,
    "a revision already returned by the dashboard queues is not refetched",
  );
});

test("dashboard batches direct and review-group patches into one Phabricator revision query", async () => {
  const groups = [
    { phid: "PHID-PROJ-one", fields: { name: "One", slug: "one" } },
    { phid: "PHID-PROJ-two", fields: { name: "Two", slug: "two" } },
    { phid: "PHID-PROJ-three", fields: { name: "Three", slug: "three" } },
  ];
  const reviewerQueries = [];

  await getDashboardData({
    appConfig: {
      bugzilla: { user: "me@example.com" },
      phabricator: { user: "me" },
    },
    getAssignedOpenBugs: async () => [],
    getNeedinfoOpenBugs: async () => [],
    getBugsByIds: async () => [],
    getBugsWithAttachmentsByIds: async () => [],
    phab: async ({ params, route }) => {
      if (route === "user.query" && params.usernames) {
        return { result: [{ phid: ME, realName: "Me", userName: "me" }] };
      }

      if (route === "project.search") {
        return { result: { data: groups } };
      }

      if (route === "differential.query" && params.authors) {
        return { result: [] };
      }

      if (route === "differential.query" && params.reviewers) {
        reviewerQueries.push(params.reviewers);

        return { result: [] };
      }

      if (route === "differential.getrevisioncomments" || route === "user.query") {
        return { result: route === "user.query" ? [] : {} };
      }

      throw new Error(`Unexpected request: ${route}`);
    },
  });

  assert.deepEqual(reviewerQueries, [[
    ME,
    "PHID-PROJ-one",
    "PHID-PROJ-two",
    "PHID-PROJ-three",
  ]]);
});

test("dashboard reuses fresh persisted reviewer groups without identity lookups", async () => {
  const cached = {
    currentUser: { phid: ME, realName: "Me", userName: "me" },
    fresh: true,
    groups: [{
      name: "Reviewers",
      phid: GROUP,
      slug: "reviewers",
    }],
  };
  const requests = [];

  await getDashboardData({
    appConfig: {
      bugzilla: { user: "me@example.com" },
      phabricator: { user: "me" },
    },
    getAssignedOpenBugs: async () => [],
    getBugsByIds: async () => [],
    getBugsWithAttachmentsByIds: async () => [],
    getNeedinfoOpenBugs: async () => [],
    loadReviewerGroupCache: async () => cached,
    phab: async (request) => {
      requests.push(request);
      assert.notEqual(request.route, "project.search");
      assert.notEqual(request.route, "user.query");
      return { result: [] };
    },
    saveReviewerGroupCache: async () => {
      throw new Error("A fresh cache must not be rewritten.");
    },
  });

  assert.deepEqual(requests.map((request) => request.route), [
    "differential.query",
    "differential.query",
  ]);
});

test("interactive dashboard endpoint shares an in-flight result and caches it", async (t) => {
  let calls = 0;
  const serverInfo = await startInteractiveGraphServer({
    getDashboardData: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { user: { name: "Me" }, ownNeedsRevision: [] };
    },
    graphs: [],
    html: "<!doctype html><p>dashboard</p>",
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const endpoint = new URL("api/dashboard?token=secret", serverInfo.url);
  const [firstResponse, secondResponse] = await Promise.all([
    fetch(endpoint),
    fetch(endpoint),
  ]);

  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, true);
  assert.equal(calls, 1);
  assert.equal((await firstResponse.json()).user.name, "Me");

  const cachedResponse = await fetch(endpoint);

  assert.equal(cachedResponse.ok, true);
  assert.equal(calls, 1);

  const [forcedResponse, joinedForcedResponse] = await Promise.all([
    fetch(new URL("api/dashboard?token=secret&force=1", serverInfo.url)),
    fetch(new URL("api/dashboard?token=secret&force=1", serverInfo.url)),
  ]);

  assert.equal(forcedResponse.ok, true);
  assert.equal(joinedForcedResponse.ok, true);
  assert.equal(calls, 2);
});

test("interactive dashboard serves cached data during a Phabricator cooldown", async (t) => {
  let calls = 0;
  const serverInfo = await startInteractiveGraphServer({
    getDashboardData: async () => {
      calls++;

      if (calls === 1) {
        return { user: { name: "Me" }, ownNeedsRevision: [] };
      }

      const error = new Error("Phabricator differential.query failed (429).");

      error.statusCode = 429;
      error.retryAfterMs = 1000;
      throw error;
    },
    graphs: [],
    html: "<!doctype html><p>dashboard</p>",
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const endpoint = new URL("api/dashboard?token=secret", serverInfo.url);

  assert.equal((await fetch(endpoint)).ok, true);

  const limitedResponse = await fetch(
    new URL("api/dashboard?token=secret&force=1", serverInfo.url),
  );
  const limitedResult = await limitedResponse.json();

  assert.equal(limitedResponse.ok, true);
  assert.match(limitedResult.warning, /showing cached dashboard data/);
  assert.equal(calls, 2);

  const repeatedResponse = await fetch(
    new URL("api/dashboard?token=secret&force=1", serverInfo.url),
  );
  const repeatedResult = await repeatedResponse.json();

  assert.equal(repeatedResponse.ok, true);
  assert.match(repeatedResult.warning, /Try again in/);
  assert.equal(calls, 2);
});
