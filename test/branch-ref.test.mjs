import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { runGraphCommitAction } from "../commands/graph/actions.mjs";

const execute = promisify(execFile);

test("remove branch ref preserves commits and rejects checked-out, remote, and stale refs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-branch-ref-"));
  const git = async (...args) => (await execute("git", args, { cwd: directory })).stdout.trim();
  const runCommand = async ({ cmd, args, cwd }) => (await execute(cmd, args, { cwd })).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "first");
    const hash = await git("rev-parse", "HEAD");
    await git("branch", "remove-me");
    await git("branch", "keep-me");
    const remove = (preferredBranch, selectedHash = hash) => runGraphCommitAction({
      graphs: [{ path: directory, label: "Test" }], graphIndex: 0,
      hash: selectedHash, action: "remove-branch", preferredBranch, runCommand,
    });
    await remove("remove-me");
    await assert.rejects(git("show-ref", "--verify", "refs/heads/remove-me"));
    assert.equal(await git("rev-parse", "keep-me"), hash);
    assert.equal(await git("cat-file", "-t", hash), "commit");
    assert.equal(await git("rev-parse", "HEAD"), hash);
    await assert.rejects(remove("main"), /checked out|used by worktree/);
    await git("worktree", "add", path.join(directory, "linked"), "keep-me");
    await assert.rejects(remove("keep-me"), /checked out|used by worktree/);
    await git("update-ref", "refs/remotes/origin/main", hash);
    await assert.rejects(remove("origin/main"), /selected local branch/);
    assert.equal(await git("rev-parse", "refs/remotes/origin/main"), hash);
    await git("branch", "stale");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "second");
    await assert.rejects(remove("stale", await git("rev-parse", "HEAD")), /selected local branch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
