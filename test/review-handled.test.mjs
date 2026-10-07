import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReviewHandledStore, applyHandledReviews } from "../commands/graph/review-handled.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

const patch = { id: "D123", title: "A patch", dateModified: 1 };
const dashboard = { directlyAssignedWaitingOnReview: [patch], groupWaitingForFirstReview: [patch], ownNeedsReview: [patch] };

test("handled reviews persist per user, survive new versions, and undo restores both queues", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "handled-reviews-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { filePath: path.join(directory, "handled.json"), username: "reviewer" };
  const store = createReviewHandledStore(options);
  await Promise.all([store.set("D123", true, patch), store.set("D456", true)]);
  const restored = createReviewHandledStore(options);
  assert.equal((await restored.list()).length, 2);
  assert.deepEqual(await createReviewHandledStore({ ...options, username: "other" }).list(), []);
  const nextVersion = { ...dashboard, directlyAssignedWaitingOnReview: [{ ...patch, dateModified: 2 }], groupWaitingForFirstReview: [{ ...patch, dateModified: 2 }] };
  const filtered = applyHandledReviews(nextVersion, await restored.list());
  assert.deepEqual(filtered.directlyAssignedWaitingOnReview, []);
  assert.deepEqual(filtered.groupWaitingForFirstReview, []);
  assert.deepEqual(filtered.ownNeedsReview, [patch]);
  assert.equal(filtered.handledReviews[0].handled, true);
  assert.equal(filtered.handledReviews[0].dateModified, 2);
  await restored.set("D123", false);
  assert.deepEqual(applyHandledReviews(dashboard, await restored.list()).directlyAssignedWaitingOnReview, [patch]);
  assert.deepEqual(applyHandledReviews(dashboard, await restored.list()).groupWaitingForFirstReview, [patch]);
});

test("handled API checks tokens and input and filters cached and refreshed dashboard data", async t => {
  const server = await startInteractiveGraphServer({ html: "", graphs: [], token: "secret", tryMonitor: null,
    getDashboardData: async () => dashboard, appConfig: { phabricator: { user: "reviewer" } } });
  t.after(() => { server.server.closeAllConnections(); return new Promise(resolve => server.server.close(resolve)); });
  const post = body => fetch(new URL("/api/dashboard/review-handled", server.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await post({ token: "wrong", revision: "D123", handled: true })).status, 403);
  assert.equal((await post({ token: "secret", revision: "bad", handled: true })).status, 400);
  assert.equal((await post({ token: "secret", revision: "D123", handled: "yes" })).status, 400);
  assert.equal((await fetch(new URL("/api/dashboard/review-handled?token=wrong", server.url))).status, 403);
  assert.equal((await post({ token: "secret", revision: "D123", handled: true, title: patch.title })).status, 200);
  for (const suffix of ["", "&force=1"]) {
    const result = await (await fetch(new URL(`/api/dashboard?token=secret${suffix}`, server.url))).json();
    assert.deepEqual(result.directlyAssignedWaitingOnReview, []);
    assert.deepEqual(result.groupWaitingForFirstReview, []);
    assert.equal(result.handledReviews[0].title, patch.title);
  }
  await post({ token: "secret", revision: "D123", handled: false });
  const result = await (await fetch(new URL("/api/dashboard?token=secret", server.url))).json();
  assert.deepEqual(result.directlyAssignedWaitingOnReview, [patch]);
});
