import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTestCommand,
  getPatterns,
  getTestTargets,
  getTestsForChangedFiles,
} from "../commands/test.mjs";

test("getPatterns normalizes omitted, single, and multiple patterns", () => {
  assert.deepEqual(getPatterns(), []);
  assert.deepEqual(getPatterns("mail/**/browser_*.js"), ["mail/**/browser_*.js"]);
  assert.deepEqual(getPatterns(["mail/test.js", ""]), ["mail/test.js"]);
});

test("test command passes explicit patterns directly to mach test", async () => {
  const calls = [];
  const testCommand = createTestCommand({
    getChangedFiles: async () => {
      assert.fail("changed-file inference should not run when a pattern is provided");
    },
    runMach: async (args) => {
      calls.push(args);
    },
  });

  await testCommand({
    headless: true,
    pattern: [
      "mail/components/accountcreation/test/browser/browser_*.js",
      "mail/base/test/browser/browser_tree.js",
    ],
  });

  assert.deepEqual(calls, [[
    "test",
    "--headless",
    "mail/components/accountcreation/test/browser/browser_*.js",
    "mail/base/test/browser/browser_tree.js",
  ]]);
});

test("test command infers component tests when no pattern is provided", async () => {
  const calls = [];
  const testCommand = createTestCommand({
    getChangedFiles: async () => [
      "mail/components/accountcreation/content/emailWizard.js",
    ],
    runMach: async (args) => {
      calls.push(args);
    },
  });

  await testCommand({ flavor: "browser" });

  assert.deepEqual(calls, [[
    "test",
    "mail/components/accountcreation/test/browser",
  ]]);
});

test("getTestsForChangedFiles includes changed test files outside components", () => {
  assert.deepEqual(
    Array.from(getTestsForChangedFiles(["browser_direct.js"])),
    ["browser_direct.js"]
  );
});

test("getTestsForChangedFiles includes nested changed test files directly", () => {
  assert.deepEqual(
    Array.from(getTestsForChangedFiles([
      "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
      "mail/components/accountcreation/test/browser/browser_accountSetup.js",
    ])),
    [
      "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
      "mail/components/accountcreation/test/browser/browser_accountSetup.js",
    ]
  );
});

test("getTestTargets returns explicit patterns without reading changed files", async () => {
  const targets = await getTestTargets({
    pattern: ["mail/**/browser_*.js"],
    getChangedFiles: async () => {
      assert.fail("changed-file inference should not run when patterns are provided");
    },
  });

  assert.deepEqual(targets, ["mail/**/browser_*.js"]);
});
