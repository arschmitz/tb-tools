import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { continueRebaseCommit, rebaseCommit } from "../commands/graph/actions.mjs";
import { run } from "../lib/utils.mjs";

const exec = promisify(execFile);

for (const mode of ["children", "descendants", "stack"]) {
  for (const uneven of [false, true]) {
    test(`rebase ${mode} preserves ${uneven ? "unequal" : "equal"} child forks`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "tb-rebase-forks-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
      const commit = async (name, content = name) => {
        await writeFile(path.join(root, `${name}.txt`), content + "\n");
        await git("add", ".");
        await git("commit", "-m", name);
        return git("rev-parse", "HEAD");
      };
      await git("init", "-b", "main");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.com");
      await git("config", "commit.gpgsign", "false");
      await commit("base");
      await git("update-ref", "refs/remotes/origin/main", "HEAD");
      await git("switch", "-c", "parent");
      const hash = await commit("parent");
      await git("switch", "-c", "child-a");
      const a = await commit("a");
      await git("branch", "alias-a");
      if (uneven) {
        await commit("a-tip");
      }
      await git("switch", "-c", "child-b", "parent");
      const b = await commit("b");
      await git("switch", "main");
      const base = await commit("upstream");
      await git("update-ref", "refs/remotes/origin/main", base);
      const result = await rebaseCommit({
        // Unequal forks also cover commits outside the loaded graph page.
        graph: { path: root, label: "comm", knownHashes: new Set(uneven ? [] : [hash]) },
        hash,
        rebaseMode: mode,
        // A hint must not exclude the other child.
        preferredBranch: uneven ? "child-a" : "",
        runCommand: run,
      });
      const rewritten = new Map(result.rewrittenCommits.map((entry) => [entry.originalHash, entry.hash]));
      assert.equal(result.rebasedCount, uneven ? 4 : 3);
      assert.equal(await git("rev-parse", "parent^"), base);
      assert.equal(await git("rev-parse", "alias-a^"), rewritten.get(hash));
      assert.equal(await git("rev-parse", "child-b^"), rewritten.get(hash));
      assert.equal(await git("rev-parse", "alias-a"), rewritten.get(a));
      assert.equal(await git("rev-parse", "child-b"), rewritten.get(b));
      assert.equal(await git("show", "child-b:b.txt"), "b");
      await assert.rejects(git("cat-file", "-e", "child-b:a.txt"));
      await assert.rejects(git("cat-file", "-e", "child-a:b.txt"));
      assert.equal(await git("status", "--porcelain"), "");
    });
  }
}

test("fork rebase continues a conflict before replaying the sibling", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-rebase-fork-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "Base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("switch", "-c", "parent");
  await writeFile(path.join(root, "parent.txt"), "parent\n");
  await git("add", ".");
  await git("commit", "-m", "Parent");
  const hash = await git("rev-parse", "HEAD");
  await git("switch", "-c", "child-a");
  await writeFile(path.join(root, "conflict.txt"), "child\n");
  await git("commit", "-am", "Child A");
  const a = await git("rev-parse", "HEAD");
  await git("switch", "-c", "child-b", "parent");
  await writeFile(path.join(root, "b.txt"), "b\n");
  await git("add", ".");
  await git("commit", "-m", "Child B");
  await git("switch", "main");
  await writeFile(path.join(root, "conflict.txt"), "upstream\n");
  await git("commit", "-am", "Upstream");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  let session;
  await assert.rejects(rebaseCommit({
    graph: { path: root, label: "comm", knownHashes: new Set([hash]) },
    hash,
    rebaseMode: "children",
    runCommand: run,
  }), (error) => {
    session = error.rebaseState;
    assert.equal(session.conflictCommit, a);
    return true;
  });
  assert.equal(await git("rev-parse", "parent"), hash);
  await writeFile(path.join(root, "conflict.txt"), "resolved\n");
  await continueRebaseCommit({ session, runCommand: run });
  assert.equal(await git("rev-parse", "child-a^"), await git("rev-parse", "parent"));
  assert.equal(await git("rev-parse", "child-b^"), await git("rev-parse", "parent"));
  assert.equal(await git("show", "child-a:conflict.txt"), "resolved");
  assert.equal(await git("show", "child-b:conflict.txt"), "upstream");
  assert.equal(await git("status", "--porcelain"), "");
});
