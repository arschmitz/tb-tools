import { normalizeMachCommand } from "../lib/mach-command.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../lib/utils.mjs";
import { createTaskWorktreeManager } from "../commands/graph/task-worktrees.mjs";
import { createGraphPatchUpdateSession, prepareGraphPatchUpdateSession } from "../commands/graph/patch-update.mjs";
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

test("two updates of the same patch keep source changes and other task branches unchanged", async t => {
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
    assert.ok(git(session.graph.path, "for-each-ref", "--format=%(refname:short)", `refs/heads/${session.graph.branchNamespace}`), "task branches must be visible");
    await prepareGraphPatchUpdateSession({ session, graphs: f.manager.taskGraphs(session),
      getRustUpstreamStatus: async () => ({ state: "current" }),
      getSnapshot: graph => getCheckoutGraphSnapshot({ graph, runCommand: run }), runCommand: run });
    assert.equal(session.status, "complete", session.error);
    assert.notEqual(session.currentHash, f.hash);
    assert.match(session.branch, new RegExp(`^${session.graph.branchNamespace}`));
    tasks.push(session);
  }
  const secondBranch = tasks[1].branch;
  const secondHash = git(f.comm, "rev-parse", secondBranch);
  await writeFile(path.join(tasks[0].graph.path, "patch.js"), "task one amended\n");
  git(tasks[0].graph.path, "commit", "-am", "Task one amendment");
  assert.equal(git(f.comm, "rev-parse", secondBranch), secondHash);
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


test("build and test tasks capture current edits without changing the source or another task", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.comm, "patch.js"), "unsaved working edit\n");
  await writeFile(path.join(f.comm, "new-file.js"), "new source\n");
  const first = await f.manager.prepareCurrent("build");
  const second = await f.manager.prepareCurrent("test");
  assert.notEqual(first.graph.path, second.graph.path);
  for (const task of [first, second]) {
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


test("an isolated rebase survives a server restart and continues without moving source branches", async t => {
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
    runCommand: run, prepareTaskBuild: false, patchSessionDirectory: path.join(f.root, "sessions"),
    taskWorktreeDirectory: name => path.join(f.root, name) };
  const first = await startInteractiveGraphServer(options);
  t.after(() => first.server.listening ? new Promise(resolve => first.server.close(resolve)) : undefined);
  const response = await fetch(new URL("/api/commit-action", first.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", graphIndex: 0, hash: patchHash, action: "rebase", rebaseMode: "stack" }) });
  const payload = await response.json();
  const conflict = payload.rebaseConflict;
  assert.ok(conflict?.id, JSON.stringify(payload));
  assert.notEqual(conflict.path, f.comm);
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
  assert.equal(git(f.comm, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(f.comm, "rev-parse", "Bug123"), patchHash);
  assert.equal(await readFile(path.join(f.comm, "source.js"), "utf8"), "main side\n");
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
  const selectedHash = git(f.comm, "rev-parse", "HEAD");
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
  const taskId = path.basename(path.dirname(complete.worktree)).replace(/^task-/, "");
  const child = `tb-task/${taskId}/Bug124`;
  git(f.comm, "merge-base", "--is-ancestor", complete.currentHash, child);
  assert.equal(git(f.comm, "rev-parse", "Bug123"), selectedHash);
  assert.equal(git(f.comm, "rev-parse", "Bug124"), originalChild);
  assert.equal(await readFile(path.join(f.comm, "source.js"), "utf8"), "selected side\n");
});
