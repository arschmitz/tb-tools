import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  copyGraphCommitsBetweenCheckouts,
  checkoutCommit,
  continueRebaseCommit,
  createBranchForCommit,
  createGraphCommit,
  createGraphCommand,
  createPhabricatorWebSession,
  getGraphCommitMessage,
  getGraphCommitIntegrationStatus,
  isGraphCommitOnOriginMain,
  getGraphCommitReview,
  getGraphCommitMetadata,
  getGraphCurrentCommitMessage,
  getGraphDirtyCheckouts,
  discardWorkingTreeChanges,
  getGraphOriginMainStatus,
  getGraphRustUpstreamStatus,
  getGraphTryRunsForCommit,
  getInteractiveRebasePlan,
  getLandingPatchTryStatus,
  getLatestLandingPatchTryRun,
  getCheckoutCommitPage,
  getCheckoutGraphData,
  getCheckoutGraphMetadata,
  getReviewCheckoutConfig,
  getCommitDiff,
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
  syncReviewCheckoutFromWorking,
  acceptGraphPatchUpdateChange,
  applyGraphPatchUpdateComment,
  markGraphPatchUpdateCommentHandled,
  revertGraphPatchUpdateChange,
  saveGraphPatchUpdateReply,
  normalizeGraphCommitReviewers,
  getInteractiveYesNoPrompt,
  runGraphMachActionSession,
  runGraphRepositoryUpdate,
  resolveGraphCheckouts,
  runInteractiveSubmitCommand,
  serializeGraphTestSession,
  startInteractiveRebase,
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
import { expandDiffContext } from "../commands/graph/client/diff-context.js";
import {
  buildGraphHtml,
  buildInteractiveGraphLauncherHtml,
} from "../commands/graph/templates.mjs";
import {
  ensureTbToolsIdInCommitMessage,
  installTbToolsCommitMsgHook,
  TB_TOOLS_ID_TRAILER,
} from "../lib/commit-message.mjs";
import { run } from "../lib/utils.mjs";

const GRAPH_CLIENT_TEST_ASSETS = [
  { source: "style.css", output: "graph-client/style.css" },
  { source: "live-text.js", output: "graph-client/live-text.js" },
  { source: "settings.js", output: "graph-client/settings.js" },
  { source: "review-handled.js", output: "graph-client/review-handled.js" },
  { source: "ai-dialog-controls.js", output: "graph-client/ai-dialog-controls.js" },
  { source: "review-attention.js", output: "graph-client/review-attention.js" },
  { source: "config.js", output: "graph-client/config.js" },
  { source: "system-dialog.js", output: "graph-client/system-dialog.js" },
  { source: "patch-session-resume.js", output: "graph-client/patch-session-resume.js" },
  { source: "codex-run-status.js", output: "graph-client/codex-run-status.js" },
  { source: "background-jobs.js", output: "graph-client/background-jobs.js" },
  { source: "ai-task-tray.js", output: "graph-client/ai-task-tray.js" },
  { source: "commit-model.js", output: "graph-client/commit-model.js" },
  { source: "dom.js", output: "graph-client/dom.js" },
  { source: "pane-resizer.js", output: "graph-client/pane-resizer.js" },
  { source: "lane-renderer.js", output: "graph-client/lane-renderer.js" },
  { source: "diff-context.js", output: "graph-client/diff-context.js" },
  { source: "review-viewer.js", output: "graph-client/review-viewer.js" },
  { source: "diff-viewer.js", output: "graph-client/diff-viewer.js" },
  { source: "command-sessions.js", output: "graph-client/command-sessions.js" },
  { source: "update-scope-dialog.js", output: "graph-client/update-scope-dialog.js" },
  { source: "rebase-dialog.js", output: "graph-client/rebase-dialog.js" },
  { source: "interactive-rebase-dialog.js", output: "graph-client/interactive-rebase-dialog.js" },
  { source: "commit-actions.js", output: "graph-client/commit-actions.js" },
  { source: "commit-dialog.js", output: "graph-client/commit-dialog.js" },
  { source: "checkout-transfer-dialog.js", output: "graph-client/checkout-transfer-dialog.js" },
  { source: "review-sync-dialog.js", output: "graph-client/review-sync-dialog.js" },
  { source: "view-router.js", output: "graph-client/view-router.js" },
  { source: "phabricator-cache.js", output: "graph-client/phabricator-cache.js" },
  { source: "patch-update-dialog.js", output: "graph-client/patch-update-dialog.js" },
  { source: "patch-review-dialog.js", output: "graph-client/patch-review-dialog.js" },
  { source: "dashboard.js", output: "graph-client/dashboard.js" },
  { source: "implement.js", output: "graph-client/implement.js" },
  { source: "meta-board-colors.js", output: "graph-client/meta-board-colors.js" },
  { source: "markdown.js", output: "graph-client/markdown.js" },
  { source: "meta-boards.js", output: "graph-client/meta-boards.js" },
  { source: "sprints.js", output: "graph-client/sprints.js" },
  { source: "phab-auth-dialog.js", output: "graph-client/phab-auth-dialog.js" },
  { source: "landing-dialog.js", output: "graph-client/landing-dialog.js" },
  { source: "new-patch-dialog.js", output: "graph-client/new-patch-dialog.js" },
  { source: "patch-dialog.js", output: "graph-client/patch-dialog.js" },
  { source: "test-dialog.js", output: "graph-client/test-dialog.js" },
  { source: "init.js", output: "graph-client/init.js" },
];

test("isGraphCommitOnOriginMain distinguishes published commits from local work", async () => {
  const calls = [];
  const graph = { path: "/repo/comm" };

  const onMain = await isGraphCommitOnOriginMain({
    graph,
    hash: "published",
    runCommand: async (command) => {
      calls.push(command);
    },
  });
  const local = await isGraphCommitOnOriginMain({
    graph,
    hash: "local",
    runCommand: async () => {
      throw new Error("not reachable");
    },
  });

  assert.equal(onMain, true);
  assert.equal(local, false);
  assert.deepEqual(calls[0].args, [
    "merge-base",
    "--is-ancestor",
    "published",
    "origin/main",
  ]);
});

test("Patch Update amends an accepted source change before the server handles its comment", async () => {
  const item = {
    assessment: "The existing implementation needs the focused source update.",
    changeSummary: "Replace the local implementation with the shared helper.",
    id: "inline:1",
    state: "ready",
    requiresChanges: true,
  };
  const session = {
    aiEnabled: true,
    codexSessionId: "thread-1",
    codexAgent: {
      threadId: "thread-1",
      client: {
        async startTurn({ onTurnStarted }) {
          onTurnStarted("turn-1");
          return {
            turn: { status: "completed" },
            message: "Updated file and ran the focused test.",
          };
        },
      },
    },
    graph: {
      checkout: "working",
      repository: "comm",
      path: "/repo/working/comm",
    },
    revision: "D123",
    currentHash: "old123",
    commitMessage: "Bug 123 - Update the patch. r=reviewer\n\nTB-Tools-Id: test-id",
    currentItemIndex: 0,
    items: [item, { id: "inline:2", state: "ready" }],
  };

  saveGraphPatchUpdateReply({
    session,
    itemId: item.id,
    message: "I will keep this behavior and explain why in the update.",
  });

  assert.equal(item.draftSaved, true);
  assert.equal(item.state, "ready");
  assert.equal(session.currentItemIndex, 0);

  const before = {
    head: "old123",
    rawDiff: "",
    treeish: "before123",
    untrackedPaths: [],
  };
  const after = {
    head: "old123",
    rawDiff: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
    treeish: "after456",
    untrackedPaths: [],
  };
  let workingTreeReadCount = 0;

  await applyGraphPatchUpdateComment({
    session,
    itemId: item.id,
    runCommand: async () => "",
    getWorkingTreePatch: async () => after.rawDiff,
    getWorkingTreeState: async () => (
      workingTreeReadCount++ ? after : before
    ),
  });

  assert.equal(item.changeApplied, true);
  assert.equal(item.changeAccepted, false);
  assert.equal(item.state, "ready");
  assert.equal(session.currentItemIndex, 0);
  assert.match(item.workingDiffHtml, /pretty-file/);
  assert.match(session.message, /Review the actual uncommitted diff/);

  const clean = {
    head: "amended456",
    rawDiff: "",
    treeish: "amended456",
    untrackedPaths: [],
  };
  let acceptedStateReads = 0;
  const amendCalls = [];
  const runCommand = async () => "";

  await acceptGraphPatchUpdateChange({
    session,
    itemId: item.id,
    runCommand,
    getCurrentCommit: async () => ({ hash: "old123" }),
    amendCurrent: async (options) => {
      amendCalls.push(options);
      return {
        currentHash: "amended456",
        message: "comm amended current commit amended456.",
      };
    },
    getWorkingTreeState: async () => {
      const state = acceptedStateReads === 0 ? after : clean;

      acceptedStateReads++;
      return state;
    },
  });

  assert.deepEqual(amendCalls, [{
    graph: session.graph,
    message: session.commitMessage,
    includeChanges: true,
    runCommand,
  }]);
  assert.equal(item.changeAccepted, false);
  assert.equal(item.changesAmended, true);
  assert.equal(session.currentHash, "amended456");
  assert.equal(session.workingDiff, "");
  assert.equal(session.workingDiffHtml, "");
  assert.equal(session.currentItemIndex, 0);
  assert.equal(session.items[1].state, "ready");
  assert.match(session.message, /Source change was amended/);
});

test("Patch Update refuses a source apply without its explanation", async () => {
  const session = {
    aiEnabled: true,
    codexSessionId: "thread-1",
    graph: {
      checkout: "working",
      path: "/repo/working/comm",
      repository: "comm",
    },
    items: [{
      assessment: "",
      changeSummary: "",
      id: "inline:1",
      state: "ready",
    }],
  };

  await assert.rejects(
    applyGraphPatchUpdateComment({
      session,
      itemId: "inline:1",
      runCommand: async () => {
        throw new Error("Codex should not run for an incomplete proposal.");
      },
    }),
    /assessment and planned-change summary/,
  );
});

test("Patch Update reverts only its prepared working-tree candidate", async () => {
  const before = {
    head: "old123",
    rawDiff: "diff --git a/existing b/existing\n--- a/existing\n+++ b/existing\n@@ -1 +1 @@\n-old\n+kept\n",
    treeish: "before123",
    untrackedPaths: [],
  };
  const after = {
    head: "old123",
    rawDiff: `${before.rawDiff}\ndiff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+candidate\n`,
    treeish: "after456",
    untrackedPaths: [],
  };
  let current = after;
  const item = {
    changeAccepted: false,
    changeApplied: true,
    changeReverted: false,
    id: "inline:1",
    state: "ready",
  };
  const session = {
    changeSnapshots: new Map([[item.id, {
      addedUntrackedPaths: [],
      after,
      before,
      patch: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+candidate\n",
    }]]),
    graph: {
      checkout: "working",
      path: "/repo/working/comm",
      repository: "comm",
    },
    items: [item],
  };
  let revertedPatch = "";

  await revertGraphPatchUpdateChange({
    session,
    itemId: item.id,
    runCommand: async () => "",
    applyReversePatch: async ({ patch }) => {
      revertedPatch = patch;
      current = before;
    },
    getWorkingTreeState: async () => current,
  });

  assert.match(revertedPatch, /candidate/);
  assert.equal(item.changeApplied, false);
  assert.equal(item.changeReverted, true);
  assert.equal(item.changeAccepted, false);
  assert.equal(session.changeSnapshots.has(item.id), false);
  assert.equal(item.workingDiff, before.rawDiff);
});

test("Patch Update requires a candidate decision before handling a comment", () => {
  const item = {
    changeAccepted: false,
    changeApplied: true,
    id: "inline:1",
    state: "ready",
  };
  const session = {
    currentItemIndex: 0,
    items: [item],
  };

  assert.throws(
    () => markGraphPatchUpdateCommentHandled({ session, itemId: item.id }),
    /Keep or revert the prepared working-tree change/,
  );
  assert.equal(item.state, "ready");
});

test("run streams captured output while a command is active", async () => {
  const chunks = [];
  const output = await run({
    cmd: process.execPath,
    args: ["-e", 'process.stdout.write("first\\nsecond\\n")'],
    capture: true,
    silent: true,
    onStdout: (chunk) => chunks.push(chunk),
  });

  assert.equal(output, "first\nsecond\n");
  assert.equal(chunks.join(""), output);
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

test("graph try runs prefer tbToolsId trailers over patch-id collisions", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-try-store-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const graph = { label: "comm", path: "/repo/comm" };
  const runCommand = async (command) => {
    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return "Bug 123 - Try this. r=#reviewers\n\nTB-Tools-Id: current-tb-tools-id\n";
    }

    if (command.cmd === "sh") {
      return "stable-patch-id def456\n";
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  for (const tryRun of [
    {
      id: "current",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=current",
      createdAt: "2026-07-27T12:00:00.000Z",
      hash: "abc123",
      patchId: "stable-patch-id",
      tbToolsId: "current-tb-tools-id",
    },
    {
      id: "legacy-patch",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=legacy-patch",
      createdAt: "2026-07-27T12:01:00.000Z",
      hash: "abc000",
      patchId: "stable-patch-id",
    },
    {
      id: "legacy-hash",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=legacy-hash",
      createdAt: "2026-07-27T12:02:00.000Z",
      hash: "def456",
      patchId: "different-patch-id",
    },
    {
      id: "other-local",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=other-local",
      createdAt: "2026-07-27T12:03:00.000Z",
      hash: "def456",
      patchId: "stable-patch-id",
      tbToolsId: "other-tb-tools-id",
    },
  ]) {
    await recordGraphTryRun({
      graph,
      runCommand,
      tryRun: {
        ...tryRun,
        subject: "Bug 123 - Try this",
        label: "comm",
      },
    });
  }

  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: {
      hash: "def456",
      parents: [],
      refs: ["HEAD"],
      subject: "Bug 123 - Try this",
    },
  });

  assert.deepEqual(
    runs.map((run) => run.id),
    ["other-local", "legacy-hash", "legacy-patch", "current"],
  );
});

test("graph try runs attach legacy ids when a rebased commit has a newer trailer", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-try-store-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const graph = { label: "comm", path: "/repo/comm" };
  const subject = "Bug 2056377 - Fix bct2 failures part 3 - Expose card view row clicks through the subject grid cell. r=#thunderbird-front-end-reviewers";
  const runCommand = async (command) => {
    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return `${subject}\n\nTB-Tools-Id: current-message-id\n`;
    }

    if (command.cmd === "sh") {
      return "current-patch-id current-part3\n";
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "part3-old-try",
      url: "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=part3-old",
      createdAt: "2026-07-31T13:17:42.183Z",
      hash: "old-part3",
      patchId: "old-part3-patch-id",
      tbToolsId: "legacy-part3-id",
      subject,
      label: "comm",
    },
  });

  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: {
      hash: "current-part3",
      subject,
    },
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "part3-old-try");
  assert.equal(runs[0].tbToolsId, "legacy-part3-id");
});

test("rebaseCommit backfills legacy try ids before replaying trailerless commits", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-rebase-try-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const part3Subject = "Bug 2056377 - Fix bct2 failures part 3 - Expose card view row clicks through the subject grid cell. r=#thunderbird-front-end-reviewers";
  const part4Subject = "Bug 2056377 - Fix bct2 failures part 4 - Make message attachment bar keyboard accessible. r=#thunderbird-front-end-reviewers";
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "Bug-2056377_2",
    knownHashes: new Set(["part3"]),
    backfillTryRunIds: true,
  };
  const headHashes = ["part2", "rebasedPart3", "rebasedPart4", "rebasedPart4"];
  let amendedPart3Message = "";
  const runCommand = async (command) => {
    calls.push(command);

    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "status") {
      return "";
    }

    if (command.args[0] === "branch" && command.args[1] === "--show-current") {
      return "Bug-2056377_2\n";
    }

    if (
      command.args[0] === "for-each-ref" &&
      command.args.includes("--points-at")
    ) {
      const hash = command.args[command.args.indexOf("--points-at") + 1];

      return {
        part3: "Bug-2056377_3\n",
        part4: "Bug-2056377_4\n",
      }[hash] || "";
    }

    if (
      command.args[0] === "for-each-ref" &&
      command.args.includes("--contains")
    ) {
      return "Bug-2056377_3\nBug-2056377_4\n";
    }

    if (command.args[0] === "rev-list") {
      return {
        "part3..Bug-2056377_3": "",
        "part3..Bug-2056377_4": "part4\n",
      }[command.args.at(-1)] || "";
    }

    if (command.args[0] === "merge-base") {
      throw new Error("not on main");
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return {
        part3: `${part3Subject}\n\nBody before ids.\n`,
        part4: `${part4Subject}\n\nTB-Tools-Id: part4-existing-id\n`,
        rebasedPart3: amendedPart3Message,
        rebasedPart4: `${part4Subject}\n\nTB-Tools-Id: part4-existing-id\n`,
      }[command.args.at(-1)] || "";
    }

    if (command.cmd === "sh") {
      return `patch-id-for-${command.args.at(-1)} ${command.args.at(-1)}\n`;
    }

    if (
      command.args[0] === "commit" &&
      command.args[1] === "--amend" &&
      command.args.includes("--only")
    ) {
      amendedPart3Message = readFileSync(command.args.at(-1), "utf8");
      return "";
    }

    if (command.args[0] === "rev-parse") {
      return `${headHashes.shift()}\n`;
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "part3-old-try",
      url: "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=part3-old",
      createdAt: "2026-07-31T13:17:42.183Z",
      hash: "old-part3",
      patchId: "old-part3-patch-id",
      tbToolsId: "legacy-part3-id",
      subject: part3Subject,
      label: "comm",
    },
  });

  const result = await rebaseCommit({
    graph,
    hash: "part3",
    preferredBranch: "Bug-2056377_3",
    rebaseMode: "children",
    runCommand,
  });

  assert.equal(result.branch, "Bug-2056377_4");
  assert.deepEqual(result.commits, ["part3", "part4"]);
  assert.match(amendedPart3Message, /TB-Tools-Id: legacy-part3-id/);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "commit" && call.args[1] === "--amend")
      .map((call) => call.args.slice(0, 4)),
    [["commit", "--amend", "--only", "-F"]],
  );

  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: {
      hash: "rebasedPart3",
      subject: part3Subject,
    },
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "part3-old-try");
  assert.equal(runs[0].hash, "rebasedPart3");
});

test("runGraphTrySubmission records mach try output for the current commit", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-try-run-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const graph = { label: "comm", path: "/repo/comm" };
  let headHash = "abc123";
  let messageHasId = false;
  let committedMessage = "";
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
      return `${headHash}\n`;
    }

    if (command.args[0] === "diff" || command.args[0] === "ls-files") {
      return "";
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return messageHasId
        ? committedMessage
        : "Bug 123 - Try me. r=#reviewers\n";
    }

    if (command.cmd === "sh") {
      return `stable-patch-id ${headHash}\n`;
    }

    if (
      command.args[0] === "commit" &&
      command.args[1] === "--amend" &&
      command.args.includes("--only")
    ) {
      headHash = "amended456";
      messageHasId = true;
      committedMessage = readFileSync(command.args.at(-1), "utf8");
      return "";
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
  assert.equal(result.tryRun.hash, "amended456");
  assert.match(result.tryRun.tbToolsId, /^[0-9a-f-]+$/);
  assert.equal(result.target.originalHash, "abc123");
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
  let spawnOptions;
  const writes = [];
  const session = {
    status: "running",
    message: "",
    prompt: null,
    pendingPrompt: null,
    output: "",
  };
  const spawnCommand = (_cmd, _args, options) => {
    spawnOptions = options;
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
  assert.equal(spawnOptions.env.MOZ_SKIP_PATH_PERFORMANCE_CHECK, "1");
  assert.match(session.output, /\$ moz-phab submit/);
  assert.match(session.output, /> yes/);
  assert.match(
    session.output,
    /Submitted https:\/\/phabricator\.services\.mozilla\.com\/D123456/,
  );
});

test("getInteractiveYesNoPrompt detects a prompt appended to prior output", () => {
  assert.equal(
    getInteractiveYesNoPrompt(
      "Tests completed successfully. Submit to https://phabricator.services.mozilla.com (YES/No/Always)? ",
    ),
    "Tests completed successfully. Submit to https://phabricator.services.mozilla.com (YES/No/Always)?",
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

test("expandDiffContext moves its controls after each revealed page", () => {
  let expanderPosition;
  const rows = Array.from({ length: 25 }, () => {
    let collapsed = true;

    return {
      classList: {
        remove(className) {
          assert.equal(className, "collapsed-context");
          collapsed = false;
        },
      },
      dataset: { contextGroup: "context" },
      get collapsed() {
        return collapsed;
      },
      hidden: true,
      after(node) {
        expanderPosition = { node, row: this };
      },
    };
  });
  const allButton = {
    dataset: {
      contextPosition: "middle",
      expandMode: "all",
    },
    hidden: false,
    textContent: "",
  };
  const expander = {
    dataset: { contextDirection: "start" },
    querySelectorAll() {
      return [button, allButton];
    },
  };
  const body = {
    querySelectorAll(selector) {
      assert.equal(selector, ".collapsed-context");
      return rows;
    },
  };
  const button = {
    dataset: {
      contextGroup: "context",
      contextPosition: "middle",
      expandMode: "next",
    },
    closest(selector) {
      if (selector === "tbody") {
        return body;
      }

      if (selector === ".diff-context-expander") {
        return expander;
      }

      return null;
    },
    setAttribute() {},
    textContent: "",
  };

  expandDiffContext(button);

  assert.equal(rows.slice(0, 20).every((row) => !row.collapsed), true);
  assert.equal(rows.slice(20).every((row) => row.collapsed), true);
  assert.deepEqual(expanderPosition, { node: expander, row: rows[19] });
  assert.equal(button.textContent, "Expand 5 lines");
  assert.equal(allButton.hidden, true);
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
    /<div class="file-diff"><table class="diff-table"><colgroup><col class="diff-gutter-column"><col class="diff-gutter-column"><col><\/colgroup><tbody>/,
  );
  assert.doesNotMatch(html, /diff --git/);
  assert.doesNotMatch(html, /index 123\.\.456/);
  assert.doesNotMatch(html, /--- a\/file\.txt/);
  assert.doesNotMatch(html, /\+\+\+ b\/file\.txt/);
  assert.doesNotMatch(html, /class="diff-line info"/);
  assert.doesNotMatch(html, /@@ -10,2 \+20,2 @@/);
  assert.match(html, /class="diff-line context"/);
  assert.match(html, /data-file-path="file.txt"/);
  assert.match(html, /data-old-file-path="file.txt" data-new-file-path="file.txt"/);
  assert.match(html, /data-old-line="10" data-new-line="20"/);
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

  const renamedFileHtml = formatPrettyDiffHtml(
    [
      "diff --git a/old-file.txt b/new-file.txt",
      "similarity index 100%",
      "rename from old-file.txt",
      "rename to new-file.txt",
      "@@ -1 +1 @@",
      " unchanged",
    ].join("\n"),
  );

  assert.match(
    renamedFileHtml,
    /data-old-file-path="old-file.txt" data-new-file-path="new-file.txt"/,
  );

  const collapsedContextHtml = formatPrettyDiffHtml(
    [
      "diff --git a/context.txt b/context.txt",
      "@@ -1,11 +1,11 @@",
      "-old value",
      "+new value",
      " context 1",
      " context 2",
      " context 3",
      " context 4",
      " context 5",
      " context 6",
      " context 7",
      " context 8",
      " context 9",
      " context 10",
      "-old final value",
      "+new final value",
    ].join("\n"),
  );

  assert.match(
    collapsedContextHtml,
    /<button class="diff-context-expander-button" type="button" data-context-group="diff-context-0-0" data-context-position="middle" data-expand-mode="next" aria-expanded="false">Expand 4 lines<\/button>/,
  );
  assert.doesNotMatch(collapsedContextHtml, /data-expand-mode="all"/);
  assert.match(
    collapsedContextHtml,
    /<tr class="diff-line context collapsed-context" data-old-line="5" data-new-line="5" hidden data-context-group="diff-context-0-0">/,
  );
  assert.match(collapsedContextHtml, /class="line-number old-line">2<\/td>/);
  assert.match(collapsedContextHtml, /class="line-number old-line">11<\/td>/);

  const edgeContextHtml = formatPrettyDiffHtml(
    [
      "diff --git a/edge-context.txt b/edge-context.txt",
      "@@ -1,22 +1,22 @@",
      " leading context 1",
      " leading context 2",
      " leading context 3",
      " leading context 4",
      " leading context 5",
      " leading context 6",
      " leading context 7",
      " leading context 8",
      " leading context 9",
      " leading context 10",
      "-old value",
      "+new value",
      " trailing context 1",
      " trailing context 2",
      " trailing context 3",
      " trailing context 4",
      " trailing context 5",
      " trailing context 6",
      " trailing context 7",
      " trailing context 8",
      " trailing context 9",
      " trailing context 10",
    ].join("\n"),
  );

  assert.match(edgeContextHtml, />Expand 7 lines above<\/button>/);
  assert.match(edgeContextHtml, />Expand 7 lines below<\/button>/);

  const largeContextHtml = formatPrettyDiffHtml(
    [
      "diff --git a/large-context.txt b/large-context.txt",
      "@@ -1,32 +1,32 @@",
      "-old value",
      "+new value",
      ...Array.from({ length: 30 }, (_, index) => ` context ${index + 1}`),
      "-old final value",
      "+new final value",
    ].join("\n"),
  );

  assert.match(largeContextHtml, />Expand 20 lines<\/button>/);
  assert.match(largeContextHtml, />Show all 24 lines<\/button>/);

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
  assert.equal(commands[0].args.includes("--unified=20"), true);
  assert.match(diffs.abc123.text, /diff --git/);
  assert.match(diffs.abc123.html, /pretty-file/);
  assert.equal(diffs.abc123.truncated, false);
  assert.equal(diffs.abc123.insertions, 1);
  assert.equal(diffs.abc123.deletions, 1);
});

test("getCommitDiff fetches full file context on request", async () => {
  const commands = [];
  const diff = await getCommitDiff({
    cwd: "/repo/comm",
    hash: "abc123",
    fullFile: true,
    maxDiffBytes: 0,
    runCommand: async (command) => {
      commands.push(command);
      return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
    },
  });

  assert.equal(commands[0].cmd, "git");
  assert.equal(commands[0].args.includes("--unified=2147483647"), true);
  assert.equal(diff.truncated, false);
  assert.match(diff.html, /pretty-file/);
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
  assert.equal(
    workingTree.commits[0].changeId,
    createHash("sha256").update([
      "diff --git a/tracked.txt b/tracked.txt",
      "index 1234567..89abcde 100644",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      untrackedDiff,
    ].join("\n")).digest("hex"),
  );
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

test("tree snapshots do not build a diff for every untracked file", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tb-graph-untracked-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const files = Array.from({ length: 100 }, (_, index) => `review/file-${index}.txt`);
  await mkdir(path.join(cwd, "review"));
  await Promise.all(files.map((file) => writeFile(path.join(cwd, file), "original")));
  const commands = [];
  const runCommand = async (command) => {
    commands.push(command);
    if (command.args[0] === "ls-files") {
      return `${files.join("\0")}\0`;
    }
    return "";
  };

  const first = await getWorkingTreeCommits({ cwd, diffs: false, runCommand });
  assert.equal(first.commits.length, 1);
  assert.equal(commands.filter((command) => command.args.includes("--no-index")).length, 0);
  assert.equal(commands.length, 2);

  await writeFile(path.join(cwd, files[0]), "changed content");
  const second = await getWorkingTreeCommits({ cwd, diffs: false, runCommand });
  assert.notEqual(second.commits[0].changeId, first.commits[0].changeId);
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
    getNotionStoriesByBugId: async () => null,
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
      cacheTtlMs: 15 * 60 * 1000,
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

test("getGraphCommitReview returns regular comments and inline suggestions", async () => {
  const calls = [];
  const phabCalls = [];
  const originalSource = Array.from(
    { length: 100 },
    (_, index) => index === 98 ? "const old = true;" : `line ${index + 1};`,
  );
  const revisedSource = originalSource.with(98, "const reviewed = true;");
  const makeDiff = (id, dateCreated, source) => ({
    dateCreated,
    id,
    changes: [{
      currentPath: "comm/mail/base/content/example.js",
      hunks: [{
        newOffset: "1",
        corpus: `${source.map((line) => `+${line}`).join("\n")}\n`,
      }],
    }],
  });
  const review = await getGraphCommitReview({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Fix thing" }],
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "Bug 123456 - Fix thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n";
    },
    phab: async (request) => {
      phabCalls.push(request);

      if (request.route === "user.query") {
        return {
          result: [{
            phid: "PHID-USER-reviewer",
            realName: "Reviewing Person",
            userName: "reviewer",
          }],
        };
      }

      if (request.route === "differential.query") {
        return { result: [{ authorPHID: "PHID-USER-author" }] };
      }

      if (request.route === "differential.getrevision") {
        return {
          result: {
            diffs: {
              42: makeDiff(42, 1710000000, originalSource),
              43: makeDiff(43, 1710000003, revisedSource),
            },
          },
        };
      }

      return {
        result: {
          data: [
            {
              id: "transaction-comment",
              phid: "PHID-XACT-comment",
              type: "comment",
              authorPHID: "PHID-USER-reviewer",
              dateCreated: 1710000000,
              fields: {},
              comments: [
                {
                  id: 100,
                  phid: "PHID-XCMT-regular",
                  authorPHID: "PHID-USER-reviewer",
                  dateCreated: 1710000000,
                  content: { raw: "Looks good overall." },
                },
              ],
            },
            {
              id: "transaction-inline",
              phid: "PHID-XACT-inline",
              type: "inline",
              authorPHID: "PHID-USER-reviewer",
              dateCreated: 1710000001,
              fields: {
                diff: { id: 42 },
                isNewFile: false,
                length: 2,
                line: 42,
                path: "comm/mail/base/content/example.js",
              },
              comments: [
                {
                  id: 101,
                  phid: "PHID-XCMT-inline",
                  authorPHID: "PHID-USER-reviewer",
                  dateCreated: 1710000001,
                  content: { raw: "```suggestion\nconst reviewed = true;\n```" },
                },
              ],
            },
            {
              id: "transaction-code-suggestion",
              phid: "PHID-XACT-code-suggestion",
              type: "inline",
              authorPHID: "PHID-USER-reviewer",
              dateCreated: 1710000002,
              fields: {
                diff: { id: 42 },
                length: 1,
                line: 99,
                path: "comm/mail/base/content/example.js",
              },
              comments: [
                {
                  id: 102,
                  phid: "PHID-XCMT-code-suggestion",
                  authorPHID: "PHID-USER-reviewer",
                  dateCreated: 1710000002,
                  content: { raw: "" },
                },
              ],
            },
            {
              id: "transaction-request-changes",
              phid: "PHID-XACT-request-changes",
              type: "request-changes",
              authorPHID: "PHID-USER-reviewer",
              dateCreated: 1710000003,
              fields: {},
              comments: [],
            },
            {
              id: "transaction-author-note",
              phid: "PHID-XACT-author-note",
              type: "comment",
              authorPHID: "PHID-USER-author",
              dateCreated: 1710000004,
              fields: {},
              comments: [{
                id: 103,
                phid: "PHID-XCMT-author-note",
                authorPHID: "PHID-USER-author",
                dateCreated: 1710000004,
                content: { raw: "try: https://treeherder.mozilla.org/jobs?repo=try-comm-central" },
              }],
            },
          ],
        },
      };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [["log", "-1", "--format=%B", "abc123"]],
  );
  assert.deepEqual(phabCalls, [
    {
      route: "transaction.search",
      params: { objectIdentifier: "D987654", limit: 100 },
    },
    {
      route: "differential.query",
      params: { ids: [987654] },
    },
    {
      route: "user.query",
      params: { phids: ["PHID-USER-reviewer"] },
    },
    {
      route: "differential.getrevision",
      params: { revision_id: 987654 },
    },
  ]);
  assert.deepEqual(review.comments, [{
    id: "PHID-XCMT-regular",
    action: "comment",
    author: "Reviewing Person",
    authorPhid: "PHID-USER-reviewer",
    content: "Looks good overall.",
    dateCreated: 1710000000,
    url: "https://phabricator.services.mozilla.com/D987654#inline-100",
  }]);
  assert.deepEqual(review.inlineComments, [{
    id: "PHID-XCMT-inline",
    action: "comment",
    author: "Reviewing Person",
    authorPhid: "PHID-USER-reviewer",
    codeSuggestion: {
      content: "const reviewed = true;",
      url: "https://phabricator.services.mozilla.com/D987654#inline-101",
    },
    commentId: "PHID-XCMT-inline",
    content: "",
    dateCreated: 1710000001,
    diffId: 42,
    filePath: "comm/mail/base/content/example.js",
    isNewFile: true,
    lineLength: 2,
    lineNumber: 42,
    contextDiff: "diff --git a/mail/base/content/example.js b/mail/base/content/example.js\n--- a/mail/base/content/example.js\n+++ b/mail/base/content/example.js\n@@ -0,0 +35,16 @@\n+line 35;\n+line 36;\n+line 37;\n+line 38;\n+line 39;\n+line 40;\n+line 41;\n+line 42;\n+line 43;\n+line 44;\n+line 45;\n+line 46;\n+line 47;\n+line 48;\n+line 49;\n+line 50;",
    contextLineSide: "new",
    url: "https://phabricator.services.mozilla.com/D987654#inline-101",
  }, {
    id: "PHID-XCMT-code-suggestion",
    action: "comment",
    author: "Reviewing Person",
    authorPhid: "PHID-USER-reviewer",
    codeSuggestion: {
      content: "const reviewed = true;",
      url: "https://phabricator.services.mozilla.com/D987654#inline-102",
    },
    commentId: "PHID-XCMT-code-suggestion",
    content: "",
    dateCreated: 1710000002,
    diffId: 42,
    filePath: "comm/mail/base/content/example.js",
    isNewFile: true,
    lineLength: 1,
    lineNumber: 99,
    contextDiff: "diff --git a/mail/base/content/example.js b/mail/base/content/example.js\n--- a/mail/base/content/example.js\n+++ b/mail/base/content/example.js\n@@ -0,0 +92,9 @@\n+line 92;\n+line 93;\n+line 94;\n+line 95;\n+line 96;\n+line 97;\n+line 98;\n+const old = true;\n+line 100;",
    contextLineSide: "new",
    url: "https://phabricator.services.mozilla.com/D987654#inline-102",
  }]);
  assert.equal(review.revision, "D987654");
});

test("getGraphCommitReview loads context for prose-only inline feedback", async () => {
  const phabCalls = [];
  const review = await getGraphCommitReview({
    graph: {
      commits: [{ hash: "abc123", subject: "Fix thing" }],
      label: "comm",
      path: "/repo/comm",
    },
    hash: "abc123",
    runCommand: async () => (
      "Bug 123456 - Fix thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n"
    ),
    phab: async (request) => {
      phabCalls.push(request);

      if (request.route === "differential.query") {
        return { result: [{ authorPHID: "PHID-USER-author" }] };
      }
      if (request.route === "user.query") {
        return {
          result: [{
            phid: "PHID-USER-reviewer",
            realName: "Reviewing Person",
          }],
        };
      }
      if (request.route === "differential.getrevision") {
        return {
          result: {
            diffs: {
              42: {
                dateCreated: 1710000000,
                id: 42,
                changes: [{
                  currentPath: "comm/mail/base/content/example.js",
                  hunks: [{
                    newOffset: "1",
                    oldOffset: "1",
                    corpus: " line 1;\n line 2;\n line 3;\n line 4;\n",
                  }],
                }],
              },
            },
          },
        };
      }

      return {
        result: {
          cursor: { after: null },
          data: [{
            authorPHID: "PHID-USER-reviewer",
            dateCreated: 1710000001,
            fields: {
              diff: { id: 42 },
              length: 1,
              line: 3,
              path: "comm/mail/base/content/example.js",
            },
            id: "transaction-inline",
            phid: "PHID-XACT-inline",
            type: "inline",
            comments: [{
              authorPHID: "PHID-USER-reviewer",
              content: { raw: "Please preserve this behavior." },
              dateCreated: 1710000001,
              id: 101,
              phid: "PHID-XCMT-inline",
            }],
          }],
        },
      };
    },
  });

  assert.match(review.inlineComments[0].contextDiff, /line 3/);
  assert.equal(
    phabCalls.filter(({ route }) => route === "differential.getrevision").length,
    1,
  );
});

test("getGraphCommitReview caps Phabricator transaction history", async () => {
  let transactionRequests = 0;
  const review = await getGraphCommitReview({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Fix thing" }],
    },
    hash: "abc123",
    runCommand: async () => (
      "Bug 123456 - Fix thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n"
    ),
    phab: async ({ route }) => {
      if (route === "transaction.search") {
        transactionRequests++;
        return {
          result: {
            data: [],
            cursor: { after: `cursor-${transactionRequests}` },
          },
        };
      }

      if (route === "differential.query") {
        return { result: [{ authorPHID: "PHID-USER-author" }] };
      }

      assert.fail(`Unexpected Phabricator route: ${route}`);
    },
  });

  assert.equal(transactionRequests, 4);
  assert.equal(review.historyTruncated, true);
});

test("getGraphCommitReview uses the authenticated web session for a prose comment suggestion", async () => {
  const webSuggestionCalls = [];
  const review = await getGraphCommitReview({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Fix thing" }],
    },
    hash: "abc123",
    runCommand: async () => (
      "Bug 123456 - Fix thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D290877\n"
    ),
    phab: async (request) => {
      if (request.route === "user.query") {
        return { result: [] };
      }

      return {
        result: {
          data: [{
            id: "transaction-inline",
            type: "inline",
            fields: {
              diff: { id: 42 },
              length: 1,
              line: 9,
              path: "comm/mail/locales/en-US/messenger/selectAll.ftl",
            },
            comments: [{
              id: 1668758,
              content: {
                raw: "Maybe refer to it by name so it is absolutely clear.",
              },
            }],
          }],
        },
      };
    },
    getWebSuggestions: async (request) => {
      webSuggestionCalls.push(request);
      return new Map([[
        "1668758",
        {
          content: "# The select-all-total-count span may or may not be visible forming",
        },
      ]]);
    },
  });

  assert.deepEqual(webSuggestionCalls, [{
    revision: "D290877",
    inlineComments: [{ id: "1668758", diffId: 42 }],
  }]);
  assert.equal(review.inlineComments[0].content, "Maybe refer to it by name so it is absolutely clear.");
  assert.deepEqual(review.inlineComments[0].codeSuggestion, {
    content: "# The select-all-total-count span may or may not be visible forming",
    url: "https://phabricator.services.mozilla.com/D290877#inline-1668758",
  });
});

test("Phabricator web session authenticates and caches inline suggestions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-phab-auth-"));
  const launches = [];
  let signedIn = false;
  let suggestionFetches = 0;
  const restoredCookies = [];
  const page = {
    async goto(url) {
      this.url = url;
    },
  };
  const browser = {
    async launchPersistentContext(profilePath, options) {
      launches.push({ options, profilePath });
      return {
        pages: () => [page],
        async newPage() {
          return page;
        },
        async addCookies(cookies) {
          restoredCookies.push(...cookies);
        },
        async close() {},
        async storageState() {
          return {
            cookies: [{ name: "session", value: "authenticated" }],
          };
        },
      };
    },
  };
  const session = createPhabricatorWebSession({
    browserLoader: async () => browser,
    getPageAuthenticationState: async () => signedIn,
    getPageSuggestions: async () => {
      suggestionFetches++;
      return {
        1668758: {
          content: "suggested replacement",
        },
      };
    },
    homeDirectory: directory,
  });

  t.after(async () => {
    await session.close();
    await rm(directory, { force: true, recursive: true });
  });

  assert.equal((await session.getStatus()).state, "disconnected");
  assert.equal((await session.startAuthentication()).state, "pending");

  signedIn = true;
  assert.equal((await session.getStatus()).state, "connected");

  const first = await session.getSuggestions({
    revision: "D290877",
    inlineComments: [{ id: "1668758", diffId: 42 }],
  });
  const second = await session.getSuggestions({
    revision: "D290877",
    inlineComments: [{ id: "1668758", diffId: 42 }],
  });

  assert.deepEqual(first.get("1668758"), {
    content: "suggested replacement",
  });
  assert.equal(second, first);
  assert.equal(suggestionFetches, 1);
  assert.equal(launches[0].options.headless, false);
  assert.equal(launches.at(-1).options.headless, true);
  assert.deepEqual(restoredCookies, [{ name: "session", value: "authenticated" }]);
  assert.equal((await session.signOut()).state, "disconnected");
});

test("Phabricator web sessions never open the default browser during tests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-phab-blocked-"));
  const previousBlock = globalThis.__tbToolsBlockExternalApis;

  globalThis.__tbToolsBlockExternalApis = true;
  t.after(async () => {
    globalThis.__tbToolsBlockExternalApis = previousBlock;
    await rm(directory, { force: true, recursive: true });
  });

  await mkdir(path.join(directory, ".tb-tools", "phabricator-browser"), {
    recursive: true,
  });
  const session = createPhabricatorWebSession({ homeDirectory: directory });
  const status = await session.getStatus();

  assert.equal(status.state, "error");
  assert.match(status.message, /browser access is blocked during tests/);
});

test("Phabricator web session keeps Bugzilla OAuth open until Phabricator confirms it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-phab-oauth-"));
  const page = {
    url: "",
    async goto(url) {
      this.url = url;
    },
  };
  let contextClosed = false;
  const browser = {
    async launchPersistentContext() {
      return {
        pages: () => [page],
        async newPage() {
          return page;
        },
        async storageState() {
          return { cookies: [] };
        },
        async close() {
          contextClosed = true;
        },
      };
    },
  };
  const session = createPhabricatorWebSession({
    browserLoader: async () => browser,
    getPageAuthenticationState: async (currentPage) => (
      currentPage.url.startsWith("https://phabricator.services.mozilla.com/") &&
      !currentPage.url.includes("/auth/login/") &&
      !currentPage.url.includes("/auth/callback/")
    ),
    homeDirectory: directory,
  });

  t.after(async () => {
    await session.close();
    await rm(directory, { force: true, recursive: true });
  });

  await session.startAuthentication();
  page.url = "https://bugzilla.mozilla.org/login";

  assert.equal((await session.getStatus()).state, "pending");
  assert.equal(contextClosed, false);

  page.url = "https://phabricator.services.mozilla.com/auth/callback/";
  assert.equal((await session.getStatus()).state, "pending");
  assert.equal(contextClosed, false);

  page.url = "https://phabricator.services.mozilla.com/D290877";
  assert.equal((await session.getStatus()).state, "connected");
  assert.equal(contextClosed, true);
  assert.equal(page.url, "https://phabricator.services.mozilla.com/settings/");
});

test("Phabricator web session fetches a missing suggestion from its revision diff", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-phab-diff-"));
  const page = {
    async close() {},
    async goto(url) {
      this.url = url;
    },
  };
  const browser = {
    async launchPersistentContext() {
      return {
        pages: () => [page],
        async newPage() {
          return page;
        },
        async addCookies() {},
        async close() {},
        async storageState() {
          return { cookies: [] };
        },
      };
    },
  };
  const session = createPhabricatorWebSession({
    browserLoader: async () => browser,
    getPageAuthenticationState: async () => true,
    getPageSuggestions: async (currentPage) => (
      currentPage.url.includes("?id=42")
        ? { 1668758: { content: "suggested replacement" } }
        : {}
    ),
    homeDirectory: directory,
  });

  t.after(async () => {
    await session.close();
    await rm(directory, { force: true, recursive: true });
  });

  await mkdir(path.join(directory, ".tb-tools", "phabricator-browser"), {
    recursive: true,
  });
  const suggestions = await session.getSuggestions({
    revision: "D290877",
    inlineComments: [{ id: "1668758", diffId: 42 }],
  });

  assert.deepEqual(suggestions.get("1668758"), {
    content: "suggested replacement",
  });
  assert.equal(page.url, "https://phabricator.services.mozilla.com/D290877?id=42");
});

// Native draft and review-form behavior is covered with Playwright in phab-web-review.test.mjs.


test("getGraphCommitIntegrationStatus includes Notion stories by bug id", async () => {
  const notionCalls = [];
  const result = await getGraphCommitIntegrationStatus({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [
        {
          hash: "abc123",
          subject: "Bug 123456 - Fix thing",
        },
      ],
    },
    hash: "abc123",
    runCommand: async (command) => {
      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123456 - Fix thing. r=#reviewers\n";
      }

      return "";
    },
    getBug: async (id) => ({
      bugs: [
        {
          id,
          status: "ASSIGNED",
          resolution: "---",
          summary: "Fix thing",
          is_open: true,
          keywords: [],
        },
      ],
    }),
    phab: async () => ({ result: [] }),
    getNotionStoriesByBugId: async ({ bugId }) => {
      notionCalls.push(bugId);
      return {
        bugId,
        stories: [
          {
            id: "notion-page",
            url: "https://www.notion.so/story",
            title: "Fix thing story",
            status: "In progress",
          },
        ],
      };
    },
  });

  assert.deepEqual(notionCalls, ["123456"]);
  assert.deepEqual(result.notion, {
    bugId: "123456",
    stories: [
      {
        id: "notion-page",
        url: "https://www.notion.so/story",
        title: "Fix thing story",
        status: "In progress",
      },
    ],
  });
});

test("getGraphCommitIntegrationStatus hides Notion when its token is invalid", async () => {
  const result = await getGraphCommitIntegrationStatus({
    graph: {
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Bug 123456 - Fix thing" }],
    },
    hash: "abc123",
    runCommand: async (command) => (
      command.args[0] === "log" && command.args.includes("--format=%B")
        ? "Bug 123456 - Fix thing. r=#reviewers\n"
        : ""
    ),
    getBug: async () => ({ bugs: [] }),
    phab: async () => ({ result: [] }),
    getNotionStoriesByBugId: async () => {
      const error = new Error("Notion request failed (401 Unauthorized).");

      error.statusCode = 401;
      throw error;
    },
  });

  assert.equal(result.notion, null);
});

test("interactive graph server disables Notion after an invalid token", async (t) => {
  let notionCalls = 0;
  const serverInfo = await startInteractiveGraphServer({
    getBug: async () => ({ bugs: [] }),
    getNotionStoriesByBugId: async () => {
      notionCalls++;
      const error = new Error("Notion request failed (403 Forbidden).");

      error.statusCode = 403;
      throw error;
    },
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Bug 123456 - Fix thing" }],
    }],
    html: "<!doctype html><p>graph</p>",
    phab: async () => ({ result: [] }),
    runCommand: async (command) => (
      command.args[0] === "log" && command.args.includes("--format=%B")
        ? "Bug 123456 - Fix thing. r=#reviewers\n"
        : ""
    ),
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const endpoint = new URL(
    "api/graph/0/integration/abc123?token=secret",
    serverInfo.url,
  );
  const first = await (await fetch(endpoint)).json();
  const second = await (await fetch(endpoint)).json();

  assert.equal(first.notion, null);
  assert.equal(second.notion, null);
  assert.equal(notionCalls, 1);
});

test("interactive graph server shares an in-flight integration request across tabs", async (t) => {
  let phabCalls = 0;
  const releasePhab = [];
  let markPhabStarted;
  const phabStarted = new Promise((resolve) => {
    markPhabStarted = resolve;
  });
  const serverInfo = await startInteractiveGraphServer({
    getBug: async () => ({ bugs: [] }),
    getNotionStoriesByBugId: async () => [],
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Bug 123456 - Fix thing D987654" }],
    }],
    html: "<!doctype html><p>graph</p>",
    getBugzillaRevisions: async () => {
      phabCalls++;
      markPhabStarted();
      await new Promise((resolve) => {
        releasePhab.push(resolve);
      });
      return [{ id: "D987654", status: "needs-review", long_status: "Needs Review" }];
    },
    runCommand: async (command) => (
      command.args[0] === "log" && command.args.includes("--format=%B")
        ? "Bug 123456 - Fix thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n"
        : ""
    ),
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const endpoint = new URL(
    "api/graph/0/integration/abc123?token=secret",
    serverInfo.url,
  );
  const first = fetch(endpoint);

  await phabStarted;
  const second = fetch(endpoint);

  await new Promise((resolve) => setTimeout(resolve, 0));
  let assertionError;

  try {
    assert.equal(phabCalls, 1);
  } catch (error) {
    assertionError = error;
  } finally {
    releasePhab.forEach((resolve) => resolve());
  }

  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  if (assertionError) {
    throw assertionError;
  }

  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, true);
  assert.equal(phabCalls, 1);
});

test("interactive graph server exposes local Phabricator cache controls without a Phabricator request", async (t) => {
  const cleared = [];
  let dashboardClears = 0;
  let dashboardStatusCalls = 0;
  let statusCalls = 0;
  let timelineStatusCalls = 0;
  let timelineClears = 0;
  const serverInfo = await startInteractiveGraphServer({
    clearDashboardCache: async () => {
      dashboardClears++;
      return { entries: 0, enabled: true };
    },
    clearDashboardTimelineCache: async () => {
      timelineClears++;
      return { entries: 0, enabled: true, users: 0 };
    },
    clearPhabricatorCache: async ({ category }) => {
      cleared.push(category);
      return {
        categories: {
          identities: { entries: 1 },
          "revision-history": { entries: 0 },
          "revision-status": { entries: 0 },
        },
        enabled: true,
      };
    },
    getDashboardTimelineCacheStatus: async () => {
      timelineStatusCalls++;
      return { entries: 5, enabled: true, users: 1 };
    },
    getDashboardCacheStatus: async () => {
      dashboardStatusCalls++;
      return { entries: 1, enabled: true };
    },
    getPhabricatorCacheStatus: async () => {
      statusCalls++;
      return {
        categories: {
          identities: { entries: 1 },
          "revision-history": { entries: 2 },
          "revision-status": { entries: 3 },
        },
        enabled: true,
      };
    },
    graphs: [{ label: "comm", path: "/repo/comm" }],
    html: "<!doctype html><p>graph</p>",
    phab: async () => assert.fail("The local cache endpoint must not call Phabricator."),
    runCommand: async () => "",
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const endpoint = new URL("api/phabricator-cache?token=secret", serverInfo.url);
  const statusResponse = await fetch(endpoint);

  assert.equal(statusResponse.ok, true);
  assert.deepEqual(await statusResponse.json(), {
    ok: true,
    cache: {
      categories: {
        identities: { entries: 1 },
        "revision-history": { entries: 2 },
        "revision-status": { entries: 3 },
      },
      enabled: true,
    },
    dashboard: { entries: 1, enabled: true },
    dashboardTimelines: { entries: 5, enabled: true, users: 1 },
  });
  assert.equal(dashboardStatusCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(timelineStatusCalls, 1);

  const clearResponse = await fetch(new URL("api/phabricator-cache", serverInfo.url), {
    body: JSON.stringify({ category: "revision-history", token: "secret" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(clearResponse.ok, true);
  assert.deepEqual(cleared, ["revision-history"]);
  assert.equal(dashboardClears, 1);

  const clearAllResponse = await fetch(new URL("api/phabricator-cache", serverInfo.url), {
    body: JSON.stringify({ category: "all", token: "secret" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(clearAllResponse.ok, true);
  assert.deepEqual(cleared, ["revision-history", "all"]);
  assert.equal(dashboardClears, 2);
  assert.equal(timelineClears, 1);
});

test("interactive graph server does not cache an unavailable Phabricator status", async (t) => {
  let phabCalls = 0;
  const serverInfo = await startInteractiveGraphServer({
    getBug: async () => ({ bugs: [] }),
    getNotionStoriesByBugId: async () => [],
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      commits: [{ hash: "abc123", subject: "Bug 123456 - Fix thing D987654" }],
    }],
    html: "<!doctype html><p>graph</p>",
    getBugzillaRevisions: async () => {
      phabCalls++;
      throw new Error("Phabricator differential.query temporarily rate limited.");
    },
    runCommand: async (command) => (
      command.args[0] === "log" && command.args.includes("--format=%B")
        ? "Bug 123456 - Fix thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D987654\n"
        : ""
    ),
    token: "secret",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const endpoint = new URL(
    "api/graph/0/integration/abc123?token=secret",
    serverInfo.url,
  );
  const first = await (await fetch(endpoint)).json();
  const second = await (await fetch(endpoint)).json();

  assert.match(first.phabricator.error, /temporarily rate limited/);
  assert.match(second.phabricator.error, /temporarily rate limited/);
  assert.equal(phabCalls, 2);
});

test("getGraphCommitIntegrationStatus keeps subject-matched legacy try runs", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-integration-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const subject = "Bug 2056377 - Fix bct2 failures part 3 - Expose card view row clicks through the subject grid cell. r=#thunderbird-front-end-reviewers";
  const graph = {
    label: "comm",
    path: "/repo/comm",
    commits: [
      {
        hash: "current-part3",
        subject,
      },
    ],
  };
  const runCommand = async (command) => {
    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return `${subject}\n\nTB-Tools-Id: current-message-id\n`;
    }

    if (command.cmd === "sh") {
      return "current-patch-id current-part3\n";
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "part3-old-try",
      url: "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=part3-old",
      createdAt: "2026-07-31T13:17:42.183Z",
      hash: "old-part3",
      patchId: "old-part3-patch-id",
      tbToolsId: "legacy-part3-id",
      subject,
      label: "comm",
    },
  });

  const result = await getGraphCommitIntegrationStatus({
    graph,
    hash: "current-part3",
    runCommand,
    getBug: async () => {
      throw new Error("Bugzilla should not be queried.");
    },
    phab: async () => {
      throw new Error("Phabricator should not be queried.");
    },
    getNotionStoriesByBugId: async () => null,
  });

  assert.deepEqual(
    result.tryRuns.map((tryRun) => tryRun.id),
    ["part3-old-try"],
  );
  assert.equal(result.tryRuns[0].hash, "current-part3");
});

test("markGraphBugForCheckin sets the repository milestone and checkin-needed-tb keyword", async (t) => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "tb-checkin-milestone-"));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  await mkdir(path.join(repoPath, "mail", "config"), { recursive: true });
  await writeFile(path.join(repoPath, "mail", "config", "version.txt"), "153.0a1\n");
  const calls = [];
  const updates = [];
  let marked = false;
  const options = {
    getBugzillaRevisions: async () => [{ id: "D987654", status: "accepted", long_status: "Accepted", title: "Bug 123456 - Fix thing" }],
    graph: {
      label: "comm",
      path: repoPath,
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
    getNotionStoriesByBugId: async () => null,
  };
  const result = await markGraphBugForCheckin(options);

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
        target_milestone: "153 Branch",
        keywords: {
          add: ["checkin-needed-tb"],
        },
      },
    ],
  ]);
  assert.equal(result.message, "Bug 123456 marked for checkin.");
  assert.equal(result.bug.hasCheckinNeeded, true);
  assert.deepEqual(result.bug.keywords, ["checkin-needed-tb"]);

  await markGraphBugForCheckin(options);
  assert.equal(updates.length, 1, "An already marked bug needs no update.");

  marked = false;
  await writeFile(path.join(repoPath, "mail", "config", "version.txt"), "invalid\n");
  await assert.rejects(markGraphBugForCheckin(options), /Cannot determine the target milestone/);
  assert.equal(updates.length, 1, "An invalid version must not update Bugzilla.");

  await rm(path.join(repoPath, "mail", "config", "version.txt"));
  await assert.rejects(markGraphBugForCheckin(options), /ENOENT/);
  assert.equal(updates.length, 1, "A missing version must not update Bugzilla.");
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
      getNotionStoriesByBugId: async () => null,
    }),
    /Only accepted Phabricator patches/,
  );

  assert.deepEqual(updates, []);
});

test("buildGraphCommitMessage uses a Bug branch prefix and reviewer pills", () => {
  assert.match(
    buildGraphCommitMessage({
      branch: "Bug-1234567_2",
      summary: "Fix calendar keyboard handling",
      reviewers: [
        "aleca!",
        { value: "#thunderbird-front-end-reviewers", blocking: true },
        "aleca",
      ],
    }),
    /^Bug 1234567 - Fix calendar keyboard handling\. r=aleca!,#thunderbird-front-end-reviewers!\n\nTB-Tools-Id: [0-9a-f-]+$/,
  );
  assert.match(
    buildGraphCommitMessage({
      branch: "topic",
      bugId: "7654321",
      summary: "Fix account setup",
      reviewers: "#mail-reviewers",
    }),
    /^Bug 7654321 - Fix account setup\. r=#mail-reviewers\n\nTB-Tools-Id: [0-9a-f-]+$/,
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

test("commit message helpers add tbToolsId trailers and install an idempotent hook", async (t) => {
  const ensured = ensureTbToolsIdInCommitMessage("Bug 123 - Fix thing. r=#reviewers");
  const preserved = ensureTbToolsIdInCommitMessage(
    "Bug 123 - Fix thing. r=#reviewers\n\nTB-Tools-Id: existing-id",
  );
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-hook-"));
  const hookPath = path.join(tempDir, "hooks", "commit-msg");
  const runCommand = async (command) => {
    assert.deepEqual(command.args, ["rev-parse", "--git-path", "hooks/commit-msg"]);
    return `${hookPath}\n`;
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, "#!/bin/sh\nexit 0\n");

  assert.match(
    ensured.message,
    /^Bug 123 - Fix thing\. r=#reviewers\n\nTB-Tools-Id: [0-9a-f-]+$/,
  );
  assert.equal(preserved.id, "existing-id");
  assert.equal(preserved.added, false);
  assert.equal(
    await installTbToolsCommitMsgHook({ cwd: tempDir, runCommand }),
    true,
  );
  assert.equal(
    await installTbToolsCommitMsgHook({ cwd: tempDir, runCommand }),
    false,
  );

  const hook = readFileSync(hookPath, "utf8");

  assert.match(hook, /^#!\/bin\/sh\n\n# tb-tools commit-msg hook begin/);
  assert.match(hook, new RegExp(`const trailer = "${TB_TOOLS_ID_TRAILER}"`));
  assert.match(hook, /exit 0\n$/);
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

test("createGraphCommit creates a new Bug branch from a patch branch", async () => {
  const calls = [];
  const refs = new Map([["Bug-1234567_2", "base000"]]);
  let branch = "Bug-1234567_2";
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "Bug-1234567_2",
  };
  const result = await createGraphCommit({
    graph,
    options: {
      bugId: "7654321",
      summary: "Fix message list focus",
      reviewers: ["aleca", "#mail-reviewers"],
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.args.join(" ") === "branch --show-current") {
        return `${branch}\n`;
      }

      if (command.args.join(" ") === "for-each-ref --format=%(refname:short) refs/heads") {
        return `${[...refs.keys()].join("\n")}\n`;
      }

      if (command.args.join(" ") === "switch -c Bug-7654321") {
        branch = "Bug-7654321";
        refs.set(branch, "base000");
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "-m") {
        refs.set(branch, "def4567890abcdef");
        return "[Bug-7654321 def456] Bug 7654321 - Fix message list focus. r=aleca,#mail-reviewers\n";
      }

      if (command.args.join(" ") === "rev-parse HEAD") {
        return "def4567890abcdef\n";
      }

      return "";
    },
  });

  assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [
    ["branch", "--show-current"],
    ["for-each-ref", "--format=%(refname:short)"],
    ["switch", "-c"],
    ["add", "-A"],
    ["commit", "-m"],
    ["rev-parse", "HEAD"],
  ]);
  assert.match(
    calls[4].args[2],
    /^Bug 7654321 - Fix message list focus\. r=aleca,#mail-reviewers\n\nTB-Tools-Id: [0-9a-f-]+$/,
  );
  assert.equal(result.hash, "def4567890abcdef");
  assert.match(
    result.commitMessage,
    /^Bug 7654321 - Fix message list focus\. r=aleca,#mail-reviewers\n\nTB-Tools-Id: [0-9a-f-]+$/,
  );
  assert.equal(result.branch, "Bug-7654321");
  assert.equal(result.message, "comm created commit def4567890ab.");
});

test("createGraphCommit creates and checks out a matching Bug branch", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-commit-branch-"));
  const git = async (args) =>
    (await run({
      cmd: "git",
      args,
      cwd: tempDir,
      capture: true,
      silent: true,
    })).trim();

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "tb-tools"]);
  await git(["config", "user.email", "tb-tools@example.invalid"]);
  await writeFile(path.join(tempDir, "base.txt"), "base\n");
  await git(["add", "base.txt"]);
  await git(["commit", "-m", "base"]);
  await git(["switch", "-c", "Bug-1234567"]);
  await writeFile(path.join(tempDir, "first-patch.txt"), "first patch\n");
  await git(["add", "first-patch.txt"]);
  await git(["commit", "-m", "Bug 1234567 - First patch"]);
  const previousPatch = await git(["rev-parse", "HEAD"]);
  await writeFile(path.join(tempDir, "second-patch.txt"), "second patch\n");
  const existingRefs = await git([
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    "refs/heads",
  ]);

  const graph = {
    label: "comm",
    path: tempDir,
    branch: "Bug-1234567",
  };
  const result = await createGraphCommit({
    graph,
    options: {
      bugId: "7654321",
      summary: "Second patch",
    },
    // Use the real Git executable without installing a hook in the temp repo.
    runCommand: (command) => run(command),
  });

  assert.equal(await git(["branch", "--show-current"]), "Bug-7654321");
  assert.equal(graph.branch, "Bug-7654321");
  assert.equal(result.branch, "Bug-7654321");
  assert.equal(await git(["rev-parse", "Bug-1234567"]), previousPatch);
  assert.equal(await git(["rev-parse", "Bug-7654321"]), result.hash);
  assert.equal(
    (await git([
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      "refs/heads",
    ]))
      .split("\n")
      .filter((ref) => !ref.startsWith("Bug-7654321 "))
      .join("\n"),
    existingRefs,
  );
  assert.equal(
    await git(["log", "-1", "--format=%s", "Bug-7654321"]),
    "Bug 7654321 - Second patch. r=",
  );
});

test("createGraphCommit creates a Bug branch before committing from main", async () => {
  const calls = [];
  const refs = new Map([["main", "base000"]]);
  let branch = "main";
  let head = "base000";
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "main",
  };
  const result = await createGraphCommit({
    graph,
    options: {
      bugId: "1234567",
      summary: "Keep main in place",
      reviewers: ["aleca"],
    },
    runCommand: async (command) => {
      calls.push(command);
      const args = command.args.join(" ");

      if (args === "branch --show-current") {
        return `${branch}\n`;
      }

      if (args === "for-each-ref --format=%(refname:short) refs/heads") {
        return `${[...refs.keys()].join("\n")}\n`;
      }

      if (args === "switch -c Bug-1234567") {
        branch = "Bug-1234567";
        refs.set(branch, head);
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "-m") {
        head = "def4567890abcdef";
        refs.set(branch, head);
        return "";
      }

      if (args === "rev-parse HEAD") {
        return `${head}\n`;
      }

      return "";
    },
  });

  assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [
    ["branch", "--show-current"],
    ["for-each-ref", "--format=%(refname:short)"],
    ["switch", "-c"],
    ["add", "-A"],
    ["commit", "-m"],
    ["rev-parse", "HEAD"],
  ]);
  assert.equal(refs.get("main"), "base000");
  assert.equal(refs.get("Bug-1234567"), "def4567890abcdef");
  assert.equal(graph.branch, "Bug-1234567");
  assert.equal(result.branch, "Bug-1234567");
  assert.match(result.commitMessage, /^Bug 1234567 - Keep main in place\. r=aleca/);
});

test("getGraphCommitMetadata requires a bug input for every new patch", async () => {
  const metadata = await getGraphCommitMetadata({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    runCommand: async () => "Bug-1234567\n",
  });

  assert.deepEqual(metadata, {
    label: "comm",
    path: "/repo/comm",
    branch: "Bug-1234567",
    bugId: "",
    bugRequired: true,
    prefix: "",
  });
});

test("createGraphCommit requires a Bugzilla bug ID from a Bug branch", async () => {
  await assert.rejects(
    createGraphCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
      },
      options: {
        summary: "Do not reuse the previous patch bug",
      },
      runCommand: async (command) => {
        if (command.args.join(" ") === "branch --show-current") {
          return "Bug-1234567\n";
        }

        throw new Error(`Unexpected command: ${command.args.join(" ")}`);
      },
    }),
    /Bugzilla bug ID is required for a new commit/,
  );
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
        return command.args.includes("def456")
          ? "Bug 123 - Better message. r=#reviewers\n\nUpdated body.\n\nTB-Tools-Id: amend-id\n"
          : "Bug 123 - Old message. r=#reviewers\n\nTB-Tools-Id: amend-id\n";
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
    "Bug 123 - Better message. r=#reviewers\n\nUpdated body.\n\nTB-Tools-Id: amend-id\n",
  );
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["branch", "--show-current"],
      ["log", "-1", "--format=%B"],
      [
        "diff",
        "--patch",
        "--unified=20",
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
        return command.args.includes("def456")
          ? "Bug 123 - Message only. r=#reviewers\n\nTB-Tools-Id: amend-message-id\n"
          : "Bug 123 - Old message. r=#reviewers\n\nTB-Tools-Id: amend-message-id\n";
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
  assert.equal(
    writes[0].content,
    "Bug 123 - Message only. r=#reviewers\n\nTB-Tools-Id: amend-message-id\n",
  );
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["branch", "--show-current"],
      ["log", "-1", "--format=%B"],
      ["commit", "--amend", "--only", "-F", writes[0].file],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["log", "-1", "--format=%B", "def456"],
    ],
  );
});

test("amendCurrentCommit moves local main work to its Bug branch before amending", async () => {
  const calls = [];
  const refs = { main: "old111" };
  let branch = "main";
  let head = "old111";
  const result = await amendCurrentCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
    },
    message: "Bug 2062537 - Amended patch. r=#reviewers",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return `${branch}\n`;
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        if (command.args[2] === "refs/remotes/origin/main") {
          return "origin-main\n";
        }

        if (command.args[2] === "refs/heads/main") {
          return `${refs.main}\n`;
        }
      }

      if (command.args[0] === "rev-parse") {
        return `${head}\n`;
      }

      if (command.args[0] === "merge-base") {
        const error = new Error("not on origin main");

        error.code = 1;
        throw error;
      }

      if (command.args[0] === "rev-list") {
        return "old111\n";
      }

      if (command.args[0] === "for-each-ref") {
        if (command.args.some((arg) => arg.includes("%(objectname)"))) {
          return `${Object.entries(refs)
            .map(([name, hash]) => `${name}\0${hash}`)
            .join("\n")}\n`;
        }

        return `${Object.keys(refs).join("\n")}\n`;
      }

      if (command.args[0] === "branch") {
        refs[command.args[1]] = command.args[2];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1];
        head = refs[branch];
        return "";
      }

      if (command.args[0] === "update-ref") {
        refs.main = command.args[2];
        return "";
      }

      if (command.args[0] === "commit") {
        head = "new111";
        refs[branch] = head;
        return "";
      }

      if (command.args[0] === "log") {
        return head === "new111"
          ? "Bug 2062537 - Amended patch. r=#reviewers\n\nTB-Tools-Id: amend-id\n"
          : "Bug 2062537 - Original patch. r=#reviewers\n\nTB-Tools-Id: amend-id\n";
      }

      return "";
    },
    writeMessage: async () => {},
    removeMessage: async () => {},
  });

  assert.equal(result.branch, "Bug-2062537");
  assert.equal(result.currentHash, "new111");
  assert.deepEqual(refs, {
    main: "origin-main",
    "Bug-2062537": "new111",
  });
  assert.equal(
    calls.findIndex((call) => call.args.join(" ") === "switch Bug-2062537") <
      calls.findIndex((call) => call.args[0] === "commit"),
    true,
  );
});

test("amendCurrentCommit keeps try runs on the rewritten commit", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-amend-try-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
  };
  let headHash = "old111";
  const runCommand = async (command) => {
    calls.push(command);

    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "branch") {
      return "topic\n";
    }

    if (command.args[0] === "rev-parse") {
      return `${headHash}\n`;
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return "Bug 123 - Message only. r=#reviewers\n\nTB-Tools-Id: amend-try-id\n";
    }

    if (command.cmd === "sh") {
      return `new-patch-id ${headHash}\n`;
    }

    if (command.args[0] === "commit" && command.args[1] === "--amend") {
      headHash = "new222";
      return "";
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "try-current-amend",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=current-amend",
      createdAt: "2026-07-31T12:00:00.000Z",
      hash: "old111",
      patchId: "old-patch-id",
      tbToolsId: "amend-try-id",
      subject: "Bug 123 - Message only. r=#reviewers",
      label: "comm",
    },
  });

  const result = await amendCurrentCommit({
    graph,
    message: "Bug 123 - Message only. r=#reviewers",
    runCommand,
    writeMessage: async () => {},
    removeMessage: async () => {},
  });

  assert.equal(result.rewrittenHash, "new222");

  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: {
      hash: "new222",
      subject: "Bug 123 - Message only. r=#reviewers",
    },
  });

  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=current-amend",
  );
  assert.equal(runs[0].hash, "new222");
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
        return command.args.includes("newabc999")
          ? "Bug 123 - Reword selected commit. r=#reviewers\n\nTB-Tools-Id: selected-amend-id\n"
          : "Bug 123 - Old selected commit. r=#reviewers\n\nTB-Tools-Id: selected-amend-id\n";
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
    "Bug 123 - Reword selected commit. r=#reviewers\n\nTB-Tools-Id: selected-amend-id\n",
  );
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["log", "-1", "--format=%B", "abc123"],
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
        "fed789",
        "refs/heads",
      ],
      ["switch", "--detach", "parent000"],
      ["cherry-pick", "--no-commit", "abc123"],
      ["commit", "-C", "abc123"],
      ["commit", "--amend", "--only", "-F", writes[0].file],
      ["rev-parse", "HEAD"],
      ["log", "-1", "--format=%B", "newabc999"],
      ["cherry-pick", "--no-commit", "def456"],
      ["commit", "-C", "def456"],
      ["rev-parse", "HEAD"],
      ["cherry-pick", "--no-commit", "fed789"],
      ["commit", "-C", "fed789"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "HEAD"],
      ["branch", "-f", "topic", "newtip999"],
      ["switch", "topic"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("amendCommitMessage moves every branch ref in the rewritten stack", async () => {
  const refs = {
    "Bug-123": "abc123",
    "Bug-456": "def456",
    topic: "fed789",
  };
  const revParseResults = [
    "fed789",
    "newabc999",
    "newdef999",
    "newtip999",
    "newtip999",
    "newtip999",
  ];
  let branch = "topic";

  const result = await amendCommitMessage({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch,
      knownHashes: new Set(["abc123", "def456", "fed789"]),
    },
    hash: "abc123",
    message: "Bug 123 - Reword selected commit. r=#reviewers",
    runCommand: async (command) => {
      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return `${branch}\n`;
      }

      if (command.args[0] === "rev-parse") {
        return `${revParseResults.shift() || "newtip999"}\n`;
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        if (command.args.includes("--contains")) {
          return "topic\n";
        }

        const hash = command.args[command.args.indexOf("--points-at") + 1];

        return Object.entries(refs)
          .filter(([, refHash]) => refHash === hash)
          .map(([ref]) => ref)
          .join("\n");
      }

      if (command.args[0] === "rev-list") {
        return command.args.includes("--parents")
          ? "abc123 parent000\n"
          : "def456\nfed789\n";
      }

      if (command.args[0] === "log") {
        return command.args.includes("newabc999")
          ? "Bug 123 - Reword selected commit. r=#reviewers\n\nTB-Tools-Id: selected-amend-id\n"
          : "Bug 123 - Old selected commit. r=#reviewers\n\nTB-Tools-Id: selected-amend-id\n";
      }

      if (command.args[0] === "branch" && command.args[1] === "-f") {
        refs[command.args[2]] = command.args[3];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1] === "--detach" ? "" : command.args[1];
      }

      return "";
    },
    writeMessage: async () => {},
    removeMessage: async () => {},
  });

  assert.deepEqual(refs, {
    "Bug-123": "newabc999",
    "Bug-456": "newdef999",
    topic: "newtip999",
  });
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-123", originalHash: "abc123", hash: "newabc999" },
    { branch: "Bug-456", originalHash: "def456", hash: "newdef999" },
    { branch: "topic", originalHash: "fed789", hash: "newtip999" },
  ]);
});

test("amendCommitMessage restores the checkout after a replay conflict", async () => {
  const calls = [];
  const removedMessages = [];

  await assert.rejects(
    amendCommitMessage({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "topic",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      message: "Bug 123 - Reword selected commit. r=#reviewers",
      runCommand: async (command) => {
        calls.push(command.args);

        if (command.args[0] === "log") {
          return "Bug 123 - Old selected commit. r=#reviewers\n";
        }

        if (command.args[0] === "branch") {
          return command.args[1] === "--show-current" ? "topic\n" : "";
        }

        if (command.args[0] === "rev-parse") {
          return "tip789\n";
        }

        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "for-each-ref") {
          return command.args.includes("--contains") ? "topic\n" : "";
        }

        if (command.args[0] === "rev-list") {
          return command.args.includes("--parents")
            ? "abc123 parent000\n"
            : "";
        }

        if (
          command.args[0] === "cherry-pick" &&
          command.args[1] === "--no-commit"
        ) {
          const error = new Error("conflict while applying commit");

          error.code = 1;
          throw error;
        }

        if (command.args[0] === "cherry-pick" || command.args[0] === "reset") {
          return "";
        }

        if (command.args[0] === "switch") {
          return "";
        }

        throw new Error(`Unexpected command: ${command.args.join(" ")}`);
      },
      writeMessage: async () => {},
      removeMessage: async (file) => removedMessages.push(file),
    }),
    /conflict while applying commit/,
  );

  assert.deepEqual(calls.slice(-3), [
    ["cherry-pick", "--abort"],
    ["reset", "--hard"],
    ["switch", "topic"],
  ]);
  assert.equal(removedMessages.length, 1);
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
    id: "review-firefox",
    checkout: "review",
    repository: "firefox",
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
  assert.equal(data.id, "review-firefox");
  assert.equal(data.checkout, "review");
  assert.equal(data.repository, "firefox");
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

test("rebaseCommit can rebase a Git-resolved commit outside the loaded graph page", async () => {
  const calls = [];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(),
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

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return "tb-tools-try-runs.json\n";
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
      ["cat-file", "-e", "abc123^{commit}"],
      ["status", "--porcelain"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["merge-base", "--is-ancestor", "abc123", "base123"],
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
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
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

test("rebaseCommit rejects concurrent replays for the same checkout", async () => {
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "main",
    knownHashes: new Set(["a111"]),
  };
  let releaseStatus;
  let markStatusStarted;
  const statusStarted = new Promise((resolve) => {
    markStatusStarted = resolve;
  });
  const statusHeld = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const first = rebaseCommit({
    graph,
    hash: "a111",
    runCommand: async (command) => {
      if (command.args[0] === "status") {
        markStatusStarted();
        await statusHeld;
        return "";
      }

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "a111\n";
      }

      return "";
    },
  });

  await statusStarted;
  await assert.rejects(
    rebaseCommit({ graph, hash: "a111" }),
    /A rebase is already running for comm/,
  );
  releaseStatus();
  await assert.rejects(first, /already checked out/);
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

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return "tb-tools-try-runs.json\n";
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
      ["merge-base", "--is-ancestor", "abc123", "base123"],
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
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
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

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return "tb-tools-try-runs.json\n";
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
      ["merge-base", "--is-ancestor", "abc123", "base123"],
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
        "abc123",
        "refs/heads",
      ],
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
  const rewrittenHashes = ["base000", "new111", "new222", "new333", "new444", "new555", "new555"];
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

      if (command.args[0] === "rev-list" && command.args[1] === "--parents") {
        const commit = command.args.at(-1);
        return `${commit} ${{ a111: "oldbase", b222: "a111", c333: "b222", d444: "a111", e555: "d444" }[commit]}\n`;
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

  assert.equal(result.message, "comm rebased branch Bug-202 (5 commits) onto main.");
  assert.equal(result.branch, "Bug-202");
  assert.deepEqual(result.commits, ["a111", "b222", "c333", "d444", "e555"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-100", originalHash: "a111", hash: "new111" },
    { branch: "Bug-101", originalHash: "b222", hash: "new222" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
    { branch: "Bug-201", originalHash: "d444", hash: "new444" },
    { branch: "Bug-202", originalHash: "e555", hash: "new555" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "a111"],
      ["cherry-pick", "--no-commit", "b222"],
      ["cherry-pick", "--no-commit", "c333"],
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

      if (command.args[0] === "rev-list" && command.args[1] === "--parents") {
        return "a111 base000\n";
      }

      if (command.args[0] === "merge-base") {
        if (command.args[2] === "base000") {
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
    [["rev-list", "--parents", "-n", "1", "a111"]],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [["cherry-pick", "--no-commit", "a111"]],
  );
});

test("rebaseCommit selected mode moves a tip branch and leaves its parent branch alone", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-rebase-real-"));
  const git = async (args) =>
    (await run({
      cmd: "git",
      args,
      cwd: tempDir,
      capture: true,
      silent: true,
    })).trim();

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "tb-tools"]);
  await git(["config", "user.email", "tb-tools@example.invalid"]);
  await writeFile(path.join(tempDir, "base.txt"), "base\n");
  await git(["add", "base.txt"]);
  await git(["commit", "-m", "base"]);

  const firstMain = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/origin/main", firstMain]);
  await git(["switch", "-c", "topic"]);
  await writeFile(path.join(tempDir, "parent.txt"), "parent\n");
  await git(["add", "parent.txt"]);
  await git(["commit", "-m", "Bug 1111111 - Parent"]);
  const parent = await git(["rev-parse", "HEAD"]);
  await git(["branch", "Bug-1111111", parent]);
  await writeFile(path.join(tempDir, "child.txt"), "child\n");
  await git(["add", "child.txt"]);
  await git(["commit", "-m", "Bug 2222222 - Child"]);
  const child = await git(["rev-parse", "HEAD"]);

  await git(["switch", "main"]);
  await writeFile(path.join(tempDir, "main.txt"), "main\n");
  await git(["add", "main.txt"]);
  await git(["commit", "-m", "advance main"]);
  const newMain = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/origin/main", newMain]);

  const graph = {
    label: "comm",
    path: tempDir,
    branch: "main",
    knownHashes: new Set([child]),
  };
  const result = await rebaseCommit({
    graph,
    hash: child,
    preferredBranch: "topic",
    rebaseMode: "selected",
  });

  assert.equal(result.mode, "selected");
  assert.equal(result.branch, "topic");
  assert.equal(result.detached, false);
  assert.deepEqual(result.commits, [child]);
  assert.deepEqual(result.preservedBranches, []);
  assert.deepEqual(result.branchUpdates, [
    { branch: "topic", originalHash: child, hash: result.currentHash },
  ]);
  assert.equal(await git(["rev-parse", "Bug-1111111"]), parent);
  assert.equal(await git(["rev-list", "--count", `origin/main..Bug-1111111`]), "1");
  assert.equal(await git(["rev-parse", "topic"]), result.currentHash);
  assert.equal(await git(["rev-list", "--count", "origin/main..topic"]), "1");
  assert.notEqual(result.currentHash, child);
  assert.equal(graph.branch, "topic");
});

test("rebaseCommit selected mode creates a parent branch when only the tip has one", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-rebase-real-"));
  const git = async (args) =>
    (await run({
      cmd: "git",
      args,
      cwd: tempDir,
      capture: true,
      silent: true,
    })).trim();

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "tb-tools"]);
  await git(["config", "user.email", "tb-tools@example.invalid"]);
  await writeFile(path.join(tempDir, "base.txt"), "base\n");
  await git(["add", "base.txt"]);
  await git(["commit", "-m", "base"]);

  const firstMain = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/origin/main", firstMain]);
  await git(["switch", "-c", "topic"]);
  await writeFile(path.join(tempDir, "parent.txt"), "parent\n");
  await git(["add", "parent.txt"]);
  await git(["commit", "-m", "Bug 1111111 - Parent"]);
  const parent = await git(["rev-parse", "HEAD"]);
  await writeFile(path.join(tempDir, "child.txt"), "child\n");
  await git(["add", "child.txt"]);
  await git(["commit", "-m", "Bug 2222222 - Child"]);
  const child = await git(["rev-parse", "HEAD"]);

  await git(["switch", "main"]);
  await writeFile(path.join(tempDir, "main.txt"), "main\n");
  await git(["add", "main.txt"]);
  await git(["commit", "-m", "advance main"]);
  const newMain = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/remotes/origin/main", newMain]);

  const graph = {
    label: "comm",
    path: tempDir,
    branch: "main",
    knownHashes: new Set([child]),
  };
  const result = await rebaseCommit({
    graph,
    hash: child,
    preferredBranch: "topic",
    rebaseMode: "selected",
  });

  assert.equal(result.mode, "selected");
  assert.equal(result.branch, "topic");
  assert.equal(result.detached, false);
  assert.deepEqual(result.commits, [child]);
  assert.deepEqual(result.preservedBranches, [{
    branch: "Bug-1111111",
    hash: parent,
    sourceBranch: "topic",
  }]);
  assert.deepEqual(result.branchUpdates, [
    {
      branch: "Bug-1111111",
      originalHash: parent,
      hash: parent,
      preserved: true,
    },
    { branch: "topic", originalHash: child, hash: result.currentHash },
  ]);
  assert.equal(await git(["rev-parse", "Bug-1111111"]), parent);
  assert.equal(await git(["rev-list", "--count", `origin/main..Bug-1111111`]), "1");
  assert.equal(await git(["rev-parse", "topic"]), result.currentHash);
  assert.equal(await git(["rev-list", "--count", "origin/main..topic"]), "1");
  assert.notEqual(result.currentHash, child);
  assert.equal(graph.branch, "topic");
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

test("rebaseCommit children mode preserves middle branch-per-commit mappings", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-rebase-try-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const commits = Array.from({ length: 9 }, (_, index) =>
    "c" + String(index + 1).padStart(3, "0"),
  );
  const selectedIndex = 4;
  const selectedCommit = commits[selectedIndex];
  const childCommits = commits.slice(selectedIndex);
  const branchByCommit = new Map(
    commits.map((commit, index) => [commit, `Bug-${101 + index}`]),
  );
  const rewrittenByCommit = new Map(
    childCommits.map((commit, index) => [
      commit,
      "new" + String(selectedIndex + index + 1).padStart(3, "0"),
    ]),
  );
  const rewrittenHashes = [
    "base000",
    ...childCommits.map((commit) => rewrittenByCommit.get(commit)),
    rewrittenByCommit.get(childCommits.at(-1)),
  ];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "main",
    knownHashes: new Set([selectedCommit]),
  };
  const runCommand = async (command) => {
    calls.push(command);

    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

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
      return childCommits.map((commit) => branchByCommit.get(commit)).join("\n") + "\n";
    }

    if (command.args[0] === "rev-list") {
      const range = command.args.at(-1);
      const branch = range.slice(range.indexOf("..") + 2);
      const targetIndex = Array.from(branchByCommit.values()).indexOf(branch);

      if (range.startsWith(`origin/main..`)) {
        throw new Error("children mode should not prepend unpublished parents");
      }

      return targetIndex <= selectedIndex
        ? ""
        : commits.slice(selectedIndex + 1, targetIndex + 1).join("\n") + "\n";
    }

    if (command.args[0] === "merge-base") {
      throw new Error("not on main");
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      return "Bug 105 - Middle commit\n\nTB-Tools-Id: middle-try-id\n";
    }

    if (command.cmd === "sh") {
      return `middle-patch-id ${command.args.at(-1)}\n`;
    }

    if (command.args[0] === "rev-parse") {
      return `${rewrittenHashes.shift()}\n`;
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "try-middle",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=middle",
      createdAt: "2026-07-30T12:00:00.000Z",
      hash: selectedCommit,
      tbToolsId: "middle-try-id",
      subject: "Bug 105 - Middle commit",
      label: "comm",
    },
  });

  const result = await rebaseCommit({
    graph,
    hash: selectedCommit,
    preferredBranch: branchByCommit.get(selectedCommit),
    rebaseMode: "children",
    runCommand,
  });

  assert.equal(result.mode, "children");
  assert.equal(result.branch, branchByCommit.get(commits.at(-1)));
  assert.deepEqual(result.commits, childCommits);
  assert.deepEqual(
    result.branchUpdates,
    childCommits.map((commit) => ({
      branch: branchByCommit.get(commit),
      originalHash: commit,
      hash: rewrittenByCommit.get(commit),
    })),
  );
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "branch" && call.args[1] === "-f")
      .map((call) => call.args),
    childCommits.map((commit) => [
      "branch",
      "-f",
      branchByCommit.get(commit),
      rewrittenByCommit.get(commit),
    ]),
  );
  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: {
      hash: rewrittenByCommit.get(selectedCommit),
      subject: "Bug 105 - Middle commit",
    },
  });

  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=middle",
  );
  assert.equal(runs[0].hash, rewrittenByCommit.get(selectedCommit));
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

test("rebaseCommit never replaces a patch branch with main when every replay is empty", async () => {
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
          return "patch-branch\n";
        }

        if (
          command.args[0] === "for-each-ref" &&
          command.args.includes("--contains")
        ) {
          return "patch-branch\n";
        }

        if (command.args[0] === "rev-list") {
          return command.args.at(-1) === "origin/main..a111"
            ? "a111\n"
            : "";
        }

        if (command.args[0] === "merge-base") {
          throw new Error("not on main");
        }

        if (command.args[0] === "cherry-pick") {
          const error = new Error("The previous cherry-pick is now empty.");
          error.stderr = "The previous cherry-pick is now empty.";
          throw error;
        }

        if (command.args[0] === "rev-parse") {
          return "base000\n";
        }

        return "";
      },
    }),
    /No branch references were changed/,
  );

  assert.equal(
    calls.some((call) => (
      call.args[0] === "branch" &&
      call.args[1] === "-f" &&
      call.args[2] === "patch-branch"
    )),
    false,
  );
  assert.equal(
    calls.some((call) => (
      call.args[0] === "switch" && call.args[1] === "patch-branch"
    )),
    true,
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

test("rebaseCommit refuses to rebase an ancestor onto the current checkout", async () => {
  const calls = [];

  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "topic",
        knownHashes: new Set(["parent123"]),
      },
      hash: "parent123",
      runCommand: async (command) => {
        calls.push(command.args);

        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "branch") {
          return "topic\n";
        }

        if (command.args[0] === "rev-parse") {
          return "child456\n";
        }

        if (command.args[0] === "merge-base") {
          assert.deepEqual(command.args, [
            "merge-base",
            "--is-ancestor",
            "parent123",
            "child456",
          ]);
          return "";
        }

        throw new Error(`Unexpected command: ${command.args.join(" ")}`);
      },
    }),
    /current checkout already descends from it/,
  );

  assert.equal(
    calls.some((args) => args[0] === "switch" || args[0] === "cherry-pick"),
    false,
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

test("getInteractiveRebasePlan builds a branch stack todo with fixup defaults", async () => {
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "main",
    knownHashes: new Set(["c1"]),
  };
  const messages = {
    c1: "Bug 123 - Base patch. r=#reviewers\n",
    c2: "fixup! Bug 123 - Base patch. r=#reviewers\n",
    c3: "squash! Bug 123 - Base patch. r=#reviewers\n",
  };
  const plan = await getInteractiveRebasePlan({
    graph,
    hash: "c1",
    preferredBranch: "Bug-123_3",
    runCommand: async (command) => {
      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];

        return {
          c1: "Bug-123\n",
          c2: "Bug-123_2\n",
          c3: "Bug-123_3\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-123\nBug-123_2\nBug-123_3\n";
      }

      if (command.args[0] === "rev-list" && command.args[1] === "--parents") {
        return "c1 base0\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "c1..Bug-123": "",
          "c1..Bug-123_2": "c2\n",
          "c1..Bug-123_3": "c2\nc3\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "log") {
        return messages[command.args.at(-1)] || "";
      }

      return "";
    },
  });

  assert.equal(plan.branch, "Bug-123_3");
  assert.equal(plan.base, "base0");
  assert.deepEqual(
    plan.commits.map((commit) => [commit.hash, commit.action]),
    [
      ["c1", "pick"],
      ["c2", "fixup"],
      ["c3", "squash"],
    ],
  );
});

test("startInteractiveRebase reorders commits and squashes messages", async () => {
  const calls = [];
  const messages = {
    c1: "Bug 123 - First patch. r=#reviewers\n\nFirst body.\n",
    c2: "Bug 123 - Second patch. r=#reviewers\n\nSecond body.\n",
    c3: "Bug 123 - Third patch. r=#reviewers\n\nThird body.\n",
  };
  const branchHeads = new Map();
  let currentHead = "checkout0";
  let squashedMessage = "";
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "Bug-123_2",
    knownHashes: new Set(["c1"]),
  };
  const runCommand = async (command) => {
    calls.push(command);

    if (command.args[0] === "status") {
      return "";
    }

    if (command.args[0] === "branch" && command.args[1] === "--show-current") {
      return "Bug-123_2\n";
    }

    if (
      command.args[0] === "for-each-ref" &&
      command.args.includes("--points-at")
    ) {
      const hash = command.args[command.args.indexOf("--points-at") + 1];

      return {
        c1: "Bug-123\n",
        c2: "Bug-123_2\n",
        c3: "Bug-123_3\n",
      }[hash] || "";
    }

    if (
      command.args[0] === "for-each-ref" &&
      command.args.includes("--contains")
    ) {
      return "Bug-123\nBug-123_2\nBug-123_3\n";
    }

    if (command.args[0] === "rev-list" && command.args[1] === "--parents") {
      return "c1 base0\n";
    }

    if (command.args[0] === "rev-list") {
      return {
        "c1..Bug-123": "",
        "c1..Bug-123_2": "c2\n",
        "c1..Bug-123_3": "c2\nc3\n",
      }[command.args.at(-1)] || "";
    }

    if (command.args[0] === "merge-base") {
      throw new Error("not on main");
    }

    if (command.args[0] === "switch" && command.args[1] === "--detach") {
      currentHead = command.args[2];
      return "";
    }

    if (command.args[0] === "switch") {
      currentHead = branchHeads.get(command.args[1]) || currentHead;
      return "";
    }

    if (command.args[0] === "cherry-pick") {
      return "";
    }

    if (command.args[0] === "commit" && command.args[1] === "-C") {
      currentHead = "new-" + command.args[2];
      return "";
    }

    if (command.args[0] === "commit" && command.args[1] === "--amend") {
      squashedMessage = readFileSync(command.args.at(-1), "utf8");
      currentHead = "squashed-c2-c1";
      return "";
    }

    if (command.args[0] === "branch" && command.args[1] === "-f") {
      branchHeads.set(command.args[2], command.args[3]);
      return "";
    }

    if (command.args[0] === "rev-parse") {
      return `${currentHead}\n`;
    }

    if (command.args[0] === "log") {
      return {
        ...messages,
        "new-c2": messages.c2,
        "squashed-c2-c1": squashedMessage,
        "new-c3": messages.c3,
      }[command.args.at(-1)] || "";
    }

    return "";
  };

  const result = await startInteractiveRebase({
    graph,
    graphIndex: 0,
    hash: "c1",
    preferredBranch: "Bug-123_3",
    items: [
      { hash: "c2", action: "pick" },
      { hash: "c1", action: "squash" },
      { hash: "c3", action: "pick" },
    ],
    runCommand,
  });

  assert.equal(result.action, "interactive-rebase");
  assert.equal(result.branch, "Bug-123_3");
  assert.equal(result.currentHash, "new-c3");
  assert.match(squashedMessage, /Second body\./);
  assert.match(squashedMessage, /First body\./);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-123", originalHash: "c1", hash: "squashed-c2-c1" },
    { branch: "Bug-123_2", originalHash: "c2", hash: "squashed-c2-c1" },
    { branch: "Bug-123_3", originalHash: "c3", hash: "new-c3" },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "cherry-pick")
      .map((call) => call.args),
    [
      ["cherry-pick", "--no-commit", "c2"],
      ["cherry-pick", "--no-commit", "c1"],
      ["cherry-pick", "--no-commit", "c3"],
    ],
  );
});

test("startInteractiveRebase pauses for edit and continues after manual amend", async () => {
  const calls = [];
  const messages = {
    c1: "Bug 123 - First patch. r=#reviewers\n",
    c2: "Bug 123 - Second patch. r=#reviewers\n",
    amended1: "Bug 123 - First patch amended. r=#reviewers\n",
    new2: "Bug 123 - Second patch. r=#reviewers\n",
  };
  const branchHeads = new Map();
  let currentHead = "checkout0";
  let session;
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "Bug-123",
    knownHashes: new Set(["c1"]),
  };
  const runCommand = async (command) => {
    calls.push(command);

    if (command.args[0] === "status") {
      return "";
    }

    if (command.args[0] === "branch" && command.args[1] === "--show-current") {
      return "Bug-123\n";
    }

    if (
      command.args[0] === "for-each-ref" &&
      command.args.includes("--points-at")
    ) {
      const hash = command.args[command.args.indexOf("--points-at") + 1];

      return {
        c1: "Bug-123\n",
        c2: "Bug-123_2\n",
      }[hash] || "";
    }

    if (
      command.args[0] === "for-each-ref" &&
      command.args.includes("--contains")
    ) {
      return "Bug-123\nBug-123_2\n";
    }

    if (command.args[0] === "rev-list" && command.args[1] === "--parents") {
      return "c1 base0\n";
    }

    if (command.args[0] === "rev-list") {
      return {
        "c1..Bug-123": "",
        "c1..Bug-123_2": "c2\n",
      }[command.args.at(-1)] || "";
    }

    if (command.args[0] === "merge-base") {
      throw new Error("not on main");
    }

    if (command.args[0] === "switch" && command.args[1] === "--detach") {
      currentHead = command.args[2];
      return "";
    }

    if (command.args[0] === "switch") {
      currentHead = branchHeads.get(command.args[1]) || currentHead;
      return "";
    }

    if (command.args[0] === "cherry-pick") {
      return "";
    }

    if (command.args[0] === "commit" && command.args[1] === "-C") {
      currentHead = command.args[2] === "c1" ? "new1" : "new2";
      return "";
    }

    if (command.args[0] === "branch" && command.args[1] === "-f") {
      branchHeads.set(command.args[2], command.args[3]);
      return "";
    }

    if (command.args[0] === "rev-parse") {
      return `${currentHead}\n`;
    }

    if (command.args[0] === "log") {
      return {
        ...messages,
        new1: messages.c1,
      }[command.args.at(-1)] || "";
    }

    return "";
  };

  await assert.rejects(
    startInteractiveRebase({
      graph,
      graphIndex: 0,
      hash: "c1",
      preferredBranch: "Bug-123_2",
      items: [
        { hash: "c1", action: "edit" },
        { hash: "c2", action: "pick" },
      ],
      runCommand,
    }),
    (error) => {
      session = error.rebaseState;
      assert.equal(error.rebaseConflict.type, "edit");
      assert.equal(error.rebaseConflict.canContinue, true);
      return true;
    },
  );

  currentHead = "amended1";
  const result = await continueRebaseCommit({
    session,
    runCommand,
  });

  assert.equal(result.currentHash, "new2");
  assert.deepEqual(result.rewrittenCommits, [
    { originalHash: "c1", hash: "amended1" },
    { originalHash: "c2", hash: "new2" },
  ]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-123", originalHash: "c1", hash: "amended1" },
    { branch: "Bug-123_2", originalHash: "c2", hash: "new2" },
  ]);
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
      ["rev-parse", "--verify", "refs/remotes/origin/main"],
      ["rev-parse", "--verify", "refs/heads/main"],
      ["switch", "main"],
      ["pull", "--ff-only", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("updateGraphCheckout recovers every unbranched local main commit before updating", async () => {
  const calls = [];
  const refs = {
    main: "local-three",
    "Bug-1": "local-one",
  };
  let branch = "main";
  let head = "local-three";
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "main",
  };

  const result = await updateGraphCheckout({
    graph,
    mode: "update",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        if (command.args[2] === "refs/remotes/origin/main") {
          return "origin-new\n";
        }

        if (command.args[2] === "refs/heads/main") {
          return `${refs.main}\n`;
        }
      }

      if (command.args[0] === "rev-parse") {
        return `${head}\n`;
      }

      if (command.args[0] === "merge-base") {
        const error = new Error("not an ancestor");

        error.code = 1;
        throw error;
      }

      if (command.args[0] === "rev-list") {
        return "local-one\nlocal-two\nlocal-three\n";
      }

      if (command.args[0] === "for-each-ref") {
        if (command.args.some((arg) => arg.includes("%(objectname)"))) {
          return `${Object.entries(refs)
            .map(([name, hash]) => `${name}\0${hash}`)
            .join("\n")}\n`;
        }

        return `${Object.keys(refs).join("\n")}\n`;
      }

      if (command.args[0] === "log") {
        return command.args.at(-1) === "local-three"
          ? "Bug 2062537 - Local patch.\n"
          : "No bug - Local follow-up.\n";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return `${branch}\n`;
      }

      if (command.args[0] === "branch") {
        refs[command.args[1]] = command.args[2];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1];
        head = refs[branch];
        return "";
      }

      if (command.args[0] === "update-ref") {
        refs.main = command.args[2];
        return "";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm updated main from origin/main after recovering 2 branches.");
  assert.equal(result.branch, "main");
  assert.deepEqual(refs, {
    main: "origin-new",
    "Bug-1": "local-one",
    "recovery/local-two": "local-two",
    "Bug-2062537": "local-three",
  });
  assert.equal(
    calls.some((call) =>
      call.args.join(" ") === "update-ref refs/heads/main origin-new local-three"),
    true,
  );
  assert.equal(calls.some((call) => call.args[0] === "pull"), true);
});

test("updateGraphCheckout rebases local branch commits onto origin main", async () => {
  const calls = [];
  const refs = {
    main: "main-old",
    "Bug-1": "root111",
    topic: "child222",
    "stale-root": "old-root",
    "stale-child": "old-child",
  };
  const messages = {
    root111: "Bug 1 - Root patch.\n",
    child222: "Bug 1 - Child patch.\n\nTB-Tools-Id: child-id\n",
    "old-root": "Bug 1 - Root patch.\n",
    "old-child": "Bug 1 - Child patch.\n\nTB-Tools-Id: child-id\n",
  };
  const rewritten = {
    root111: "root-new",
    child222: "child-new",
  };
  let branch = "topic";
  let head = "child222";
  let pendingCherryPick = "";
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

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return branch ? `${branch}\n` : "";
      }

      if (command.args[0] === "rev-list") {
        return "root111\nchild222\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        if (command.args[2] === "refs/remotes/origin/main") {
          return "origin-new\n";
        }

        if (command.args[2] === "refs/heads/main") {
          return `${refs.main}\n`;
        }
      }

      if (command.args[0] === "merge-base") {
        if (["old-root", "old-child"].includes(command.args[2])) {
          const error = new Error("not an ancestor");
          error.code = 1;
          throw error;
        }

        return "";
      }

      if (command.args[0] === "update-ref") {
        refs.main = command.args[2];
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        if (!command.args.includes("--points-at")) {
          return `${Object.entries(refs)
            .map(([name, hash]) => `${name}\0${hash}`)
            .join("\n")}\n`;
        }

        const pointsAt = command.args[command.args.indexOf("--points-at") + 1];
        const names = Object.entries(refs)
          .filter(([, hash]) => hash === pointsAt)
          .map(([name]) => name)
          .sort();

        return `${names.join("\n")}${names.length ? "\n" : ""}`;
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return messages[command.args.at(-1)] || "";
      }

      if (command.args[0] === "switch" && command.args[1] === "--detach") {
        branch = "";
        head = command.args[2];
        return "";
      }

      if (command.args[0] === "cherry-pick") {
        pendingCherryPick = command.args.at(-1);
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "-C") {
        head = rewritten[pendingCherryPick];
        pendingCherryPick = "";
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "-f") {
        refs[command.args[2]] = command.args[3];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1];
        head = refs[branch];
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return `${head}\n`;
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
  assert.equal(result.currentHash, "child-new");
  assert.deepEqual(refs, {
    main: "origin-new",
    "Bug-1": "root-new",
    topic: "child-new",
    "stale-root": "old-root",
    "stale-child": "old-child",
  });
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-1", originalHash: "root111", hash: "root-new" },
    { branch: "topic", originalHash: "child222", hash: "child-new" },
  ]);
  assert.equal(
    calls.some((call) => call.args[0] === "rebase"),
    false,
  );
  assert.equal(
    calls.some((call) =>
      call.args[0] === "update-ref" &&
      call.args[1] === "refs/heads/main" &&
      call.args[2] === "origin-new" &&
      call.args[3] === "main-old"
    ),
    true,
  );
});

test("updateGraphCheckout rebases the containing branch for a detached checkout", async () => {
  const calls = [];
  const refs = {
    main: "main-old",
    topic: "child222",
  };
  const rewritten = {
    current123: "current-new",
    child222: "child-new",
  };
  let branch = "";
  let head = "current123";
  let pendingCherryPick = "";
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

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return branch ? `${branch}\n` : "";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        if (command.args[2] === "refs/remotes/origin/main") {
          return "origin-new\n";
        }

        if (command.args[2] === "refs/heads/main") {
          return `${refs.main}\n`;
        }
      }

      if (command.args[0] === "rev-parse") {
        return `${head}\n`;
      }

      if (command.args[0] === "for-each-ref") {
        if (command.args.includes("--contains")) {
          return "topic\n";
        }

        const pointsAt = command.args[command.args.indexOf("--points-at") + 1];
        const names = Object.entries(refs)
          .filter(([, hash]) => hash === pointsAt)
          .map(([name]) => name)
          .sort();

        return `${names.join("\n")}${names.length ? "\n" : ""}`;
      }

      if (command.args[0] === "rev-list") {
        return "current123\nchild222\n";
      }

      if (command.args[0] === "merge-base") {
        return "";
      }

      if (command.args[0] === "update-ref") {
        refs.main = command.args[2];
        return "";
      }

      if (command.args[0] === "switch" && command.args[1] === "--detach") {
        branch = "";
        head = command.args[2];
        return "";
      }

      if (command.args[0] === "cherry-pick") {
        pendingCherryPick = command.args.at(-1);
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "-C") {
        head = rewritten[pendingCherryPick];
        pendingCherryPick = "";
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "-f") {
        refs[command.args[2]] = command.args[3];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1];
        head = refs[branch];
        return "";
      }

      return "";
    },
  });

  assert.equal(result.branch, "topic");
  assert.equal(result.rebasedCount, 2);
  assert.deepEqual(result.commits, ["current123", "child222"]);
  assert.equal(result.currentHash, "child-new");
  assert.deepEqual(refs, {
    main: "origin-new",
    topic: "child-new",
  });
  assert.equal(
    calls.some((call) => call.args[0] === "rebase"),
    false,
  );
});

test("updateGraphCheckout keeps try runs on commits rewritten by update rebase", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-update-try-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "topic",
  };
  const refs = {
    main: "main-old",
    topic: "old222",
  };
  const messages = {
    old111: "Bug 123 - Patch one. r=#reviewers\n\nTB-Tools-Id: patch-one-id\n",
    old222: "Bug 123 - Patch two. r=#reviewers\n\nTB-Tools-Id: patch-two-id\n",
    new111: "Bug 123 - Patch one. r=#reviewers\n\nTB-Tools-Id: patch-one-id\n",
    new222:
      "Bug 123 - Patch two after upstream drift. r=#reviewers\n\nTB-Tools-Id: patch-two-id\n",
  };
  const rewritten = {
    old111: "new111",
    old222: "new222",
  };
  let branch = "topic";
  let head = "old222";
  let pendingCherryPick = "";
  const runCommand = async (command) => {
    calls.push(command);

    if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
      return storePath;
    }

    if (command.args[0] === "branch" && command.args[1] === "--show-current") {
      return branch ? `${branch}\n` : "";
    }

    if (command.args[0] === "rev-list") {
      return "old111\nold222\n";
    }

    if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
      if (command.args[2] === "refs/remotes/origin/main") {
        return "origin-new\n";
      }

      if (command.args[2] === "refs/heads/main") {
        return `${refs.main}\n`;
      }
    }

    if (command.args[0] === "log" && command.args.includes("--format=%B")) {
      const hash = command.args.at(-1);

      return messages[hash] || messages[head] || "";
    }

    if (command.cmd === "sh") {
      const hash = command.args.at(-1);
      return hash.endsWith("222")
        ? `${hash === "old222" ? "old" : "new"}-patch-two 0000000000000000000000000000000000000000\n`
        : "patch-one 0000000000000000000000000000000000000000\n";
    }

    if (command.args[0] === "merge-base") {
      return "";
    }

    if (command.args[0] === "update-ref") {
      refs.main = command.args[2];
      return "";
    }

    if (command.args[0] === "for-each-ref") {
      const pointsAt = command.args[command.args.indexOf("--points-at") + 1];
      const names = Object.entries(refs)
        .filter(([, hash]) => hash === pointsAt)
        .map(([name]) => name)
        .sort();

      return `${names.join("\n")}${names.length ? "\n" : ""}`;
    }

    if (command.args[0] === "switch" && command.args[1] === "--detach") {
      branch = "";
      head = command.args[2];
      return "";
    }

    if (command.args[0] === "cherry-pick") {
      pendingCherryPick = command.args.at(-1);
      return "";
    }

    if (command.args[0] === "commit" && command.args[1] === "-C") {
      head = rewritten[pendingCherryPick];
      pendingCherryPick = "";
      return "";
    }

    if (command.args[0] === "branch" && command.args[1] === "-f") {
      refs[command.args[2]] = command.args[3];
      return "";
    }

    if (command.args[0] === "switch") {
      branch = command.args[1];
      head = refs[branch];
      return "";
    }

    if (command.args[0] === "rev-parse") {
      return `${head}\n`;
    }

    return "";
  };

  t.after(() => rm(tempDir, { recursive: true, force: true }));

  await recordGraphTryRun({
    graph,
    runCommand,
    tryRun: {
      id: "try-update-rebase",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=update-rebase",
      createdAt: "2026-07-31T12:30:00.000Z",
      hash: "old222",
      tbToolsId: "patch-two-id",
      patchId: "old-patch-two",
      subject: "Bug 123 - Patch two. r=#reviewers",
      label: "comm",
    },
  });

  const result = await updateGraphCheckout({
    graph,
    mode: "rebase",
    runCommand,
  });

  assert.deepEqual(result.commits, ["old111", "old222"]);
  assert.equal(
    calls.some((call) => call.cmd === "git" && call.args[0] === "rebase"),
    false,
  );
  assert.equal(refs.topic, "new222");

  const runs = await getGraphTryRunsForCommit({
    graph,
    runCommand,
    commit: {
      hash: "new222",
      subject: "Bug 123 - Patch two. r=#reviewers",
    },
  });

  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].url,
    "https://treeherder.mozilla.org/jobs?repo=try&revision=update-rebase",
  );
  assert.equal(runs[0].hash, "new222");
  assert.equal(runs[0].tbToolsId, "patch-two-id");
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
          files: ["file.txt"],
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

test("runGraphRepositoryUpdate updates only the selected checkout pair", async () => {
  const calls = [];
  const graphs = [
    { label: "Working comm", checkout: "working", path: "/working/comm" },
    { label: "Working firefox", checkout: "working", path: "/working" },
    { label: "Review comm", checkout: "review", path: "/review/comm" },
    { label: "Review firefox", checkout: "review", path: "/review" },
  ];
  const result = await runGraphRepositoryUpdate({
    graphs,
    mode: "update",
    scope: "current",
    graphIndex: 2,
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "review-main\n";
      }

      return "";
    },
  });

  assert.equal(result.scope, "current");
  assert.deepEqual(result.graphIndexes, [2, 3]);
  assert.deepEqual(result.results.map(({ label }) => label), [
    "Review comm",
    "Review firefox",
  ]);
  assert.equal(calls.some((call) => call.cwd.startsWith("/working")), false);
  assert.equal(calls.some((call) => call.cwd.startsWith("/review")), true);
});

test("copyGraphCommitsBetweenCheckouts copies a stack onto a new destination branch", async () => {
  const calls = [];
  const source = {
    label: "Working comm",
    checkout: "working",
    repository: "comm",
    path: "/working/comm",
  };
  const destination = {
    label: "Review comm",
    checkout: "review",
    repository: "comm",
    path: "/review/comm",
  };
  let destinationHeadCalls = 0;
  const result = await copyGraphCommitsBetweenCheckouts({
    source,
    destination,
    hash: "tip222",
    mode: "stack",
    runCommand: async (command) => {
      calls.push(command);

      if (command.cwd === source.path && command.args[0] === "rev-parse") {
        return "tip222\n";
      }

      if (command.cwd === source.path && command.args[0] === "rev-list") {
        return "base111\ntip222\n";
      }

      if (command.cwd === source.path && command.args[0] === "for-each-ref") {
        return "Bug-1234567\n";
      }

      if (command.cwd === destination.path && command.args[0] === "status") {
        return "";
      }

      if (command.cwd === destination.path && command.args[0] === "show-ref") {
        const error = new Error("missing branch");

        error.code = 1;
        throw error;
      }

      if (command.cwd === destination.path && command.args[0] === "merge-base") {
        const error = new Error("not on destination main");

        error.code = 1;
        throw error;
      }

      if (command.cwd === destination.path && command.args[0] === "branch") {
        return "main\n";
      }

      if (command.cwd === destination.path && command.args[0] === "rev-parse") {
        destinationHeadCalls += 1;
        return destinationHeadCalls === 1 ? "old-main\n" : "copied-tip\n";
      }

      return "";
    },
  });

  assert.equal(result.branch, "Bug-1234567");
  assert.deepEqual(result.copiedCommits, ["base111", "tip222"]);
  assert.equal(result.currentHash, "copied-tip");
  assert.equal(destination.branch, "Bug-1234567");
  assert.deepEqual(
    calls
      .filter((command) => command.cwd === destination.path)
      .map((command) => command.args),
    [
      ["status", "--porcelain"],
      ["check-ref-format", "--branch", "Bug-1234567"],
      ["show-ref", "--verify", "--quiet", "refs/heads/Bug-1234567"],
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "/working/comm",
        "tip222",
      ],
      ["merge-base", "--is-ancestor", "base111", "origin/main"],
      ["merge-base", "--is-ancestor", "tip222", "origin/main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
      ["switch", "--create", "Bug-1234567", "origin/main"],
      ["cherry-pick", "-x", "base111"],
      ["cherry-pick", "-x", "tip222"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("copyGraphCommitsBetweenCheckouts requires confirmation before discarding destination changes", async () => {
  const source = {
    label: "Working comm",
    checkout: "working",
    repository: "comm",
    path: "/working/comm",
  };
  const destination = {
    label: "Review comm",
    checkout: "review",
    repository: "comm",
    path: "/review/comm",
  };

  await assert.rejects(
    copyGraphCommitsBetweenCheckouts({
      source,
      destination,
      hash: "tip222",
      runCommand: async (command) => {
        if (command.cwd === source.path && command.args[0] === "rev-parse") {
          return "tip222\n";
        }

        if (command.cwd === source.path && command.args[0] === "for-each-ref") {
          return "Bug-1234567\n";
        }

        if (command.cwd === destination.path && command.args[0] === "status") {
          return " M file.txt\n";
        }

        return "";
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.transfer.reason, "destination-dirty");
      return /local changes/.test(error.message);
    },
  );
});

test("copyGraphCommitsBetweenCheckouts ignores untracked destination files", async () => {
  const source = {
    label: "Working comm",
    checkout: "working",
    repository: "comm",
    path: "/working/comm",
  };
  const destination = {
    label: "Review comm",
    checkout: "review",
    repository: "comm",
    path: "/review/comm",
  };
  const calls = [];
  let destinationHeadCalls = 0;

  await copyGraphCommitsBetweenCheckouts({
    source,
    destination,
    hash: "tip222",
    branch: "Bug-1234567",
    runCommand: async (command) => {
      calls.push(command);

      if (command.cwd === source.path && command.args[0] === "rev-parse") {
        return "tip222\n";
      }

      if (command.cwd === destination.path && command.args[0] === "status") {
        return "?? .DS_Store\n";
      }

      if (command.cwd === destination.path && command.args[0] === "show-ref") {
        const error = new Error("missing branch");

        error.code = 1;
        throw error;
      }

      if (command.cwd === destination.path && command.args[0] === "merge-base") {
        const error = new Error("not on destination main");

        error.code = 1;
        throw error;
      }

      if (command.cwd === destination.path && command.args[0] === "branch") {
        return "main\n";
      }

      if (command.cwd === destination.path && command.args[0] === "rev-parse") {
        destinationHeadCalls += 1;
        return destinationHeadCalls === 1 ? "old-main\n" : "copied-tip\n";
      }

      return "";
    },
  });

  assert.equal(calls.some((command) => command.args[0] === "clean"), false);
  assert.equal(calls.some((command) => command.args[0] === "cherry-pick"), true);
});

test("syncReviewCheckoutFromWorking requires an explicit destructive confirmation", async () => {
  await assert.rejects(
    syncReviewCheckoutFromWorking({
      graphs: [],
      confirmation: "sync review",
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.reviewSync.reason, "confirmation-required");
      return /Type SYNC REVIEW/.test(error.message);
    },
  );
});

test("syncReviewCheckoutFromWorking refuses tracked Working changes before touching Review", async () => {
  const calls = [];

  await assert.rejects(
    syncReviewCheckoutFromWorking({
      confirmation: "SYNC REVIEW",
      graphs: [
        { checkout: "working", repository: "firefox", path: "/working" },
        { checkout: "working", repository: "comm", path: "/working/comm" },
        { checkout: "review", repository: "firefox", path: "/review" },
        { checkout: "review", repository: "comm", path: "/review/comm" },
      ],
      runCommand: async (command) => {
        calls.push(command);

        if (command.args[0] === "status" && command.cwd === "/working") {
          return " M source.txt\n";
        }

        return ".git\n";
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.reviewSync.reason, "source-dirty");
      return /tracked Working changes/.test(error.message);
    },
  );

  assert.equal(
    calls.some((command) => command.cwd.startsWith("/review") && command.args[0] === "reset"),
    false,
  );
});

test("syncReviewCheckoutFromWorking replaces both review repositories and mirrors build artifacts", async () => {
  const graphs = [
    {
      label: "Working firefox",
      checkout: "working",
      repository: "firefox",
      path: "/working",
    },
    {
      label: "Working comm",
      checkout: "working",
      repository: "comm",
      path: "/working/comm",
    },
    {
      label: "Review firefox",
      checkout: "review",
      repository: "firefox",
      path: "/review",
    },
    {
      label: "Review comm",
      checkout: "review",
      repository: "comm",
      path: "/review/comm",
    },
  ];
  const calls = [];
  const removals = [];
  const directoryCopies = [];
  const fileCopies = [];
  const sourceStates = new Map([
    ["/working", { hash: "firefox-head", branch: "main" }],
    ["/working/comm", { hash: "comm-head", branch: "Bug-1234567" }],
  ]);
  const directoryEntry = (name) => ({ name, isDirectory: () => true, isFile: () => false });
  const fileEntry = (name) => ({ name, isDirectory: () => false, isFile: () => true });
  const result = await syncReviewCheckoutFromWorking({
    graphs,
    confirmation: "SYNC REVIEW",
    runCommand: async (command) => {
      calls.push(command);
      const sourceState = sourceStates.get(command.cwd);

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-dir") {
        return ".git\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        return `${sourceState?.hash || "review-head"}\n`;
      }

      if (sourceState && command.args[0] === "symbolic-ref") {
        return `${sourceState.branch}\n`;
      }

      if (["rebase", "cherry-pick", "merge", "am"].includes(command.args[0])) {
        throw new Error("no operation in progress");
      }

      return "";
    },
    readDirectory: async (directory) => {
      if (directory === "/working") {
        return [
          directoryEntry("obj-aarch64"),
          fileEntry("mozconfig"),
          fileEntry("notes.txt"),
        ];
      }

      return [
        directoryEntry("obj-aarch64"),
        directoryEntry("obj-stale"),
        fileEntry("mozconfig-old"),
      ];
    },
    remove: async (target, options) => removals.push([target, options]),
    copyDirectory: async (source, destination, options) => {
      directoryCopies.push([source, destination, options]);
    },
    copyFile: async (source, destination, mode) => {
      fileCopies.push([source, destination, mode]);
    },
  });

  assert.deepEqual(result.repositories.map((repository) => ({
    repository: repository.repository,
    hash: repository.destination.hash,
    branch: repository.destination.branch,
  })), [
    { repository: "firefox", hash: "firefox-head", branch: "main" },
    { repository: "comm", hash: "comm-head", branch: "Bug-1234567" },
  ]);
  assert.deepEqual(result.artifacts, {
    copied: ["obj-aarch64", "mozconfig"],
    removed: ["obj-stale", "mozconfig-old"],
  });
  assert.deepEqual(removals.map(([target]) => target), [
    "/review/obj-stale",
    "/review/mozconfig-old",
    "/review/obj-aarch64",
  ]);
  assert.deepEqual(directoryCopies.map(([source, destination]) => [source, destination]), [
    ["/working/obj-aarch64", "/review/obj-aarch64"],
  ]);
  assert.deepEqual(fileCopies.map(([source, destination]) => [source, destination]), [
    ["/working/mozconfig", "/review/mozconfig"],
  ]);

  const reviewCommands = calls.filter((command) => command.cwd.startsWith("/review"));
  const workingCommands = calls.filter((command) => command.cwd.startsWith("/working"));

  assert.equal(
    workingCommands.some((command) => ["clean", "reset", "gc"].includes(command.args[0])),
    false,
  );
  assert.equal(
    reviewCommands.filter((command) => command.args[0] === "clean").every(
      (command) => command.args.includes("-ffdx"),
    ),
    true,
  );
  assert.equal(reviewCommands.filter((command) => command.args[0] === "gc").length, 2);
  assert.deepEqual(
    reviewCommands
      .filter((command) => command.args[0] === "fetch")
      .map((command) => command.args.slice(1, 6)),
    [
      ["--no-tags", "--prune", "--refmap=+refs/*:refs/*", "/working", "+refs/*:refs/*"],
      ["--no-tags", "--prune", "--refmap=+refs/*:refs/*", "/working/comm", "+refs/*:refs/*"],
    ],
  );
});

test("syncReviewCheckoutFromWorking makes review refs and build outputs match real working clones", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-tools-review-sync-"));
  const workingFirefox = path.join(root, "working-firefox");
  const workingComm = path.join(workingFirefox, "comm");
  const reviewFirefox = path.join(root, "review-firefox");
  const reviewComm = path.join(reviewFirefox, "comm");
  const git = async (cwd, args) => run({
    cmd: "git",
    args,
    cwd,
    capture: true,
    silent: true,
  });
  const configureRepository = async (repository) => {
    await git(repository, ["config", "user.email", "tb-tools@example.invalid"]);
    await git(repository, ["config", "user.name", "TB Tools Test"]);
  };

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workingFirefox, { recursive: true });
  await git(workingFirefox, ["init", "--initial-branch=main"]);
  await configureRepository(workingFirefox);
  await writeFile(path.join(workingFirefox, "source.txt"), "working firefox\n");
  await git(workingFirefox, ["add", "source.txt"]);
  await git(workingFirefox, ["commit", "-m", "working firefox"]);
  await git(workingFirefox, ["branch", "Bug-1000000"]);

  await mkdir(workingComm, { recursive: true });
  await git(workingComm, ["init", "--initial-branch=main"]);
  await configureRepository(workingComm);
  await writeFile(path.join(workingComm, "source.txt"), "working comm\n");
  await git(workingComm, ["add", "source.txt"]);
  await git(workingComm, ["commit", "-m", "working comm"]);
  await git(workingComm, ["switch", "-c", "Bug-1000001"]);
  await writeFile(path.join(workingComm, "bug.txt"), "working branch\n");
  await git(workingComm, ["add", "bug.txt"]);
  await git(workingComm, ["commit", "-m", "working comm branch"]);

  await git(root, ["clone", workingFirefox, reviewFirefox]);
  await git(root, ["clone", workingComm, reviewComm]);
  await configureRepository(reviewFirefox);
  await configureRepository(reviewComm);
  await git(reviewFirefox, ["switch", "-c", "review-only"]);
  await writeFile(path.join(reviewFirefox, "review-only.txt"), "remove me\n");
  await git(reviewFirefox, ["add", "review-only.txt"]);
  await git(reviewFirefox, ["commit", "-m", "review only"]);
  await git(reviewComm, ["switch", "-c", "review-only"]);
  await writeFile(path.join(reviewComm, "review-only.txt"), "remove me\n");
  await git(reviewComm, ["add", "review-only.txt"]);
  await git(reviewComm, ["commit", "-m", "review only"]);

  await writeFile(path.join(workingFirefox, "mozconfig"), "ac_add_options --enable-project=comm/mail\n");
  await mkdir(path.join(workingFirefox, "obj-test"), { recursive: true });
  await writeFile(path.join(workingFirefox, "obj-test", "artifact.txt"), "reuse this build\n");
  await mkdir(path.join(reviewFirefox, "obj-stale"), { recursive: true });
  await writeFile(path.join(reviewFirefox, "obj-stale", "artifact.txt"), "discard this build\n");

  await syncReviewCheckoutFromWorking({
    graphs: [
      { checkout: "working", repository: "firefox", path: workingFirefox },
      { checkout: "working", repository: "comm", path: workingComm },
      { checkout: "review", repository: "firefox", path: reviewFirefox },
      { checkout: "review", repository: "comm", path: reviewComm },
    ],
    confirmation: "SYNC REVIEW",
  });

  for (const [working, review] of [
    [workingFirefox, reviewFirefox],
    [workingComm, reviewComm],
  ]) {
    assert.equal(
      (await git(review, ["rev-parse", "HEAD"])).trim(),
      (await git(working, ["rev-parse", "HEAD"])).trim(),
    );
    assert.equal(
      (await git(review, ["for-each-ref", "--format=%(refname) %(objectname)"])).trim(),
      (await git(working, ["for-each-ref", "--format=%(refname) %(objectname)"])).trim(),
    );
    assert.equal(
      (await git(review, ["branch", "--show-current"])).trim(),
      (await git(working, ["branch", "--show-current"])).trim(),
    );
  }

  assert.equal(
    await (async () => {
      try {
        await git(reviewFirefox, ["show-ref", "--verify", "--quiet", "refs/heads/review-only"]);
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
  await assert.rejects(access(path.join(reviewFirefox, "obj-stale")), /ENOENT/);
  assert.equal(
    await readFile(path.join(reviewFirefox, "obj-test", "artifact.txt"), "utf8"),
    "reuse this build\n",
  );
  assert.equal(
    await readFile(path.join(reviewFirefox, "mozconfig"), "utf8"),
    "ac_add_options --enable-project=comm/mail\n",
  );
});

test("getGraphDirtyCheckouts ignores untracked files", async () => {
  const dirty = await getGraphDirtyCheckouts({
    graphs: [{
      label: "firefox",
      path: "/repo/firefox",
    }],
    runCommand: async () => "?? .tb-review-scratch/\n",
  });

  assert.deepEqual(dirty, []);
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
  assert.match(result.output, /\$ git stash push --include-untracked -m tb-tools graph update: comm/);
  assert.match(result.output, /Saved working directory and index state/);
  assert.match(result.output, /\$ git pull --ff-only origin main/);
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
      ["rev-parse", "--verify", "refs/remotes/origin/main"],
      ["rev-parse", "--verify", "refs/heads/main"],
      ["switch", "main"],
      ["pull", "--ff-only", "origin", "main"],
      ["branch", "--show-current"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("runGraphRepositoryUpdate can discard dirty changes and conflicts before updating", async () => {
  const calls = [];
  const graphs = [{
    label: "comm",
    path: "/repo/comm",
  }];
  const result = await runGraphRepositoryUpdate({
    graphs,
    mode: "update",
    dirtyAction: "discard",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "status") {
        return "UU conflicted-file.txt\n M changed-file.txt\n";
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

  assert.equal(result.dirtyAction, "discard");
  assert.deepEqual(result.dirtyResults, [{
    label: "comm",
    path: "/repo/comm",
    message: "comm discarded uncommitted changes.",
  }]);
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.args),
    [
      ["status", "--porcelain"],
      ["reset", "--hard", "HEAD"],
      ["clean", "-fd"],
    ],
  );
});

test("runGraphRepositoryUpdate can amend dirty changes before rebasing", async () => {
  const calls = [];
  const refs = {
    main: "main-old",
    topic: "child222",
  };
  const rewritten = {
    root111: "root-new",
    child222: "child-new",
  };
  let branch = "topic";
  let head = "child222";
  let pendingCherryPick = "";
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

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return branch ? `${branch}\n` : "";
      }

      if (command.args[0] === "rev-list") {
        return "root111\nchild222\n";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--verify") {
        if (command.args[2] === "refs/remotes/origin/main") {
          return "origin-new\n";
        }

        if (command.args[2] === "refs/heads/main") {
          return `${refs.main}\n`;
        }
      }

      if (command.args[0] === "merge-base") {
        return "";
      }

      if (command.args[0] === "update-ref") {
        refs.main = command.args[2];
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        const pointsAt = command.args[command.args.indexOf("--points-at") + 1];
        const names = Object.entries(refs)
          .filter(([, hash]) => hash === pointsAt)
          .map(([name]) => name)
          .sort();

        return `${names.join("\n")}${names.length ? "\n" : ""}`;
      }

      if (command.args[0] === "switch" && command.args[1] === "--detach") {
        branch = "";
        head = command.args[2];
        return "";
      }

      if (command.args[0] === "cherry-pick") {
        pendingCherryPick = command.args.at(-1);
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "-C") {
        head = rewritten[pendingCherryPick];
        pendingCherryPick = "";
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "-f") {
        refs[command.args[2]] = command.args[3];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1];
        head = refs[branch];
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return `${head}\n`;
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
  assert.match(result.output, /\$ git commit --amend --no-edit/);
  assert.match(result.output, /\$ git switch --detach origin-new/);
  assert.match(result.output, /\$ git cherry-pick --no-commit root111/);
  assert.equal(
    calls.some((call) => call.args[0] === "rebase"),
    false,
  );
  assert.equal(refs.main, "origin-new");
  assert.equal(refs.topic, "child-new");
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

test("getGraphRustUpstreamStatus uses the working clone pair when review clones are present", async () => {
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
      {
        id: "working-comm",
        checkout: "working",
        repository: "comm",
        label: "Working comm",
        path: "/repo/comm",
      },
      {
        id: "working-firefox",
        checkout: "working",
        repository: "firefox",
        label: "Working firefox",
        path: "/repo/firefox",
      },
      {
        id: "review-comm",
        checkout: "review",
        repository: "comm",
        label: "Review comm",
        path: "/repo/review/comm",
      },
      {
        id: "review-firefox",
        checkout: "review",
        repository: "firefox",
        label: "Review firefox",
        path: "/repo/review",
      },
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
  const fallbackFetch = calls.find(
    (call) => call.cwd === tempDir && call.args[0] === "fetch",
  );

  assert.equal(fallbackFetch.timeoutMs, 30_000);
  assert.equal(fallbackFetch.killProcessGroup, true);
});

test("getGraphRustUpstreamStatus reads GitHub raw files instead of shallow-fetching Firefox", async () => {
  const calls = [];
  const fetchedUrls = [];
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
      throw new Error("GitHub raw checks should not create a temp Git repo.");
    },
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      const file = new URL(url).pathname
        .split("/")
        .slice(4)
        .map(decodeURIComponent)
        .join("/");

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => remoteFiles[file],
      };
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
        return "git@github.com:mozilla-firefox/firefox.git\n";
      }

      if (command.cwd === "/repo/firefox" && command.args[0] === "rev-parse") {
        return "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n";
      }

      throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
    },
  });

  assert.equal(result.type, "rust-upstream");
  assert.equal(result.state, "current");
  assert.equal(result.upToDate, true);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(
    fetchedUrls.sort(),
    [
      "https://raw.githubusercontent.com/mozilla-firefox/firefox/ffffffffffffffffffffffffffffffffffffffff/Cargo.lock",
      "https://raw.githubusercontent.com/mozilla-firefox/firefox/ffffffffffffffffffffffffffffffffffffffff/Cargo.toml",
      "https://raw.githubusercontent.com/mozilla-firefox/firefox/ffffffffffffffffffffffffffffffffffffffff/build/workspace-hack/Cargo.toml",
      "https://raw.githubusercontent.com/mozilla-firefox/firefox/ffffffffffffffffffffffffffffffffffffffff/toolkit/library/rust/shared/Cargo.toml",
    ].sort(),
  );
  assert.deepEqual(
    calls.map((call) => [call.cwd, call.args]),
    [
      ["/repo/comm", ["rev-parse", "--verify", "refs/remotes/origin/main"]],
      ["/repo/comm", ["show", "refs/remotes/origin/main:rust/checksums.json"]],
      ["/repo/firefox", ["ls-remote", "--heads", "origin", "main"]],
      ["/repo/firefox", ["rev-parse", "--verify", "refs/remotes/origin/main"]],
      ["/repo/firefox", ["remote", "get-url", "origin"]],
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
  assert.match(result.output, /\$ git stash pop stash@\{0\}/);
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
        return "topic\n";
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

      if (command.args[0] === "rev-list" && command.args.includes("--parents")) {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-list") {
        return command.args.at(-1) === "abc123..topic" ? "child456\n" : "";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "tip789\n"
          : "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from branch topic.");
  assert.deepEqual(result.branches, ["topic"]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.branch, "topic");
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
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "abc123..topic",
      ],
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
        "--points-at",
        "child456",
        "refs/heads",
      ],
      ["switch", "--detach", "parent123"],
      ["cherry-pick", "--no-commit", "child456"],
      ["commit", "-C", "child456"],
      ["rev-parse", "HEAD"],
      ["branch", "-f", "topic", "rebased456"],
      ["switch", "topic"],
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
          : "topic\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        return "topic\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "topic\n";
      }

      if (command.args[0] === "rev-list" && command.args.includes("--parents")) {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-list") {
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return "parent123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from branch topic.");
  assert.deepEqual(result.branches, ["topic"]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "parent123");
  assert.equal(result.branch, "topic");
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
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "abc123..topic",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "abc123",
        "refs/heads",
      ],
      ["switch", "--detach", "parent123"],
      ["branch", "-f", "topic", "parent123"],
      ["switch", "topic"],
      ["rev-parse", "HEAD"],
    ],
  );
});

test("pruneCommitBranches removes a branch-per-commit stack commit in one pass", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["b222"]),
    },
    hash: "b222",
    preferredBranch: "Bug-101",
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
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];

        return {
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

      if (command.args[0] === "rev-list" && command.args.includes("--parents")) {
        return "b222 a111\n";
      }

      if (command.args[0] === "rev-list") {
        return {
          "b222..Bug-101": "",
          "b222..Bug-102": "c333\n",
        }[command.args.at(-1)] || "";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "b222\n"
          : calls.filter((call) => call.args[0] === "rev-parse").length === 2
            ? "new333\n"
            : "a111\n";
      }

      return "";
    },
  });

  assert.equal(
    result.message,
    "comm pruned b222 from branches Bug-101, Bug-102.",
  );
  assert.deepEqual(result.branches, ["Bug-101", "Bug-102"]);
  assert.deepEqual(result.branchUpdates, [
    { branch: "Bug-101", originalHash: "b222", hash: "a111" },
    { branch: "Bug-102", originalHash: "c333", hash: "new333" },
  ]);
  assert.equal(result.parent, "a111");
  assert.equal(result.currentHash, "a111");
  assert.equal(result.branch, "Bug-101");
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
        "b222",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--contains",
        "b222",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--points-at",
        "b222",
        "refs/tb-tools",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)",
        "--contains",
        "b222",
        "refs/tb-tools",
      ],
      ["rev-list", "--parents", "-n", "1", "b222"],
      ["rev-parse", "HEAD"],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "b222..Bug-101",
      ],
      [
        "rev-list",
        "--reverse",
        "--topo-order",
        "--ancestry-path",
        "b222..Bug-102",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "b222",
        "refs/heads",
      ],
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "--points-at",
        "c333",
        "refs/heads",
      ],
      ["switch", "--detach", "a111"],
      ["cherry-pick", "--no-commit", "c333"],
      ["commit", "-C", "c333"],
      ["rev-parse", "HEAD"],
      ["branch", "-f", "Bug-101", "a111"],
      ["branch", "-f", "Bug-102", "new333"],
      ["switch", "Bug-101"],
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
  assert.match(html, /class="toolbar-row graph-toolbar"/);
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
  assert.match(html, /data-action="interactive-rebase"/);
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
  assert.doesNotMatch(html, /commit-reviewer-list/);
  assert.match(html, /id="phab-auth-dialog"/);
  assert.match(html, /class="phab-auth-start" type="button">Authenticate<\/button>/);
  assert.match(html, /id="submit-dialog"/);
  assert.match(html, /<dialog class="system-dialog" id="system-dialog"/);
  assert.match(html, /class="system-dialog-choices"/);
  assert.match(html, /class="submit-prompt"/);
  assert.match(html, /class="submit-links" hidden/);
  assert.match(html, /class="submit-output"/);
  assert.match(html, /id="interactive-rebase-dialog"/);
  assert.match(html, /class="interactive-rebase-todo"/);
  assert.match(html, /id="try-dialog"/);
  assert.match(html, /class="try-selector"/);
  assert.match(html, /class="try-tasks-regex"/);
  assert.doesNotMatch(html, /class="console-view-tab test-output-tab"/);
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
  assert.match(style, /\.repository-navigation \{/);
  assert.match(style, /\.repository-navigation \{[^}]*transform: translateY\(-5px\)/);
  assert.match(style, /\.repository-switch \{/);
  assert.match(style, /\.checkout-mode-button, \.repository-button \{[^}]*padding: 2px 9px/);
  assert.match(style, /\.system-dialog \{/);
  assert.match(style, /\.system-dialog\.danger \.system-dialog-confirm \{/);
  assert.match(style, /\.console-navigation \{/);
  assert.match(style, /\.console-navigation \{[^}]*align-self: stretch;/);
  assert.match(style, /\.console-view-tab\.active \{/);
  assert.match(style, /\.console-view-tab\.active \{\s*background: #1f5f9f;/);
  assert.match(style, /\.dashboard-panel\[hidden\] \{\s*display: none;/);
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
    /\.checkout-commit, \.amend-commit, \.submit-commit, \.patch-update-commit, \.patch-verify-commit, \.patch-freeform-commit, \.load-more/,
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
  assert.match(style, /\.phab-auth-dialog \{/);
  assert.match(style, /\.phab-auth-actions \{/);
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
  assert.match(style, /\.review-discussion \{/);
  assert.match(style, /\.review-inline-thread td \{/);
  assert.match(style, /\.review-inline-code \{/);
  assert.match(
    style,
    /\.review-comment-text \{[^}]*overflow-wrap: anywhere;/,
  );
  assert.match(
    style,
    /\.review-code-block,[^}]*max-width: calc\(100% - 20px\);/,
  );
  assert.match(
    style,
    /\.diff-table\.has-review-comments \{[^}]*table-layout: fixed;/,
  );
  assert.match(style, /\.diff-gutter-column \{[^}]*width: 44px;/);
  assert.match(
    style,
    /\.diff-table\.has-review-comments \.line-content \{[^}]*min-width: max-content;/,
  );
  assert.match(style, /\.review-comment header \{[^]*justify-content: flex-start/);
  assert.match(style, /\.review-suggestion \{/);
  assert.match(style, /\.review-code-suggestion \{/);
  assert.match(client, /function appendReviewCodeSuggestion/);
  assert.match(style, /\.integration-status \{/);
  assert.match(style, /\.status-badge \{/);
  assert.match(style, /\.status-badge\.try/);
  assert.match(style, /\.status-badge\.notion/);
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
  assert.match(client, /function renderSelectedCommitReview/);
  assert.match(client, /function fetchSelectedCommitReview/);
  assert.match(client, /const INLINE_CODE_PATTERN/);
  assert.doesNotMatch(client, /discussion\.open = true/);
  assert.match(client, /function reviewPathsMatch/);
  assert.match(client, /variants\.add\(`comm\/\$\{path\}`\)/);
  assert.match(client, /function openAmendDialog/);
  assert.match(client, /function submitAmendDialog/);
  assert.match(client, /function openCommitDialog/);
  assert.match(client, /function handleCommitReviewerInputKeydown/);
  assert.doesNotMatch(client, /function searchCommitReviewers/);
  assert.match(client, /function submitCommitDialog/);
  assert.match(client, /function openPhabricatorAuthDialog/);
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
  assert.match(client, /setLiveText\(submitOutput, session\.output \|\| ""\)/);
  assert.match(client, /function isWorkingTreeCommit/);
  assert.match(client, /function getSnapshotFingerprint/);
  assert.match(client, /function refreshGraphFromServer/);
  assert.match(client, /function pollGraphUpdates/);
  assert.match(client, /function runGraphUpdate/);
  assert.match(client, /function createRelationOpenButton/);
  assert.match(client, /function createRelationRemoveButton/);
  assert.match(client, /function openRelationAddDialog/);
  assert.match(client, /function addRelation/);
  assert.match(
    client,
    /createRelationRemoveButton\(bug, relationType\),[\s\S]*?createBugzillaIconLink\(bug\)/,
  );
  assert.match(client, /function openInteractiveRebaseDialog/);
  assert.match(client, /function submitInteractiveRebaseDialog/);
  assert.match(client, /function handleInteractiveRebaseDialogClick/);
  assert.match(client, /\/api\/interactive-rebase\/plan/);
  assert.match(client, /\/api\/interactive-rebase/);
  assert.match(client, /function promptForDirtyUpdateAction/);
  assert.match(client, /function showSystemChoice/);
  assert.match(client, /function showSystemConfirmation/);
  assert.doesNotMatch(client, /\balert\s*\(/);
  assert.doesNotMatch(client, /\bconfirm\s*\(/);
  assert.doesNotMatch(client, /\bprompt\s*\(/);
  assert.match(client, /function unshelfGraphUpdateChanges/);
  assert.match(client, /function listenForServerShutdown/);
  assert.match(client, /\/api\/shutdown-events/);
  assert.match(client, /INTERACTIVE\.closeTabsOnShutdown !== false/);
  assert.match(client, /window\.close\(\)/);
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
  assert.match(client, /function createNotionStoryStatus/);
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
  assert.match(client, /function openLinkInNewTab\(link\)/);
  assert.match(client, /link\.target = "_blank"/);
  assert.match(client, /link\.relList\.add\("noopener", "noreferrer"\)/);
  assert.match(client, /const linkTargetObserver = new MutationObserver/);
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
    /const result = \{ tryRuns: commit\.tryRuns \|\| \[\] \};/,
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
    /export async function showDiff\(\s*graph,\s*index,\s*commit,\s*\{ loadCurrentIntegration = false, loadIntegration = false \} = \{\},\s*\)/,
  );
  assert.match(client, /if \(loadIntegration && !isWorkingTreeCommit\(commit\)\)/);
  assert.doesNotMatch(
    client,
    /loadSelectedCommitIntegrationStatus\(index, commit, integrationStatus, \{\s*onLoaded:/,
  );
  assert.match(client, /function configurePatchUpdateButton/);
  assert.match(client, /event\.target\.closest\("\.patch-update-commit, \.patch-verify-commit, \.patch-freeform-commit"\)/);
  assert.match(
    client,
    /!result\.bug\.error && isAcceptedPhabricatorStatus\(result\.phabricator\)/,
  );
  assert.match(client, /\/api\/bugzilla\/checkin/);
  assert.match(client, /event\.target\.closest\("\.checkin-needed-button"\)/);
  assert.match(client, /\/api\/amend-message/);
  assert.match(client, /\/api\/commit\/metadata/);
  assert.doesNotMatch(client, /\/api\/commit\/reviewers/);
  assert.match(client, /\/api\/commit/);
  assert.match(
    client,
    /amendButton\.textContent = isWorkingTreeCommit\(commit\)[^]*\? "Amend"[^]*: "Amend Message"/,
  );
  assert.match(
    client,
    /function isCommitReachableFromLoadedOriginMain/,
  );
  assert.match(
    client,
    /submitButton\.hidden =[^]*!INTERACTIVE\.enabled[^]*\|\|[^]*isWorkingTreeCommit\(commit\)[^]*\|\|[^]*isCommitReachableFromLoadedOriginMain\(index, commit\)/,
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
  assert.match(client, /button\.dataset\.action === "interactive-rebase"/);
  assert.match(client, /openInteractiveRebaseDialog\(actionState\)/);
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

test("interactive graph launcher opens a script-owned console tab", () => {
  const html = buildInteractiveGraphLauncherHtml({
    consolePath: "/",
    tabName: "tb-tools-console-secret",
  });

  assert.match(html, /const consolePath = "\/";/);
  assert.match(html, /const tabName = "tb-tools-console-secret";/);
  assert.match(html, /window\.open\(consolePath, tabName\)/);
  assert.match(html, /consoleTab\.focus\(\)/);
  assert.match(html, /window\.setTimeout\(\(\) => window\.close\(\), 100\)/);
  assert.match(html, /window\.location\.replace\(consolePath\)/);
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
  assert.match(client, /originMainStatusRefreshQueued/);
  assert.match(client, /const checkout = uiState\.checkoutMode/);
  assert.match(html, /<title>Thunderbird Desktop Console<\/title>/);
  assert.match(html, /<h1[^>]*><picture>.*alt="Thunderbird Development Dashboard".*<\/picture><\/h1>/);
  assert.match(
    html,
    /<\/picture><\/h1>\s*<div class="origin-main-status"/,
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
      html.indexOf('<div class="toolbar-row graph-toolbar">'),
  );
  assert.match(
    html,
    /<div class="toolbar-row graph-toolbar">\s*<nav class="repository-navigation" aria-label="Checkout and repository">/,
  );
  assert.match(
    html,
    /<div class="console-footer">\s*<nav class="console-navigation" aria-label="Console views">\s*<button class="tab console-view-tab graph-view-tab active" type="button">Tree<\/button>/,
  );
  assert.match(html, /class="update-actions"/);
  assert.match(html, /class="tab console-view-tab dashboard-tab"/);
  assert.match(html, /class="dashboard-panel"/);
  assert.match(html, /class="dashboard-section dashboard-direct-review" data-dashboard-section="direct-review"/);
  assert.match(html, /class="dashboard-workspace"/);
  assert.match(html, /class="dashboard-column-heading">Your Patches<\/h3>/);
  assert.match(html, /class="dashboard-column-heading">Needs Review<\/h3>/);
  assert.match(html, /class="dashboard-column-heading">Bugzilla<\/h3>/);
  assert.match(html, /class="dashboard-bug-sidebar" aria-label="Assigned bug queues"/);
  assert.match(html, /class="dashboard-section dashboard-needinfo" data-dashboard-section="needinfo-bugs"/);
  assert.match(html, /class="dashboard-section dashboard-in-progress" data-dashboard-section="in-progress-bugs"/);
  assert.match(html, /class="dashboard-section dashboard-bugs" data-dashboard-section="assigned-bugs"/);
  assert.doesNotMatch(html, /dashboard-needinfo-tray/);
  assert.doesNotMatch(html, /dashboard-bug-inbox/);
  assert.match(html, /<dialog class="patch-update-dialog" id="patch-update-dialog">/);
  assert.doesNotMatch(html, /Codex analysis/);
  assert.doesNotMatch(html, /Suggested reply/);
  assert.doesNotMatch(html, /Comment Posted/);
  assert.doesNotMatch(html, /Submit Patch/);
  assert.doesNotMatch(html, /data-dashboard-section="approved-not-marked"/);
  assert.doesNotMatch(html, /data-dashboard-section="reviewed-awaiting-review"/);
  assert.match(html, /class="tab console-view-tab meta-boards-tab"/);
  assert.match(html, /class="meta-boards-panel"/);
  assert.match(html, /class="meta-board-root-links"/);
  assert.match(html, /<h3>Blocked By<\/h3>/);
  assert.match(html, /<h3>Blocks<\/h3>/);
  assert.doesNotMatch(html, /<h3>Dependents<\/h3>/);
  assert.doesNotMatch(html, /meta-board-detail-depends"/);
  assert.doesNotMatch(html, /meta-board-detail-blocks"/);
  assert.match(html, /class="meta-board-relation-add" type="button" data-relation="dependsOn">Add<\/button>/);
  assert.match(html, /class="meta-board-relation-add" type="button" data-relation="blocks">Add<\/button>/);
  assert.match(html, /id="meta-board-relation-dialog"/);
  assert.match(html, /data-menu-action="meta-boards-add"/);
  assert.match(html, /data-menu-action="meta-boards-manage"/);
  assert.match(html, /id="meta-board-manager-dialog"/);
  assert.match(client, /meta-board-review-group/);
  assert.match(client, /saveBoardReviewGroup/);
  assert.match(html, /id="meta-board-dialog"/);
  assert.match(
    html,
    /class="meta-board-detail-assignee" type="email" list="meta-board-assignees"/,
  );
  assert.match(html, /class="meta-board-detail-header-actions"/);
  assert.match(html, /class="meta-board-detail-bugzilla"/);
  assert.match(html, /class="meta-board-description-edit"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /data-mode="render" aria-hidden="true" hidden/);
  assert.match(html, /class="meta-board-detail-description-rendered"/);
  assert.match(html, /class="meta-board-detail-description" rows="12" hidden/);
  assert.match(html, /<details class="meta-board-detail-comments">/);
  assert.match(html, /class="meta-board-detail-comments-count"/);
  assert.ok(
    html.indexOf('<div class="update-actions"') <
      html.indexOf('<div class="graph-options">'),
  );
  assert.ok(
    html.indexOf('<div class="update-actions"') <
    html.indexOf('<div class="toolbar-row graph-toolbar">'),
  );
  assert.match(html, /data-mode="update">Pull<\/button>/);
  assert.match(html, /data-mode="rebase">Rebase<\/button>/);
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
    /class="graph-menu-command" type="button" role="menuitem" data-menu-action="phabricator-auth">Authenticate Phabricator\.\.\.<\/button>/,
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
    /class="tab console-view-tab test-output-tab" type="button" hidden>Test Output<\/button>/,
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
  assert.match(style, /\.meta-board-detail-depends-links,[\s\S]*?height: 180px;/);
  assert.match(style, /\.meta-board-relation-link \+ \.meta-board-relation-link/);
  assert.match(style, /\.meta-board-detail-description-rendered \{/);
  assert.match(style, /\.markdown-code-block \{/);
  assert.match(
    html,
    /class="origin-main-status" role="status" aria-label="origin\/main freshness"/,
  );
  assert.match(html, /"closeTabsOnShutdown":true/);
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
  assert.match(html, /class="commit-reviewer-input"[\s\S]+press Enter/);
  assert.doesNotMatch(html, /aria-controls="commit-reviewer-list"/);
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
  assert.match(client, /openPhabricatorAuthDialog\(\)/);
  assert.match(client, /let latestAuthenticationRequest = 0;/);
  assert.match(client, /tb-phab-authenticated/);
  assert.match(client, /renderMarkdown\(detailDescriptionRendered, description\)/);
  assert.match(client, /renderEditedDetailDescription\(\)/);
  assert.match(client, /toggleDetailDescription/);
  assert.match(client, /detailDescription\.hidden = false;/);
  assert.match(client, /submitCommitDialog/);
  assert.match(client, /handleCommitReviewerInputKeydown/);
  assert.match(client, /handleCommitReviewerPillEvent/);
  assert.match(client, /normalizeReviewerInputValue/);
  assert.doesNotMatch(client, /scheduleCommitReviewerSearch/);
  assert.doesNotMatch(client, /addCommitReviewerFromEvent/);
  assert.doesNotMatch(client, /MIN_REVIEWER_QUERY_LENGTH/);
  assert.doesNotMatch(client, /REVIEWER_SEARCH_DEBOUNCE_MS/);
  assert.doesNotMatch(client, /\/api\/commit\/reviewers/);
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
  assert.match(client, /clientId/);
  assert.doesNotMatch(client, /\/api\/ping/);
  assert.doesNotMatch(client, /function sendHeartbeat/);
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

test("buildGraphHtml only renders Codex patch review controls when enabled", () => {
  const graphs = [{
    label: "comm",
    path: "/repo/comm",
    branch: "main",
    commitCount: 0,
    commits: [],
    diffs: {},
  }];
  const disabledHtml = buildGraphHtml({
    graphs,
    interactive: { enabled: true, token: "secret" },
  });
  const enabledHtml = buildGraphHtml({
    graphs,
    interactive: { enabled: true, aiEnabled: true, token: "secret" },
  });

  assert.match(disabledHtml, /class="patch-update-title">Review Update<\/h2>/);
  assert.match(disabledHtml, /class="patch-update-output-toggle"/);
  assert.doesNotMatch(disabledHtml, /Codex analysis/);
  assert.doesNotMatch(disabledHtml, /Suggested reply/);
  assert.doesNotMatch(disabledHtml, /Review comment/);
  assert.doesNotMatch(disabledHtml, /Comment Posted/);
  assert.doesNotMatch(disabledHtml, /Guide Codex/);
  assert.doesNotMatch(disabledHtml, /Submit Patch/);
  assert.doesNotMatch(disabledHtml, /class="patch-update-commit"/);
  assert.doesNotMatch(disabledHtml, /class="patch-verify-commit"/);
  assert.match(enabledHtml, /class="patch-verify-commit" type="button" hidden>Verify<\/button>/);
  assert.match(enabledHtml, /class="patch-update-sidebar" aria-label="Patch update context"/);
  assert.match(enabledHtml, /class="patch-update-context-diff-content"/);
  assert.match(enabledHtml, /Codex activity/);
  assert.match(enabledHtml, /class="patch-update-steer-label"[^>]*>Guide Codex<\/label>/);
  assert.doesNotMatch(enabledHtml, /Prepare Change/);
  assert.match(enabledHtml, /Amend Patch/);
  assert.match(enabledHtml, /Submit Patch/);
  assert.match(
    enabledHtml,
    /class="patch-update-commit" type="button" hidden>Review Update<\/button>/,
  );
  assert.match(enabledHtml, /<dialog class="patch-review-dialog" id="patch-review-dialog">/);
  assert.match(enabledHtml, /class="patch-review-sidebar"/);
  assert.match(enabledHtml, /class="patch-review-diff-column" aria-label="Patch diff"/);
  assert.doesNotMatch(enabledHtml, /class="patch-review-issue"/);
  assert.doesNotMatch(enabledHtml, /class="patch-review-issue-actions"/);
  assert.match(enabledHtml, /Request Changes/);
});

test("patch review keeps a prose inline draft action available with a ready finding", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-review-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /function appendInlineFinding\(row, issue\)/);
  assert.match(source, /data-review-inline-action/);
  assert.match(source, /"inline-comment"/);
  assert.match(source, /"inline-suggestion"/);
  assert.match(source, /"Save Inline Comment Draft"/);
  assert.match(source, /void runAction\("inline", \{\n {8}itemId: issue\.id,\n {8}kind: "comment",/);
  assert.match(source, /function renderSuggestedSourceDiff/);
});

test("patch update dialog clears the prior session before starting another update", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /function resetPatchUpdateDialog\(patch\)/);
  assert.match(source, /session = undefined;/);
  assert.match(source, /output\.textContent = "";/);
  assert.match(source, /patchDiffContent\?\.replaceChildren\(\);/);
  assert.match(source, /resetPatchUpdateDialog\(patch\);\n {2}const generation = viewGeneration;\n {2}setPageScrollLocked\(true\);\n {2}dialog\.showModal\(\);/);
});

test("patch update locks background page scrolling while its dialog is open", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );
  const style = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );

  assert.match(source, /function setPageScrollLocked\(isLocked\)/);
  assert.match(source, /setPageScrollLocked\(true\);\n {2}dialog\.showModal\(\);/);
  assert.match(source, /dialog\.addEventListener\("close", \(\) => \{\n {4}if \(!dialog\.open\) setPageScrollLocked\(false\);/);
  assert.match(style, /html\.patch-update-open,\nbody\.patch-update-open \{\n {2}overflow: hidden;/);
});

test("patch update actions display immediate pending feedback", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /let pendingAction = "";/);
  assert.match(source, /pendingAction = action;\n {2}renderSession\(session\);/);
  assert.match(source, /pendingAction === "comment"\n {6}\? "Posting\.\.\."/);
  assert.match(source, /item\.state === "applying"/);
  assert.match(source, /isCommentFeedback && item\.changeApplied && !item\.changesAmended\s+\? "revise"/);
  assert.match(source, /pendingAction === "steer" \|\| pendingAction === "feedback" \|\| pendingAction === "revise"/);
});

test("patch update puts context and activity beside the source patch diff", () => {
  const html = buildGraphHtml({
    graphs: [],
    interactive: { aiEnabled: true, enabled: true, token: "secret" },
  });
  const style = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );

  assert.match(html, /class="patch-update-workspace">\s*<aside class="patch-update-sidebar"/);
  assert.ok(
    html.indexOf('class="patch-update-context"') <
      html.indexOf('class="patch-update-progress"'),
  );
  assert.match(html, /class="patch-update-context-toggle" type="button" aria-controls="patch-update-context-details" aria-expanded="false"/);
  assert.match(html, /class="patch-update-context-details" id="patch-update-context-details" hidden/);
  assert.match(html, /class="patch-update-diff-column" aria-label="Patch diff"/);
  assert.match(html, /class="patch-update-context-diff-content"/);
  assert.doesNotMatch(html, /class="patch-update-review-column"/);
  assert.doesNotMatch(html, /class="patch-update-comment-context"/);
  assert.match(style, /\.patch-update-workspace \{\n {2}gap: 14px;\n {2}grid-template-columns: minmax\(320px, 0\.8fr\) minmax\(0, 1\.8fr\);/);
  assert.match(style, /\.patch-update-sidebar \{/);
  assert.match(style, /\.patch-update-context-diff \{/);
  assert.match(style, /\.patch-update-inline-finding,/);
  assert.match(style, /\.patch-update-working-diff \{/);
  assert.match(style, /\.patch-update-context-toggle\[aria-expanded="true"\]::after/);
  assert.match(style, /\.patch-update-context-details\[hidden\] \{\s*display: none;/);
});

test("patch update labels suggested replies by their Phabricator target", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /item\.type === "inline"/);
  assert.match(source, /"Suggested inline reply"/);
  assert.match(source, /"Suggested overall reply"/);
  assert.match(source, /`Reason: \$\{item\.rationale\}`/);
  assert.match(source, /`Checks: \$\{item\.validation\}`/);
});

test("Patch Update automatically prepares and shows the actual working-tree diff", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );
  const patchUpdate = readFileSync(
    new URL("../commands/graph/patch-update.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /function getWorkingTreeDiffState\(item\) \{/);
  assert.match(source, /function loadWorkingTreeDiff\(item\) \{/);
  assert.match(source, /function loadPatchDiff\(\) \{/);
  assert.match(source, /function appendWorkingTreeDiff\(item\) \{/);
  assert.match(source, /function setPatchDiff\(item\) \{/);
  assert.match(source, /\/diff\/uncommitted-changes\?token=/);
  assert.match(source, /const hasWorkingDiff = Boolean\(workingDiff \|\| workingDiffHtml\);/);
  assert.match(source, /const \{ currentDiff, hasWorkingDiff, shouldLoadWorkingTreeDiff \} = getWorkingTreeDiffState\(item\);/);
  assert.match(source, /rawDiff\.textContent = currentDiff\.text;/);
  assert.match(source, /patchDiffContent\.innerHTML = currentDiff\.html;/);
  assert.match(source, /appendWorkingTreeDiff\(item\);/);
  assert.match(source, /renderedPatchDiffKey = "";/);
  assert.match(source, /session\.workingTreeDiffVersion/);
  assert.doesNotMatch(source, /Prepare Change/);
  assert.match(source, /data-update-inline-action/);
  assert.match(source, /createInlineAction\("apply", "Make Change"/);
  assert.match(source, /createInlineAction\("keep", "Amend Change"/);
  assert.match(source, /createInlineAction\("revert", "Revert Change"/);
  assert.match(patchUpdate, /function hasGraphPatchUpdateChangeRecommendation\(item\)/);
  assert.match(patchUpdate, /export async function reviseGraphPatchUpdateChange/);
  assert.match(
    patchUpdate,
    /Codex did not provide a complete source-change recommendation\./,
  );
});

test("patch update keeps the purpose collapsed until the user expands it", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /let patchContextExpanded = false;/);
  assert.match(source, /function setPatchContextExpanded\(expanded\)/);
  assert.match(source, /patchContext\?\.classList\.toggle\("is-expanded", patchContextExpanded\);/);
  assert.match(source, /patchContextDetails\.hidden = !patchContextExpanded;/);
  assert.match(source, /patchContextToggle\?\.addEventListener\("click"/);
  assert.match(source, /patchContextExpanded = false;\n {2}patchContextKey = "";/);
});

test("patch update keeps Codex activity visible with Notes and All filters", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );
  const controls = readFileSync(
    new URL("../commands/graph/client/ai-dialog-controls.js", import.meta.url),
    "utf8",
  );
  const html = buildGraphHtml({
    interactive: { enabled: true, token: "secret", aiEnabled: true },
    graphs: [],
  });
  const style = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );

  assert.match(html, /<details class="patch-update-progress" open>/);
  assert.match(html, /class="patch-update-progress-summary"/);
  assert.match(html, /class="patch-update-progress-toggle" aria-hidden="true"/);
  assert.match(html, /class="patch-update-progress-label">Codex activity<\/span>/);
  assert.ok(
    html.indexOf('class="patch-update-progress-label"') <
      html.indexOf('class="patch-update-progress-toggle"'),
  );
  assert.ok(
    html.indexOf('class="patch-update-progress-toggle"') <
      html.indexOf('class="patch-update-status"'),
  );
  assert.match(html, /class="patch-update-activity" aria-label="Codex activity"/);
  assert.match(html, /class="patch-update-activity-status"/);
  assert.match(html, /class="patch-update-activity-latest" role="status">Waiting for Codex activity\.\.\.<\/span>/);
  assert.match(html, /data-activity-filter="notes" aria-pressed="true">Notes<\/button>/);
  assert.match(html, /data-activity-filter="all" aria-pressed="false">All<\/button>/);
  assert.match(html, /class="patch-update-activity-list"><\/ol>/);
  assert.match(source, /let activityFilter = "notes";/);
  assert.match(source, /function setActivityFilter\(filter\)/);
  assert.match(source, /activityFilter = filter === "all" \? "all" : "notes";/);
  assert.match(source, /function isCodexNoteActivity\(entry\)/);
  assert.match(source, /items\.filter\(isCodexNoteActivity\)/);
  assert.doesNotMatch(source, /items\.filter\(\(entry\) => !isCommandActivity\(entry\)\)/);
  assert.match(source, /items\[items\.length - 1\]/);
  assert.match(source, /No Codex notes yet\. Select All to include other activity\./);
  assert.match(source, /createSharedActivityEntry\(entry, expandedActivityCommandIds\)/);
  assert.match(controls, /function createCommandActivityDisclosure\(entry, expandedActivityCommandIds\)/);
  assert.match(controls, /details\.open = expandedActivityCommandIds\.has\(entry\.id\);/);
  assert.match(source, /function getActivityCommandPreview\(detail\)/);
  assert.match(controls, /patch-update-activity-command-row/);
  assert.match(source, /const activityProgress = dialog\?\.querySelector\("\.patch-update-progress"\);/);
  assert.match(source, /activityProgress\.open = true;/);
  assert.match(style, /\.patch-update-progress-summary \{/);
  assert.match(style, /\.patch-update-progress-toggle::before \{/);
  assert.match(style, /\.patch-update-progress\[open\] \.patch-update-progress-toggle \{/);
  assert.match(style, /\.patch-update-activity-status \{/);
  assert.match(style, /\.patch-update-activity-filter button\[aria-pressed="true"\] \{/);
  assert.match(style, /height: clamp\(140px, 20dvh, 260px\);/);
  assert.match(style, /\.patch-update-activity-command-summary \{/);
  assert.match(style, /\.patch-update-activity-command-disclosure > code \{/);
});

test("patch update reuses graph inline review threads in the contextual diff", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );
  const reviewViewer = readFileSync(
    new URL("../commands/graph/client/review-viewer.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /import \{ appendInlineReviewComment, findReviewLine \} from "\.\/review-viewer\.js";/);
  assert.match(source, /appendInlineReviewComment\(row, \{/);
  assert.match(source, /findReviewLine\(patchDiffContent, item\)/);
  assert.match(reviewViewer, /export function appendInlineReviewComment\(row, comment\)/);
});

test("patch update anchors review feedback in the complete local patch diff", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /function setPatchDiff\(item\)/);
  assert.match(source, /patchDiffContent\.innerHTML = currentDiff\.html;/);
  assert.match(source, /const anchor = \["inline", "finding"\]\.includes\(item\.type\) \? findReviewLine\(patchDiffContent, item\) : null;/);
  assert.match(source, /anchor\.classList\.add\("patch-update-context-line"\)/);
  assert.match(source, /appendUpdateFinding\(anchor, item\);/);
});

test("dashboard and meta boards show an accessible loading indicator", () => {
  const html = buildGraphHtml({
    graphs: [],
    interactive: { enabled: true, token: "secret" },
  });
  const dashboardSource = readFileSync(
    new URL("../commands/graph/client/dashboard.js", import.meta.url),
    "utf8",
  );
  const metaBoardsSource = readFileSync(
    new URL("../commands/graph/client/meta-boards.js", import.meta.url),
    "utf8",
  );
  const style = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );

  assert.match(html, /class="loading-indicator dashboard-loading" role="status" hidden/);
  assert.match(html, /class="loading-indicator meta-boards-loading" role="status" hidden/);
  assert.match(dashboardSource, /dashboardPanel\?\.setAttribute\("aria-busy", String\(isLoading\)\);/);
  assert.match(dashboardSource, /dashboardLoading\.hidden = !isLoading;/);
  assert.match(metaBoardsSource, /panel\?\.setAttribute\("aria-busy", String\(isLoading\)\);/);
  assert.match(metaBoardsSource, /setLoading\(true, "Loading available meta bug boards\.\.\."\);/);
  assert.match(style, /\.loading-spinner \{/);
  assert.match(style, /@keyframes console-loading-spinner/);
});

test("meta board columns show filtered point totals except backlog", () => {
  const html = buildGraphHtml({
    graphs: [],
    interactive: { enabled: true, token: "secret" },
  });
  const source = readFileSync(
    new URL("../commands/graph/client/meta-boards.js", import.meta.url),
    "utf8",
  );
  const style = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );

  assert.match(
    html,
    /data-meta-board-column="backlog"[\s\S]*?meta-board-column-points" hidden/,
  );
  assert.match(
    html,
    /data-meta-board-column="ready"[\s\S]*?meta-board-column-points"><\/span>/,
  );
  assert.match(source, /function getPointTotal\(cards\)/);
  assert.match(source, /const cards = getFilteredCards\(column\.dataset\.metaBoardColumn\);/);
  assert.match(source, /points\.hidden = column\.dataset\.metaBoardColumn === "backlog";/);
  assert.match(source, /formatPointTotal\(getPointTotal\(cards\)\)/);
  assert.match(style, /\.meta-board-column header \.meta-board-column-points \{/);
});

test("patch update reads the active inline reply after advancing to a comment", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /setPatchDiff\(freeform && !item\?\.changeApplied \? null : item\);/);
  assert.match(source, /function updateInlineFindingActions\(item\) \{[\s\S]*?const replyValue = replyInput\?\.value \|\| "";/);
});

test("patch update output remains hidden until the user expands it", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /let outputVisible = false;/);
  assert.doesNotMatch(source, /outputAutoShown/);
  assert.match(source, /output\.hidden = !outputVisible \|\| !hasOutput;/);
  assert.match(source, /function getPatchUpdateOutput/);
  assert.match(source, /output-expanded/);
  assert.match(source, /const workingDiffHtml = currentDiff\?\.html \|\| "";/);
});

test("patch update activity follows new entries until the user scrolls away", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-update-dialog.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /let activityFollowsLatest = true;/);
  assert.match(source, /function updateActivityFollowState\(\)/);
  assert.match(source, /activityList\?\.addEventListener\("scroll", updateActivityFollowState/);
  assert.match(source, /if \(!hasSelectedText\(activityList\)\) activityList\.scrollTop = activityList\.scrollHeight;/);
  assert.match(source, /activityFollowsLatest = true;\n {2}renderActivityFilter\(\);/);
});

test("getGraphOutputPath defaults to a temp HTML file", () => {
  assert.match(getGraphOutputPath(), /tb-tools-branch-graph\.html$/);
  assert.equal(getGraphOutputPath("/tmp/custom.html"), "/tmp/custom.html");
});

test("review checkout config requires both independent clone paths", () => {
  assert.equal(getReviewCheckoutConfig({}), null);
  assert.equal(getReviewCheckoutConfig({
    reviewCheckout: { firefoxPath: "/repo/firefox-review" },
  }), null);
  assert.deepEqual(getReviewCheckoutConfig({
    reviewCheckout: {
      firefoxPath: "/repo/firefox-review",
      commPath: "/repo/firefox-review/comm",
    },
  }), {
    firefoxPath: "/repo/firefox-review",
    commPath: "/repo/firefox-review/comm",
  });
});

test("interactive console includes the configured independent review clone pair", () => {
  const checkouts = resolveGraphCheckouts({
    cwd: "/repo/working/comm",
    config: {
      reviewCheckout: {
        firefoxPath: "/repo/review",
        commPath: "/repo/review/comm",
      },
    },
    includeReview: true,
  });

  assert.deepEqual(checkouts, [
    {
      id: "working-comm",
      checkout: "working",
      repository: "comm",
      label: "Working comm",
      cwd: "/repo/working/comm",
    },
    {
      id: "working-firefox",
      checkout: "working",
      repository: "firefox",
      label: "Working firefox",
      cwd: "/repo/working",
    },
    {
      id: "review-comm",
      checkout: "review",
      repository: "comm",
      label: "Review comm",
      cwd: "/repo/review/comm",
    },
    {
      id: "review-firefox",
      checkout: "review",
      repository: "firefox",
      label: "Review firefox",
      cwd: "/repo/review",
    },
  ]);
});

test("interactive console uses a checkout switch with one comm and Firefox tab", () => {
  const html = buildGraphHtml({
    interactive: { enabled: true, token: "secret" },
    graphs: [
      {
        id: "working-comm",
        checkout: "working",
        repository: "comm",
        label: "Working comm",
        path: "/repo/working/comm",
        commits: [],
        diffs: {},
      },
      {
        id: "working-firefox",
        checkout: "working",
        repository: "firefox",
        label: "Working firefox",
        path: "/repo/working",
        commits: [],
        diffs: {},
      },
      {
        id: "review-comm",
        checkout: "review",
        repository: "comm",
        label: "Review comm",
        path: "/repo/review/comm",
        commits: [],
        diffs: {},
      },
      {
        id: "review-firefox",
        checkout: "review",
        repository: "firefox",
        label: "Review firefox",
        path: "/repo/review",
        commits: [],
        diffs: {},
      },
    ],
  });
  const client = readGraphClientScripts();

  assert.match(html, /class="checkout-mode-switch" role="group" aria-label="Checkout mode"/);
  assert.match(html, /<nav class="repository-navigation" aria-label="Checkout and repository">/);
  assert.match(html, /<nav class="console-navigation" aria-label="Console views">/);
  assert.match(html, /class="checkout-mode-button active"[^>]+data-checkout="working"[^>]*>Working<\/button>/);
  assert.match(html, /class="checkout-mode-button"[^>]+data-checkout="review"[^>]*>Review<\/button>/);
  assert.equal((html.match(/class="tab[^"\n]*"[^>]+data-repository=/g) || []).length, 2);
  assert.equal((html.match(/class="origin-main-badge checking"/g) || []).length, 3);
  assert.match(html, /data-repository="comm"[^>]*>comm<\/button>/);
  assert.match(html, /data-repository="firefox"[^>]*>firefox<\/button>/);
  assert.doesNotMatch(html, /data-index="0">Working comm<\/button>/);
  assert.doesNotMatch(html, /data-index="2">Review comm<\/button>/);
  assert.match(client, /function switchCheckoutMode\(checkout\)/);
  assert.match(client, /document\.querySelectorAll\("\.checkout-mode-button"\)/);
});

test("interactive console exposes Review sync only for a complete checkout pair", () => {
  const completeHtml = buildGraphHtml({
    interactive: { enabled: true, token: "secret" },
    graphs: [
      { checkout: "working", repository: "comm", label: "Working comm", path: "/working/comm", commits: [], diffs: {} },
      { checkout: "working", repository: "firefox", label: "Working firefox", path: "/working", commits: [], diffs: {} },
      { checkout: "review", repository: "comm", label: "Review comm", path: "/review/comm", commits: [], diffs: {} },
      { checkout: "review", repository: "firefox", label: "Review firefox", path: "/review", commits: [], diffs: {} },
    ],
  });
  const incompleteHtml = buildGraphHtml({
    interactive: { enabled: true, token: "secret" },
    graphs: [
      { checkout: "working", repository: "comm", label: "Working comm", path: "/working/comm", commits: [], diffs: {} },
      { checkout: "review", repository: "comm", label: "Review comm", path: "/review/comm", commits: [], diffs: {} },
    ],
  });
  const client = readGraphClientScripts();

  assert.match(completeHtml, /data-menu-action="review-sync">Sync Review from Working\.\.\.<\/button>/);
  assert.match(completeHtml, /id="review-sync-dialog"/);
  assert.match(completeHtml, /Type <code>SYNC REVIEW<\/code> to confirm/);
  assert.doesNotMatch(incompleteHtml, /data-menu-action="review-sync"/);
  assert.match(client, /initializeReviewSyncDialog\(\)/);
  assert.match(client, /openReviewSyncDialog\(\)/);
});

test("console tabs are bottom-left navigation and checkout switches are graph-only", () => {
  const html = buildGraphHtml({
    interactive: { enabled: true, token: "secret" },
    graphs: [{
      checkout: "working",
      repository: "comm",
      label: "comm",
      path: "/repo/comm",
      commits: [],
      diffs: {},
    }],
  });
  const staticHtml = buildGraphHtml({
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      commits: [],
      diffs: {},
    }],
  });
  const style = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );
  const dashboardSource = readFileSync(
    new URL("../commands/graph/client/dashboard.js", import.meta.url),
    "utf8",
  );
  const metaBoardsSource = readFileSync(
    new URL("../commands/graph/client/meta-boards.js", import.meta.url),
    "utf8",
  );

  assert.match(html, /<div class="console-footer">/);
  assert.match(html, /<nav class="console-navigation" aria-label="Console views">/);
  assert.match(html, /<div class="toolbar-row graph-toolbar">/);
  assert.match(
    html,
    /class="tab console-view-tab graph-view-tab active" type="button">Tree<\/button>/,
  );
  assert.ok(
    html.indexOf('class="console-navigation"') <
      html.indexOf('class="toolbar-row graph-toolbar"'),
  );
  assert.doesNotMatch(staticHtml, /console-navigation/);
  assert.match(style, /body:not\(\.graph-view-active\) \.graph-toolbar \{\s*display: none;/);
  assert.match(style, /\.console-footer \{[\s\S]*?display: flex;/);
  assert.match(style, /\.graph-toolbar \{[\s\S]*?margin: 0 0 0 auto;/);
  assert.match(style, /\.console-navigation \{[\s\S]*?background: transparent;/);
  assert.match(style, /\.console-view-tab \{[\s\S]*?background: #e8ecf0;/);
  assert.match(style, /\.console-view-tab \{[\s\S]*?border-bottom: 0;[\s\S]*?border-radius: 5px 5px 0 0;/);
  assert.match(style, /\.console-view-tab\.active \{[\s\S]*?background: #1f5f9f;/);
  assert.match(style, /\.console-view-tab \{[\s\S]*?background: #2a313c;/);
  assert.match(style, /\.console-view-tab\.active \{[\s\S]*?background: #4b9eff;/);
  assert.match(dashboardSource, /document\.body\.classList\.remove\("graph-view-active"\)/);
  assert.match(metaBoardsSource, /document\.body\.classList\.remove\("graph-view-active"\)/);
  assert.match(
    readGraphClientScripts(),
    /void loadMoreCommits\(index\)\.then\(\(\) => selectCurrentCommit\(index\)\);/,
  );
});

test("Tree checks the checked-out patch but defers all other integrations and review history", () => {
  const html = buildGraphHtml({
    interactive: { enabled: true, token: "secret" },
    graphs: [{
      checkout: "working",
      repository: "comm",
      label: "comm",
      path: "/repo/comm",
      commits: [],
      diffs: {},
    }],
  });
  const commitActions = readFileSync(
    new URL("../commands/graph/client/commit-actions.js", import.meta.url),
    "utf8",
  );
  const laneRenderer = readFileSync(
    new URL("../commands/graph/client/lane-renderer.js", import.meta.url),
    "utf8",
  );
  const init = readFileSync(
    new URL("../commands/graph/client/init.js", import.meta.url),
    "utf8",
  );

  assert.match(html, /class="load-commit-review" type="button" hidden>Load Review<\/button>/);
  assert.doesNotMatch(html, /load-commit-integration/);
  assert.match(
    commitActions,
    /export async function loadSelectedCommitReviewForCurrentSelection/,
  );
  assert.match(
    commitActions,
    /export async function showDiff\(\s*graph,\s*index,\s*commit,\s*\{ loadCurrentIntegration = false, loadIntegration = false \} = \{\},\s*\)/,
  );
  assert.match(laneRenderer, /showDiff\(state\.graph, index, commit, \{ loadIntegration: true \}\)/);
  assert.match(
    init,
    /void showDiff\(state\.graph, index, currentCommit, \{\s*loadCurrentIntegration: true,\s*\}\);/,
  );
  assert.match(
    commitActions,
    /loadCurrentIntegration &&[^]*getCommitPhabricatorRevision\(commit, message\)/,
  );
  assert.doesNotMatch(commitActions, /const reviewPromise = fetchSelectedCommitReview/);
});

test("static graph does not add review checkout tabs", () => {
  const checkouts = resolveGraphCheckouts({
    cwd: "/repo/working/comm",
    config: {
      reviewCheckout: {
        firefoxPath: "/repo/review",
        commPath: "/repo/review/comm",
      },
    },
  });

  assert.deepEqual(checkouts.map(({ label }) => label), ["comm", "firefox"]);
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

  const forcedPendingResponse = await fetch(
    new URL("api/origin-main-status?token=secret&force=1", serverInfo.url),
  );
  const forcedPendingStatus = await forcedPendingResponse.json();

  assert.equal(forcedPendingStatus.statuses[0].label, "comm");
  assert.equal(forcedPendingStatus.statuses[0].state, "current");
  assert.equal(forcedPendingStatus.statuses[1].label, "firefox");
  assert.equal(forcedPendingStatus.statuses[1].state, "current");
  assert.equal(forcedPendingStatus.statuses[2].type, "rust-upstream");
  assert.equal(forcedPendingStatus.statuses[2].state, "checking");

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

test("patch update always targets the working comm checkout", async (t) => {
  let resolvePrepared;
  const prepared = new Promise((resolve) => {
    resolvePrepared = resolve;
  });
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    graphs: [
      {
        checkout: "working",
        repository: "comm",
        label: "Working comm",
        path: "/work/comm",
      },
      {
        checkout: "working",
        repository: "firefox",
        label: "Working firefox",
        path: "/work/firefox",
      },
      {
        checkout: "review",
        repository: "comm",
        label: "Review comm",
        path: "/review/comm",
      },
      {
        checkout: "review",
        repository: "firefox",
        label: "Review firefox",
        path: "/review/firefox",
      },
    ],
    preparePatchUpdateSession: async (options) => resolvePrepared(options),
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const response = await fetch(new URL("api/patch-update", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 2,
      revision: "D123456",
    }),
  });
  const payload = await response.json();
  const options = await prepared;

  assert.equal(response.ok, true);
  assert.equal(payload.graphIndex, 0);
  assert.equal(options.session.graph.path, "/work/comm");
  assert.equal(options.session.graphIndex, 0);
  assert.deepEqual(
    options.graphs.map((graph) => graph.path),
    ["/work/comm", "/work/firefox"],
  );
});

test("smaller snapshots keep loaded commits available for rebase", async (t) => {
  let checkingRebase = false;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    graphs: [{ label: "comm", path: "/work/comm", commits: [{ hash: "aaa111" }] }],
    runCommand: async ({ args }) => {
      if (args[0] === "status" && checkingRebase) {
        return " M file.txt\n";
      }
      if (args[0] === "cat-file" && args.at(-1) === "ddd444^{commit}") throw new Error("missing object");
      if (args[0] === "branch") return "main\n";
      if (args[0] === "log" && args.includes("--format=%B")) return "Local patch\n";
      if (args[0] === "log") {
        const hash = args.includes("--skip=1") ? "bbb222" : "ccc333";
        return `\x1e${hash}\x1f\x1f\x1fAlice\x1falice@example.com\x1f1710000000\x1fLocal patch\n`;
      }
      return "";
    },
  });
  t.after(() => serverInfo.server.close());

  const page = await fetch(new URL("api/graph/0/commits?offset=1&limit=1&token=secret", serverInfo.url));
  assert.equal((await page.json()).commits[0].hash, "bbb222");
  const snapshot = await fetch(new URL("api/graph/0/snapshot?limit=1&token=secret", serverInfo.url));
  assert.deepEqual((await snapshot.json()).commits.map(commit => commit.hash), ["ccc333"]);

  // Stop at the clean-checkout guard so this test cannot rewrite a repository.
  checkingRebase = true;
  for (const hash of ["aaa111", "bbb222", "ccc333", "ddd444"]) {
    const response = await fetch(new URL("api/commit-action", serverInfo.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", graphIndex: 0, hash, action: "rebase" }),
    });
    const result = await response.json();
    assert.equal(result.ok, false);
    if (hash === "ddd444") {
      assert.equal(response.status, 404);
      assert.match(result.error, /does not exist in comm/);
    } else {
      assert.equal(response.status, 409);
      assert.match(result.error, /has local changes/, hash);
    }
  }
});

test("patch update keeps Git-resolved hashes addressable across graph snapshots", async (t) => {
  let resolvePrepared;
  const prepared = new Promise((resolve) => {
    resolvePrepared = resolve;
  });
  const originalHash = "original-not-in-page";
  const rewrittenHash = "rewritten-not-in-page";
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    graphs: [{
      checkout: "working",
      repository: "comm",
      label: "Working comm",
      path: "/work/comm",
    }],
    preparePatchUpdateSession: async ({ session }) => {
      session.originalHash = originalHash;
      session.currentHash = rewrittenHash;
      resolvePrepared();
    },
    runCommand: async (command) => {
      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "A local patch\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const createResponse = await fetch(new URL("api/patch-update", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      revision: "D123456",
    }),
  });
  assert.equal(createResponse.ok, true);
  await prepared;

  const snapshotResponse = await fetch(
    new URL("api/graph/0/snapshot?limit=1&token=secret", serverInfo.url),
  );
  assert.equal(snapshotResponse.ok, true);

  for (const hash of [originalHash, rewrittenHash]) {
    const response = await fetch(
      new URL(`api/graph/0/message/${hash}?token=secret`, serverInfo.url),
    );

    assert.equal(response.ok, true);
  }
});

test("patch update posts only the reply body to its inline Phabricator parent", async (t) => {
  let resolvePrepared;
  const prepared = new Promise((resolve) => {
    resolvePrepared = resolve;
  });
  const postedReplies = [];
  const doneComments = [];
  const handledComments = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    appConfig: { ai: { enabled: true } },
    graphs: [{
      checkout: "working",
      repository: "comm",
      label: "Working comm",
      path: "/work/comm",
    }],
    phabWebSession: {
      async close() {},
      async markInlineCommentDone(details) {
        doneComments.push(details);
      },
      async postInlineReply(details) {
        postedReplies.push(details);
      },
    },
    persistPatchUpdateHandledComment: async (details) => {
      handledComments.push(details);
    },
    preparePatchUpdateSession: async ({ session }) => {
      session.status = "review";
      session.items = [{
        id: "inline:PHID-XCMT-parent",
        type: "inline",
        parentCommentPHID: "PHID-XCMT-parent",
        state: "ready",
        draftReply: "",
        draftSaved: false,
      }];
      resolvePrepared(session);
    },
    savePatchUpdateMemory: async () => {},
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const createResponse = await fetch(new URL("api/patch-update", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      revision: "D123456",
    }),
  });
  const created = await createResponse.json();

  await prepared;
  const reply = "I updated the implementation and added focused coverage.";
  const response = await fetch(
    new URL(`api/patch-update/${encodeURIComponent(created.id)}/comment`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        itemId: "inline:PHID-XCMT-parent",
        message: reply,
      }),
    },
  );
  const payload = await response.json();

  assert.equal(response.ok, true);
  assert.deepEqual(postedReplies, [{
    revision: "D123456",
    commentPHID: "PHID-XCMT-parent",
    message: reply,
  }]);
  assert.equal(payload.items[0].draftReply, reply);
  assert.equal(payload.items[0].draftSaved, true);
  assert.equal(payload.items[0].state, "ready");
  assert.equal(payload.currentItemIndex, 0);
  assert.deepEqual(handledComments, []);
  assert.match(payload.message, /reply draft saved/i);
  assert.doesNotMatch(postedReplies[0].message, /responses? to review comments|response to .*\(/i);

  const doneResponse = await fetch(
    new URL(`api/patch-update/${encodeURIComponent(created.id)}/handled`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", itemId: "inline:PHID-XCMT-parent" }),
    },
  );
  const donePayload = await doneResponse.json();

  assert.equal(doneResponse.ok, true);
  assert.equal(donePayload.items[0].state, "handled");
  assert.deepEqual(doneComments, [{
    revision: "D123456",
    commentPHID: "PHID-XCMT-parent",
  }]);
  assert.deepEqual(handledComments, [{
    revision: "D123456",
    itemId: "inline:PHID-XCMT-parent",
  }]);
});

test("patch update keeps, amends, and handles a source response before moving on", async (t) => {
  let resolvePrepared;
  const prepared = new Promise((resolve) => {
    resolvePrepared = resolve;
  });
  const acceptedChanges = [];
  const doneComments = [];
  const handledComments = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    appConfig: { ai: { enabled: true } },
    graphs: [{
      checkout: "working",
      repository: "comm",
      label: "Working comm",
      path: "/work/comm",
    }],
    acceptPatchUpdateChange: async ({ itemId, session }) => {
      const item = session.items.find((candidate) => candidate.id === itemId);

      acceptedChanges.push(itemId);
      item.changeAccepted = false;
      item.changeApplied = false;
      item.changesAmended = true;
      session.currentHash = "amended456";
      session.workingDiff = "";
      session.workingDiffHtml = "";
      session.workingTreeDiffVersion = 1;
      session.message = "Source change was amended into the current commit. You can now post a reply, skip, or mark this comment done.";
    },
    phabWebSession: {
      async close() {},
      async markInlineCommentDone(details) {
        doneComments.push(details);
      },
    },
    persistPatchUpdateHandledComment: async (details) => {
      handledComments.push(details);
    },
    preparePatchUpdateSession: async ({ session }) => {
      session.status = "review";
      session.currentHash = "original123";
      session.items = [
        {
          changeAccepted: false,
          changeApplied: true,
          changesAmended: false,
          id: "inline:1",
          parentCommentPHID: "PHID-XCMT-1",
          state: "ready",
          type: "inline",
        },
        { id: "inline:2", state: "ready" },
      ];
      resolvePrepared(session);
    },
    savePatchUpdateMemory: async () => {},
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const createResponse = await fetch(new URL("api/patch-update", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      revision: "D123456",
    }),
  });
  const created = await createResponse.json();

  await prepared;
  const response = await fetch(
    new URL(`api/patch-update/${encodeURIComponent(created.id)}/keep`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "secret",
        itemId: "inline:1",
      }),
    },
  );
  const payload = await response.json();

  assert.equal(response.ok, true);
  assert.deepEqual(acceptedChanges, ["inline:1"]);
  assert.deepEqual(handledComments, []);
  assert.equal(payload.currentHash, "amended456");
  assert.equal(payload.workingDiff, "");
  assert.equal(payload.items[0].changesAmended, true);
  assert.equal(payload.items[0].state, "ready");
  assert.equal(payload.currentItemIndex, 0);
  assert.equal(payload.items[1].state, "ready");
  assert.match(payload.message, /post a reply, skip, or mark this comment done/i);

  const doneResponse = await fetch(
    new URL(`api/patch-update/${encodeURIComponent(created.id)}/handled`, serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", itemId: "inline:1" }),
    },
  );
  const donePayload = await doneResponse.json();

  assert.equal(doneResponse.ok, true);
  assert.equal(donePayload.items[0].state, "handled");
  assert.equal(donePayload.currentItemIndex, 1);
  assert.deepEqual(doneComments, [{ revision: "D123456", commentPHID: "PHID-XCMT-1" }]);
  assert.deepEqual(handledComments, [{ revision: "D123456", itemId: "inline:1" }]);
});

test("interactive graph server scopes origin and Rust status to the selected checkout", async (t) => {
  const rustCalls = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        checkout: "working",
        repository: "comm",
        label: "Working comm",
        path: "/working/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
      {
        checkout: "working",
        repository: "firefox",
        label: "Working firefox",
        path: "/working",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
      {
        checkout: "review",
        repository: "comm",
        label: "Review comm",
        path: "/review/comm",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
      {
        checkout: "review",
        repository: "firefox",
        label: "Review firefox",
        path: "/review",
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    getRustUpstreamStatus: async ({ graphs, commGraph, firefoxGraph }) => {
      rustCalls.push({ graphs, commGraph, firefoxGraph });
      return {
        type: "rust-upstream",
        label: "rust",
        state: "current",
        upToDate: true,
        mismatches: [],
        message: "Rust dependencies match Firefox remote main.",
      };
    },
    runCommand: async (command) => {
      if (command.args[0] === "rev-parse") {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
      }

      if (command.args[0] === "ls-remote") {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const reviewResponse = await fetch(
    new URL("api/origin-main-status?token=secret&checkout=review&force=1&wait=1", serverInfo.url),
  );
  const reviewStatus = await reviewResponse.json();

  assert.deepEqual(
    reviewStatus.statuses.map((status) => [status.label, status.checkout]),
    [["Review comm", "review"], ["Review firefox", "review"], ["rust", "review"]],
  );
  assert.deepEqual(
    rustCalls[0].graphs.map((graph) => graph.checkout),
    ["review", "review"],
  );
  assert.equal(rustCalls[0].commGraph.path, "/review/comm");
  assert.equal(rustCalls[0].firefoxGraph.path, "/review");

  const workingResponse = await fetch(
    new URL("api/origin-main-status?token=secret&checkout=working&force=1&wait=1", serverInfo.url),
  );
  const workingStatus = await workingResponse.json();

  assert.deepEqual(
    workingStatus.statuses.map((status) => [status.label, status.checkout]),
    [["Working comm", "working"], ["Working firefox", "working"], ["rust", "working"]],
  );
  assert.deepEqual(
    rustCalls[1].graphs.map((graph) => graph.checkout),
    ["working", "working"],
  );
});

test("interactive graph server returns interactive rebase plans", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commits: [{ hash: "c1", parents: [], refs: [], subject: "Bug 123" }],
        commitCount: 1,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--points-at")
      ) {
        const hash = command.args[command.args.indexOf("--points-at") + 1];

        return {
          c1: "Bug-123\n",
          c2: "Bug-123_2\n",
        }[hash] || "";
      }

      if (
        command.args[0] === "for-each-ref" &&
        command.args.includes("--contains")
      ) {
        return "Bug-123\nBug-123_2\n";
      }

      if (command.args[0] === "rev-list" && command.args[1] === "--parents") {
        return "c1 base0\n";
      }

      if (command.args[0] === "rev-list") {
        return command.args.at(-1) === "c1..Bug-123_2" ? "c2\n" : "";
      }

      if (command.args[0] === "merge-base") {
        throw new Error("not on main");
      }

      if (command.args[0] === "log") {
        return {
          c1: "Bug 123 - Base patch. r=#reviewers\n",
          c2: "fixup! Bug 123 - Base patch. r=#reviewers\n",
        }[command.args.at(-1)] || "";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const response = await fetch(
    new URL(
      "api/interactive-rebase/plan?token=secret&graphIndex=0&hash=c1&preferredBranch=Bug-123_2",
      serverInfo.url,
    ),
  );
  const result = await response.json();

  assert.equal(response.ok, true);
  assert.equal(result.plan.branch, "Bug-123_2");
  assert.deepEqual(
    result.plan.commits.map((commit) => [commit.hash, commit.action]),
    [
      ["c1", "pick"],
      ["c2", "fixup"],
    ],
  );
});

test("interactive graph submit checks out a selected local commit before submitting", async (t) => {
  const calls = [];
  const localHash = "local123";
  const publishedHash = "published123";
  let head = "current123";
  let branch = "Bug-current";
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      branch,
      commits: [
        { hash: localHash, parents: [], refs: [], subject: "Local patch" },
        { hash: publishedHash, parents: [], refs: ["origin/main"], subject: "Published patch" },
      ],
      commitCount: 2,
      diffs: {},
    }],
    runCommand: async (command) => {
      calls.push(command);
      const [action, ...args] = command.args || [];

      if (action === "merge-base") {
        if (args[1] === publishedHash) {
          return "";
        }
        throw new Error("not on origin/main");
      }

      if (action === "status") {
        return "";
      }

      if (action === "branch" && args[0] === "--show-current") {
        return `${branch}\n`;
      }

      if (action === "rev-parse" && args[0] === "HEAD") {
        return `${head}\n`;
      }

      if (action === "for-each-ref" && args.includes("--points-at")) {
        return "Bug-local\n";
      }

      if (action === "switch" && args[0] === "Bug-local") {
        head = localHash;
        branch = "Bug-local";
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

  const localResponse = await fetch(new URL("api/submit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      hash: localHash,
    }),
  });
  const localResult = await localResponse.json();

  assert.equal(localResponse.ok, true);
  assert.equal(typeof localResult.id, "string");
  assert.equal(head, localHash);
  assert.equal(
    calls.some((command) => (
      command.args?.[0] === "switch" && command.args?.[1] === "Bug-local"
    )),
    true,
  );

  const blockedResponse = await fetch(new URL("api/submit", serverInfo.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", graphIndex: 0, hash: localHash }),
  });
  assert.equal(blockedResponse.status, 409);
  assert.match((await blockedResponse.json()).error, /Submit is still using/);
  await fetch(new URL(`api/submit/${localResult.id}/cancel`, serverInfo.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret" }),
  });

  const publishedResponse = await fetch(new URL("api/submit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      hash: publishedHash,
    }),
  });
  const publishedResult = await publishedResponse.json();

  assert.equal(publishedResponse.status, 409);
  assert.match(publishedResult.error, /not already on origin\/main/i);
});

test("interactive graph server streams commits, diffs, checkout responses, and closes", async (t) => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "tb-checkin-milestone-"));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  await mkdir(path.join(repoPath, "mail", "config"), { recursive: true });
  await writeFile(path.join(repoPath, "mail", "config", "version.txt"), "153.0a1\n");
  const calls = [];
  const bugUpdates = [];
  let checkinMarked = false;
  let reviewTransactionRequests = 0;
  const serverInfo = await startInteractiveGraphServer({
    phabWebSession: {
      getReview: async () => {
        reviewTransactionRequests++;
        return {
          comments: [{ content: "Please take a look at this." }],
          inlineComments: [{ filePath: "file.txt", content: "", codeSuggestion: {
            content: "new", url: "https://phabricator.services.mozilla.com/D987654#inline-100",
          } }],
        };
      },
    },
    getBugzillaRevisions: async () => [{ id: "D987654", status: "accepted", long_status: "Accepted", title: "Bug 123456 - Fix the thing" }],
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: repoPath,
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
    phab: async ({ route }) => {
      if (route === "transaction.search") {
        reviewTransactionRequests++;
        return {
          result: {
            data: [
              {
                id: "transaction-inline",
                phid: "PHID-XACT-inline",
                type: "inline",
                authorPHID: "PHID-USER-reviewer",
                dateCreated: 1710000000,
                fields: {
                  line: 1,
                  path: "file.txt",
                },
                comments: [
                  {
                    id: 100,
                    phid: "PHID-XCMT-inline",
                    authorPHID: "PHID-USER-reviewer",
                    dateCreated: 1710000000,
                    content: { raw: "```suggestion\nnew\n```" },
                  },
                ],
              },
              {
                id: "transaction-comment",
                phid: "PHID-XACT-comment",
                type: "comment",
                authorPHID: "PHID-USER-reviewer",
                dateCreated: 1710000001,
                fields: {},
                comments: [
                  {
                    id: 101,
                    phid: "PHID-XCMT-comment",
                    authorPHID: "PHID-USER-reviewer",
                    dateCreated: 1710000001,
                    content: { raw: "Please take a look at this." },
                  },
                ],
              },
            ],
          },
        };
      }

      if (route === "user.query") {
        return {
          result: [{
            phid: "PHID-USER-reviewer",
            realName: "Reviewing Person",
          }],
        };
      }

      return {
        result: [
          {
            id: 987654,
            uri: "https://phabricator.services.mozilla.com/D987654",
            status: "status-accepted",
            statusName: "Accepted",
            title: "Bug 123456 - Fix the thing",
          },
        ],
      };
    },
    getNotionStoriesByBugId: async ({ bugId }) => ({
      bugId,
      stories: [
        {
          id: "notion-page",
          url: "https://www.notion.so/story",
          title: "Fix the thing story",
          status: "In progress",
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
  assert.equal(
    calls.some(
      (command) =>
        command.args[0] === "show" &&
        command.args.at(-1) === "abc123" &&
        command.args.includes("--unified=2147483647"),
    ),
    true,
  );

  const reviewResponse = await fetch(
    new URL("api/graph/0/review/abc123?token=secret", serverInfo.url),
  );
  const review = await reviewResponse.json();
  assert.equal(review.available, true);
  assert.equal(review.comments[0].content, "Please take a look at this.");
  assert.equal(review.inlineComments[0].filePath, "file.txt");
  assert.equal(review.inlineComments[0].content, "");
  assert.deepEqual(review.inlineComments[0].codeSuggestion, {
    content: "new",
    url: "https://phabricator.services.mozilla.com/D987654#inline-100",
  });

  const cachedReviewResponse = await fetch(
    new URL("api/graph/0/review/abc123?token=secret", serverInfo.url),
  );
  assert.equal(cachedReviewResponse.ok, true);
  assert.equal(reviewTransactionRequests, 1);

  const integrationResponse = await fetch(
    new URL("api/graph/0/integration/abc123?token=secret", serverInfo.url),
  );
  const integration = await integrationResponse.json();
  assert.equal(integration.bug.status, "NEW");
  assert.equal(integration.bug.summary, "Fix the thing");
  assert.equal(integration.bug.hasCheckinNeeded, false);
  assert.equal(integration.phabricator.statusName, "Accepted");
  assert.equal(integration.phabricator.title, "Bug 123456 - Fix the thing");
  assert.equal(integration.notion.stories[0].url, "https://www.notion.so/story");
  assert.equal(integration.notion.stories[0].title, "Fix the thing story");

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
        target_milestone: "153 Branch",
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
    new URL("api/origin-main-status?token=secret&force=1&wait=1", serverInfo.url),
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
  assert.equal(rebase.message, "comm rebased abc123 onto main.");
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
  assert.match(update.output, /\$ git fetch origin main/);
  assert.match(update.output, /\$ git pull --ff-only origin main/);

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
        call.cwd === repoPath &&
        call.args.join(" ") === "build",
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.cmd.endsWith("mach") &&
        call.cwd === repoPath &&
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
    false,
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
  let committedMessage = "";
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
          ? committedMessage
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
        committedMessage = readFileSync(command.args.at(-1), "utf8");
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

test("interactive graph server manages the Phabricator web session", async (t) => {
  const calls = [];
  const phabWebSession = {
    async getStatus() {
      calls.push("status");
      return { state: "disconnected", message: "Not connected." };
    },
    async startAuthentication() {
      calls.push("start");
      return { state: "pending", message: "Sign in in the browser." };
    },
    async cancelAuthentication() {
      calls.push("cancel");
      return { state: "disconnected", message: "Canceled." };
    },
    async signOut() {
      calls.push("sign-out");
      return { state: "disconnected", message: "Signed out." };
    },
    async getSuggestions() {
      return new Map();
    },
    async close() {
      calls.push("close");
    },
  };
  const serverInfo = await startInteractiveGraphServer({
    closeBrowserTabsOnShutdown: false,
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      commits: [],
      commitCount: 0,
      diffs: {},
    }],
    phabWebSession,
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const statusResponse = await fetch(
    new URL("api/phabricator/auth?token=secret", serverInfo.url),
  );
  const status = await statusResponse.json();
  assert.deepEqual(status, {
    ok: true,
    state: "disconnected",
    message: "Not connected.",
  });

  const startResponse = await fetch(
    new URL("api/phabricator/auth/start", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    },
  );
  assert.deepEqual(await startResponse.json(), {
    ok: true,
    state: "pending",
    message: "Sign in in the browser.",
  });

  const cancelResponse = await fetch(
    new URL("api/phabricator/auth/cancel", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    },
  );
  assert.deepEqual(await cancelResponse.json(), {
    ok: true,
    state: "disconnected",
    message: "Canceled.",
  });

  const signOutResponse = await fetch(
    new URL("api/phabricator/auth/sign-out", serverInfo.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    },
  );
  assert.deepEqual(await signOutResponse.json(), {
    ok: true,
    state: "disconnected",
    message: "Signed out.",
  });

  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );
  serverInfo.server.shutdown(0, "test complete");
  await closePromise;
  assert.deepEqual(calls, ["status", "start", "cancel", "sign-out", "close"]);
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
  let committedMessage = "";
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
        return committedMessage || "Bug 123 - Server try. r=#reviewers\n";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Server try\n";
      }

      if (command.cmd === "sh") {
        return "server-patch-id abc123\n";
      }

      if (command.args[0] === "commit" && command.args[1] === "--amend") {
        committedMessage = readFileSync(command.args.at(-1), "utf8");
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
  const bugUpdates = [];
  const commPath = await mkdtemp(path.join(os.tmpdir(), "tb-tools-land-"));
  const firefoxPath = path.join(commPath, "firefox");
  await mkdir(path.join(commPath, "mail", "config"), { recursive: true });
  await writeFile(path.join(commPath, "mail", "config", "version.txt"), "128.0a1\n");
  let transactionSearches = 0;
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: commPath,
        branch: "main",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
      {
        label: "firefox",
        path: firefoxPath,
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
        target_milestone: "---",
      },
    ],
    updateBug: async (bugId, update) => {
      bugUpdates.push([bugId, update]);
    },
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

      if (command.cwd === firefoxPath && command.args[0] === "status") {
        return "?? .tb-review-scratch/\n";
      }

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
    return rm(commPath, { recursive: true, force: true });
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
      snapshotLimits: [1, 1],
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
  assert.equal(
    calls.some(
      (call) => call.cwd === firefoxPath && call.args[0] === "status",
    ),
    false,
  );

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
    (item) => item.prompt?.message === "Enter target milestone for bug 123456.",
  );
  assert.equal(session.prompt.type, "input");
  assert.equal(session.prompt.defaultValue, "128 Branch");

  session = await answer(session, "129 Branch");
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
      localRepo: commPath,
      yes: true,
    },
  ]);
  assert.deepEqual(bugUpdates, [
    ["123456", { target_milestone: "129 Branch" }],
  ]);
  assert.match(
    session.output,
    /Set bug 123456 target milestone to 129 Branch\./,
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

test("interactive graph server keeps reviewer autocomplete disabled", async (t) => {
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
      throw new Error("Reviewer autocomplete must not query Phabricator.");
    },
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const response = await fetch(
    new URL("api/commit/reviewers?query=mail&token=secret", serverInfo.url),
  );
  const result = await response.json();

  assert.equal(response.ok, true);
  assert.equal(result.disabled, true);
  assert.deepEqual(result.reviewers, []);
  assert.deepEqual(phabCalls, []);
});

test("interactive graph server creates commits with manually entered reviewers", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tb-tools-commit-"));
  const storePath = path.join(tempDir, "try-runs.json");
  const calls = [];
  let branch = "Bug-1234567";
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
    phab: async () => {
      throw new Error("Committing manually entered reviewers must not query Phabricator.");
    },
    runCommand: async (command) => {
      calls.push(command);

      if (
        command.args[0] === "branch" &&
        command.args[1] === "--show-current"
      ) {
        return `${branch}\n`;
      }

      if (command.args[0] === "for-each-ref") {
        return "Bug-1234567\n";
      }

      if (command.args[0] === "switch" && command.args[1] === "-c") {
        branch = command.args[2];
        return "";
      }

      if (command.args[0] === "add") {
        return "";
      }

      if (command.args[0] === "commit") {
        assert.equal(command.args[0], "commit");
        assert.equal(command.args[1], "-m");
        assert.match(
          command.args[2],
          /^Bug 1234567 - Fix folder keyboard flow\. r=aleca!,#mail-reviewers\n\nTB-Tools-Id: [0-9a-f-]+$/,
        );
        return `[${branch} def456] Bug 1234567 - Fix folder keyboard flow. r=aleca!,#mail-reviewers\n`;
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "--git-path") {
        return storePath;
      }

      if (command.args[0] === "rev-parse") {
        return "def4567890abcdef\n";
      }

      if (command.args[0] === "log") {
        return `\x1edef4567890abcdef\x1f\x1fHEAD -> ${branch}\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 1234567 - Fix folder keyboard flow\n`;
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
  assert.equal(metadata.metadata.bugRequired, true);
  assert.equal(metadata.metadata.bugId, "");

  const commitResponse = await fetch(new URL("api/commit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      options: {
        bugId: "1234567",
        summary: "Fix folder keyboard flow",
        reviewers: [{ value: "aleca", blocking: true }, "#mail-reviewers"],
      },
      snapshotLimits: [1],
    }),
  });
  const commit = await commitResponse.json();

  assert.equal(commit.ok, true);
  assert.equal(commit.hash, "def4567890abcdef");
  assert.match(
    commit.commitMessage,
    /^Bug 1234567 - Fix folder keyboard flow\. r=aleca!,#mail-reviewers\n\nTB-Tools-Id: [0-9a-f-]+$/,
  );
  assert.equal(commit.snapshots[0].branch, "Bug-1234567_2");
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
  let committedMessage = "";
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

      if (command.args[0] === "merge-base") {
        throw Object.assign(new Error("not on origin/main"), { code: 1 });
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
        return committedMessage ||
          "Bug 123 - Submit me. r=#reviewers\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Submit me\n";
      }

      if (command.cmd === "sh") {
        return "submit-patch-id abc123\n";
      }

      if (command.args[0] === "commit" && command.args[1] === "--amend") {
        committedMessage = readFileSync(command.args.at(-1), "utf8");
        return "";
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
  assert.match(session.output, /\$ moz-phab submit --single/);
  assert.match(
    session.output,
    /Submitted https:\/\/phabricator\.services\.mozilla\.com\/D123456/,
  );
  assert.match(session.output, /\$ \.\.\/mach try auto --no-artifact/);
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
        call.args.join(" ") === "try auto --no-artifact",
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

test("interactive graph submit replays descendant branches after moz-phab amends current commit", async (t) => {
  const calls = [];
  let branch = "Bug-1";
  let head = "old111";
  let pendingCherryPick = "";
  let rewrittenChildIndex = 0;
  const refs = {
    "Bug-1": "old111",
    "Bug-2": "child111",
  };
  const parents = {
    old111: "main000",
    new111: "main000",
    child111: "old111",
  };
  const messages = {
    old111: "Bug 1 - Part 1. r=#reviewers\n",
    new111:
      "Bug 1 - Part 1. r=#reviewers\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n",
    child111: "Bug 2 - Part 2. r=#reviewers\n",
  };
  const isAncestor = (ancestor, tip) => {
    for (let current = tip; current; current = parents[current]) {
      if (current === ancestor) {
        return true;
      }
    }

    return false;
  };
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "Bug-1",
        commits: [],
        commitCount: 0,
        diffs: {},
      },
    ],
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd === "moz-phab") {
        refs["Bug-1"] = "new111";
        head = "new111";
        messages.new111 =
          "Bug 1 - Part 1. r=#reviewers\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
        return "Submitted https://phabricator.services.mozilla.com/D123456\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return branch ? `${branch}\n` : "";
      }

      if (command.args[0] === "branch" && command.args[1] === "-f") {
        refs[command.args[2]] = command.args[3];
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        const pointsAtIndex = command.args.indexOf("--points-at");
        const containsIndex = command.args.indexOf("--contains");
        const pointsAt = pointsAtIndex === -1 ? "" : command.args[pointsAtIndex + 1];
        const contains = containsIndex === -1 ? "" : command.args[containsIndex + 1];
        const matchingRefs = Object.entries(refs)
          .filter(([, value]) => {
            if (pointsAt) {
              return value === pointsAt;
            }

            return isAncestor(contains, value);
          })
          .map(([name]) => name)
          .sort();

        return `${matchingRefs.join("\n")}${matchingRefs.length ? "\n" : ""}`;
      }

      if (command.args[0] === "rev-list") {
        const range = command.args.at(-1);
        const [start, endRef] = range.split("..");
        const end = refs[endRef] || endRef;

        return isAncestor(start, end) && end === "child111" ? "child111\n" : "";
      }

      if (command.args[0] === "merge-base") {
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }

      if (command.args[0] === "switch" && command.args[1] === "--detach") {
        branch = "";
        head = command.args[2];
        return "";
      }

      if (command.args[0] === "switch") {
        branch = command.args[1];
        head = refs[branch];
        return "";
      }

      if (command.args[0] === "cherry-pick") {
        pendingCherryPick = command.args.at(-1);
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "-C") {
        assert.equal(command.args[2], pendingCherryPick);
        rewrittenChildIndex += 1;
        const rewrittenHash = `child-new-${rewrittenChildIndex}`;

        parents[rewrittenHash] = head;
        messages[rewrittenHash] = messages[pendingCherryPick];
        head = rewrittenHash;
        pendingCherryPick = "";
        return "";
      }

      if (command.args[0] === "rev-parse" && command.args[1] === "HEAD") {
        return `${head}\n`;
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        const hash = command.args.at(-1)?.startsWith("--") ? head : command.args.at(-1);

        return messages[hash] || messages[head] || "";
      }

      if (command.args[0] === "log") {
        return `\x1e${head}\x1f${parents[head] || ""}\x1fHEAD -> ${branch || "(detached)"}\x1fAlice\x1falice@example.com\x1f1710000000\x1f${messages[head]?.split("\n")[0] || "Submitted"}\n`;
      }

      if (command.cmd === "sh" || command.args[0] === "diff" || command.args[0] === "ls-files") {
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

  const startResponse = await fetch(new URL("api/submit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      hash: "old111",
      snapshotLimit: 1,
    }),
  });
  const start = await startResponse.json();
  assert.equal(start.ok, true);

  const sessionUrl = new URL(`api/submit/${start.id}?token=secret`, serverInfo.url);
  let session = await waitForSubmitSession(
    sessionUrl,
    (item) => item.status === "prompt",
  );

  for (const answer of [false, false, false, false]) {
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
  }

  assert.equal(session.status, "complete");
  assert.match(session.output, /\$ moz-phab submit --single/);
  assert.match(session.output, /Replayed 1 descendant commit onto submitted commit new111/);
  assert.equal(branch, "Bug-1");
  assert.equal(head, "new111");
  assert.equal(refs["Bug-1"], "new111");
  assert.equal(refs["Bug-2"], "child-new-1");
  assert.equal(parents["child-new-1"], "new111");
  assert.equal(session.snapshot.branch, "Bug-1");
  assert.equal(session.snapshot.commits[0].hash, "new111");
  assert.equal(
    calls.some(
      (call) =>
        call.cmd === "moz-phab" &&
        call.args.join(" ") === "submit --single",
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

test("interactive graph server stays alive when browser tabs are idle or close", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    heartbeatIntervalMs: 10,
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

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(serverInfo.server.listening, true);

  const response = await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", clientId: "tab-one" }),
  });
  assert.deepEqual(await response.json(), { ok: true, remainingClients: 0 });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    serverInfo.server.listening,
    true,
    "closing a browser tab must not shut down the console server",
  );
});

test("interactive graph server survives refreshes and multiple browser clients", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    heartbeatIntervalMs: 10,
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
  assert.deepEqual(await close("tab-one"), { ok: true, remainingClients: 0 });

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

  assert.deepEqual(await close("tab-three"), { ok: true, remainingClients: 0 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(serverInfo.server.listening, true);
});

test("interactive graph server asks browser tabs to close on shutdown", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    browserShutdownGraceMs: 5,
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

  const shutdownEvent = fetch(
    new URL("api/shutdown-events?token=secret&clientId=tab-one", serverInfo.url),
  ).then((response) => response.json());
  const closePromise = new Promise((resolve) =>
    serverInfo.server.once("close", resolve),
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  serverInfo.server.shutdown(0, "terminal signal received");

  assert.deepEqual(await shutdownEvent, {
    ok: true,
    closing: true,
    closeTabs: true,
    reason: "terminal signal received",
  });
  await closePromise;
  assert.equal(serverInfo.server.closeReason, "terminal signal received");
});

test("interactive graph launcher accepts old links while actions require the current token", async (t) => {
  const launcherHtml = buildInteractiveGraphLauncherHtml({
    consolePath: "/",
    tabName: "tb-tools-console-secret",
  });
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    launcherHtml,
    token: "secret",
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      commits: [],
      commitCount: 0,
      diffs: {},
    }],
    runCommand: async () => "",
  });

  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const response = await fetch(
    new URL("launch?token=secret", serverInfo.url),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), launcherHtml);

  for (const suffix of ["", "?token=previous-process"]) {
    const launch = await fetch(new URL(`launch${suffix}`, serverInfo.url));
    assert.equal(launch.status, 200);
    assert.equal(launch.headers.get("cache-control"), "no-store");
    assert.equal(await launch.text(), launcherHtml);
  }
  for (const token of [undefined, "previous-process"]) {
    const unauthorizedAction = await fetch(new URL("api/commit-action", serverInfo.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, graphIndex: 0, action: "rebase", hash: "abc123" }),
    });
    assert.equal(unauthorizedAction.status, 403);
  }
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
  assert.equal(signals.listenerCount("SIGHUP"), 0);
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
    startServer: async ({
      html,
      launcherHtml,
      token,
      pageSize,
      port,
      fallbackPort,
      closeBrowserTabsOnShutdown,
    }) => {
      calls.push([
        "server",
        /id="graph-config"/.test(html),
        /\/assets\/graph-client\/init\.js/.test(html),
        /window\.open\(consolePath, tabName\)/.test(launcherHtml),
        token,
        pageSize,
        port,
        fallbackPort,
        closeBrowserTabsOnShutdown,
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
    ["server", true, true, true, "secret", 25, 4310, 0, true],
    ["open", "http://127.0.0.1:1234/launch"],
    ["wait", {}],
  ]);
});

test("console command can leave browser tabs open on process shutdown", async () => {
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
    startServer: async ({ closeBrowserTabsOnShutdown, fallbackPort, port }) => {
      calls.push(["server", closeBrowserTabsOnShutdown, port, fallbackPort]);
      return {
        url: "http://127.0.0.1:1234/",
        server: {},
      };
    },
    waitForClose: async (server) => calls.push(["wait", server]),
  });

  const url = await command({ closeTabs: false, open: false, port: 0 });

  assert.equal(url, "http://127.0.0.1:1234/");
  assert.deepEqual(calls, [
    ["server", false, 0, undefined],
    ["wait", {}],
  ]);
});

test("interactive graph server falls back to a random port when the preferred port is busy", async (t) => {
  const blocker = createServer((_request, response) => response.end("another service"));

  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());

  const serverInfo = await startInteractiveGraphServer({
    graphs: [{ label: "comm", path: "/repo/comm" }],
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    port: blocker.address().port,
    fallbackPort: 0,
  });

  t.after(() => serverInfo.server.close());

  assert.notEqual(new URL(serverInfo.url).port, String(blocker.address().port));
  assert.equal(blocker.listening, true);
});

test("interactive graph server replaces another console on the preferred port", async (t) => {
  const graphs = [{ label: "comm", path: "/repo/comm" }];
  const previous = await startInteractiveGraphServer({
    graphs,
    html: buildGraphHtml({
      graphs,
      interactive: { enabled: true, token: "previous-token" },
      scriptSrcs: ["/assets/graph-client/init.js"],
    }),
    token: "previous-token",
    port: 0,
    closeBrowserTabsOnShutdown: false,
  });
  t.after(() => { if (previous.server.listening) previous.server.close(); });

  const preferredPort = Number(new URL(previous.url).port);
  const replacement = await startInteractiveGraphServer({
    graphs,
    html: "<!doctype html><p>replacement</p>",
    token: "new-token",
    port: preferredPort,
    fallbackPort: 0,
  });
  t.after(() => replacement.server.close());

  assert.equal(Number(new URL(replacement.url).port), preferredPort);
  assert.equal(previous.server.closeReason, "browser tab closed");
  assert.equal(previous.server.listening, false);

  // The browser can finish opening the earlier URL after the port changes owners.
  const delayedLaunch = await fetch(new URL("launch?token=previous-token", previous.url));
  assert.equal(delayedLaunch.status, 200);
  assert.equal(await delayedLaunch.text(), "<!doctype html><p>replacement</p>");

  const staleAction = await fetch(new URL("api/commit-action", replacement.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "previous-token", graphIndex: 0, action: "rebase", hash: "abc123" }),
  });
  assert.equal(staleAction.status, 403);
});
