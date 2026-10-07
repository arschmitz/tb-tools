import { CODEX_MEMORY_ARGS } from "../commands/knowledge/instructions.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  resumeGraphPatchUpdateAssessment,
  createGraphPatchUpdateSession,
  applyGraphPatchUpdateComment,
  findGraphPatchCommit,
  filterGraphPatchUpdateHandledComments,
  followUpGraphPatchUpdateComment,
  getGraphCodexActivity,
  recordGraphPatchUpdateCodexNotification,
  recoverGraphPatchUpdateChange,
  runGraphPatchUpdateCodexTurn,
  steerGraphPatchUpdateSession,
  acceptGraphPatchUpdateChange,
  getGraphCodexExecArgs,
  getGraphPatchUpdateCodexThreadName,
  getGraphPatchUpdateMemoryContext,
  getGraphPatchUpdateWorkingTreeState,
  getGraphPatchUpdateFollowUpPrompt,
  getGraphPatchUpdateReviewPrompt,
  isGraphAiEnabled,
  normalizeGraphPatchUpdateProposedDiff,
  prepareGraphPatchUpdateSession,
  reviseGraphPatchUpdateChange,
  resolveGraphPatchUpdateWorkingCheckout,
  resolveGraphCodexCommand,
  saveGraphPatchUpdateReply,
  serializeGraphPatchUpdateSession,
} from "../commands/graph/patch-update.mjs";

test("end-of-list follow-ups answer questions and retain requested edits as candidates", async () => {
  for (const changed of [false, true]) {
    const session = {
      aiEnabled: true, graph: { path: "/work/comm", checkout: "working", repository: "comm" },
      revision: "D123456", codexSessionId: "saved", codexTurnId: "", status: "review",
      activity: [], items: [{ id: "done", state: "handled" }], currentItemIndex: 1,
    };
    let complete;
    const finished = new Promise(resolve => { complete = resolve; });
    let reads = 0;
    await steerGraphPatchUpdateSession({
      session, instruction: changed ? "Fix the missing cleanup." : "Were the checks run?",
      runFollowUp: async ({ prompt }) => {
        assert.match(prompt, /When the author requests changes, implement them/);
        assert.match(prompt, /For questions, inspect and answer without editing/);
        return { message: changed ? "Fixed cleanup. Focused test passed." : "No runtime tests were run." };
      },
      applyFollowUp: async (options) => {
        try {
          return await applyGraphPatchUpdateComment({ ...options,
            getWorkingTreeState: async () => ({ head: "abc", treeish: "base", untrackedPaths: [],
              rawDiff: reads++ && changed ? "+cleanup();" : "" }),
            getWorkingTreePatch: async () => "+cleanup();",
          });
        } finally { complete(); }
      },
    });
    await finished;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.items[0].state, "handled");
    assert.equal(session.status, "review");
    assert.equal(session.items[1].changeApplied, changed);
    assert.equal(session.items[1].state, changed ? "ready" : "handled");
    assert.equal(session.items[1].changeAccepted, false);
    assert.equal(Boolean(session.changeSnapshots?.has(session.items[1].id)), changed);
    assert.match(session.followUpAnswer, changed ? /Fixed cleanup/ : /No runtime tests/);
  }
});

test("Patch Update does not replace a thread with an active writer", async () => {
  let calls = 0;
  const session = { activity: [], codexSessionId: "busy-thread", codexTurnId: "" };
  await assert.rejects(runGraphPatchUpdateCodexTurn({ session, prompt: "Continue.",
    getAgent: async () => { calls++; return { threadId: "busy-thread", client: {
      startTurn: async () => { throw new Error("thread already has an active writer"); },
      close: () => assert.fail("Do not close the existing worker"),
    } }; },
  }), /active writer/);
  assert.equal(calls, 1);
  assert.equal(session.codexSessionId, "busy-thread");
});

for (const errorMessage of ["no rollout found for thread id saved-thread"]) {
  test(`Patch Update recovers from ${errorMessage}`, async () => {
    const session = { activity: [], codexSessionId: "saved-thread", codexTurnId: "",
      memoryContext: "Saved patch evidence", items: [{ id: "one", state: "handled" }] };
    let calls = 0;
    const result = await runGraphPatchUpdateCodexTurn({
      session,
      prompt: "Continue the assessment.",
      getAgent: async () => {
        if (++calls === 1) {
          throw new Error(errorMessage);
        }
        assert.equal(session.codexSessionId, "");
        assert.equal(session.codexAgent, null);
        return {
          threadId: "replacement",
          client: {
            async startTurn({ prompt, onTurnStarted }) {
              assert.equal(prompt, "Continue the assessment.");
              onTurnStarted("replacement-turn");
              return { message: "Assessment", turn: { status: "completed" } };
            },
          },
        };
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.sessionId, "replacement");
    assert.equal(session.codexTurnId, "");
    assert.equal(session.memoryContext, "Saved patch evidence");
    assert.deepEqual(session.items, [{ id: "one", state: "handled" }]);
    if (errorMessage.startsWith("no rollout")) {
      assert.match(session.activity.at(-1).title, /saved conversation is missing/);
    }
  });
}

test("Patch Update does not retry other connection errors or known active turns", async () => {
  for (const [message, turnId] of [
    ["Connection failed", ""],
    ["thread saved-thread already has an active turn", ""],
    ["thread saved-thread already has an active writer", ""],
    ["thread saved-thread already has an active turn", "known-turn"],
    ["thread saved-thread already has an active writer", "known-turn"],
    ["no rollout found for thread id saved-thread", "known-turn"],
    ["no rollout found for thread id unrelated-thread", ""],
  ]) {
    const session = { activity: [], codexSessionId: "saved-thread", codexTurnId: turnId };
    let calls = 0;
    const error = new Error(message);
    await assert.rejects(runGraphPatchUpdateCodexTurn({
      session,
      prompt: "Continue.",
      getAgent: async () => {
        calls++;
        throw error;
      },
    }), (actual) => actual === error);
    assert.equal(calls, 1);
    assert.equal(session.codexSessionId, "saved-thread");
  }
});

for (const message of ["thread saved-thread already has an active writer", "no rollout found for thread id saved-thread"]) {
  test(`Patch Update retries only once: ${message}`, async () => {
    const session = { activity: [], codexSessionId: "saved-thread", codexTurnId: "" };
    let calls = 0;
    await assert.rejects(runGraphPatchUpdateCodexTurn({
      session,
      prompt: "Continue.",
      getAgent: async () => {
        calls++;
        throw new Error(message);
      },
    }), (error) => error.message === message);
    assert.equal(calls, message.includes("active writer") ? 1 : 2);
    assert.equal(session.codexTurnId, "");
  });
}

test("late Codex events keep the failure reason and still record activity", () => {
  const error = "Selected model is at capacity. Please try a different model.";
  const session = { activity: [], status: "error", error, message: error };
  for (const notification of [
    { method: "item/completed", params: { item: {
      type: "commandExecution", command: "git status", exitCode: 0,
    } } },
    { method: "item/agentMessage/delta", params: {
      turnId: "turn", itemId: "note", delta: "The command finished.",
    } },
    { method: "item/completed", params: { turnId: "turn", item: {
      id: "note", type: "agentMessage", text: "The command finished.",
    } } },
    { method: "turn/completed", params: {} },
  ]) {
    recordGraphPatchUpdateCodexNotification(session, notification);
    assert.equal(session.message, error);
    assert.equal(session.error, error);
    assert.equal(session.status, "error");
  }
  assert.equal(session.activity.length, 3);
  assert.equal(session.activity[0].title, "Command completed");
  assert.equal(session.activity[1].detail, "The command finished.");
});

test("Update streams public notes and keeps them after many commands", () => {
  const session = { activity: [] };
  const send = (method, params) => recordGraphPatchUpdateCodexNotification(session, { method, params });
  send("item/agentMessage/delta", { turnId: "turn", itemId: "note", delta: "I checked " });
  send("item/agentMessage/delta", { turnId: "turn", itemId: "note", delta: "the test." });
  assert.equal(session.activity[0].detail, "I checked the test.");
  send("item/completed", { turnId: "turn", item: { id: "note", type: "agentMessage", text: "I checked the test." } });
  assert.equal(session.activity.length, 1);
  for (let index = 0; index < 250; index++) {
    send("item/started", { item: { type: "commandExecution", command: `command ${index}` } });
  }
  assert.equal(session.activity.filter((entry) => entry.kind === "note").length, 1);
  assert.equal(session.activity.length, 201);
  send("item/reasoning/textDelta", { delta: "Private reasoning" });
  assert.equal(session.activity.some((entry) => entry.detail.includes("Private reasoning")), false);
});

test("resume recovers an interrupted source change without another Codex turn", async () => {
  const before = { head: "abc", untrackedPaths: [], rawDiff: "", treeish: "base" };
  const after = { head: "abc", untrackedPaths: [], rawDiff: "recovered diff", treeish: "edit" };
  const session = {
    graph: { path: "/work/comm" }, pendingChange: { itemId: "one", before },
    items: [{ id: "one", state: "applying" }], status: "applying",
  };
  assert.equal(await recoverGraphPatchUpdateChange({
    session, getWorkingTreeState: async () => after, getWorkingTreePatch: async () => "recovered diff",
  }), true);
  assert.equal(session.status, "review");
  assert.equal(session.items[0].changeApplied, true);
  assert.equal(session.workingDiff, "recovered diff");
  assert.deepEqual(session.changeSnapshots.get("one").before, before);
  assert.match(session.message, /may be incomplete/);
  assert.equal(session.pendingChange, null);
});

test("amending a candidate returns the same comment to ready with no pending edits", async () => {
  const before = { head: "abc", rawDiff: "", untrackedPaths: [] };
  const after = { head: "abc", rawDiff: "source change", untrackedPaths: [] };
  const item = { id: "one", state: "applying", changeApplied: true, suggestedReply: "My reply" };
  const session = {
    graph: { path: "/work/comm", repository: "comm", checkout: "working" },
    items: [item], currentHash: "abc", activity: [], status: "review", aiEnabled: true,
    pendingChange: { itemId: "one", before },
    changeSnapshots: new Map([["one", { before, after, patch: "source change" }]]),
  };
  let amended = false;
  await acceptGraphPatchUpdateChange({
    session, itemId: "one", runCommand: async () => "",
    getCurrentCommit: async () => ({ hash: "abc" }),
    getWorkingTreeState: async () => amended ? { ...before, head: "def" } : after,
    amendCurrent: async () => { amended = true; return { currentHash: "def" }; },
  });
  assert.equal(item.state, "ready");
  assert.equal(item.changesAmended, true);
  assert.equal(item.changeApplied, false);
  assert.equal(item.suggestedReply, "My reply");
  assert.equal(session.pendingChange, null);
  assert.equal(session.changeSnapshots.size, 0);
  assert.equal(session.currentHash, "def");
});

test("patch update normalizes a fenced unified diff for the preview renderer", () => {
  const diff = normalizeGraphPatchUpdateProposedDiff([
    "```diff",
    "--- a/mail/base/content/example.js",
    "+++ b/mail/base/content/example.js",
    "@@ -1 +1 @@",
    "-const local = true;",
    "+const shared = true;",
    "```",
  ].join("\n"));

  assert.equal(diff, [
    "diff --git a/mail/base/content/example.js b/mail/base/content/example.js",
    "--- a/mail/base/content/example.js",
    "+++ b/mail/base/content/example.js",
    "@@ -1 +1 @@",
    "-const local = true;",
    "+const shared = true;",
  ].join("\n"));
});

test("AI patch updating requires the explicit local config gate", () => {
  assert.equal(isGraphAiEnabled({}), false);
  assert.equal(isGraphAiEnabled({ ai: {} }), false);
  assert.equal(isGraphAiEnabled({ ai: { enabled: false } }), false);
  assert.equal(isGraphAiEnabled({ ai: { enabled: true } }), true);
});

test("Patch Update gives its Codex chat a revision and local start time", () => {
  const now = new Date(2026, 8, 8, 14, 37);
  const graph = {
    checkout: "working",
    path: "/work/comm",
    repository: "comm",
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: true,
    graph,
    graphIndex: 0,
    now,
    revision: "320328",
  });

  assert.equal(
    getGraphPatchUpdateCodexThreadName({ revision: "D320328", now }),
    "D320328 - Review Update 2026-09-08 14:37",
  );
  assert.equal(session.codexThreadName, "D320328 - Review Update 2026-09-08 14:37");
});

test("Patch Update captures an invisible working-tree snapshot for a candidate", async () => {
  const calls = [];
  const state = await getGraphPatchUpdateWorkingTreeState({
    graph: { path: "/work/comm" },
    getWorkingDiff: async ({ fullFile }) => {
      assert.equal(fullFile, true);
      return "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
    },
    runCommand: async ({ args }) => {
      calls.push(args);

      if (args[0] === "rev-parse") {
        return "head123\n";
      }
      if (args[0] === "stash") {
        return "snapshot456\n";
      }
      if (args[0] === "ls-files") {
        return "new-file.js\0";
      }

      assert.fail(`Unexpected Git command: ${args.join(" ")}`);
    },
  });

  assert.equal(state.head, "head123");
  assert.equal(state.treeish, "snapshot456");
  assert.deepEqual(state.untrackedPaths, ["new-file.js"]);
  assert.match(state.rawDiff, /diff --git/);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["rev-parse", "HEAD"],
    ["stash", "create"],
    ["ls-files", "--others"],
  ]);
});

test("Patch Update prepares a recommended source change only when explicitly requested", async () => {
  const item = {
    assessment: "The focused source update is required.",
    changeSummary: "Use the shared helper.",
    id: "inline:1",
    requiresChanges: true,
    state: "ready",
  };
  const session = {
    aiEnabled: true,
    codexSessionId: "thread-1",
    graph: { checkout: "working", path: "/work/comm", repository: "comm" },
    items: [item],
    revision: "D123456",
  };
  const before = {
    head: "abc123",
    rawDiff: "",
    treeish: "before",
    untrackedPaths: [],
  };
  const after = {
    head: "abc123",
    rawDiff: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
    treeish: "after",
    untrackedPaths: [],
  };
  let stateReadCount = 0;

  await applyGraphPatchUpdateComment({
    session,
    itemId: item.id,
    getWorkingTreePatch: async () => after.rawDiff,
    getWorkingTreeState: async () => (
      stateReadCount++ ? after : before
    ),
    runCodexTask: async () => ({ message: "Updated the source and ran the focused test." }),
    runCommand: async () => "",
  });

  assert.equal(item.changeApplied, true);
  assert.equal(item.changeAccepted, false);
  assert.match(item.workingDiff, /diff --git/);
  assert.match(session.workingDiff, /diff --git/);
});

test("Patch Update prepares a source change when Codex marks the recommendation as change", async () => {
  const item = {
    assessment: "The focused source update is required.",
    changeSummary: "Use the shared helper.",
    id: "inline:recommendation-change",
    recommendation: "change",
    requiresChanges: "true",
    state: "ready",
  };
  const session = {
    aiEnabled: true,
    codexSessionId: "thread-1",
    graph: { checkout: "working", path: "/work/comm", repository: "comm" },
    items: [item],
    revision: "D123456",
  };
  const before = { head: "abc123", rawDiff: "", treeish: "before", untrackedPaths: [] };
  const after = {
    head: "abc123",
    rawDiff: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
    treeish: "after",
    untrackedPaths: [],
  };
  let stateReadCount = 0;

  await applyGraphPatchUpdateComment({
    session,
    itemId: item.id,
    getWorkingTreePatch: async () => after.rawDiff,
    getWorkingTreeState: async () => (stateReadCount++ ? after : before),
    runCodexTask: async () => ({ message: "Changed the source." }),
    runCommand: async () => "",
  });

  assert.equal(item.changeApplied, true);
  assert.match(item.workingDiff, /\+new/);
});

test("Patch Update revises the same uncommitted candidate after author feedback", async () => {
  const before = { head: "abc123", rawDiff: "", treeish: "before", untrackedPaths: [] };
  const candidate = {
    head: "abc123",
    rawDiff: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+first\n",
    treeish: "candidate",
    untrackedPaths: [],
  };
  const revised = {
    head: "abc123",
    rawDiff: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+revised\n",
    treeish: "revised",
    untrackedPaths: [],
  };
  const item = {
    assessment: "The source needs a focused change.",
    changeApplied: true,
    changeReverted: false,
    id: "inline:1",
    state: "ready",
  };
  const session = {
    activity: [],
    aiEnabled: true,
    changeSnapshots: new Map([[item.id, {
      addedUntrackedPaths: [], after: candidate, before, patch: candidate.rawDiff,
    }]]),
    codexSessionId: "thread-1",
    graph: { checkout: "working", path: "/work/comm", repository: "comm" },
    items: [item],
    patchContext: { behaviorContract: "Keep the focused behavior.", purpose: "Preserve the contract." },
    revision: "D123456",
    status: "review",
  };
  let reads = 0;

  await reviseGraphPatchUpdateChange({
    session,
    itemId: item.id,
    instruction: "Keep the source helper, but update the test name.",
    getWorkingTreePatch: async () => revised.rawDiff,
    getWorkingTreeState: async () => (reads++ ? revised : candidate),
    runCodexTask: async () => ({ message: "Updated the test name and ran the focused test." }),
    runCommand: async () => "",
    saveMemory: async () => {},
  });

  assert.equal(item.changeApplied, true);
  assert.match(item.workingDiff, /\+revised/);
  assert.equal(session.changeSnapshots.get(item.id).after, revised);
  assert.match(session.message, /updated the working-tree change/i);
});

test("Patch Update assessment does not edit the working tree", async () => {
  const graph = {
    checkout: "working",
    knownHashes: new Set(),
    path: "/work/comm",
    repository: "comm",
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: true,
    graph,
    graphIndex: 0,
    revision: "D123456",
  });
  let codexCalls = 0;
  let reviewForce;
  session.refreshAfterCheckoutUpdate = true;

  await prepareGraphPatchUpdateSession({
    session,
    graphs: [graph],
    findPatchCommit: async () => ({
      hash: "original123",
      message: "Bug 123456 - Update the source\nDifferential Revision: https://phabricator.services.mozilla.com/D123456",
    }),
    assertSafeWorktree: async () => {},
    getRustUpstreamStatus: async () => ({ state: "current", upToDate: true }),
    updateCheckout: async () => ({ output: "Updated main." }),
    rebasePatch: async () => ({
      base: "main123",
      currentHash: "rewritten123",
      rewrittenCommits: [{ hash: "rewritten123", originalHash: "original123" }],
    }),
    checkoutPatch: async () => ({ branch: "Bug-123456" }),
    getSnapshot: async () => ({ commits: [] }),
    getReview: async ({ force }) => {
      reviewForce = force;
      return {
      available: true,
      inlineComments: [{
        content: "Use the shared helper.",
        id: "inline:1",
        lineNumber: 1,
      }],
      };
    },
    getHandledCommentIds: async () => new Set(),
    getWorkingTreePatch: async () => assert.fail("assessment must not prepare a source patch"),
    getWorkingTreeState: async () => assert.fail("assessment must not inspect a source candidate"),
    runCodexTask: async () => {
      codexCalls++;
      return {
        message: JSON.stringify({
          comments: [{
            assessment: "The source should use the shared helper.",
            changeSummary: "Replace the local helper call.",
            id: "inline:inline:1",
            rationale: "The shared helper owns this lifecycle.",
            recommendation: "change",
            requiresChanges: "true",
            suggestedReply: "I will use the shared helper.",
            validation: "Inspected the affected source.",
          }],
          patchContext: {
            behaviorContract: "The focused behavior remains covered.",
            evidence: "The source currently uses a local helper.",
            purpose: "Preserve the lifecycle behavior.",
            stackContext: "This patch is a standalone update.",
            validation: "A focused test should be run after the edit.",
          },
        }),
        sessionId: "codex-thread",
      };
    },
    runCommand: async () => "",
  });

  assert.equal(codexCalls, 1);
  assert.equal(reviewForce, true);
  assert.equal(session.baseHash, "main123");
  assert.equal(session.items[0].changeApplied, false);
  assert.equal(session.workingDiff, "");
  assert.match(session.message, /reviewed all 1 new comment/i);
});

test("Codex command resolution supports an override and the macOS app fallback", async () => {
  const configured = await resolveGraphCodexCommand({
    configuredCommand: "/tools/codex",
    accessFile: async (candidate) => {
      assert.equal(candidate, "/tools/codex");
    },
  });
  const fallback = await resolveGraphCodexCommand({
    env: { PATH: "/missing" },
    platform: "darwin",
    accessFile: async (candidate) => {
      if (candidate !== "/Applications/ChatGPT.app/Contents/Resources/codex") {
        throw new Error("missing");
      }
    },
  });

  assert.equal(configured, "/tools/codex");
  assert.equal(fallback, "/Applications/ChatGPT.app/Contents/Resources/codex");
});

test("Codex command resolution finds the current app bundle without a shell PATH", async () => {
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  const resolved = await resolveGraphCodexCommand({
    env: { PATH: "/usr/bin:/bin" }, platform: "darwin",
    accessFile: async candidate => { if (candidate !== bundled) throw new Error("missing"); },
  });
  assert.equal(resolved, bundled);
});

test("Codex patch updates use a full-access noninteractive invocation", () => {
  const args = getGraphCodexExecArgs({
    session: { codexSessionId: "", graph: { path: "/work/comm" } },
    prompt: "Review this patch.",
  });

  assert.deepEqual(args, [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "-C",
    "/work/comm",
    ...CODEX_MEMORY_ARGS,
    "Review this patch.",
  ]);
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--approve-for-me"), false);
});

test("Codex patch updates use standalone knowledge and disable native memory", () => {
  const args = getGraphCodexExecArgs({
    memoryDirectory: "/Users/example/.tb-tools/knowledge",
    session: { codexSessionId: "", graph: { path: "/work/comm" } },
    prompt: "Review this patch.",
  });

  assert.deepEqual(args.slice(-3), [
    "--add-dir",
    "/Users/example/.tb-tools/knowledge",
    "Review this patch.",
  ]);

  assert.deepEqual(
    getGraphCodexExecArgs({
      memoryDirectory: "/Users/example/.tb-tools/knowledge",
      session: { codexSessionId: "existing-session", graph: { path: "/work/comm" } },
      prompt: "Apply the selected change.",
    }),
    [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      ...CODEX_MEMORY_ARGS,
      "existing-session",
      "Apply the selected change.",
    ],
  );
});

test("author patch-update prompts establish purpose before assessing comments", () => {
  const prompt = getGraphPatchUpdateReviewPrompt({
    revision: "D123456",
    currentHash: "abc123",
    commitMessage: "Bug 123456 - Fix the thing",
    descendantBranches: ["Bug-2061188", "Bug-2061192"],
    graph: { path: "/work/comm" },
    items: [{
      id: "comment:1",
      author: "Reviewer",
      content: "Please use the shared helper.",
    }],
  });

  assert.match(prompt, /continuing the author's own Thunderbird implementation/i);
  assert.match(prompt, /Do not invoke, read, or follow the thunderbird-patch-review skill/i);
  assert.match(prompt, /patchContext before evaluating comments/i);
  assert.match(prompt, /targeted tb knowledge search/);
  assert.doesNotMatch(prompt, /\.codex\/memories/);
  assert.match(prompt, /Current patch commit: abc123/);
  assert.match(prompt, /Bug 123456 - Fix the thing/);
  assert.match(prompt, /Each descendant branch was replayed onto the rewritten selected commit/);
  assert.match(prompt, /Their commits were replayed only to preserve the branch topology/);
  assert.match(prompt, /Bug-2061188, Bug-2061192/);
  assert.match(prompt, /ASD-STE100 Simplified Technical English/);
  assert.match(prompt, /Reuse the existing hidden page for this revision/);
  assert.match(prompt, /Never use a visible browser as a fallback/);

  const refreshedPrompt = getGraphPatchUpdateReviewPrompt({
    revision: "D123456",
    currentHash: "def456",
    commitMessage: "Bug 123456 - Fix the thing",
    graph: { path: "/work/comm" },
    refreshAfterCheckoutUpdate: true,
    items: [{
      id: "comment:1",
      author: "Reviewer",
      content: "Please use the shared helper.",
    }],
  });

  assert.match(refreshedPrompt, /resuming after the local checkout changed/i);
  assert.match(refreshedPrompt, /re-evaluate every listed comment/i);

  const promptWithMemory = getGraphPatchUpdateReviewPrompt({
    revision: "D123456",
    currentHash: "abc123",
    commitMessage: "Bug 123456 - Fix the thing",
    graph: { path: "/work/comm" },
    memoryContext: "Shared Thunderbird history for the affected test.",
    items: [{
      id: "comment:1",
      author: "Reviewer",
      content: "Please use the shared helper.",
    }],
  });

  assert.match(promptWithMemory, /Shared Thunderbird history for the affected test/);
});

test("patch update reads only standalone patch histories", async () => {
  const files = new Map([
    ["/knowledge/private/legacy-patch-history/tb-tools-patch-d123456.md", "Imported review decision."],
    ["/knowledge/private/patch-history/tb-tools-patch-d123456.md", "Current review result."],
  ]);
  const reads = [];
  const context = await getGraphPatchUpdateMemoryContext({
    memoryDirectory: "/knowledge", revision: "D123456",
    readMemoryFile: async file => { reads.push(file); return files.get(file) || ""; },
  });
  assert.deepEqual(reads, [...files.keys()]);
  assert.match(context, /Imported review decision/);
  assert.match(context, /Current review result/);
});

test("Patch Update keeps full history until the final prompt budget is known", async () => {
  const context = await getGraphPatchUpdateMemoryContext({
    memoryDirectory: "/knowledge", revision: "D321284",
    readMemoryFile: async file => file.includes("legacy-patch-history") ? "Original purpose" :
      "older history\n".repeat(120000) + "Most recent result",
  });
  assert.ok(context.length > 1048576);
  assert.match(context, /Original purpose/);
  assert.match(context, /Most recent result/);
  assert.ok(context.includes("/knowledge/private/patch-history/tb-tools-patch-d321284.md"));
});

test("Patch Update routes oversized distinct history to files without dropping review comments", () => {
  const session = {
    graph: { path: "/work/comm" }, revision: "D321284", currentHash: "abc",
    memoryContext: "Original purpose\n" + "saved history\n".repeat(120000) + "Latest result",
    items: [{ id: "comment-one", author: "Reviewer", content: "Keep this feedback.",
      codeSuggestion: "Keep this code suggestion." }],
  };
  const prompt = getGraphPatchUpdateReviewPrompt(session);
  assert.ok(prompt.length < 1048576 - 4096);
  assert.match(prompt, /Read the full history from/);
  assert.doesNotMatch(prompt, /History excerpt shortened/);
  assert.match(prompt, /tb-tools-patch-d321284\.md/);
  assert.match(prompt, /Comment ID: comment-one/);
  assert.match(prompt, /Keep this feedback/);
  assert.match(prompt, /Keep this code suggestion/);
  assert.ok(session.memoryContext.length > 1048576);
});

test("Codex activity shows useful execution events without structured review output", () => {
  assert.deepEqual(
    getGraphCodexActivity({
      type: "item.started",
      item: { type: "command_execution", command: "git status --short" },
    }),
    {
      kind: "command",
      title: "Running command",
      detail: "git status --short",
    },
  );
  assert.deepEqual(
    getGraphCodexActivity({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "../mach test path/to/test.js",
        aggregated_output: "0 failures",
        exit_code: 0,
      },
    }),
    {
      kind: "command",
      title: "Command completed",
      detail: "../mach test path/to/test.js\n\n0 failures",
    },
  );
  assert.deepEqual(
    getGraphCodexActivity({
      type: "item.completed",
      item: { type: "reasoning" },
    }),
    { kind: "reasoning", title: "Completed an author update step" },
  );
  assert.equal(
    getGraphCodexActivity({
      type: "item.completed",
      item: { type: "agent_message", text: '{"comments":[]}' },
    }),
    null,
  );
  assert.deepEqual(
    getGraphCodexActivity({
      type: "item.completed",
      item: { type: "command_execution", command: "rg -n missing path", exit_code: 1 },
    }),
    {
      kind: "command",
      title: "Command completed with no matches",
      detail: "rg -n missing path",
    },
  );
});

test("patch update follow-up prompts retain the comment context without editing source", () => {
  const prompt = getGraphPatchUpdateFollowUpPrompt({
    session: { revision: "D123456" },
    item: {
      id: "inline:42",
      content: "Please use the shared helper.",
      assessment: "The shared helper is appropriate here.",
      rationale: "It owns the common lifecycle.",
      suggestedReply: "I will use the shared helper.",
      filePath: "mail/base/content/example.js",
      lineNumber: 42,
    },
    instruction: "Please reconsider whether the helper covers this case.",
  });

  assert.match(prompt, /Please use the shared helper/);
  assert.match(prompt, /Please reconsider whether the helper covers this case/);
  assert.match(prompt, /Do not modify files, Git state/);
  assert.match(prompt, /Return only one JSON object with a comment object/);
  assert.match(prompt, /Reuse the existing hidden page for this revision/);
  assert.match(prompt, /Do not open or reload a page just because a new comment or turn started/);
  assert.match(prompt, /ASD-STE100 Simplified Technical English/);
});

test("Patch Update applies ASD-STE100 rules to every Codex interaction", () => {
  const source = readFileSync(
    new URL("../commands/graph/patch-update.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.match(/ASD_STE100_SIMPLIFIED_TECHNICAL_ENGLISH/g)?.length,
    10,
  );
});

test("patch update filters only previously handled review comments", () => {
  const items = [
    { id: "inline:100" },
    { id: "comment:200" },
    { id: "inline:300" },
  ];

  assert.deepEqual(
    filterGraphPatchUpdateHandledComments(items, new Set(["inline:100", "comment:200"])),
    [{ id: "inline:300" }],
  );
});

test("patch update feedback revises the current recommendation in the same Codex session", async () => {
  const session = {
    aiEnabled: true,
    codexSessionId: "codex-session",
    revision: "D123456",
    status: "review",
    message: "",
    activity: [],
    items: [{
      id: "comment:1",
      state: "ready",
      content: "Please use the shared helper.",
      assessment: "The helper is optional.",
      rationale: "The existing behavior works.",
      suggestedReply: "I do not think this is necessary.",
      recommendation: "discussion",
      requiresChanges: false,
      changeSummary: "",
    }],
  };
  let prompt = "";
  let savedEvent = "";

  await followUpGraphPatchUpdateComment({
    session,
    itemId: "comment:1",
    instruction: "Please reconsider the shared helper requirement.",
    runCommand: async () => "",
    runCodexTask: async ({ prompt: value }) => {
      prompt = value;
      return {
        sessionId: "codex-session",
        message: JSON.stringify({
          comment: {
            id: "comment:1",
            recommendation: "change",
            assessment: "The shared helper should be used.",
            rationale: "It centralizes the required lifecycle.",
            validation: "Inspected the shared helper and ran the focused unit test successfully.",
            suggestedReply: "I will update this to use the shared helper.",
            requiresChanges: true,
            changeSummary: "Replace the local lifecycle code with the shared helper.",
          },
        }),
      };
    },
    saveMemory: async ({ event }) => {
      savedEvent = event;
    },
  });

  assert.match(prompt, /Please reconsider the shared helper requirement/);
  assert.equal(session.status, "review");
  assert.equal(session.items[0].recommendation, "change");
  assert.equal(session.items[0].requiresChanges, true);
  assert.match(session.items[0].validation, /focused unit test/);
  assert.match(session.items[0].changeSummary, /shared helper/);
  assert.equal("hasProposedDiff" in session.items[0], false);
  assert.equal(session.items[0].state, "ready");
  assert.equal(session.items[0].instruction, "");
  assert.match(session.message, /updated its recommendation/);
  assert.match(savedEvent, /reviewed user feedback/);
});

test("patch update feedback accepts the full-review comments array response shape", async () => {
  const session = {
    aiEnabled: true,
    codexSessionId: "codex-session",
    revision: "D123456",
    status: "review",
    message: "",
    activity: [],
    items: [{
      id: "comment:1",
      state: "ready",
      content: "Please use the shared helper.",
      assessment: "The helper is optional.",
      rationale: "The existing behavior works.",
      suggestedReply: "I do not think this is necessary.",
      recommendation: "discussion",
      requiresChanges: false,
      changeSummary: "",
    }],
  };

  await followUpGraphPatchUpdateComment({
    session,
    itemId: "comment:1",
    instruction: "Please verify the behavior before agreeing.",
    runCommand: async () => "",
    runCodexTask: async () => ({
      sessionId: "codex-session",
      message: JSON.stringify({
        comments: [{
          id: "comment:1",
          recommendation: "discussion",
          assessment: "The behavior needs focused validation.",
          rationale: "The existing test still covers the code path.",
          validation: "Inspected the test; a focused run is still needed.",
          suggestedReply: "I am validating the existing behavior before changing this.",
          requiresChanges: false,
          changeSummary: "",
          proposedDiff: "",
        }],
      }),
    }),
  });

  assert.equal(session.items[0].recommendation, "discussion");
  assert.match(session.items[0].validation, /focused run/);
});

test("patch update renders structured Codex validation as readable text", async () => {
  const session = {
    aiEnabled: true,
    codexSessionId: "codex-session",
    revision: "D123456",
    status: "review",
    message: "",
    activity: [],
    items: [{
      id: "comment:1",
      state: "ready",
      content: "Please verify the test.",
      assessment: "The test needs review.",
      rationale: "The reviewer raised a behavior question.",
      suggestedReply: "I will verify it.",
      recommendation: "discussion",
      requiresChanges: false,
      changeSummary: "",
    }],
  };

  await followUpGraphPatchUpdateComment({
    session,
    itemId: "comment:1",
    instruction: "Show the validation clearly.",
    runCommand: async () => "",
    runCodexTask: async () => ({
      sessionId: "codex-session",
      message: JSON.stringify({
        comment: {
          id: "comment:1",
          recommendation: "reply",
          assessment: "The existing test covers this behavior.",
          rationale: "The relevant assertion remains active.",
          validation: {
            command: "../mach test mail/base/test/browser/browser_example.js",
            outcome: "passed",
          },
          suggestedReply: "The focused test passes with the current behavior.",
          requiresChanges: false,
          changeSummary: "",
          proposedDiff: "",
        },
      }),
    }),
  });

  assert.equal(
    session.items[0].validation,
    "command: ../mach test mail/base/test/browser/browser_example.js\noutcome: passed",
  );
  assert.doesNotMatch(session.items[0].validation, /\[object Object\]/);
});

test("patch update feedback retries a prose response before surfacing an error", async () => {
  const session = {
    aiEnabled: true,
    codexSessionId: "codex-session",
    revision: "D123456",
    status: "review",
    message: "",
    activity: [],
    items: [{
      id: "comment:1",
      state: "ready",
      content: "Please verify the test.",
      assessment: "The test needs review.",
      rationale: "The reviewer raised a behavior question.",
      suggestedReply: "I will verify it.",
      recommendation: "discussion",
      requiresChanges: false,
      changeSummary: "",
    }],
  };
  let calls = 0;

  await followUpGraphPatchUpdateComment({
    session,
    itemId: "comment:1",
    instruction: "Run the focused test before deciding.",
    runCommand: async () => "",
    runCodexTask: async () => {
      calls += 1;

      if (calls === 1) {
        return { sessionId: "codex-session", message: "I will check that now." };
      }

      return {
        sessionId: "codex-session",
        message: JSON.stringify({
          comment: {
            id: "comment:1",
            recommendation: "reply",
            assessment: "The focused test confirms the behavior.",
            rationale: "The test exercises the reviewed path.",
            validation: "../mach test path/to/test.js passed.",
            suggestedReply: "I verified the existing behavior with the focused test.",
            requiresChanges: false,
            changeSummary: "",
            proposedDiff: "",
          },
        }),
      };
    },
  });

  assert.equal(calls, 2);
  assert.match(session.items[0].validation, /mach test/);
});

test("patch update keeps its rewritten commit addressable after refreshing the graph", () => {
  const source = readFileSync(
    new URL("../commands/graph/patch-update.mjs", import.meta.url),
    "utf8",
  );
  const snapshot = source.indexOf("session.snapshot = await getSnapshot(");
  const preserveHash = source.indexOf(
    "session.graph.knownHashes.add(session.currentHash);",
    snapshot,
  );

  assert.ok(snapshot >= 0);
  assert.ok(preserveHash > snapshot);
});

test("patch update sessions do not expose their graph object to the browser", () => {
  const graph = { label: "comm", path: "/work/comm" };
  const session = createGraphPatchUpdateSession({
    aiEnabled: true,
    graph,
    graphIndex: 0,
    revision: "123456",
  });
  const serialized = serializeGraphPatchUpdateSession(session);

  assert.equal(serialized.revision, "D123456");
  assert.equal(serialized.aiEnabled, true);
  assert.deepEqual(serialized.activity, []);
  assert.equal(serialized.patchContext, null);
  assert.equal(Object.hasOwn(serialized, "graph"), false);
});

test("patch update resolves the working comm checkout and excludes review clones", () => {
  const workingComm = {
    checkout: "working",
    repository: "comm",
    path: "/work/comm",
  };
  const workingFirefox = {
    checkout: "working",
    repository: "firefox",
    path: "/work/firefox",
  };
  const reviewComm = {
    checkout: "review",
    repository: "comm",
    path: "/review/comm",
  };
  const reviewFirefox = {
    checkout: "review",
    repository: "firefox",
    path: "/review/firefox",
  };

  const checkout = resolveGraphPatchUpdateWorkingCheckout({
    graphs: [workingComm, workingFirefox, reviewComm, reviewFirefox],
  });

  assert.equal(checkout.graph, workingComm);
  assert.equal(checkout.graphIndex, 0);
  assert.deepEqual(checkout.graphs, [workingComm, workingFirefox]);
  assert.throws(
    () => createGraphPatchUpdateSession({
      aiEnabled: false,
      graph: reviewComm,
      graphIndex: 2,
      revision: "D123456",
    }),
    /working comm checkout/i,
  );
});

test("patch update refuses a review session before executing Git commands", async () => {
  const workingComm = {
    checkout: "working",
    repository: "comm",
    path: "/work/comm",
    knownHashes: new Set(),
  };
  const reviewComm = {
    checkout: "review",
    repository: "comm",
    path: "/review/comm",
    knownHashes: new Set(),
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: false,
    graph: workingComm,
    graphIndex: 0,
    revision: "D123456",
  });
  let findCalls = 0;

  session.graph = reviewComm;
  session.graphIndex = 1;
  await assert.rejects(
    prepareGraphPatchUpdateSession({
      session,
      graphs: [workingComm, reviewComm],
      findPatchCommit: async () => {
        findCalls++;
      },
      runCommand: async () => "",
    }),
    /working comm checkout/i,
  );

  assert.equal(findCalls, 0);
  assert.equal(session.status, "error");
});

test("patch update keeps the command log when checkout update fails", async () => {
  const graph = {
    checkout: "working", repository: "comm", path: "/work/comm", knownHashes: new Set(),
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: false, graph, graphIndex: 0, revision: "D123456",
  });
  const error = Object.assign(new Error("fatal: Not a valid object name"), {
    output: "$ git merge-base --is-ancestor local-hash ''\nfatal: Not a valid object name\n",
    stderr: "fatal: Not a valid object name\n",
  });
  await assert.rejects(prepareGraphPatchUpdateSession({
    session,
    graphs: [graph],
    findPatchCommit: async () => ({ hash: "selected-original", message: "Patch" }),
    assertSafeWorktree: async () => {},
    getRustUpstreamStatus: async () => ({ state: "current" }),
    updateCheckout: async () => { throw error; },
    runCommand: async () => "",
  }), (caught) => caught === error);
  assert.equal(session.output, error.output);
  assert.equal(session.status, "error");
});

test("patch update only checks and updates the working checkout pair", async () => {
  const workingComm = {
    checkout: "working",
    repository: "comm",
    path: "/work/comm",
    knownHashes: new Set(),
  };
  const workingFirefox = {
    checkout: "working",
    repository: "firefox",
    path: "/work/firefox",
    knownHashes: new Set(),
  };
  const reviewComm = {
    checkout: "review",
    repository: "comm",
    path: "/review/comm",
    knownHashes: new Set(),
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: false,
    graph: workingComm,
    graphIndex: 0,
    revision: "D123456",
  });
  const observed = [];

  await prepareGraphPatchUpdateSession({
    session,
    graphs: [workingComm, workingFirefox, reviewComm],
    findPatchCommit: async () => ({
      hash: "selected-original",
      message: "Bug 123456 - Selected patch\nDifferential Revision: https://phabricator.services.mozilla.com/D123456",
      revision: "D123456",
    }),
    assertSafeWorktree: async ({ graphs }) => {
      observed.push(["safety", graphs.map((graph) => graph.path)]);
    },
    getRustUpstreamStatus: async () => ({ state: "current", upToDate: true }),
    updateCheckout: async ({ graphs }) => {
      observed.push(["update", graphs.map((graph) => graph.path)]);
      return { output: "Updated main." };
    },
    rebasePatch: async () => ({
      branch: "Bug-123456",
      currentHash: "selected-rewritten",
      rewrittenCommits: [{
        originalHash: "selected-original",
        hash: "selected-rewritten",
      }],
    }),
    checkoutPatch: async () => ({
      branch: "Bug-123456",
      hash: "selected-rewritten",
    }),
    getSnapshot: async () => ({ branch: "Bug-123456", commits: [] }),
    runCommand: async () => "",
  });

  assert.deepEqual(observed, [
    ["safety", ["/work/comm", "/work/firefox"]],
    ["update", ["/work/comm", "/work/firefox"]],
  ]);
});

test("patch update finds the exact Differential Revision trailer", async () => {
  const graph = { path: "/work/comm" };
  const result = await findGraphPatchCommit({
    graph,
    revision: "D123456",
    runCommand: async ({ args }) => {
      if (args[0] === "log" && !args.includes("-1")) {
        return "incorrect\ncorrect\n";
      }

      if (args.at(-1) === "incorrect") {
        return "Bug 123456 - Another patch\nDifferential Revision: https://phabricator.services.mozilla.com/D1234567\n";
      }

      return "Bug 123456 - Correct patch\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
    },
  });

  assert.deepEqual(result, {
    hash: "correct",
    message: "Bug 123456 - Correct patch\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n",
    revision: "D123456",
  });
});

test("patch update checks out the rewritten selected patch instead of the stack tip", async () => {
  const graph = {
    label: "comm",
    path: "/work/comm",
    knownHashes: new Set(),
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: false,
    graph,
    graphIndex: 0,
    revision: "D123456",
  });
  const calls = [];
  const rebaseOptions = [];
  const checkoutOptions = [];

  await prepareGraphPatchUpdateSession({
    session,
    graphs: [graph],
    findPatchCommit: async () => ({
      hash: "selected-original",
      message: "Bug 123456 - Selected patch\nDifferential Revision: https://phabricator.services.mozilla.com/D123456",
      revision: "D123456",
    }),
    assertSafeWorktree: async () => {},
    getRustUpstreamStatus: async () => ({ state: "current", upToDate: true }),
    updateCheckout: async () => ({ output: "Updated main." }),
    rebasePatch: async (options) => {
      rebaseOptions.push(options);
      return {
        branch: "Bug-123456-tip",
        currentHash: "tip-rewritten",
        rewrittenCommits: [
          { originalHash: "selected-original", hash: "selected-rewritten" },
          { originalHash: "child-original", hash: "tip-rewritten" },
        ],
      };
    },
    checkoutPatch: async (options) => {
      checkoutOptions.push(options);
      const { hash } = options;
      calls.push(hash);
      return { branch: "Bug-123456-selected", hash };
    },
    getSnapshot: async () => ({ branch: "Bug-123456-selected", commits: [] }),
    runCommand: async () => "",
  });

  assert.deepEqual(calls, ["selected-rewritten"]);
  assert.equal(rebaseOptions[0].requireLoaded, false);
  assert.equal(rebaseOptions[0].rebaseMode, "selected");
  assert.equal(checkoutOptions[0].requireLoaded, false);
  assert.equal(session.currentHash, "selected-rewritten");
  assert.equal(session.branch, "Bug-123456-selected");
  assert.equal(session.status, "complete");
  assert.match(session.message, /rebased and checked out/);
});

test("patch update replays every descendant branch onto the rewritten selected commit", async () => {
  const graph = {
    checkout: "working",
    knownHashes: new Set(),
    path: "/work/comm",
    repository: "comm",
  };
  const session = createGraphPatchUpdateSession({
    aiEnabled: false,
    graph,
    graphIndex: 0,
    revision: "D123456",
  });
  const rebaseCalls = [];
  const checkoutCalls = [];
  const rewritten = new Map([
    ["selected-original", "selected-rewritten"],
    ["left-original", "left-rewritten"],
    ["right-original", "right-rewritten"],
    ["right-child-original", "right-child-rewritten"],
  ]);

  await prepareGraphPatchUpdateSession({
    session,
    graphs: [graph],
    findPatchCommit: async () => ({
      hash: "selected-original",
      message: "Bug 123456 - Selected patch\nDifferential Revision: https://phabricator.services.mozilla.com/D123456",
      revision: "D123456",
    }),
    assertSafeWorktree: async () => {},
    getRustUpstreamStatus: async () => ({ state: "current", upToDate: true }),
    updateCheckout: async () => ({ output: "Updated main." }),
    rebasePatch: async (options) => {
      rebaseCalls.push(options);
      return {
        base: "main-rewritten",
        currentHash: rewritten.get(options.hash),
        rewrittenCommits: [{
          originalHash: options.hash,
          hash: rewritten.get(options.hash),
        }],
      };
    },
    checkoutPatch: async ({ hash }) => {
      checkoutCalls.push(hash);
      return { branch: `branch-${hash}` };
    },
    getSnapshot: async () => ({ commits: [] }),
    runCommand: async ({ args }) => {
      if (args[0] === "for-each-ref") {
        return "Bug-left\nBug-right\n";
      }
      if (args[0] === "rev-list") {
        return {
          "selected-original..Bug-left": "left-original\n",
          "selected-original..Bug-right": "right-original\nright-child-original\n",
        }[args.at(-1)] || "";
      }
      return "";
    },
  });

  assert.deepEqual(rebaseCalls.map(({ hash }) => hash), [
    "selected-original",
    "left-original",
    "right-original",
    "right-child-original",
  ]);
  assert.deepEqual(rebaseCalls.map(({ rebaseMode }) => rebaseMode), [
    "selected",
    "selected",
    "selected",
    "selected",
  ]);
  assert.ok(rebaseCalls.every(({ preserveSelectedParent }) => preserveSelectedParent === false));
  assert.deepEqual(checkoutCalls, [
    "selected-rewritten",
    "selected-rewritten",
    "right-rewritten",
    "selected-rewritten",
  ]);
  assert.equal(session.currentHash, "selected-rewritten");
});

test("saving a patch update reply keeps the comment active", () => {
  const session = {
    currentItemIndex: 0,
    items: [
      { id: "comment:1", author: "Reviewer", state: "pending", draftReply: "" },
      { id: "comment:2", author: "Next reviewer", state: "pending", draftReply: "" },
    ],
  };

  const item = saveGraphPatchUpdateReply({
    session,
    itemId: "comment:1",
    message: "  I kept the existing selection behavior.  ",
  });

  assert.equal(item.state, "pending");
  assert.equal(item.draftSaved, true);
  assert.equal(item.draftReply, "I kept the existing selection behavior.");
  assert.equal(session.currentItemIndex, 0);
  assert.match(session.message, /Reply draft saved in Phabricator/);
});

test("an archived conversation restore error never starts a replacement conversation", async () => {
  const session = { codexSessionId: "saved", activity: [] };
  let attempts = 0;
  await assert.rejects(runGraphPatchUpdateCodexTurn({ session, prompt: "Continue",
    getAgent: async () => {
      attempts++;
      throw Object.assign(new Error("Could not restore archived Codex chat: thread saved already has an active writer"),
        { code: "ARCHIVED_THREAD_RESTORE_FAILED" });
    },
  }), { code: "ARCHIVED_THREAD_RESTORE_FAILED" });
  assert.equal(attempts, 1);
  assert.equal(session.codexSessionId, "saved");
});

for (const invalid of ["missing", "duplicate", "unknown"]) {
  test(`assessment retries ${invalid} comment IDs without applying a partial result`, async () => {
    const session = { aiEnabled: true, status: "error", codexSessionId: "saved", activity: [],
      graph: { path: "/work/comm" }, items: [
        { id: "inline:one", state: "pending", assessment: "original" },
        { id: "inline:two", state: "pending", assessment: "original" },
      ] };
    const finding = id => ({ id, assessment: "Complete assessment", recommendation: "reply" });
    let calls = 0;
    await resumeGraphPatchUpdateAssessment({ session, runCodexTask: async ({ prompt }) => {
      calls++;
      if (calls === 2) {
        assert.deepEqual(session.items.map(item => item.assessment), ["original", "original"]);
        assert.match(prompt, /inline:one\ninline:two/);
        assert.match(prompt, /Do not edit files or Git state/);
      }
      const comments = calls === 2 ? [finding("inline:one"), finding("inline:two")]
        : invalid === "missing" ? [finding("inline:one")]
        : invalid === "duplicate" ? [finding("inline:one"), finding("inline:one"), finding("inline:two")]
        : [finding("inline:one"), finding("unknown")];
      return { message: JSON.stringify({ patchContext: { purpose: "Purpose", behaviorContract: "Contract" }, comments }) };
    } });
    assert.equal(calls, 2);
    assert.equal(session.status, "review");
    assert.ok(session.items.every(item => item.state === "ready"));
  });
}

test("failed assessment remains retryable and can recover in the saved conversation", async () => {
  const session = { aiEnabled: true, status: "error", currentHash: "abc", codexSessionId: "saved", activity: [],
    graph: { path: "/work/comm", checkout: "working", repository: "comm" },
    items: [{ id: "inline:one", state: "pending" }] };
  let calls = 0;
  const response = comments => ({ message: JSON.stringify({
    patchContext: { purpose: "Purpose", behaviorContract: "Contract" }, comments }) });
  await resumeGraphPatchUpdateAssessment({ session, runCodexTask: async () => { calls++; return response([]); } });
  assert.equal(calls, 2);
  assert.equal(session.status, "error");
  assert.equal(serializeGraphPatchUpdateSession(session).canRetryAssessment, true);
  await steerGraphPatchUpdateSession({ session, instruction: "Try again with the saved evidence.",
    runCommand: async () => "abc", runFollowUp: async ({ session, prompt }) => {
      assert.equal(session.codexSessionId, "saved");
      assert.match(prompt, /Try again with the saved evidence/);
      return response([{ id: "inline:one", assessment: "Checked", recommendation: "reply" }]);
    } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status, "review");
  assert.equal(session.error, "");
  assert.equal(serializeGraphPatchUpdateSession(session).canRetryAssessment, false);
});

test("ending a Codex turn does not claim the assessment succeeded", () => {
  assert.equal(getGraphCodexActivity({ type: "turn.completed" }).title, "Codex turn ended");
});
