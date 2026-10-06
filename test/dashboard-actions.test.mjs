import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareDashboardPatchAction } from "../commands/graph/dashboard-actions.mjs";
const exec = promisify(execFile);

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dashboard-action-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await git("config", "commit.gpgsign", "false");
  const commit = async (file, message = file) => {
    await writeFile(path.join(root, file), file + "\n");
    await git("add", file);
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await commit("base");
  await git("remote", "add", "origin", root);
  await git("fetch", "origin", "main");
  await git("switch", "-c", "patch");
  const patch = await commit("patch", "Bug 1 - Patch\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123");
  await git("switch", "-c", "child-a");
  await commit("child-a");
  await git("switch", "-c", "grandchild");
  await commit("grandchild");
  await git("switch", "-c", "child-b", "patch");
  await commit("child-b");
  await git("switch", "main");
  const main = await commit("upstream");
  await git("switch", "child-b");
  const graph = { path: root, label: "comm", repository: "comm", checkout: "working", knownHashes: new Set() };
  return { root, git, patch, main, graph };
}

test("dashboard rebase moves the patch and every child fork onto fetched main", async t => {
  const { graph, git, main } = await fixture(t);
  const { result } = await prepareDashboardPatchAction({ graphs: [graph], revision: "D123", action: "rebase" });
  assert.equal(result.rebasedCount, 4);
  const patch = await git("rev-parse", "patch");
  assert.equal(await git("rev-parse", "patch^"), main);
  assert.equal(await git("rev-parse", "child-a^"), patch);
  assert.equal(await git("rev-parse", "child-b^"), patch);
  assert.equal(await git("rev-parse", "grandchild^"), await git("rev-parse", "child-a"));
});

test("CI Verify selects the exact working patch without rebasing or starting AI", async t => {
  const { graph, git, patch } = await fixture(t);
  const child = await git("rev-parse", "child-b");
  const result = await prepareDashboardPatchAction({ graphs: [{ ...graph, checkout: "review" }, graph], revision: "D123", action: "ci-verify" });
  assert.equal(result.graphIndex, 1);
  assert.equal(await git("rev-parse", "HEAD"), patch);
  assert.equal(await git("rev-parse", "child-b"), child);
});

test("dashboard actions preserve dirty changes and reject missing patches", async t => {
  const { graph, git, root } = await fixture(t);
  const head = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "unsaved"), "keep me");
  for (const action of ["rebase", "ci-verify"]) {
    await assert.rejects(prepareDashboardPatchAction({ graphs: [graph], revision: "D123", action }), /Commit or save/);
  }
  assert.equal(await git("rev-parse", "HEAD"), head);
  await rm(path.join(root, "unsaved"));
  await assert.rejects(prepareDashboardPatchAction({ graphs: [graph], revision: "D999", action: "ci-verify" }), /not found/);
  assert.equal(await git("rev-parse", "HEAD"), head);
});
