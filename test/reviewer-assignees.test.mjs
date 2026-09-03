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
