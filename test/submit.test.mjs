import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubmitCommand } from "../commands/submit.mjs";

function promptsFrom(answers) {
  return {
    keyInYNStrict() {
      return answers.shift();
    },
  };
}

test("submit command posts a mach try URL with mocked prompts and runners", async () => {
  const calls = [];
  const comments = [];
  const submit = createSubmitCommand({
    checkChanges: async (message) => {
      calls.push(["checkChanges", message]);
    },
    lint: async () => {
      calls.push(["lint"]);
    },
    testChanged: async (options) => {
      calls.push(["testChanged", options]);
    },
    runCommand: async (command) => {
      calls.push(["run", command]);
    },
    tryCommand: async (options, tryOptions) => {
      calls.push(["try", options, tryOptions]);
      return "https://treeherder.mozilla.org/jobs?repo=try&revision=abc";
    },
    postComment: async (comment) => {
      comments.push(comment);
    },
    prompts: promptsFrom([false, true, true, true]),
  });

  await submit({
    comment: true,
    flavor: "browser",
    pattern: "mail/**/browser_*.js",
  }, [{ name: "selector" }]);

  assert.deepEqual(calls, [
    ["checkChanges", "Changes found please amend, commit, or stash your changes."],
    ["testChanged", {
      flavor: "browser",
      pattern: "mail/**/browser_*.js",
    }],
    ["run", { cmd: "moz-phab", args: ["submit"] }],
    ["try", {
      comment: false,
      flavor: "browser",
      pattern: "mail/**/browser_*.js",
    }, [{ name: "selector" }]],
  ]);
  assert.deepEqual(comments, [{
    message: "try: https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
    resolve: true,
  }]);
});

test("submit command throws a lint failure when the user declines to continue", async () => {
  const lintError = new Error("lint failed");
  const submit = createSubmitCommand({
    checkChanges: async () => {},
    lint: async () => {
      throw lintError;
    },
    runCommand: async () => {
      assert.fail("moz-phab submit should not run after declined lint failure");
    },
    prompts: promptsFrom([true, false]),
  });

  await assert.rejects(submit({}, []), lintError);
});
