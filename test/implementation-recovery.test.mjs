import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoverImplementationSource } from "../commands/graph/implementation-recovery.mjs";
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-source-recovery-"));
  const comm = path.join(root, "comm"); await mkdir(comm);
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
  for (const cwd of [root, comm]) {
    await git(cwd, "init", "-b", "main");
    if (cwd === root) await writeFile(path.join(root, ".git", "info", "exclude"), "comm/\n");
    await git(cwd, "config", "user.name", "Test");
    await git(cwd, "config", "user.email", "test@example.invalid");
    await git(cwd, "config", "commit.gpgsign", "false");
    await writeFile(path.join(cwd, "base.txt"), "base\n");
    await git(cwd, "add", "base.txt"); await git(cwd, "commit", "-m", "Base");
  }
  await git(comm, "switch", "-c", "task");
  for (let i = 1; i <= 3; i++) {
    await writeFile(path.join(comm, `calendar-${i}.txt`), `Calendar ${i}\n`);
    await git(comm, "add", `calendar-${i}.txt`); await git(comm, "commit", "-m", `Calendar ${i}`);
  }
  const state = { path: comm, branch: "task", commitHash: await git(comm, "rev-parse", "HEAD") };
  const options = { commRevision: "main", geckoRevision: "main",
    runCommand: async ({ cwd, args }) => git(cwd, ...args) };
  return { root, comm, state, options, git };
}

test("current paired source needs no switch or rebase", async t => {
  const f = await fixture(t);
  const result = await recoverImplementationSource(f.state, f.options);
  assert.equal(result.changed, false);
  assert.equal(await f.git(f.comm, "rev-parse", "HEAD"), f.state.commitHash);
});

test("console updates paired source and preserves all three Calendar commits", async t => {
  const f = await fixture(t);
  const oldGecko = await f.git(f.root, "rev-parse", "HEAD");
  await writeFile(path.join(f.root, "upstream.txt"), "Gecko update\n");
  await f.git(f.root, "add", "upstream.txt"); await f.git(f.root, "commit", "-m", "Gecko update");
  const targetGecko = await f.git(f.root, "rev-parse", "HEAD");
  await f.git(f.root, "switch", "--detach", oldGecko);
  await f.git(f.comm, "switch", "main");
  await writeFile(path.join(f.comm, "upstream.txt"), "comm update\n");
  await f.git(f.comm, "add", "upstream.txt"); await f.git(f.comm, "commit", "-m", "comm update");
  await f.git(f.comm, "switch", "task");
  const result = await recoverImplementationSource(f.state, f.options);
  assert.equal(result.changed, true);
  assert.equal(await f.git(f.root, "rev-parse", "HEAD"), targetGecko);
  assert.equal(await f.git(f.comm, "rev-list", "--count", "main..HEAD"), "3");
  assert.equal(await f.git(f.comm, "diff", "--stat", "main", "HEAD"), await f.git(f.comm, "diff", "--stat", `${f.state.commitHash}~3`, f.state.commitHash));
  assert.equal(await f.git(f.comm, "status", "--porcelain"), "");
});

for (const legacy of [false, true, "handoff"]) test(`saved console recovery rebuilds before verification (legacy pause: ${legacy})`, async t => {
  const { createImplementationManager } = await import("../commands/graph/implement.mjs");
  const { createTryMonitorStore } = await import("../commands/graph/try-monitor-store.mjs");
  const f = await fixture(t);
  await f.git(f.comm, "update-ref", "refs/remotes/origin/main", "main");
  await f.git(f.root, "update-ref", "refs/remotes/origin/main", "main");
  const store = createTryMonitorStore(path.join(f.root, ".git", "implement"));
  const monitorStore = createTryMonitorStore(path.join(f.root, ".git", "monitor"));
  const state = { ...f.state, id: "recovery", bugId: "123", repositoryPath: f.comm,
    phase: "recovering-build", reports: [], instructions: [], comments: [], buildRecoveryPending: true };
  if (legacy === true) {
    state.phase = "implementing";
    state.errorKind = "input-required";
    state.tryStatus = "build-blocked";
    state.error = `Use the console to update paired Gecko to ${"a".repeat(40)} and rebase the Calendar commits.`;
    delete state.buildRecoveryPending;
  }
  if (legacy === "handoff") { state.phase = "implementing"; delete state.buildRecoveryPending; }
  store.save(state);
  const actions = [];
  const manager = createImplementationManager({ taskManager: { sourceGraph: { path: f.comm },
    prepareBuild: async () => { actions.push("build"); } }, aiEnabled: true, taskId: state.id,
    store, monitorStore, runCommand: f.options.runCommand,
    generate: async ({ role }) => {
      if (legacy === "handoff" && role === "implement") return { complete: false, workflowRequest: { kind: "recover-build" } };
      actions.push(role);
      return { complete: true, summary: "Verified", title: "Calendar", description: "Save events",
        findings: [], tests: [{ command: "test", status: "passed", evidence: "Passed" }],
        acceptanceCriteria: [{ criterion: "Save", status: "passed", evidence: "Passed" }],
        accessibility: { status: "not-applicable", evidence: "No UI change" } };
    }, submitTry: async () => {
      actions.push("submit");
      monitorStore.save({ id: "monitor", implementationId: state.id, phase: "waiting",
        attempts: [{ url: "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=test" }] });
      return {};
    } });
  t.after(() => manager.stop());
  await manager.tick();
  if (legacy === "handoff") {
    assert.equal(store.read(state.id).phase, "recovering-build");
    assert.equal(Boolean(store.read(state.id).error), false);
    await manager.tick();
  }
  assert.equal(Boolean(store.read(state.id).error), false);
  assert.deepEqual(actions, ["build", "verify", "submit"]);
  assert.equal(store.read(state.id).phase, "monitoring");
});
