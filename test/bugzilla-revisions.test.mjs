import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getBugzillaRevisions } from "../lib/bugzilla-revisions.mjs";
import phab, { clearPhabricatorRequestState, flushPhabricatorCache, clearPhabricatorCache, findCachedReviewer } from "../lib/phab.mjs";
import { getGraphCommitIntegrationStatus } from "../commands/graph/actions.mjs";
import { getDashboardData, getDashboardRevisionPanes } from "../commands/graph/dashboard.mjs";

test("Bugzilla pane persists across restarts and resolves cached reviewers without lookups", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-bz-revisions-"));
  const previousPath = process.env.TB_TOOLS_PHAB_CACHE_PATH;
  const originalFetch = globalThis.fetch;
  process.env.TB_TOOLS_PHAB_CACHE_PATH = path.join(directory, "cache.json");
  clearPhabricatorRequestState();
  t.after(async () => {
    await flushPhabricatorCache();
    globalThis.fetch = originalFetch;
    if (previousPath === undefined) delete process.env.TB_TOOLS_PHAB_CACHE_PATH;
    else process.env.TB_TOOLS_PHAB_CACHE_PATH = previousPath;
    clearPhabricatorRequestState();
    await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ result: [{ phid: "PHID-USER-one", userName: "one" }] }));
  await phab({ route: "user.query", params: { phids: ["PHID-USER-one"] } });
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { data: [{ phid: "PHID-PROJ-team", fields: { name: "Team", slug: "team" } }] } }));
  await phab({ route: "project.search", params: { constraints: { members: ["PHID-USER-one"] } } });
  await flushPhabricatorCache();
  clearPhabricatorRequestState();
  const realNow = Date.now;
  const clock = t.mock.method(Date, "now", () => realNow() + 10 * 365 * 24 * 60 * 60 * 1000);
  globalThis.fetch = async () => assert.fail("Persistent identities must not expire");
  assert.deepEqual(await findCachedReviewer("Team"), { phid: "PHID-PROJ-team", type: "group" });
  await phab({ route: "project.search", params: { constraints: { members: ["PHID-USER-one"] } } });
  clock.mock.restore();
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://bugzilla.mozilla.org/rest/phabbugz/bug_revisions/123");
    assert.ok(options.headers);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ revisions: [{ id: "D42", title: "Bug 123 - Test", status: "needs-review", long_status: "Needs Review", reviews: [
      { user: "one", status: "accepted" }, { user: "Team", status: "blocking" }, { user: "unknown", status: "added" },
    ] }] }));
  };
  const [first, second] = await Promise.all([getBugzillaRevisions(123), getBugzillaRevisions(123)]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(first[0].reviews.map((review) => review.identity), [
    { phid: "PHID-USER-one", type: "user" }, { phid: "PHID-PROJ-team", type: "group" }, null,
  ]);
  clearPhabricatorRequestState();
  assert.deepEqual(await getBugzillaRevisions(123), first);
  assert.equal(calls, 1);
  await getBugzillaRevisions(123, { bypassCache: true });
  assert.equal(calls, 2);
  await clearPhabricatorCache({ category: "identities" });
  assert.equal(await findCachedReviewer("one"), null);
  assert.equal(await findCachedReviewer("Team"), null);
});

test("selected commit uses the exact Bugzilla revision and never falls back to Conduit on error", async () => {
  let calls = 0;
  const options = {
    graph: { label: "comm", path: "/test/repo", commits: [{ hash: "abc", subject: "Bug 123456 - Test", refs: ["phab-D4242"] }] },
    hash: "abc",
    runCommand: async () => "",
    getBug: async () => ({ bugs: [] }),
    getNotionStoriesByBugId: async () => null,
    phab: async () => { calls++; throw new Error("Unexpected Conduit call"); },
  };
  const result = await getGraphCommitIntegrationStatus({ ...options, getBugzillaRevisions: async (bugId) => {
    assert.equal(bugId, "123456");
    return [{ id: "D99", title: "Wrong revision" }, { id: "D4242", title: "Correct revision", status: "accepted", long_status: "Accepted", reviews: [] }];
  } });
  assert.equal(result.phabricator.revision, "D4242");
  assert.equal(result.phabricator.title, "Correct revision");
  assert.equal(result.phabricator.statusName, "Accepted");
  const failed = await getGraphCommitIntegrationStatus({ ...options, getBugzillaRevisions: async () => { throw new Error("Unavailable"); } });
  assert.equal(failed.phabricator.error, "Unavailable");
  assert.equal(calls, 0);
});

test("dashboard queries only active Phabricator attachments and shares each bug result", async () => {
  const calls = [];
  const result = await getDashboardRevisionPanes({
    currentUser: { userName: "me", phid: "PHID-USER-me" }, groups: [],
    assignedBugs: [{ id: 1000 }, { id: 2000 }, { id: 3000 }, { id: 4000 }],
    getDashboardRevisions: async () => ({ mine: [
      { id: "D1000", title: "Bug 1000 - One", authorName: "me" },
      { id: "D1001", title: "Bug 1000 - Two", authorName: "me" },
    ], reviewQueue: [] }),
    getBugsWithAttachmentsByIds: async () => [
      { id: 1000, attachments: [1000, 1001].map((id) => ({ content_type: "text/x-phabricator-request", file_name: `phabricator-D${id}-url.txt`, last_change_time: "2026-09-10T12:00:00Z" })) },
      { id: 2000, attachments: [{ content_type: "text/plain", file_name: "D2222.txt" }] },
      { id: 3000, attachments: [] },
      { id: 4000, attachments: [{ content_type: "text/x-phabricator-request", file_name: "D4444", is_obsolete: true }] },
    ],
    getBugzillaRevisions: async (id) => {
      calls.push(id);
      return [1000, 1001].map((id) => ({ id: `D${id}`, title: `Bug 1000 - ${id}`, status: "needs-review", long_status: "Needs Review", reviews: [] }));
    },
    phab: async () => assert.fail("Cached dashboard identities need no Conduit call"),
  });
  assert.deepEqual(calls, [1000]);
  assert.deepEqual(result.mine.map((revision) => revision.id), ["D1000", "D1001"]);
  assert.equal(result.mine[0].dateModified, Date.parse("2026-09-10T12:00:00Z"));
});

test("dashboard completes from browser, Bugzilla, and cached history without revision API queries", async () => {
  const modified = Date.parse("2026-09-10T12:00:00Z");
  let paneCalls = 0;
  const dashboard = await getDashboardData({
    appConfig: { phabricator: { user: "me" }, bugzilla: { user: "me@example.com" } },
    loadReviewerGroupCache: async () => ({ fresh: true, currentUser: { userName: "me", phid: "PHID-USER-me" }, groups: [{ name: "team", slug: "team", phid: "PHID-PROJ-team" }] }),
    getAssignedOpenBugs: async () => [{ id: 1000, summary: "One", is_open: true }],
    getNeedinfoOpenBugs: async () => [],
    getBugsByIds: async () => [],
    getDashboardRevisions: async () => ({ mine: [{ id: "D1000", title: "Bug 1000 - One", authorName: "me" }], reviewQueue: [] }),
    getBugsWithAttachmentsByIds: async () => [{ id: 1000, attachments: [{ content_type: "text/x-phabricator-request", file_name: "D1000", last_change_time: "2026-09-10T12:00:00Z" }] }],
    getBugzillaRevisions: async () => {
      paneCalls++;
      return [{ id: "D1000", title: "Bug 1000 - One", status: "needs-review", long_status: "Needs Review", reviews: [{ user: "team", status: "added" }] }];
    },
    loadDashboardTimelineCache: async () => ({ D1000: { dateModified: modified, timeline: { latestPatchUpdateAt: modified } } }),
    saveDashboardTimelineCache: async () => {},
    phab: async (request) => assert.fail(`Unexpected Conduit request: ${request.route}`),
  });
  assert.equal(paneCalls, 1);
  assert.equal(dashboard.ownNeedsReview[0].id, "D1000");
  assert.equal(dashboard.ownNeedsReview[0].reviewers["PHID-PROJ-team"], "added");
  assert.equal(dashboard.inProgressBugs[0].id, "1000");
});
