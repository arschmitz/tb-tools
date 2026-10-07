import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifyDashboardRevisions,
  getDashboardAgeState,
  getDashboardData,
  getDashboardRevisionPanes,
} from "../commands/graph/dashboard.mjs";
import { clearBugzillaBugCache, getBugsWithAttachmentsByIds, getBug } from "../lib/bugzilla.mjs";
import {
  loadDashboardTimelineCache,
  saveDashboardTimelineCache,
} from "../commands/graph/dashboard-timeline-cache.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { loadDashboardCache, saveDashboardCache } from "../commands/graph/dashboard-cache.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = 1_750_000_000_000;
const ME = "PHID-USER-me";
const OTHER = "PHID-USER-other";
const REVIEWER = "PHID-USER-reviewer";
const GROUP = "PHID-PROJ-reviewers";

test("review queues hide your acceptances but keep other reviews and missing history", () => {
  const revisions = [
    { id: "reviewed", statusName: "Needs Review", authorPHID: OTHER },
    { id: "accepted-by-you", statusName: "Needs Review", authorPHID: OTHER },
    { id: "requested-again", statusName: "Needs Review", authorPHID: OTHER },
    { id: "history-error", statusName: "Needs Review", authorPHID: OTHER },
    { id: "no-history", statusName: "Needs Review", authorPHID: OTHER },
    { id: "own", statusName: "Needs Review", authorPHID: ME },
    ...["Accepted", "Needs Revision", "Closed", "Abandoned"].map(statusName => ({
      id: statusName, statusName, authorPHID: OTHER,
    })),
  ];
  const sections = classifyDashboardRevisions({
    currentUserPhid: ME,
    directlyAssignedRevisions: revisions,
    groupRevisions: revisions,
    timelines: new Map([
      ["reviewed", { timeline: {
        latestReviewAt: NOW,
        latestYourCommentAt: NOW, latestYourRequestChangesAt: NOW,
      } }],
      ["accepted-by-you", { timeline: { latestYourAcceptanceAt: NOW - HOUR, latestPatchUpdateAt: NOW } }],
      ["requested-again", { timeline: { latestYourAcceptanceAt: NOW - HOUR, latestReviewRequestAt: NOW } }],
      ["history-error", { error: "History unavailable" }],
    ]),
    now: NOW,
  });
  for (const queue of [sections.directlyAssignedWaitingOnReview, sections.groupWaitingForFirstReview]) {
    assert.deepEqual(queue.map(revision => revision.id), ["reviewed", "requested-again", "history-error", "no-history"]);
  }
});

test("dashboard reads revision status only for listed active Phabricator attachments", async () => {
  const calls = [];
  await getDashboardRevisionPanes({
    currentUser: { userName: "me", phid: ME }, groups: [],
    assignedBugs: [1, 2, 3, 4].map(id => ({ id })),
    getDashboardRevisions: async () => ({ mine: [
      { id: "D124", title: "Bug 4 - Listed patch", authorName: "me" },
    ], reviewQueue: [] }),
    getBugsWithAttachmentsByIds: async () => [
      { id: 1, attachments: [] },
      { id: 2, attachments: [{ content_type: "text/plain", file_name: "D123.txt" }] },
      { id: 3, attachments: [{ content_type: "text/x-phabricator-request", file_name: "D123", is_obsolete: true }] },
      { id: 4, attachments: [{ content_type: "text/x-phabricator-request", file_name: "D124" }] },
    ],
    getBugzillaRevisions: async id => { calls.push(id); return []; },
  });
  assert.deepEqual(calls, [4]);
});

test("dashboard loads Bugzilla revision panes with bounded concurrency", async () => {
  const bugIds = Array.from({ length: 9 }, (_, index) => index + 1);
  let active = 0;
  let maxActive = 0;

  await getDashboardRevisionPanes({
    currentUser: { userName: "me", phid: ME }, groups: [],
    assignedBugs: bugIds.map((id) => ({ id })),
    getDashboardRevisions: async () => ({ mine: bugIds.map((id) => ({
      id: `D${id}`,
      title: `Bug ${id} - Listed patch`,
      authorName: "me",
    })), reviewQueue: [] }),
    getBugsWithAttachmentsByIds: async () => bugIds.map((id) => ({
      id,
      attachments: [{
        content_type: "text/x-phabricator-request",
        file_name: `D${id}`,
      }],
    })),
    getBugzillaRevisions: async (id) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return [{ id: `D${id}`, title: `Bug ${id} - Patch`, long_status: "Needs Review", reviews: [] }];
    },
  });

  assert.equal(maxActive, 8);
});

test("dashboard keeps unlisted active attachments without loading revision details", async () => {
  const requestedBugIds = [];
  const modified = Date.parse("2026-09-10T12:00:00Z");
  const dashboard = await getDashboardData({
    appConfig: { bugzilla: { user: "me@example.com" }, phabricator: { user: "me" } },
    getAssignedOpenBugs: async () => [
      { id: 1000, is_open: true, summary: "Listed patch" },
      { id: 2000, is_open: true, summary: "Other attached patch" },
    ],
    getBugsByIds: async () => [],
    getBugsWithAttachmentsByIds: async () => [
      { id: 1000, attachments: [{ content_type: "text/x-phabricator-request", file_name: "D1000", last_change_time: "2026-09-10T12:00:00Z" }] },
      { id: 2000, attachments: [{ content_type: "text/x-phabricator-request", file_name: "D2000", last_change_time: "2026-09-10T12:00:00Z" }] },
    ],
    getBugzillaRevisions: async (bugId) => {
      requestedBugIds.push(bugId);
      return [{ id: "D1000", long_status: "Needs Review", reviews: [] }];
    },
    getDashboardRevisions: async () => ({ mine: [
      { id: "D1000", title: "Bug 1000 - Listed patch", authorName: "me" },
    ], reviewQueue: [] }),
    getNeedinfoOpenBugs: async () => [],
    loadDashboardTimelineCache: async () => ({
      D1000: { dateModified: modified, timeline: { latestPatchUpdateAt: modified } },
    }),
    loadReviewerGroupCache: async () => ({
      currentUser: { phid: ME, userName: "me" }, fresh: true, groups: [],
    }),
    phab: async () => assert.fail("No Phabricator API request is needed"),
    saveDashboardTimelineCache: async () => {},
  });

  assert.deepEqual(requestedBugIds, [1000]);
  assert.deepEqual(dashboard.inProgressBugs.map((bug) => bug.id), ["2000", "1000"]);
  assert.deepEqual(dashboard.inProgressBugs[0].patches, [{
    id: "D2000",
    statusName: "Attached",
    title: "",
    url: "https://phabricator.services.mozilla.com/D2000",
  }]);
});

test("dashboard uses browser status hints without loading revision panes", async () => {
  const result = await getDashboardRevisionPanes({
    currentUser: { userName: "me", phid: ME }, groups: [], assignedBugs: [],
    getDashboardRevisions: async () => ({
      mine: [{
        id: "D1000",
        title: "Bug 12345 - Mine",
        authorName: "My Display Name",
        reviewers: [{ name: "me", type: "user" }],
        statusName: "Needs Review",
      }],
      reviewQueue: [{
        id: "D2000",
        title: "Bug 12345 - Other patch",
        authorName: "Uncached Author 93841",
        reviewers: [{ name: "me", type: "user" }],
        statusName: "Needs Revision",
      }],
    }),
    getBugsWithAttachmentsByIds: async () => [{ id: 12345, attachments: [1000, 2000].map((id) => ({ id, file_name: `phabricator-D${id}-url.txt`, content_type: "text/x-phabricator-request", is_obsolete: false })) }],
    getBugzillaRevisions: async () => assert.fail("Browser status hints must avoid per-bug revision requests"),
    phab: async () => assert.fail("Browser author names must not trigger Conduit requests"),
  });
  assert.equal(result.mine[0].authorPHID, ME);
  assert.equal(result.mine[0].statusName, "Needs Review");
  assert.equal(result.reviewQueue[0].authorName, "Uncached Author 93841");
  assert.equal(result.reviewQueue[0].reviewers[ME], "added");
});

test("dashboard starts the browser queue while Bugzilla assigned bugs load", async () => {
  let listCalls = 0;
  let releaseAssigned;
  const assignedBugs = new Promise((resolve) => { releaseAssigned = resolve; });
  const dashboard = getDashboardData({
    appConfig: { bugzilla: { user: "me@example.com" }, phabricator: { user: "me" } },
    getAssignedOpenBugs: async () => assignedBugs,
    getBugsByIds: async () => [],
    getBugsWithAttachmentsByIds: async () => [],
    getDashboardRevisions: async () => {
      listCalls++;
      return { mine: [], reviewQueue: [] };
    },
    getNeedinfoOpenBugs: async () => [],
    loadDashboardTimelineCache: async () => ({}),
    loadReviewerGroupCache: async () => ({
      currentUser: { phid: ME, userName: "me" }, fresh: true, groups: [],
    }),
    phab: async () => assert.fail("No Phabricator API request is needed"),
    saveDashboardTimelineCache: async () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 1);
  releaseAssigned([]);
  await dashboard;
});

test("partial dashboard persists to disk and repeated reloads and restarts respect fifteen minutes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-dashboard-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, "dashboard.json");
  const result = { errors: ["One bug could not load (401)"], user: { name: "Me" }, assignedBugs: [{ id: 12345 }] };
  let loads = 0;
  const cacheOptions = { cachePath, username: "test-user" };
  for (const ageMinutes of [0, 5, 14]) {
    if (ageMinutes) await saveDashboardCache({ ...cacheOptions, result, now: Date.now() - ageMinutes * 60_000 });
    const info = await startInteractiveGraphServer({
    tryMonitor: null,
      graphs: [], html: "<!doctype html><p>dashboard</p>", token: "secret",
      getDashboardData: async () => { loads++; return result; },
      loadDashboardCache: () => loadDashboardCache(cacheOptions),
      saveDashboardCache: ({ result }) => saveDashboardCache({ ...cacheOptions, result }),
    });
    try {
      for (let reload = 0; reload < 3; reload++) {
        const response = await fetch(new URL("api/dashboard?token=secret", info.url));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, ...result, handledReviews: [] });
      }
      assert.equal(loads, 1);
      assert.deepEqual((await loadDashboardCache(cacheOptions)).result, result);
    } finally {
      await new Promise((resolve) => info.server.close(resolve));
    }
  }
});

test("dashboard HTTP 401 failures leave other sections usable and report the missing data", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; clearBugzillaBugCache(); });
  for (const failedSection of ["attachments", "pane", "assigned", "needinfo", "accepted"]) {
    await t.test(failedSection, async () => {
      clearBugzillaBugCache();
      let calls = 0;
      global.fetch = async () => {
        calls++;
        return Response.json({ error: true, message: "You are not authorized to access bug 2026587." }, { status: 401 });
      };
      const denied = () => getBug(2026587);
      const result = await getDashboardData({
        appConfig: { bugzilla: { user: "me@example.com" }, phabricator: { user: "me" } },
        loadReviewerGroupCache: async () => ({ currentUser: { phid: ME, userName: "me" }, fresh: true, groups: [] }),
        loadDashboardTimelineCache: async () => ({}),
        saveDashboardTimelineCache: async () => {},
        getAssignedOpenBugs: failedSection === "assigned" ? denied : async () => [{ id: 12345, summary: "Accessible assigned bug", is_open: true }],
        getNeedinfoOpenBugs: failedSection === "needinfo" ? denied : async () => [{ id: 67890, summary: "Accessible needinfo bug" }],
        getDashboardRevisions: async () => ({ mine: [
          { id: "D2000", title: "Bug 2026587 - Restricted bug", authorName: "me" },
          { id: "D1000", title: "Bug 12345 - Accessible patch", authorName: "me" },
        ], reviewQueue: [] }),
        getBugsWithAttachmentsByIds: failedSection === "attachments" ? denied : async () => [12345, 2026587].map((id) => ({
          id, attachments: [{ id, file_name: `phabricator-D${id === 12345 ? 1000 : 2000}-url.txt`, content_type: "text/x-phabricator-request", is_obsolete: false }],
        })),
        getBugzillaRevisions: async (id) => {
          if (failedSection === "pane" && id === 2026587) return denied();
          return [{ id: `D${id === 12345 ? 1000 : 2000}`, title: `Bug ${id} - Patch`, long_status: "Needs Review", reviews: [] }];
        },
        getBugsByIds: failedSection === "accepted" ? denied : async () => [],
        phab: async ({ route }) => {
          assert.equal(route, "differential.getrevisioncomments");
          return { result: {} };
        },
      });
      assert.equal(calls, 1, "The 401 must not cause retries");
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /401.*2026587/);
      assert.equal(result.user.username, "me");
      if (failedSection !== "needinfo") assert.equal(result.needinfoBugs.length, 1);
      if (failedSection !== "assigned") assert.equal(result.assignedBugs.length + result.inProgressBugs.length, 1);
      if (failedSection === "pane") assert.ok(result.ownNeedsReview.some((patch) => patch.id === "D1000"));
    });
  }
});

test("dashboard keeps accessible patches after an attachment batch returns HTTP 401", async (t) => {
  const originalFetch = global.fetch;
  clearBugzillaBugCache();
  t.after(() => { global.fetch = originalFetch; clearBugzillaBugCache(); });
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get("permissive"), "1");
    if (calls === 1) {
      assert.deepEqual(params.getAll("ids"), ["12345", "2026587"]);
      return Response.json({ error: true, message: "You are not authorized to access bug 2026587." }, { status: 401 });
    }
    assert.deepEqual(params.getAll("ids"), ["12345"]);
    return Response.json({
      bugs: [{ id: 12345, attachments: [{ id: 1, file_name: "phabricator-D1000-url.txt", content_type: "text/x-phabricator-request", is_obsolete: false }] }],
    });
  };
  const options = {
    currentUser: { userName: "me", phid: ME }, groups: [], assignedBugs: [],
    getDashboardRevisions: async () => ({ mine: [
      { id: "D1000", title: "Bug 12345 - Accessible patch", authorName: "me" },
      { id: "D2000", title: "Bug 2026587 - Restricted bug", authorName: "me" },
    ], reviewQueue: [] }),
    getBugsWithAttachmentsByIds,
    getBugzillaRevisions: async (id) => {
      assert.equal(id, 12345);
      return [{ id: "D1000", title: "Bug 12345 - Accessible patch", long_status: "Needs Review", reviews: [] }];
    },
    phab: async () => assert.fail("No Phabricator API request is needed"),
  };
  const result = await getDashboardRevisionPanes(options);
  assert.equal(result.mine.length, 1);
  assert.equal(result.attachmentsByBugId.has("2026587"), false);
  await getDashboardRevisionPanes(options);
  assert.equal(calls, 2);
});

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

test("dashboard revision timelines persist by reviewer", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-dashboard-timeline-"));
  const cachePath = path.join(directory, "timelines.json");

  t.after(() => rm(directory, { force: true, recursive: true }));
  await saveDashboardTimelineCache({
    cachePath,
    currentUserPhid: ME,
    entries: {
      D1001: {
        dateModified: NOW,
        timeline: {
          currentReviewEventCount: 1,
          latestPatchUpdateAt: NOW - HOUR,
          latestReviewAt: NOW,
          latestReviewRequestAt: NOW - HOUR,
        },
      },
    },
    now: NOW,
  });

  assert.deepEqual(
    await loadDashboardTimelineCache({ cachePath, currentUserPhid: ME }),
    {
      D1001: {
        checkedAt: NOW,
        dateModified: NOW,
        timeline: {
          currentReviewEventCount: 1,
          latestCurrentReviewAt: 0,
          latestOtherCommentAt: 0,
          latestPatchUpdateAt: NOW - HOUR,
          latestReviewAt: NOW,
          latestReviewRequestAt: NOW - HOUR,
          latestYourAcceptanceAt: 0,
          latestYourCommentAt: 0,
          latestYourRequestChangesAt: 0,
        },
      },
    },
  );
});

test("dashboard refreshes review timelines only when a revision changes", async () => {
  const revision = makeRevision({
    bugId: "1001",
    id: 1001,
    statusName: "Needs Review",
  });
  const cachedTimelines = {
    D1001: {
      dateModified: Number(revision.dateModified),
      timeline: {
        currentReviewEventCount: 0,
        latestCurrentReviewAt: 0,
        latestOtherCommentAt: 0,
        latestPatchUpdateAt: Number(revision.dateModified),
        latestReviewAt: 0,
        latestYourAcceptanceAt: 0,
        latestYourCommentAt: 0,
        latestYourRequestChangesAt: 0,
      },
    },
  };
  let timelineQueries = 0;
  let savedEntries;

  async function loadDashboard({ dateModified }) {
    revision.dateModified = String(dateModified);

    return getDashboardData({
      appConfig: {
        bugzilla: { user: "me@example.com" },
        phabricator: { user: "me" },
      },
      getAssignedOpenBugs: async () => [],
      getBugsByIds: async () => [],
      getBugsWithAttachmentsByIds: async () => [],
      getNeedinfoOpenBugs: async () => [],
      loadDashboardTimelineCache: async () => cachedTimelines,
      loadReviewerGroupCache: async () => ({
        currentUser: { phid: ME, realName: "Me", userName: "me" },
        fresh: true,
        groups: [],
      }),
      now: NOW,
      phab: async ({ params, route }) => {
        if (route === "differential.query" && params.authors) {
          return { result: [revision] };
        }

        if (route === "differential.query" && params.reviewers) {
          return { result: [] };
        }

        if (route === "differential.getrevisioncomments") {
          timelineQueries++;
          return { result: { 1001: [] } };
        }

        throw new Error(`Unexpected request: ${route}`);
      },
      saveDashboardTimelineCache: async ({ entries }) => {
        savedEntries = entries;
      },
      saveReviewerGroupCache: async () => {
        throw new Error("The fresh reviewer cache must not be rewritten.");
      },
    });
  }

  await loadDashboard({ dateModified: NOW - HOUR });
  assert.equal(timelineQueries, 0);
  assert.equal(savedEntries.D1001.dateModified, NOW - HOUR);

  await loadDashboard({ dateModified: NOW });
  assert.equal(timelineQueries, 1);
  assert.equal(savedEntries.D1001.dateModified, NOW);
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
  const alreadyApprovedRevision = makeRevision({
    authorPHID: OTHER,
    bugId: "2005",
    dateModified: NOW - (20 * HOUR),
    id: 2005,
    statusName: "Needs Review",
  });
  alreadyApprovedRevision.reviewers = { [ME]: ME };
  const alreadyCommentedRevision = makeRevision({
    authorPHID: OTHER,
    bugId: "2006",
    dateModified: NOW - (30 * HOUR),
    id: 2006,
    statusName: "Needs Review",
  });
  alreadyCommentedRevision.reviewers = { [ME]: ME };
  const requestedChangesRevision = makeRevision({
    authorPHID: OTHER,
    bugId: "2007",
    dateModified: NOW - (40 * HOUR),
    id: 2007,
    statusName: "Needs Review",
  });
  requestedChangesRevision.reviewers = { [ME]: ME };
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
      transaction({ authorPHID: OTHER, dateCreated: NOW - (9 * HOUR), type: "request" }),
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
      transaction({ authorPHID: OTHER, dateCreated: NOW - (20 * HOUR), type: "update" }),
    ]],
    ["PHID-DREV-2005", [
      transaction({ authorPHID: ME, dateCreated: NOW - (30 * HOUR), type: "accept" }),
      transaction({ authorPHID: OTHER, dateCreated: NOW - (20 * HOUR), type: "update" }),
    ]],
    ["PHID-DREV-2006", [
      transaction({ authorPHID: OTHER, content: "Please consider this edge case.", dateCreated: NOW - (20 * HOUR), type: "comment" }),
      transaction({ authorPHID: ME, content: "Confirmed; that case is covered.", dateCreated: NOW - (10 * HOUR), type: "comment" }),
    ]],
    ["PHID-DREV-2007", [
      transaction({ authorPHID: OTHER, dateCreated: NOW - (40 * HOUR), type: "update" }),
      transaction({ authorPHID: ME, dateCreated: NOW - (30 * HOUR), type: "reject" }),
      transaction({ authorPHID: REVIEWER, content: "I agree with the requested changes.", dateCreated: NOW - (10 * HOUR), type: "comment" }),
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
          result: [
            directlyAssignedRevision,
            alreadyApprovedRevision,
            alreadyCommentedRevision,
            requestedChangesRevision,
            ...groupRevisions,
          ],
        };
      }

      if (route === "differential.query" && params.ids) {
        attachmentRevisionQueries++;
        const revisions = [
          ...mine,
          ...groupRevisions,
          directlyAssignedRevision,
          alreadyApprovedRevision,
          alreadyCommentedRevision,
          requestedChangesRevision,
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
    ["D2007", "D2006", "D2004"],
  );
  assert.equal(
    dashboard.directlyAssignedWaitingOnReview[0].authorName,
    "Other Author",
  );
  assert.deepEqual(
    dashboard.groupWaitingForFirstReview.map((patch) => patch.id),
    ["D2003", "D2002", "D2001"],
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
    tryMonitor: null,
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
    tryMonitor: null,
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

test("interactive dashboard restores a durable cache after restart and uses it on 429", async (t) => {
  const cachedResult = { ownNeedsRevision: [], user: { name: "Cached Me" } };
  let persisted = null;
  let liveCalls = 0;

  async function startServer({ loadDashboardCache, getDashboardData }) {
    const serverInfo = await startInteractiveGraphServer({
    tryMonitor: null,
      getDashboardData,
      graphs: [],
      html: "<!doctype html><p>dashboard</p>",
      loadDashboardCache,
      saveDashboardCache: async ({ result }) => {
        persisted = { checkedAt: Date.now(), result };
      },
      token: "secret",
    });

    t.after(() => {
      if (serverInfo.server.listening) {
        serverInfo.server.close();
      }
    });

    return serverInfo;
  }

  const firstServer = await startServer({
    getDashboardData: async () => {
      liveCalls++;
      return cachedResult;
    },
    loadDashboardCache: async () => null,
  });
  const firstResponse = await fetch(new URL("api/dashboard?token=secret", firstServer.url));

  assert.equal(firstResponse.ok, true);
  assert.equal(liveCalls, 1);
  assert.deepEqual(persisted?.result, cachedResult);
  firstServer.server.close();

  const restartedServer = await startServer({
    getDashboardData: async () => {
      liveCalls++;
      throw new Error("A fresh persisted cache must not query Phabricator.");
    },
    loadDashboardCache: async () => persisted,
  });
  const restartedResponse = await fetch(new URL("api/dashboard?token=secret", restartedServer.url));

  assert.equal(restartedResponse.ok, true);
  assert.deepEqual(await restartedResponse.json(), { ok: true, ...cachedResult, handledReviews: [] });
  assert.equal(liveCalls, 1);
  restartedServer.server.close();

  persisted.checkedAt = Date.now() - (16 * 60 * 1000);
  const limitedServer = await startServer({
    getDashboardData: async () => {
      liveCalls++;
      const error = new Error("Phabricator differential.query failed (429).");

      error.statusCode = 429;
      error.retryAfterMs = 1000;
      throw error;
    },
    loadDashboardCache: async () => persisted,
  });
  const limitedResponse = await fetch(new URL("api/dashboard?token=secret", limitedServer.url));
  const limitedResult = await limitedResponse.json();

  assert.equal(limitedResponse.ok, true);
  assert.equal(liveCalls, 2);
  assert.equal(limitedResult.user.name, "Cached Me");
  assert.match(limitedResult.warning, /showing cached dashboard data/);
});


test("approved own patches include check-in requests and exclude merged patches", () => {
  const result = classifyDashboardRevisions({
    currentUserPhid: ME,
    mine: [
      { id: "D1", statusName: "Accepted", bugId: "1", dateModified: NOW - HOUR },
      { id: "D2", statusName: "Accepted", bugId: "2", dateModified: NOW - 2 * HOUR },
      { id: "D3", statusName: "Closed", bugId: "3", dateModified: NOW },
      { id: "D4", statusName: "Needs Review", dateModified: NOW },
      { id: "D5", statusName: "Needs Revision", dateModified: NOW },
    ],
    bugsById: new Map([["2", { keywords: ["checkin-needed-tb"] }]]),
    now: NOW,
  });
  assert.deepEqual(result.ownApproved.map(patch => patch.id), ["D2", "D1"]);
  assert.ok(result.ownApproved.every(patch => patch.statusName === "Accepted"));
  assert.deepEqual(result.ownNeedsReview.map(patch => patch.id), ["D4"]);
  assert.deepEqual(result.ownNeedsRevision.map(patch => patch.id), ["D5"]);
});
