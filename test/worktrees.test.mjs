import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePairedWorktrees, shareGitRepository, writeWorktreeBuildConfig } from "../commands/graph/worktrees.mjs";
import { syncReviewCheckoutFromWorking } from "../commands/graph/review-sync.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function init(directory) {
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--initial-branch=main");
  git(directory, "config", "user.name", "Worktree test");
  git(directory, "config", "user.email", "worktree@example.test");
  await writeFile(path.join(directory, "source.txt"), "first\n");
  git(directory, "add", "source.txt");
  git(directory, "commit", "-m", "first");
}

test("paired Review worktrees keep private builds and shared refs during sync", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paired-worktree-test-"));
  const geckoSource = path.join(root, "source");
  const commSource = path.join(geckoSource, "comm");
  const directory = path.join(root, "review");
  await init(geckoSource);
  await init(commSource);
  t.after(async () => {
    git(commSource, "worktree", "remove", "--force", path.join(directory, "comm"));
    git(geckoSource, "worktree", "remove", "--force", directory);
    await rm(root, { recursive: true, force: true });
  });
  const pair = await ensurePairedWorktrees({ geckoSource, commSource, directory });
  assert.equal(await shareGitRepository(geckoSource, pair.gecko.path), true);
  assert.equal(await shareGitRepository(commSource, pair.comm.path), true);
  await writeWorktreeBuildConfig({ gecko: directory, name: "review" });
  const config = await readFile(path.join(directory, ".mozconfig"), "utf8");
  assert.match(config, /obj-review/);
  assert.match(config, /export SCCACHE_DIRECT=false/);
  await writeFile(path.join(directory, ".mozconfig"), `${config}# Local build option\n`);
  await writeWorktreeBuildConfig({ gecko: directory, name: "review" });
  assert.equal(await readFile(path.join(directory, ".mozconfig"), "utf8"),
    `${config}# Local build option\n`);
  await mkdir(path.join(directory, "obj-review"));
  await writeFile(path.join(directory, "obj-review", "keep.txt"), "private build\n");
  await writeFile(path.join(directory, "source.txt"), "local experiment\n");
  await writeFile(path.join(geckoSource, "source.txt"), "second\n");
  git(geckoSource, "commit", "-am", "second");
  await writeFile(path.join(commSource, "source.txt"), "second\n");
  git(commSource, "commit", "-am", "second");
  const geckoHead = git(geckoSource, "rev-parse", "HEAD");
  const commHead = git(commSource, "rev-parse", "HEAD");
  const result = await syncReviewCheckoutFromWorking({ confirmation: "SYNC REVIEW", graphs: [
    { checkout: "working", repository: "firefox", path: geckoSource },
    { checkout: "working", repository: "comm", path: commSource },
    { checkout: "review", repository: "firefox", path: directory },
    { checkout: "review", repository: "comm", path: pair.comm.path },
  ] });
  assert.equal(git(directory, "rev-parse", "HEAD"), geckoHead);
  assert.equal(git(pair.comm.path, "rev-parse", "HEAD"), commHead);
  assert.equal(git(geckoSource, "branch", "--show-current"), "main");
  assert.equal(git(commSource, "branch", "--show-current"), "main");
  assert.equal(await readFile(path.join(directory, "obj-review", "keep.txt"), "utf8"), "private build\n");
  assert.deepEqual(result.artifacts, { copied: [], removed: [] });
  assert.equal(result.repositories[0].destination.branch, "(detached)");
});
