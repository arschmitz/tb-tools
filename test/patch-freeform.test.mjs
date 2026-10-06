import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createGraphPatchUpdateSession, prepareGraphPatchUpdateSession,
  runGraphPatchFreeformUpdate, rollbackGraphPatchFreeformUpdate,
  applyGraphPatchUpdateComment, reviseGraphPatchUpdateChange, acceptGraphPatchUpdateChange,
  serializeGraphPatchUpdateSession,
} from "../commands/graph/patch-update.mjs";
import { createPatchSessionStore } from "../commands/graph/patch-session-store.mjs";

const message = "Bug 123456 - Update the patch\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456";
const saveMemory = async () => {};

test("freeform preparation loads history, selects the newest working patch, and waits for a request", async () => {
  const graph = { path: "/repo/comm", repository: "comm", checkout: "working", knownHashes: new Set() };
  const session = createGraphPatchUpdateSession({ graph, graphIndex: 0, revision: "D123456", mode: "freeform", aiEnabled: true });
  const history = { available: true, comments: [], inlineComments: [], historyTruncated: true };
  await prepareGraphPatchUpdateSession({
    session, graphs: [graph],
    findPatchCommit: async options => { assert.equal(options.newest, true); return { hash: "latest", message }; },
    assertSafeWorktree: async () => {},
    checkoutPatch: async options => { assert.equal(options.hash, "latest"); return { branch: "feature" }; },
    getSnapshot: async () => ({}),
    getReview: async () => history,
    runCommand: async ({ args }) => args[0] === "rev-parse" ? "other" : "",
    updateCheckout: async () => assert.fail("Do not update repositories"),
    runCodexTask: async () => assert.fail("Wait for the author's request"),
  });
  assert.equal(session.mode, "freeform");
  assert.equal(session.status, "review");
  assert.equal(session.rollbackHash, "latest");
  assert.equal(session.reviewHistory, history);
  assert.match(session.message, /400/);
  assert.deepEqual(session.items, []);
});

async function checkout(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freeform-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args, trim = true) => {
    const result = execFileSync("git", args, { cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
    stdio: ["ignore", "pipe", "pipe"] });
    return trim ? result.trim() : result;
  };
  git(["init", "-b", "feature"]);
  await writeFile(path.join(directory, "file.txt"), "base\n");
  git(["add", "."]); git(["commit", "-m", "base"]);
  await writeFile(path.join(directory, "file.txt"), "patch\n");
  git(["commit", "-am", message]);
  const graph = { path: directory, repository: "comm", checkout: "working", branch: "feature", label: "comm", knownHashes: new Set() };
  const session = createGraphPatchUpdateSession({ graph, graphIndex: 0, revision: "D123456", mode: "freeform", aiEnabled: true });
  Object.assign(session, { status: "review", currentHash: git(["rev-parse", "HEAD"]), commitMessage: message,
    reviewHistory: { discussion: "Preserve the original behavior." } });
  session.rollbackHash = session.currentHash;
  return { directory, git, session, runCommand: async ({ args }) => {
    try { return git(args, false); } catch (error) { error.code = error.status; throw error; }
  } };
}

test("freeform questions, repeated edits, amendment, resume, and rollback preserve the starting patch", async t => {
  const { directory, git, session, runCommand } = await checkout(t);
  const apply = task => options => applyGraphPatchUpdateComment({ ...options, runCodexTask: task });
  await runGraphPatchFreeformUpdate({ session, runCommand, saveMemory, instruction: "Explain this patch",
    applyChange: apply(async ({ prompt }) => {
      assert.match(prompt, /Preserve the original behavior/);
      assert.match(prompt, /For a question, answer without editing/);
      return { sessionId: "saved-chat", message: "The patch changes file.txt." };
    }) });
  assert.equal(session.codexSessionId, "saved-chat");
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(session.currentItemIndex, session.items.length);
  await runGraphPatchFreeformUpdate({ session, runCommand, saveMemory, instruction: "Change the file",
    applyChange: apply(async () => {
      await writeFile(path.join(directory, "file.txt"), "updated\n");
      return { sessionId: "saved-chat", message: "Updated the file." };
    }) });
  const item = session.items.at(-1);
  assert.equal(item.changeApplied, true);
  await runGraphPatchFreeformUpdate({ session, runCommand, saveMemory, instruction: "Add another line",
    reviseChange: options => reviseGraphPatchUpdateChange({ ...options, runCodexTask: async ({ prompt }) => {
      assert.match(prompt, /Add another line/);
      await writeFile(path.join(directory, "file.txt"), "updated\nmore\n");
      return { message: "Added another line." };
    } }) });
  assert.equal(session.items.at(-1), item);
  await acceptGraphPatchUpdateChange({ session, itemId: item.id, runCommand, saveMemory });
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(item.state, "handled");
  assert.equal(serializeGraphPatchUpdateSession(session).canRollback, true);
  const store = createPatchSessionStore({ directory: path.join(directory, "sessions") });
  store.save("update", session);
  const restored = store.load("update", session);
  assert.equal(restored.chat.length, 6);
  assert.equal(restored.rollbackHash, session.rollbackHash);
  assert.equal(store.load("update", { ...session, mode: "verify" }), null);
  assert.equal(store.load("update", { ...session, mode: "update" }), null);
  // Keep the store outside Git's working files for rollback's ownership check.
  await rm(path.join(directory, "sessions"), { recursive: true });
  await rollbackGraphPatchFreeformUpdate({ session: restored, runCommand, saveMemory });
  assert.equal(await readFile(path.join(directory, "file.txt"), "utf8"), "patch\n");
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(git(["rev-parse", "feature"]), restored.currentHash);
  assert.equal(serializeGraphPatchUpdateSession(restored).canRollback, false);
});

test("freeform refuses to edit or roll back unrelated work or another checkout commit", async t => {
  const { directory, git, session, runCommand } = await checkout(t);
  await writeFile(path.join(directory, "file.txt"), "external edit\n");
  await assert.rejects(runGraphPatchFreeformUpdate({ session, runCommand, instruction: "Change it",
    applyChange: async () => assert.fail("Do not invoke the agent") }), /unrelated/);
  await assert.rejects(rollbackGraphPatchFreeformUpdate({ session, runCommand }), /unrelated/);
  assert.equal(await readFile(path.join(directory, "file.txt"), "utf8"), "external edit\n");
  git(["restore", "file.txt"]); git(["checkout", "--detach", "HEAD^"]);
  await assert.rejects(rollbackGraphPatchFreeformUpdate({ session, runCommand }), /commit changed/);
});

test("interrupted freeform edits remain visible and rollback removes only the session changes", async t => {
  const { directory, git, session, runCommand } = await checkout(t);
  await assert.rejects(runGraphPatchFreeformUpdate({ session, runCommand, saveMemory, instruction: "Update the files",
    applyChange: options => applyGraphPatchUpdateComment({ ...options, runCodexTask: async () => {
      await writeFile(path.join(directory, "file.txt"), "interrupted edit\n");
      await writeFile(path.join(directory, "new.txt"), "new file\n");
      throw new Error("Agent disconnected");
    } }),
  }), /Agent disconnected/);
  assert.equal(session.status, "review");
  assert.equal(session.items.at(-1).changeApplied, true);
  assert.equal(serializeGraphPatchUpdateSession(session).canRollback, true);
  await rollbackGraphPatchFreeformUpdate({ session, runCommand, saveMemory });
  assert.equal(await readFile(path.join(directory, "file.txt"), "utf8"), "patch\n");
  await assert.rejects(readFile(path.join(directory, "new.txt")), { code: "ENOENT" });
  assert.equal(git(["status", "--porcelain"]), "");
});

test("a freeform request holds the checkout until the agent finishes", async t => {
  const { session, runCommand } = await checkout(t);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const active = runGraphPatchFreeformUpdate({ session, runCommand, saveMemory, instruction: "Explain it",
    applyChange: async ({ session, itemId }) => {
      entered();
      await wait;
      session.items.find(item => item.id === itemId).appliedSummary = "Explained.";
    },
  });
  await started;
  await assert.rejects(runGraphPatchFreeformUpdate({ session, runCommand, instruction: "Another edit" }), /Wait/);
  await assert.rejects(rollbackGraphPatchFreeformUpdate({ session, runCommand }), /Wait/);
  release();
  await active;
  assert.equal(session.freeformOperationRunning, false);
});
