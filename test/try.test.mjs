import assert from "node:assert/strict";
import { test } from "node:test";
import { createTryCommand, getMachTryArgs, getTryUrl } from "../commands/try.mjs";

test("getMachTryArgs builds fuzzy mach try arguments", () => {
  assert.deepEqual(getMachTryArgs({
    query: "browser_accountHub",
    artifact: false,
  }), [
    "try",
    "fuzzy",
    "--query",
    "browser_accountHub",
    "--no-artifact",
  ]);
});

test("getMachTryArgs builds auto mach try arguments with defaults", () => {
  assert.deepEqual(getMachTryArgs({
    "tasks-regex": "mochitest",
    preset: "comm-central",
  }), [
    "try",
    "auto",
    "--tasks-regex",
    "mochitest",
    "--preset",
    "comm-central",
    "--artifact",
  ]);
});

test("getTryUrl returns the last URL from mach try output", () => {
  assert.equal(
    getTryUrl("first https://example.invalid/one\nsecond https://treeherder.mozilla.org/jobs?repo=try&revision=abc"),
    "https://treeherder.mozilla.org/jobs?repo=try&revision=abc"
  );
});

test("try command runs mach try and posts an optional comment", async () => {
  const runCalls = [];
  const comments = [];
  const tryCommand = createTryCommand({
    runCommand: async (command) => {
      runCalls.push(command);
      return "Created try push: https://treeherder.mozilla.org/jobs?repo=try&revision=abc";
    },
    postComment: async (comment) => {
      comments.push(comment);
    },
  });

  const tryUrl = await tryCommand({ comment: true });

  assert.equal(tryUrl, "https://treeherder.mozilla.org/jobs?repo=try&revision=abc");
  assert.deepEqual(runCalls, [{
    cmd: "../mach",
    args: ["try", "auto", "--artifact"],
    capture: true,
  }]);
  assert.deepEqual(comments, [{
    message: "try: https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
  }]);
});
