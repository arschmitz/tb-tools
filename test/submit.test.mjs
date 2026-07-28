import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubmitCommand, getSubmitLinksFromText } from "../commands/submit.mjs";

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
      return "Submitted https://phabricator.services.mozilla.com/D123456\n";
    },
    tryCommand: async (options, tryOptions) => {
      calls.push(["try", options, tryOptions]);
      return "https://treeherder.mozilla.org/jobs?repo=try&revision=abc";
    },
    postComment: async (comment) => {
      comments.push(comment);
    },
    getCommitMessage: async () => "Differential Revision: https://phabricator.services.mozilla.com/D123456\n",
    prompts: promptsFrom([false, true, true, true]),
  });

  const result = await submit({
    comment: true,
    flavor: "browser",
    headless: true,
    pattern: "mail/**/browser_*.js",
  }, [{ name: "selector" }]);

  assert.deepEqual(calls, [
    ["checkChanges", "Changes found please amend, commit, or stash your changes."],
    ["testChanged", {
      flavor: "browser",
      headless: true,
      pattern: "mail/**/browser_*.js",
    }],
    ["run", { cmd: "moz-phab", args: ["submit"], capture: true }],
    ["try", {
      comment: false,
      flavor: "browser",
      headless: true,
      pattern: "mail/**/browser_*.js",
    }, [{ name: "selector" }]],
  ]);
  assert.deepEqual(comments, [{
    message: "try: https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
    resolve: true,
    id: "123456",
  }]);
  assert.deepEqual(result, {
    phabRevision: "D123456",
    phabUrl: "https://phabricator.services.mozilla.com/D123456",
    tryUrl: "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
  });
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

test("getSubmitLinksFromText extracts phabricator and try links", () => {
  assert.deepEqual(
    getSubmitLinksFromText(`
      Review at https://phabricator.services.mozilla.com/D234567
      Try https://treeherder.mozilla.org/jobs?repo=try&revision=def
    `),
    {
      phabRevision: "D234567",
      phabUrl: "https://phabricator.services.mozilla.com/D234567",
      tryUrl: "https://treeherder.mozilla.org/jobs?repo=try&revision=def",
    }
  );
});
