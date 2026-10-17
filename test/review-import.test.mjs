import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../lib/utils.mjs";
import { startReviewImport, continueReviewImport } from "../commands/graph/review-import.mjs";
import { proposeRebaseResolution, applyRebaseResolution } from "../commands/graph/rebase-resolution.mjs";
import { createRebaseSessionStore, hasActiveRebaseSession } from "../commands/graph/rebase-session-store.mjs";

test("Review raw imports preserve parents, repeated conflicts, new files and saved state", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-import-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "file.js"), "main\n");
  git("add", "."); git("commit", "-m", "Main");
  const main = git("rev-parse", "HEAD");
  const graph = { path: root, repositoryPath: root, repository: "comm", taskWorktree: true };
  const incoming = (revision, diff) => ({ diff, body: `Bug 123 - ${revision}\n\nDifferential Revision: https://phabricator.services.mozilla.com/${revision}\n`,
    author: "Author <author@example.invalid>", date: 1791763200 });
  const addition = file => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+added\n`;
  const change = (old, value) => `diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-${old}\n+${value}\n`;
  const patches = [incoming("D1", addition("parent.js")),
    incoming("D2", change("original", "incoming") + addition("new/sub/file.js")),
    incoming("D3", change("incoming", "next"))];
  let state;
  await assert.rejects(startReviewImport({ session: { id: "review", graph, graphIndex: 0,
    reviewMainHash: main, revision: "D3" }, patches, runCommand: run }), error => {
    state = error.rebaseState;
    return Boolean(state);
  }, "The failed raw import should pause in the shared resolver.");
  assert.equal(state.conflictCommit, "D2", "The parent should import before the first conflict.");
  assert.equal(await readFile(path.join(root, "parent.js"), "utf8"), "added\n",
    "The clean parent should retain its changes.");
  assert.deepEqual(state.conflictFiles, ["file.js", "new/sub/file.js"],
    "The failed patch should list every path, including clean additions.");
  assert.equal(git("log", "-1", "--format=%an <%ae> %at"), "Author <author@example.invalid> 1791763200",
    "Imported commits should preserve author and date.");
  state.id = "abc123";
  const store = createRebaseSessionStore({ directory: path.join(root, "saved") });
  store.save(state);
  [state] = store.load([graph]);
  assert.equal(await hasActiveRebaseSession(state, run), true,
    "The pending raw import should remain active without a Git sequencer.");
  assert.equal(await hasActiveRebaseSession(state, async () => "moved"), false,
    "A moved checkout should not restore the pending raw import.");
  let proposal = await proposeRebaseResolution({ session: state, runCommand: run, generate: async prompt => {
    assert.match(prompt, /Git applied none of this patch/, "The prompt should explain atomic raw application.");
    return JSON.stringify({ files: [{ path: "file.js", edits: [{ startLine: 1, endLine: 1, text: "merged\n" }] },
      { path: "new/sub/file.js", edits: [{ startLine: 1, endLine: 0, text: "added\n" }] }] });
  } });
  store.save(state);
  [state] = store.load([graph]);
  await applyRebaseResolution({ session: state, id: proposal.id, runCommand: run, cancel: true });
  assert.equal(await readFile(path.join(root, "file.js"), "utf8"), "main\n",
    "Cancelling a proposal should restore main content.");
  await assert.rejects(readFile(path.join(root, "new/sub/file.js")), { code: "ENOENT" },
    "Cancelling a proposal should remove its new file.");
  proposal = await proposeRebaseResolution({ session: state, runCommand: run, generate: async () => JSON.stringify({
    files: [{ path: "file.js", edits: [{ startLine: 1, endLine: 1, text: "merged\n" }] },
      { path: "new/sub/file.js", edits: [{ startLine: 1, endLine: 0, text: "added\n" }] }],
  }) });
  await applyRebaseResolution({ session: state, id: proposal.id, runCommand: run });
  await assert.rejects(continueReviewImport({ session: state, runCommand: run }), error => {
    state = error.rebaseState;
    return state?.conflictCommit === "D3";
  }, "The next conflict should pause again before the review resumes.");
  assert.equal(await readFile(path.join(root, "new/sub/file.js"), "utf8"), "added\n",
    "The resolution should retain the failed patch's clean addition.");
  proposal = await proposeRebaseResolution({ session: state, runCommand: run, generate: async () => JSON.stringify({
    files: [{ path: "file.js", edits: [{ startLine: 1, endLine: 1, text: "final\n" }] }],
  }) });
  await applyRebaseResolution({ session: state, id: proposal.id, runCommand: run });
  const result = await continueReviewImport({ session: state, runCommand: run });
  assert.equal(result.currentHash, git("rev-parse", "HEAD"), "Completion should identify the imported requested revision.");
  assert.match(git("log", "-1", "--format=%B"), /\/D3/, "The requested revision should remain at HEAD.");
  git("merge-base", "--is-ancestor", main, "HEAD");
});

test("Review raw import refuses cancellation and unsafe paths before changing Git", async () => {
  let calls = 0;
  const session = { cancelled: true, graph: { taskWorktree: true, repository: "comm", path: "/review/comm" },
    reviewMainHash: "main", revision: "D1" };
  const patch = { body: "Differential Revision: https://example.invalid/D1", diff:
    "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n" };
  await assert.rejects(startReviewImport({ session, patches: [patch], runCommand: async () => calls++ }),
    { code: "ABORT_ERR" }, "A cancelled import should not replay the patch.");
  assert.equal(calls, 0, "Cancellation should prevent all Git commands.");
  await assert.rejects(startReviewImport({ session: { ...session, cancelled: false },
    patches: [{ ...patch, diff: patch.diff.replaceAll("a/file", "a/../../file") }], runCommand: async () => calls++ }),
    /safely/, "Unsafe paths should require manual import.");
  assert.equal(calls, 0, "Unsafe paths should be rejected before changing Git.");
  for (const file of [".git/config", ".GIT/config"]) {
    await assert.rejects(startReviewImport({ session: { ...session, cancelled: false },
      patches: [{ ...patch, diff: patch.diff.replaceAll("a/file", `a/${file}`).replaceAll("b/file", `b/${file}`) }],
      runCommand: async () => calls++ }), /safely/, "Repository metadata paths should require manual import.");
  }
  assert.equal(calls, 0, "Metadata paths should be rejected before changing Git.");
  for (const mode of ["100755", "120000"]) {
    await assert.rejects(startReviewImport({ session: { ...session, cancelled: false }, patches: [{ ...patch,
      diff: `diff --git a/file b/file\nnew file mode ${mode}\n--- /dev/null\n+++ b/file\n@@ -0,0 +1 @@\n+added\n` }],
      runCommand: async () => calls++ }), /permissions/, "Special file modes should require manual import.");
  }
  assert.equal(calls, 0, "Special file modes should be rejected before changing Git.");
});
