import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addGraphPatchReviewInline,
  applyGraphPatchReviewSuggestion,
  createGraphPatchReviewSession,
  getGraphPatchReviewCodexThreadName,
  getGraphPatchReviewContext,
  getGraphPatchReviewPrompt,
  prepareGraphPatchReviewSession,
  steerGraphPatchReviewSession,
  submitGraphPatchReview,
} from "../commands/graph/patch-review.mjs";

function getReviewGraphs() {
  return [
    {
      checkout: "working",
      repository: "comm",
      label: "Working comm",
      path: "/repo/working/comm",
    },
    {
      checkout: "review",
      repository: "comm",
      label: "Review comm",
      path: "/repo/review/comm",
    },
    {
      checkout: "review",
      repository: "firefox",
      label: "Review firefox",
      path: "/repo/review/firefox",
    },
  ];
}

test("patch review pulls an exact raw patch into the configured Review clone when AI is disabled", async () => {
  const calls = [];
  const writes = [];
  const snapshots = [];
  const session = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "123456",
    aiEnabled: false,
    snapshotLimit: 7,
  });

  await prepareGraphPatchReviewSession({
    session,
    getSnapshot: async (graph, limit) => {
      snapshots.push({ graph, limit });
      return { branch: "D123456", path: graph.path };
    },
    makeTempDirectory: async () => "/tmp/tb-tools-review-test",
    writeRawPatch: async (...args) => writes.push(args),
    runCommand: async ({ args, cmd, cwd }) => {
      calls.push({ args, cmd, cwd });
      if (cmd === "git" && args[0] === "status") {
        return "";
      }
      if (cmd === "moz-phab" && args.includes("--raw")) {
        return "diff --git a/mail/example.mjs b/mail/example.mjs\n@@ -1 +1 @@\n-old\n+new\n";
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return "abcdef123456\n";
      }
      if (cmd === "git" && args[0] === "log") {
        return "Bug 123456 - Example\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
      }
      return "Pulled D123456\n";
    },
  });

  assert.equal(session.graph.path, "/repo/review/comm");
  assert.equal(session.reviewFirefoxPath, "/repo/review/firefox");
  assert.equal(session.status, "complete");
  assert.equal(session.currentHash, "abcdef123456");
  assert.match(session.rawPatchHash, /^[a-f0-9]{64}$/);
  assert.match(session.rawPatchHtml, /class="pretty-file"/);
  assert.equal(session.reviewContextVersion, 1);
  assert.deepEqual(snapshots, [{ graph: session.graph, limit: 7 }]);
  assert.deepEqual(writes, [[
    "/tmp/tb-tools-review-test/D123456.patch",
    "diff --git a/mail/example.mjs b/mail/example.mjs\n@@ -1 +1 @@\n-old\n+new\n",
    "utf8",
  ]]);
  assert.deepEqual(calls.map(({ args, cmd, cwd }) => ({ args, cmd, cwd })), [
    { cmd: "git", args: ["rebase", "--abort"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["cherry-pick", "--abort"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["merge", "--abort"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["am", "--abort"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["reset", "--hard"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["clean", "-ffdx"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["switch", "main"], cwd: "/repo/review/comm" },
    { cmd: "moz-phab", args: ["patch", "D123456", "--raw", "--skip-dependencies"], cwd: "/repo/review/comm" },
    { cmd: "moz-phab", args: ["patch", "D123456", "--apply-to", "here"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["rev-parse", "HEAD"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["log", "-1", "--format=%B"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["log", "--reverse", "--format=%H%x09%s", "main..HEAD"], cwd: "/repo/review/comm" },
  ]);
});

test("patch review falls back to the selected patch after parent patches fail", async () => {
  const calls = [];
  const session = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "123456",
    aiEnabled: false,
  });

  await prepareGraphPatchReviewSession({
    session,
    getSnapshot: async () => ({ branch: "D123456" }),
    makeTempDirectory: async () => "/tmp/tb-tools-review-fallback",
    writeRawPatch: async () => {},
    runCommand: async ({ args, cmd, cwd }) => {
      calls.push({ args, cmd, cwd });

      if (cmd === "git" && args[0] === "status") {
        return "";
      }
      if (cmd === "moz-phab" && args.includes("--raw")) {
        return "diff --git a/mail/example.mjs b/mail/example.mjs\n@@ -1 +1 @@\n-old\n+new\n";
      }
      if (cmd === "moz-phab" && !args.includes("--skip-dependencies")) {
        const error = new Error("parent patch could not apply");

        error.stderr = "parent patch could not apply\n";
        throw error;
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return "abcdef123456\n";
      }
      if (cmd === "git" && args[0] === "log") {
        return "Bug 123456 - Example\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
      }

      return "";
    },
  });

  assert.equal(session.status, "complete");
  assert.deepEqual(calls.map(({ args }) => args), [
    ["rebase", "--abort"],
    ["cherry-pick", "--abort"],
    ["merge", "--abort"],
    ["am", "--abort"],
    ["reset", "--hard"],
    ["clean", "-ffdx"],
    ["switch", "main"],
    ["patch", "D123456", "--raw", "--skip-dependencies"],
    ["patch", "D123456", "--apply-to", "here"],
    ["rebase", "--abort"],
    ["cherry-pick", "--abort"],
    ["merge", "--abort"],
    ["am", "--abort"],
    ["reset", "--hard"],
    ["clean", "-ffdx"],
    ["switch", "main"],
    ["patch", "D123456", "--skip-dependencies", "--apply-to", "here"],
    ["rev-parse", "HEAD"],
    ["log", "-1", "--format=%B"],
    ["log", "--reverse", "--format=%H%x09%s", "main..HEAD"],
  ]);
  assert.match(session.output, /Parent patch stack could not be applied/);
});

test("patch review adds a selected code suggestion as a pending inline before final review", async () => {
  const calls = [];
  const session = {
    aiEnabled: true,
    revision: "D123456",
    currentIssueIndex: 0,
    issues: [{
      id: "correct-cleanup",
      filePath: "mail/example.mjs",
      lineNumber: 42,
      lineLength: 1,
      isNewFile: true,
      suggestedComment: "Please use the shared cleanup helper.",
      codeSuggestion: "cleanup();",
      state: "ready",
    }],
  };

  await addGraphPatchReviewInline({
    session,
    itemId: "correct-cleanup",
    kind: "suggestion",
    createInlineComment: async (details) => calls.push(details),
  });

  assert.deepEqual(calls, [{
    revision: "D123456",
    filePath: "mail/example.mjs",
    isNewFile: true,
    lineNumber: 42,
    lineLength: 1,
    content: "Please use the shared cleanup helper.\n\n```suggestion\ncleanup();\n```",
  }]);
  assert.equal(session.issues[0].state, "pending");
  assert.equal(session.issues[0].pendingKind, "suggestion");
  assert.equal(session.currentIssueIndex, 1);
  assert.equal(session.reviewContextVersion, 1);
  assert.deepEqual(session.reviewDiscussion.inlineComments, [{
    action: "pending inline draft",
    author: "You",
    codeSuggestion: { content: "cleanup();", url: "" },
    commentId: "pending:correct-cleanup",
    content: "Please use the shared cleanup helper.",
    dateCreated: session.reviewDiscussion.inlineComments[0].dateCreated,
    filePath: "mail/example.mjs",
    id: "pending:correct-cleanup",
    isNewFile: true,
    lineLength: 1,
    lineNumber: 42,
    url: "",
  }]);
});

test("patch review applies a suggestion only in the Review checkout and keeps its reply active", async () => {
  const writes = [];
  const session = {
    aiEnabled: true,
    graph: {
      checkout: "review",
      path: "/repo/review/comm",
      repository: "comm",
    },
    issues: [{
      id: "correct-cleanup",
      filePath: "mail/example.mjs",
      lineNumber: 2,
      lineLength: 1,
      codeSuggestion: "cleanup();\nverify();",
      suggestedComment: "Use the shared cleanup helper.",
      state: "ready",
    }],
    workingTreeDiffVersion: 3,
  };

  await applyGraphPatchReviewSuggestion({
    session,
    itemId: "correct-cleanup",
    readSource: async () => "first();\nold();\nlast();\n",
    writeSource: async (...details) => writes.push(details),
  });

  assert.deepEqual(writes, [[
    "/repo/review/comm/mail/example.mjs",
    "first();\ncleanup();\nverify();\nlast();\n",
    "utf8",
  ]]);
  assert.equal(session.issues[0].state, "applied");
  assert.equal(session.workingTreeDiffVersion, 4);
  assert.match(session.message, /Review checkout/);

  const calls = [];
  session.revision = "D123456";
  session.currentIssueIndex = 0;
  await addGraphPatchReviewInline({
    session,
    itemId: "correct-cleanup",
    kind: "suggestion",
    createInlineComment: async (details) => calls.push(details),
  });
  assert.match(calls[0].content, /Use the shared cleanup helper/);
  assert.match(calls[0].content, /```suggestion/);
});

test("patch review publishes pending inline comments with the selected final action", async () => {
  const calls = [];
  const session = {
    aiEnabled: true,
    revision: "D123456",
    currentIssueIndex: 0,
    issues: [{ id: "pending", state: "pending" }],
  };

  await submitGraphPatchReview({
    session,
    outcome: "request-changes",
    message: "Please address the pending inline feedback.",
    publishReview: async (details) => calls.push(details),
  });

  assert.deepEqual(calls, [{
    revision: "D123456",
    message: "Please address the pending inline feedback.",
    action: "reject",
  }]);
  assert.equal(session.status, "complete");
  assert.equal(session.reviewOutcome, "request-changes");
});

test("patch review verifies Request Changes even without pending inline comments", async () => {
  const publishedReviews = [];
  const postedComments = [];
  const session = {
    aiEnabled: true,
    revision: "D123456",
    currentIssueIndex: 0,
    issues: [],
  };

  await submitGraphPatchReview({
    session,
    outcome: "request-changes",
    message: "Please address the focus regression.",
    postComment: async (details) => postedComments.push(details),
    publishReview: async (details) => publishedReviews.push(details),
  });

  assert.deepEqual(publishedReviews, [{
    revision: "D123456",
    message: "Please address the focus regression.",
    action: "reject",
  }]);
  assert.deepEqual(postedComments, []);
  assert.equal(session.reviewOutcome, "request-changes");
});

test("patch review requires browser-backed publication for pending inline comments", async () => {
  const session = {
    aiEnabled: true,
    revision: "D123456",
    currentIssueIndex: 0,
    issues: [{ id: "pending", state: "pending" }],
  };

  await assert.rejects(
    submitGraphPatchReview({
      session,
      outcome: "comment",
      message: "A final note.",
    }),
    /Sign in to Phabricator/,
  );
  assert.equal(session.status, "review");
});

test("patch review prompt grants local Review experiments while protecting the working checkout", () => {
  const prompt = getGraphPatchReviewPrompt({
    revision: "D123456",
    graph: { path: "/repo/review/comm" },
    reviewFirefoxPath: "/repo/review/firefox",
    rawPatchPath: "/tmp/D123456.patch",
    rawPatchHash: "abc123",
    currentHash: "def456",
    commitMessage: "Bug 123456 - Example",
    memoryContext: "Relevant shared history for Bug 123456.",
    reviewDiscussion: {
      available: true,
      comments: [{ author: "Reviewer", content: "Please verify the focus contract.", id: "PHID-X" }],
      inlineComments: [],
    },
    stackContext: "def456\tBug 123456 - Example",
  });

  assert.match(prompt, /raw unified diff/);
  assert.match(prompt, /accessibility review/);
  assert.match(prompt, /never a local clone line/);
  assert.match(prompt, /CodeRabbit/);
  assert.match(prompt, /local uncommitted source and test changes/i);
  assert.match(prompt, /explicit user authorization to make uncommitted source and test edits/i);
  assert.match(prompt, /Never access, inspect, switch to, or modify the working checkout/i);
  assert.match(prompt, /paired Review Firefox checkout at \/repo\/review\/firefox/i);
  assert.match(prompt, /Relevant shared history for Bug 123456/);
  assert.match(prompt, /Please verify the focus contract/);
  assert.match(prompt, /"patchContext"/);
});

test("patch review exposes the rendered patch and discussion through its local session context", () => {
  const session = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "D123456",
    aiEnabled: true,
  });

  session.rawPatchHash = "abc123";
  session.rawPatchHtml = '<section class="pretty-file"></section>';
  session.reviewDiscussion = {
    available: true,
    comments: [{ author: "Reviewer", content: "General feedback." }],
    inlineComments: [],
  };
  const context = getGraphPatchReviewContext(session);

  assert.equal(context.rawPatchHash, "abc123");
  assert.equal(context.reviewContextVersion, 0);
  assert.equal(context.rawPatchHtml, '<section class="pretty-file"></section>');
  assert.equal(context.reviewDiscussion.comments[0].content, "General feedback.");
  assert.match(session.codexThreadName, /^D123456 - Review \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(
    getGraphPatchReviewCodexThreadName({
      revision: "123456",
      now: new Date("2026-09-08T14:05:00"),
    }),
    "D123456 - Review 2026-09-08 14:05",
  );
});

test("patch review serializes a context version so a later discussion response replaces an early raw-patch response", () => {
  const session = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "D123456",
    aiEnabled: true,
  });

  session.rawPatchHash = "abc123";
  session.rawPatchHtml = '<section class="pretty-file"></section>';
  session.reviewContextVersion = 2;
  const context = getGraphPatchReviewContext(session);

  assert.equal(context.reviewContextVersion, 2);
});

test("patch review feedback continues the persistent Codex session after the initial review", async () => {
  let resolveTurn;
  const session = {
    aiEnabled: true,
    activity: [],
    codexAgent: {
      client: {
        startTurn({ onTurnStarted }) {
          onTurnStarted("follow-up-turn");
          return new Promise((resolve) => {
            resolveTurn = resolve;
          });
        },
      },
      threadId: "thread-123",
    },
    codexTurnId: "",
    coverage: { summary: "Initial assessment." },
    graph: { checkout: "review", path: "/repo/review/comm", repository: "comm" },
    issues: [{
      codeSuggestion: "cleanup();",
      id: "pending-inline",
      pendingKind: "suggestion",
      state: "pending",
      suggestedComment: "Please use the shared cleanup helper.",
    }],
    patchContext: {
      behaviorContract: "The helper owns cleanup.",
      purpose: "Preserve cleanup ownership.",
    },
    status: "review",
    workingTreeDiffVersion: 0,
  };

  await steerGraphPatchReviewSession({
    session,
    instruction: "Please re-check the cleanup ownership before finalizing.",
  });
  assert.equal(session.status, "reviewing");
  assert.match(session.message, /revisiting the review/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.codexTurnId, "follow-up-turn");

  resolveTurn({
    message: JSON.stringify({
      coverage: { summary: "Confirmed the cleanup contract." },
      issues: [{
        codeSuggestion: "cleanup();",
        comment: "Please use the shared cleanup helper.",
        filePath: "mail/example.mjs",
        id: "pending-inline",
        lineNumber: 42,
        title: "Use the shared cleanup helper",
      }],
      patchContext: {
        behaviorContract: "The helper owns cleanup.",
        purpose: "Preserve cleanup ownership.",
      },
    }),
    turn: { status: "completed" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.status, "review");
  assert.equal(session.error, "");
  assert.equal(session.issues[0].state, "pending");
  assert.equal(session.issues[0].pendingKind, "suggestion");
  assert.equal(session.workingTreeDiffVersion, 1);
  assert.match(session.message, /updated the review/i);
});

test("patch review client renders the local patch context and Review checkout diff", () => {
  const source = readFileSync(
    new URL("../commands/graph/client/patch-review-dialog.js", import.meta.url),
    "utf8",
  );
  const patchReview = readFileSync(
    new URL("../commands/graph/patch-review.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /\/context\?token=/);
  assert.match(source, /reviewContextVersion/);
  assert.match(source, /diff\/uncommitted-changes\?token=/);
  assert.match(patchReview, /completedSourceEdit/);
  assert.match(source, /appendInlineReviewComment/);
  assert.match(source, /findReviewLine/);
  assert.match(source, /Apply in Review Checkout/);
  assert.match(source, /\["ready", "applied"\]\.includes\(issue\.state\)/);
  assert.match(patchReview, /applyGraphPatchReviewSuggestion/);
  assert.match(source, /setPageScrollLocked/);
  assert.match(source, /reviewActivityFilter/);
  assert.match(source, /session\.status === "review"/);
});

test("patch review activity and discussion stay readable in dark mode", () => {
  const css = readFileSync(
    new URL("../commands/graph/client/style.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /\.patch-review-activity-entry strong,[\s\S]*?color: #f0f6fc;/);
  assert.match(css, /\.patch-review-activity-entry code,[\s\S]*?color: #e6edf3;/);
  assert.match(css, /\.patch-review-activity-command-preview,[\s\S]*?color: #c6d0dc;/);
  assert.match(css, /13px\/1\.55 ui-monospace/);
  assert.match(css, /\.patch-review-activity-command-summary:focus-visible/);
  assert.match(css, /\.patch-review-discussion > summary,[\s\S]*?color: #f0f6fc;/);
  assert.match(css, /\.patch-review-discussion-entry p,[\s\S]*?color: #e6edf3;/);
  assert.match(css, /\.patch-review-discussion-entry a \{[\s\S]*?color: #79c0ff;/);
  assert.match(css, /\.patch-review-activity-filter button \{[\s\S]*?color: #d8e1ec;/);
  assert.match(css, /\.patch-review-activity-filter button\[aria-pressed="true"\] \{[\s\S]*?background: #0b5394;/);
  assert.match(css, /\.patch-review-coverage > summary,[\s\S]*?color: #f0f6fc;/);
});
