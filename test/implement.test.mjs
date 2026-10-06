import { DEFAULT_AI_PROFILES } from "../commands/graph/ai-models.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createImplementationManager, chooseImplementationModel, validateImplementationReport, implementationOwnsCheckout } from "../commands/graph/implement.mjs";
import { createTryMonitorStore } from "../commands/graph/try-monitor-store.mjs";
const exec = promisify(execFile);
const report = (extra = {}) => ({ complete: true, summary: "Implemented and checked", title: "Add feature", description: "Support the requested behavior.",
  tests: [{ command: "test feature", status: "passed", evidence: "1 passed" }],
  acceptanceCriteria: [{ criterion: "Requested behavior", status: "passed", evidence: "feature.txt and test feature" }],
  accessibility: { status: "not-applicable", evidence: "No UI changes" }, findings: [], ...extra });

test("Implement batches linked bug metadata before AI and reuses it during verification", async t => {
  const requests = [];
  const f = await fixture(t, {
    readBug: async () => ({ bugs: [{ id: 123, assigned_to: "me@example.invalid", is_open: true, depends_on: [456], blocks: [456, 789] }] }),
    readLinkedBugs: async ids => { requests.push(ids); return ids.map(id => ({ id, summary: `Linked ${id}` })); },
  });
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait();
  assert.equal(state.phase, "monitoring", state.error);
  assert.deepEqual(requests, [["456", "789"]]);
  assert.equal(state.linkedBugs.length, 2);
});

async function fixture(t, overrides = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tb-implement-")));
  const root = path.join(directory, "comm"); await mkdir(root);
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "base.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "Base");
  const main = await git("rev-parse", "HEAD");
  await git("remote", "add", "origin", root);
  await git("switch", "-c", "topic");
  await writeFile(path.join(root, "topic.txt"), "topic\n"); await git("add", "."); await git("commit", "-m", "Topic");
  const head = await git("rev-parse", "HEAD");
  const store = createTryMonitorStore(path.join(directory, "implement"));
  const monitorStore = createTryMonitorStore(path.join(directory, "monitor"));
  const assignments = [], roles = [];
  let pushes = 0;
  const options = { getAiProfiles: () => DEFAULT_AI_PROFILES, graphs: [{ path: root, label: "comm" }], aiEnabled: true, username: "me@example.invalid", store, monitorStore,
    readBug: async () => ({ bugs: [{ id: 123, assigned_to: "me@example.invalid", is_open: true, summary: "Feature" }] }),
    readComments: async () => [{ text: "Original acceptance criteria" }, { text: "Later planning context" }],
    readAttachments: async () => [{ id: 123, attachments: [] }],
    assignBug: async (...args) => assignments.push(args),
    generate: async ({ role, prompt }) => {
      roles.push(role);
      assert.match(prompt, /Original acceptance criteria/); assert.match(prompt, /Later planning context/);
      if (role === "implement") await writeFile(path.join(root, "feature.txt"), "feature\n");
      return report();
    },
    submitTry: async ({ implementationId, options }) => {
      pushes++;
      assert.equal(options.comment, false);
      const sourceHash = await git("rev-parse", "HEAD");
      monitorStore.save({ id: "try-1", implementationId, path: root, phase: "waiting", sourceHash, hash: sourceHash, attempts: [{ url: "https://treeherder.mozilla.org/jobs?repo=try-comm-central&revision=abc" }] });
      return { tryUrl: monitorStore.read("try-1").attempts[0].url };
    }, ...overrides };
  const manager = createImplementationManager(options);
  t.after(async () => { manager.stop(); await rm(directory, { recursive: true, force: true }); });
  const wait = async () => {
    for (let n = 0; n < 500; n++) {
      const state = store.list()[0];
      if (state?.error || ["monitoring", "complete", "cancelled"].includes(state?.phase)) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Implementation did not settle");
  };
  return { directory, root, git, main, head, store, monitorStore, options, manager, assignments, roles, wait, pushes: () => pushes };
}

test("uses the configured implementation model", () => {
  const model = (id, extra = {}) => ({ id, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], ...extra });
  assert.equal(chooseImplementationModel([model("gpt-5.6"), model("gpt-6-luna", { isDefault: true }), model("gpt-6-sol"), model("gpt-6-astra"), model("gpt-7", { hidden: true })], DEFAULT_AI_PROFILES), "gpt-6-sol");
  assert.throws(() => chooseImplementationModel([{ id: "gpt-6", supportedReasoningEfforts: [] }], DEFAULT_AI_PROFILES), /Change it in Settings/);
});

test("failed verification feeds repair, but cannot become a clean pass", () => {
  const failed = report({ complete: false, findings: [{ id: "a11y", description: "Missing name", evidence: "button at file:12" }],
    accessibility: { status: "failed", evidence: "Missing name" } });
  assert.equal(validateImplementationReport(failed, { verifier: true }), failed);
  assert.throws(() => validateImplementationReport({ ...failed, findings: [] }, { verifier: true }), /clear question or action/);
  assert.throws(() => validateImplementationReport(report({ tests: [] })), /applicable tests/);
});

for (const base of ["main", "current"]) test(`Implement starts from ${base}, commits, verifies, and resumes Try after restart`, async t => {
  const f = await fixture(t);
  await f.manager.create({ bugId: 123, base, expectedHead: f.head });
  const state = await f.wait(); assert.equal(state.error, undefined);
  assert.equal(state.phase, "monitoring"); assert.equal(await f.git("rev-parse", "HEAD^"), base === "main" ? f.main : f.head);
  assert.equal(await f.git("branch", "--show-current"), "Bug-123");
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.match(await f.git("show", "-s", "--format=%B"), /^Bug 123 - Add feature\n\nSupport the requested behavior\./);
  assert.deepEqual(f.assignments, [["123", { status: "ASSIGNED", assigned_to: "me@example.invalid" }]]);
  assert.deepEqual(f.roles, ["implement", "verify"]); assert.equal(f.pushes(), 1);
  f.manager.stop();
  f.monitorStore.save({ ...f.monitorStore.read("try-1"), phase: "passed" });
  const resumed = createImplementationManager(f.options); t.after(() => resumed.stop());
  await resumed.tick();
  assert.equal(f.store.read(state.id).phase, "complete"); assert.equal(f.pushes(), 1);
});

test("verifier and implementer exchange findings and amend one commit", async t => {
  const f = await fixture(t); let iterations = 0;
  const manager = createImplementationManager({ ...f.options, generate: async ({ role, state, prompt }) => {
    if (role === "implement") {
      if (iterations) assert.match(prompt, /Missing keyboard behavior/);
      await writeFile(path.join(f.root, "feature.txt"), iterations ? "keyboard fixed\n" : "feature\n");
      return report();
    }
    if (!iterations++) return report({ complete: false, findings: [{ id: "keyboard", description: "Missing keyboard behavior", evidence: "feature.txt:1" }],
      acceptanceCriteria: [{ criterion: "Keyboard works", status: "failed", evidence: "Missing event handler" }] });
    assert.equal(state.reports.length, 3); return report();
  } }); t.after(() => manager.stop());
  await manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); assert.equal(state.error, undefined); assert.equal(state.phase, "monitoring");
  assert.equal(await f.git("rev-list", "--count", `${f.head}..HEAD`), "1");
  assert.equal(await f.git("show", "HEAD:feature.txt"), "keyboard fixed");
  assert.deepEqual(state.reports.map(entry => entry.role), ["implement", "verify", "implement", "verify"]);
});

test("automatically folds only this implementation's passing Try fixup into its commit", async t => {
  const f = await fixture(t);
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); assert.equal(state.error, undefined);
  const monitor = f.monitorStore.read("try-1");
  await f.git("switch", "-c", "tb-try-fixup/try-1");
  await writeFile(path.join(f.root, "feature.txt"), "CI repair\n");
  await f.git("add", "."); await f.git("commit", "-m", "fixup! Bug 123 - Add feature\n\nFix the failing platform test by adjusting feature.txt.");
  monitor.fixupHash = await f.git("rev-parse", "HEAD"); monitor.phase = "passed"; f.monitorStore.save(monitor);
  f.monitorStore.save({ id: "unrelated", path: f.root, phase: "passed", fixupHash: "unrelated", attempts: [] });
  await f.git("switch", state.branch);
  await f.manager.tick();
  const done = f.store.read(state.id); assert.equal(done.error, undefined); assert.equal(done.phase, "complete");
  assert.equal(await f.git("show", "HEAD:feature.txt"), "CI repair");
  assert.equal(await f.git("rev-parse", "HEAD^"), f.head);
  assert.match(await f.git("show", "-s", "--format=%B"), /Bug 123 - Add feature/);
  assert.doesNotMatch(await f.git("show", "-s", "--format=%B"), /Fix the failing platform test/);
  assert.equal(f.monitorStore.read("unrelated").fixupHash, "unrelated");
});

test("reconciles a saved submission without pushing twice", async t => {
  const f = await fixture(t);
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); f.manager.stop();
  state.phase = "submitting"; state.monitorId = ""; f.store.save(state);
  const resumed = createImplementationManager(f.options); t.after(() => resumed.stop()); await resumed.tick();
  assert.equal(f.store.read(state.id).phase, "monitoring"); assert.equal(f.pushes(), 1);
});

test("recovers a commit written before its receipt was saved", async t => {
  const f = await fixture(t);
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); f.manager.stop();
  state.phase = "committing"; state.commitHash = ""; f.store.save(state);
  const hash = await f.git("rev-parse", "HEAD");
  const resumed = createImplementationManager(f.options); t.after(() => resumed.stop()); await resumed.tick();
  assert.equal(f.store.read(state.id).error, undefined); assert.equal(await f.git("rev-parse", "HEAD"), hash);
  assert.equal(f.pushes(), 1);
});

test("blocks changed bases, dirty checkouts, and disabled AI before starting", async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.create({ bugId: 123, base: "current", expectedHead: "old" }), /changed/);
  const disabled = createImplementationManager({ ...f.options, aiEnabled: false });
  await assert.rejects(disabled.create({ bugId: 123, base: "main" }), /Enable AI/);
  await writeFile(path.join(f.root, "dirty.txt"), "user work");
  await assert.rejects(f.manager.create({ bugId: 123, base: "main" }), /working changes/);
  assert.equal(f.store.list().length, 0);
});

test("retries bug eligibility checks instead of trusting a failed partial read", async t => {
  let owner = "other@example.invalid";
  const f = await fixture(t, { readBug: async () => ({ id: 123, assigned_to: owner, is_open: true }) });
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  let state = await f.wait(); assert.match(state.error, /assigned to you/); assert.equal(state.bug, undefined);
  owner = "me@example.invalid";
  await f.manager.retry(state.id); state = await f.wait(); assert.equal(state.error, ""); assert.equal(state.phase, "monitoring");
});

test("rejects an existing patch before changing Bugzilla or the branch", async t => {
  const f = await fixture(t, { readAttachments: async () => [{ id: 123, attachments: [{ is_patch: true }] }] });
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); assert.match(state.error, /already has a patch/);
  assert.equal(f.assignments.length, 0); assert.equal(await f.git("branch", "--show-current"), "topic");
  f.manager.cancel(state.id); assert.equal(f.manager.active(), undefined);
});

test("keeps blocked test evidence and user changes without committing or pushing", async t => {
  const f = await fixture(t, { generate: async () => report({ complete: false, summary: "Build unavailable" }) });
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); assert.match(state.error, /Build unavailable/);
  assert.equal(state.reports[0].report.summary, "Build unavailable");
  assert.equal(await f.git("rev-parse", "HEAD"), f.head); assert.equal(f.pushes(), 0);
});

test("a graceful shutdown keeps an interrupted stage resumable without a manual retry", async t => {
  const f = await fixture(t); let started, interrupt;
  const entered = new Promise(resolve => { started = resolve; });
  const manager = createImplementationManager({ ...f.options, generate: async () => {
    await writeFile(path.join(f.root, "feature.txt"), "unfinished\n"); started();
    return new Promise((_, reject) => { interrupt = reject; });
  } });
  await manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  await entered; manager.stop(); interrupt(new Error("Server stopped"));
  await new Promise(resolve => setImmediate(resolve));
  const state = f.store.list()[0]; assert.equal(state.error, undefined); assert.equal(state.phase, "implementing");
  const resumed = createImplementationManager(f.options); t.after(() => resumed.stop()); await resumed.tick();
  assert.equal(f.store.read(state.id).phase, "monitoring"); assert.equal(f.pushes(), 1);
});

test("waits for an old agent to exit and does not start a duplicate", async t => {
  const f = await fixture(t);
  f.store.save({ id: "old-agent", path: f.root, phase: "implementing", aiPid: process.pid });
  await f.manager.tick();
  assert.equal(f.store.read("old-agent").error, undefined); assert.equal(f.roles.length, 0);
});

test("a busy Try amendment is retried automatically", async t => {
  const f = await fixture(t);
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait(); f.manager.stop();
  f.monitorStore.save({ ...f.monitorStore.read("try-1"), phase: "passed", fixupHash: "fixup" });
  const resumed = createImplementationManager({ ...f.options, squash: async () => { throw Object.assign(new Error("busy"), { code: "TRY_BUSY" }); } });
  t.after(() => resumed.stop()); await resumed.tick();
  assert.equal(f.store.read(state.id).error, undefined); assert.equal(f.store.read(state.id).phase, "monitoring");
});

test("feedback during verification survives saves and gets implemented before Try", async t => {
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  let implementations = 0, verifications = 0;
  const f = await fixture(t, { generate: async ({ state, role, prompt }) => {
    assert.match(prompt, /Initial user scope/);
    if (role === "implement") {
      implementations++;
      if (implementations > 1) assert.match(prompt, /Handle Escape/);
      await writeFile(path.join(state.path, "feature.txt"), `feature ${implementations}\n`);
    } else if (++verifications === 1) { entered(); await gate; }
    return report();
  } });
  const state = await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head, instructions: "Initial user scope" });
  await waiting;
  const diff = await f.manager.diff(state.id);
  assert.match(diff.committedHtml, /feature/);
  assert.doesNotMatch(diff.committedHtml, /<pre>diff --git/);
  await f.manager.feedback(state.id, { text: "Handle Escape" });
  assert.equal(f.store.read(state.id).instructions.at(-1).text, "Handle Escape");
  resume();
  const result = await f.wait();
  assert.equal(result.error, undefined);
  assert.equal(result.phase, "monitoring");
  assert.equal(implementations, 2); assert.equal(verifications, 2); assert.equal(f.pushes(), 1);
  assert.equal(result.instructions.length, 2);
  await assert.rejects(f.manager.feedback(state.id, { text: "Too late" }), /Try already owns/);
});

test("live feedback steers the active Codex turn and keeps untracked changes visible", async t => {
  let entered, resume, count = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const steers = [];
  const f = await fixture(t, { generate: undefined, codexCommand: process.execPath,
    startAgent: async ({ cwd, threadName, onNotification }) => ({ thread: { id: threadName }, client: {
      listModels: async () => [{ id: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }],
      async startTurn({ onTurnStarted, effort }) {
        assert.equal(effort, threadName.endsWith(" verify") ? "high" : "medium");
        onTurnStarted("turn-123");
        onNotification({ method: "item/started", params: { item: { type: "commandExecution", command: "mach test" } } });
        onNotification({ method: "item/agentMessage/delta", params: { turnId: "turn-123", itemId: "note", delta: "Checking tests" } });
        onNotification({ method: "item/completed", params: { turnId: "turn-123", item: { id: "report", type: "agentMessage", text: JSON.stringify(report()) } } });
        if (threadName.endsWith(" implement")) {
          await writeFile(path.join(cwd, "new.txt"), "untracked feature\n");
          if (++count === 1) { entered(); await gate; }
        }
        return { turn: { status: "completed" }, message: JSON.stringify(report()) };
      },
      async steerTurn(value) { steers.push(value); }, close() {},
    } }),
  });
  const state = await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  await waiting;
  assert.match((await f.manager.diff(state.id)).workingHtml, /untracked feature/);
  await f.manager.feedback(state.id, { text: "Please test keyboard focus." });
  const activities = f.store.read(state.id).activities;
  assert.ok(activities.some(entry => entry.kind === "command" && entry.detail.includes("mach test")));
  assert.equal(activities.filter(entry => entry.kind === "note").length, 1);
  assert.equal(activities.find(entry => entry.kind === "note").detail, "Checking tests");
  assert.equal(steers[0].turnId, "turn-123");
  assert.match(steers[0].prompt, /Please test keyboard focus/);
  assert.equal(f.store.read(state.id).instructions[0].delivery, "sent");
  resume();
  assert.equal((await f.wait()).phase, "monitoring");
  assert.equal(count, 2);
});

test("cancel stops a live agent, keeps edits, and never commits or posts Try", async t => {
  let entered, rejectTurn, closes = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { generate: undefined, codexCommand: process.execPath,
    startAgent: async ({ cwd }) => ({ thread: { id: "cancel-thread" }, client: {
      listModels: async () => [{ id: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }],
      async startTurn({ onTurnStarted, effort }) {
        assert.equal(effort, "medium");
        onTurnStarted("cancel-turn");
        await writeFile(path.join(cwd, "unfinished.txt"), "Keep these changes\n");
        return new Promise((resolve, reject) => { rejectTurn = reject; entered(); });
      },
      close() { closes++; rejectTurn?.(new Error("Agent stopped")); },
    } }),
  });
  const state = await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  await waiting;
  assert.equal(f.manager.cancel(state.id).phase, "cancelling");
  assert.ok(f.manager.active(), "Keep the checkout owned until the turn exits");
  const result = await f.wait();
  assert.equal(result.phase, "cancelled"); assert.equal(result.error, "");
  assert.ok(closes); assert.equal(f.pushes(), 0);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.match(await f.git("status", "--porcelain"), /unfinished.txt/);
  assert.match((await f.manager.diff(state.id)).workingHtml, /Keep these changes/);
  assert.equal(f.manager.active(), undefined);
  await f.manager.tick(); assert.equal(f.pushes(), 0);
});

test("cancel also stops a healthy monitoring implementation without discarding its Try", async t => {
  const f = await fixture(t);
  const state = await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  await f.wait();
  const cancelled = f.manager.cancel(state.id);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(f.monitorStore.read(cancelled.monitorId).phase, "waiting");
  assert.equal(f.manager.active(), undefined);
  assert.match((await f.manager.diff(state.id)).committedHtml, /feature/);
});


test("vague implementation block gets one clarification and resumes without a false pass", async t => {
  const f = await fixture(t);
  let turns = 0;
  const manager = createImplementationManager({ ...f.options, generate: async args => {
    if (args.role === "implement" && ++turns === 1) return report({ complete: false,
      summary: "Implemented and tested. Product/design confirmation remains open. Changes are unstaged; Gecko source is unchanged." });
    if (args.role === "implement") assert.match(args.prompt, /exact question/);
    return f.options.generate(args);
  } });
  t.after(() => manager.stop());
  await manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait();
  assert.equal(state.error, undefined);
  assert.equal(state.phase, "monitoring");
  assert.equal(turns, 2);
});

test("repeated vague reports pause after one clarification without committing or posting Try", async t => {
  const f = await fixture(t, { generate: async () => report({ complete: false }) });
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait();
  assert.equal(state.errorKind, "report-invalid");
  assert.match(state.error, /Automatic report recovery/);
  assert.equal(state.reports.length, 2);
  await f.manager.tick();
  assert.equal(f.store.read(state.id).reports.length, 2);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(f.pushes(), 0);
});

test("a specific input request pauses and feedback resumes the saved workflow", async t => {
  const f = await fixture(t);
  let turns = 0;
  const manager = createImplementationManager({ ...f.options, generate: async args => {
    if (!turns++) return report({ complete: false, inputRequest: {
      question: "Which of the two conflicting label requirements should I use?",
      reason: "The bug requests Save, but the supplied design requires Apply.",
      attemptedResolution: "Checked the bug and design history; neither supersedes the other." } });
    assert.match(args.prompt, /Use Save/);
    return f.options.generate(args);
  } });
  t.after(() => manager.stop());
  await manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const paused = await f.wait();
  assert.equal(paused.errorKind, "input-required");
  assert.match(paused.error, /Which of the two/);
  assert.equal(f.pushes(), 0);
  await manager.feedback(paused.id, { text: "Use Save." });
  const resumed = await f.wait();
  assert.equal(resumed.error, "");
  assert.equal(resumed.phase, "monitoring");
  assert.equal(f.pushes(), 1);
});


test("historical failure in a complete report is reconciled once before committing", async t => {
  const f = await fixture(t);
  const failed = { command: "test selector and dialog", status: "failed", evidence: "Selector fixture failed; dialog passed" };
  let calls = 0;
  const manager = createImplementationManager({ ...f.options, generate: async args => {
    if (args.role === "verify") return f.options.generate(args);
    await writeFile(path.join(f.root, "feature.txt"), "feature\n");
    if (!calls++) return report({ tests: [failed, { command: "test selector", status: "passed", evidence: "Repaired fixture; 197 assertions passed" }] });
    assert.match(args.prompt, /Separate repaired historical test failures/);
    assert.equal(await f.git("rev-parse", "HEAD"), f.head);
    assert.equal(f.pushes(), 0);
    return report({ testHistory: [{ ...failed, resolution: "Final selector rerun passed 197 assertions; dialog previously passed 98 assertions." }] });
  } });
  t.after(() => manager.stop());
  await manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait();
  assert.equal(state.error, undefined);
  assert.equal(state.phase, "monitoring");
  assert.equal(calls, 2);
  assert.equal(state.reports[0].report.tests[0].status, "failed");
  assert.equal(state.reports[1].report.testHistory[0].status, "failed");
  assert.equal(f.pushes(), 1);
});

test("unresolved test failure is never accepted as complete after reconciliation", async t => {
  const f = await fixture(t, { generate: async () => report({ tests: [{ command: "test feature", status: "failed", evidence: "Still broken" }] }) });
  await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  const state = await f.wait();
  assert.equal(state.errorKind, "report-invalid");
  assert.match(state.error, /Automatic report recovery/);
  assert.equal(state.reports.length, 2);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(f.pushes(), 0);
});

test("resuming a saved validation pause asks for report reconciliation", async t => {
  const f = await fixture(t);
  const state = { id: "saved-report", bugId: "123", path: f.root, phase: "implementing", branch: "topic",
    baseHash: f.head, reports: [{ role: "implement", report: report() }],
    error: "The agent has not confirmed all applicable tests.",
    bug: { id: 123 }, comments: [], threads: {} };
  f.store.save(state);
  const manager = createImplementationManager({ ...f.options, generate: async ({ role, prompt }) => {
    if (role === "implement") {
      assert.match(prompt, /Reconcile the saved report before repeating work/);
      await writeFile(path.join(f.root, "feature.txt"), "feature\n");
    }
    return report();
  } });
  t.after(() => manager.stop());
  await manager.retry(state.id);
  const resumed = await f.wait();
  assert.equal(resumed.phase, "monitoring");
  assert.equal(resumed.error, "");
});


test("saved report pauses recover automatically once without a user action", async t => {
  const f = await fixture(t);
  f.store.save({ id: "saved-auto", bugId: "123", path: f.root, phase: "implementing", branch: "topic",
    baseHash: f.head, reports: [], error: "The agent has not confirmed all applicable tests.",
    bug: { id: 123 }, comments: [], threads: {} });
  let turns = 0;
  const manager = createImplementationManager({ ...f.options, generate: async ({ role, prompt }) => {
    turns++;
    if (role === "implement") {
      assert.match(prompt, /Continue this saved workflow without asking the user/);
      await writeFile(path.join(f.root, "feature.txt"), "feature\n");
    }
    return report();
  } });
  t.after(() => manager.stop());
  await manager.tick();
  const state = f.store.read("saved-auto");
  assert.equal(state.phase, "monitoring");
  assert.equal(state.reportRecoveryVersion, 1);
  assert.equal(turns, 2);
});

test("automatic saved-report recovery cannot loop after restart", async t => {
  const f = await fixture(t);
  f.store.save({ id: "saved-invalid", bugId: "123", path: f.root, phase: "implementing", branch: "topic",
    baseHash: f.head, reports: [], error: "The agent has not confirmed all applicable tests.",
    bug: { id: 123 }, comments: [], threads: {} });
  let turns = 0;
  const options = { ...f.options, generate: async () => { turns++; return report({ tests: [] }); } };
  const manager = createImplementationManager(options);
  t.after(() => manager.stop());
  await manager.tick();
  assert.equal(turns, 2);
  await manager.tick();
  const restarted = createImplementationManager(options);
  t.after(() => restarted.stop());
  await restarted.tick();
  assert.equal(turns, 2);
  assert.equal(f.pushes(), 0);
});

test("a question without attempted alternatives is sent back to the agent", () => {
  assert.throws(() => validateImplementationReport(report({ complete: false,
    inputRequest: { question: "Can I proceed?", reason: "Want approval" } })),
  error => error.code === "IMPLEMENT_REPORT_INCOMPLETE");
});

test("Implement cannot complete when a saved pass had no successful builds", async t => {
  const f = await fixture(t);
  const state = await f.manager.create({ bugId: 123, base: "current", expectedHead: f.head });
  await f.wait();
  const monitor = f.monitorStore.read("try-1");
  monitor.phase = "passed";
  monitor.attempts[0].buildValidationBlocked = true;
  f.monitorStore.save(monitor);
  await f.manager.tick();
  const saved = f.store.read(state.id);
  assert.equal(saved.phase, "monitoring");
  assert.match(saved.error, /failed before the patch could build/);
});


test("a blocked Try releases checkout ownership while active edits and cancellation retain it", () => {
  assert.equal(implementationOwnsCheckout({ phase: "monitoring", error: "Update the base", tryStatus: "needs-rebase" }), false);
  assert.equal(implementationOwnsCheckout({ phase: "monitoring", tryStatus: "needs-rebase" }), false);
  assert.equal(implementationOwnsCheckout({ phase: "monitoring", tryStatus: "rust-blocked" }), false);
  assert.equal(implementationOwnsCheckout({ phase: "monitoring", error: "Update the base", aiPid: 123 }), true);
  assert.equal(implementationOwnsCheckout({ phase: "implementing", error: "Needs a decision" }), true);
  assert.equal(implementationOwnsCheckout({ phase: "cancelling", cancelRequested: true }), true);
  assert.equal(implementationOwnsCheckout({ phase: "monitoring", tryStatus: "waiting" }), true);
});
