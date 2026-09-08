import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createGraphPatchUpdateSession,
  applyGraphPatchUpdateRecommendedChange,
  findGraphPatchCommit,
  filterGraphPatchUpdateHandledComments,
  followUpGraphPatchUpdateComment,
  getGraphCodexActivity,
  getGraphCodexExecArgs,
  getGraphPatchUpdateCodexThreadName,
  getGraphPatchUpdateMemoryContext,
  getGraphPatchUpdateWorkingTreeState,
  getGraphPatchUpdateFollowUpPrompt,
  getGraphPatchUpdateReviewPrompt,
  isGraphAiEnabled,
  normalizeGraphPatchUpdateProposedDiff,
  prepareGraphPatchUpdateSession,
  resolveGraphPatchUpdateWorkingCheckout,
  resolveGraphCodexCommand,
  saveGraphPatchUpdateReply,
  serializeGraphPatchUpdateSession,
} from "../commands/graph/patch-update.mjs";

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
    "D320328 - Update 2026-09-08 14:37",
  );
  assert.equal(session.codexThreadName, "D320328 - Update 2026-09-08 14:37");
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

test("Patch Update automatically prepares the current recommended source change", async () => {
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

  await applyGraphPatchUpdateRecommendedChange({
    session,
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

test("Patch Update automatically applies the first recommended change after assessment", async () => {
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
  const before = {
    head: "rewritten123",
    rawDiff: "",
    treeish: "before",
    untrackedPaths: [],
  };
  const after = {
    head: "rewritten123",
    rawDiff: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
    treeish: "after",
    untrackedPaths: [],
  };
  let stateReadCount = 0;
  let codexCalls = 0;

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
      currentHash: "rewritten123",
      rewrittenCommits: [{ hash: "rewritten123", originalHash: "original123" }],
    }),
    checkoutPatch: async () => ({ branch: "Bug-123456" }),
    getSnapshot: async () => ({ commits: [] }),
    getReview: async () => ({
      available: true,
      inlineComments: [{
        content: "Use the shared helper.",
        id: "inline:1",
        lineNumber: 1,
      }],
    }),
    getHandledCommentIds: async () => new Set(),
    getWorkingTreePatch: async () => after.rawDiff,
    getWorkingTreeState: async () => (
      stateReadCount++ ? after : before
    ),
    runCodexTask: async () => {
      codexCalls++;
      return codexCalls === 1
        ? {
          message: JSON.stringify({
            comments: [{
              assessment: "The source should use the shared helper.",
              changeSummary: "Replace the local helper call.",
              id: "inline:inline:1",
              rationale: "The shared helper owns this lifecycle.",
              recommendation: "change",
              requiresChanges: true,
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
        }
        : { message: "Updated the source and ran the focused test.", sessionId: "codex-thread" };
    },
    runCommand: async () => "",
  });

  assert.equal(codexCalls, 2);
  assert.equal(session.items[0].changeApplied, true);
  assert.match(session.items[0].workingDiff, /diff --git/);
  assert.match(session.workingDiff, /diff --git/);
  assert.match(session.message, /actual uncommitted diff/);
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
    "Review this patch.",
  ]);
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--approve-for-me"), false);
});

test("Codex patch updates make the shared memory store available", () => {
  const args = getGraphCodexExecArgs({
    memoryDirectory: "/Users/example/.codex/memories",
    session: { codexSessionId: "", graph: { path: "/work/comm" } },
    prompt: "Review this patch.",
  });

  assert.deepEqual(args.slice(-3), [
    "--add-dir",
    "/Users/example/.codex/memories",
    "Review this patch.",
  ]);

  assert.deepEqual(
    getGraphCodexExecArgs({
      memoryDirectory: "/Users/example/.codex/memories",
      session: { codexSessionId: "existing-session", graph: { path: "/work/comm" } },
      prompt: "Apply the selected change.",
    }),
    [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
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
  assert.match(prompt, /rg exits with status 1/);
  assert.match(prompt, /ad-hoc notes/);
  assert.match(prompt, /Current patch commit: abc123/);
  assert.match(prompt, /Bug 123456 - Fix the thing/);

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

test("patch update injects the shared memory summary and its patch history", async () => {
  const files = new Map([
    ["/memories/memory_summary.md", "Project-wide Thunderbird context."],
    [
      "/memories/MEMORY.md",
      "# BCT4 a11y work\n\nThe BCT4 stack protects accessibility test behavior.\n\n## Other work\n",
    ],
    [
      "/memories/extensions/ad_hoc/notes/tb-tools-patch-d123456.md",
      "Prior patch update context.",
    ],
  ]);
  const context = await getGraphPatchUpdateMemoryContext({
    memoryDirectory: "/memories",
    revision: "D123456",
    commitMessage: "Bug 123456 - BCT4 a11y test fix",
    readMemoryFile: async (filePath) => {
      if (!files.has(filePath)) {
        throw new Error("missing");
      }

      return files.get(filePath);
    },
  });

  assert.match(context, /Project-wide Thunderbird context/);
  assert.match(context, /Prior Patch Update history/);
  assert.match(context, /Relevant shared-memory index excerpts/);
  assert.match(context, /BCT4 stack protects accessibility test behavior/);
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
  assert.equal(session.items[0].hasProposedDiff, false);
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
    rebasePatch: async () => ({
      branch: "Bug-123456-tip",
      currentHash: "tip-rewritten",
      rewrittenCommits: [
        { originalHash: "selected-original", hash: "selected-rewritten" },
        { originalHash: "child-original", hash: "tip-rewritten" },
      ],
    }),
    checkoutPatch: async ({ hash }) => {
      calls.push(hash);
      return { branch: "Bug-123456-selected", hash };
    },
    getSnapshot: async () => ({ branch: "Bug-123456-selected", commits: [] }),
    runCommand: async () => "",
  });

  assert.deepEqual(calls, ["selected-rewritten"]);
  assert.equal(session.currentHash, "selected-rewritten");
  assert.equal(session.branch, "Bug-123456-selected");
  assert.equal(session.status, "complete");
  assert.match(session.message, /rebased and checked out/);
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
