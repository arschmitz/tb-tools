import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLintCommand,
  getDefaultLintFiles,
  LINT_DIRS,
} from "../commands/lint.mjs";

function createSpinner(calls) {
  return (options) => {
    calls.push(["spinner", options]);

    return {
      start() {
        calls.push(["spinner-start"]);

        return {
          succeed(message) {
            calls.push(["spinner-succeed", message]);
          },
          fail() {
            calls.push(["spinner-fail"]);
          },
        };
      },
    };
  };
}

test("getDefaultLintFiles includes current local commit files and uncommitted files", async () => {
  const calls = [];
  const files = await getDefaultLintFiles({
    runGit: async (args) => {
      calls.push(args);

      if (args[0] === "merge-base") {
        throw new Error("HEAD is not on origin/main");
      }

      if (args[0] === "diff-tree") {
        return "mail/base/content/message.js\nmail/base/content/shared.js\n";
      }

      if (args[0] === "diff" && args[1] === "--name-only") {
        return "mail/base/content/message.js\nmail/base/content/dirty.js\n";
      }

      if (args[0] === "diff" && args[1] === "--cached") {
        return "calendar/base/content/staged.js\n";
      }

      if (args[0] === "ls-files") {
        return "mail/base/content/new.js\n";
      }

      return "";
    },
  });

  assert.deepEqual(files, [
    "mail/base/content/message.js",
    "mail/base/content/shared.js",
    "mail/base/content/dirty.js",
    "calendar/base/content/staged.js",
    "mail/base/content/new.js",
  ]);
  assert.deepEqual(calls, [
    ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
    ["diff", "--name-only", "--diff-filter=ACMR"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    ["ls-files", "--others", "--exclude-standard"],
    ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=ACMR", "-r", "--root", "HEAD"],
  ]);
});

test("getDefaultLintFiles only includes uncommitted files when HEAD is published on main", async () => {
  const calls = [];
  const files = await getDefaultLintFiles({
    runGit: async (args) => {
      calls.push(args);

      if (args[0] === "diff-tree") {
        assert.fail("published commits should not be linted");
      }

      if (args[0] === "diff" && args[1] === "--name-only") {
        return "mail/base/content/dirty.js\n";
      }

      return "";
    },
  });

  assert.deepEqual(files, ["mail/base/content/dirty.js"]);
  assert.deepEqual(calls, [
    ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
    ["diff", "--name-only", "--diff-filter=ACMR"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    ["ls-files", "--others", "--exclude-standard"],
  ]);
});

test("lint command runs commlint on inferred files by default", async () => {
  const calls = [];
  const lint = createLintCommand({
    getLintFiles: async () => ["mail/base/content/message.js", "calendar/base/content/calendar.js"],
    runMach: async (args) => calls.push(["mach", args]),
    createSpinner: createSpinner(calls),
  });

  const targets = await lint();

  assert.deepEqual(targets, ["mail/base/content/message.js", "calendar/base/content/calendar.js"]);
  assert.deepEqual(calls, [
    ["spinner", { text: "Linting", spinner: "aesthetic" }],
    ["spinner-start"],
    ["mach", ["commlint", "mail/base/content/message.js", "calendar/base/content/calendar.js", "--fix"]],
    ["spinner-succeed", undefined],
  ]);
});

test("lint command --all keeps the old directory-wide behavior", async () => {
  const calls = [];
  const lint = createLintCommand({
    getLintFiles: async () => {
      assert.fail("--all should not infer changed files");
    },
    runMach: async (args) => calls.push(args),
    createSpinner: createSpinner([]),
  });

  await lint({ all: true });

  assert.deepEqual(calls, [["commlint", ...LINT_DIRS, "--fix"]]);
});

test("lint command skips mach when there are no inferred files", async () => {
  const calls = [];
  const lint = createLintCommand({
    getLintFiles: async () => [],
    runMach: async () => {
      assert.fail("mach should not run without lint targets");
    },
    createSpinner: createSpinner(calls),
  });

  const targets = await lint();

  assert.deepEqual(targets, []);
  assert.deepEqual(calls, [
    ["spinner", { text: "Linting", spinner: "aesthetic" }],
    ["spinner-start"],
    ["spinner-succeed", "No files to lint."],
  ]);
});
