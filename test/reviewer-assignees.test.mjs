import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  clearReviewGroupAssigneeCache,
  getReviewGroupAssignees,
} from "../commands/graph/reviewer-assignees.mjs";

afterEach(() => clearReviewGroupAssigneeCache());

test("review group assignees map Phabricator members to Bugzilla users in batches", async () => {
  const calls = [];
  const assignees = await getReviewGroupAssignees({
    reviewGroup: "#thunderbird-reviewers",
    phab: async (request) => {
      calls.push(request);

      if (request.route === "project.search") {
        return {
          result: {
            data: [{
              attachments: {
                members: {
                  members: [
                    { phid: "PHID-USER-a" },
                    { phid: "PHID-USER-b" },
                  ],
                },
              },
            }],
          },
        };
      }

      return {
        result: [
          { phid: "PHID-USER-a", userName: "alice", realName: "Alice Example" },
          { phid: "PHID-USER-b", userName: "bob", realName: "Bob Example" },
        ],
      };
    },
    getUsersByMatches: async (matches) => {
      assert.deepEqual(matches, ["Alice Example", "alice", "Bob Example", "bob"]);
      return [
        { name: "alice@mozilla.com", real_name: "Alice Example" },
        { name: "bob@mozilla.com", real_name: "Bob Example [:bob]" },
      ];
    },
  });

  assert.deepEqual(calls, [
    {
      route: "project.search",
      params: {
        attachments: { members: true },
        constraints: { slugs: ["thunderbird-reviewers"] },
      },
    },
    {
      route: "user.query",
      params: { phids: ["PHID-USER-a", "PHID-USER-b"] },
    },
  ]);
  assert.deepEqual(assignees, [
    { email: "alice@mozilla.com", name: "Alice Example" },
    { email: "bob@mozilla.com", name: "Bob Example [:bob]" },
  ]);
});

test("review group assignees return cached group membership", async () => {
  let projectSearches = 0;
  const options = {
    reviewGroup: "thunderbird-reviewers",
    phab: async ({ route }) => {
      if (route === "project.search") {
        projectSearches++;
        return { result: { data: [] } };
      }

      throw new Error("The empty group should not request users.");
    },
    getUsersByMatches: async () => {
      throw new Error("The empty group should not query Bugzilla.");
    },
  };

  await getReviewGroupAssignees(options);
  await getReviewGroupAssignees(options);

  assert.equal(projectSearches, 1);
});

test("review group assignees reuse persisted entries without remote lookups", async () => {
  const assignees = await getReviewGroupAssignees({
    reviewGroup: "#thunderbird-reviewers",
    loadReviewGroupAssigneeCache: async ({ reviewGroup }) => {
      assert.equal(reviewGroup, "thunderbird-reviewers");
      return {
        assignees: [{ email: "reviewer@example.com", name: "Review Er" }],
        fresh: true,
      };
    },
    phab: async () => {
      throw new Error("A fresh persisted group must not query Phabricator.");
    },
    getUsersByMatches: async () => {
      throw new Error("A fresh persisted group must not query Bugzilla.");
    },
  });

  assert.deepEqual(assignees, [
    { email: "reviewer@example.com", name: "Review Er" },
  ]);
});

test("review group assignees retain a stale persisted entry when refresh fails", async () => {
  const assignees = await getReviewGroupAssignees({
    reviewGroup: "thunderbird-reviewers",
    loadReviewGroupAssigneeCache: async () => ({
      assignees: [{ email: "reviewer@example.com", name: "Review Er" }],
      fresh: false,
    }),
    phab: async () => {
      throw new Error("Phabricator rate limited the refresh.");
    },
    getUsersByMatches: async () => {
      throw new Error("The group lookup should fail before Bugzilla.");
    },
  });

  assert.deepEqual(assignees, [
    { email: "reviewer@example.com", name: "Review Er" },
  ]);
});
