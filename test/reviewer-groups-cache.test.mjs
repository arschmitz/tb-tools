import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadReviewGroupAssigneeCache,
  loadReviewerGroupCache,
  REVIEWER_GROUP_CACHE_TTL_MS,
  saveReviewGroupAssigneeCache,
  saveReviewerGroupCache,
} from "../commands/graph/reviewer-groups-cache.mjs";

test("reviewer group cache persists a fresh identity and membership list", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-reviewer-groups-"));
  const cachePath = path.join(directory, "reviewer-groups.json");
  const now = 1_750_000_000_000;

  t.after(() => rm(directory, { force: true, recursive: true }));

  await saveReviewerGroupCache({
    cachePath,
    currentUser: {
      phid: "PHID-USER-me",
      realName: "Me Example",
      userName: "me",
    },
    groups: [{
      name: "Thunderbird Reviewers",
      phid: "PHID-PROJ-thunderbird-reviewers",
      slug: "thunderbird-reviewers",
    }],
    now,
    username: "Me",
  });

  const cached = await loadReviewerGroupCache({
    cachePath,
    now: now + REVIEWER_GROUP_CACHE_TTL_MS - 1,
    username: "me",
  });

  assert.equal(cached.fresh, true);
  assert.equal(cached.currentUser.phid, "PHID-USER-me");
  assert.deepEqual(cached.groups, [{
    name: "Thunderbird Reviewers",
    phid: "PHID-PROJ-thunderbird-reviewers",
    slug: "thunderbird-reviewers",
  }]);
});

test("reviewer group cache persists resolved board assignees", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-reviewer-groups-"));
  const cachePath = path.join(directory, "reviewer-groups.json");
  const now = 1_750_000_000_000;

  t.after(() => rm(directory, { force: true, recursive: true }));

  await saveReviewGroupAssigneeCache({
    assignees: [{ email: "reviewer@example.com", name: "Review Er" }],
    cachePath,
    now,
    reviewGroup: "#thunderbird-reviewers",
  });

  const cached = await loadReviewGroupAssigneeCache({
    cachePath,
    now: now + 10 * 365 * 24 * 60 * 60 * 1000,
    reviewGroup: "thunderbird-reviewers",
  });

  assert.equal(cached.fresh, true);
  assert.deepEqual(cached.assignees, [
    { email: "reviewer@example.com", name: "Review Er" },
  ]);
});
