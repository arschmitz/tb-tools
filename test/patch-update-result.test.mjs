import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureGraphPatchSource } from "../commands/graph/branches.mjs";
import { run } from "../lib/utils.mjs";
import { createTaskWorktreeManager } from "../commands/graph/task-worktrees.mjs";
import { amendGraphPatchUpdateChanges, findGraphPatchCommit, publishGraphPatchUpdateResult } from "../commands/graph/patch-update.mjs";
import { createPatchSessionStore } from "../commands/graph/patch-session-store.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) {
  let root;
  t.after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  root = await mkdtemp(path.join(os.tmpdir(), "patch-result-"));
  const gecko = path.join(root, "source"), comm = path.join(gecko, "comm");
  for (const cwd of [gecko, comm]) {
    await mkdir(cwd, { recursive: true });
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    await writeFile(path.join(cwd, ".gitignore"), "comm/\n.mozconfig\nobj-*\n");
    await writeFile(path.join(cwd, "base"), "base\n");
    git(cwd, "add", "."); git(cwd, "commit", "-m", "Base");
    git(cwd, "remote", "add", "origin", cwd); git(cwd, "fetch", "origin", "main");
  }
  git(comm, "switch", "-c", "Bug-123");
  await writeFile(path.join(comm, "patch"), "original\n");
  git(comm, "add", "."); git(comm, "commit", "-m", "Bug 123 - Patch\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456");
  const hash = git(comm, "rev-parse", "HEAD");
  const graphs = [{ path: comm, checkout: "working", repository: "comm", label: "comm", knownHashes: new Set([hash]) },
    { path: gecko, checkout: "working", repository: "firefox", label: "firefox" }];
  const manager = createTaskWorktreeManager({ graphs, runCommand: run, directory: name => path.join(root, name) });
  return { root, comm, hash, graphs, manager };
}
async function candidate(f, id = "author") {
  const session = f.manager.configure({ id, revision: "D123456", mode: "verify", aiEnabled: true, status: "review" }, "verify");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  session.originalHash = f.hash;
  await writeFile(path.join(session.graph.path, "patch"), "accepted\n");
  git(session.graph.path, "commit", "--amend", "--no-edit", "-a");
  session.currentHash = git(session.graph.path, "rev-parse", "HEAD");
  session.pendingPublication = { result: { currentHash: session.currentHash } };
  return session;
}

test("an author worktree publishes one existing patch branch and preserves descendant forks", async t => {
  const f = await fixture(t);
  const children = [];
  for (const name of ["Bug-124", "Bug-125"]) {
    git(f.comm, "switch", "-c", name, f.hash);
    await writeFile(path.join(f.comm, name), name);
    git(f.comm, "add", "."); git(f.comm, "commit", "-m", name);
    children.push({ name, hash: git(f.comm, "rev-parse", "HEAD") });
  }
  git(f.comm, "switch", "Bug-123");
  const branches = git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads");
  const session = await candidate(f);
  assert.equal(git(session.graph.path, "branch", "--show-current"), "", "The author worktree should remain detached.");
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads"), branches,
    "Preparing an author worktree should create no separate branches.");
  await publishGraphPatchUpdateResult({ session, runCommand: run });
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), session.currentHash, "Keeping the candidate should advance the existing patch branch.");
  assert.equal(git(f.comm, "branch", "--show-current"), "Bug-123", "Publication should restore the source checkout branch.");
  assert.equal(await readFile(path.join(f.comm, "patch"), "utf8"), "accepted\n",
    "Publication should refresh the clean source checkout files.");
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads"), branches,
    "Publication should preserve the same set of existing branches.");
  for (const child of children) {
    assert.equal(git(f.comm, "rev-parse", `${child.name}^`), session.currentHash, "Each fork should retain the updated patch as its direct parent.");
    assert.equal(git(f.comm, "diff", `${child.hash}^`, child.hash, "--", child.name),
      git(f.comm, "diff", `${child.name}^`, child.name, "--", child.name), "Each fork should preserve its patch content.");
  }
  assert.equal(git(session.graph.path, "rev-parse", "HEAD"), session.currentHash, "The task should return to its saved patch candidate.");
});

for (const cause of ["dirty", "moved"]) test(`publication preserves the candidate when the source is ${cause}`, async t => {
  const f = await fixture(t), session = await candidate(f);
  if (cause === "dirty") await writeFile(path.join(f.comm, "patch"), "unsaved source\n");
  else {
    await writeFile(path.join(f.comm, "patch"), "another update\n");
    git(f.comm, "commit", "-am", "Another update");
  }
  const before = git(f.comm, "rev-parse", "Bug-123");
  await assert.rejects(publishGraphPatchUpdateResult({ session, runCommand: run }), /source.*(?:changed|uncommitted)/i,
    "A changed source should block publication without overwriting work.");
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), before, "A failed publication should preserve the canonical branch.");
  assert.equal(git(session.graph.path, "show", `${session.currentHash}:patch`), "accepted", "A failed publication should preserve the candidate content.");
  assert.ok(session.pendingPublication, "A failed publication should retain resumable publication state.");
  const store = createPatchSessionStore({ directory: path.join(f.root, "sessions") });
  store.save("update", session);
  const [restored] = store.list(f.graphs);
  assert.equal(restored.session.pendingPublication.result.currentHash, session.currentHash,
    "Restart should retain the pending candidate hash.");
});

test("canonical patch lookup excludes a newer private task version", async t => {
  const f = await fixture(t), session = await candidate(f);
  git(f.comm, "update-ref", "refs/heads/tb-task/legacy/result", session.currentHash);
  const found = await findGraphPatchCommit({ graph: f.graphs[0], revision: "D123456", newest: true, runCommand: run });
  assert.equal(found.hash, f.hash, "Canonical lookup should select the author branch instead of private task history.");
});


test("main checkout acceptance updates the existing patch and replays its child", async t => {
  const f = await fixture(t);
  git(f.comm, "switch", "-c", "Bug-124");
  await writeFile(path.join(f.comm, "child"), "child\n");
  git(f.comm, "add", "."); git(f.comm, "commit", "-m", "Child");
  git(f.comm, "switch", "Bug-123");
  const session = { id: "main-author", graph: f.graphs[0], repositoryPath: f.comm, aiEnabled: true,
    currentHash: f.hash, patchSourceHash: f.hash,
    patchSourceRefs: await captureGraphPatchSource({ graph: f.graphs[0], hash: f.hash, runCommand: run }),
    commitMessage: git(f.comm, "show", "-s", "--format=%B", f.hash),
    items: [{ id: "change", state: "handled", changeApplied: true, changeAccepted: true }] };
  await writeFile(path.join(f.comm, "patch"), "accepted in main\n");
  await amendGraphPatchUpdateChanges({ session, runCommand: run });
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), session.currentHash, "Main acceptance should update the existing patch branch.");
  assert.equal(git(f.comm, "rev-parse", "Bug-124^"), session.currentHash, "The dependent branch should follow the updated main-checkout patch.");
  assert.equal(git(f.comm, "branch", "--show-current"), "Bug-123", "Main acceptance should restore the same author branch.");
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads/tb-task/"), "", "Main acceptance should create no task branches.");
});

test("a ref race aborts the whole source transaction and preserves the candidate", async t => {
  const f = await fixture(t), session = await candidate(f);
  const other = git(f.comm, "rev-parse", "main");
  let raced = false;
  const execute = async command => {
    if (!raced && command.input && command.args[0] === "update-ref") {
      raced = true;
      git(f.comm, "update-ref", "refs/heads/Bug-123", other, f.hash);
    }
    return run(command);
  };
  await assert.rejects(publishGraphPatchUpdateResult({ session, runCommand: execute }), /cannot lock ref/,
    "Concurrent ref changes should abort publication.");
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), other, "Publication should preserve the concurrent branch change.");
  assert.equal(git(session.graph.path, "rev-parse", "HEAD"), session.currentHash, "The failed transaction should retain the candidate.");
});

test("a committed publication can retry checkout restoration without publishing twice", async t => {
  const f = await fixture(t), session = await candidate(f);
  let failed = false;
  const execute = async command => {
    if (!failed && command.cwd === f.comm && command.args.join(" ") === "switch Bug-123") {
      failed = true;
      throw new Error("Simulated checkout restoration failure");
    }
    return run(command);
  };
  await assert.rejects(publishGraphPatchUpdateResult({ session, runCommand: execute }), /restoration failure/,
    "A checkout restoration failure should leave publication retryable.");
  assert.equal(session.pendingPublication.published, true, "The retry state should record the committed ref transaction.");
  await publishGraphPatchUpdateResult({ session, runCommand: execute });
  assert.equal(git(f.comm, "branch", "--show-current"), "Bug-123", "Retry should restore the source checkout branch.");
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), session.currentHash, "Retry should preserve the already published patch.");
});

test("an already current patch can complete publication without changing refs", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "current", status: "review", revision: "D123456" }, "verify");
  await f.manager.prepare(session, { commRevision: f.hash });
  session.currentHash = f.hash;
  session.pendingPublication = { result: { currentHash: f.hash }, replay: {
    branchUpdates: [{ branch: "Bug-123", originalHash: f.hash, hash: f.hash }] } };
  await publishGraphPatchUpdateResult({ session, runCommand: run });
  assert.equal(session.publishedHash, f.hash, "An unchanged patch should complete without a ref update.");
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), f.hash, "An unchanged patch should retain its existing branch hash.");
});

test("restart recognizes a committed transaction from the saved precommit journal", async t => {
  const f = await fixture(t), session = await candidate(f);
  const store = createPatchSessionStore({ directory: path.join(f.root, "sessions") });
  session.persistPatchState = () => {
    if (!session.pendingPublication.published) store.save("update", session);
  };
  await publishGraphPatchUpdateResult({ session, runCommand: run });
  const [saved] = store.list(f.graphs);
  const restored = saved.session;
  assert.notEqual(restored.patchSourceHash, session.publishedHash, "The simulated crash should leave the precommit source snapshot on disk.");
  await publishGraphPatchUpdateResult({ session: restored, runCommand: run });
  assert.equal(restored.publishedHash, session.currentHash, "Restart should recognize this task's already committed transaction.");
  assert.equal(git(f.comm, "branch", "--show-current"), "Bug-123", "Restart recovery should leave the source on its existing branch.");
});

test("a descendant conflict survives restart and publishes through the shared resolver", async t => {
  const { startInteractiveGraphServer } = await import("../commands/graph/server.mjs");
  const f = await fixture(t);
  git(f.comm, "switch", "-c", "Bug-124");
  await writeFile(path.join(f.comm, "patch"), "child version\n");
  git(f.comm, "commit", "-am", "Child changes the same line");
  const child = git(f.comm, "rev-parse", "HEAD");
  git(f.comm, "switch", "Bug-123");
  const servers = [];
  t.after(async () => { for (const info of servers) if (info.server.listening) await new Promise(resolve => info.server.close(resolve)); });
  let session;
  const options = { graphs: f.graphs, html: "", token: "test", runCommand: run,
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, prepareTaskBuild: false,
    patchSessionDirectory: path.join(f.root, "sessions"), taskWorktreeDirectory: name => path.join(f.root, name),
    preparePatchUpdateSession: async ({ session: value }) => {
      session = value;
      value.commitMessage = git(f.comm, "show", "-s", "--format=%B", f.hash);
      value.currentHash = f.hash;
      value.items = [{ id: "change", state: "handled", changeApplied: true, changeAccepted: true }];
      await writeFile(path.join(value.graph.path, "patch"), "accepted\n");
      value.status = "review";
    } };
  const start = async () => { const info = await startInteractiveGraphServer(options); servers.push(info); return info; };
  const post = (info, route, body = {}) => fetch(new URL(route, info.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...body }) });
  const first = await start();
  await post(first, "/api/patch-update", { graphIndex: 0, revision: "D123456", mode: "verify" });
  for (let attempt = 0; session?.status !== "review" && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(session?.status, "review", "The Verify fixture should prepare its candidate.");
  const response = await post(first, `/api/patch-update/${session.id}/amend`);
  const failed = await response.json();
  assert.ok(failed.rebaseConflict, "The failed save should expose the shared rebase conflict resolver.");
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), f.hash, "A conflict should leave the source patch branch unchanged.");
  assert.equal(git(f.comm, "rev-parse", "Bug-124"), child, "A conflict should leave the source child branch unchanged.");
  await new Promise(resolve => first.server.close(resolve));
  const second = await start();
  await writeFile(path.join(session.graph.path, "patch"), "accepted with child\n");
  git(session.graph.path, "add", "patch");
  const continued = await post(second, `/api/rebase/${failed.rebaseConflict.id}/continue`);
  const result = await continued.json();
  assert.equal(result.ok, true, `The shared resolver should finish publication after restart: ${result.error || ""}`);
  const state = await (await fetch(new URL(`/api/patch-update/${session.id}?token=test`, second.url))).json();
  assert.equal(git(f.comm, "rev-parse", "Bug-123"), state.currentHash, "Conflict recovery should advance the existing patch branch.");
  assert.equal(git(f.comm, "rev-parse", "Bug-124^"), state.currentHash, "Conflict recovery should replay the child onto the updated patch.");
  assert.equal(git(f.comm, "show", "Bug-124:patch"), "accepted with child", "Conflict recovery should preserve the resolved child content.");
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads/tb-task/"), "", "Conflict recovery should create no task branches.");
});
