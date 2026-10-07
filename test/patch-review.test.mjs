import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  addGraphPatchReviewInline,
  applyGraphPatchReviewSuggestion,
  cancelGraphPatchReviewSession,
  createGraphPatchReviewSession,
  getGraphPatchReviewCodexThreadName,
  getGraphPatchReviewContext,
  getGraphPatchReviewPrompt,
  prepareGraphPatchReviewCodexPrompt,
  refreshGraphPatchReviewContext,
  prepareGraphPatchReviewSession,
  retryGraphPatchReviewSession,
  steerGraphPatchReviewSession,
  submitGraphPatchReview,
} from "../commands/graph/patch-review.mjs";
import { formatGraphPatchUpdateMemory } from "../commands/graph/patch-update-memory.mjs";

test("Review removes repeated history fields while preserving distinct evidence and discussion", () => {
  const history = formatGraphPatchUpdateMemory({ event: "Assessed", session: {
    revision: "D123456", currentHash: "abc", status: "review",
    items: [{ author: "Reviewer", state: "ready", content: "Unique older feedback",
      validation: "Unique validation evidence", url: "https://example.com/comment" }],
  } });
  const comments = Array.from({ length: 120 }, (_, index) => ({
    id: `comment-${index}`, author: "Reviewer", content: `Distinct comment ${index}: ` + "x".repeat(200),
  }));
  const prompt = getGraphPatchReviewPrompt({
    revision: "D123456", graph: { path: "/review/comm" }, memoryContext: history.repeat(100),
    reviewDiscussion: { available: true, comments, inlineComments: [] },
    resumeReviewContext: { issues: [{ id: "old-finding", validation: "Prior experiment" }] },
  });
  assert.equal(prompt.split("> Unique older feedback").length - 1, 1);
  assert.match(prompt, /Unique validation evidence/);
  assert.match(prompt, /Prior experiment/);
  assert.ok(comments.every(comment => prompt.includes(comment.content)));
  assert.doesNotMatch(prompt, /Additional existing discussion omitted/);
});

test("Review keeps oversized requests intact in a file, including resumed review evidence", async (t) => {
  const session = {
    revision: "D123456", graph: { path: "/review/comm" },
    memoryContext: "Earlier unique evidence\n" + "x".repeat(1100000) + "\nLatest unique evidence",
    resumeReviewContext: { issues: [{ id: "pending", state: "pending", codeSuggestion: "exact replacement" }] },
  };
  const prompt = getGraphPatchReviewPrompt(session);
  const input = await prepareGraphPatchReviewCodexPrompt({ session, prompt });
  const filename = JSON.parse(input.match(/saved at ("[^\n]+?")\./)[1]);
  t.after(() => rm(path.dirname(filename), { recursive: true, force: true }));
  assert.ok(input.length < 1048576);
  assert.match(input, /Read that entire file in bounded sections/);
  assert.match(input, /Do not access the Working checkout/);
  assert.equal(await readFile(filename, "utf8"), prompt);
  assert.match(prompt, /exact replacement/);
  assert.match(prompt, /Earlier unique evidence/);
  assert.match(prompt, /Latest unique evidence/);
});

test("Review sends normal requests unchanged", async () => {
  assert.equal(await prepareGraphPatchReviewCodexPrompt({
    session: { graph: { path: "/review/comm" } }, prompt: "Review this exact change.",
  }), "Review this exact change.");
});

test("Review applies the size guard to follow-ups and live guidance", async (t) => {
  for (const live of [false, true]) {
    let sent;
    const receive = async ({ prompt }) => {
      sent = prompt;
      return { turn: { status: "completed" }, message: JSON.stringify({
        patchContext: { purpose: "Purpose", behaviorContract: "Contract" }, issues: [], coverage: {},
      }) };
    };
    const session = {
      aiEnabled: true, activity: [], issues: [], workingTreeDiffVersion: 0,
      graph: { checkout: "review", repository: "comm", path: "/review/comm" },
      status: live ? "reviewing" : "review", codexTurnId: live ? "active" : "",
      codexAgent: { threadId: "saved", client: { startTurn: receive, steerTurn: receive } },
    };
    const instruction = "Keep every part of this guidance: " + "y".repeat(1100000) + " END";
    await steerGraphPatchReviewSession({ session, instruction });
    for (let attempt = 0; !sent && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(sent);
    assert.ok(sent.length < 1048576);
    const filename = JSON.parse(sent.match(/saved at ("[^\n]+?")\./)[1]);
    t.after(() => rm(path.dirname(filename), { recursive: true, force: true }));
    assert.ok((await readFile(filename, "utf8")).includes(instruction));
  }
});

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
    runCommand: async (command) => {
      const { args, cmd } = command;

      calls.push(command);
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
      if (cmd === "git" && args[0] === "branch") {
        return "phab-D123456\n";
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
    { cmd: "moz-phab", args: ["patch", "D123456", "--raw", "--skip-dependencies", "--yes"], cwd: "/repo/review/comm" },
    { cmd: "moz-phab", args: ["patch", "D123456", "--apply-to", "here", "--yes"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["rev-parse", "HEAD"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["log", "-1", "--format=%B"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["branch", "--show-current"], cwd: "/repo/review/comm" },
    { cmd: "git", args: ["log", "--reverse", "--format=%H%x09%s", "main..HEAD"], cwd: "/repo/review/comm" },
  ]);
  assert.deepEqual(
    calls
      .filter(({ cmd }) => cmd === "moz-phab")
      .map(({ args, killProcessGroup, timeoutMs }) => ({
        args,
        killProcessGroup,
        timeoutMs,
      })),
    [
      {
        args: ["patch", "D123456", "--raw", "--skip-dependencies", "--yes"],
        killProcessGroup: true,
        timeoutMs: 90_000,
      },
      {
        args: ["patch", "D123456", "--apply-to", "here", "--yes"],
        killProcessGroup: true,
        timeoutMs: 90_000,
      },
    ],
  );
});

test("patch review selects the requested parent when moz-phab leaves a child at HEAD", async () => {
  const session = createGraphPatchReviewSession({ graphs: getReviewGraphs(), revision: "D323799", aiEnabled: false });
  const parent = "a".repeat(40);
  const child = "b".repeat(40);
  let head = child;
  const message = (id) => `Differential Revision: https://phabricator.services.mozilla.com/${id}\n`;
  await prepareGraphPatchReviewSession({
    session, getSnapshot: async () => ({}),
    makeTempDirectory: async () => "/tmp/review-fixture", writeRawPatch: async () => {},
    runCommand: async ({ cmd, args, cwd }) => {
      assert.equal(cwd, "/repo/review/comm");
      if (cmd === "moz-phab" && args.includes("--raw")) return "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n";
      if (cmd === "git" && args[0] === "rev-parse") return head;
      if (cmd === "git" && args[0] === "branch") return "phab-D324796_7";
      if (cmd === "git" && args.includes("--format=%H%x00%B%x00")) return `${child}\0${message("D324796")}\0\n${parent}\0${message("D323799")}\0\n`;
      if (cmd === "git" && args[0] === "log" && args[1] === "-1") return message(head === child ? "D324796" : "D323799");
      if (cmd === "git" && args.includes("--detach")) {
        assert.deepEqual(args, ["switch", "--detach", parent]);
        head = parent;
      }
      return "";
    },
  });
  assert.equal(session.status, "complete", session.error);
  assert.equal(session.currentHash, parent);
  assert.equal(session.reviewBranch, "");
});

test("resuming a review detects patch and discussion changes without discarding saved findings", async () => {
  const rawPatch = "diff --git a/a b/a\n";
  const session = { revision: "D123", rawPatchHash: createHash("sha256").update(rawPatch).digest("hex"), issues: [{ id: "keep" }] };
  let calls = 0;
  const getRevisionReview = async () => { calls++; return { rawPatch, revision: "D123", comments: [], inlineComments: [] }; };
  assert.equal(await refreshGraphPatchReviewContext({ session, getRevisionReview }), true);
  assert.equal(await refreshGraphPatchReviewContext({ session, getRevisionReview }), false);
  assert.equal(calls, 2);
  await assert.rejects(refreshGraphPatchReviewContext({ session, getRevisionReview: async () => ({ rawPatch: "changed" }) }), /new patch must be checked out and reviewed/);
  assert.deepEqual(session.issues, [{ id: "keep" }]);
});

test("patch review cancels an in-progress Review checkout pull", () => {
  const session = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "123456",
    aiEnabled: false,
  });
  let aborted = false;

  session.abortController.signal.addEventListener("abort", () => {
    aborted = true;
  });
  cancelGraphPatchReviewSession({ session });

  assert.equal(aborted, true);
  assert.equal(session.cancelled, true);
  assert.equal(session.status, "cancelled");
  assert.equal(session.message, "Review checkout session cancelled.");
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
      if (cmd === "git" && args[0] === "branch") {
        return "phab-D123456\n";
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
    ["patch", "D123456", "--raw", "--skip-dependencies", "--yes"],
    ["patch", "D123456", "--apply-to", "here", "--yes"],
    ["rebase", "--abort"],
    ["cherry-pick", "--abort"],
    ["merge", "--abort"],
    ["am", "--abort"],
    ["reset", "--hard"],
    ["clean", "-ffdx"],
    ["switch", "main"],
    ["patch", "D123456", "--skip-dependencies", "--apply-to", "here", "--yes"],
    ["rev-parse", "HEAD"],
    ["log", "-1", "--format=%B"],
    ["branch", "--show-current"],
    ["log", "--reverse", "--format=%H%x09%s", "main..HEAD"],
  ]);
  assert.match(session.output, /Parent patch stack could not be applied/);
});

test("patch review accepts moz-phab's branch identity when commits omit Differential Revision", async () => {
  const session = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "123456",
    aiEnabled: false,
  });

  await prepareGraphPatchReviewSession({
    session,
    getSnapshot: async () => ({ branch: "phab-D123456" }),
    makeTempDirectory: async () => "/tmp/tb-tools-review-branch-identity",
    writeRawPatch: async () => {},
    runCommand: async ({ args, cmd }) => {
      if (cmd === "moz-phab" && args.includes("--raw")) {
        return "diff --git a/mail/example.mjs b/mail/example.mjs\n@@ -1 +1 @@\n-old\n+new\n";
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return "abcdef123456\n";
      }
      if (cmd === "git" && args[0] === "log" && args.includes("--format=%B")) {
        return "Bug 123456 - Example\n";
      }
      if (cmd === "git" && args[0] === "branch") {
        return "phab-D123456\n";
      }
      return "";
    },
  });

  assert.equal(session.status, "complete");
  assert.equal(session.reviewBranch, "phab-D123456");
});

test("patch review serializes access to the shared Review checkout", async () => {
  let releaseFirstApply;
  const firstApplyStarted = new Promise((resolve) => {
    releaseFirstApply = resolve;
  });
  let allowFirstApply;
  const firstApplyFinished = new Promise((resolve) => {
    allowFirstApply = resolve;
  });
  const events = [];
  const first = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "111111",
    aiEnabled: false,
  });
  const second = createGraphPatchReviewSession({
    graphs: getReviewGraphs(),
    revision: "222222",
    aiEnabled: false,
  });
  const prepare = (session) => prepareGraphPatchReviewSession({
    session,
    getSnapshot: async () => ({ branch: `phab-${session.revision}` }),
    makeTempDirectory: async () => `/tmp/tb-tools-review-${session.revision}`,
    writeRawPatch: async () => {},
    runCommand: async ({ args, cmd }) => {
      events.push(`${session.revision}:${cmd}:${args[0]}`);
      if (cmd === "moz-phab" && args.includes("--raw")) {
        return "diff --git a/mail/example.mjs b/mail/example.mjs\n@@ -1 +1 @@\n-old\n+new\n";
      }
      if (cmd === "moz-phab" && !args.includes("--raw") && session === first) {
        releaseFirstApply();
        await firstApplyFinished;
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return "abcdef123456\n";
      }
      if (cmd === "git" && args[0] === "log" && args.includes("--format=%B")) {
        return `Bug ${session.revision.slice(1)} - Example\n`;
      }
      if (cmd === "git" && args[0] === "branch") {
        return `phab-${session.revision}\n`;
      }
      return "";
    },
  });
  const firstPreparation = prepare(first);

  await firstApplyStarted;
  const secondPreparation = prepare(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.startsWith("D222222:")), false);

  allowFirstApply();
  await Promise.all([firstPreparation, secondPreparation]);
  assert.equal(first.status, "complete");
  assert.equal(second.status, "complete");
  assert.ok(
    events.findIndex((event) => event === "D222222:git:rebase") >
      events.findIndex((event) => event === "D111111:git:branch"),
  );
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
      // The review action must normalize this stale old-side marker before it
      // reaches Phabricator.
      isNewFile: false,
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
    hasSuggestion: true,
    suggestionText: "cleanup();",
    commentText: "Please use the shared cleanup helper.",
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
    contextLineSide: "new",
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

test("patch review submits saved inline drafts with every final action", async () => {
  const cases = [
    ["accept", "", "accept"],
    ["request-changes", "Please address the focus regression.", "reject"],
    ["comment", "A final note.", "comment"],
  ];

  for (const [outcome, message, action] of cases) {
    const draftPublications = [];
    const finalActions = [];
    const session = {
      aiEnabled: true,
      revision: "D123456",
      currentIssueIndex: 0,
      issues: [{ id: "pending", state: "pending" }],
    };

    await submitGraphPatchReview({
      session,
      outcome,
      message,
      postComment: async (details) => draftPublications.push(details),
      editRevision: async (details) => finalActions.push(details),
    });

    assert.deepEqual(draftPublications, [{
      id: "D123456",
      message: "",
      action: "comment",
      resolve: true,
    }]);
    assert.deepEqual(finalActions, action !== "comment" || message
      ? [{ id: "D123456", message, action }]
      : []);
    assert.equal(session.status, "complete");
    assert.equal(session.reviewOutcome, outcome);
  }
});

test("patch review posts Request Changes through Conduit", async () => {
  const finalActions = [];
  const session = {
    aiEnabled: true,
    revision: "D123456",
    status: "review",
    currentIssueIndex: 0,
    issues: [],
  };

  await submitGraphPatchReview({
    session,
    outcome: "request-changes",
    message: "Please address the focus regression.",
    editRevision: async (details) => finalActions.push(details),
  });

  assert.deepEqual(finalActions, [{
    id: "D123456",
    message: "Please address the focus regression.",
    action: "reject",
  }]);
  assert.equal(session.reviewOutcome, "request-changes");
});

test("web review publication submits pending drafts and the final action in one operation", async () => {
  for (const outcome of ["accept", "request-changes", "comment"]) {
    const calls = [];
    const session = { aiEnabled: true, revision: "D123456", currentIssueIndex: 0,
      issues: [{ id: "pending", state: "pending" }] };
    await submitGraphPatchReview({
      session, outcome, message: "Reviewed.",
      publishReview: async (details) => calls.push(details),
      postComment: async () => assert.fail("Do not publish drafts through Conduit"),
      editRevision: async () => assert.fail("Do not publish the action through Conduit"),
    });
    assert.deepEqual(calls, [{ revision: "D123456", action: outcome === "request-changes" ? "reject" : outcome, message: "Reviewed." }]);
    assert.equal(session.status, "complete");
    assert.equal(session.issues[0].state, "posted");
  }
});

test("failed web publication leaves drafts pending and the review open", async () => {
  const session = { aiEnabled: true, revision: "D123456", currentIssueIndex: 0,
    issues: [{ id: "pending", state: "pending" }] };
  await assert.rejects(submitGraphPatchReview({
    session, outcome: "accept", message: "Reviewed.",
    publishReview: async () => { throw new Error("Unconfirmed submission"); },
    postComment: async () => assert.fail("No API fallback"),
  }), /Unconfirmed submission/);
  assert.equal(session.status, "review");
  assert.equal(session.issues[0].state, "pending");
});

test("patch review does not duplicate published drafts when the final action is retried", async () => {
  const draftPublications = [];
  const session = {
    aiEnabled: true,
    revision: "D123456",
    status: "review",
    currentIssueIndex: 0,
    issues: [{ id: "pending", state: "pending" }],
  };

  await assert.rejects(
    submitGraphPatchReview({
      session,
      outcome: "accept",
      postComment: async (details) => draftPublications.push(details),
      editRevision: async () => {
        throw new Error("The final action failed.");
      },
    }),
    /The final action failed/,
  );
  assert.deepEqual(draftPublications, [{
    id: "D123456",
    message: "",
    action: "comment",
    resolve: true,
  }]);
  assert.equal(session.issues[0].state, "posted");
  assert.match(session.message, /Saved inline drafts were published/);

  const finalActions = [];
  await submitGraphPatchReview({
    session,
    outcome: "accept",
    editRevision: async (details) => finalActions.push(details),
  });
  assert.deepEqual(draftPublications, [{
    id: "D123456",
    message: "",
    action: "comment",
    resolve: true,
  }]);
  assert.deepEqual(finalActions, [{
    id: "D123456",
    message: "",
    action: "accept",
  }]);
});

test("patch review requires an overall comment for a comment-only review", async () => {
  const session = {
    aiEnabled: true,
    revision: "D123456",
    status: "review",
    currentIssueIndex: 0,
    issues: [],
  };

  await assert.rejects(
    submitGraphPatchReview({
      session,
      outcome: "comment",
      message: "",
    }),
    /Enter an overall comment/,
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
  assert.match(prompt, /ASD-STE100 Simplified Technical English/);
  assert.match(prompt, /Reuse the existing hidden page for this revision/);
  assert.match(prompt, /Never use a visible browser as a fallback/);
  assert.match(prompt, /Do not open or reload a page just because a new comment or turn started/);
});

test("Patch Review applies ASD-STE100 rules to every Codex interaction", () => {
  const source = readFileSync(
    new URL("../commands/graph/patch-review.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.match(/ASD_STE100_SIMPLIFIED_TECHNICAL_ENGLISH/g)?.length,
    5,
  );
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

test("capacity retry sends the full review prompt in the saved conversation", async () => {
  let received;
  const session = {
    activity: [],
    codexSessionId: "saved-thread",
    codexAgent: { threadId: "saved-thread", client: { startTurn: async (args) => {
      received = args;
      return { turn: { status: "completed" }, message: JSON.stringify({
        patchContext: { purpose: "Enable the row action.", behaviorContract: "The toggle changes state." },
        issues: [], coverage: { summary: "No defects found." },
      }) };
    } } },
    commitMessage: "Bug 2061586 - Add a calendar row action.",
    currentHash: "review-head",
    graph: { checkout: "review", path: "/repo/review/comm", repository: "comm" },
    rawPatchPath: "/tmp/D330263.patch",
    rawPatchHash: "patch-hash",
    revision: "D330263",
    reviewDiscussion: { comments: [], inlineComments: [] },
    status: "error",
    error: "Selected model is at capacity. Please try a different model.",
    workingTreeDiffVersion: 0,
  };
  retryGraphPatchReviewSession({ session, runCommand: async () => "review-head\n" });
  assert.equal(session.status, "reviewing");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.threadId, "saved-thread");
  assert.equal(received.task, "review");
  assert.match(received.prompt, /Perform the full Thunderbird Phabricator patch review for D330263/);
  assert.equal(session.status, "review");
  assert.equal(session.error, "");
  assert.equal(session.workingTreeDiffVersion, 1);
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
