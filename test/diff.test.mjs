import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiffCommand, getPrettyDiffCommand, parseDiffArgs } from "../commands/diff.mjs";

test("getPrettyDiffCommand uses the installed local binary when present", () => {
  const command = getPrettyDiffCommand({
    exists: () => true,
    platform: "darwin",
  });

  assert.match(command, /node_modules\/\.bin\/pretty-diff$/);
});

test("getPrettyDiffCommand falls back to PATH when the local binary is missing", () => {
  assert.equal(getPrettyDiffCommand({ exists: () => false }), "pretty-diff");
});

test("getPrettyDiffCommand chooses gist-diff when publishing", () => {
  const command = getPrettyDiffCommand({
    exists: () => true,
    platform: "darwin",
    publish: true,
  });

  assert.match(command, /node_modules\/\.bin\/gist-diff$/);
});

test("parseDiffArgs extracts gist publishing flags", () => {
  assert.deepEqual(parseDiffArgs(["--gist", "HEAD^"]), {
    args: ["HEAD^"],
    publish: true,
  });
  assert.deepEqual(parseDiffArgs(["--public", "--cached"]), {
    args: ["--public", "--cached"],
    publish: true,
  });
});

test("diff command forwards git diff arguments to pretty-diff", async () => {
  const calls = [];
  const diff = createDiffCommand({
    getCommand: ({ publish }) => publish ? "gist-diff" : "pretty-diff",
    runCommand: async (command) => {
      calls.push(command);
    },
  });

  await diff(["--cached", "--", "mail/base/test/browser/browser_tree.js"]);

  assert.deepEqual(calls, [{
    cmd: "pretty-diff",
    args: ["--cached", "--", "mail/base/test/browser/browser_tree.js"],
  }]);
});

test("diff command publishes via gist-diff", async () => {
  const calls = [];
  const diff = createDiffCommand({
    getCommand: ({ publish }) => publish ? "gist-diff" : "pretty-diff",
    runCommand: async (command) => {
      calls.push(command);
    },
  });

  await diff(["--gist", "--public", "HEAD^"]);

  assert.deepEqual(calls, [{
    cmd: "gist-diff",
    args: ["--public", "HEAD^"],
  }]);
});
