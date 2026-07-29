import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  amendCommitMessage,
  amendCurrentCommit,
  attachGraphTryRunsToCommits,
  answerSubmitSessionPrompt,
  buildGraphCommitMessage,
  chooseCheckoutBranch,
  choosePruneBranches,
  chooseRebaseBranch,
  chooseRewordBranch,
  checkoutCommit,
  continueRebaseCommit,
  createBranchForCommit,
  createGraphCommit,
  createGraphCommand,
  getGraphCommitMessage,
  getGraphCommitIntegrationStatus,
  getGraphCommitMetadata,
  getGraphCurrentCommitMessage,
  discardWorkingTreeChanges,
  getGraphOriginMainStatus,
  getGraphRustUpstreamStatus,
  getGraphTryRunsForCommit,
  getLandingPatchTryStatus,
  getLatestLandingPatchTryRun,
  getCheckoutCommitPage,
  getCheckoutGraphData,
  getCheckoutGraphMetadata,
  getCommitDiffs,
  getWorkingTreeCommits,
  getWorkingTreeDiff,
  getGraphOutputPath,
  getTreeherderUrlsFromText,
  isWorkingTreeCommitHash,
  markGraphBugForCheckin,
  cleanGraphTestTerminalOutput,
  createGraphTestSession,
  getPseudoTerminalCommand,
  normalizeGraphTryOptions,
  normalizeGraphTestOptions,
  normalizeGraphTryStore,
  parseGraphTestOutput,
  parseDecorations,
  parseGitLog,
  pruneCommitBranches,
  pruneMissingParents,
  rebaseCommit,
  recordGraphTryRun,
  runGraphTrySubmission,
  runGraphCommitAction,
  searchGraphCommitReviewers,
  normalizeGraphCommitReviewers,
  getInteractiveYesNoPrompt,
  runGraphMachActionSession,
  runGraphRepositoryUpdate,
  runInteractiveSubmitCommand,
  serializeGraphTestSession,
  startInteractiveGraphServer,
  truncateDiff,
  unshelfGraphShelves,
  updateGraphCheckout,
  waitForInteractiveServerClose,
} from "../commands/graph.mjs";
import { createConsoleCommand } from "../commands/console.mjs";
import {
  formatPrettyDiffHtml,
  splitPrettyDiffFiles,
} from "../commands/graph/diff-renderer.mjs";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "../commands/graph/constants.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

const GRAPH_CLIENT_TEST_ASSETS = [
  { source: "style.css", output: "graph-client/style.css" },
  { source: "config.js", output: "graph-client/config.js" },
  { source: "commit-model.js", output: "graph-client/commit-model.js" },
  { source: "dom.js", output: "graph-client/dom.js" },
  { source: "pane-resizer.js", output: "graph-client/pane-resizer.js" },
  { source: "lane-renderer.js", output: "graph-client/lane-renderer.js" },
  { source: "diff-viewer.js", output: "graph-client/diff-viewer.js" },
  { source: "command-sessions.js", output: "graph-client/command-sessions.js" },
  { source: "rebase-dialog.js", output: "graph-client/rebase-dialog.js" },
  { source: "commit-actions.js", output: "graph-client/commit-actions.js" },
  { source: "commit-dialog.js", output: "graph-client/commit-dialog.js" },
  { source: "landing-dialog.js", output: "graph-client/landing-dialog.js" },
  { source: "new-patch-dialog.js", output: "graph-client/new-patch-dialog.js" },
  { source: "patch-dialog.js", output: "graph-client/patch-dialog.js" },
  { source: "test-dialog.js", output: "graph-client/test-dialog.js" },
  { source: "init.js", output: "graph-client/init.js" },
];

test("interactive graph server defaults to a 24 hour heartbeat timeout", () => {
  assert.equal(DEFAULT_HEARTBEAT_TIMEOUT_MS, 24 * 60 * 60 * 1000);
});

function readGraphClientScripts() {
  return GRAPH_CLIENT_TEST_ASSETS.filter(({ source }) => source.endsWith(".js"))
    .map(({ source }) =>
      readFileSync(
        path.join(process.cwd(), "commands/graph/client", source),
        "utf8",
      ),
    )
    .join("\n");
}

function readGraphClientStylesheet() {
  return readFileSync(
    path.join(process.cwd(), "commands/graph/client/style.css"),
    "utf8",
  ).replace(/\s+/g, " ");
}

async function waitForSubmitSession(url, predicate) {
  for (let index = 0; index < 50; index++) {
    const response = await fetch(url);
    const session = await response.json();

    if (predicate(session)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for submit session.");
}

async function waitForMachSession(url, predicate) {
  for (let index = 0; index < 50; index++) {
    const response = await fetch(url);
    const session = await response.json();

    if (predicate(session)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for mach session.");
}

async function waitForLandSession(url, predicate) {
  for (let index = 0; index < 80; index++) {
    const response = await fetch(url);
    const session = await response.json();

    if (predicate(session)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for landing session.");
}

async function waitForSubmitSessionLike(session, predicate) {
  for (let index = 0; index < 50; index++) {
    if (predicate(session)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for submit session state.");
}

test("parseDecorations expands HEAD arrows and tags", () => {
  assert.deepEqual(parseDecorations("HEAD -> main, origin/main, tag: v1.0.0"), [
    "HEAD",
    "main",
    "origin/main",
    "tag: v1.0.0",
  ]);
  assert.deepEqual(parseDecorations("origin/HEAD -> origin/main"), [
    "origin/main",
  ]);
});

test("parseGitLog converts git log records into graph data", () => {
  const output =
    "\x1eabc123\x1fparent1 parent2\x1fHEAD -> main, tag: v1.0.0\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";

  assert.deepEqual(parseGitLog(output), [
    {
      hash: "abc123",
      parents: ["parent1", "parent2"],
      refs: ["HEAD", "main", "tag: v1.0.0"],
      author: {
        name: "Alice",
        email: "alice@example.com",
        timestamp: 1710000000000,
      },
      subject: "Fix the thing",
    },
  ]);
});

test("pruneMissingParents removes parents outside the displayed commit window", () => {
  assert.deepEqual(
    pruneMissingParents([
      { hash: "child", parents: ["parent", "missing"] },
      { hash: "parent", parents: ["older"] },
    ]),
    [
      { hash: "child", parents: ["parent"] },
      { hash: "parent", parents: [] },
    ],
  );
});

test("normalizeGraphTryOptions mirrors the supported mach try option surface", () => {
  assert.deepEqual(
    normalizeGraphTryOptions({
      selector: "fuzzy",
      query: "linux64 debug",
      preset: "smoke",
      artifact: false,
      comment: true,
    }),
    {
      selector: "fuzzy",
      query: "linux64 debug",
      preset: "smoke",
      artifact: false,
      comment: true,
    },
  );
  assert.deepEqual(
    normalizeGraphTryOptions({
      selector: "surprise",
      tasksRegex: "browser",
    }),
    {
      selector: "auto",
      "tasks-regex": "browser",
      artifact: true,
      comment: false,
    },
  );
});

test("normalizeGraphTestOptions supports flavor and comma or line separated patterns", () => {
  assert.deepEqual(
    normalizeGraphTestOptions({
      flavor: "browser",
      headless: true,
      pattern: "mail/**/browser_*.js,\ncalendar/test/unit/test_alarm.js",
    }),
    {
      flavor: "browser",
      headless: true,
      pattern: ["mail/**/browser_*.js", "calendar/test/unit/test_alarm.js"],
    },
  );
  assert.deepEqual(
    normalizeGraphTestOptions({
      flavor: "surprise",
    }),
    {
      flavor: "all",
      pattern: [],
      headless: false,
    },
  );
  assert.equal(
    normalizeGraphTestOptions({ headless: "false" }).headless,
    false,
  );
});

test("getPseudoTerminalCommand wraps real test runs in script for color output", () => {
  assert.deepEqual(
    getPseudoTerminalCommand(
      {
        cmd: "../mach",
        args: ["test", "mail/test/browser/browser_color.js"],
        cwd: "/repo/comm",
        capture: true,
      },
      "darwin",
    ),
    {
      cmd: "script",
      args: [
        "-q",
        "-e",
        "-F",
        "/dev/null",
        "../mach",
        "test",
        "mail/test/browser/browser_color.js",
      ],
      cwd: "/repo/comm",
      capture: true,
    },
  );
  assert.deepEqual(
    getPseudoTerminalCommand(
      {
        cmd: "../mach",
        args: ["test", "mail/test/browser/browser_color.js"],
        cwd: "/repo/comm",
      },
      "linux",
    ),
    {
      cmd: "script",
      args: [
        "-q",
        "-e",
        "-f",
        "-c",
        "'../mach' 'test' 'mail/test/browser/browser_color.js'",
        "/dev/null",
      ],
      cwd: "/repo/comm",
    },
  );
  assert.deepEqual(
    getPseudoTerminalCommand(
      {
        cmd: "../mach",
        args: ["test"],
      },
      "win32",
    ),
    {
      cmd: "../mach",
      args: ["test"],
    },
  );
});

test("cleanGraphTestTerminalOutput removes terminal noise without stripping ANSI color", () => {
  assert.equal(
    cleanGraphTestTerminalOutput("^D\b\b\x1b(B\x1b[31mred\x1b[0m\n"),
    "\x1b[31mred\x1b[0m\n",
  );
});

test("parseGraphTestOutput summarizes live failure lines and creates VS Code links", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser",
      "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
    ],
    commandFailed: true,
    output: [
      "\x1b[31mTEST-UNEXPECTED-FAIL | mail/test/browser/folder-display/browser_messagePaneVisibility.js:42 | expected visible pane\x1b[0m",
      "Passed: 7",
      "Failed: 1",
      "Todo: 0",
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.passed, 7);
  assert.equal(summary.failureCount, 1);
  assert.equal(
    summary.failures[0].path,
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(summary.failures[0].lineNumber, 42);
  assert.equal(
    summary.failures[0].absolutePath,
    "/repo/comm/mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(
    summary.failures[0].vscodeUrl,
    "vscode://file//repo/comm/mail/test/browser/folder-display/browser_messagePaneVisibility.js:42",
  );
  assert.deepEqual(summary.failedFiles, [
    {
      path: "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
      lineNumber: 42,
      absolutePath:
        "/repo/comm/mail/test/browser/folder-display/browser_messagePaneVisibility.js",
      vscodeUrl:
        "vscode://file//repo/comm/mail/test/browser/folder-display/browser_messagePaneVisibility.js:42",
      failureCount: 1,
      firstLine:
        "TEST-UNEXPECTED-FAIL | mail/test/browser/folder-display/browser_messagePaneVisibility.js:42 | expected visible pane",
    },
  ]);
});

test("parseGraphTestOutput summarizes final unexpected result files", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
      "calendar/test/unit/test_alarm.js",
    ],
    commandFailed: true,
    output: [
      "Overall Summary",
      "===============",
      "Ran 12 checks (2 tests)",
      "Expected results: 10",
      "Unexpected results: 2",
      "",
      "Unexpected Results",
      "==================",
      "\x1b(B\x1b[31mFAIL mail/test/browser/folder-display/browser_messagePaneVisibility.js:42 | expected visible pane\x1b[0m",
      "ERROR calendar/test/unit/test_alarm.js | alarm should fire",
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.expected, 10);
  assert.equal(summary.unexpected, 2);
  assert.equal(summary.failureCount, 2);
  assert.deepEqual(summary.failedPaths, [
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
    "calendar/test/unit/test_alarm.js",
  ]);
  assert.equal(summary.failures[0].status, "FAIL");
  assert.equal(summary.failures[0].message, "expected visible pane");
  assert.equal(
    summary.failures[0].path,
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(summary.failures[0].lineNumber, 42);
  assert.equal(summary.failures[1].status, "ERROR");
  assert.equal(summary.failures[1].message, "alarm should fire");
  assert.equal(summary.failedFiles[0].failureCount, 1);
});

test("parseGraphTestOutput handles mochitest Error Summary context lines", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
      "mail/components/accountcreation/test/browser/browser_other.js",
    ],
    commandFailed: true,
    output: [
      "mochitest-browser",
      "~~~~~~~~~~~~~~~~~",
      "Ran 1318 checks (1288 subtests, 30 tests)",
      "Expected results: 1316",
      "Unexpected results: 2",
      "  test: 1 (1 fail)",
      "  subtest: 1 (1 fail)",
      'FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
      "",
      "Error Summary",
      "-------------",
      "comm/mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
      '  FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
      "chrome://mochitests/content/browser/comm/mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js:test_setStatePrefillsDiscoveredGraphConfig:495",
      "chrome://mochikit/content/browser-test.js:handleTask:1402",
      "  FAIL comm/mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js - finished in 652ms",
      "",
      "xpcshell",
      "~~~~~~~~",
      "Ran 15 checks (15 tests)",
      "Expected results: 15",
      "Unexpected results: 0",
      "OK",
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.expected, 1316);
  assert.equal(summary.unexpected, 2);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.failedFiles.length, 1);
  assert.equal(
    summary.failedFiles[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failedFiles[0].failureCount, 1);
  assert.equal(
    summary.failedPaths[0],
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failures.length, 1);
  assert.equal(
    summary.failures[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failures[0].lineNumber, 495);
  assert.equal(
    summary.failures[0].message,
    'test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
  );
});

test("parseGraphTestOutput keeps pre-summary live failures while a test is running", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
    ],
    running: true,
    output: [
      "mochitest-browser",
      "~~~~~~~~~~~~~~~~~",
      'FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.failureCount, 1);
  assert.equal(
    summary.failedFiles[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failedFiles[0].failureCount, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(
    summary.failures[0].message,
    'test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
  );
});

test("parseGraphTestOutput uses live TEST-START context for bare failure lines", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser",
      "calendar/test/unit/test_alarm.js",
    ],
    running: true,
    output: [
      "TEST-START | comm/mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
      'FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.failedFiles.length, 1);
  assert.equal(
    summary.failedFiles[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failures.length, 1);
  assert.equal(
    summary.failures[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
});

test("parseGraphTestOutput replaces live failures with Error Summary while running", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
    ],
    running: true,
    output: [
      'FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
      "",
      "Error Summary",
      "-------------",
      "comm/mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
      '  FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.failureCount, 1);
  assert.equal(
    summary.failedFiles[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failedFiles[0].failureCount, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].lineNumber, 0);
});

test("parseGraphTestOutput does not duplicate live failures when summary rows arrive", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser",
      "calendar/test/unit",
    ],
    running: true,
    knownFailures: [
      {
        line: "FAIL test_first - first message",
        status: "FAIL",
        message: "test_first - first message",
        path: "mail/components/accountcreation/test/browser/browser_first.js",
        lineNumber: 42,
        absolutePath:
          "/repo/comm/mail/components/accountcreation/test/browser/browser_first.js",
        vscodeUrl:
          "vscode://file//repo/comm/mail/components/accountcreation/test/browser/browser_first.js:42",
      },
      {
        line: "FAIL test_second - second message",
        status: "FAIL",
        message: "test_second - second message",
        path: "mail/components/accountcreation/test/browser/browser_second.js",
        lineNumber: 84,
        absolutePath:
          "/repo/comm/mail/components/accountcreation/test/browser/browser_second.js",
        vscodeUrl:
          "vscode://file//repo/comm/mail/components/accountcreation/test/browser/browser_second.js:84",
      },
    ],
    output: [
      "TEST-START | comm/mail/components/accountcreation/test/browser/browser_first.js",
      "FAIL test_first - first message",
      "TEST-START | comm/mail/components/accountcreation/test/browser/browser_second.js",
      "FAIL test_second - second message",
      "",
      "Error Summary",
      "-------------",
      "comm/mail/components/accountcreation/test/browser/browser_first.js",
      "  FAIL test_first - first message",
      "chrome://mochitests/content/browser/comm/mail/components/accountcreation/test/browser/browser_first.js:test_first:42",
      "comm/mail/components/accountcreation/test/browser/browser_second.js",
      "  FAIL test_second - second message",
      "chrome://mochitests/content/browser/comm/mail/components/accountcreation/test/browser/browser_second.js:test_second:84",
      "",
      "Error Summary",
      "-------------",
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.failureCount, 2);
  assert.deepEqual(summary.failedPaths, [
    "mail/components/accountcreation/test/browser/browser_first.js",
    "mail/components/accountcreation/test/browser/browser_second.js",
  ]);
  assert.equal(summary.failures.length, 2);
  assert.equal(summary.failedFiles.length, 2);
  assert.equal(summary.failures[0].lineNumber, 42);
  assert.equal(summary.failures[1].lineNumber, 84);
});

test("parseGraphTestOutput keeps live failures until Error Summary has rows", () => {
  const summary = parseGraphTestOutput({
    graph: { path: "/repo/comm" },
    targets: [
      "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
    ],
    running: true,
    output: [
      "mochitest-browser",
      "~~~~~~~~~~~~~~~~~",
      "Unexpected results: 2",
      'FAIL test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
      "",
      "Error Summary",
      "-------------",
    ].join("\n"),
  });

  assert.equal(summary.status, "failed");
  assert.equal(summary.unexpected, 2);
  assert.equal(summary.failureCount, 1);
  assert.equal(
    summary.failedFiles[0].path,
    "mail/components/accountcreation/test/browser/browser_accountHubEmailExchangeType.js",
  );
  assert.equal(summary.failures.length, 1);
  assert.equal(
    summary.failures[0].message,
    'test_setStatePrefillsDiscoveredGraphConfig - The username should be prefilled from the Graph config - "graph-user@example.com" == "graph-user@exale.com"',
  );
});

test("createGraphTestSession keeps parsed failures after raw output is capped", async () => {
  const failureLine =
    "\x1b(B\x1b[31mFAIL mail/test/browser/folder-display/browser_messagePaneVisibility.js:42 | expected visible pane\x1b[0m\n";
  const longTail = "noise\n".repeat(40000);
  const session = createGraphTestSession({
    graph: { label: "comm", path: "/repo/comm" },
    graphIndex: 0,
    options: {
      pattern: [
        "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
      ],
    },
    runCommand: async (command) => {
      if (command.cmd.endsWith("mach")) {
        const error = new Error("mach test failed");

        error.stdout = `${failureLine}${longTail}Failed: 1\n`;
        error.stderr = "";
        throw error;
      }

      return "";
    },
  });

  await waitForSubmitSessionLike(session, (item) => item.status === "error");

  const serialized = serializeGraphTestSession(session);

  assert.equal(serialized.output.includes("expected visible pane"), false);
  assert.equal(serialized.output.includes("(B"), false);
  assert.equal(serialized.summary.status, "failed");
  assert.equal(serialized.summary.failureCount, 1);
  assert.equal(
    serialized.failures[0].path,
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(serialized.failures[0].lineNumber, 42);
  assert.equal(
    serialized.failedFiles[0].path,
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(serialized.canRerunFailures, false);
});

test("graph try runs are stored by stable patch id and attach after a rebase", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-try-store-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const graph = { label: "comm", path: "/repo/comm" };
  const runCommand = async (command) => {
    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.cmd === "sh") {
      return "stable-patch-id abc123\n";
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "run-1",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=one",
      createdAt: "2026-07-27T12:00:00.000Z",
      hash: "abc123",
      patchId: "stable-patch-id",
      subject: "Bug 123 - Try this",
      label: "comm",
    },
  });

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "run-2",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=two",
      createdAt: "2026-07-27T12:05:00.000Z",
      hash: "abc123",
      patchId: "stable-patch-id",
      subject: "Bug 123 - Try this",
      label: "comm",
    },
  });

  const [commit] = await attachGraphTryRunsToCommits({
    graph,
    runCommand,
    commits: [
      {
        hash: "def456",
        parents: [],
        refs: ["HEAD"],
        subject: "Bug 123 - Try this",
      },
    ],
  });

  assert.equal(commit.tryRuns.length, 2);
  assert.equal(
    commit.tryRuns[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=two",
  );
  assert.equal(
    commit.tryRuns[1].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=one",
  );

  const normalized = normalizeGraphTryStore({
    runsByPatchId: {
      "stable-patch-id": [commit.tryRuns[0]],
    },
  });
  assert.equal(normalized.runs[0].patchId, "stable-patch-id");
});

test("runGraphTrySubmission records mach try output for the current commit", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-try-run-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const graph = { label: "comm", path: "/repo/comm" };
  const runCommand = async (command) => {
    calls.push(command);

    if (command.cmd.endsWith("mach")) {
      return "Created try push: https://treeherder.mozilla.org/jobs?repo=try&revision=abc\n";
    }

    if (command.args[0] === "branch" && command.args[1] === "--show-current") {
      return "main\n";
    }

    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "rev-parse") {
      return "abc123\n";
    }

    if (command.args[0] === "diff" || command.args[0] === "ls-files") {
      return "";
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return "Bug 123 - Try me. r=#reviewers\n";
    }

    if (command.cmd === "sh") {
      return "stable-patch-id abc123\n";
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const session = { output: "" };
  const result = await runGraphTrySubmission({
    graph,
    session,
    runCommand,
    options: {
      selector: "fuzzy",
      query: "linux64 debug",
      preset: "smoke",
      artifact: false,
    },
  });

  assert.equal(
    result.tryUrl,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
  );
  assert.equal(result.tryRun.patchId, "stable-patch-id");
  assert.equal(result.tryRun.subject, "Bug 123 - Try me. r=#reviewers");
  assert.match(
    session.output,
    /\$ \.\.\/mach try fuzzy --query linux64 debug --preset smoke --no-artifact/,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.args.join(" ") ===
          "try fuzzy --query linux64 debug --preset smoke --no-artifact",
    ),
    true,
  );

  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: { hash: "rebased456", subject: "Bug 123 - Try me" },
  });
  assert.equal(
    runs[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
  );
});

test("landing patch try status reads Treeherder links from Phabricator comments", () => {
  assert.deepEqual(
    getTreeherderUrlsFromText(
      "any comment https://treeherder.mozilla.org/jobs?repo=try&revision=abc.",
    ),
    ["https://treeherder.mozilla.org/jobs?repo=try&revision=abc"],
  );

  const transactions = [
    {
      type: "comment",
      dateCreated: 1700000000,
      comments: [
        {
          content: {
            raw: "Green enough: https://treeherder.mozilla.org/jobs?repo=try&revision=old",
          },
        },
      ],
    },
    {
      type: "comment",
      dateCreated: 1700000600,
      comments: [
        {
          content: {
            raw: "Latest remote run https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=new",
          },
        },
      ],
    },
  ];
  const latest = getLatestLandingPatchTryRun({ transactions });

  assert.equal(
    latest.url,
    "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=new",
  );
  assert.deepEqual(getLandingPatchTryStatus({ transactions }), {
    state: "current",
    latestTryRun: latest,
    warning: "",
  });
});

test("landing patch try status warns for missing and stale Treeherder runs", () => {
  assert.deepEqual(getLandingPatchTryStatus(), {
    state: "missing",
    latestTryRun: null,
    warning: "No Treeherder try run was found in Phabricator comments.",
  });

  const status = getLandingPatchTryStatus({
    patch: {
      diffs: [
        {
          dateCreated: 1700000800,
        },
      ],
    },
    transactions: [
      {
        type: "comment",
        dateCreated: 1700000600,
        comments: [
          {
            content: {
              raw: "https://treeherder.mozilla.org/jobs?repo=try&revision=before-diff",
            },
          },
        ],
      },
    ],
  });

  assert.equal(status.state, "stale");
  assert.equal(
    status.latestTryRun.url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=before-diff",
  );
  assert.equal(
    status.warning,
    "Patch changes were posted after the latest Treeherder try run.",
  );
});

test("chooseCheckoutBranch prefers the current branch when available", () => {
  assert.equal(chooseCheckoutBranch("topic\nmain\n", "main"), "main");
  assert.equal(chooseCheckoutBranch("topic\nmain\n", "other"), "topic");
  assert.equal(chooseCheckoutBranch("", "main"), "");
});

test("choosePruneBranches picks the local branch to rewrite", () => {
  assert.deepEqual(
    choosePruneBranches({
      containingRefs: "topic\nmain\n",
      currentBranch: "main",
    }),
    ["main"],
  );
  assert.deepEqual(
    choosePruneBranches({
      containingRefs: "topic\nmain\n",
      tipRefs: "topic\nmain\n",
    }),
    ["topic", "main"],
  );
  assert.deepEqual(
    choosePruneBranches({
      containingRefs: "topic\n",
    }),
    ["topic"],
  );
  assert.deepEqual(
    choosePruneBranches({
      containingRefs: "topic\nmain\n",
    }),
    [],
  );
});

test("chooseRebaseBranch picks one source branch containing the selected commit", () => {
  assert.equal(
    chooseRebaseBranch({
      containingRefs: "topic\nmain\n",
      tipRefs: "topic\nmain\n",
      currentBranch: "main",
    }),
    "main",
  );
  assert.equal(
    chooseRebaseBranch({
      containingRefs: "topic\n",
      currentBranch: "main",
    }),
    "topic",
  );
  assert.equal(
    chooseRebaseBranch({
      containingRefs: "topic\nother\n",
      currentBranch: "main",
    }),
    "",
  );
  assert.equal(
    chooseRebaseBranch({
      containingRefs: "main\n",
      currentBranch: "main",
    }),
    "main",
  );
});

test("chooseRewordBranch prefers the checked-out branch containing the selected commit", () => {
  assert.equal(
    chooseRewordBranch({
      containingRefs: "topic\nmain\n",
      currentBranch: "main",
    }),
    "main",
  );
  assert.equal(
    chooseRewordBranch({
      containingRefs: "topic\n",
      currentBranch: "main",
    }),
    "topic",
  );
  assert.equal(
    chooseRewordBranch({
      containingRefs: "topic\nother\n",
      currentBranch: "main",
    }),
    "",
  );
  assert.equal(
    chooseRewordBranch({
      containingRefs: "topic\nmain\n",
      tipRefs: "topic\n",
    }),
    "topic",
  );
});

test("truncateDiff caps embedded diff size", () => {
  assert.deepEqual(truncateDiff("small diff", 100), {
    text: "small diff",
    html: "",
    truncated: false,
    insertions: 0,
    deletions: 0,
  });
  assert.deepEqual(truncateDiff("abcdef", 3), {
    text: "abc\n\n[diff truncated at 3 bytes]",
    html: '<pre class="info">[diff truncated at 3 bytes]</pre>',
    truncated: true,
    insertions: 0,
    deletions: 0,
  });

  assert.deepEqual(
    truncateDiff(
      [
        "diff --git a/file.txt b/file.txt",
        "@@ -1,2 +1,3 @@",
        " unchanged",
        "-old",
        "+new",
        "+extra",
      ].join("\n"),
      1000,
    ),
    {
      text: [
        "diff --git a/file.txt b/file.txt",
        "@@ -1,2 +1,3 @@",
        " unchanged",
        "-old",
        "+new",
        "+extra",
      ].join("\n"),
      html: formatPrettyDiffHtml(
        [
          "diff --git a/file.txt b/file.txt",
          "@@ -1,2 +1,3 @@",
          " unchanged",
          "-old",
          "+new",
          "+extra",
        ].join("\n"),
      ),
      truncated: false,
      insertions: 2,
      deletions: 1,
    },
  );
});

test("runInteractiveSubmitCommand routes child yes/no prompts through submit session", async () => {
  let child;
  const writes = [];
  const session = {
    status: "running",
    message: "",
    prompt: null,
    pendingPrompt: null,
    output: "",
  };
  const spawnCommand = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(value) {
        writes.push(value);
        child.stdout.emit(
          "data",
          "Submitted https://phabricator.services.mozilla.com/D123456\n",
        );
        queueMicrotask(() => child.emit("exit", 0));
      },
    };
    child.kill = () => {};
    return child;
  };

  const command = runInteractiveSubmitCommand({
    command: { cmd: "moz-phab", args: ["submit"], cwd: "/repo/comm" },
    session,
    spawnCommand,
  });

  child.stdout.emit(
    "data",
    "Submit to https://phabricator.services.mozilla.com (Yes/no/always)? ",
  );
  await waitForSubmitSessionLike(session, (item) => Boolean(item.prompt));
  assert.equal(
    getInteractiveYesNoPrompt(session.output),
    "Submit to https://phabricator.services.mozilla.com (Yes/no/always)?",
  );
  assert.equal(
    session.prompt.message,
    "Submit to https://phabricator.services.mozilla.com (Yes/no/always)?",
  );

  answerSubmitSessionPrompt(session, session.prompt.id, true);

  assert.equal(
    await command,
    "Submit to https://phabricator.services.mozilla.com (Yes/no/always)? Submitted https://phabricator.services.mozilla.com/D123456\n",
  );
  assert.deepEqual(writes, ["y\n"]);
  assert.match(session.output, /\$ moz-phab submit/);
  assert.match(session.output, /> yes/);
  assert.match(
    session.output,
    /Submitted https:\/\/phabricator\.services\.mozilla\.com\/D123456/,
  );
});

test("runGraphMachActionSession keeps run active when mach exits but the process group remains", async (t) => {
  const originalKill = process.kill;
  const killChecks = [];
  const session = {
    action: "run",
    status: "running",
    phase: "",
    message: "",
    output: "",
    child: null,
    childPid: null,
    cancelRequested: false,
  };

  process.kill = (pid, signal) => {
    killChecks.push([pid, signal]);

    if (pid === -4321 && signal === 0) {
      return true;
    }

    return originalKill(pid, signal);
  };
  t.after(() => {
    process.kill = originalKill;
  });

  await runGraphMachActionSession({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    action: "run",
    session,
    runCommand: async (command) => {
      if (command.args[0] === "run") {
        session.childPid = 4321;
      }

      return `${command.args[0]} complete\n`;
    },
  });

  assert.equal(session.status, "running");
  assert.equal(session.phase, "running");
  assert.equal(session.message, "Thunderbird running.");
  assert.equal(session.childPid, 4321);
  assert.deepEqual(killChecks, [[-4321, 0]]);
  assert.match(session.output, /\$ \.\.\/mach build/);
  assert.match(session.output, /\$ \.\.\/mach run/);
});

test("splitPrettyDiffFiles groups patch output by file", () => {
  assert.deepEqual(
    splitPrettyDiffFiles(
      [
        "diff --git a/file.txt b/file.txt",
        "index 123..456 100644",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    ),
    {
      "file.txt": [
        "diff --git a/file.txt b/file.txt",
        "index 123..456 100644",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ],
    },
  );
});

test("formatPrettyDiffHtml renders pretty-diff style markup", () => {
  const html = formatPrettyDiffHtml(
    [
      "diff --git a/file.txt b/file.txt",
      "index 123..456 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -10,2 +20,2 @@",
      " unchanged",
      "-old <value>",
      "+new & better",
    ].join("\n"),
  );

  assert.match(html, /class="pretty-file"/);
  assert.match(html, /class="file-heading"/);
  assert.match(
    html,
    /class="file-stats" aria-label="1 addition and 1 deletion"/,
  );
  assert.match(html, /class="stat-additions">\+1<\/span>/);
  assert.match(html, /class="stat-deletions">-1<\/span>/);
  assert.match(
    html,
    /class="copy-path" type="button" data-path="file.txt">Copy path<\/button>/,
  );
  assert.match(
    html,
    /<div class="file-diff"><table class="diff-table"><tbody>/,
  );
  assert.doesNotMatch(html, /diff --git/);
  assert.doesNotMatch(html, /index 123\.\.456/);
  assert.doesNotMatch(html, /--- a\/file\.txt/);
  assert.doesNotMatch(html, /\+\+\+ b\/file\.txt/);
  assert.match(html, /class="diff-line info"/);
  assert.match(html, /<span class="line-content">@@ -10,2 \+20,2 @@<\/span>/);
  assert.match(html, /class="diff-line context"/);
  assert.match(html, /class="line-number old-line">10<\/td>/);
  assert.match(html, /class="line-number new-line">20<\/td>/);
  assert.match(html, /<span class="line-content">unchanged<\/span>/);
  assert.match(html, /class="diff-line delete"/);
  assert.match(html, /class="line-number old-line">11<\/td>/);
  assert.match(html, /class="line-number new-line"><\/td>/);
  assert.match(
    html,
    /<span class="line-marker">-<\/span><span class="line-content">old &lt;value&gt;<\/span>/,
  );
  assert.match(html, /class="diff-line insert"/);
  assert.match(html, /class="line-number old-line"><\/td>/);
  assert.match(html, /class="line-number new-line">21<\/td>/);
  assert.match(
    html,
    /<span class="line-marker">\+<\/span><span class="line-content">new &amp; better<\/span>/,
  );
  assert.match(html, /data-path="file.txt"/);

  const newFileHtml = formatPrettyDiffHtml(
    [
      "diff --git a/new.txt b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
    ].join("\n"),
  );

  assert.match(newFileHtml, /class="line-number new-line">1<\/td>/);
  assert.match(newFileHtml, /class="line-number new-line">2<\/td>/);

  const markerLikeContentHtml = formatPrettyDiffHtml(
    [
      "diff --git a/marker.txt b/marker.txt",
      "--- a/marker.txt",
      "+++ b/marker.txt",
      "@@ -1 +1 @@",
      "--- markdown heading",
      "+++ plus heading",
    ].join("\n"),
  );

  assert.match(
    markerLikeContentHtml,
    /class="file-stats" aria-label="1 addition and 1 deletion"/,
  );
  assert.match(
    markerLikeContentHtml,
    /class="diff-line delete"[^]*<span class="line-marker">-<\/span><span class="line-content">-- markdown heading<\/span>/,
  );
  assert.match(
    markerLikeContentHtml,
    /class="diff-line insert"[^]*<span class="line-marker">\+<\/span><span class="line-content">\+\+ plus heading<\/span>/,
  );

  const highlightedHtml = formatPrettyDiffHtml(
    [
      "diff --git a/file.mjs b/file.mjs",
      "@@ -1 +1 @@",
      "-const oldValue = 1;",
      '+const newValue = "ok";',
    ].join("\n"),
  );

  assert.match(highlightedHtml, /<span class="hljs-keyword">const<\/span>/);
  assert.match(highlightedHtml, /<span class="hljs-number">1<\/span>/);
  assert.match(
    highlightedHtml,
    /<span class="hljs-string">&quot;ok&quot;<\/span>/,
  );
});

test("getCommitDiffs collects git show output by commit hash", async () => {
  const commands = [];
  const diffs = await getCommitDiffs({
    cwd: "/repo/comm",
    maxDiffBytes: 100,
    commits: [{ hash: "abc123" }],
    runCommand: async (command) => {
      commands.push(command);
      return `commit ${command.args.at(-1)}\n\ndiff --git a/file b/file\n@@ -1 +1 @@\n-old\n+new\n`;
    },
  });

  assert.equal(commands[0].cmd, "git");
  assert.equal(commands[0].cwd, "/repo/comm");
  assert.deepEqual(commands[0].args.slice(0, 2), ["show", "--format="]);
  assert.match(diffs.abc123.text, /diff --git/);
  assert.match(diffs.abc123.html, /pretty-file/);
  assert.equal(diffs.abc123.truncated, false);
  assert.equal(diffs.abc123.insertions, 1);
  assert.equal(diffs.abc123.deletions, 1);
});

test("getWorkingTreeCommits returns one uncommitted item for staged, unstaged, and untracked changes", async () => {
  const commands = [];
  const untrackedDiff = [
    "diff --git a/untracked.txt b/untracked.txt",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/untracked.txt",
    "@@ -0,0 +1 @@",
    "+fresh",
  ].join("\n");
  const workingTree = await getWorkingTreeCommits({
    cwd: "/repo/comm",
    parentHash: "abc123",
    runCommand: async (command) => {
      commands.push(command);

      if (command.args.includes("--no-index")) {
        const error = new Error("files differ");
        error.code = 1;
        error.stdout = untrackedDiff;
        throw error;
      }

      if (command.args[0] === "diff") {
        return [
          "diff --git a/tracked.txt b/tracked.txt",
          "index 1234567..89abcde 100644",
          "--- a/tracked.txt",
          "+++ b/tracked.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n");
      }

      if (command.args[0] === "ls-files") {
        return "untracked.txt\0";
      }

      return "";
    },
  });

  assert.equal(workingTree.commits.length, 1);
  assert.equal(isWorkingTreeCommitHash(workingTree.commits[0].hash), true);
  assert.equal(workingTree.commits[0].subject, "Uncommitted changes");
  assert.deepEqual(workingTree.commits[0].parents, ["abc123"]);
  assert.equal(workingTree.commits[0].workingTree, true);
  assert.match(workingTree.commits[0].changeId, /^[a-f0-9]{64}$/);
  assert.match(
    workingTree.diffs[workingTree.commits[0].hash].text,
    /tracked\.txt/,
  );
  assert.match(
    workingTree.diffs[workingTree.commits[0].hash].text,
    /untracked\.txt/,
  );
  assert.equal(workingTree.diffs[workingTree.commits[0].hash].insertions, 2);
  assert.equal(workingTree.diffs[workingTree.commits[0].hash].deletions, 1);
  assert.equal(
    commands.some((command) => command.args.includes("HEAD")),
    true,
  );
  assert.equal(
    commands.some((command) => command.args[0] === "ls-files"),
    true,
  );
  assert.equal(
    commands.some((command) => command.args.includes("--no-index")),
    true,
  );
});

test("getWorkingTreeDiff returns an empty rendered diff when the working tree is clean", async () => {
  const diff = await getWorkingTreeDiff({
    cwd: "/repo/comm",
    runCommand: async () => "",
  });

  assert.deepEqual(diff, {
    text: "",
    html: "",
    truncated: false,
    insertions: 0,
    deletions: 0,
  });
});

test("getGraphCurrentCommitMessage reads the full current commit message", async () => {
  const calls = [];
  const message = await getGraphCurrentCommitMessage({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    runCommand: async (command) => {
      calls.push(command);
      return "Bug 123 - Fix thing. r=#reviewers\n\nBody text.\n";
    },
  });

  assert.equal(message, "Bug 123 - Fix thing. r=#reviewers\n\nBody text.\n");
  assert.deepEqual(
    calls.map((call) => call.args),
    [["log", "-1", "--format=%B"]],
  );
});

test("getGraphCommitMessage reads the full selected commit message", async () => {
  const calls = [];
  const message = await getGraphCommitMessage({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "Bug 123 - Selected message. r=#reviewers\n\nBody text.\n";
    },
  });

  assert.equal(
    message,
    "Bug 123 - Selected message. r=#reviewers\n\nBody text.\n",
  );
  assert.deepEqual(
    calls.map((call) => call.args),
    [["log", "-1", "--format=%B", "abc123"]],
  );
});

test("getGraphCommitIntegrationStatus reads Bugzilla and Phabricator status", async () => {
  const calls = [];
  const bugCalls = [];
  const phabCalls = [];
  const result = await getGraphCommitIntegrationStatus({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [
        {
          hash: "abc123",
          refs: ["phab-D987654"],
          subject: "Fix thing",
        },
      ],
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "Body text without integration links.\n";
    },
    getBug: async (id) => {
      bugCalls.push(id);
      return {
        bugs: [
          {
            id,
            status: "ASSIGNED",
            resolution: "---",
            summary: "Fix thing",
            assigned_to: "alice@example.com",
            is_open: true,
            keywords: [],
          },
        ],
      };
    },
    phab: async (request) => {
      phabCalls.push(request);
      return {
        result: [
          {
            id: 987654,
            uri: "https://phabricator.services.mozilla.com/D987654",
            status: "status-review",
            statusName: "Needs Review",
            title: "Bug 123456 - Fix thing",
          },
        ],
      };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["log", "-1", "--format=%B", "abc123"],
      ["rev-parse", "--git-path", "tb-tools-try-runs.json"],
    ],
  );
  assert.deepEqual(bugCalls, ["123456"]);
  assert.deepEqual(phabCalls, [
    {
      route: "differential.query",
      params: { ids: [987654] },
    },
  ]);
  assert.equal(result.bugId, "123456");
  assert.equal(result.phabRevision, "D987654");
  assert.deepEqual(result.bug, {
    id: "123456",
    url: "https://bugzilla.mozilla.org/show_bug.cgi?id=123456",
    status: "ASSIGNED",
    resolution: "---",
    summary: "Fix thing",
    assignedTo: "alice@example.com",
    isOpen: true,
    keywords: [],
    hasCheckinNeeded: false,
  });
  assert.deepEqual(result.phabricator, {
    revision: "D987654",
    url: "https://phabricator.services.mozilla.com/D987654",
    status: "status-review",
    statusName: "Needs Review",
    title: "Bug 123456 - Fix thing",
  });
});

test("markGraphBugForCheckin adds the checkin-needed-tb keyword to the detected bug", async () => {
  const calls = [];
  const updates = [];
  let marked = false;
  const result = await markGraphBugForCheckin({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [
        {
          hash: "abc123",
          refs: ["phab-D987654"],
          subject: "Bug 123456 - Fix thing",
        },
      ],
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "Bug 123456 - Fix thing. r=#reviewers\n";
    },
    getBug: async (id) => ({
      bugs: [
        {
          id,
          status: "NEW",
          resolution: "---",
          summary: "Fix thing",
          is_open: true,
          keywords: marked ? ["checkin-needed-tb"] : [],
        },
      ],
    }),
    updateBug: async (id, update) => {
      updates.push([id, update]);
      marked = true;
      return {};
    },
    phab: async () => ({
      result: [
        {
          id: 987654,
          uri: "https://phabricator.services.mozilla.com/D987654",
          status: "status-accepted",
          statusName: "Accepted",
          title: "Bug 123456 - Fix thing",
        },
      ],
    }),
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["log", "-1", "--format=%B", "abc123"],
      ["rev-parse", "--git-path", "tb-tools-try-runs.json"],
      ["log", "-1", "--format=%B", "abc123"],
      ["rev-parse", "--git-path", "tb-tools-try-runs.json"],
    ],
  );
  assert.deepEqual(updates, [
    [
      "123456",
      {
        keywords: {
          add: ["checkin-needed-tb"],
        },
      },
    ],
  ]);
  assert.equal(result.message, "Bug 123456 marked for checkin.");
  assert.equal(result.bug.hasCheckinNeeded, true);
  assert.deepEqual(result.bug.keywords, ["checkin-needed-tb"]);
});

test("markGraphBugForCheckin refuses patches that are not accepted", async () => {
  const updates = [];

  await assert.rejects(
    markGraphBugForCheckin({
      graph: {
        label: "comm",
        path: "/repo/comm",
        commits: [
          {
            hash: "abc123",
            refs: ["phab-D987654"],
            subject: "Bug 123456 - Fix thing",
          },
        ],
      },
      hash: "abc123",
      runCommand: async () => "Bug 123456 - Fix thing. r=#reviewers\n",
      getBug: async (id) => ({
        bugs: [
          {
            id,
            status: "NEW",
            resolution: "---",
            summary: "Fix thing",
            is_open: true,
            keywords: [],
          },
        ],
      }),
      updateBug: async (id, update) => {
        updates.push([id, update]);
      },
      phab: async () => ({
        result: [
          {
            id: 987654,
            uri: "https://phabricator.services.mozilla.com/D987654",
            status: "status-review",
            statusName: "Needs Review",
            title: "Bug 123456 - Fix thing",
          },
        ],
      }),
    }),
    /Only accepted Phabricator patches/,
  );

  assert.deepEqual(updates, []);
});

test("buildGraphCommitMessage uses a Bug branch prefix and reviewer pills", () => {
  assert.equal(
    buildGraphCommitMessage({
      branch: "Bug-1234567_2",
      summary: "Fix calendar keyboard handling",
      reviewers: [
        "aleca!",
        { value: "#thunderbird-front-end-reviewers", blocking: true },
        "aleca",
      ],
    }),
    "Bug 1234567 - Fix calendar keyboard handling. r=aleca!,#thunderbird-front-end-reviewers!",
  );
  assert.equal(
    buildGraphCommitMessage({
      branch: "topic",
      bugId: "7654321",
      summary: "Fix account setup",
      reviewers: "#mail-reviewers",
    }),
    "Bug 7654321 - Fix account setup. r=#mail-reviewers",
  );
  assert.deepEqual(
    normalizeGraphCommitReviewers([
      "r=aleca",
      " #mail-reviewers! ",
      "#mail-reviewers",
    ]),
    ["aleca", "#mail-reviewers!"],
  );
  assert.deepEqual(
    normalizeGraphCommitReviewers(["aleca!", "#calendar-reviewers!"]),
    ["aleca!", "#calendar-reviewers!"],
  );
  assert.throws(
    () => buildGraphCommitMessage({ branch: "topic", summary: "Fix thing" }),
    /Bugzilla bug ID is required/,
  );
});

test("searchGraphCommitReviewers skips short reviewer queries", async () => {
  let calls = 0;
  const reviewers = await searchGraphCommitReviewers({
    query: "ma",
    phab: async () => {
      calls += 1;
      return {};
    },
  });

  assert.deepEqual(reviewers, []);
  assert.equal(calls, 0);
});

test("searchGraphCommitReviewers searches users for plain reviewer queries", async () => {
  const calls = [];
  const reviewers = await searchGraphCommitReviewers({
    query: "front!",
    phab: async (request) => {
      calls.push(request);

      assert.equal(request.route, "user.search");
      return {
        result: {
          data: [
            {
              phid: "PHID-USER-aleca",
              fields: {
                username: "frontuser",
                realName: "Frontend Alice",
              },
            },
          ],
        },
      };
    },
  });

  assert.deepEqual(
    calls.map((call) => [call.route, call.params]),
    [["user.search", { constraints: { query: "front" }, limit: 30 }]],
  );
  assert.deepEqual(reviewers, [
    {
      type: "user",
      value: "frontuser",
      label: "frontuser",
      description: "Frontend Alice",
      phid: "PHID-USER-aleca",
    },
  ]);
});

test("searchGraphCommitReviewers returns no suggestions when the user route is rate limited", async () => {
  const calls = [];
  const reviewers = await searchGraphCommitReviewers({
    query: "mail",
    phab: async (request) => {
      calls.push(request.route);
      throw new Error(`Phabricator ${request.route} failed (429): {}`);
    },
  });

  assert.deepEqual(calls, ["user.search"]);
  assert.deepEqual(reviewers, []);
});

test("searchGraphCommitReviewers skips user lookup for group queries", async () => {
  const calls = [];
  const reviewers = await searchGraphCommitReviewers({
    query: "#mail!",
    phab: async (request) => {
      calls.push(request.route);

      return {
        result: {
          data: [
            {
              phid: "PHID-PROJ-mail",
              fields: {
                slug: "mail-reviewers",
                name: "Mail Reviewers",
              },
            },
          ],
        },
      };
    },
  });

  assert.deepEqual(calls, ["project.search"]);
  assert.deepEqual(
    reviewers.map((reviewer) => reviewer.value),
    ["#mail-reviewers"],
  );
});

test("searchGraphCommitReviewers returns no suggestions when the group route is rate limited", async () => {
  const calls = [];
  const reviewers = await searchGraphCommitReviewers({
    query: "#mail",
    phab: async (request) => {
      calls.push(request.route);
      throw new Error(`Phabricator ${request.route} failed (429): {}`);
    },
  });

  assert.deepEqual(calls, ["project.search"]);
  assert.deepEqual(reviewers, []);
});

test("createGraphCommit stages changes and commits with generated message", async () => {
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "Bug-1234567_2",
  };
  const result = await createGraphCommit({
    graph,
    options: {
      summary: "Fix message list focus",
      reviewers: ["aleca", "#mail-reviewers"],
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.args.join(" ") === "branch --show-current") {
        return "Bug-1234567_2\n";
      }

      if (
        command.args.join(" ") ===
        "commit -m Bug 1234567 - Fix message list focus. r=aleca,#mail-reviewers"
      ) {
        return "[Bug-1234567_2 def456] Bug 1234567 - Fix message list focus. r=aleca,#mail-reviewers\n";
      }

      if (command.args.join(" ") === "rev-parse HEAD") {
        return "def4567890abcdef\n";
      }

      return "";
    },
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["branch", "--show-current"],
      ["add", "-A"],
      [
        "commit",
        "-m",
        "Bug 1234567 - Fix message list focus. r=aleca,#mail-reviewers",
      ],
      ["rev-parse", "HEAD"],
    ],
  );
  assert.equal(result.hash, "def4567890abcdef");
  assert.equal(
    result.commitMessage,
    "Bug 1234567 - Fix message list focus. r=aleca,#mail-reviewers",
  );
  assert.equal(result.message, "comm created commit def4567890ab.");
});

test("getGraphCommitMetadata requires a bug input outside Bug branches", async () => {
  const metadata = await getGraphCommitMetadata({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    runCommand: async () => "topic\n",
  });

  assert.deepEqual(metadata, {
    label: "comm",
    path: "/repo/comm",
    branch: "topic",
    bugId: "",
    bugRequired: true,
    prefix: "",
  });
});

test("amendCurrentCommit stages shown changes and amends with an edited message", async () => {
  const calls = [];
  const writes = [];
  const removes = [];
  const result = await amendCurrentCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    message: "Bug 123 - Better message. r=#reviewers\n\nUpdated body.",
    includeChanges: true,
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "diff") {
        return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "branch") {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Better message. r=#reviewers\n\nUpdated body.\n";
      }

      return "";
    },
    writeMessage: async (file, content) => writes.push({ file, content }),
    removeMessage: async (file) => removes.push(file),
  });

  assert.equal(result.message, "comm amended current commit def456.");
  assert.equal(result.branch, "topic");
  assert.equal(result.currentHash, "def456");
  assert.match(writes[0].file, /tb-tools-amend-[^.]+\.txt$/);
  assert.equal(
    writes[0].content,
    "Bug 123 - Better message. r=#reviewers\n\nUpdated body.\n",
  );
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        "diff",
        "--patch",
        "--find-renames",
        "--no-ext-diff",
        "--no-color",
        "HEAD",
      ],
      ["ls-files", "--others", "--exclude-standard", "-z"],
      ["add", "-A"],
      ["commit", "--amend", "-F", writes[0].file],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["log", "-1", "--format=%B", "def456"],
    ],
  );
});

test("amendCurrentCommit can update only the commit message without staging dirty files", async () => {
  const calls = [];
  const writes = [];
  const removes = [];
  const result = await amendCurrentCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    message: "Bug 123 - Message only. r=#reviewers",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Message only. r=#reviewers\n";
      }

      return "";
    },
    writeMessage: async (file, content) => writes.push({ file, content }),
    removeMessage: async (file) => removes.push(file),
  });

  assert.equal(result.message, "comm amended current commit def456.");
  assert.equal(result.branch, "topic");
  assert.equal(result.currentHash, "def456");
  assert.equal(result.rewrittenHash, "def456");
  assert.equal(writes[0].content, "Bug 123 - Message only. r=#reviewers\n");
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["commit", "--amend", "--only", "-F", writes[0].file],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["log", "-1", "--format=%B", "def456"],
    ],
  );
});

test("amendCommitMessage rewrites a selected commit message and replays descendants", async () => {
  const calls = [];
  const writes = [];
  const removes = [];
  let revParseCount = 0;
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "topic",
    knownHashes: new Set(["abc123", "def456", "fed789"]),
  };
  const result = await amendCommitMessage({
    graph,
    hash: "abc123",
    message: "Bug 123 - Reword selected commit. r=#reviewers",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        revParseCount += 1;
        if (revParseCount === 1) {
          return "fed789\n";
        }
        if (revParseCount === 2) {
          return "newabc999\n";
        }
        return "newtip999\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        return "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "topic\n";
      }

      if (
        command.args[0] === "rev-list" &&
        command.args.includes("--parents")
      ) {
        return "abc123 parent000\n";
      }

      if (
        command.args[0] === "rev-list" &&
        command.args.includes("--ancestry-path")
      ) {
        return "def456\nfed789\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Reword selected commit. r=#reviewers\n";
      }

      return "";
    },
    writeMessage: async (file, content) => writes.push({ file, content }),
    removeMessage: async (file) => removes.push(file),
  });

  assert.equal(
    result.message,
    "comm amended message for abc123 and replayed 2 descendant commits on branch topic.",
  );
  assert.equal(result.branch, "topic");
  assert.equal(result.currentHash, "newtip999");
  assert.equal(result.rewrittenHash, "newabc999");
  assert.equal(result.amendedCount, 3);
  assert.deepEqual(result.commits, ["abc123", "def456", "fed789"]);
  assert.equal(graph.branch, "topic");
  assert.match(writes[0].file, /tb-tools-amend-[^.]+\.txt$/);
  assert.equal(
    writes[0].content,
    "Bug 123 - Reword selected commit. r=#reviewers\n",
  );
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "abc123..topic",
      ],
      ["switch", "--detach", "parent000"],
      ["cherry-pick", "--no-commit", "abc123"],
      ["commit", "-C", "abc123"],
      ["commit", "--amend", "--only", "-F", writes[0].file],
      ["rev-parse", "HEAD"],
      ["log", "-1", "--format=%B", "newabc999"],
      ["cherry-pick", "--no-commit", "def456"],
      ["commit", "-C", "def456"],
      ["cherry-pick", "--no-commit", "fed789"],
      ["commit", "-C", "fed789"],
      ["rev-parse", "HEAD"],
      ["branch", "-f", "topic", "newtip999"],
      ["switch", "topic"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("amendCurrentCommit refuses when the shown working tree diff is stale", async () => {
  await assert.rejects(
    amendCurrentCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
      },
      message: "Bug 123 - Better message. r=#reviewers",
      expectedChangeId: "different",
      includeChanges: true,
      runCommand: async (command) => {
        if (command.args[0] === "diff") {
          return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
        }

        return "";
      },
      writeMessage: async () => {
        throw new Error("stale amend should not write a commit message");
      },
    }),
    /Working tree changed since this diff was loaded/,
  );
});

test("getCheckoutGraphData collects git log data for a checkout", async () => {
  const commands = [];
  const data = await getCheckoutGraphData({
    label: "comm",
    cwd: ".",
    limit: 12,
    runCommand: async (command) => {
      commands.push(command);

      if (command.args[0] === "rev-parse") {
        return "/repo/comm\n";
      }

      if (command.args[0] === "branch") {
        return "Bug-1234567\n";
      }

      if (command.args[0] === "show") {
        return "diff --git a/file b/file\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "\x1eabc123\x1f\x1fHEAD -> Bug-1234567\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
    },
  });

  assert.equal(data.label, "comm");
  assert.equal(data.path, "/repo/comm");
  assert.equal(data.branch, "Bug-1234567");
  assert.equal(data.commitCount, 1);
  assert.equal(data.workingTreeCount, 0);
  assert.match(data.diffs.abc123.text, /diff --git/);
  assert.equal(commands[2].args.includes("--max-count=12"), true);
  assert.equal(
    commands.some((command) => command.args[0] === "show"),
    true,
  );
});

test("getCheckoutGraphMetadata collects checkout identity without commits", async () => {
  const commands = [];
  const data = await getCheckoutGraphMetadata({
    label: "firefox",
    cwd: "..",
    runCommand: async (command) => {
      commands.push(command);

      if (command.args[0] === "rev-parse") {
        return "/repo/firefox\n";
      }

      return "main\n";
    },
  });

  assert.equal(data.label, "firefox");
  assert.equal(data.path, "/repo/firefox");
  assert.equal(data.branch, "main");
  assert.deepEqual(data.commits, []);
  assert.equal(commands.length, 2);
});

test("getCheckoutCommitPage collects a page of commits without pruning parents", async () => {
  const commands = [];
  const page = await getCheckoutCommitPage({
    cwd: "/repo/comm",
    offset: 20,
    limit: 10,
    runCommand: async (command) => {
      commands.push(command);
      return "\x1eabc123\x1fmissing-parent\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
    },
  });

  assert.equal(page.offset, 20);
  assert.equal(page.nextOffset, 21);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.commits[0].parents, ["missing-parent"]);
  assert.equal(commands[0].args.includes("--skip=20"), true);
  assert.equal(commands[0].args.includes("--max-count=10"), true);
});

test("getCheckoutCommitPage inserts one uncommitted item above HEAD and keeps later offsets aligned", async () => {
  const firstCommands = [];
  const firstPage = await getCheckoutCommitPage({
    cwd: "/repo/comm",
    offset: 0,
    limit: 10,
    includeWorkingTree: true,
    runCommand: async (command) => {
      firstCommands.push(command);

      if (command.args[0] === "diff") {
        return "diff --git a/file b/file\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return "head123\n";
      }

      return [
        "\x1enewer123\x1f\x1forigin/main\x1fAlice\x1falice@example.com\x1f1710000100\x1fNewer upstream thing\n",
        "\x1ehead123\x1fparent123\x1fHEAD -> topic\x1fAlice\x1falice@example.com\x1f1710000000\x1fChecked out thing\n",
      ].join("");
    },
  });

  assert.equal(firstPage.commits.length, 3);
  assert.equal(firstPage.commits[0].hash, "newer123");
  assert.equal(firstPage.commits[1].subject, "Uncommitted changes");
  assert.deepEqual(firstPage.commits[1].parents, ["head123"]);
  assert.equal(firstPage.commits[2].hash, "head123");
  assert.equal(firstPage.nextOffset, 3);
  assert.equal(firstPage.workingTreeCount, 1);
  assert.equal(firstPage.hasMore, false);
  assert.equal(
    firstCommands.some(
      (command) =>
        command.args[0] === "rev-parse" && command.args[1] === "HEAD",
    ),
    true,
  );

  const nextCommands = [];
  await getCheckoutCommitPage({
    cwd: "/repo/comm",
    offset: firstPage.nextOffset,
    limit: 10,
    includeWorkingTree: true,
    workingTreeCount: firstPage.workingTreeCount,
    runCommand: async (command) => {
      nextCommands.push(command);
      return "";
    },
  });

  assert.equal(nextCommands[0].args.includes("--skip=2"), true);
  assert.equal(
    nextCommands.some((command) => command.args[0] === "diff"),
    false,
  );
});

test("checkoutCommit checks out loaded commits only when the tree is clean", async () => {
  const calls = [];
  const result = await checkoutCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "";
    },
  });

  assert.equal(result.message, "comm checked out abc123 as detached HEAD.");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      ["switch", "--detach", "abc123"],
    ],
  );
});

test("checkoutCommit switches to a local branch when the commit is a branch tip", async () => {
  const calls = [];
  const result = await checkoutCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "for-each-ref") {
        return "topic\nmain\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm checked out branch main at abc123.");
  assert.equal(result.branch, "main");
  assert.equal(result.detached, false);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      ["switch", "main"],
    ],
  );
});

test("createBranchForCommit creates a Bug branch at the selected commit", async () => {
  const calls = [];
  const result = await createBranchForCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "log") {
        return "Bug 1234567 - Fix selected history\n\nBody text.\n";
      }

      if (command.args[0] === "for-each-ref") {
        return "main\nBug-1234567\nBug-1234567_2\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm created branch Bug-1234567_3 at abc123.");
  assert.equal(result.createdBranch, "Bug-1234567_3");
  assert.equal(result.hash, "abc123");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["log", "-1", "--format=%B", "abc123"],
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      ["branch", "Bug-1234567_3", "abc123"],
    ],
  );
});

test("createBranchForCommit requires a Bug number in the selected commit", async () => {
  await assert.rejects(
    createBranchForCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async () => "No bug - Fix selected history\n",
    }),
    /No Bugzilla bug number found in abc123/,
  );
});

test("rebaseCommit rebases a selected local branch tip onto the current checkout", async () => {
  const calls = [];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        return "topic\n";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "base123\n"
          : "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased branch topic onto base123.");
  assert.equal(result.branch, "topic");
  assert.equal(result.base, "base123");
  assert.deepEqual(result.commits, ["abc123"]);
  assert.equal(result.rebasedCount, 1);
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.detached, false);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "abc123..topic",
      ],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "origin/main..abc123",
      ],
      ["merge-base", "--is-ancestor", "abc123", "origin/main"],
      ["switch", "--detach", "base123"],
      ["cherry-pick", "--no-commit", "abc123"],
      ["commit", "-C", "abc123"],
      ["rev-parse", "HEAD"],
      ["branch", "-f", "topic", "rebased456"],
      ["switch", "topic"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("rebaseCommit rebases a selected commit onto the current checkout without a branch tip", async () => {
  const calls = [];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch" || command.args[0] === "for-each-ref") {
        return "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "base123\n"
          : "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased abc123 onto base123.");
  assert.equal(result.branch, "");
  assert.equal(result.base, "base123");
  assert.deepEqual(result.commits, ["abc123"]);
  assert.equal(result.rebasedCount, 1);
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.detached, true);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "origin/main..abc123",
      ],
      ["merge-base", "--is-ancestor", "abc123", "origin/main"],
      ["switch", "--detach", "base123"],
      ["cherry-pick", "--no-commit", "abc123"],
      ["commit", "-C", "abc123"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("rebaseCommit rebases a selected commit and descendants in order", async () => {
  const calls = [];
  const rewrittenHashes = ["base123", "rebased111", "rebased222", "rebased999", "rebased999"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return hash === "ghi789" ? "topic\n" : "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "topic\n";
      }

      if (command.args[0] === "rev-list") {
        return "def456\nghi789\n";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(
    result.message,
    "comm rebased branch topic (3 commits) onto main.",
  );
  assert.equal(result.branch, "topic");
  assert.equal(result.base, "base123");
  assert.deepEqual(result.commits, ["abc123", "def456", "ghi789"]);
  assert.equal(result.rebasedCount, 3);
  assert.equal(result.currentHash, "rebased999");
  assert.equal(result.detached, false);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "abc123..topic",
      ],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "origin/main..abc123",
      ],
      ["merge-base", "--is-ancestor", "abc123", "origin/main"],
      ["merge-base", "--is-ancestor", "def456", "origin/main"],
      ["merge-base", "--is-ancestor", "ghi789", "origin/main"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "def456",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "ghi789",
        "refs/heads",
      ],
      ["switch", "--detach", "base123"],
      ["cherry-pick", "--no-commit", "abc123"],
      ["commit", "-C", "abc123"],
      ["rev-parse", "HEAD"],
      ["cherry-pick", "--no-commit", "def456"],
      ["commit", "-C", "def456"],
      ["rev-parse", "HEAD"],
      ["cherry-pick", "--no-commit", "ghi789"],
      ["commit", "-C", "ghi789"],
      ["rev-parse", "HEAD"],
      ["branch", "-f", "topic", "rebased999"],
      ["switch", "topic"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("rebaseCommit descendants mode replays a selected tip from the stack base", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new222", "new333", "new333"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["c333"]),
    },
    hash: "c333",
    preferredBranch: "Bug-102",
    rebaseMode: "descendants",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-102\n";
      }

      if (
        command.args[0] === "rev-list" &&
        command.args.at(-1) === "origin/main..c333"
      ) {
        return "a111\nb222\nc333\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "c333..Bug-102": "",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.mode, "descendants");
  assert.equal(result.branch, "Bug-102");
  assert.deepEqual(result.commits, ["a111", "b222", "c333"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new222" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["cherry-pick", "--no-commit", "c333"],
    ],
  );
});

test("rebaseCommit moves child branch tips when rebasing the bottom commit", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new222", "new333", "new333"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["a111"]),
    },
    hash: "a111",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\nBug-101\nBug-102\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "a111..Bug-100": "",
          "a111..Bug-101": "b222\n",
          "a111..Bug-102": "b222\nc333\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased branch Bug-102 (3 commits) onto main.");
  assert.equal(result.branch, "Bug-102");
  assert.deepEqual(result.commits, ["a111", "b222", "c333"]);
  assert.deepEqual(result.rewrittenCommits, [
    { originalHash: "a111", hash: "new111" },
    { originalHash: "b222", hash: "new222" },
    { originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new222" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "branch" && call.args[1] === "-f")
      .map((call) => call.args),
    [
      ["branch", "-f", "Bug-100", "new111"],
      ["branch", "-f", "Bug-101", "new222"],
      ["branch", "-f", "Bug-102", "new333"],
    ],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["cherry-pick", "--no-commit", "c333"],
    ],
  );
});

test("rebaseCommit uses the selected branch hint for equal length stacks", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new444", "new555", "new555"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["a111"]),
    },
    hash: "a111",
    preferredBranch: "Bug-202",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
          d444: "Bug-201\n",
          e555: "Bug-202\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\nBug-102\nBug-202\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "a111..Bug-100": "",
          "a111..Bug-102": "b222\nc333\n",
          "a111..Bug-202": "d444\ne555\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased branch Bug-202 (3 commits) onto main.");
  assert.equal(result.branch, "Bug-202");
  assert.deepEqual(result.commits, ["a111", "d444", "e555"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-201", originalHash: "d444", hash: "new444" },
    { branch: "Bug-202", originalHash: "e555", hash: "new555" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "d444"],
      ["cherry-pick", "--no-commit", "e555"],
    ],
  );
});

test("rebaseCommit ignores a shorter per-commit branch hint", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new222", "new333", "new333"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["a111"]),
    },
    hash: "a111",
    preferredBranch: "Bug-101",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\nBug-101\nBug-102\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "a111..Bug-100": "",
          "a111..Bug-101": "b222\n",
          "a111..Bug-102": "b222\nc333\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.branch, "Bug-102");
  assert.deepEqual(result.commits, ["a111", "b222", "c333"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new222" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["cherry-pick", "--no-commit", "c333"],
    ],
  );
});

test("rebaseCommit selected mode ignores ambiguous descendant stacks", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new111"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["a111"]),
    },
    hash: "a111",
    preferredBranch: "Bug-100",
    rebaseMode: "selected",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        return "Bug-100\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\nBug-102\nBug-202\n";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.mode, "selected");
  assert.equal(result.branch, "Bug-100");
  assert.deepEqual(result.commits, ["a111"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "rev-list")
      .map((call) => call.args),
    [],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [["cherry-pick", "--no-commit", "a111"]],
  );
});

test("rebaseCommit children mode preserves the selected stack path", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new222", "new333", "new333"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["a111"]),
    },
    hash: "a111",
    preferredBranch: "Bug-102",
    rebaseMode: "children",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\nBug-101\nBug-102\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "a111..Bug-100": "",
          "a111..Bug-101": "b222\n",
          "a111..Bug-102": "b222\nc333\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.mode, "children");
  assert.equal(result.branch, "Bug-102");
  assert.deepEqual(result.commits, ["a111", "b222", "c333"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new222" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["cherry-pick", "--no-commit", "c333"],
    ],
  );
});

test("rebaseCommit children mode preserves a branch-per-commit Thunderbird stack", async () => {
  const calls = [];
  const commits = Array.from({ length: 9 }, (_, index) =>
    "c" + String(index + 1).padStart(3, "0"),
  );
  const branchByCommit = new Map(
    commits.map((commit, index) => [commit, `Bug-${101 + index}`]),
  );
  const rewrittenByCommit = new Map(
    commits.map((commit, index) => [
      commit,
      "new" + String(index + 1).padStart(3, "0"),
    ]),
  );
  const rewrittenHashes = [
    "base000",
    ...commits.map((commit) => rewrittenByCommit.get(commit)),
    rewrittenByCommit.get(commits.at(-1)),
  ];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set([commits[0]]),
    },
    hash: commits[0],
    preferredBranch: branchByCommit.get(commits[0]),
    rebaseMode: "children",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];

        return branchByCommit.has(hash) ? branchByCommit.get(hash) + "\n" : "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return Array.from(branchByCommit.values()).join("\n") + "\n";
      }

      if (
        command.args[0] === "rev-list" &&
        command.args.at(-1) === `origin/main..${commits[0]}`
      ) {
        return commits[0] + "\n";
      }

      if (command.args[0] === "rev-list") {
        const range = command.args.at(-1);
        const branch = range.slice(range.indexOf("..") + 2);
        const targetIndex = Array.from(branchByCommit.values()).indexOf(branch);

        return targetIndex === -1
          ? ""
          : commits.slice(1, targetIndex + 1).join("\n") + "\n";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.mode, "children");
  assert.equal(result.branch, branchByCommit.get(commits.at(-1)));
  assert.deepEqual(result.commits, commits);
  assert.deepEqual(
    result.branchUpdates,
    commits.map((commit) => ({
      branch: branchByCommit.get(commit),
      originalHash: commit,
      hash: rewrittenByCommit.get(commit),
    })),
  );
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    commits.map((commit) => ["cherry-pick", "--no-commit", commit]),
  );
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "branch" && call.args[1] === "-f")
      .map((call) => call.args),
    commits.map((commit) => [
      "branch",
      "-f",
      branchByCommit.get(commit),
      rewrittenByCommit.get(commit),
    ]),
  );
});

test("rebaseCommit skips an empty cherry-pick and keeps rebasing descendants", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new111", "new111", "new333", "new333"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["a111"]),
    },
    hash: "a111",
    rebaseMode: "children",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\nBug-101\nBug-102\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "origin/main..a111": "a111\n",
          "a111..Bug-100": "",
          "a111..Bug-101": "b222\n",
          "a111..Bug-102": "b222\nc333\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "cherry-pick" && command.args[2] === "b222") {
        const error = new Error("The previous cherry-pick is now empty.");
        error.stderr = "The previous cherry-pick is now empty.";
        throw error;
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.rebasedCount, 2);
  assert.deepEqual(result.skippedMainCommits, ["b222"]);
  assert.deepEqual(result.rewrittenCommits, [
    { originalHash: "a111", hash: "new111" },
    { originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new111" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["cherry-pick", "--abort"],
      ["cherry-pick", "--no-commit", "c333"],
    ],
  );
});

test("rebaseCommit reports conflicts without restoring the checkout", async () => {
  const calls = [];
  let rejectedError;

  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["a111"]),
      },
      hash: "a111",
      graphIndex: 0,
      rebaseMode: "children",
      runCommand: async (command) => {
        calls.push(command);

        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "branch" && command.args[1] === "--show-current") {
          return "main\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--points-at")
        ) {
          return "Bug-100\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--contains")
        ) {
          return "Bug-100\n";
        }

        if (command.args[0] === "rev-list") {
          return command.args.at(-1) === "origin/main..a111" ? "a111\n" : "";
        }

        if (command.args[0] === "merge-base") {
          throw new Error("not on main");
        }

        if (command.args[0] === "rev-parse") {
          return "base000\n";
        }

        if (command.args[0] === "diff" && command.args.includes("--diff-filter=U")) {
          return "mail/conflicted.js\n";
        }

        if (command.args[0] === "cherry-pick" && command.args[1] === "--no-commit") {
          const error = new Error("CONFLICT");
          error.stderr = "CONFLICT (content): Merge conflict";
          throw error;
        }

        return "";
      },
    }),
    (error) => {
      rejectedError = error;
      return /Rebase conflict/.test(error.message);
    },
  );

  assert.equal(rejectedError.rebaseConflict.type, "conflict");
  assert.equal(rejectedError.rebaseConflict.graphIndex, 0);
  assert.equal(rejectedError.rebaseConflict.conflictCommit, "a111");
  assert.deepEqual(rejectedError.rebaseConflict.files, [
    {
      path: "mail/conflicted.js",
      absolutePath: "/repo/comm/mail/conflicted.js",
    },
  ]);
  assert.deepEqual(
    calls
      .filter((call) =>
        call.args[0] === "switch" ||
        call.args[0] === "cherry-pick" ||
        call.args[0] === "reset"
      )
      .map((call) => call.args),
    [
      ["switch", "--detach", "base000"],
      ["cherry-pick", "--no-commit", "a111"],
    ],
  );
});

test("continueRebaseCommit blocks conflict markers before staging", async () => {
  const calls = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-conflict-"));
  const conflictPath = path.join(tempDir, "mail", "conflicted.js");
  const resolvedPath = path.join(tempDir, "mail", "resolved.js");
  let session;

  await mkdir(path.dirname(conflictPath), { recursive: true });
  await writeFile(
    conflictPath,
    "<<<<<<< ours\nold\n=======\nnew\n>>>>>>> theirs\n",
  );
  await writeFile(resolvedPath, "resolved\n");

  try {
    session = {
      id: "session-1",
      graph: {
        label: "comm",
        path: tempDir,
      },
      graphIndex: 0,
      base: { branch: "main", hash: "base000" },
      hash: "a111",
      branch: "Bug-100",
      mode: "children",
      stackCommits: ["a111"],
      stackBranchRefs: [{ hash: "a111", branches: ["Bug-100"] }],
      skippedMainCommits: [],
      rewrittenCommits: [],
      skippedReplayedCommits: [],
      conflictCommit: "a111",
      conflictIndex: 0,
      conflictFiles: ["mail/conflicted.js", "mail/resolved.js"],
    };

    await assert.rejects(
      continueRebaseCommit({
        session,
        runCommand: async (command) => {
          calls.push(command);
          return "";
        },
      }),
      (error) => {
        assert.equal(error.rebaseConflict.reason, "conflict-markers");
        assert.deepEqual(
          error.rebaseConflict.files.map((file) => file.path),
          ["mail/conflicted.js"],
        );
        assert.deepEqual(
          error.rebaseConflict.markerFiles.map((file) => file.path),
          ["mail/conflicted.js"],
        );
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    session.conflictFiles,
    ["mail/conflicted.js", "mail/resolved.js"],
    "Marker failures should not narrow the stored conflict set.",
  );
  assert.deepEqual(
    calls.map((call) => call.args),
    [],
    "Continue must not stage files while conflict markers remain.",
  );
});

test("continueRebaseCommit commits the resolved conflict and resumes the stack", async () => {
  const calls = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-conflict-"));
  const conflictPath = path.join(tempDir, "mail", "conflicted.js");
  const rewrittenHashes = ["new111", "new222", "new222"];
  const result = await (async () => {
    await mkdir(path.dirname(conflictPath), { recursive: true });
    await writeFile(conflictPath, "resolved\n");

    try {
      return await continueRebaseCommit({
        session: {
          id: "session-1",
          graph: {
            label: "comm",
            path: tempDir,
          },
          graphIndex: 0,
          base: { branch: "main", hash: "base000" },
          hash: "a111",
          branch: "Bug-101",
          mode: "children",
          stackCommits: ["a111", "b222"],
          stackBranchRefs: [
            { hash: "a111", branches: ["Bug-100"] },
            { hash: "b222", branches: ["Bug-101"] },
          ],
          skippedMainCommits: [],
          rewrittenCommits: [],
          skippedReplayedCommits: [],
          conflictCommit: "a111",
          conflictIndex: 0,
          conflictFiles: ["mail/conflicted.js"],
        },
        runCommand: async (command) => {
          calls.push(command);

          if (command.args[0] === "diff" && command.args.includes("--diff-filter=U")) {
            return "";
          }

          if (command.args[0] === "rev-parse") {
            return `${rewrittenHashes.shift()}\n`;
          }

          return "";
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  })();

  assert.deepEqual(result.rewrittenCommits, [
    { originalHash: "a111", hash: "new111" },
    { originalHash: "b222", hash: "new222" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) =>
        call.args[0] === "add" ||
        call.args[0] === "commit" ||
        call.args[0] === "cherry-pick" ||
        (call.args[0] === "branch" && call.args[1] === "-f") ||
        call.args[0] === "switch"
      )
      .map((call) => call.args),
    [
      ["add", "-A", "--", "mail/conflicted.js"],
      ["commit", "-C", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["commit", "-C", "b222"],
      ["branch", "-f", "Bug-100", "new111"],
      ["branch", "-f", "Bug-101", "new222"],
      ["switch", "Bug-101"],
    ],
  );
});

test("rebaseCommit restores the original checkout after a non-conflict replay failure", async () => {
  const calls = [];

  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["a111"]),
      },
      hash: "a111",
      rebaseMode: "children",
      runCommand: async (command) => {
        calls.push(command);

        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "branch" && command.args[1] === "--show-current") {
          return "main\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--points-at")
        ) {
          return "Bug-100\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--contains")
        ) {
          return "Bug-100\n";
        }

        if (command.args[0] === "rev-list") {
          return command.args.at(-1) === "origin/main..a111" ? "a111\n" : "";
        }

        if (command.args[0] === "merge-base") {
          throw new Error("not on main");
        }

        if (command.args[0] === "rev-parse") {
          return "base000\n";
        }

        if (command.args[0] === "cherry-pick" && command.args[1] === "--no-commit") {
          const error = new Error("fatal: bad object");
          error.stderr = "fatal: bad object";
          throw error;
        }

        return "";
      },
    }),
    /fatal: bad object/,
  );

  assert.deepEqual(
    calls
      .filter((call) =>
        call.args[0] === "switch" ||
        call.args[0] === "cherry-pick" ||
        call.args[0] === "reset"
      )
      .map((call) => call.args),
    [
      ["switch", "--detach", "base000"],
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--abort"],
      ["reset", "--hard"],
      ["switch", "main"],
    ],
  );
});

test("rebaseCommit stack mode prepends unpublished ancestors and skips main commits", async () => {
  const calls = [];
  const rewrittenHashes = ["base000", "new000", "new111", "new222", "new222"];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["b222"]),
    },
    hash: "b222",
    preferredBranch: "Bug-102",
    rebaseMode: "stack",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];
        return {
          a111: "Bug-100\n",
          b222: "Bug-101\n",
          c333: "Bug-102\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-101\nBug-102\n";
      }

      if (
        command.args[0] === "rev-list" &&
        command.args.at(-1) === "origin/main..b222"
      ) {
        return "root000\na111\nb222\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "b222..Bug-101": "",
          "b222..Bug-102": "c333\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        if (command.args[2] === "c333") {
          return "";
        }

        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return `${rewrittenHashes.shift()}\n`;
      }

      return "";
    },
  });

  assert.equal(result.mode, "stack");
  assert.equal(result.branch, "Bug-101");
  assert.deepEqual(result.commits, ["root000", "a111", "b222"]);
  assert.deepEqual(result.skippedMainCommits, ["c333"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new222" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "root000"],
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
    ],
  );
});

test("rebaseCommit rejects equal length stacks without a matching branch hint", async () => {
  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["a111"]),
      },
      hash: "a111",
      preferredBranch: "Bug-999",
      runCommand: async (command) => {
        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "branch") {
          return "main\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--points-at")
        ) {
          return "Bug-100\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--contains")
        ) {
          return "Bug-100\nBug-102\nBug-202\n";
        }

        if (command.args[0] === "rev-list") {
          return {
            "a111..Bug-100": "",
            "a111..Bug-102": "b222\nc333\n",
            "a111..Bug-202": "d444\ne555\n",
          }[command.args.at(-1)] || "";
        }

        if (command.args[0] === "merge-base") {
          throw new Error("not on main");
        }

        if (command.args[0] === "rev-parse") {
          return "base000\n";
        }

        return "";
      },
    }),
    /multiple descendant branch stacks \(Bug-102, Bug-202\)/,
  );
});

test("rebaseCommit refuses to rebase the current checkout onto itself", async () => {
  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "(detached)",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async (command) => {
        if (command.args[0] === "status" || command.args[0] === "branch") {
          return "";
        }

        if (command.args[0] === "rev-parse") {
          return "abc123\n";
        }

        return "";
      },
    }),
    /already checked out/,
  );
});

test("rebaseCommit refuses when the current checkout is inside the selected stack", async () => {
  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async (command) => {
        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "branch") {
          return "main\n";
        }

        if (command.args[0] === "rev-parse") {
          return "def456\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--points-at")
        ) {
          return "";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--contains")
        ) {
          return "main\n";
        }

        if (command.args[0] === "rev-list") {
          return "def456\n";
        }

        if (command.args[0] === "merge-base") {
          throw new Error("not on main");
        }

        return "";
      },
    }),
    /current checkout is inside the selected commit stack/,
  );
});

test("updateGraphCheckout switches to updated main for plain updates", async () => {
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "topic",
  };
  const result = await updateGraphCheckout({
    graph,
    mode: "update",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "updated123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm updated main from origin/main.");
  assert.equal(result.branch, "main");
  assert.equal(result.currentHash, "updated123");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["fetch", "origin", "main"],
      ["switch", "main"],
      ["pull", "--ff-only", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("updateGraphCheckout rebases local branch commits onto origin main", async () => {
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "topic",
  };
  const result = await updateGraphCheckout({
    graph,
    mode: "rebase",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "topic\n";
      }

      if (command.args[0] === "rev-list") {
        return "root111\nchild222\n";
      }

      if (command.args[0] === "rev-parse") {
        return "rebased333\n";
      }

      return "";
    },
  });

  assert.equal(
    result.message,
    "comm fetched origin/main and rebased 2 local commits.",
  );
  assert.equal(result.branch, "topic");
  assert.equal(result.rebasedCount, 2);
  assert.deepEqual(result.commits, ["root111", "child222"]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["fetch", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-list", "--reverse", "--topo-order", "origin/main..topic"],
      ["rebase", "--update-refs", "origin/main", "topic"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("updateGraphCheckout rebases the containing branch for a detached checkout", async () => {
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "(detached)",
  };
  const result = await updateGraphCheckout({
    graph,
    mode: "rebase",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return calls.filter((call) => call.args[0] === "branch").length === 1
          ? ""
          : "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "current123\n"
          : "rebased333\n";
      }

      if (command.args[0] === "for-each-ref") {
        return "topic\n";
      }

      if (command.args[0] === "rev-list") {
        return "current123\nchild222\n";
      }

      return "";
    },
  });

  assert.equal(result.branch, "topic");
  assert.equal(result.rebasedCount, 2);
  assert.deepEqual(result.commits, ["current123", "child222"]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["fetch", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "current123",
        "refs/heads",
      ],
      ["rev-list", "--reverse", "--topo-order", "origin/main..topic"],
      ["rebase", "--update-refs", "origin/main", "topic"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("runGraphRepositoryUpdate reports dirty checkouts before changing anything", async () => {
  const calls = [];
  const graphs = [
    {
      label: "comm",
      path: "/repo/comm",
    },
  ];

  await assert.rejects(
    runGraphRepositoryUpdate({
      graphs,
      mode: "update",
      runCommand: async (command) => {
        calls.push(command);
        return " M file.txt\n";
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.dirty, [
        {
          index: 0,
          label: "comm",
          path: "/repo/comm",
          status: "M file.txt",
        },
      ]);
      return /Uncommitted changes/.test(error.message);
    },
  );

  assert.deepEqual(
    calls.map((call) => call.args),
    [["status", "--porcelain"]],
  );
});

test("runGraphRepositoryUpdate can shelf dirty changes before updating", async () => {
  const calls = [];
  const graphs = [
    {
      label: "comm",
      path: "/repo/comm",
    },
  ];
  const result = await runGraphRepositoryUpdate({
    graphs,
    mode: "update",
    dirtyAction: "shelf",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return " M file.txt\n";
      }

      if (command.args[0] === "stash") {
        return "Saved working directory and index state On topic: tb-tools graph update: comm\n";
      }

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "updated123\n";
      }

      return "";
    },
  });

  assert.equal(result.dirtyAction, "shelf");
  assert.equal(result.shelves.length, 1);
  assert.deepEqual(result.shelves[0], {
    graphIndex: 0,
    label: "comm",
    path: "/repo/comm",
    stashRef: "stash@{0}",
    message:
      "Saved working directory and index state On topic: tb-tools graph update: comm",
  });
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      [
        "stash",
        "push",
        "--include-untracked",
        "-m",
        "tb-tools graph update: comm",
      ],
      ["fetch", "origin", "main"],
      ["switch", "main"],
      ["pull", "--ff-only", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("runGraphRepositoryUpdate can amend dirty changes before rebasing", async () => {
  const calls = [];
  const graphs = [
    {
      label: "comm",
      path: "/repo/comm",
    },
  ];
  const result = await runGraphRepositoryUpdate({
    graphs,
    mode: "rebase",
    dirtyAction: "amend",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return " M file.txt\n";
      }

      if (command.args[0] === "branch") {
        return "topic\n";
      }

      if (command.args[0] === "rev-list") {
        return "root111\nchild222\n";
      }

      if (command.args[0] === "rev-parse") {
        return "rebased333\n";
      }

      return "";
    },
  });

  assert.equal(result.dirtyAction, "amend");
  assert.equal(
    result.dirtyResults[0].message,
    "comm amended uncommitted changes into the current commit.",
  );
  assert.equal(result.results[0].rebasedCount, 2);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["add", "-A"],
      ["commit", "--amend", "--no-edit"],
      ["fetch", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-list", "--reverse", "--topo-order", "origin/main..topic"],
      ["rebase", "--update-refs", "origin/main", "topic"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("getGraphOriginMainStatus compares local origin main with remote origin main", async () => {
  const calls = [];
  const result = await getGraphOriginMainStatus({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "rev-parse") {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      }

      if (command.args[0] === "ls-remote") {
        return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/main\n";
      }

      return "";
    },
  });

  assert.equal(result.label, "comm");
  assert.equal(result.branch, "main");
  assert.equal(result.state, "stale");
  assert.equal(result.upToDate, false);
  assert.equal(result.localHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(result.remoteHash, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["rev-parse", "--verify", "refs/remotes/origin/main"],
      ["ls-remote", "--heads", "origin", "main"],
    ],
  );
});

test("getGraphRustUpstreamStatus compares Firefox remote rust files to comm origin main checksums without changing checkouts", async () => {
  const calls = [];
  const removed = [];
  const tempDir = path.join(os.tmpdir(), "rust-upstream-check");
  const remoteFiles = {
    "Cargo.toml": "workspace\n",
    "toolkit/library/rust/shared/Cargo.toml": "gkrust\n",
    "build/workspace-hack/Cargo.toml": "hack\n",
    "Cargo.lock": "remote lock\n",
  };
  const checksumData = {
    mc_workspace_toml: createHash("sha512")
      .update(remoteFiles["Cargo.toml"])
      .digest("hex"),
    mc_gkrust_toml: createHash("sha512")
      .update(remoteFiles["toolkit/library/rust/shared/Cargo.toml"])
      .digest("hex"),
    mc_hack_toml: createHash("sha512")
      .update(remoteFiles["build/workspace-hack/Cargo.toml"])
      .digest("hex"),
    mc_cargo_lock: createHash("sha512").update("old lock\n").digest("hex"),
  };

  const result = await getGraphRustUpstreamStatus({
    graphs: [
      { label: "comm", path: "/repo/comm" },
      { label: "firefox", path: "/repo/firefox" },
    ],
    makeTempDir: async (prefix) => {
      assert.match(prefix, /tb-tools-rust-upstream-/);
      return tempDir;
    },
    removeDir: async (dir, options) => {
      removed.push([dir, options]);
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.cwd === "/repo/comm" && command.args[0] === "rev-parse") {
        return "cccccccccccccccccccccccccccccccccccccccc\n";
      }

      if (command.cwd === "/repo/comm" && command.args[0] === "show") {
        return JSON.stringify(checksumData);
      }

      if (command.cwd === "/repo/firefox" && command.args[0] === "ls-remote") {
        return "ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main\n";
      }

      if (
        command.cwd === "/repo/firefox" &&
        command.args.join(" ") === "remote get-url origin"
      ) {
        return "git@example.com:firefox.git\n";
      }

      if (command.cwd === tempDir && command.args[0] === "init") {
        return "";
      }

      if (command.cwd === tempDir && command.args[0] === "fetch") {
        return "";
      }

      if (command.cwd === tempDir && command.args[0] === "show") {
        return remoteFiles[command.args[1].replace(/^FETCH_HEAD:/, "")];
      }

      throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
    },
  });

  assert.equal(result.type, "rust-upstream");
  assert.equal(result.label, "rust");
  assert.equal(result.state, "warning");
  assert.equal(result.upToDate, false);
  assert.equal(
    result.commLocalHash,
    "cccccccccccccccccccccccccccccccccccccccc",
  );
  assert.equal(
    result.firefoxRemoteHash,
    "ffffffffffffffffffffffffffffffffffffffff",
  );
  assert.deepEqual(
    result.mismatches.map((item) => item.file),
    ["Cargo.lock"],
  );
  assert.deepEqual(removed, [[tempDir, { recursive: true, force: true }]]);
  assert.deepEqual(
    calls.map((call) => [call.cwd, call.args]),
    [
      ["/repo/comm", ["rev-parse", "--verify", "refs/remotes/origin/main"]],
      ["/repo/comm", ["show", "refs/remotes/origin/main:rust/checksums.json"]],
      ["/repo/firefox", ["ls-remote", "--heads", "origin", "main"]],
      ["/repo/firefox", ["rev-parse", "--verify", "refs/remotes/origin/main"]],
      ["/repo/firefox", ["remote", "get-url", "origin"]],
      [tempDir, ["init"]],
      [
        tempDir,
        [
          "fetch",
          "--depth=1",
          "--no-tags",
          "git@example.com:firefox.git",
          "ffffffffffffffffffffffffffffffffffffffff",
        ],
      ],
      [tempDir, ["show", "FETCH_HEAD:Cargo.toml"]],
      [tempDir, ["show", "FETCH_HEAD:toolkit/library/rust/shared/Cargo.toml"]],
      [tempDir, ["show", "FETCH_HEAD:build/workspace-hack/Cargo.toml"]],
      [tempDir, ["show", "FETCH_HEAD:Cargo.lock"]],
    ],
  );
});

test("getGraphRustUpstreamStatus reads local Firefox origin main when it already matches remote", async () => {
  const calls = [];
  const remoteFiles = {
    "Cargo.toml": "workspace\n",
    "toolkit/library/rust/shared/Cargo.toml": "gkrust\n",
    "build/workspace-hack/Cargo.toml": "hack\n",
    "Cargo.lock": "remote lock\n",
  };
  const checksumData = {
    mc_workspace_toml: createHash("sha512")
      .update(remoteFiles["Cargo.toml"])
      .digest("hex"),
    mc_gkrust_toml: createHash("sha512")
      .update(remoteFiles["toolkit/library/rust/shared/Cargo.toml"])
      .digest("hex"),
    mc_hack_toml: createHash("sha512")
      .update(remoteFiles["build/workspace-hack/Cargo.toml"])
      .digest("hex"),
    mc_cargo_lock: createHash("sha512")
      .update(remoteFiles["Cargo.lock"])
      .digest("hex"),
  };

  const result = await getGraphRustUpstreamStatus({
    graphs: [
      { label: "comm", path: "/repo/comm" },
      { label: "firefox", path: "/repo/firefox" },
    ],
    makeTempDir: async () => {
      throw new Error(
        "Temp fetch should not run when local Firefox origin/main is current.",
      );
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.cwd === "/repo/comm" && command.args[0] === "rev-parse") {
        return "cccccccccccccccccccccccccccccccccccccccc\n";
      }

      if (command.cwd === "/repo/comm" && command.args[0] === "show") {
        return JSON.stringify(checksumData);
      }

      if (command.cwd === "/repo/firefox" && command.args[0] === "ls-remote") {
        return "ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main\n";
      }

      if (command.cwd === "/repo/firefox" && command.args[0] === "rev-parse") {
        return "ffffffffffffffffffffffffffffffffffffffff\n";
      }

      if (command.cwd === "/repo/firefox" && command.args[0] === "show") {
        return remoteFiles[
          command.args[1].replace(/^refs\/remotes\/origin\/main:/, "")
        ];
      }

      throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
    },
  });

  assert.equal(result.state, "current");
  assert.equal(result.upToDate, true);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    calls.map((call) => [call.cwd, call.args]),
    [
      ["/repo/comm", ["rev-parse", "--verify", "refs/remotes/origin/main"]],
      ["/repo/comm", ["show", "refs/remotes/origin/main:rust/checksums.json"]],
      ["/repo/firefox", ["ls-remote", "--heads", "origin", "main"]],
      ["/repo/firefox", ["rev-parse", "--verify", "refs/remotes/origin/main"]],
      ["/repo/firefox", ["show", "refs/remotes/origin/main:Cargo.toml"]],
      [
        "/repo/firefox",
        [
          "show",
          "refs/remotes/origin/main:toolkit/library/rust/shared/Cargo.toml",
        ],
      ],
      [
        "/repo/firefox",
        ["show", "refs/remotes/origin/main:build/workspace-hack/Cargo.toml"],
      ],
      ["/repo/firefox", ["show", "refs/remotes/origin/main:Cargo.lock"]],
    ],
  );
});

test("unshelfGraphShelves pops requested graph shelves", async () => {
  const calls = [];
  const result = await unshelfGraphShelves({
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
      },
    ],
    shelves: [
      {
        graphIndex: 0,
        stashRef: "stash@{0}",
      },
    ],
    runCommand: async (command) => {
      calls.push(command);
      return "";
    },
  });

  assert.equal(result.message, "Unshelved 1 checkout.");
  assert.deepEqual(
    calls.map((call) => call.args),
    [["stash", "pop", "stash@{0}"]],
  );
});

test("pruneCommitBranches drops a commit from the current branch history", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        return "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "topic\nmain\n";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse") {
        return "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from branch main.");
  assert.deepEqual(result.branches, ["main"]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.branch, "main");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["rebase", "--onto", "parent123", "abc123", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches drops a branch-tip commit without deleting the branch", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return calls.filter(
          (call) =>
            call.args[0] === "branch" && call.args[1] === "--show-current",
        ).length === 1
          ? ""
          : "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse") {
        return "parent123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from branch main.");
  assert.deepEqual(result.branches, ["main"]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "parent123");
  assert.equal(result.branch, "main");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["rebase", "--onto", "parent123", "abc123", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches drops a tb-tools checkpoint ref tip", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("refs/heads")
      ) {
        return "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("refs/tb-tools")
      ) {
        return "refs/tb-tools/rust-checkpoint\n";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        return "abc123\n";
      }

      if (command.args[0] === "rev-parse") {
        return "current789\n";
      }

      return "";
    },
  });

  assert.equal(
    result.message,
    "comm pruned abc123 from ref refs/tb-tools/rust-checkpoint.",
  );
  assert.deepEqual(result.branches, []);
  assert.deepEqual(result.refs, [
    { ref: "refs/tb-tools/rust-checkpoint", hash: "parent123" },
  ]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "current789");
  assert.equal(result.branch, "(detached)");
  assert.equal(result.detached, true);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--verify", "refs/tb-tools/rust-checkpoint"],
      ["update-ref", "refs/tb-tools/rust-checkpoint", "parent123", "abc123"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches rewrites a tb-tools checkpoint ref stack", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("refs/heads")
      ) {
        return "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("refs/tb-tools")
      ) {
        return command.args.includes("--points-at")
          ? ""
          : "refs/tb-tools/stack\n";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        return "tip789\n";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 3
          ? "rewritten456\n"
          : "current789\n";
      }

      return "";
    },
  });

  assert.equal(
    result.message,
    "comm pruned abc123 from ref refs/tb-tools/stack.",
  );
  assert.deepEqual(result.branches, []);
  assert.deepEqual(result.refs, [
    { ref: "refs/tb-tools/stack", hash: "rewritten456" },
  ]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "current789");
  assert.equal(result.branch, "main");
  assert.equal(result.detached, false);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--verify", "refs/tb-tools/stack"],
      ["switch", "--detach", "tip789"],
      ["rebase", "--onto", "parent123", "abc123", "HEAD"],
      ["rev-parse", "HEAD"],
      ["update-ref", "refs/tb-tools/stack", "rewritten456", "tip789"],
      ["switch", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches drops a commit from detached current history", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        return "";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "tip789\n"
          : "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from current checkout.");
  assert.deepEqual(result.branches, []);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.branch, "(detached)");
  assert.equal(result.detached, true);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["rev-parse", "HEAD"],
      ["merge-base", "--is-ancestor", "abc123", "HEAD"],
      ["rebase", "--onto", "parent123", "abc123", "HEAD"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches drops a detached HEAD tip commit", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        return "";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "abc123\n"
          : "parent123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from current checkout.");
  assert.deepEqual(result.branches, []);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "parent123");
  assert.equal(result.branch, "(detached)");
  assert.equal(result.detached, true);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["rev-parse", "HEAD"],
      ["switch", "--detach", "parent123"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches rejects an unbranched commit outside the current checkout", async () => {
  const calls = [];
  await assert.rejects(
    pruneCommitBranches({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "(detached)",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async (command) => {
        calls.push(command);

        if (
          command.args[0] === "branch" &&
          command.args[1] === "--show-current"
        ) {
          return "";
        }

        if (command.args[0] === "for-each-ref") {
          return "";
        }

        if (command.args[0] === "rev-list") {
          return "abc123 parent123\n";
        }

        if (command.args[0] === "rev-parse") {
          return "tip789\n";
        }

        if (command.args[0] === "merge-base") {
          const error = new Error("not an ancestor");
          error.code = 1;
          throw error;
        }

        return "";
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(
        error.message,
        /No local branches or the current checkout contain abc123/,
      );
      return true;
    },
  );

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "abc123",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "abc123",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "abc123",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "abc123"],
      ["rev-parse", "HEAD"],
      ["merge-base", "--is-ancestor", "abc123", "HEAD"],
    ],
  );
});

test("discardWorkingTreeChanges resets tracked changes and removes untracked files", async () => {
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "main",
    knownHashes: new Set(["uncommitted-changes"]),
  };
  const result = await discardWorkingTreeChanges({
    graph,
    hash: "uncommitted-changes",
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm discarded uncommitted changes.");
  assert.equal(result.currentHash, "abc123");
  assert.equal(result.branch, "main");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["reset", "--hard", "HEAD"],
      ["clean", "-fd"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("runGraphCommitAction prunes uncommitted changes by discarding the working tree", async () => {
  const calls = [];
  const result = await runGraphCommitAction({
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["uncommitted-changes"]),
      },
    ],
    graphIndex: 0,
    hash: "uncommitted-changes",
    action: "prune",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm discarded uncommitted changes.");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["reset", "--hard", "HEAD"],
      ["clean", "-fd"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("runGraphCommitAction creates a Bug branch from a selected commit", async () => {
  const calls = [];
  const result = await runGraphCommitAction({
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["abc123"]),
      },
    ],
    graphIndex: 0,
    hash: "abc123",
    action: "branch",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "log") {
        return "Bug 7654321 - Branch me\n";
      }

      return "";
    },
  });

  assert.equal(result.createdBranch, "Bug-7654321");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["log", "-1", "--format=%B", "abc123"],
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      ["branch", "Bug-7654321", "abc123"],
    ],
  );
});

test("checkoutCommit refuses dirty working trees", async () => {
  await assert.rejects(
    checkoutCommit({
      graph: {
        label: "firefox",
        path: "/repo/firefox",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async () => " M file.txt\n",
    }),
    /local changes/,
  );
});

test("buildGraphHtml creates tabbed lane graph HTML", () => {
  const html = buildGraphHtml({
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commitCount: 1,
        diffs: {
          abc123: {
            text: "diff --git a/file b/file",
            truncated: false,
          },
        },
        commits: [
          {
            hash: "abc123",
            parents: [],
            refs: ["HEAD", "main"],
            author: { name: "Alice", email: "alice@example.com" },
            subject: "Fix",
          },
        ],
        workingTreeCount: 1,
      },
      {
        label: "firefox",
        path: "/repo",
        branch: "main",
        commitCount: 0,
        commits: [],
      },
    ],
  });
  const client = readGraphClientScripts();
  const style = readGraphClientStylesheet();

  assert.match(html, /Thunderbird Desktop Console/);
  assert.match(html, /id="graph-config"/);
  assert.match(html, /<link rel="stylesheet" href="graph-client\/style\.css">/);
  assert.match(
    html,
    /<script type="module" src="graph-client\/init\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /function renderGraph/);
  assert.doesNotMatch(html, /window\.[A-Z][A-Za-z]+JS/);
  assert.match(html, /1 uncommitted change set/);
  assert.match(html, /data-index="0"/);
  assert.match(html, /data-index="1"/);
  assert.match(html, /class="header-row"/);
  assert.match(html, /class="title-row"/);
  assert.match(html, /class="toolbar-row"/);
  assert.match(html, /class="summary" data-index="0"/);
  assert.match(html, /class="summary-branch"/);
  assert.match(html, /class="summary-working-tree"/);
  assert.match(client, /function renderGraph/);
  assert.match(client, /renderGraph\(0\)/);
  assert.match(client, /function showDiff/);
  assert.match(html, /id="commit-context-menu"/);
  assert.match(html, /data-action="checkout"/);
  assert.match(html, /data-action="rebase"/);
  assert.match(html, /data-rebase-mode="selected"/);
  assert.match(html, /data-rebase-mode="children"/);
  assert.match(html, /data-rebase-mode="descendants"/);
  assert.match(html, /data-rebase-mode="stack"/);
  assert.match(html, /data-action="branch"/);
  assert.match(html, /data-action="prune"/);
  assert.match(
    html,
    /class="amend-commit" type="button" hidden>Amend<\/button>/,
  );
  assert.match(
    html,
    /class="submit-commit" type="button" hidden>Submit<\/button>/,
  );
  assert.match(html, /class="diff-message" hidden/);
  assert.match(html, /class="integration-status" hidden/);
  assert.match(html, /id="amend-dialog"/);
  assert.match(html, /class="amend-message"/);
  assert.match(html, /id="commit-dialog"/);
  assert.match(html, /class="commit-reviewer-input"/);
  assert.match(html, /id="commit-reviewer-list" role="listbox" hidden/);
  assert.match(html, /id="submit-dialog"/);
  assert.match(html, /class="submit-prompt"/);
  assert.match(html, /class="submit-links" hidden/);
  assert.match(html, /class="submit-output"/);
  assert.match(html, /id="try-dialog"/);
  assert.match(html, /class="try-selector"/);
  assert.match(html, /class="try-tasks-regex"/);
  assert.match(
    html,
    /class="tab test-output-tab" type="button" hidden>Test Output<\/button>/,
  );
  assert.match(html, /class="test-output-panel" hidden/);
  assert.match(
    html,
    /class="test-results-panel" aria-label="Parsed test results"/,
  );
  assert.match(html, /class="test-results-state">Waiting for a test run\./);
  assert.match(
    html,
    /class="test-rerun-all" type="button" hidden>Rerun All<\/button>/,
  );
  assert.match(html, /class="test-output-summary empty"/);
  assert.match(html, /class="test-output-failures empty"/);
  assert.match(html, /id="test-dialog"/);
  assert.match(html, /class="test-flavor"/);
  assert.match(html, /class="test-pattern"/);
  assert.match(html, /class="test-headless"/);
  assert.match(html, /class="workspace" data-index="0"/);
  assert.match(html, /class="pane-resizer"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-controls="graph-0 diff-0"/);
  assert.match(html, /class="diff-stats" hidden aria-label=""/);
  assert.match(style, /\.workspace \{ --graph-pane-width: 54%; display: grid/);
  assert.match(style, /\.title-row \{/);
  assert.match(style, /\.toolbar-row \{/);
  assert.match(style, /\.update-actions \{/);
  assert.match(style, /\.graph-options-menu \{/);
  assert.match(style, /\.graph-submenu \{/);
  assert.match(style, /\.command-status-bar \{/);
  assert.match(style, /\.command-status-bar\[hidden\] \{ display: none; \}/);
  assert.match(style, /\.command-status-primary \{/);
  assert.match(style, /\.command-status-tools \{/);
  assert.match(style, /body\.has-command-status main/);
  assert.match(style, /\.command-status-bar\.busy \.command-status-dot/);
  assert.match(style, /\.command-elapsed \{/);
  assert.match(style, /\.command-status-close \{/);
  assert.match(
    style,
    /\.mach-cancel\[hidden\], \.mach-output-toggle\[hidden\], \.command-status-close\[hidden\] \{ display: none; \}/,
  );
  assert.match(style, /\.mach-output-panel \{/);
  assert.match(style, /\.mach-output-toggle\[hidden\]/);
  assert.match(style, /\.origin-main-status \{/);
  assert.match(style, /\.origin-main-badge\.current/);
  assert.match(
    style,
    /\.origin-main-badge\.stale, \.origin-main-badge\.warning/,
  );
  assert.match(style, /\.update-status\.error/);
  assert.match(style, /\.pane-resizer \{[^}]*cursor: col-resize/);
  assert.match(style, /\.pane-resizer:hover::before/);
  assert.match(style, /body\.is-resizing-panes/);
  assert.match(style, /\.graph svg \{ overflow: visible; \}/);
  assert.match(style, /\.lane-path \{ fill: none; stroke-linecap: round/);
  assert.match(style, /\.commit-dot \{ stroke: #ffffff/);
  assert.match(
    style,
    /\.commit-hash, \.commit-message \{ dominant-baseline: central/,
  );
  assert.match(style, /\.commit-message \{ fill: #20242a; \}/);
  assert.match(style, /\.branch-label-bg \{ stroke-width: 1/);
  assert.match(style, /\.branch-label-text \{ dominant-baseline: central/);
  assert.doesNotMatch(style, /\.commit-try-link/);
  assert.doesNotMatch(style, /\.commit-try-bg/);
  assert.match(style, /\.commit-row, \.commit-row \* \{ cursor: pointer; \}/);
  assert.match(style, /\.commit-row\.active \.commit-row-hitbox/);
  assert.match(style, /\.commit-row\.working-tree \.commit-row-hitbox/);
  assert.match(style, /\.commit-row\.current \.commit-row-hitbox/);
  assert.match(
    style,
    /@media \(prefers-color-scheme: dark\) \{[^]*\.commit-hash \{ fill: #9aa4b2; \}/,
  );
  assert.match(
    style,
    /@media \(prefers-color-scheme: dark\) \{[^]*\.commit-message \{ fill: #e6edf3; \}/,
  );
  assert.match(style, /\.context-menu button\[data-action="prune"\]/);
  assert.match(style, /\.context-menu button\[hidden\] \{ display: none; \}/);
  assert.match(
    style,
    /\.checkout-commit, \.amend-commit, \.submit-commit, \.load-more/,
  );
  assert.match(style, /\.amend-dialog \{/);
  assert.match(style, /\.amend-message \{/);
  assert.match(style, /\.commit-dialog \{/);
  assert.match(style, /\.commit-reviewer-picker \{/);
  assert.match(style, /\.commit-reviewer-pill \{/);
  assert.match(style, /\.commit-reviewer-pill\.blocking \{/);
  assert.match(style, /\.commit-reviewer-blocking\[aria-pressed="true"\]/);
  assert.match(style, /\.commit-reviewer-option\[aria-selected="true"\]/);
  assert.match(style, /\.commit-reviewer-option\.blocking/);
  assert.match(style, /\.submit-dialog \{/);
  assert.match(style, /\.submit-links a/);
  assert.match(style, /\.submit-output \{/);
  assert.match(style, /\.try-dialog \{/);
  assert.match(style, /\.try-grid \{/);
  assert.match(style, /\.test-output-panel \{/);
  assert.match(style, /\.test-results-panel \{/);
  assert.match(style, /\.test-summary-card\.passed/);
  assert.match(style, /\.test-failed-file-list \{/);
  assert.match(style, /\.test-failed-file \{/);
  assert.match(style, /\.test-failure \{/);
  assert.match(style, /\.test-rerun-all/);
  assert.match(style, /\.test-output-log \{/);
  assert.match(style, /\.ansi-red \{/);
  assert.match(style, /\.test-dialog \{/);
  assert.match(style, /\.diff-placeholder/);
  assert.match(style, /\.diff-message \{/);
  assert.match(
    style,
    /\.diff-message a \{ color: #0969da; text-decoration: none; \}/,
  );
  assert.match(style, /\.diff-message\[hidden\] \{ display: none; \}/);
  assert.match(style, /\.integration-status \{/);
  assert.match(style, /\.status-badge \{/);
  assert.match(style, /\.status-badge\.try/);
  assert.match(style, /\.try-run-current \{/);
  assert.match(style, /\.try-run-toggle/);
  assert.match(style, /\.try-run-history\[hidden\]/);
  assert.match(style, /\.status-badge\.open/);
  assert.match(style, /\.status-badge\.error/);
  assert.match(style, /\.checkin-needed-button/);
  assert.match(style, /\.diff-table \{ border-collapse: collapse/);
  assert.match(style, /\.diff-line \{ height: 24px/);
  assert.match(style, /\.diff-line\.delete \.old-line/);
  assert.match(style, /\.diff-line\.insert \.line-code/);
  assert.match(style, /\.file-stats/);
  assert.match(style, /\.diff-stats/);
  assert.match(style, /\.line-marker/);
  assert.match(style, /\.line-number/);
  assert.match(style, /\.line-content \.hljs-keyword/);
  assert.match(style, /\.line-content \.hljs-string/);
  assert.match(client, /const COMMIT_DOT_RADIUS = 10/);
  assert.match(client, /const LANE_SPACING = 20/);
  assert.match(client, /const COMMIT_HASH_WIDTH = 116/);
  assert.match(client, /function normalizeBranchRef/);
  assert.match(client, /function getCommitBranchRefs/);
  assert.match(client, /function getPrioritizedCommitBranchRefs/);
  assert.match(client, /function getBranchColor/);
  assert.match(client, /function addBranchLabels/);
  assert.match(client, /function getLaneRows/);
  assert.match(client, /function renderLaneGraph/);
  assert.match(client, /function drawLaneContinuations/);
  assert.match(client, /function addLaneCommitRow/);
  assert.doesNotMatch(client, /function addCommitTryRunLabel/);
  assert.match(client, /fill: branchColor/);
  assert.match(client, /drawLanePath\(svg, index/);
  assert.match(client, /function centerBranchLabelsVertically/);
  assert.match(client, /function decorateCommitRows/);
  assert.match(client, /function showCommitContextMenu/);
  assert.match(client, /function runCommitAction/);
  assert.match(client, /function openAmendDialog/);
  assert.match(client, /function submitAmendDialog/);
  assert.match(client, /function openCommitDialog/);
  assert.match(client, /function searchCommitReviewers/);
  assert.match(client, /function submitCommitDialog/);
  assert.match(client, /function openSubmitDialog/);
  assert.match(client, /await confirmRemoteBuildRustWarning\("submit"\)/);
  assert.match(client, /function renderSubmitSession/);
  assert.match(client, /function answerSubmitPrompt/);
  assert.match(client, /function confirmRemoteBuildRustWarning/);
  assert.doesNotMatch(
    client,
    /function confirmRemoteBuildRustWarning[\s\S]*?refreshOriginMainStatus\(\{ force: true \}\)[\s\S]*?Remote builds may fail/,
  );
  assert.match(
    client,
    /Rust dependencies are out of sync with Firefox remote main/,
  );
  assert.match(client, /function scheduleOriginMainStatusRetry/);
  assert.match(client, /originMainStatusRetryTimer/);
  assert.match(client, /submitOutput\.textContent = session\.output \|\| ""/);
  assert.match(client, /function isWorkingTreeCommit/);
  assert.match(client, /function getSnapshotFingerprint/);
  assert.match(client, /function refreshGraphFromServer/);
  assert.match(client, /function pollGraphUpdates/);
  assert.match(client, /function runGraphUpdate/);
  assert.match(client, /function promptForDirtyUpdateAction/);
  assert.match(client, /function unshelfGraphUpdateChanges/);
  assert.match(client, /function startGraphMachAction/);
  assert.match(client, /function openTryDialog/);
  assert.match(client, /function submitTryDialog/);
  assert.match(client, /function pollGraphTrySession/);
  assert.match(client, /function openTestDialog/);
  assert.match(client, /function startGraphTestSession/);
  assert.match(client, /function pollGraphTestSession/);
  assert.match(client, /function renderAnsiOutput/);
  assert.match(client, /function renderTestSummary/);
  assert.match(client, /function renderTestFailures/);
  assert.match(client, /function renderFailedFiles/);
  assert.match(client, /function setTestRerunAllButton/);
  assert.match(client, /\/api\/test/);
  assert.match(client, /testHeadless\.checked/);
  assert.match(client, /failure\.vscodeUrl/);
  assert.match(client, /session\.summary\.failedFiles/);
  assert.match(client, /test-rerun-file/);
  assert.match(client, /test-rerun-all/);
  assert.match(client, /function cancelGraphMachAction/);
  assert.match(client, /function setMachOutputPanel/);
  assert.match(client, /function dismissCommandStatus/);
  assert.match(client, /setCommandStatusBarActive\(busy, \{ visible \}\)/);
  assert.match(client, /closeButton\.hidden = busy \|\| !visible/);
  assert.match(client, /function refreshOriginMainStatus/);
  assert.match(client, /function promptForPostUpdateMachAction/);
  assert.match(client, /function selectCommitActionResult/);
  assert.match(client, /function loadSelectedCommitMessage/);
  assert.match(client, /function loadSelectedCommitIntegrationStatus/);
  assert.match(client, /function renderCommitIntegrationStatus/);
  assert.match(client, /function createTryRunStatus/);
  assert.match(client, /function clearIntegrationStatus/);
  assert.match(client, /function isAcceptedPhabricatorStatus/);
  assert.match(client, /function markBugForCheckin/);
  assert.match(client, /function setCommitMessage/);
  assert.match(client, /function getCommitMessageLinkUrl/);
  assert.match(client, /function getLinkedCommitMessageNodes/);
  assert.match(
    client,
    /const BUGZILLA_BUG_URL = "https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id="/,
  );
  assert.match(
    client,
    /const PHABRICATOR_REVISION_URL = "https:\/\/phabricator\.services\.mozilla\.com\/D"/,
  );
  assert.match(client, /const COMMIT_MESSAGE_LINK_PATTERN = /);
  assert.match(client, /document\.createTextNode/);
  assert.match(client, /document\.createElement\("a"\)/);
  assert.match(client, /BUGZILLA_BUG_URL \+ bugMatch\[1\]/);
  assert.match(client, /PHABRICATOR_REVISION_URL \+ phabMatch\[1\]/);
  assert.match(client, /link\.target = "_blank"/);
  assert.match(client, /link\.rel = "noreferrer"/);
  assert.match(client, /function formatCommitTitle/);
  assert.match(client, /Current staged, unstaged, and untracked changes/);
  assert.match(client, /if \(!INTERACTIVE\.enabled\)/);
  assert.match(
    client,
    /current\.append\(createTryRunBadge\(runs\[0\], "Try"\)\)/,
  );
  assert.match(client, /current\.append\(toggle\)/);
  assert.match(client, /group\.append\(current, history\)/);
  assert.match(
    client,
    /renderCommitIntegrationStatus\(container, \{ tryRuns: commit\.tryRuns \|\| \[\] \}/,
  );
  assert.match(client, /amendButton\.hidden = !INTERACTIVE\.enabled/);
  assert.match(client, /function startPaneResize/);
  assert.match(client, /function resizePaneFromKeyboard/);
  assert.match(client, /restoreGraphPaneWidth\(0\)/);
  assert.match(
    client,
    /resizer\.addEventListener\("pointerdown", startPaneResize\)/,
  );
  assert.match(client, /function setDiffStats/);
  assert.match(client, /setDiffStats\(stats, result\)/);
  assert.match(client, /function isCurrentCommit/);
  assert.match(client, /const labelTranslate = getTranslate\(labelContainer\)/);
  assert.match(client, /graphStates\[index\]\.selectedHash = commit\.hash/);
  assert.match(
    client,
    /const commits = placeWorkingTreeCommits\(graph\.commits \? \[\.\.\.graph\.commits\] : \[\]\)/,
  );
  assert.match(client, /currentHash: getCurrentCommitHash\(commits\)/);
  assert.match(
    client,
    /row\.classList\.toggle\("current", row\.dataset\.hash === currentHash\)/,
  );
  assert.match(client, /graphStates\[graphIndex\]\.currentHash = hash/);
  assert.match(client, /\/api\/graph\/" \+ index \+ "\/snapshot/);
  assert.match(
    client,
    /setInterval\(pollGraphUpdates, INTERACTIVE\.pollIntervalMs\)/,
  );
  assert.match(
    client,
    /\/api\/graph\/" \+[^]*graphIndex[^]*"\/message\/" \+[^]*encodeURIComponent\(hash\)/,
  );
  assert.match(
    client,
    /\/api\/graph\/" \+ index \+ "\/message\/" \+ encodeURIComponent\(commit\.hash\)/,
  );
  assert.match(
    client,
    /\/api\/graph\/" \+ index \+ "\/integration\/" \+ encodeURIComponent\(commit\.hash\)/,
  );
  assert.match(
    client,
    /loadSelectedCommitMessage\(index, commit, commitMessage\)/,
  );
  assert.match(
    client,
    /loadSelectedCommitIntegrationStatus\(index, commit, integrationStatus\)/,
  );
  assert.match(
    client,
    /!result\.bug\.error && isAcceptedPhabricatorStatus\(result\.phabricator\)/,
  );
  assert.match(client, /\/api\/bugzilla\/checkin/);
  assert.match(client, /event\.target\.closest\("\.checkin-needed-button"\)/);
  assert.match(client, /\/api\/amend-message/);
  assert.match(client, /\/api\/commit\/metadata/);
  assert.match(client, /\/api\/commit\/reviewers/);
  assert.match(client, /\/api\/commit/);
  assert.match(
    client,
    /amendButton\.textContent = isWorkingTreeCommit\(commit\)[^]*\? "Amend"[^]*: "Amend Message"/,
  );
  assert.match(
    client,
    /submitButton\.hidden =[^]*!INTERACTIVE\.enabled[^]*\|\|[^]*isWorkingTreeCommit\(commit\)[^]*\|\|[^]*!isCurrentCommit\(commit\)/,
  );
  assert.match(client, /hash: uiState\.amendDialogState\.hash/);
  assert.match(client, /expectedChangeId: uiState\.amendDialogState\.changeId/);
  assert.match(
    client,
    /includeChanges: uiState\.amendDialogState\.includeChanges/,
  );
  assert.match(
    client,
    /selectCommitActionResult\([^]*graphIndex,[^]*result\.rewrittenHash \|\| result\.currentHash,[^]*result\.message/,
  );
  assert.match(client, /\/api\/submit/);
  assert.match(client, /\/api\/try/);
  assert.match(client, /\/api\/update-graphs/);
  assert.match(client, /\/api\/unshelf-graphs/);
  assert.match(client, /\/api\/mach-action/);
  assert.match(client, /\/api\/origin-main-status/);
  assert.match(
    client,
    /\/api\/submit\/" \+[^]*encodeURIComponent\(uiState\.submitDialogState\.sessionId\)/,
  );
  assert.match(client, /button\.dataset\.answer === "true"/);
  assert.match(client, /scheduleGraphEnhancements\(index\)/);
  assert.match(client, /Branch tips will check out the branch/);
  assert.match(client, /Create a Bug branch at/);
  assert.match(client, /Discard all uncommitted changes/);
  assert.match(client, /button\.dataset\.action !== "prune"/);
  assert.match(client, /button\.style\.display = hidden \? "none" : ""/);
  assert.match(client, /Uncommitted changes/);
  assert.match(client, /rebaseMode: button\.dataset\.rebaseMode \|\| ""/);
  assert.match(client, /preferredBranch/);
  assert.match(client, /rebaseMode/);
  assert.match(client, /commitGroup\.addEventListener\("contextmenu"/);
  assert.match(
    client,
    /runCommitAction\(button\.dataset\.action, actionState\)/,
  );
  assert.doesNotMatch(client, /window\.[A-Z][A-Za-z]+JS/);
  assert.match(
    client,
    /renderLaneGraph\(index, pruneLoadedParents\(state\.commits\)\)/,
  );
  assert.doesNotMatch(html, /class="update-actions"/);
  assert.doesNotMatch(html, /class="origin-main-status"/);
  assert.doesNotMatch(html, /class="graph-options"/);
  assert.doesNotMatch(html, /class="command-status-bar"/);
});

test("buildGraphHtml supports interactive loading and checkout callbacks", () => {
  const html = buildGraphHtml({
    interactive: {
      enabled: true,
      pageSize: 25,
      token: "secret",
    },
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commitCount: 0,
        commits: [],
        diffs: {},
      },
    ],
  });
  const client = readGraphClientScripts();
  const style = readGraphClientStylesheet();

  assert.match(html, /id="graph-config"/);
  assert.match(html, /"pageSize":25/);
  assert.match(html, /<link rel="stylesheet" href="graph-client\/style\.css">/);
  assert.match(
    html,
    /<script type="module" src="graph-client\/init\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /function renderGraph/);
  assert.match(client, /const INTERACTIVE = /);
  assert.match(html, /<title>Thunderbird Desktop Console<\/title>/);
  assert.match(html, /<h1>Thunderbird Desktop Console<\/h1>/);
  assert.match(
    html,
    /<h1>Thunderbird Desktop Console<\/h1>\s*<div class="origin-main-status"/,
  );
  assert.match(
    html,
    /class="origin-main-badge checking">Thunderbird: checking<\/span>/,
  );
  assert.match(
    html,
    /class="origin-main-badge checking">Rust deps: checking<\/span>/,
  );
  assert.ok(
    html.indexOf('<div class="graph-options">') >
      html.indexOf('<div class="header-row">'),
  );
  assert.ok(
    html.indexOf('<div class="graph-options">') <
      html.indexOf('<div class="toolbar-row">'),
  );
  assert.match(html, /<div class="toolbar-row">\s*<nav class="tabs">/);
  assert.match(html, /class="update-actions"/);
  assert.match(html, /<\/nav>\s*<div class="update-actions" role="toolbar"/);
  assert.ok(
    html.indexOf('<div class="update-actions"') >
      html.indexOf('<div class="toolbar-row">'),
  );
  assert.match(html, /data-mode="update">Update<\/button>/);
  assert.match(html, /data-mode="rebase">Update and Rebase<\/button>/);
  assert.doesNotMatch(
    html,
    /class="mach-action" type="button" data-action="build">Build<\/button>/,
  );
  assert.match(html, /data-action="run">Run<\/button>/);
  assert.match(
    html,
    /class="graph-menu-button" type="button" aria-label="More actions"/,
  );
  assert.match(
    html,
    /id="graph-options-menu" role="menu" aria-label="More actions" hidden/,
  );
  assert.match(
    html,
    /class="graph-menu-command" type="button" role="menuitem" data-menu-action="build">Build<\/button>/,
  );
  assert.match(
    html,
    /class="graph-menu-command" type="button" role="menuitem" data-menu-action="commit">Commit<\/button>/,
  );
  assert.match(
    html,
    /class="graph-menu-command graph-submenu-trigger"[^>]+data-menu-action="lint">Lint<\/button>/,
  );
  assert.match(
    html,
    /class="graph-submenu" role="menu" aria-label="Lint options"/,
  );
  assert.match(html, /data-menu-action="lint-all">All<\/button>/);
  assert.match(html, /data-menu-action="lint-outgoing">Outgoing<\/button>/);
  assert.doesNotMatch(html, /data-menu-action="lint-new"/);
  assert.match(html, /data-menu-action="new-patch">New Patch<\/button>/);
  assert.match(html, /data-menu-action="pull-patch">Pull patch<\/button>/);
  assert.match(html, /data-menu-action="test">Test<\/button>/);
  assert.match(html, /data-menu-action="try">Try<\/button>/);
  assert.match(html, /data-menu-action="land">Land Patches<\/button>/);
  assert.match(
    html,
    /class="tab test-output-tab" type="button" hidden>Test Output<\/button>/,
  );
  assert.match(html, /class="test-output-panel" hidden/);
  assert.match(
    html,
    /class="test-results-panel" aria-label="Parsed test results"/,
  );
  assert.match(
    html,
    /class="test-rerun-all" type="button" hidden>Rerun All<\/button>/,
  );
  assert.match(
    style,
    /\.graph-submenu \{ display: none; position: absolute; right: calc\(100% - 1px\); top: 0; \}/,
  );
  assert.match(
    html,
    /class="origin-main-status" role="status" aria-label="origin\/main freshness"/,
  );
  assert.match(
    html,
    /class="command-status-bar" role="region" aria-label="Command status" hidden/,
  );
  assert.match(html, /class="command-status-primary"/);
  assert.match(html, /class="command-status-tools"/);
  assert.match(html, /class="update-status" role="status" hidden><\/span>/);
  assert.match(
    html,
    /class="command-elapsed" aria-label="Elapsed time"><\/span>/,
  );
  assert.match(
    html,
    /class="mach-cancel" type="button" hidden>Cancel Build<\/button>/,
  );
  assert.match(
    html,
    /class="command-status-close" type="button" hidden aria-label="Dismiss command status">&times;<\/button>/,
  );
  assert.match(
    html,
    /class="mach-output-toggle" type="button" hidden aria-expanded="false">Output<\/button>/,
  );
  assert.match(html, /class="mach-output-panel" hidden/);
  assert.match(html, /<dialog class="try-dialog" id="try-dialog">/);
  assert.match(html, /<dialog class="commit-dialog" id="commit-dialog">/);
  assert.match(html, /class="commit-field commit-bug-field" hidden/);
  assert.match(
    html,
    /class="commit-reviewer-input"[\s\S]+aria-controls="commit-reviewer-list"/,
  );
  assert.match(html, /<option value="fuzzy">fuzzy<\/option>/);
  assert.match(html, /Post try link to Phabricator/);
  assert.match(html, /<dialog class="test-dialog" id="test-dialog">/);
  assert.match(html, /<option value="browser">browser<\/option>/);
  assert.match(html, /class="test-pattern" name="pattern"/);
  assert.match(html, /class="test-headless" name="headless" type="checkbox"/);
  assert.match(html, /<dialog class="new-patch-dialog" id="new-patch-dialog">/);
  assert.match(html, /class="new-patch-bug"[^>]+pattern="\[0-9\]\{4,8\}"/);
  assert.match(html, /class="new-patch-update"[^>]+checked/);
  assert.match(html, /<dialog class="patch-dialog" id="patch-dialog">/);
  assert.match(html, /class="patch-revision"[^>]+placeholder="D123456"/);
  assert.match(html, /class="patch-apply-to"/);
  assert.match(html, /class="patch-skip-dependencies"/);
  assert.doesNotMatch(html, /class="patch-yes"/);
  assert.match(html, /<dialog class="land-dialog" id="land-dialog">/);
  assert.match(
    html,
    /class="land-lando-repo"[^>]+value="thunderbird-desktop-main"/,
  );
  assert.match(
    html,
    /class="land-start" type="button">Start Landing<\/button>/,
  );
  assert.doesNotMatch(style, /\.land-close:disabled/);
  assert.match(client, /\/api\/graph\/" \+ index \+ "\/commits/);
  assert.match(client, /openTestDialog\(\)/);
  assert.match(client, /cancelGraphTestSession\(\)/);
  assert.match(
    client,
    /testOutputTab\.addEventListener\("click", showTestOutputTab\)/,
  );
  assert.match(client, /document\.querySelectorAll\("\.tab\[data-index\]"\)/);
  assert.match(client, /\/api\/commit-action/);
  assert.match(client, /openCommitDialog\(\)/);
  assert.match(client, /submitCommitDialog/);
  assert.match(client, /addCommitReviewerFromEvent/);
  assert.match(client, /handleCommitReviewerPillEvent/);
  assert.match(client, /function getReviewerResultVariants/);
  assert.match(client, /\.flatMap\(getReviewerResultVariants\)/);
  assert.match(client, /MIN_REVIEWER_QUERY_LENGTH = 3/);
  assert.match(client, /REVIEWER_SEARCH_DEBOUNCE_MS = 300/);
  assert.match(client, /result\.rateLimited/);
  assert.match(client, /Start group searches with #/);
  assert.match(client, /limit=20/);
  assert.match(client, /\/api\/update-graphs/);
  assert.match(client, /\/api\/unshelf-graphs/);
  assert.match(client, /\/api\/mach-action/);
  assert.match(client, /\/api\/lint/);
  assert.match(client, /\/api\/new-patch/);
  assert.match(client, /\/api\/patch/);
  assert.match(client, /\/api\/origin-main-status/);
  assert.match(client, /\/api\/land/);
  assert.match(client, /function startGraphLintAction/);
  assert.match(client, /startGraphLintAction\(menuAction\.replace/);
  assert.match(client, /function openNewPatchDialog/);
  assert.match(client, /openNewPatchDialog\(\)/);
  assert.match(client, /function openPatchDialog/);
  assert.match(client, /openPatchDialog\(\)/);
  assert.match(client, /await confirmRemoteBuildRustWarning\("the try run"\)/);
  assert.doesNotMatch(
    client,
    /confirmRemoteBuildRustWarning\("land patches"\)/,
  );
  assert.match(client, /snapshotLimits: getSnapshotLimits\(\)/);
  assert.match(client, /await promptForPostUpdateMachAction\(\)/);
  assert.match(client, /await startGraphMachAction\("run"\)/);
  assert.match(client, /clearInterval\(originMainStatusPoll\)/);
  assert.match(client, /window\.clearTimeout\(uiState\.landPollTimer\)/);
  assert.match(client, /window\.clearTimeout\(uiState\.newPatchPollTimer\)/);
  assert.match(client, /window\.clearTimeout\(uiState\.patchPollTimer\)/);
  assert.match(client, /function cancelOrCloseLandDialog/);
  assert.match(client, /landClose\.disabled = false/);
  assert.match(client, /landClose\.textContent = busy \? "Cancel" : "Close"/);
  assert.match(
    client,
    /\/api\/land\/" \+ encodeURIComponent\(sessionId\) \+ "\/cancel"/,
  );
  assert.match(client, /landClose\.addEventListener\("click", \(\) =>/);
  assert.match(client, /landClose\.dataset\.landAnswer/);
  assert.match(
    client,
    /window\.clearTimeout\(uiState\.originMainStatusRetryTimer\)/,
  );
  assert.match(
    client,
    /snapshotLimit: getLoadedGitCommitLimit\(graphStates\[graphIndex\]\)/,
  );
  assert.match(
    client,
    /applyGraphSnapshot\(graphIndex, result\.snapshot, \{ force: true \}\)/,
  );
  assert.match(client, /\/api\/close/);
  assert.match(client, /\/api\/ping/);
  assert.match(client, /clientId/);
  assert.match(client, /function sendHeartbeat/);
  assert.match(client, /sendHeartbeat\(\)/);
  assert.match(client, /window\.addEventListener\(\s*"pagehide"/);
  assert.doesNotMatch(client, /beforeunload/);
  assert.match(html, /checkout-commit/);
  assert.match(html, /amend-commit/);
  assert.match(html, /submit-commit/);
  assert.match(client, /IntersectionObserver/);
  assert.match(client, /load-sentinel/);
  assert.match(client, /function openLandDialog/);
  assert.match(client, /function renderGraphLandSession/);
  assert.match(client, /function answerLandPrompt/);
  assert.doesNotMatch(client, /window\.innerHeight \+ window\.scrollY/);
});

test("getGraphOutputPath defaults to a temp HTML file", () => {
  assert.match(getGraphOutputPath(), /tb-tools-branch-graph\.html$/);
  assert.equal(getGraphOutputPath("/tmp/custom.html"), "/tmp/custom.html");
});

test("graph command writes and opens a tabbed graph", async () => {
  const calls = [];
  const graph = createGraphCommand({
    getCheckoutData: async ({ label, limit }) => ({
      label,
      path: `/repo/${label}`,
      branch: "main",
      limit,
      commitCount: 0,
      commits: [],
      diffs: {},
    }),
    readBundle: async (file, encoding) => {
      calls.push(["readBundle", path.basename(file), encoding]);
      return "client asset";
    },
    makeDir: async (dir, options) => calls.push(["mkdir", dir, options]),
    write: async (file, contents) => {
      calls.push([
        "write",
        file,
        contents === "client asset" ||
          (/comm/.test(contents) &&
            /firefox/.test(contents) &&
            /graph-client\/init\.js/.test(contents)),
      ]);
    },
    open: async (file) => calls.push(["open", file]),
  });

  const outputPath = await graph({ limit: 5, output: "/tmp/graph.html" });

  assert.equal(outputPath, "/tmp/graph.html");
  assert.deepEqual(calls.slice(0, 2), [
    ["mkdir", "/tmp", { recursive: true }],
    ["mkdir", "/tmp/graph-client", { recursive: true }],
  ]);
  assert.deepEqual(
    calls.slice(2, -2),
    GRAPH_CLIENT_TEST_ASSETS.flatMap(({ source, output }) => [
      ["readBundle", source, "utf8"],
      ["write", `/tmp/${output}`, true],
    ]),
  );
  assert.deepEqual(calls.slice(-2), [
    ["write", "/tmp/graph.html", true],
    ["open", "/tmp/graph.html"],
  ]);
});

test("interactive graph server returns origin status before slow Rust dependency check finishes", async (t) => {
  let resolveRustStatus;
  const rustStatusPromise = new Promise((resolve) => {
    resolveRustStatus = resolve;
  });
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
      {
        label: "firefox",
        path: "/repo/firefox",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getRustUpstreamStatus: async () => rustStatusPromise,
    runCommand: async (command) => {
      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        return command.cwd === "/repo/comm"
          ? "cccccccccccccccccccccccccccccccccccccccc\n"
          : "ffffffffffffffffffffffffffffffffffffffff\n";
      }

      if (command.args[0] === "ls-remote") {
        return command.cwd === "/repo/comm"
          ? "cccccccccccccccccccccccccccccccccccccccc\trefs/heads/main\n"
          : "ffffffffffffffffffffffffffffffffffffffff\trefs/heads/main\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const pendingResponse = await fetch(
    new URL("api/origin-main-status?token=secret", serverInfo.url),
  );
  const pendingStatus = await pendingResponse.json();

  assert.equal(pendingStatus.statuses[0].label, "comm");
  assert.equal(pendingStatus.statuses[0].state, "current");
  assert.equal(pendingStatus.statuses[1].label, "firefox");
  assert.equal(pendingStatus.statuses[1].state, "current");
  assert.equal(pendingStatus.statuses[2].type, "rust-upstream");
  assert.equal(pendingStatus.statuses[2].state, "checking");

  resolveRustStatus({
    type: "rust-upstream",
    label: "rust",
    state: "current",
    upToDate: true,
    commLocalHash: "cccccccccccccccccccccccccccccccccccccccc",
    firefoxRemoteHash: "ffffffffffffffffffffffffffffffffffffffff",
    mismatches: [],
    message: "Rust dependencies match Firefox remote main.",
  });
  await rustStatusPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const completedResponse = await fetch(
    new URL("api/origin-main-status?token=secret", serverInfo.url),
  );
  const completedStatus = await completedResponse.json();

  assert.equal(completedStatus.statuses[2].type, "rust-upstream");
  assert.equal(completedStatus.statuses[2].state, "current");
});

test("interactive graph server streams commits, diffs, checkout responses, and closes", async (t) => {
  const calls = [];
  const bugUpdates = [];
  let checkinMarked = false;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBug: async (id) => ({
      bugs: [
        {
          id,
          status: "NEW",
          resolution: "---",
          summary: "Fix the thing",
          is_open: true,
          keywords: checkinMarked ? ["checkin-needed-tb"] : [],
        },
      ],
    }),
    updateBug: async (id, update) => {
      bugUpdates.push([id, update]);
      checkinMarked = true;
      return {};
    },
    phab: async () => ({
      result: [
        {
          id: 987654,
          uri: "https://phabricator.services.mozilla.com/D987654",
          status: "status-accepted",
          statusName: "Accepted",
          title: "Bug 123456 - Fix the thing",
        },
      ],
    }),
    getRustUpstreamStatus: async () => ({
      type: "rust-upstream",
      label: "rust",
      state: "warning",
      upToDate: false,
      commLocalHash: "cccccccccccccccccccccccccccccccccccccccc",
      firefoxRemoteHash: "ffffffffffffffffffffffffffffffffffffffff",
      mismatches: [{ file: "Cargo.lock" }],
      message:
        "Rust dependencies are out of sync with Firefox remote main. Remote builds may fail.",
    }),
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd.endsWith("mach")) {
        return `${command.args[0]} complete\n`;
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123456 - Fix the thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
      }

      if (command.args[0] === "show") {
        return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "for-each-ref") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      }

      if (command.args[0] === "ls-remote") {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main\n";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });
  assert.equal(typeof serverInfo.server.shutdown, "function");

  const pageResponse = await fetch(serverInfo.url);
  assert.equal(await pageResponse.text(), "<!doctype html><p>graph</p>");

  const assetResponse = await fetch(
    new URL("assets/graph-client/init.js", serverInfo.url),
  );
  assert.equal(assetResponse.ok, true);
  assert.match(
    assetResponse.headers.get("content-type"),
    /application\/javascript/,
  );
  assert.match(await assetResponse.text(), /function renderGraph/);

  const stylesheetResponse = await fetch(
    new URL("assets/graph-client/style.css", serverInfo.url),
  );
  assert.equal(stylesheetResponse.ok, true);
  assert.match(stylesheetResponse.headers.get("content-type"), /text\/css/);
  assert.match(
    (await stylesheetResponse.text()).replace(/\s+/g, " "),
    /\.diff-line \{ height: 24px/,
  );

  const commitsResponse = await fetch(
    new URL(
      "api/graph/0/commits?offset=0&limit=1&token=secret",
      serverInfo.url,
    ),
  );
  const commits = await commitsResponse.json();
  assert.equal(commits.commits[0].hash, "abc123");

  const diffResponse = await fetch(
    new URL("api/graph/0/diff/abc123?token=secret", serverInfo.url),
  );
  const diff = await diffResponse.json();
  assert.match(diff.html, /pretty-file/);
  assert.equal(diff.insertions, 1);
  assert.equal(diff.deletions, 1);

  const integrationResponse = await fetch(
    new URL("api/graph/0/integration/abc123?token=secret", serverInfo.url),
  );
  const integration = await integrationResponse.json();
  assert.equal(integration.bug.status, "NEW");
  assert.equal(integration.bug.summary, "Fix the thing");
  assert.equal(integration.bug.hasCheckinNeeded, false);
  assert.equal(integration.phabricator.statusName, "Accepted");
  assert.equal(integration.phabricator.title, "Bug 123456 - Fix the thing");

  const checkinResponse = await fetch(
    new URL("api/bugzilla/checkin", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        graphIndex: 0,
        hash: "abc123",
        bugId: "123456",
      }),
    },
  );
  const checkin = await checkinResponse.json();
  assert.equal(checkin.message, "Bug 123456 marked for checkin.");
  assert.equal(checkin.bug.hasCheckinNeeded, true);
  assert.deepEqual(bugUpdates, [
    [
      "123456",
      {
        keywords: {
          add: ["checkin-needed-tb"],
        },
      },
    ],
  ]);

  const snapshotResponse = await fetch(
    new URL("api/graph/0/snapshot?limit=1&token=secret", serverInfo.url),
  );
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.commitCount, 1);
  assert.equal(snapshot.commits[0].hash, "abc123");

  const pingResponse = await fetch(new URL("api/ping", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  assert.equal(pingResponse.ok, true);

  const originMainStatusResponse = await fetch(
    new URL("api/origin-main-status?token=secret&force=1", serverInfo.url),
  );
  const originMainStatus = await originMainStatusResponse.json();
  assert.equal(originMainStatus.statuses[0].label, "comm");
  assert.equal(originMainStatus.statuses[0].state, "current");
  assert.equal(originMainStatus.statuses[0].upToDate, true);
  assert.equal(originMainStatus.statuses[1].type, "rust-upstream");
  assert.equal(originMainStatus.statuses[1].state, "warning");
  assert.equal(originMainStatus.statuses[1].mismatches[0].file, "Cargo.lock");

  const checkoutResponse = await fetch(
    new URL("api/checkout", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", graphIndex: 0, hash: "abc123" }),
    },
  );
  const checkout = await checkoutResponse.json();
  assert.equal(checkout.message, "comm checked out branch main at abc123.");
  assert.equal(checkout.snapshot.branch, "main");
  assert.equal(checkout.snapshot.commits[0].hash, "abc123");

  const rebaseResponse = await fetch(
    new URL("api/commit-action", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        graphIndex: 0,
        hash: "abc123",
        action: "rebase",
        snapshotLimit: 1,
      }),
    },
  );
  const rebase = await rebaseResponse.json();
  assert.equal(rebase.message, "comm rebased branch main onto main.");
  assert.equal(rebase.currentHash, "def456");
  assert.equal(rebase.snapshot.branch, "main");
  assert.equal(rebase.snapshot.commits[0].hash, "abc123");

  const updateResponse = await fetch(
    new URL("api/update-graphs", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        mode: "update",
        snapshotLimits: [1],
      }),
    },
  );
  const update = await updateResponse.json();
  assert.equal(update.ok, true);
  assert.equal(
    update.results[0].message,
    "comm updated main from origin/main.",
  );
  assert.equal(update.snapshots[0].branch, "main");
  assert.equal(update.snapshots[0].commits[0].hash, "abc123");

  const machResponse = await fetch(new URL("api/mach-action", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", action: "run" }),
  });
  const machStart = await machResponse.json();
  assert.equal(machStart.ok, true);
  assert.equal(machStart.action, "run");
  assert.equal(machStart.label, "comm");
  assert.equal(machStart.status, "running");

  const machSession = await waitForMachSession(
    new URL(`api/mach-action/${machStart.id}?token=secret`, serverInfo.url),
    (item) => item.status === "complete",
  );
  assert.equal(machSession.message, "Run finished.");
  assert.equal(machSession.phase, "");
  assert.equal(machSession.canCancel, false);
  assert.match(machSession.output, /\$ \.\.\/mach build/);
  assert.match(machSession.output, /build complete/);
  assert.match(machSession.output, /\$ \.\.\/mach run/);
  assert.match(machSession.output, /run complete/);

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  const closeResponse = await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  assert.equal(closeResponse.ok, true);
  await closePromise;

  assert.equal(
    calls.some((call) => call.args[0] === "switch" && call.args[1] === "main"),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === "fetch" &&
        call.args[1] === "origin" &&
        call.args[2] === "main",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) => call.args[0] === "pull" && call.args[1] === "--ff-only",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.cwd === "/repo/comm" &&
        call.args.join(" ") === "build",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.cwd === "/repo/comm" &&
        call.args.join(" ") === "run",
    ),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === "osascript" || call.cmd === "pkill"),
    false,
  );
  assert.equal(
    calls.some(
      (call) => call.args[0] === "switch" && call.args[1] === "--detach",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === "cherry-pick" && call.args[1] === "--no-commit",
    ),
    true,
  );
  assert.equal(
    calls.some((call) => call.args[0] === "commit" && call.args[1] === "-C"),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === "branch" &&
        call.args[1] === "-f" &&
        call.args[2] === "main",
    ),
    true,
  );
});

test("interactive graph server exposes rebase conflict sessions and continue", async (t) => {
  let conflictsStaged = false;
  let continuing = false;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [{ hash: "a111", subject: "Bug 100 - Fix", parents: [] }],
        commitCount: 1,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return continuing ? "Bug-100\n" : "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        return "Bug-100\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-100\n";
      }

      if (command.args[0] === "rev-list") {
        return command.args.at(-1) === "origin/main..a111" ? "a111\n" : "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (
        command.args[0] === "cherry-pick" &&
        command.args[1] === "--no-commit" &&
        !continuing
      ) {
        const error = new Error("CONFLICT");

        error.stderr = "CONFLICT (content): Merge conflict";
        throw error;
      }

      if (command.args[0] === "diff" && command.args.includes("--diff-filter=U")) {
        return conflictsStaged ? "" : "mail/conflicted.js\n";
      }

      if (command.args[0] === "add") {
        conflictsStaged = true;
        return "";
      }

      if (command.args[0] === "commit") {
        continuing = true;
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return continuing ? "new111\n" : "base000\n";
      }

      if (command.args[0] === "log") {
        return "\x1enew111\x1f\x1fHEAD -> Bug-100\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 100 - Fix\n";
      }

      return "";
    },
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const rebaseResponse = await fetch(
    new URL("api/commit-action", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        graphIndex: 0,
        hash: "a111",
        action: "rebase",
        snapshotLimit: 1,
      }),
    },
  );
  const conflict = await rebaseResponse.json();

  assert.equal(rebaseResponse.status, 409);
  assert.equal(conflict.rebaseConflict.type, "conflict");
  assert.equal(conflict.rebaseConflict.canContinue, true);
  assert.equal(conflict.rebaseConflict.files[0].path, "mail/conflicted.js");
  assert.ok(conflict.rebaseConflict.id);

  const continueResponse = await fetch(
    new URL(
      `api/rebase/${conflict.rebaseConflict.id}/continue`,
      serverInfo.url,
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        snapshotLimit: 1,
      }),
    },
  );
  const continued = await continueResponse.json();

  assert.equal(continueResponse.ok, true);
  assert.equal(continued.currentHash, "new111");
  assert.equal(continued.snapshot.branch, "Bug-100");
});

test("interactive graph server amends current commit with edited message and refreshes", async (t) => {
  const calls = [];
  let amended = false;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return amended
          ? "Bug 123 - New message. r=#reviewers\n\nNew body.\n"
          : "Bug 123 - Old message. r=#reviewers\n\nOld body.\n";
      }

      if (command.args[0] === "log") {
        return amended
          ? "\x1edef456\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - New message\n"
          : "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Old message\n";
      }

      if (command.args[0] === "diff") {
        return amended
          ? ""
          : "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "--amend") {
        amended = true;
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const messageResponse = await fetch(
    new URL(
      "api/graph/0/message/uncommitted-changes?token=secret",
      serverInfo.url,
    ),
  );
  const currentMessage = await messageResponse.json();
  assert.equal(
    currentMessage.message,
    "Bug 123 - Old message. r=#reviewers\n\nOld body.\n",
  );

  const amendResponse = await fetch(
    new URL("api/amend-message", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        graphIndex: 0,
        hash: "uncommitted-changes",
        message: "Bug 123 - New message. r=#reviewers\n\nNew body.",
        includeChanges: true,
        snapshotLimit: 1,
      }),
    },
  );
  const amend = await amendResponse.json();

  assert.equal(amend.ok, true);
  assert.equal(amend.message, "comm amended current commit def456.");
  assert.equal(amend.currentHash, "def456");
  assert.equal(amend.rewrittenHash, "def456");
  assert.equal(amend.snapshot.commits[0].hash, "def456");
  assert.equal(amend.snapshot.workingTreeCount, 0);
  assert.equal(
    calls.some((call) => call.args[0] === "add" && call.args[1] === "-A"),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === "commit" &&
        call.args[1] === "--amend" &&
        call.args[2] === "-F",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server cancels an active build session", async (t) => {
  let releaseBuild;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      if (command.cmd.endsWith("mach") && command.args[0] === "build") {
        return new Promise((resolve) => {
          releaseBuild = () => resolve("build stopped\n");
        });
      }

      return "";
    },
  });
  t.after(() => {
    releaseBuild?.();
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(
    new URL("api/mach-action", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", action: "build" }),
    },
  );
  const start = await startResponse.json();
  assert.equal(start.ok, true);

  const statusUrl = new URL(
    `api/mach-action/${start.id}?token=secret`,
    serverInfo.url,
  );
  const running = await waitForMachSession(
    statusUrl,
    (item) => item.phase === "building",
  );
  assert.equal(running.canCancel, true);

  const cancelResponse = await fetch(
    new URL(`api/mach-action/${start.id}/cancel`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    },
  );
  const canceled = await cancelResponse.json();
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.message, "Build canceled.");
  assert.equal(canceled.canCancel, false);

  releaseBuild();
  await waitForMachSession(statusUrl, (item) => item.status === "canceled");

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server starts lint sessions from menu modes", async (t) => {
  const calls = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd.endsWith("mach")) {
        return "lint complete\n";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("HEAD is not published on main.");
      }

      if (command.args[0] === "diff-tree") {
        return "mail/current.js\n";
      }

      if (command.args[0] === "diff" && command.args.includes("--cached")) {
        return "mail/staged.js\n";
      }

      if (command.args[0] === "diff") {
        return "mail/unstaged.js\n";
      }

      if (command.args[0] === "ls-files") {
        return "mail/new.js\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const allResponse = await fetch(new URL("api/lint", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", mode: "all" }),
  });
  const allStart = await allResponse.json();
  assert.equal(allStart.ok, true);
  assert.equal(allStart.mode, "all");

  const allSession = await waitForMachSession(
    new URL(`api/lint/${allStart.id}?token=secret`, serverInfo.url),
    (item) => item.status === "complete",
  );
  assert.equal(allSession.message, "Lint all complete.");
  assert.match(
    allSession.output,
    /\$ \.\.\/mach commlint build calendar chat docs mail tools --fix/,
  );

  const outgoingResponse = await fetch(new URL("api/lint", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", mode: "outgoing" }),
  });
  const outgoingStart = await outgoingResponse.json();
  assert.equal(outgoingStart.ok, true);
  assert.equal(outgoingStart.mode, "outgoing");

  const outgoingSession = await waitForMachSession(
    new URL(`api/lint/${outgoingStart.id}?token=secret`, serverInfo.url),
    (item) => item.status === "complete",
  );
  assert.equal(outgoingSession.message, "Lint changed files complete.");
  assert.match(
    outgoingSession.output,
    /\$ \.\.\/mach commlint mail\/current\.js mail\/unstaged\.js mail\/staged\.js mail\/new\.js --fix/,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.args.join(" ") ===
          "commlint build calendar chat docs mail tools --fix",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.args.join(" ") ===
          "commlint mail/current.js mail/unstaged.js mail/staged.js mail/new.js --fix",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server runs test sessions and reports failed files", async (t) => {
  const calls = [];
  const failureOutput = [
    "Unexpected Results",
    "==================",
    "\x1b(B\x1b[31mFAIL mail/test/browser/folder-display/browser_messagePaneVisibility.js:42 | expected visible pane\x1b[0m",
    "Passed: 7",
    "Failed: 1",
    "Todo: 0",
  ].join("\n");
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd.endsWith("mach")) {
        if (
          command.args.includes("mail/components/accountcreation/test/browser")
        ) {
          const error = new Error("mach test failed");

          error.stdout = failureOutput;
          error.stderr = "";
          throw error;
        }

        return "Passed: 1\nFailed: 0\n";
      }

      if (command.args[0] === "merge-base") {
        return "base\n";
      }

      if (command.args[0] === "diff" && command.args[1] === "--name-only") {
        return [
          "mail/components/accountcreation/content/emailWizard.js",
          "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
        ].join("\n");
      }

      if (command.args[0] === "status") {
        return "";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/test", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: { flavor: "browser", headless: true },
    }),
  });
  const start = await startResponse.json();
  assert.equal(start.ok, true);

  const statusUrl = new URL(
    `api/test/${start.id}?token=secret`,
    serverInfo.url,
  );
  const failedSession = await waitForMachSession(
    statusUrl,
    (item) => item.status === "error",
  );

  assert.deepEqual(failedSession.targets, [
    "mail/components/accountcreation/test/browser",
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  ]);
  assert.equal(failedSession.summary.status, "failed");
  assert.equal(failedSession.options.headless, true);
  assert.equal(failedSession.summary.passed, 7);
  assert.equal(failedSession.summary.failureCount, 1);
  assert.equal(failedSession.canRerunFailures, true);
  assert.equal(
    failedSession.failures[0].path,
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(failedSession.failures[0].lineNumber, 42);
  assert.equal(
    failedSession.failures[0].vscodeUrl,
    "vscode://file//repo/comm/mail/test/browser/folder-display/browser_messagePaneVisibility.js:42",
  );
  assert.equal(
    failedSession.failedFiles[0].path,
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  );
  assert.equal(failedSession.failedFiles[0].failureCount, 1);
  assert.equal(
    failedSession.output.includes(
      "\x1b[31mFAIL mail/test/browser/folder-display/browser_messagePaneVisibility.js",
    ),
    true,
  );
  assert.equal(failedSession.output.includes("(B"), false);
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.args.join(" ") ===
          "test --headless mail/components/accountcreation/test/browser mail/test/browser/folder-display/browser_messagePaneVisibility.js",
    ),
    true,
  );

  const rerunResponse = await fetch(new URL("api/test", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        pattern: [failedSession.failures[0].path],
      },
    }),
  });
  const rerunStart = await rerunResponse.json();
  const rerunSession = await waitForMachSession(
    new URL(`api/test/${rerunStart.id}?token=secret`, serverInfo.url),
    (item) => item.status === "complete",
  );

  assert.deepEqual(rerunSession.targets, [
    "mail/test/browser/folder-display/browser_messagePaneVisibility.js",
  ]);
  assert.equal(rerunSession.summary.status, "passed");
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.args.join(" ") ===
          "test mail/test/browser/folder-display/browser_messagePaneVisibility.js",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server creates new patch branches and assigns bugs", async (t) => {
  const calls = [];
  const bugUpdates = [];
  const branches = new Map([
    ["/repo/comm", "topic"],
    ["/repo/firefox", "central-work"],
  ]);
  const hashes = new Map([
    ["/repo/comm", "abc123abc123abc123abc123abc123abc123abcd"],
    ["/repo/firefox", "def456def456def456def456def456def456def456"],
  ]);
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "topic",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
      {
        label: "firefox",
        path: "/repo/firefox",
        branch: "central-work",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    appConfig: {
      bugzilla: {
        user: "dev@example.com",
        apiKey: "secret-key",
      },
    },
    updateBug: async (bugId, update) => {
      bugUpdates.push([bugId, update]);
      return { id: bugId };
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "fetch" || command.args[0] === "pull") {
        return "";
      }

      if (command.args[0] === "switch" && command.args[1] === "-c") {
        branches.set(command.cwd, command.args[2]);
        return "";
      }

      if (command.args[0] === "switch") {
        branches.set(command.cwd, command.args[1]);
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return `${branches.get(command.cwd) || "main"}\n`;
      }

      if (command.args[0] === "rev-parse") {
        return `${hashes.get(command.cwd)}\n`;
      }

      if (command.args[0] === "for-each-ref") {
        return "main\nBug-1234567\nBug-1234567_2\n";
      }

      if (command.args[0] === "log") {
        const hash = hashes.get(command.cwd);
        const branch = branches.get(command.cwd);

        return `\x1e${hash}\x1f\x1fHEAD -> ${branch}\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 1234567 - New patch\n`;
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/new-patch", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        bugId: "1234567",
        update: true,
      },
      snapshotLimits: [1, 1],
    }),
  });
  const start = await startResponse.json();

  assert.equal(start.ok, true);
  assert.equal(start.bugId, "1234567");

  const session = await waitForMachSession(
    new URL(`api/new-patch/${start.id}?token=secret`, serverInfo.url),
    (item) => item.status === "complete",
  );
  assert.equal(session.branch, "Bug-1234567_3");
  assert.equal(session.message, "Created Bug-1234567_3.");
  assert.equal(session.snapshots[0].branch, "Bug-1234567_3");
  assert.equal(session.snapshots[1].branch, "main");
  assert.deepEqual(bugUpdates, [
    [
      "1234567",
      {
        assigned_to: "dev@example.com",
        status: "ASSIGNED",
      },
    ],
  ]);
  assert.match(session.output, /Updating checkouts from origin\/main/);
  assert.match(session.output, /Created branch Bug-1234567_3\./);
  assert.match(session.output, /Assigning bug 1234567 to dev@example\.com\./);
  assert.equal(
    calls.some(
      (call) =>
        call.cwd === "/repo/comm" &&
        call.args.join(" ") === "switch -c Bug-1234567_3",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cwd === "/repo/firefox" &&
        call.args.join(" ") === "pull --ff-only origin main",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server pulls patches through browser prompts", async (t) => {
  const calls = [];
  let branch = "main";
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd === "moz-phab") {
        const error = new Error("patch failed");

        error.stdout = "partial patch output\n";
        error.stderr = "patch failed\n";
        throw error;
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return `${branch}\n`;
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "HEAD") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      if (command.args[0] === "update-ref") {
        return "";
      }

      if (command.args[0] === "switch" && command.args[1] === "-c") {
        branch = command.args[2];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1] === "--detach" ? "" : command.args[1];
        return "";
      }

      if (command.args[0] === "reset" || command.args[0] === "clean") {
        return "";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123abc123abc123abc123abc123abc123abcd\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 1234567 - Pulled patch\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/patch", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        revision: "123456",
        bug: "1234567",
        applyTo: "here",
        diffId: "42",
        name: "Bug-1234567",
        noCommit: true,
        includeAbandoned: true,
        safeMode: true,
        forceVcs: true,
      },
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();

  assert.equal(start.ok, true);
  assert.equal(start.revision, "D123456");

  const statusUrl = new URL(
    `api/patch/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForMachSession(
    statusUrl,
    (item) => item.status === "prompt",
  );
  assert.equal(
    session.prompt.message,
    "Patch failed. Roll back to checkpoint? [y/n]:",
  );
  assert.match(
    session.output,
    /\$ moz-phab patch D123456 --apply-to here --diff-id 42 --name Bug-1234567 --no-commit --include-abandoned --safe-mode --force-vcs/,
  );
  assert.doesNotMatch(session.output, /--yes/);
  assert.equal(
    calls.some(
      (call) =>
        call.cmd === "git" && call.args.join(" ") === "switch -c Bug-1234567",
    ),
    true,
  );

  const answerResponse = await fetch(
    new URL(`api/patch/${start.id}/answer`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        promptId: session.prompt.id,
        answer: true,
      }),
    },
  );
  session = await answerResponse.json();
  assert.equal(session.status, "running");

  session = await waitForMachSession(
    statusUrl,
    (item) => item.status === "error",
  );
  assert.equal(session.message, "patch failed");
  assert.match(session.output, /Rolled back to abc123abc123\./);
  assert.equal(
    session.snapshot.commits[0].hash,
    "abc123abc123abc123abc123abc123abc123abcd",
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd === "git" &&
        call.args.join(" ") ===
          "reset --hard abc123abc123abc123abc123abc123abc123abcd",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) => call.cmd === "git" && call.args.join(" ") === "clean -fd",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server starts a try session and refreshes try links", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-server-try-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd.endsWith("mach")) {
        return "Created try push: https://treeherder.mozilla.org/jobs?repo=try&revision=server\n";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return storePath;
      }

      if (command.args[0] === "rev-parse") {
        return "abc123\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Server try. r=#reviewers\n";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Server try\n";
      }

      if (command.cmd === "sh") {
        return "server-patch-id abc123\n";
      }

      return "";
    },
  });

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/try", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        selector: "auto",
        "tasks-regex": "browser",
        artifact: true,
      },
      snapshotLimit: 1,
    }),
  });
  const start = await startResponse.json();
  assert.equal(start.ok, true);
  assert.equal(start.status, "running");

  const session = await waitForMachSession(
    new URL(`api/try/${start.id}?token=secret`, serverInfo.url),
    (item) => item.status === "complete",
  );
  assert.equal(
    session.tryRun.url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=server",
  );
  assert.equal(
    session.snapshot.commits[0].tryRuns[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=server",
  );
  assert.match(
    session.output,
    /\$ \.\.\/mach try auto --tasks-regex browser --artifact/,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.args.join(" ") === "try auto --tasks-regex browser --artifact",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server lands patches through browser prompts", async (t) => {
  const calls = [];
  const pushes = [];
  let transactionSearches = 0;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBugs: async () => [
      {
        id: "123456",
        summary: "Fix the landing flow",
        target_milestone: "128 Branch",
      },
    ],
    getAttachments: async () => [
      {
        content_type: "text/x-phabricator-request",
        file_name: "D987654.diff",
      },
    ],
    phab: async ({ route }) => {
      if (route === "differential.query") {
        return {
          result: [
            {
              id: 987654,
              phid: "PHID-DREV-landing",
              uri: "https://phabricator.services.mozilla.com/D987654",
              statusName: "Accepted",
              title: "Bug 123456 - Fix the landing flow. r=#reviewers",
              reviewers: {
                "PHID-USER-reviewer": true,
              },
            },
          ],
        };
      }

      if (route === "transaction.search") {
        transactionSearches++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          result: {
            data: [
              {
                type: "comment",
                dateCreated: 1700000000,
                comments: [
                  {
                    content: {
                      raw: "Treeherder https://treeherder.mozilla.org/jobs?repo=try&revision=landing",
                    },
                  },
                ],
              },
              {
                type: "update",
                dateCreated: 1700000600,
                summary: "updated the diff",
              },
            ],
          },
        };
      }

      if (route === "user.query") {
        return {
          result: [
            {
              userName: "alice",
            },
          ],
        };
      }

      return { result: [] };
    },
    pushCommits: async (options) => {
      pushes.push(options);
      return "Lando stack: https://lando.mozilla.org/D987654\n";
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd === "moz-phab") {
        return "patched D987654\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "fetch" ||
        command.args[0] === "switch" ||
        command.args[0] === "pull" ||
        command.args[0] === "update-ref"
      ) {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123456 - Fix the landing flow. r=#reviewers\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n";
      }

      if (command.args[0] === "log" && command.args.includes("--oneline")) {
        return "def456 Bug 123456 - Fix the landing flow. r=alice\n";
      }

      if (command.args[0] === "log") {
        return "\x1edef456\x1fabc123\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123456 - Fix the landing flow. r=alice\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "--amend") {
        return "[main def456] Bug 123456 - Fix the landing flow. r=alice\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  async function answer(session, value) {
    const response = await fetch(
      new URL(`api/land/${session.id}/answer`, serverInfo.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "secret",
          promptId: session.prompt.id,
          answer: value,
        }),
      },
    );

    return response.json();
  }

  const startResponse = await fetch(new URL("api/land", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        landoRepo: "test-lando",
      },
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();
  assert.equal(start.ok, true);
  assert.equal(start.status, "running");

  const statusUrl = new URL(
    `api/land/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForLandSession(
    statusUrl,
    (item) => item.prompt?.kind === "patch-select",
  );
  const patchChoice = session.prompt.choices.find(
    (choice) => choice.id === "patch:123456:987654",
  );

  assert.equal(Boolean(patchChoice), true);
  assert.equal(patchChoice.mergeAnswer, "merge:123456:987654");
  assert.equal(
    patchChoice.links[0].url,
    "https://bugzilla.mozilla.org/show_bug.cgi?id=123456",
  );
  assert.equal(
    patchChoice.links[1].url,
    "https://phabricator.services.mozilla.com/D987654",
  );
  assert.equal(patchChoice.tryStatus.state, "pending");
  assert.equal(transactionSearches, 0);

  const tryStatusUrl = new URL(
    `api/land/${session.id}/patch/123456/987654/try-status?token=secret`,
    serverInfo.url,
  );
  const [tryStatusResponse, duplicateTryStatusResponse] = await Promise.all([
    fetch(tryStatusUrl),
    fetch(tryStatusUrl),
  ]);
  const [tryStatusResult, duplicateTryStatusResult] = await Promise.all([
    tryStatusResponse.json(),
    duplicateTryStatusResponse.json(),
  ]);

  assert.equal(tryStatusResponse.ok, true);
  assert.equal(duplicateTryStatusResponse.ok, true);
  assert.equal(tryStatusResult.tryStatus.state, "stale");
  assert.equal(duplicateTryStatusResult.tryStatus.state, "stale");
  assert.equal(
    tryStatusResult.tryStatus.latestTryRun.url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=landing",
  );
  assert.equal(transactionSearches, 1);

  const cachedTryStatusResponse = await fetch(
    tryStatusUrl,
  );
  const cachedTryStatusResult = await cachedTryStatusResponse.json();

  assert.equal(cachedTryStatusResponse.ok, true);
  assert.equal(cachedTryStatusResult.tryStatus.state, "stale");
  assert.equal(transactionSearches, 1);
  assert.equal(
    session.prompt.actions.some((action) => action.id === "continue"),
    true,
  );
  assert.equal(
    session.prompt.actions.some((action) => action.id === "abort"),
    true,
  );
  assert.equal(
    session.prompt.choices.some((choice) => choice.id === "continue"),
    false,
  );
  assert.equal(
    session.prompt.choices.some((choice) => choice.id === "abort"),
    false,
  );

  session = await answer(session, "merge:123456:987654");
  session = await waitForLandSession(
    statusUrl,
    (item) => item.prompt?.message === "Do you want to run lint?",
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd === "moz-phab" &&
        call.args.join(" ") ===
          "patch D987654 --skip-dependencies --apply-to here",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.args[0] === "commit" &&
        call.args[1] === "--amend" &&
        call.args.some((arg) =>
          String(arg).includes("Bug 123456 - Fix the landing flow. r=alice"),
        ),
    ),
    true,
  );

  session = await answer(session, false);
  session = await waitForLandSession(
    statusUrl,
    (item) => item.prompt?.message === "Do you want to run build?",
  );
  session = await answer(session, false);
  session = await waitForLandSession(
    statusUrl,
    (item) => item.prompt?.kind === "approval",
  );
  assert.match(session.prompt.detail, /def456 Bug 123456/);

  session = await answer(session, "approve");
  session = await waitForLandSession(
    statusUrl,
    (item) => item.status === "complete",
  );
  assert.equal(session.message, "Landing complete.");
  assert.equal(session.links[0].url, "https://lando.mozilla.org/D987654");
  assert.equal(session.snapshots[0].commits[0].hash, "def456");
  assert.deepEqual(pushes, [
    {
      landoRepo: "test-lando",
      relbranch: undefined,
      localRepo: "/repo/comm",
      yes: true,
    },
  ]);

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph landing applies rust update patches before fetching checkin bugs", async (t) => {
  const events = [];
  let rustChecks = 0;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBugs: async () => {
      events.push("get-bugs");
      return [];
    },
    phab: async ({ route, params }) => {
      if (
        route === "differential.query" &&
        Array.isArray(params?.authors)
      ) {
        events.push("rust-query");
        assert.deepEqual(params, {
          authors: ["PHID-USER-3zyedh2kyrzsg5v6bc4p"],
          status: "status-open",
        });
        return {
          result: [
            {
              id: 111111,
              uri: "https://phabricator.services.mozilla.com/D111111",
              title: "No bug - Update vendored Rust dependencies",
            },
          ],
        };
      }

      return { result: [] };
    },
    runCommand: async (command) => {
      if (command.cmd.endsWith("mach")) {
        assert.deepEqual(command.args, ["tb-rust", "check-upstream"]);
        rustChecks++;
        events.push(`rust-check-${rustChecks}`);

        if (rustChecks < 4) {
          const error = new Error("rust out of date");

          error.stderr = "Rust dependencies are out of date\n";
          throw error;
        }

        return "Rust dependencies match upstream\n";
      }

      if (command.cmd === "moz-phab") {
        events.push("rust-patch");
        assert.equal(
          command.args.join(" "),
          "patch D111111 --skip-dependencies --apply-to here",
        );
        return "patched D111111\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "fetch" ||
        command.args[0] === "switch" ||
        command.args[0] === "pull" ||
        command.args[0] === "update-ref"
      ) {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/land", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();
  const statusUrl = new URL(
    `api/land/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForLandSession(
    statusUrl,
    (item) =>
      item.prompt?.message ===
      "No bugs are marked for checkin. Bump build/dummy instead?",
  );

  assert.deepEqual(events, [
    "rust-check-1",
    "rust-check-2",
    "rust-query",
    "rust-check-3",
    "rust-patch",
    "rust-check-4",
    "get-bugs",
  ]);
  assert.match(session.output, /Applying rust update patch D111111/);

  const answerResponse = await fetch(
    new URL(`api/land/${session.id}/answer`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        promptId: session.prompt.id,
        answer: false,
      }),
    },
  );
  session = await answerResponse.json();
  session = await waitForLandSession(
    statusUrl,
    (item) => item.status === "complete",
  );
  assert.equal(session.message, "No bugs marked for checkin.");

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph landing never loads patches from the rust update bug", async (t) => {
  const events = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBugs: async () => {
      events.push("get-bugs");
      return [
        {
          id: "1878375",
          summary: "Synchronize vendored Rust libraries",
          target_milestone: "---",
        },
      ];
    },
    getAttachments: async (bugId) => {
      events.push(`attachments-${bugId}`);
      assert.notEqual(
        String(bugId),
        "1878375",
        "Bug 1878375 has too many patches and must never be expanded.",
      );
      return [];
    },
    phab: async () => {
      assert.fail("The rust update bug should not load Phabricator patches.");
    },
    runCommand: async (command) => {
      if (command.cmd.endsWith("mach")) {
        assert.deepEqual(command.args, ["tb-rust", "check-upstream"]);
        events.push("rust-check");
        return "Rust dependencies match upstream\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "fetch" ||
        command.args[0] === "switch" ||
        command.args[0] === "pull" ||
        command.args[0] === "update-ref"
      ) {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/land", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();
  const statusUrl = new URL(
    `api/land/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForLandSession(
    statusUrl,
    (item) =>
      item.prompt?.message ===
      "No bugs are marked for checkin. Bump build/dummy instead?",
  );

  assert.deepEqual(events, ["rust-check", "get-bugs"]);
  assert.match(
    session.output,
    /Skipping bug 1878375; rust update patches are handled by the rust dependency preflight\./,
  );

  const answerResponse = await fetch(
    new URL(`api/land/${session.id}/answer`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        promptId: session.prompt.id,
        answer: false,
      }),
    },
  );
  session = await answerResponse.json();
  session = await waitForLandSession(
    statusUrl,
    (item) => item.status === "complete",
  );
  assert.equal(session.message, "No bugs marked for checkin.");

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph landing rechecks rust after refreshing comm before querying Phabricator", async (t) => {
  const events = [];
  let rustChecks = 0;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBugs: async () => {
      events.push("get-bugs");
      return [];
    },
    phab: async () => {
      assert.fail("Phabricator rust patch lookup should not run after comm refresh fixes rust.");
    },
    runCommand: async (command) => {
      if (command.cmd.endsWith("mach")) {
        assert.deepEqual(command.args, ["tb-rust", "check-upstream"]);
        rustChecks++;
        events.push(`rust-check-${rustChecks}`);

        if (rustChecks === 1) {
          const error = new Error("rust out of date");

          error.stderr = "Rust dependencies are out of date\n";
          throw error;
        }

        return "Rust dependencies match upstream\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "fetch" ||
        command.args[0] === "switch" ||
        command.args[0] === "pull" ||
        command.args[0] === "update-ref"
      ) {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/land", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();
  const statusUrl = new URL(
    `api/land/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForLandSession(
    statusUrl,
    (item) =>
      item.prompt?.message ===
      "No bugs are marked for checkin. Bump build/dummy instead?",
  );

  assert.deepEqual(events, ["rust-check-1", "rust-check-2", "get-bugs"]);

  const answerResponse = await fetch(
    new URL(`api/land/${session.id}/answer`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        promptId: session.prompt.id,
        answer: false,
      }),
    },
  );
  session = await answerResponse.json();
  session = await waitForLandSession(
    statusUrl,
    (item) => item.status === "complete",
  );
  assert.equal(session.message, "No bugs marked for checkin.");

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph landing falls back to a manual rust patch after Phabricator rate limits", async (t) => {
  const events = [];
  let rustChecks = 0;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBugs: async () => {
      events.push("get-bugs");
      return [];
    },
    phab: async ({ route, params }) => {
      if (
        route === "differential.query" &&
        Array.isArray(params?.authors)
      ) {
        events.push("rust-query");
        const error = new Error("Phabricator differential.query failed (429): {}");

        error.statusCode = 429;
        throw error;
      }

      return { result: [] };
    },
    runCommand: async (command) => {
      if (command.cmd.endsWith("mach")) {
        assert.deepEqual(command.args, ["tb-rust", "check-upstream"]);
        rustChecks++;
        events.push(`rust-check-${rustChecks}`);

        if (rustChecks < 4) {
          const error = new Error("rust out of date");

          error.stderr = "Rust dependencies are out of date\n";
          throw error;
        }

        return "Rust dependencies match upstream\n";
      }

      if (command.cmd === "moz-phab") {
        events.push("manual-rust-patch");
        assert.equal(
          command.args.join(" "),
          "patch D222222 --skip-dependencies --apply-to here",
        );
        return "patched D222222\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "fetch" ||
        command.args[0] === "switch" ||
        command.args[0] === "pull" ||
        command.args[0] === "update-ref"
      ) {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/land", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();
  const statusUrl = new URL(
    `api/land/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForLandSession(
    statusUrl,
    (item) =>
      item.prompt?.message ===
      "Enter a rust update Phabricator revision to apply, or leave blank to abort.",
  );

  assert.deepEqual(events, ["rust-check-1", "rust-check-2", "rust-query"]);
  assert.match(session.output, /Automatic rust patch lookup was rate limited/);

  const patchResponse = await fetch(
    new URL(`api/land/${session.id}/answer`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        promptId: session.prompt.id,
        answer: "D222222",
      }),
    },
  );
  session = await patchResponse.json();
  session = await waitForLandSession(
    statusUrl,
    (item) =>
      item.prompt?.message ===
      "No bugs are marked for checkin. Bump build/dummy instead?",
  );

  assert.deepEqual(events, [
    "rust-check-1",
    "rust-check-2",
    "rust-query",
    "rust-check-3",
    "manual-rust-patch",
    "rust-check-4",
    "get-bugs",
  ]);

  const answerResponse = await fetch(
    new URL(`api/land/${session.id}/answer`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        promptId: session.prompt.id,
        answer: false,
      }),
    },
  );
  session = await answerResponse.json();
  session = await waitForLandSession(
    statusUrl,
    (item) => item.status === "complete",
  );
  assert.equal(session.message, "No bugs marked for checkin.");

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server cancels landing sessions waiting on browser prompts", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getBugs: async () => [],
    runCommand: async (command) => {
      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "fetch" ||
        command.args[0] === "switch" ||
        command.args[0] === "pull" ||
        command.args[0] === "update-ref"
      ) {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123abc123abc123abc123abc123abc123abcd\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/land", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      snapshotLimits: [1],
    }),
  });
  const start = await startResponse.json();
  const statusUrl = new URL(
    `api/land/${start.id}?token=secret`,
    serverInfo.url,
  );
  const waiting = await waitForLandSession(
    statusUrl,
    (item) =>
      item.prompt?.message ===
      "No bugs are marked for checkin. Bump build/dummy instead?",
  );

  assert.equal(waiting.status, "prompt");

  const cancelResponse = await fetch(
    new URL(`api/land/${start.id}/cancel`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    },
  );
  const canceled = await cancelResponse.json();

  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.message, "Landing canceled.");
  assert.equal(canceled.prompt, null);
  assert.match(canceled.output, /Landing canceled\./);

  const afterCancel = await waitForLandSession(
    statusUrl,
    (item) => item.status === "canceled",
  );
  assert.equal(afterCancel.status, "canceled");

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server cools down rate-limited reviewer search routes", async (t) => {
  const phabCalls = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "Bug-1234567",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    phab: async (request) => {
      phabCalls.push([request.route, request.params.constraints.query]);

      if (request.route === "user.search") {
        throw new Error("Phabricator user.search failed (429): {}");
      }

      return {
        result: {
          data: [
            {
              phid: `PHID-PROJ-${request.params.constraints.query}`,
              fields: {
                slug: `${request.params.constraints.query}-reviewers`,
                name: `${request.params.constraints.query} Reviewers`,
              },
            },
          ],
        },
      };
    },
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const firstResponse = await fetch(
    new URL("api/commit/reviewers?query=mail&token=secret", serverInfo.url),
  );
  const first = await firstResponse.json();
  const secondResponse = await fetch(
    new URL("api/commit/reviewers?query=calendar&token=secret", serverInfo.url),
  );
  const second = await secondResponse.json();
  const groupUrl = new URL("api/commit/reviewers", serverInfo.url);
  groupUrl.searchParams.set("query", "#mail");
  groupUrl.searchParams.set("token", "secret");
  const groupResponse = await fetch(groupUrl);
  const group = await groupResponse.json();

  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, true);
  assert.equal(groupResponse.ok, true);
  assert.equal(first.rateLimited, true);
  assert.equal(second.rateLimited, true);
  assert.equal(group.rateLimited, false);
  assert.equal(first.rateLimitedRoute, "user.search");
  assert.equal(second.rateLimitedRoute, "user.search");
  assert.equal(first.retryAfterMs > 0, true);
  assert.deepEqual(
    first.reviewers.map((reviewer) => reviewer.value),
    [],
  );
  assert.deepEqual(
    second.reviewers.map((reviewer) => reviewer.value),
    [],
  );
  assert.deepEqual(
    group.reviewers.map((reviewer) => reviewer.value),
    ["#mail-reviewers"],
  );
  assert.deepEqual(phabCalls, [
    ["user.search", "mail"],
    ["project.search", "mail"],
  ]);
});

test("interactive graph server creates commits with Phabricator reviewer suggestions", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-commit-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const phabCalls = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "Bug-1234567",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    phab: async (request) => {
      phabCalls.push(request);

      if (request.route === "user.search") {
        return {
          result: {
            data: [
              {
                phid: "PHID-USER-aleca",
                fields: {
                  username: "aleca",
                  realName: "Alice Example",
                },
              },
            ],
          },
        };
      }

      assert.equal(request.route, "project.search");
      return {
        result: {
          data: [
            {
              phid: "PHID-PROJ-mail",
              fields: {
                slug: "mail-reviewers",
                name: "Mail Reviewers",
              },
            },
          ],
        },
      };
    },
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "Bug-1234567\n";
      }

      if (command.args[0] === "add") {
        return "";
      }

      if (command.args[0] === "commit") {
        assert.deepEqual(command.args, [
          "commit",
          "-m",
          "Bug 1234567 - Fix folder keyboard flow. r=aleca!,#mail-reviewers",
        ]);
        return "[Bug-1234567 def456] Bug 1234567 - Fix folder keyboard flow. r=aleca!,#mail-reviewers\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return storePath;
      }

      if (command.args[0] === "rev-parse") {
        return "def4567890abcdef\n";
      }

      if (command.args[0] === "log") {
        return "\x1edef4567890abcdef\x1f\x1fHEAD -> Bug-1234567\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 1234567 - Fix folder keyboard flow\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "";
    },
  });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const metadataResponse = await fetch(
    new URL("api/commit/metadata?token=secret", serverInfo.url),
  );
  const metadata = await metadataResponse.json();

  assert.equal(metadata.ok, true);
  assert.equal(metadata.metadata.bugRequired, false);
  assert.equal(metadata.metadata.bugId, "1234567");

  const userReviewerResponse = await fetch(
    new URL("api/commit/reviewers?query=alec&token=secret", serverInfo.url),
  );
  const userReviewers = await userReviewerResponse.json();
  const groupReviewerUrl = new URL("api/commit/reviewers", serverInfo.url);
  groupReviewerUrl.searchParams.set("query", "#mail");
  groupReviewerUrl.searchParams.set("token", "secret");
  const groupReviewerResponse = await fetch(groupReviewerUrl);
  const groupReviewers = await groupReviewerResponse.json();

  assert.equal(userReviewerResponse.ok, true);
  assert.equal(groupReviewerResponse.ok, true);
  assert.equal(userReviewers.rateLimited, false);
  assert.equal(groupReviewers.rateLimited, false);
  assert.deepEqual(
    userReviewers.reviewers.map((reviewer) => reviewer.value),
    ["aleca"],
  );
  assert.deepEqual(
    groupReviewers.reviewers.map((reviewer) => reviewer.value),
    ["#mail-reviewers"],
  );
  assert.deepEqual(
    phabCalls.map((call) => [call.route, call.params.constraints]),
    [
      ["user.search", { query: "alec" }],
      ["project.search", { query: "mail" }],
    ],
  );

  const commitResponse = await fetch(new URL("api/commit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        summary: "Fix folder keyboard flow",
        reviewers: [{ value: "aleca", blocking: true }, "#mail-reviewers"],
      },
      snapshotLimits: [1],
    }),
  });
  const commit = await commitResponse.json();

  assert.equal(commit.ok, true);
  assert.equal(commit.hash, "def4567890abcdef");
  assert.equal(
    commit.commitMessage,
    "Bug 1234567 - Fix folder keyboard flow. r=aleca!,#mail-reviewers",
  );
  assert.equal(commit.snapshots[0].branch, "Bug-1234567");
  assert.equal(commit.snapshots[0].commits[0].hash, "def4567890abcdef");
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "add").map((call) => call.args),
    [["add", "-A"]],
  );
});

test("interactive graph server submits current commit through browser prompts", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-submit-try-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const comments = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    postComment: async (comment) => {
      comments.push(comment);
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd === "moz-phab") {
        return "Submitted https://phabricator.services.mozilla.com/D123456\n";
      }

      if (command.cmd.endsWith("mach")) {
        return "Created try push: https://treeherder.mozilla.org/jobs?repo=try&revision=abc\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return "main\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return storePath;
      }

      if (command.args[0] === "rev-parse") {
        return "abc123\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Submit me. r=#reviewers\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Submit me\n";
      }

      if (command.cmd === "sh") {
        return "submit-patch-id abc123\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "";
    },
  });
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/submit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      hash: "abc123",
      snapshotLimit: 1,
    }),
  });
  const start = await startResponse.json();
  assert.equal(start.ok, true);

  const sessionUrl = new URL(
    `api/submit/${start.id}?token=secret`,
    serverInfo.url,
  );
  let session = await waitForSubmitSession(
    sessionUrl,
    (item) => item.status === "prompt",
  );
  assert.equal(session.prompt.message, "Do you want to run lint? [y/n]:");

  for (const answer of [false, false, true, true]) {
    const answerResponse = await fetch(
      new URL(`api/submit/${start.id}/answer`, serverInfo.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "secret",
          promptId: session.prompt.id,
          answer,
        }),
      },
    );
    assert.equal(answerResponse.ok, true);
    session = await waitForSubmitSession(
      sessionUrl,
      (item) =>
        item.status === "prompt" ||
        item.status === "complete" ||
        item.status === "error",
    );

    if (session.status === "complete") {
      break;
    }

    assert.equal(session.status, "prompt");
  }

  assert.equal(session.status, "complete");
  assert.match(session.output, /\$ moz-phab submit/);
  assert.match(
    session.output,
    /Submitted https:\/\/phabricator\.services\.mozilla\.com\/D123456/,
  );
  assert.match(session.output, /\$ \.\.\/mach try auto --artifact/);
  assert.match(
    session.output,
    /Created try push: https:\/\/treeherder\.mozilla\.org\/jobs\?repo=try&revision=abc/,
  );
  assert.deepEqual(session.links, [
    {
      label: "D123456",
      url: "https://phabricator.services.mozilla.com/D123456",
    },
    {
      label: "Try",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
    },
  ]);
  assert.equal(session.snapshot.branch, "main");
  assert.equal(session.snapshot.commits[0].hash, "abc123");
  assert.equal(
    session.snapshot.commits[0].tryRuns[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
  );
  assert.deepEqual(comments, [
    {
      message: "try: https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
      resolve: true,
      id: "123456",
    },
  ]);
  assert.equal(
    calls.some(
      (call) =>
        call.cmd === "moz-phab" && call.cwd === "/repo/comm" && call.capture,
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.cwd === "/repo/comm" &&
        call.args.join(" ") === "try auto --artifact",
    ),
    true,
  );

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server closes when page heartbeats stop", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 30,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async () => "",
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const pageResponse = await fetch(serverInfo.url);
  assert.equal(pageResponse.ok, true);

  await new Promise((resolve) => serverInfo.server.once("close", resolve));
  assert.equal(serverInfo.server.listening, false);
  assert.equal(
    serverInfo.server.closeReason,
    "browser heartbeat timed out after 1 second",
  );
});

test("interactive graph server survives refreshes and multiple browser clients", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    clientDisconnectGraceMs: 80,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async () => "",
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  async function ping(clientId) {
    const response = await fetch(new URL("api/ping", serverInfo.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", clientId }),
    });

    assert.equal(response.ok, true);
    return response.json();
  }

  async function close(clientId) {
    const response = await fetch(new URL("api/close", serverInfo.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", clientId }),
    });

    assert.equal(response.ok, true);
    return response.json();
  }

  assert.deepEqual(await ping("tab-one"), { ok: true, clientId: "tab-one" });
  assert.deepEqual(await ping("tab-two"), { ok: true, clientId: "tab-two" });
  assert.deepEqual(await close("tab-one"), { ok: true, remainingClients: 1 });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(serverInfo.server.listening, true);

  assert.deepEqual(await close("tab-two"), { ok: true, remainingClients: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await ping("tab-three"), {
    ok: true,
    clientId: "tab-three",
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(serverInfo.server.listening, true);

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  assert.deepEqual(await close("tab-three"), { ok: true, remainingClients: 0 });
  await closePromise;

  assert.equal(serverInfo.server.listening, false);
  assert.equal(serverInfo.server.closeReason, "all browser tabs closed");
});

test("waitForInteractiveServerClose routes signals through the interactive shutdown hook", async () => {
  const signals = new EventEmitter();
  const server = new EventEmitter();
  const calls = [];

  server.listening = true;
  server.shutdown = (delay, reason) => {
    calls.push({ delay, reason });
    server.closeReason = reason;
    server.listening = false;
    queueMicrotask(() => server.emit("close"));
  };
  server.close = () => {
    throw new Error(
      "waitForInteractiveServerClose should use server.shutdown when available",
    );
  };

  const wait = waitForInteractiveServerClose(server, signals);
  signals.emit("SIGINT");
  const closeReason = await wait;

  assert.equal(closeReason, "terminal signal received");
  assert.deepEqual(calls, [{ delay: 0, reason: "terminal signal received" }]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("console command serves interactive mode without writing static output", async () => {
  const calls = [];
  const command = createConsoleCommand({
    getCheckoutMetadata: async ({ label }) => ({
      label,
      path: `/repo/${label}`,
      branch: "main",
      commitCount: 0,
      commits: [],
      diffs: {},
    }),
    makeDir: async () => calls.push(["mkdir"]),
    write: async () => calls.push(["write"]),
    open: async (url) => calls.push(["open", url]),
    makeToken: () => "secret",
    log: () => {},
    startServer: async ({ html, token, pageSize }) => {
      calls.push([
        "server",
        /id="graph-config"/.test(html),
        /\/assets\/graph-client\/init\.js/.test(html),
        token,
        pageSize,
      ]);
      return {
        url: "http://127.0.0.1:1234/",
        server: {},
      };
    },
    waitForClose: async (server) => calls.push(["wait", server]),
  });

  const url = await command({ pageSize: 25 });

  assert.equal(url, "http://127.0.0.1:1234/");
  assert.deepEqual(calls, [
    ["server", true, true, "secret", 25],
    ["open", "http://127.0.0.1:1234/"],
    ["wait", {}],
  ]);
});
