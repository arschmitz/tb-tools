import { normalizeMachCommand } from "../lib/mach-command.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../lib/utils.mjs";
import { createTaskWorktreeManager } from "../commands/graph/task-worktrees.mjs";
import { createGraphPatchUpdateSession, publishGraphPatchUpdateResult } from "../commands/graph/patch-update.mjs";
import { createGraphPatchReviewSession, prepareGraphPatchReviewSession } from "../commands/graph/patch-review.mjs";
import { createBranchForCommit, getCheckoutGraphSnapshot } from "../commands/graph/actions.mjs";
import { createPatchSessionStore } from "../commands/graph/patch-session-store.mjs";
import { resolveGraphCheckouts } from "../commands/graph/checkouts.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { createImplementationManager } from "../commands/graph/implement.mjs";
import { createTryMonitorStore } from "../commands/graph/try-monitor-store.mjs";
import { prepareMonitoredTry } from "../commands/graph/try-submission.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-worktrees-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gecko = path.join(root, "source");
  const comm = path.join(gecko, "comm");
  for (const cwd of [gecko, comm]) {
    await mkdir(cwd, { recursive: true });
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.invalid"); git(cwd, "config", "commit.gpgsign", "false");
    await writeFile(path.join(cwd, ".gitignore"), "comm/\n.mozconfig\nobj-*\n");
    await writeFile(path.join(cwd, "source.js"), "base\n");
    git(cwd, "add", "."); git(cwd, "commit", "-m", "Base");
    git(cwd, "remote", "add", "origin", cwd); git(cwd, "fetch", "origin", "main");
  }
  const base = git(comm, "rev-parse", "HEAD");
  git(comm, "switch", "-c", "Bug123");
  await writeFile(path.join(comm, "patch.js"), "patch\n");
  git(comm, "add", "."); git(comm, "commit", "-m", "Bug 123 - Patch\n\nDifferential Revision: https://phabricator.services.mozilla.com/D100001");
  const hash = git(comm, "rev-parse", "HEAD");
  const graphs = [{ checkout: "working", repository: "comm", path: comm, label: "comm", knownHashes: new Set([hash]) },
    { checkout: "working", repository: "firefox", path: gecko, label: "firefox" }];
  const manager = createTaskWorktreeManager({ graphs, runCommand: run, directory: name => path.join(root, name) });
  return { root, comm, gecko, hash, base, graphs, manager };
}

test("Review fetches both main tips and excludes unfinished working source", async t => {
  const f = await fixture(t);
  git(f.comm, "switch", "main");
  await writeFile(path.join(f.comm, "landed.js"), "new main\n");
  git(f.comm, "add", "."); git(f.comm, "commit", "-m", "New main");
  const main = git(f.comm, "rev-parse", "HEAD");
  git(f.comm, "switch", "Bug123");
  await writeFile(path.join(f.comm, "patch.js"), "unfinished\n");
  await writeFile(path.join(f.gecko, "gecko-main.js"), "new Firefox main\n");
  git(f.gecko, "add", "."); git(f.gecko, "commit", "-m", "New Firefox main");
  const geckoMain = git(f.gecko, "rev-parse", "HEAD");
  const task = f.manager.configure({ id: "fresh-review" }, "review");
  await f.manager.prepareReview(task);
  assert.equal(git(task.graph.path, "rev-parse", "HEAD"), main);
  assert.equal(git(path.dirname(task.graph.path), "rev-parse", "HEAD"), geckoMain);
  assert.equal(task.reviewMainHash, main);
  assert.equal(await readFile(path.join(f.comm, "patch.js"), "utf8"), "unfinished\n");
});

for (const checkoutMode of ["main", "worktree"]) test(`Update uses the selected ${checkoutMode} checkout`, async t => {
  const f = await fixture(t);
  let prepared;
  const info = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: run,
    prepareTaskBuild: false, taskWorktreeDirectory: name => path.join(f.root, name),
    patchSessionDirectory: path.join(f.root, "sessions"),
    preparePatchUpdateSession: async ({ session }) => {
      prepared = session;
      Object.assign(session, { status: "review", currentHash: f.hash });
    } });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const response = await fetch(new URL("/api/patch-update", info.url), { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", graphIndex: 0, revision: "D100001", mode: "freeform", checkoutMode }) });
  assert.equal(response.status, 200);
  for (let attempt = 0; !prepared && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(prepared);
  assert.equal(Boolean(prepared.managedWorktree), checkoutMode === "worktree");
  assert.equal(prepared.graph.path === f.comm, checkoutMode === "main");
  assert.equal(git(prepared.graph.path, "rev-parse", "HEAD"), f.hash);
});

test("two author worktrees keep source edits unchanged without creating task branches", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.comm, "patch.js"), "primary unfinished edit\n");
  const sourceStatus = git(f.comm, "status", "--porcelain");
  // Advance main while the author's branch is checked out and dirty.
  const baseTree = path.join(f.root, "advance-main");
  git(f.comm, "worktree", "add", baseTree, "main");
  await writeFile(path.join(baseTree, "source.js"), "main advanced\n");
  git(baseTree, "commit", "-am", "Advance main");
  const tasks = [];
  for (let index = 0; index < 2; index++) {
    const session = createGraphPatchUpdateSession({ graph: f.graphs[0], graphIndex: 0, revision: "D100001", aiEnabled: false });
    f.manager.configure(session, "update");
    await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
    assert.equal(git(session.graph.path, "for-each-ref", "--format=%(refname:short)", `refs/heads/${session.graph.branchNamespace}`), "",
      "An author worktree should create no separate branches.");
    assert.equal(git(session.graph.path, "branch", "--show-current"), "", "An author worktree should stay detached.");
    tasks.push(session);
  }
  const secondHash = git(tasks[1].graph.path, "rev-parse", "HEAD");
  await writeFile(path.join(tasks[0].graph.path, "patch.js"), "task one amended\n");
  git(tasks[0].graph.path, "commit", "-am", "Task one amendment");
  assert.equal(git(tasks[1].graph.path, "rev-parse", "HEAD"), secondHash, "Editing one candidate should preserve the other detached checkout.");
  assert.equal(git(f.comm, "rev-parse", "Bug123"), f.hash);
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
  assert.equal(git(f.comm, "status", "--porcelain"), sourceStatus);
  assert.equal(await readFile(path.join(f.comm, "patch.js"), "utf8"), "primary unfinished edit\n");
});

test("saved tasks resume their own worktree and do not use a fresh task's path", async t => {
  const f = await fixture(t);
  const session = f.manager.configure(createGraphPatchUpdateSession({ graph: f.graphs[0], revision: "D100001", aiEnabled: true }), "update");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  session.currentHash = f.hash; session.codexSessionId = "conversation"; session.status = "review";
  const directory = path.join(f.root, "sessions");
  createPatchSessionStore({ directory }).save("update", session);
  const fresh = f.manager.configure(createGraphPatchUpdateSession({ graph: f.graphs[0], revision: "D100001", aiEnabled: true }), "update");
  const restored = createPatchSessionStore({ directory }).load("update", fresh);
  assert.equal(restored.id, session.id); assert.equal(restored.graph.path, session.graph.path);
  assert.notEqual(restored.graph.path, fresh.graph.path);
  assert.equal(restored.graph.branchNamespace, session.graph.branchNamespace);
  assert.equal(restored.codexSessionId, "conversation");
});

test("managed console has one repository graph and no permanent Review selector or sync", () => {
  const graphs = resolveGraphCheckouts({ cwd: "/source/comm", includeReview: true,
    config: { taskWorktrees: true, reviewCheckout: { firefoxPath: "/old-review", commPath: "/old-review/comm" } } });
  assert.equal(graphs.length, 2);
  assert.deepEqual(graphs.map(graph => graph.label), ["comm", "firefox"]);
  const html = buildGraphHtml({ graphs, interactive: { enabled: true, token: "test", aiEnabled: true } });
  assert.doesNotMatch(html, /data-checkout="review"|id="review-sync"/);
});

test("managed API can start two new reviews of the same revision", async t => {
  const f = await fixture(t); const sessions = [];
  const server = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true }, runCommand: run, prepareTaskBuild: false,
    taskWorktreeDirectory: name => path.join(f.root, name),
    preparePatchReviewSession: async ({ session, prepareCheckout }) => {
      await prepareCheckout(session); sessions.push(session); session.status = "reviewing";
    } });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const post = () => fetch(new URL("/api/review", server.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", revision: "D100001", resume: false }) });
  assert.equal((await post()).status, 200); assert.equal((await post()).status, 200);
  for (let attempt = 0; sessions.length < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].graph.path, sessions[1].graph.path);
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
});

test("shared graph Amend uses the saved Try task and preserves primary edits", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "try-test" }, "try");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  const branch = session.graph.branchNamespace + "result";
  git(session.graph.path, "switch", branch);
  const store = createTryMonitorStore(path.join(f.root, "try"));
  const receipt = await prepareMonitoredTry({ graph: session.graph, store, options: {} });
  receipt.release();
  assert.equal(store.read(receipt.state.id).branchNamespace, session.graph.branchNamespace);
  git(session.graph.path, "switch", "--detach");
  await writeFile(path.join(session.graph.path, "patch.js"), "fixed\n");
  git(session.graph.path, "commit", "-am", "fixup! Patch");
  const fixup = git(session.graph.path, "rev-parse", "HEAD");
  const fixupRef = "refs/heads/tb-try-fixup/test";
  git(session.graph.path, "update-ref", fixupRef, fixup);
  git(session.graph.path, "switch", branch);
  Object.assign(receipt.state, { phase: "passed", fixupHash: fixup, fixupRef });
  store.save(receipt.state);
  await writeFile(path.join(f.comm, "patch.js"), "primary edit\n");
  const server = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true }, runCommand: run, prepareTaskBuild: false, backgroundTryStore: store,
    patchSessionDirectory: path.join(f.root, "sessions"), taskWorktreeDirectory: name => path.join(f.root, name) });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const response = await fetch(new URL("/api/amend-try-fixup", server.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", graphIndex: 0, hash: fixup }) });
  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(git(session.graph.path, "rev-parse", "HEAD"), result.hash);
  assert.equal(git(session.graph.path, "show", "HEAD:patch.js"), "fixed");
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
  assert.equal(git(f.comm, "rev-parse", "Bug123"), f.hash);
  assert.equal(await readFile(path.join(f.comm, "patch.js"), "utf8"), "primary edit\n");
});

test("two implementations run concurrently even when the primary checkout is dirty", async t => {
  const f = await fixture(t); const entered = []; const releases = [];
  await writeFile(path.join(f.comm, "patch.js"), "primary work\n");
  const store = createTryMonitorStore(path.join(f.root, "implementations"));
  const manager = createImplementationManager({ graphs: f.graphs, taskManager: f.manager, prepareTaskBuild: false,
    aiEnabled: true, username: "me@example.invalid", store,
    readBug: async id => ({ id: Number(id), assigned_to: "me@example.invalid", is_open: true }),
    readAttachments: async () => [], readComments: async () => [], assignBug: async () => {},
    generate: async ({ state }) => { entered.push(state); await new Promise(resolve => releases.push(resolve)); throw new Error("Test stopped"); },
  });
  t.after(() => { manager.stop(); for (const release of releases) release(); });
  const first = await manager.create({ bugId: 124, base: "current", expectedHead: f.hash });
  const second = await manager.create({ bugId: 125, base: "current", expectedHead: f.hash });
  for (let attempt = 0; entered.length < 2 && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(entered.length, 2);
  assert.notEqual(first.path, second.path); assert.notEqual(first.branch, second.branch);
  assert.equal(first.branch, "Bug-124");
  assert.equal(second.branch, "Bug-125");
  assert.equal(git(first.path, "branch", "--show-current"), first.branch);
  assert.equal(manager.ownsCheckout(), false);
  assert.equal(await readFile(path.join(f.comm, "patch.js"), "utf8"), "primary work\n");
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
  manager.stop(); for (const release of releases) release();
  for (let attempt = 0; !store.list().every(state => state.error) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
});

test("Review imports and restarts use only task branches", async t => {
  const f = await fixture(t);
  const session = createGraphPatchReviewSession({ graphs: f.graphs.map(graph => ({ ...graph, taskWorktree: true })),
    revision: "D100001", aiEnabled: false });
  f.manager.configure(session, "review");
  const sourceRefs = git(f.comm, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/Bug123");
  const patch = "diff --git a/review.js b/review.js\nnew file mode 100644\n--- /dev/null\n+++ b/review.js\n@@ -0,0 +1 @@\n+review\n";
  const runCommand = async command => {
    if (command.cmd !== "moz-phab") return run(command);
    if (command.args.includes("--raw")) return patch;
    assert.ok(command.args.includes("--no-branch"), "moz-phab must not create shared author branches");
    await writeFile(path.join(command.cwd, "review.js"), "review\n");
    git(command.cwd, "add", "review.js");
    git(command.cwd, "commit", "-m", "Bug 124001 - Reviewed patch\n\nDifferential Revision: https://phabricator.services.mozilla.com/D100001");
    return "";
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await prepareGraphPatchReviewSession({ session, prepareCheckout: value => f.manager.prepare(value),
      runCommand, getSnapshot: graph => getCheckoutGraphSnapshot({ graph, runCommand: run }) });
    assert.equal(session.status, "complete", session.error);
    assert.equal(git(f.comm, "rev-parse", session.graph.branchNamespace + "result"), session.currentHash);
    assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
    assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/Bug123"), sourceRefs);
  }
});


test("rebase tasks leave unfinished edits and old review directories in the source checkout", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.comm, "patch.js"), "unfinished edit\n");
  const oldReview = path.join(f.gecko, ".tb-review-old");
  await mkdir(oldReview);
  await writeFile(path.join(oldReview, "large-output"), "old build\n");
  const status = git(f.comm, "status", "--porcelain");
  for (const kind of ["rebase", "interactive-rebase"]) {
    const task = await f.manager.prepareCurrent(kind, f.hash);
    assert.equal(await readFile(path.join(task.graph.path, "patch.js"), "utf8"), "patch\n");
    await assert.rejects(readFile(path.join(path.dirname(task.graph.path), ".tb-review-old", "large-output")), { code: "ENOENT" });
  }
  assert.equal(git(f.comm, "status", "--porcelain"), status);
  assert.equal(await readFile(path.join(oldReview, "large-output"), "utf8"), "old build\n");
});

test("build and test tasks capture current edits without changing the source or another task", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.comm, "patch.js"), "unsaved working edit\n");
  await writeFile(path.join(f.comm, "new-file.js"), "new source\n");
  const first = await f.manager.prepareCurrent("build");
  const second = await f.manager.prepareCurrent("test");
  assert.notEqual(first.graph.path, second.graph.path);
  for (const task of [first, second]) {
    assert.equal(git(task.graph.path, "for-each-ref", "--format=%(refname)", `refs/heads/${task.graph.branchNamespace}`), "");
    assert.equal(await readFile(path.join(task.graph.path, "patch.js"), "utf8"), "unsaved working edit\n");
    assert.equal(await readFile(path.join(task.graph.path, "new-file.js"), "utf8"), "new source\n");
  }
  await writeFile(path.join(first.graph.path, "patch.js"), "first task changed\n");
  assert.equal(await readFile(path.join(second.graph.path, "patch.js"), "utf8"), "unsaved working edit\n");
  assert.equal(await readFile(path.join(f.comm, "patch.js"), "utf8"), "unsaved working edit\n");
});

test("cancelling an implementation stops its local build and never starts AI", async t => {
  const f = await fixture(t);
  let build;
  let aiCalls = 0;
  const taskManager = { ...f.manager, prepareBuild: async session => {
    build = session;
    await new Promise((_, reject) => session.abortController.signal.addEventListener("abort", () => reject(new Error("Build cancelled")), { once: true }));
  } };
  const store = createTryMonitorStore(path.join(f.root, "implementations"));
  const manager = createImplementationManager({ graphs: f.graphs, taskManager, prepareTaskBuild: true,
    aiEnabled: true, username: "me@example.invalid", store,
    readBug: async id => ({ id: Number(id), assigned_to: "me@example.invalid", is_open: true }),
    readAttachments: async () => [], readComments: async () => [], assignBug: async () => {},
    generate: async () => { aiCalls++; throw new Error("AI must not start"); },
  });
  t.after(() => manager.stop());
  const state = await manager.create({ bugId: 126, base: "current", expectedHead: f.hash });
  for (let attempt = 0; !build && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(build);
  manager.cancel(state.id);
  for (let attempt = 0; store.read(state.id).phase !== "cancelled" && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(build.abortController.signal.aborted, true);
  assert.equal(store.read(state.id).phase, "cancelled");
  assert.equal(aiCalls, 0);
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
});


test("a graph rebase reports conflicts without creating worktrees and survives a server restart", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.comm, "source.js"), "patch side\n");
  git(f.comm, "commit", "-am", "Patch side");
  const patchHash = git(f.comm, "rev-parse", "HEAD");
  git(f.comm, "switch", "main");
  await writeFile(path.join(f.comm, "source.js"), "main side\n");
  git(f.comm, "commit", "-am", "Main side");
  const sourceHead = git(f.comm, "rev-parse", "HEAD");
  git(f.comm, "fetch", "origin", "main");
  const options = { graphs: f.graphs, html: "", token: "test", appConfig: { taskWorktrees: true },
    runCommand: async command => {
      assert.ok(!command.args?.includes("worktree"), "A graph rebase must not create a worktree");
      return run(command);
    }, prepareTaskBuild: false, patchSessionDirectory: path.join(f.root, "sessions"),
    taskWorktreeDirectory: name => path.join(f.root, name) };
  const first = await startInteractiveGraphServer(options);
  t.after(() => first.server.listening ? new Promise(resolve => first.server.close(resolve)) : undefined);
  const response = await fetch(new URL("/api/commit-action", first.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", graphIndex: 0, hash: patchHash, action: "rebase", rebaseMode: "stack" }) });
  const payload = await response.json();
  const conflict = payload.rebaseConflict;
  assert.ok(conflict?.id, JSON.stringify(payload));
  assert.equal(conflict.path, f.comm);
  await new Promise(resolve => first.server.close(resolve));
  const second = await startInteractiveGraphServer(options);
  t.after(() => new Promise(resolve => second.server.close(resolve)));
  const restored = await (await fetch(new URL(`/api/rebase/${conflict.id}?token=test`, second.url))).json();
  assert.equal(restored.ok, true); assert.equal(restored.rebaseConflict.path, conflict.path);
  await writeFile(path.join(conflict.path, "source.js"), "resolved sides\n");
  git(conflict.path, "add", "source.js");
  const continued = await (await fetch(new URL(`/api/rebase/${conflict.id}/continue`, second.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test" }) })).json();
  assert.equal(continued.ok, true, continued.error);
  assert.notEqual(git(f.comm, "rev-parse", "HEAD"), sourceHead);
  assert.notEqual(git(f.comm, "rev-parse", "Bug123"), patchHash);
  assert.equal(await readFile(path.join(f.comm, "source.js"), "utf8"), "resolved sides\n");
});


test("Windows runs Mach through Python while Unix keeps the executable script", () => {
  const command = { cmd: "../mach", args: ["build"], cwd: "/task/comm" };
  assert.deepEqual(normalizeMachCommand(command, "win32"), { ...command, cmd: "python", args: ["../mach", "build"] });
  assert.equal(normalizeMachCommand(command, "linux"), command);
  assert.equal(normalizeMachCommand(command, "darwin"), command);
});

test("a task preserves ancestor branches and creates new branches only in its own namespace", async t => {
  const f = await fixture(t);
  git(f.comm, "switch", "-c", "child");
  await writeFile(path.join(f.comm, "child.js"), "child\n");
  git(f.comm, "add", "."); git(f.comm, "commit", "-m", "Bug 124001 - Child");
  const childHash = git(f.comm, "rev-parse", "HEAD");
  const task = f.manager.configure({}, "rebase");
  await f.manager.prepare(task, { commRevision: childHash, cloneBranches: true });
  assert.equal(git(f.comm, "rev-parse", task.graph.branchNamespace + "Bug123"), f.hash);
  const branch = await createBranchForCommit({ graph: task.graph, hash: childHash, runCommand: run });
  assert.equal(branch.createdBranch, task.graph.branchNamespace + "Bug-124001");
  const next = await createBranchForCommit({ graph: task.graph, hash: childHash, runCommand: run });
  assert.equal(next.createdBranch, task.graph.branchNamespace + "Bug-124001_2");
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads/Bug-124001"), "");
});


test("a paused managed update resumes its selected patch and descendants after restart", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.comm, "source.js"), "selected side\n");
  git(f.comm, "commit", "-a", "--amend", "--no-edit");
  git(f.comm, "switch", "-c", "Bug124");
  await writeFile(path.join(f.comm, "child.js"), "child\n");
  git(f.comm, "add", "."); git(f.comm, "commit", "-m", "Bug 124 - Child");
  const originalChild = git(f.comm, "rev-parse", "HEAD");
  git(f.comm, "switch", "Bug123");
  const mainTree = path.join(f.root, "main-worktree");
  git(f.comm, "worktree", "add", mainTree, "main");
  await writeFile(path.join(mainTree, "source.js"), "main side\n");
  git(mainTree, "commit", "-am", "Advance main");
  const options = { graphs: f.graphs, html: "", token: "test", appConfig: { taskWorktrees: true },
    runCommand: run, prepareTaskBuild: false, patchSessionDirectory: path.join(f.root, "sessions"),
    taskWorktreeDirectory: name => path.join(f.root, name), getRustUpstreamStatus: async () => ({ state: "current" }) };
  const post = (server, route, body) => fetch(new URL(route, server.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", ...body }) }).then(response => response.json());
  const first = await startInteractiveGraphServer(options);
  t.after(() => first.server.listening ? new Promise(resolve => first.server.close(resolve)) : undefined);
  const started = await post(first, "/api/patch-update", { graphIndex: 0, revision: "D100001" });
  const wait = async (server, condition) => {
    let value;
    for (let attempt = 0; attempt < 1000; attempt++) {
      value = await (await fetch(new URL(`/api/patch-update/${started.id}?token=test`, server.url))).json();
      if (condition(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(JSON.stringify(value));
  };
  const paused = await wait(first, value => value.rebaseConflict);
  await new Promise(resolve => first.server.close(resolve));
  const second = await startInteractiveGraphServer(options);
  t.after(() => new Promise(resolve => second.server.close(resolve)));
  const restored = await wait(second, value => value.rebaseConflict);
  assert.equal(restored.id, paused.id);
  await writeFile(path.join(restored.rebaseConflict.path, "source.js"), "resolved selected side\n");
  git(restored.rebaseConflict.path, "add", "source.js");
  const continued = await post(second, `/api/rebase/${restored.rebaseConflict.id}/continue`, {});
  assert.equal(continued.ok, true, continued.error);
  const complete = await wait(second, value => value.status === "complete" || value.status === "error");
  assert.equal(complete.status, "complete", complete.error);
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads/tb-task/"), "",
    "A resumed author task should create no separate branches.");
  assert.equal(git(f.comm, "rev-parse", "Bug123"), complete.currentHash, "The resumed rebase should update the existing patch branch.");
  assert.equal(git(f.comm, "rev-parse", "Bug124^"), complete.currentHash, "The child should follow the updated patch.");
  assert.notEqual(git(f.comm, "rev-parse", "Bug124"), originalChild, "The child should be replayed onto the updated patch.");
  assert.equal(await readFile(path.join(f.comm, "source.js"), "utf8"), "resolved selected side\n",
    "The source checkout should contain the resolved patch.");
});

test("Submit uses the selected author branch and creates no task refs or worktrees", async t => {
  const f = await fixture(t);
  git(f.comm, "switch", "main");
  const refsBefore = git(f.comm, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads");
  const treePaths = () => git(f.comm, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "));
  const treesBefore = treePaths();
  let uploaded = false;
  const runCommand = async command => {
    if (command.cmd === "moz-phab") {
      assert.equal(command.cwd, f.comm);
      assert.equal(git(command.cwd, "branch", "--show-current"), "Bug123");
      assert.equal(git(command.cwd, "rev-parse", "HEAD"), f.hash);
      uploaded = true;
      return "https://phabricator.services.mozilla.com/D100001";
    }
    return run(command);
  };
  const server = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true }, runCommand, prepareTaskBuild: false,
    taskWorktreeDirectory: name => path.join(f.root, name) });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const post = (route, body) => fetch(new URL(route, server.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...body }) });
  const response = await post("/api/submit", { graphIndex: 0, hash: f.hash });
  let state = await response.json();
  assert.equal(response.status, 200, state.error);
  const id = state.id;
  for (let attempt = 0; state.status !== "complete" && attempt < 100; attempt++) {
    assert.notEqual(state.status, "error", state.error);
    if (state.prompt) {
      const answer = await post(`/api/submit/${id}/answer`, { promptId: state.prompt.id, answer: false });
      assert.equal(answer.status, 200);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    state = await (await fetch(new URL(`/api/submit/${id}?token=test`, server.url))).json();
  }
  assert.equal(state.status, "complete", state.error);
  assert.equal(uploaded, true);
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"), refsBefore);
  assert.deepEqual(treePaths(), treesBefore);
});

test("review cleanup removes both worktrees and only its own branches", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "cleanup-review" }, "review");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  const other = f.manager.configure({ id: "other-review" }, "review");
  await f.manager.prepare(other, { commRevision: f.hash, cloneBranches: true });
  await writeFile(path.join(session.graph.path, "scratch.js"), "review scratch\n");
  await writeFile(path.join(session.graph.path, "patch.js"), "review commit\n");
  git(session.graph.path, "commit", "-am", "Review experiment");
  session.currentHash = f.hash;
  session.status = "review";
  const store = createPatchSessionStore({ directory: path.join(f.root, "cleanup-sessions") });
  store.save("review", session);
  await f.manager.cleanup(session);
  await mkdir(path.dirname(session.graph.path), { recursive: true });
  await writeFile(path.join(path.dirname(session.graph.path), "leftover-build.txt"), "old build");
  store.save("review", { ...session, status: "complete" });
  assert.equal(store.list(f.graphs, { includeFinished: true }).length, 1);
  await f.manager.cleanup(session);
  store.save("review", session);
  assert.deepEqual(store.list(f.graphs, { includeFinished: true }), []);
  await f.manager.cleanup(session);
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", `refs/heads/${session.graph.branchNamespace}`), "");
  assert.ok(git(f.comm, "for-each-ref", "--format=%(refname)", `refs/heads/${other.graph.branchNamespace}`));
  assert.equal(git(f.comm, "rev-parse", "Bug123"), f.hash);
  for (const source of [f.comm, f.gecko]) assert.ok(!git(source, "worktree", "list", "--porcelain").includes(path.dirname(session.graph.path)));
  await assert.rejects(readFile(path.join(session.graph.path, "scratch.js")), { code: "ENOENT" });
});

test("other task cleanup archives commits and removes its visible task branches", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "cleanup-update" }, "verify");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  const hashes = [];
  for (const cwd of [session.graph.path, path.dirname(session.graph.path)]) {
    await writeFile(path.join(cwd, "source.js"), "task result\n");
    git(cwd, "commit", "-am", "Task result");
    hashes.push(git(cwd, "rev-parse", "HEAD"));
  }
  await f.manager.cleanup(session);
  for (const [index, source] of [f.comm, f.gecko].entries()) {
    assert.equal(git(source, "rev-parse", `refs/tb-tools/task-history/${session.graph.taskId}/retained-head`), hashes[index]);
    assert.ok(!git(source, "worktree", "list", "--porcelain").includes(path.dirname(session.graph.path)));
  }
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", `refs/heads/${session.graph.branchNamespace}`), "");
  const invalid = { graph: { ...session.graph, path: f.comm }, taskKind: "review" };
  await assert.rejects(f.manager.cleanup(invalid), /Refusing to remove/);
});

for (const waitingStatus of ["review", "error", "paused"]) test(`the server keeps a ${waitingStatus} review worktree until cancellation`, async t => {
  const f = await fixture(t);
  let review;
  const server = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: run, prepareTaskBuild: false,
    patchSessionDirectory: path.join(f.root, "sessions"), taskWorktreeDirectory: name => path.join(f.root, name),
    preparePatchReviewSession: async ({ session }) => {
      review = session;
      await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
      session.currentHash = f.hash;
      session.status = waitingStatus;
    } });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const post = (url, body) => fetch(new URL(url, server.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...body }) });
  const started = await (await post("/api/review", { revision: "D100001", resume: false })).json();
  for (let attempt = 0; review?.status !== waitingStatus && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(review.status, waitingStatus);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.ok(await readFile(path.join(review.graph.path, "patch.js")));
  const cancelled = await (await post(`/api/review/${started.id}/cancel`, {})).json();
  assert.equal(cancelled.status, "cancelled");
  for (let attempt = 0; !review.worktreeRemoved && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(review.worktreeRemoved, true);
  await assert.rejects(readFile(path.join(review.graph.path, "patch.js")), { code: "ENOENT" });
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", `refs/heads/${review.graph.branchNamespace}`), "");
});

for (const conflictKind of ["rebase", "import", "import-repeat", "single", "single-clean"]) test(`Review resolves ${conflictKind} conflicts and resumes on main`, async t => {
  const f = await fixture(t);
  git(f.comm, "switch", "main");
  await writeFile(path.join(f.comm, "patch.js"), "main side\n");
  git(f.comm, "add", "."); git(f.comm, "commit", "-m", "Advance main");
  const main = git(f.comm, "rev-parse", "HEAD");
  let review;
  let resumed = false;
  const comments = [];
  const server = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: async command => {
      if (command.cmd !== "moz-phab") return run(command);
      if (!command.args.includes("--raw")) throw new Error("moz-phab exited with 1: missing base");
      if (conflictKind.startsWith("single")) assert.ok(command.args.includes("--skip-dependencies"),
        "The explicit single-patch action should omit dependencies.");
      const patch = {
        body: "Bug 123 - Incoming patch\n\nDifferential Revision: https://phabricator.services.mozilla.com/D100001\n",
        author: "Patch Author <author@example.invalid>", date: 1791763200,
        diff: "diff --git a/patch.js b/patch.js\n--- a/patch.js\n+++ b/patch.js\n@@ -1 +1 @@\n-base\n+incoming side\n",
      };
      if (conflictKind === "single-clean") patch.diff = patch.diff.replace("-base", "-main side").replace("+incoming side", "+resolved side");
      const patches = conflictKind === "import-repeat" ? [
        { ...patch, body: patch.body.replace("D100001", "D100000") },
        { ...patch, diff: patch.diff.replace("-base", "-incoming side").replace("+incoming side", "+next side") },
      ] : [patch];
      await writeFile(command.env.TB_TOOLS_MOZPHAB_REVIEW_EXPORT, JSON.stringify(patches));
      return "raw diff";
    }, prepareTaskBuild: false,
    patchSessionDirectory: path.join(f.root, "sessions"), taskWorktreeDirectory: name => path.join(f.root, name),
    getRustUpstreamStatus: async () => ({ state: "current" }),
    phabWebSession: { publishRevisionReview: async value => comments.push(value) },
    generateRebaseResolution: async prompt => {
      if (conflictKind !== "rebase") assert.match(prompt, /Git applied none of this patch/,
        "The AI should receive the failed raw patch contract.");
      const content = await readFile(path.join(review.graph.path, "patch.js"), "utf8");
      return JSON.stringify({ files: [{ path: "patch.js", edits: [{ startLine: 1,
        endLine: content.trimEnd().split("\n").length, text: "resolved side\n" }] }] });
    },
    preparePatchReviewSession: async ({ session, prepareCheckout, useAppliedCheckout }) => {
      review = session;
      if (useAppliedCheckout) { resumed = true; session.status = "review"; return; }
      await prepareCheckout(session);
      git(session.graph.path, "switch", "--detach", conflictKind === "rebase" ? f.hash : main);
      Object.assign(session, { status: "paused", applyConflict: true, currentHash: f.hash,
        rebaseRequestMessage: "Please rebase onto main.", error: "Patch conflict" });
    } });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const post = async (route, body = {}, expectedStatus = 200) => {
    const response = await fetch(new URL(route, server.url), { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...body }) });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, `The review request should return the expected status: ${JSON.stringify(result)}`);
    return result;
  };
  const started = await post("/api/review", { revision: "D100001", resume: false });
  for (let attempt = 0; review?.status !== "paused" && attempt < 300; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(review.status, "paused", "The review should pause for conflict resolution.");
  assert.deepEqual(comments, [], "The review should not post a comment before resolution.");
  const single = conflictKind.startsWith("single");
  const conflict = await post(`/api/review/${started.id}/${single ? "apply-single" : "resolve-conflicts"}`);
  if (single) assert.equal(conflict.singlePatchOnly, true, "The review should report that parent patches were omitted.");
  if (conflictKind !== "single-clean") {
    assert.ok(conflict.rebaseConflict?.id, "The review should open the shared conflict resolver.");
    await post(`/api/review/${started.id}/apply-single`, {}, 409);
    assert.deepEqual(comments, [], "Conflict resolution should keep Phabricator read-only.");
    let resolution = await post(`/api/rebase/${conflict.rebaseConflict.id}/resolution`);
    if (conflictKind === "import-repeat") {
      const repeated = await post(`/api/rebase/${conflict.rebaseConflict.id}/continue`, { resolutionId: resolution.resolution.id }, 409);
      assert.equal(repeated.rebaseConflict?.id, conflict.rebaseConflict.id,
        "The next conflict should keep the same resolver session.");
      assert.equal(resumed, false, "The review should wait for all stack conflicts.");
      resolution = await post(`/api/rebase/${conflict.rebaseConflict.id}/resolution`);
    }
    await post(`/api/rebase/${conflict.rebaseConflict.id}/continue`, { resolutionId: resolution.resolution.id });
  } else {
    assert.equal(conflict.rebaseConflict, null, "A clean single patch should resume without AI conflict resolution.");
  }
  assert.equal(resumed, true, "The review should resume after resolution.");
  assert.equal(review.worktreeRemoved, undefined, "The review should retain its checkout.");
  git(review.graph.path, "merge-base", "--is-ancestor", main, "HEAD");
  assert.equal(await readFile(path.join(review.graph.path, "patch.js"), "utf8"), "resolved side\n",
    "The review checkout should contain the reviewed resolution.");
  assert.equal(await readFile(path.join(f.comm, "patch.js"), "utf8"), "main side\n",
    "The source checkout should retain main content.");
});

test("Try repair cleanup retains its commits and validates its saved directory", async t => {
  const f = await fixture(t);
  const storeDirectory = path.join(f.root, "try-store");
  await mkdir(storeDirectory);
  const root = path.join(await realpath(storeDirectory), "workspaces", "workflow-0", "gecko");
  await mkdir(path.dirname(root), { recursive: true });
  git(f.gecko, "worktree", "add", "--detach", root, "HEAD");
  const workspace = path.join(root, "comm");
  git(f.comm, "worktree", "add", "--detach", workspace, f.hash);
  await writeFile(path.join(workspace, "patch.js"), "Try repair\n");
  git(workspace, "commit", "-am", "Try repair");
  const hash = git(workspace, "rev-parse", "HEAD");
  const state = { id: "workflow", workspace };
  await f.manager.cleanupTryWorkspace(state, storeDirectory);
  assert.equal(git(f.comm, "rev-parse", "refs/tb-tools/try-history/workflow-0/retained-head"), hash);
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads/tb-try-workspace/"), "");
  await assert.rejects(readFile(path.join(workspace, "patch.js")), { code: "ENOENT" });
  await f.manager.cleanupTryWorkspace(state, storeDirectory);
  git(f.gecko, "worktree", "add", "--detach", root, "HEAD");
  git(f.comm, "worktree", "add", "--detach", workspace, f.hash);
  await f.manager.cleanupTryWorkspace(state, storeDirectory);
  assert.equal(git(f.comm, "worktree", "list", "--porcelain").includes(workspace), false);
  await assert.rejects(readFile(path.join(workspace, "patch.js")), { code: "ENOENT" });
  await assert.rejects(f.manager.cleanupTryWorkspace({ id: "wrong", workspace: f.comm }, storeDirectory), /Refusing to remove/);
});

test("Verify submits a saved candidate through the existing author branch", async t => {
  const f = await fixture(t);
  let verify, uploaded = false;
  const execute = async command => {
    if (command.cmd === "moz-phab") {
      assert.equal(command.cwd, f.comm, "Submit should use the canonical source checkout.");
      assert.equal(git(command.cwd, "branch", "--show-current"), "Bug123", "Submit should use the existing author branch.");
      assert.equal(git(command.cwd, "rev-parse", "HEAD"), verify.currentHash);
      uploaded = true;
      return "https://phabricator.services.mozilla.com/D100001";
    }
    return run(command);
  };
  const server = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: execute, prepareTaskBuild: false,
    taskWorktreeDirectory: name => path.join(f.root, name),
    preparePatchUpdateSession: async ({ session }) => {
      verify = session;
      await writeFile(path.join(session.graph.path, "patch.js"), "Verified change\n");
      git(session.graph.path, "commit", "--amend", "-am", "Bug 123456 - Verified change");
      session.currentHash = git(session.graph.path, "rev-parse", "HEAD");
      session.items = []; session.status = "review";
    } });
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const post = (route, body) => fetch(new URL(route, server.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...body }) });
  await post("/api/patch-update", { revision: "D100001", mode: "verify", graphIndex: 0 });
  for (let attempt = 0; verify?.status !== "review" && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(verify.status, "review");
  assert.equal(git(verify.graph.path, "branch", "--show-current"), "");
  const blocked = await post("/api/submit", { graphIndex: 0, hash: verify.currentHash, patchUpdateSessionId: verify.id });
  assert.equal(blocked.status, 409, "Submit should reject an unpublished task candidate.");
  verify.pendingPublication = { result: { currentHash: verify.currentHash } };
  await publishGraphPatchUpdateResult({ session: verify, runCommand: execute });
  delete verify.pendingPublication;
  const response = await post("/api/submit", { graphIndex: 0, hash: verify.currentHash, patchUpdateSessionId: verify.id });
  let state = await response.json();
  assert.equal(response.status, 200, `Submit should start after publication: ${state.error || ""}`);
  for (let attempt = 0; state.status !== "complete" && attempt < 200; attempt++) {
    assert.notEqual(state.status, "error", state.error);
    if (state.prompt) await post(`/api/submit/${state.id}/answer`, { promptId: state.prompt.id, answer: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    state = await (await fetch(new URL(`/api/submit/${state.id}?token=test`, server.url))).json();
  }
  assert.equal(state.status, "complete", state.error);
  assert.equal(uploaded, true);
  assert.equal(git(f.comm, "rev-parse", "Bug123"), verify.currentHash, "The existing author branch should contain the saved candidate.");
  assert.equal(git(f.comm, "rev-parse", "HEAD"), verify.currentHash, "The source checkout should remain on the author branch.");
});

test("failed reviews keep their checkout and evidence after restart", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "failed-review", revision: "D100001", status: "error", error: "Import failed" }, "review");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  await writeFile(path.join(session.graph.path, "scratch.js"), "failed import scratch\n");
  const directory = path.join(f.root, "sessions");
  const store = createPatchSessionStore({ directory });
  store.save("review", session);
  assert.equal(store.list(f.graphs, { includeFinished: true }).length, 1);
  const info = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: run,
    patchSessionDirectory: directory, taskWorktreeDirectory: name => path.join(f.root, name) });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(store.list(f.graphs, { includeFinished: true }).length, 1);
  assert.equal(await readFile(path.join(session.graph.path, "scratch.js"), "utf8"), "failed import scratch\n");
  for (const source of [f.comm, f.gecko]) {
    assert.ok(git(source, "worktree", "list", "--porcelain").includes(path.dirname(session.graph.path)));
  }
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
  assert.equal(git(f.comm, "status", "--porcelain"), "");
});

test("completed Update diffs remain readable after its task worktree is removed", async t => {
  const f = await fixture(t);
  let session;
  const info = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: run,
    taskWorktreeDirectory: name => path.join(f.root, name),
    preparePatchUpdateSession: async options => {
      session = options.session;
      await writeFile(path.join(session.graph.path, "patch.js"), "updated patch\n");
      git(session.graph.path, "commit", "-am", "Updated patch");
      Object.assign(session, { currentHash: git(session.graph.path, "rev-parse", "HEAD"), status: "complete" });
    } });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const response = await fetch(new URL("/api/patch-update", info.url), { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", graphIndex: 0, revision: "D100001", mode: "freeform" }) });
  assert.equal(response.status, 200);
  for (let attempt = 0; !session?.worktreeRemoved && attempt < 1200; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(session.worktreeRemoved, true);
  const result = await fetch(new URL(`/api/graph/0/diff/${session.currentHash}?token=test&patchUpdateSession=${session.id}`, info.url));
  const diff = await result.json();
  assert.equal(result.status, 200, diff.error);
  assert.equal(diff.ok, true);
  assert.match(diff.text, /updated patch/);
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
});

test("cancelled Update cleanup saves unfinished edits in Git and removes its worktree after restart", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "cancelled-update", revision: "D100001",
    status: "cancelled", cancelled: true, currentHash: f.hash }, "update");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  await writeFile(path.join(session.graph.path, "patch.js"), "unfinished update\n");
  const directory = path.join(f.root, "cancelled-sessions");
  createPatchSessionStore({ directory }).save("update", session);
  let checks = 0;
  const info = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } },
    runCommand: async options => {
      if (options.cwd === session.graph.path && options.args[0] === "status") checks++;
      return run(options);
    },
    patchSessionDirectory: directory, taskWorktreeDirectory: name => path.join(f.root, name) });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  for (let attempt = 0; !checks && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(checks > 0);
  for (let attempt = 0; git(f.comm, "worktree", "list", "--porcelain").includes(session.graph.path) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(readFile(path.join(session.graph.path, "patch.js")), { code: "ENOENT" });
  assert.equal(git(f.comm, "show", `refs/tb-tools/task-history/${session.id}/retained-head:patch.js`), "unfinished update");
  assert.equal(git(f.comm, "worktree", "list", "--porcelain").includes(session.graph.path), false);
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
});


test("retired branch migration preserves history and hides internal refs from the tree", async t => {
  const f = await fixture(t);
  git(f.comm, "update-ref", "refs/heads/tb-task/retired/result", f.hash);
  git(f.comm, "update-ref", "refs/heads/tb-task/active/result", f.hash);
  await f.manager.archiveRetiredBranches(new Set(["active"]));
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", "refs/heads/tb-task/retired/"), "");
  assert.equal(git(f.comm, "rev-parse", "refs/tb-tools/task-history/retired/result"), f.hash);
  assert.equal(git(f.comm, "rev-parse", "refs/heads/tb-task/active/result"), f.hash);
  const privateHash = git(f.comm, "commit-tree", `${f.hash}^{tree}`, "-p", f.hash, "-m", "Private task commit");
  git(f.comm, "update-ref", "refs/heads/tb-task/active/private", privateHash);
  git(f.comm, "update-ref", "refs/heads/tb-try-workspace/private/retained-head", privateHash);
  git(f.comm, "update-ref", "refs/tb-tools/patch-start", f.hash);
  const snapshot = await getCheckoutGraphSnapshot({ graph: f.graphs[0], runCommand: run });
  assert.equal(snapshot.commits.some(commit => commit.refs.some(ref => /tb-task|tb-tools|tb-try-workspace/.test(ref))), false);
  assert.equal(snapshot.commits.some(commit => commit.hash === privateHash), false);
  assert.equal(git(f.comm, "rev-parse", "Bug123"), f.hash);
});


test("restart cleans a saved review already marked handled", async t => {
  const f = await fixture(t);
  const session = f.manager.configure({ id: "handled-review", revision: "D100001", status: "review", currentHash: f.hash }, "review");
  await f.manager.prepare(session, { commRevision: f.hash, cloneBranches: true });
  const directory = path.join(f.root, "handled-sessions");
  createPatchSessionStore({ directory }).save("review", session);
  const handled = path.join(f.root, "handled.json");
  await writeFile(handled, JSON.stringify({ users: { local: { D100001: { id: "D100001", handled: true } } } }));
  const info = await startInteractiveGraphServer({ graphs: f.graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, runCommand: run,
    patchSessionDirectory: directory, reviewHandledPath: handled,
    taskWorktreeDirectory: name => path.join(f.root, name) });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await readFile(path.join(session.graph.path, "patch.js")); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await assert.rejects(readFile(path.join(session.graph.path, "patch.js")), { code: "ENOENT" });
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
});


test("task preparation excludes old review trees and keeps current source files", async t => {
  const f = await fixture(t);
  const oldReview = path.join(f.gecko, ".tb-review-old");
  await mkdir(oldReview);
  await writeFile(path.join(oldReview, "build-output"), "do not copy\n");
  await writeFile(path.join(f.gecko, "new-source.js"), "current source\n");
  const task = await f.manager.prepareCurrent("build");
  await assert.rejects(readFile(path.join(path.dirname(task.graph.path), ".tb-review-old", "build-output")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(path.dirname(task.graph.path), "new-source.js"), "utf8"), "current source\n");
  await f.manager.cleanup(task);
  assert.equal(git(f.gecko, "show", `refs/tb-tools/task-history/${task.id}/retained-head:new-source.js`), "current source");
});

test("worktree sweep removes inactive tasks and preserves active tasks and review source refs", async t => {
  const f = await fixture(t);
  const active = await f.manager.prepareCurrent("build");
  const ended = await f.manager.prepareCurrent("build");
  await f.manager.cleanupInactiveWorktrees(new Set([active.id]));
  assert.ok(git(f.comm, "worktree", "list", "--porcelain").includes(active.graph.path));
  assert.equal(git(f.comm, "worktree", "list", "--porcelain").includes(ended.graph.path), false);
  const review = f.manager.configure({ id: "00000000-0000-4000-8000-000000000001" }, "review");
  await f.manager.prepare(review);
  git(f.comm, "update-ref", `refs/tb-tools/task-history/${review.id}/retained-head`, f.hash);
  git(f.comm, "update-ref", `refs/heads/${review.graph.branchNamespace}result`, f.hash);
  await f.manager.cleanup(review);
  assert.equal(git(f.comm, "for-each-ref", "--format=%(refname)", `refs/tb-tools/task-history/${review.id}/`, `refs/heads/${review.graph.branchNamespace}`), "");
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash);
});


test("an inactive sweep waits for checkout preparation to finish", async t => {
  const f = await fixture(t);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = createTaskWorktreeManager({ graphs: f.graphs, directory: name => path.join(f.root, name),
    runCommand: async options => {
      if (options.args[0] === "worktree" && options.args[1] === "add") { enter(); await gate; }
      return run(options);
    },
  });
  const operation = manager.prepareCurrent("build");
  await entered;
  await manager.cleanupInactiveWorktrees();
  release();
  const session = await operation;
  assert.ok(git(f.comm, "worktree", "list", "--porcelain").includes(session.graph.path));
  await manager.cleanupInactiveWorktrees();
  assert.equal(git(f.comm, "worktree", "list", "--porcelain").includes(session.graph.path), false);
});

test("manual Try pins the isolated source for submission recovery", async t => {
  const { findCurrentTrySource } = await import("../commands/graph/try-source.mjs");
  const { getGraphTryTarget } = await import("../commands/graph/actions.mjs");
  const f = await fixture(t);
  const task = await f.manager.prepareCurrent("try");
  const target = await getGraphTryTarget({ graph: task.graph, runCommand: run });
  const store = createTryMonitorStore(path.join(f.root, "try-store"));
  const tracking = await prepareMonitoredTry({ graph: task.graph, target, store, runCommand: run });
  tracking.release();
  assert.equal(tracking.state.sourceRef, `refs/heads/${task.graph.branchNamespace}result`, "A manual Try should retain its task source reference.");
  assert.equal(await findCurrentTrySource(tracking.state), tracking.state.sourceHash, "Submission recovery should find the exact isolated patch source.");
  assert.equal(git(f.comm, "rev-parse", "HEAD"), f.hash, "Try tracking should preserve the primary checkout commit.");
  assert.equal(git(f.comm, "status", "--porcelain"), "", "Try tracking should preserve primary source files.");
});
