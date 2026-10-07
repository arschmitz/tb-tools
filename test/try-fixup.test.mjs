import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { run } from "../lib/utils.mjs";
import { createTryMonitorStore, mergeMonitoredTryRuns } from "../commands/graph/try-monitor-store.mjs";
import { getGraphTryRunsForCommit } from "../commands/graph/data.mjs";
import { squashTryFixup, resumeTryFixupSquash } from "../commands/graph/try-fixup.mjs";
import { createTryRepairer, refreshTryRepairSource, validateTryRepairFiles } from "../commands/graph/try-repair.mjs";
const exec = promisify(execFile);

test("repair file validation distinguishes malformed reports from valid no-commit results", () => {
  const valid = { files: ["source.mjs"], targetHash: "a".repeat(40), targetReason: "Source evidence" };
  for (const files of [undefined, [], ["../outside"], ["/absolute"], [".git/config"], [" "]]) {
    assert.throws(() => validateTryRepairFiles({}, { ...valid, files }), /list each source file/);
  }
  assert.throws(() => validateTryRepairFiles({}, { ...valid, targetHash: "" }), /owning commit/);
  assert.equal(validateTryRepairFiles({}, valid), "commit");
  assert.equal(validateTryRepairFiles({}, { files: [], alreadyFixed: true }), "ready-to-submit");
  assert.equal(validateTryRepairFiles({}, { files: [], needsFreshTry: true }), "ready-to-submit");
  assert.equal(validateTryRepairFiles({ assessment: { failures: [{ cause: "unrelated" }] } }, { files: [] }), "passed");
  assert.throws(() => validateTryRepairFiles({ assessment: { failures: [{ cause: "unknown" }] } }, { files: [] }), /list each source file/);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-fixup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  await mkdir(root);
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  const commit = async (file, content, message = file) => {
    await writeFile(path.join(root, file), content);
    await git("add", "--all"); await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await commit("base.txt", "base\n");
  await git("switch", "-c", "patch");
  const parent = await commit("feature.txt", "feature\n", "Bug 123 - Feature\n\nTb-Tools-Id: stable");
  await git("branch", "patch-alias");
  await git("switch", "-c", "child-a");
  await commit("a.txt", "a\n");
  await git("branch", "child-a-alias");
  await commit("a2.txt", "a2\n");
  await git("switch", "-c", "child-b", parent);
  await commit("b.txt", "b\n");
  await git("switch", "-c", "tb-try-fixup/test", parent);
  const fixup = await commit("feature.txt", "fixed\n", "fixup! Bug 123 - Feature\n\nDetailed failure cause and file changes.\n\nTB-Tools-Id: repair-only");
  await git("switch", "patch");
  const store = createTryMonitorStore(path.join(directory, "store"));
  const state = { id: "test", path: root, hash: parent, sourceHash: parent, subject: "Bug 123 - Feature",
    fixupHash: fixup, fixupRef: "refs/heads/tb-try-fixup/test", phase: "passed", attempts: [], nextCheckAt: 0 };
  store.save(state);
  return { git, root, store, state, parent, fixup, commit, directory };
}

test("Amend folds in only fixup changes and preserves forks, aliases, and the parent message", async t => {
  const { git, root, store, fixup, parent, state } = await fixture(t);
  state.phase = "waiting";
  state.attempts = [
    { id: "original", hash: parent, url: "https://example.com/original", status: "patch-failed", createdAt: new Date(1000).toISOString() },
    { id: "fixed", hash: fixup, url: "https://example.com/fixed", status: "waiting", createdAt: new Date(2000).toISOString() },
  ];
  store.save(state);
  const result = await squashTryFixup({ graph: { path: root }, hash: fixup, store });
  const replacement = await git("rev-parse", "patch");
  assert.notEqual(replacement, parent);
  assert.equal(result.hash, replacement);
  assert.equal(await git("rev-parse", "patch-alias"), replacement);
  assert.equal(await git("rev-parse", "child-a-alias^"), replacement);
  assert.equal(await git("rev-parse", "child-a^"), await git("rev-parse", "child-a-alias"));
  assert.equal(await git("rev-parse", "child-b^"), replacement);
  for (const ref of ["patch", "child-a", "child-b"]) assert.equal(await git("show", `${ref}:feature.txt`), "fixed");
  await assert.rejects(git("cat-file", "-e", "child-b:a.txt"));
  await assert.rejects(git("cat-file", "-e", "child-a:b.txt"));
  assert.equal(await git("branch", "--show-current"), "patch");
  assert.equal(await git("status", "--porcelain"), "");
  const message = await git("show", "-s", "--format=%B", "patch");
  assert.equal(message, await git("show", "-s", "--format=%B", parent));
  assert.deepEqual(message.match(/^TB-Tools-Id:.*$/gim), ["Tb-Tools-Id: stable"]);
  const rawMessage = async ref => (await exec("git", ["show", "-s", "--format=format:%B", ref], { cwd: root })).stdout;
  assert.equal(await rawMessage("patch"), await rawMessage(parent));
  assert.equal(store.read("test").sourceHash, replacement);
  assert.equal(store.read("test").fixupHash, "");
  const graph = { path: root };
  const history = mergeMonitoredTryRuns(graph, { runs: [state.attempts[1]] }, store.list());
  const runs = await getGraphTryRunsForCommit({ graph, commit: { hash: replacement, subject: state.subject }, store: history });
  assert.deepEqual(runs.map(item => item.id), ["fixed", "original"]);
  assert.deepEqual(runs.map(item => item.status), ["waiting", "patch-failed"]);
  assert.deepEqual(runs.map(item => item.testedHash), [fixup, parent]);
  assert.ok(runs.every(item => item.hash === replacement && !item.stale));
  assert.equal(store.read("test").attempts.length, 2);
});

test("Amend rejects a Try where no build completed", async t => {
  const { root, git, fixup, store } = await fixture(t);
  const before = await git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const state = store.read("test");
  state.attempts = [{ id: "blocked", hash: fixup, status: "passed", buildValidationBlocked: true }];
  state.phase = "passed";
  store.save(state);
  await assert.rejects(squashTryFixup({ graph: { path: root }, hash: fixup, store }), /No build completed successfully/);
  assert.equal(await git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"), before);
});

test("Amend rejects dirty work and does not change branches", async t => {
  const { git, root, store, fixup, parent } = await fixture(t);
  await writeFile(path.join(root, "feature.txt"), "user edit\n");
  await assert.rejects(squashTryFixup({ graph: { path: root }, hash: fixup, store }), /working changes/);
  assert.equal(await git("rev-parse", "patch"), parent);
  assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "user edit\n");
});

test("Amend conflict leaves every branch and checkout unchanged", async t => {
  const { git, root, store, fixup, parent, commit } = await fixture(t);
  await git("switch", "child-b");
  await commit("feature.txt", "conflicting descendant\n");
  await git("switch", "patch");
  const before = await git("show-ref");
  await assert.rejects(squashTryFixup({ graph: { path: root }, hash: fixup, store }));
  assert.equal(await git("show-ref"), before);
  assert.equal(await git("rev-parse", "HEAD"), parent);
  assert.equal(await git("status", "--porcelain"), "");
});

test("restart recovers an interrupted Amend transaction without losing descendant branches", async t => {
  const { git, root, store, fixup, parent } = await fixture(t);
  await assert.rejects(squashTryFixup({ graph: { path: root }, hash: fixup, store,
    transaction: async () => { throw new Error("process stopped before transaction"); } }), /process stopped/);
  const state = store.read("test");
  assert.equal(state.phase, "squashing");
  assert.equal(await git("rev-parse", "patch"), parent);
  await resumeTryFixupSquash({ state, store });
  assert.equal(await git("rev-parse", "patch"), state.squashedHash);
  assert.equal(await git("rev-parse", "child-b^"), state.squashedHash);
  assert.equal(await git("branch", "--show-current"), "patch");
  assert.equal(await git("show", "-s", "--format=%B", "patch"), await git("show", "-s", "--format=%B", parent));
});

test("repair creates one detailed fixup, recovers its receipt, then amends it and resubmits", async t => {
  const { root, store, state, directory } = await fixture(t);
  const gecko = path.join(directory, "gecko");
  await mkdir(gecko);
  const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
  await git(gecko, "init", "-b", "main");
  await git(gecko, "config", "user.name", "Test");
  await git(gecko, "config", "user.email", "test@example.invalid");
  await git(gecko, "config", "commit.gpgsign", "false");
  await writeFile(path.join(gecko, "mach"), "placeholder\n");
  await git(gecko, "add", "."); await git(gecko, "commit", "-m", "base");
  Object.assign(state, { geckoPath: gecko, geckoHash: await git(gecko, "rev-parse", "HEAD"),
    fixupHash: "", phase: "repairing", repairReceipt: "first", options: { selector: "fuzzy", query: "xpcshell", artifact: false } });
  await git(root, "update-ref", state.fixupRef, state.sourceHash);
  store.save(state);
  const owningParent = state.sourceHash;
  state.sourceHash = state.hash = await git(root, "rev-parse", "child-a");
  state.subject = "Child patch";
  await git(root, "update-ref", state.fixupRef, state.sourceHash);
  store.save(state);
  let calls = 0;
  let submissions = 0;
  let supersedeDuringRepair = false;
  let corrections = 0;
  let lastReport;
  const repairer = createTryRepairer({ store, generate: async ({ state, writable, prompt }) => {
    if (prompt.startsWith("Correct your last JSON repair report:")) {
      corrections++;
      if (corrections === 1) throw new Error("Interrupted report correction");
      assert.match(prompt, /Do not edit code or repeat tests/);
      assert.match(prompt, /exact source paths/);
      assert.equal(await readFile(path.join(state.workspace, "feature.txt"), "utf8"), "repair 1\n");
      return { ...lastReport, files: ["feature.txt"] };
    }
    assert.equal(writable, true);
    calls++;
    if (supersedeDuringRepair) store.save({ ...state, id: "new-version", attempts: [{ id: "new", url: "new", createdAt: new Date(Date.now() + 1000).toISOString() }] });
    await writeFile(path.join(state.workspace, "feature.txt"), `repair ${calls}\n`);
    lastReport = { targetHash: owningParent, targetReason: "feature.txt was introduced in the parent patch.", files: ["feature.txt"], causes: "The event state was read before it was ready.", changes: `feature.txt now contains repair ${calls}; includes all prior changes.`,
      validation: "Source inspection passed.", limits: "Runtime checks await Try." };
    if (calls === 1) delete lastReport.files;
    return lastReport;
  }, runCommand: async command => {
    if (command.cmd === "../mach") {
      submissions++;
      assert.ok(command.args.includes("--no-artifact"));
      assert.ok(command.args.includes("xpcshell"));
      const output = "https://treeherder.mozilla.org/jobs?repo=try&revision=" + "a".repeat(40);
      command.onStdout(output + "\n");
      return output;
    }
    return run(command);
  } });
  await assert.rejects(repairer.repair(state), /Interrupted report correction/);
  Object.assign(state, store.read(state.id));
  assert.ok(state.pendingRepairReport);
  await repairer.repair(state);
  const first = state.fixupHash;
  assert.equal(corrections, 2);
  assert.equal(calls, 1, "Report recovery must not repeat the source repair");
  assert.equal(state.pendingRepairReport, undefined);
  state.fixupAliases = ["refs/heads/tb-try-fixup/alias"];
  await git(root, "update-ref", state.fixupAliases[0], first);

  assert.equal(state.fixupTargetHash, owningParent);
  assert.equal(await git(root, "show", "-s", "--format=%s", first), "fixup! Bug 123 - Feature");
  assert.equal(await git(root, "rev-parse", `${first}^`), state.sourceHash);
  assert.match(await git(root, "show", "-s", "--format=%B", first), /Failure causes:[\s\S]*feature.txt now contains repair 1/);
  await repairer.repair(state); // Simulate a lost checkpoint after commit.
  assert.equal(state.fixupHash, first);
  assert.equal(calls, 1);
  state.repairReceipt = "second";
  await repairer.repair(state);
  assert.notEqual(state.fixupHash, first);
  assert.equal(await git(root, "rev-parse", state.fixupAliases[0]), state.fixupHash);
  assert.equal(await git(root, "rev-parse", `${state.fixupHash}^`), state.sourceHash);
  assert.equal(await git(root, "rev-list", "--count", `${state.sourceHash}..${state.fixupHash}`), "1");
  assert.match(await git(root, "show", "-s", "--format=%B", state.fixupHash), /repair 2/);
  await repairer.submit(state);
  assert.equal(submissions, 1);
  assert.equal(store.read("test").phase, "waiting");
  const published = await git(root, "rev-parse", state.fixupRef);
  state.repairReceipt = "third";
  supersedeDuringRepair = true;
  await assert.rejects(repairer.repair(state), error => error.code === "TRY_SUPERSEDED");
  assert.equal(await git(root, "rev-parse", state.fixupRef), published);
  await assert.rejects(repairer.submit(state), error => error.code === "TRY_SUPERSEDED");
  assert.equal(submissions, 1);
  assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "feature\n");
});

test("Try diagnosis uses separate tested checkouts and resumes its saved conversation", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-isolation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gecko = path.join(directory, "gecko");
  const root = path.join(gecko, "comm");
  const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
  for (const cwd of [gecko, root]) {
    await mkdir(cwd, { recursive: true });
    await git(cwd, "init", "-b", "main");
    await git(cwd, "config", "user.name", "Test");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "commit.gpgsign", "false");
    await writeFile(path.join(cwd, "source.txt"), "tested source\n");
    await git(cwd, "add", "source.txt"); await git(cwd, "commit", "-m", "Tested source");
  }
  const sourceHash = await git(root, "rev-parse", "HEAD");
  const geckoHash = await git(gecko, "rev-parse", "HEAD");
  await writeFile(path.join(root, "source.txt"), "active author edits\n");
  const store = createTryMonitorStore(path.join(directory, "store"));
  const state = id => ({ id, sourceHash, path: root, geckoPath: gecko, geckoHash, subject: "Test", attempts: [{ id: "attempt" }] });
  const first = state("first"), second = state("second");
  store.save(first); store.save(second);
  const calls = [];
  const repairer = createTryRepairer({ store, codexCommand: process.execPath,
    startAgent: async options => {
      calls.push(options);
      assert.notEqual(options.cwd, root);
      assert.equal(options.sandbox, "read-only");
      assert.equal(await readFile(path.join(options.cwd, "source.txt"), "utf8"), "tested source\n");
      return { thread: { id: options.threadId || `thread-${calls.length}` }, client: {
        startTurn: async () => ({ turn: { status: "completed" }, message: JSON.stringify({ failures: [{ id: "job", cause: "unrelated", reason: "baseline match", evidence: ["exact signature"] }] }) }),
        close() {},
      } };
    },
  });
  const evidence = { failures: [{ id: "job" }], baseline: [] };
  await Promise.all([repairer.assess(first, evidence), repairer.assess(second, evidence)]);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  const thread = Object.values(store.read(first.id).aiThreads)[0];
  await repairer.assess(store.read(first.id), evidence);
  assert.equal(calls.at(-1).threadId, thread);
  const resumed = store.read(first.id);
  resumed.attempts.push({ id: "rerun" });
  store.save(resumed);
  await repairer.assess(resumed, evidence);
  assert.equal(calls.at(-1).threadId, thread, "A later failed Try continues the same investigation");
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "active author edits\n");
});

test("analysis survives a rewritten patch and repair source advances without losing evidence", async t => {
  const { assertCurrentTrySource, findCurrentTrySource } = await import("../commands/graph/try-source.mjs");
  const f = await fixture(t);
  f.state.tbToolsId = "stable";
  // Remove other author branches retaining the original patch, but keep its fixup.
  await f.git("branch", "-D", "patch-alias", "child-a", "child-a-alias", "child-b");
  await f.git("commit", "--amend", "-m", "Bug 123 - Revised feature\n\nTB-Tools-Id: stable");
  const current = await f.git("rev-parse", "HEAD");
  assert.notEqual(current, f.parent);
  assert.equal(await findCurrentTrySource(f.state), current);
  await assert.rejects(assertCurrentTrySource(f.state), error => error.code === "TRY_SOURCE_CHANGED");
  let calls = 0;
  const repairer = createTryRepairer({ store: f.store, generate: async () => { calls++; return { failures: [] }; } });
  await repairer.assess(f.state, { failures: [], baseline: [] });
  await assert.rejects(repairer.submit(f.state), /older patch/);
  assert.equal(calls, 1);
  f.store.save(f.state);
  await assert.rejects(squashTryFixup({ graph: { path: f.root }, hash: f.fixup, store: f.store }), /older patch/);
  assert.equal(await f.git("rev-parse", f.state.fixupRef), f.fixup);
  await assertCurrentTrySource({ ...f.state, sourceHash: current });
  f.state.attempts = [{ id: "old", url: "old-run" }];
  await refreshTryRepairSource(f.state, f.store);
  assert.equal(f.state.sourceHash, current);
  assert.equal(f.state.attempts[0].hash, f.parent);
  f.state.attempts[0].createdAt = new Date().toISOString();
  const history = mergeMonitoredTryRuns({ path: f.root }, { runs: [] }, [f.state]);
  const visible = await getGraphTryRunsForCommit({ graph: { path: f.root },
    commit: { hash: current, subject: "Bug 123 - Revised feature" }, store: history });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].isFixup, false);
  assert.equal(visible[0].testedHash, f.parent);

  assert.equal(f.state.fixupHash, "");
  assert.equal(f.state.sourceUpdates[0].fixupHash, f.fixup);
  assert.equal(f.state.fixupExpectedHash, f.fixup);
  assert.equal(await f.git("rev-parse", f.state.fixupRef), f.fixup);

});

test("source lookup uses the active author stack when old versions remain", async t => {
  const { findCurrentTrySource } = await import("../commands/graph/try-source.mjs");
  const f = await fixture(t);
  f.state.tbToolsId = "stable";
  await f.git("switch", "child-a");
  await f.git("branch", "-D", "patch", "patch-alias");
  assert.equal(await findCurrentTrySource(f.state), f.parent);
  await f.git("switch", "-c", "different-version", f.parent);
  await f.git("commit", "--amend", "-m", "Different version\n\nTB-Tools-Id: stable");
  assert.equal(await findCurrentTrySource(f.state), await f.git("rev-parse", "HEAD"));
  const selected = await f.git("rev-parse", "HEAD");
  await f.git("switch", "main");
  assert.equal(await findCurrentTrySource(f.state), selected);
  delete f.state.sourceRef;
  await f.git("switch", "child-a");
  assert.equal(await findCurrentTrySource(f.state), f.parent);
  delete f.state.sourceRef;
  await f.git("switch", "--detach");
  assert.equal(await findCurrentTrySource(f.state), "");
  await f.git("switch", "tb-try-fixup/test");
  assert.equal(await findCurrentTrySource(f.state), "");
});

test("repair evaluates current code and can request a new Try when the fix is already present", async t => {
  const f = await fixture(t);
  const gecko = path.join(f.directory, "gecko");
  await mkdir(gecko);
  const git = async (...args) => (await exec("git", args, { cwd: gecko })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("commit", "--allow-empty", "-m", "Gecko");
  Object.assign(f.state, { tbToolsId: "stable", geckoPath: gecko, geckoHash: await git("rev-parse", "HEAD"),
    phase: "repairing", attempts: [{ id: "old", url: "old-run", hash: f.parent }] });
  await f.git("branch", "-D", "patch-alias", "child-a", "child-a-alias", "child-b");
  await writeFile(path.join(f.root, "feature.txt"), "fixed in current source\n");
  await f.git("commit", "-am", "Bug 123 - Revised feature\n\nTB-Tools-Id: stable");
  const current = await f.git("rev-parse", "HEAD");
  f.store.save(f.state);
  await createTryRepairer({ store: f.store, generate: async ({ state, prompt }) => {
    assert.equal(state.sourceHash, current);
    assert.match(prompt, /Evaluate each proposed repair against the current source/);
    assert.equal(await readFile(path.join(state.workspace, "feature.txt"), "utf8"), "fixed in current source\n");
    await mkdir(path.join(state.workspace, "artifacts"), { recursive: true });
    await writeFile(path.join(state.workspace, "artifacts", "test.log"), "Saved check output");
    return { alreadyFixed: true, files: [], causes: "Old code used stale state", changes: "Current source already fixes the failure",
      validation: "Compared current implementation with the failure", limits: "Fresh Try required" };
  } }).repair(f.state);
  assert.equal(f.state.phase, "ready-to-submit");
  assert.equal(f.state.fixupHash, "");
  assert.equal(f.state.attempts[0].hash, f.parent);
  f.state.attempts[0].createdAt = new Date().toISOString();
  const history = mergeMonitoredTryRuns({ path: f.root }, { runs: [] }, [f.state]);
  const visible = await getGraphTryRunsForCommit({ graph: { path: f.root },
    commit: { hash: current, subject: "Bug 123 - Revised feature" }, store: history });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].isFixup, false);
  assert.equal(visible[0].testedHash, f.parent);

  assert.equal(await f.git("rev-parse", "HEAD"), current);
});


test("parent repair squashes into its owner and keeps child changes and Try history", async t => {
  const { git, root, store, state, parent, commit } = await fixture(t);
  const source = await git("rev-parse", "child-a");
  await git("switch", "tb-try-fixup/test");
  await git("reset", "--hard", source);
  const fixup = await commit("feature.txt", "fixed parent\n", "fixup! Bug 123 - Feature\n\nRepair details.\n\nTB-Tools-Id: ancestor-repair-only");
  await git("switch", "child-a");
  Object.assign(state, { sourceHash: source, hash: source, fixupHash: fixup, fixupTargetHash: parent,
    attempts: [{ id: "before", hash: source, status: "patch-failed" }, { id: "after", hash: fixup, status: "waiting" }] });
  store.save(state);
  await squashTryFixup({ graph: { path: root }, hash: fixup, store });
  const owner = await git("rev-parse", "patch");
  const tip = await git("rev-parse", "child-a");
  assert.notEqual(owner, parent);
  assert.equal(await git("show", "-s", "--format=%B", owner), await git("show", "-s", "--format=%B", parent));
  assert.equal(await git("show", "-s", "--format=%B", tip), await git("show", "-s", "--format=%B", source));
  assert.equal(await git("show", "patch:feature.txt"), "fixed parent");
  await assert.rejects(git("cat-file", "-e", "patch:a.txt"));
  assert.equal(await git("show", "child-a:a.txt"), "a");
  assert.equal(await git("show", "child-a:a2.txt"), "a2");
  assert.equal(await git("rev-parse", "child-a^^"), owner);
  assert.equal(await git("rev-parse", "child-b^"), owner);
  assert.equal(await git("show", "child-b:feature.txt"), "fixed parent");
  assert.equal(await git("rev-parse", "child-a^{tree}"), await git("rev-parse", `${fixup}^{tree}`));
  assert.equal(await git("rev-parse", "tb-try-fixup/test"), tip);
  assert.equal(store.read(state.id).sourceHash, tip);
  assert.deepEqual(store.read(state.id).attempts.map(a => [a.hash, a.status, a.mergedInto]),
    [[source, "patch-failed", tip], [fixup, "waiting", tip]]);
});


test("stable identity preserves source and unsquashed fixup runs on a rewritten patch", async t => {
  const f = await fixture(t);
  f.state.tbToolsId = "stable";
  f.state.attempts = [
    { id: "source", hash: f.parent, url: "original", status: "patch-failed", createdAt: "2026-09-28T00:00:00Z" },
    { id: "fixup", hash: f.fixup, url: "repair", status: "waiting", createdAt: "2026-09-29T00:00:00Z", isFixup: true },
  ];
  await f.git("commit", "--amend", "-m", "Revised feature\n\nTB-Tools-Id: stable");
  const current = await f.git("rev-parse", "HEAD");
  const store = mergeMonitoredTryRuns({ path: f.root }, { runs: [] }, [f.state]);
  const runs = await getGraphTryRunsForCommit({ graph: { path: f.root },
    commit: { hash: current, subject: "Revised feature" }, store });
  assert.deepEqual(runs.map(r => [r.id, r.url, r.testedHash, r.status]),
    [["fixup", "repair", f.fixup, "waiting"], ["source", "original", f.parent, "patch-failed"]]);
  const fixupRuns = await getGraphTryRunsForCommit({ graph: { path: f.root },
    commit: { hash: f.fixup, subject: "fixup! Bug 123 - Feature" }, store });
  assert.deepEqual(fixupRuns.map(r => r.id), ["fixup"]);
  assert.equal(await f.git("rev-parse", f.state.fixupRef), f.fixup);

});

test("parent and child repairs share ownership while unrelated stacks can run", async t => {
  const { acquireTryRepairScope } = await import("../commands/graph/try-repair-coordination.mjs");
  const f = await fixture(t);
  const parent = { ...f.state, id: "parent-worker" };
  const child = { ...f.state, id: "child-worker", sourceHash: await f.git("rev-parse", "child-a") };
  await f.git("switch", "-c", "unrelated", "main");
  const unrelatedHash = await f.commit("other.txt", "other\n", "Other patch\n\nTB-Tools-Id: other");
  const unrelated = { ...f.state, id: "other-worker", sourceHash: unrelatedHash };
  f.store.save(parent); f.store.save(child); f.store.save(unrelated);
  const releaseParent = await acquireTryRepairScope({ state: parent, store: f.store });
  const releaseOther = await acquireTryRepairScope({ state: unrelated, store: f.store });
  let entered = false;
  const next = acquireTryRepairScope({ state: child, store: f.store }).then(release => { entered = true; return release; });
  for (let i = 0; i < 100 && f.store.read(child.id).repairActivity !== "Waiting for related repair"; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.store.read(child.id).repairActivity, "Waiting for related repair");
  assert.equal(entered, false);
  const releasedAt = Date.now();
  releaseParent();
  const releaseChild = await next;
  assert.equal(entered, true);
  assert.ok(Date.now() - releasedAt < 900, "A lock release wakes the child without waiting for polling");
  releaseChild(); releaseOther();
});

test("related repair context follows the published fixup ref after a rebase", async t => {
  const { getRelatedTryRepairs } = await import("../commands/graph/try-repair-coordination.mjs");
  const f = await fixture(t);
  await f.git("switch", "tb-try-fixup/test");
  await f.git("commit", "--amend", "-m", "fixup! Updated repair");
  const published = await f.git("rev-parse", "HEAD");
  f.state.repairReport = { files: ["feature.txt"], causes: "historical report ".repeat(10000) };
  f.store.save(f.state);
  const related = await getRelatedTryRepairs({ ...f.state, id: "child-worker" }, f.store);
  assert.equal(related.length, 1);
  assert.equal(related[0].hash, published);
  assert.notEqual(related[0].hash, f.state.fixupHash);
  assert.equal(related[0].ref, f.state.fixupRef);
  assert.ok(JSON.stringify(related).length < 2000);
  assert.equal(related[0].report, undefined);
  const details = JSON.parse(await readFile(related[0].detailsFile, "utf8"));
  assert.equal(details.report.causes, f.state.repairReport.causes);
});


test("publication rejects a second fixup owner for the same stable patch ID", async t => {
  const { assertTryRepairOwner, getTryRepairOwnerRef } = await import("../commands/graph/try-repair-coordination.mjs");
  const f = await fixture(t);
  const ref = getTryRepairOwnerRef("stable");
  await f.git("update-ref", ref, f.fixup);
  const competing = { ...f.state, id: "child-worker", fixupHash: "" };
  await assert.rejects(assertTryRepairOwner({ state: competing, targetId: "stable", expectedHash: "" }),
    error => error.code === "TRY_REPAIR_OWNED" && error.ownerHash === f.fixup);
  const owner = await assertTryRepairOwner({ state: f.state, targetId: "stable", expectedHash: f.fixup });
  assert.equal(owner.hash, f.fixup);
  assert.equal(await f.git("rev-parse", ref), f.fixup);
  await f.git("update-ref", ref, f.parent);
  // Once the fixup is squashed, the identity can own a new repair.
  assert.equal((await assertTryRepairOwner({ state: competing, targetId: "stable", expectedHash: "" })).hash, f.parent);
});

test("competing publication rolls back its branch when patch ownership is already claimed", async t => {
  const { updateRefs } = await import("../commands/graph/try-fixup.mjs");
  const { getTryRepairOwnerRef } = await import("../commands/graph/try-repair-coordination.mjs");
  const f = await fixture(t);
  const owner = getTryRepairOwnerRef("race-target");
  const first = "refs/heads/tb-try-fixup/first";
  const second = "refs/heads/tb-try-fixup/second";
  const transaction = ref => `start\ncreate ${ref} ${f.fixup}\ncreate ${owner} ${f.fixup}\nprepare\ncommit\n`;
  await updateRefs(f.root, transaction(first));
  await assert.rejects(updateRefs(f.root, transaction(second)));
  assert.equal(await f.git("rev-parse", first), f.fixup);
  await assert.rejects(f.git("rev-parse", "--verify", second));
});
