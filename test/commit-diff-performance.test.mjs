import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderLocalDiff } from "../commands/graph/data.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

const diff = "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";

test("diff editor links avoid listing worktrees when files exist locally", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tb-diff-local-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "file.txt"), "new\n");
  let calls = 0;
  const result = await renderLocalDiff(diff, 0, { cwd, runCommand: async () => { calls++; return ""; } });
  assert.equal(calls, 0, "Local files should need no Git worktree listing.");
  assert.match(result.html, /open-vscode/, "The local file should retain its editor link.");
  assert.equal(result.text, diff, "The diff should retain all source text.");
  await renderLocalDiff("", 0, { cwd, runCommand: async () => { calls++; return ""; } });
  assert.equal(calls, 0, "An empty diff should need no Git worktree listing.");
});

test("diff editor links fall back to another worktree for renamed files", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tb-diff-fallback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const other = path.join(cwd, "other");
  await mkdir(other);
  await writeFile(path.join(other, "new.txt"), "new\n");
  let calls = 0;
  const renamed = "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n";
  const result = await renderLocalDiff(renamed, 0, { cwd, runCommand: async command => {
    calls++;
    assert.deepEqual(command.args, ["worktree", "list", "--porcelain", "-z"], "Missing files should use the existing worktree listing command.");
    return `worktree ${cwd}\0\0worktree ${other}\0\0`;
  } });
  assert.equal(calls, 1, "Missing local files should trigger one worktree listing.");
  assert.ok(result.html.includes(path.join(other, "new.txt")), "The renamed file should link to its destination in the other worktree.");
  calls = 0;
  await renderLocalDiff(renamed, 0, { cwd, workingTrees: [other], runCommand: async () => { calls++; return ""; } });
  assert.equal(calls, 0, "Supplied worktrees should need no Git listing.");
});

test("selected committed diffs reuse results and coalesce concurrent requests", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tb-diff-cache-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "file.txt"), "new\n");
  let shows = 0;
  let workingDiffs = 0;
  const server = await startInteractiveGraphServer({
    html: "", graphs: [{ path: cwd, label: "test", commits: [] }], token: "secret",
    appConfig: { ai: { enabled: false } }, implementationManager: null, tryMonitor: null,
    patchSessionDirectory: path.join(cwd, "sessions"),
    reviewHandledPath: path.join(cwd, "handled.json"),
    taskWorktreeDirectory: path.join(cwd, "tasks"),
    getKnowledgeService: async () => null,
    runCommand: async command => {
      if (command.args[0] === "show") {
        shows++;
        assert.ok(command.args.includes("--unified=2147483647"), "Cached diffs should retain full file context.");
        await new Promise(resolve => setImmediate(resolve));
        return diff;
      }
      if (command.args[0] === "diff") return diff.replace("+new", `+new ${++workingDiffs}`);
      return "";
    },
  });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const load = async hash => {
    const response = await fetch(new URL(`api/graph/0/diff/${hash}?token=secret`, server.url));
    assert.equal(response.status, 200, "The selected diff should load successfully.");
    return response.json();
  };
  const hash = "a".repeat(40);
  const results = await Promise.all([load(hash), load(hash)]);
  assert.deepEqual(results[0], results[1], "Concurrent selections should receive the same complete diff.");
  await load(hash);
  assert.equal(shows, 1, "Repeat selections should reuse the immutable commit diff.");
  for (const abbreviated of ["abcdef", "b".repeat(41)]) {
    await load(abbreviated);
    await load(abbreviated);
  }
  assert.equal(shows, 5, "Abbreviated commit IDs should remain uncached.");
  const firstWorking = await load("uncommitted-changes");
  const secondWorking = await load("uncommitted-changes");
  assert.notEqual(firstWorking.text, secondWorking.text, "Working-tree selections should read the current changes each time.");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  now += 16_000;
  await load(hash);
  assert.equal(shows, 6, "Cached diffs should expire after fifteen seconds.");
  for (let i = 1; i <= 8; i++) await load(i.toString(16).repeat(40));
  await load(hash);
  assert.equal(shows, 15, "The cache should evict the oldest diff after eight entries.");
});
