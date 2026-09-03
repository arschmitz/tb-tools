import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createGraphPatchUpdateSession,
  findGraphPatchCommit,
  filterGraphPatchUpdateHandledComments,
  followUpGraphPatchUpdateComment,
  getGraphCodexActivity,
  getGraphCodexExecArgs,
  getGraphPatchUpdateFollowUpPrompt,
  getGraphPatchUpdateDraftBlock,
  getGraphPatchUpdateReviewPrompt,
  getGraphPatchUpdateSubmitMessage,
  isGraphAiEnabled,
  prepareGraphPatchUpdateSession,
  resolveGraphCodexCommand,
  saveGraphPatchUpdateReply,
  serializeGraphPatchUpdateSession,
} from "../commands/graph/patch-update.mjs";
import { mergePhabricatorPatchUpdateDraft } from "../commands/graph/phab-auth.mjs";

test("AI patch updating requires the explicit local config gate", () => {
  assert.equal(isGraphAiEnabled({}), false);
  assert.equal(isGraphAiEnabled({ ai: {} }), false);
  assert.equal(isGraphAiEnabled({ ai: { enabled: false } }), false);
  assert.equal(isGraphAiEnabled({ ai: { enabled: true } }), true);
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

test("Codex patch updates use a compatible noninteractive invocation", () => {
  const args = getGraphCodexExecArgs({
    session: { codexSessionId: "", graph: { path: "/work/comm" } },
    prompt: "Review this patch.",
  });

  assert.deepEqual(args, [
    "exec",
    "--json",
    "--approve-for-me",
    "--color",
    "never",
    "-C",
    "/work/comm",
    "Review this patch.",
  ]);
  assert.equal(args.includes("--sandbox"), false);
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
    ["exec", "resume", "--json", "existing-session", "Apply the selected change."],
  );
});

test("patch review prompts load shared memory and local patch history", () => {
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

  assert.match(prompt, /memory_summary\.md in full/);
  assert.match(prompt, /every shared-memory task group/);
  assert.match(prompt, /extensions\/ad_hoc\/notes/);
  assert.match(prompt, /Current patch commit: abc123/);
  assert.match(prompt, /Bug 123456 - Fix the thing/);
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
      item: { type: "reasoning" },
    }),
    { kind: "reasoning", title: "Completed a review step" },
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
            suggestedReply: "I will update this to use the shared helper.",
            requiresChanges: true,
            changeSummary: "Replace the local lifecycle code with the shared helper.",
            proposedDiff: "diff --git a/mail/base/content/example.js b/mail/base/content/example.js\n--- a/mail/base/content/example.js\n+++ b/mail/base/content/example.js\n@@ -1 +1 @@\n-const local = true;\n+const shared = true;",
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
  assert.match(session.items[0].proposedDiffHtml, /pretty-file/);
  assert.match(session.items[0].proposedDiffHtml, /mail\/base\/content\/example\.js/);
  assert.equal(session.items[0].state, "ready");
  assert.equal(session.items[0].instruction, "");
  assert.match(session.message, /updated its recommendation/);
  assert.match(savedEvent, /reviewed user feedback/);
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
  assert.equal(Object.hasOwn(serialized, "graph"), false);
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

test("patch update preserves other Phabricator draft text while replacing its response block", () => {
  const draftBlock = `<!-- tb-tools-patch-update-responses:start -->
### Responses to review comments

**Response to Reviewer**

Done.
<!-- tb-tools-patch-update-responses:end -->`;
  const existing = `A separately written draft comment.

<!-- tb-tools-patch-update-responses:start -->
Old response.
<!-- tb-tools-patch-update-responses:end -->`;

  assert.equal(
    mergePhabricatorPatchUpdateDraft(existing, draftBlock),
    `A separately written draft comment.

${draftBlock}`,
  );
  assert.equal(
    mergePhabricatorPatchUpdateDraft(existing, ""),
    "A separately written draft comment.",
  );
});

test("patch update submits saved responses without draft markers", () => {
  const session = {
    items: [
      {
        author: "Reviewer",
        filePath: "mail/base/content/example.js",
        lineNumber: 42,
        draftReply: "Adjusted the condition and added coverage.",
      },
      {
        author: "Another reviewer",
        draftReply: "No source change is needed here.",
      },
      {
        author: "Ignored reviewer",
        draftReply: "",
      },
    ],
  };

  assert.match(getGraphPatchUpdateDraftBlock(session), /tb-tools-patch-update-responses:start/);
  assert.deepEqual(
    getGraphPatchUpdateSubmitMessage(session),
    `### Responses to review comments

**Response to Reviewer (mail/base/content/example.js:42)**

Adjusted the condition and added coverage.

**Response to Another reviewer**

No source change is needed here.`,
  );
});

test("saving a patch update reply marks the comment handled and advances", () => {
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

  assert.equal(item.state, "handled");
  assert.equal(item.draftSaved, true);
  assert.equal(item.draftReply, "I kept the existing selection behavior.");
  assert.equal(session.currentItemIndex, 1);
  assert.match(session.message, /Moving to the next comment/);
  assert.match(getGraphPatchUpdateDraftBlock(session), /I kept the existing selection behavior/);
});
