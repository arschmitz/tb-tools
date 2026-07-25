import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPreflightCommand,
  getPreflightSteps,
  getTestOptions,
  getTryOptions,
} from "../commands/preflight.mjs";

test("getPreflightSteps runs status, lint, and tests by default", () => {
  assert.deepEqual(getPreflightSteps(), ["status", "lint", "test"]);
});

test("getPreflightSteps supports skipped and optional steps", () => {
  assert.deepEqual(getPreflightSteps({
    skipLint: true,
    diff: true,
    try: true,
  }), ["status", "test", "diff", "try"]);
});

test("getTestOptions extracts test options", () => {
  assert.deepEqual(getTestOptions({
    flavor: "browser",
    pattern: ["mail/**/browser_*.js"],
    unrelated: true,
  }), {
    flavor: "browser",
    pattern: ["mail/**/browser_*.js"],
  });
});

test("getTryOptions extracts try options", () => {
  assert.deepEqual(getTryOptions({
    selector: "fuzzy",
    query: "account hub",
    "tasks-regex": "mochitest",
    preset: "smoke",
    artifact: false,
    comment: true,
  }), {
    selector: "fuzzy",
    query: "account hub",
    "tasks-regex": "mochitest",
    preset: "smoke",
    artifact: false,
    comment: true,
  });
});

test("preflight command runs the selected workflow in order", async () => {
  const calls = [];
  const preflight = createPreflightCommand({
    status: async (options) => calls.push(["status", options]),
    lintCommand: async () => calls.push(["lint"]),
    testCommand: async (options) => calls.push(["test", options]),
    diff: async (args) => calls.push(["diff", args]),
    tryRunner: async (options) => calls.push(["try", options]),
    write: (message) => calls.push(["write", message]),
  });

  await preflight({
    base: "origin/main",
    flavor: "browser",
    pattern: "mail/**/browser_*.js",
    diff: true,
    diffArgs: ["--cached"],
    try: true,
    selector: "auto",
    artifact: false,
  });

  assert.deepEqual(calls, [
    ["write", "Running status"],
    ["status", { base: "origin/main" }],
    ["write", "Running lint"],
    ["lint"],
    ["write", "Running test"],
    ["test", { flavor: "browser", pattern: "mail/**/browser_*.js" }],
    ["write", "Running diff"],
    ["diff", ["--cached"]],
    ["write", "Running try"],
    ["try", {
      selector: "auto",
      query: undefined,
      "tasks-regex": undefined,
      preset: undefined,
      artifact: false,
      comment: undefined,
    }],
  ]);
});
