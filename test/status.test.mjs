import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatusCommand } from "../commands/status.mjs";
import {
  formatWorkspaceStatus,
  getBugIdFromText,
  getPhabRevisionFromText,
  getTryUrlFromText,
} from "../lib/workflow.mjs";

test("workflow helpers detect Bugzilla, Phabricator, and try references", () => {
  assert.equal(getBugIdFromText("Bug-1234567"), "1234567");
  assert.equal(getBugIdFromText("Bug 1234567 - fix thing"), "1234567");
  assert.equal(getPhabRevisionFromText("Differential Revision: https://phabricator.services.mozilla.com/D123456"), "D123456");
  assert.equal(getPhabRevisionFromText("D123456"), "D123456");
  assert.equal(
    getTryUrlFromText("try https://treeherder.mozilla.org/jobs?repo=try&revision=abc"),
    "https://treeherder.mozilla.org/jobs?repo=try&revision=abc"
  );
});

test("formatWorkspaceStatus includes pending commits and changed files", () => {
  const output = formatWorkspaceStatus({
    branch: "Bug-1234567",
    base: "origin/main",
    ahead: "2",
    changedFiles: [{ status: "M", file: "mail/base/content/foo.js" }],
    pendingCommits: ["abc1234 Bug 1234567 - Fix foo. r=bar"],
    bugId: "1234567",
    bugUrl: "https://bugzilla.mozilla.org/show_bug.cgi?id=1234567",
    phabRevision: "D123456",
    phabUrl: "https://phabricator.services.mozilla.com/D123456",
    tryUrl: "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
  });

  assert.match(output, /Branch: Bug-1234567/);
  assert.match(output, /Commits ahead: 2/);
  assert.match(output, /Pending commits:/);
  assert.match(output, /M mail\/base\/content\/foo\.js/);
});

test("status command writes formatted workspace context", async () => {
  const writes = [];
  const status = createStatusCommand({
    getContext: async () => ({
      branch: "main",
      base: "origin/main",
      ahead: "0",
      changedFiles: [],
      pendingCommits: [],
    }),
    write: (message) => writes.push(message),
  });

  await status();

  assert.equal(writes.length, 1);
  assert.match(writes[0], /Working tree: clean/);
});
