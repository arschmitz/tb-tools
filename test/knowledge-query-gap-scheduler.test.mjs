import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { captureQueryObservation, captureQueryOutcome, queryGapReport } from "../commands/knowledge/query-gaps.mjs";
import { queryGapScheduleOptions, runQueryGapSchedule, queryGapScheduleStatus } from "../commands/knowledge/query-gap-scheduler.mjs";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";

const revision = "a".repeat(40), quote = "function cancelOperation() { controller.abort(); }";
const settings = { minAgeMs: 1, intervalMs: 60_000, retryMs: 60_000 };
const checked = { state: "confirmed", reason: "missing-evidence", explanation: "The caller contract is absent from indexed evidence.",
  verification: "Checked the current cancellation function and its caller. No claim about runtime tests.", evidenceIds: [],
  sourceChecks: [{ path: "mail/cancel.js", revision, quote }] };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "query-gap-schedule-"));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
async function observe(store, { question = "What cancels the operation?", completed = true, at = "2026-10-13T10:00:00Z" } = {}) {
  const id = captureQueryObservation(store, { question, repository: "thunderbird", revision, root: "/source/comm", paths: ["mail/cancel.js"], ids: [] }, { now: () => at });
  if (completed) {
    const evidence = await store.put({ kind: "evidence", repository: "thunderbird", text: "Original task request and answer.", at,
      source: { type: "agent-turn", personal: true } });
    captureQueryOutcome(store, id, { status: "completed", evidenceId: evidence.id });
  }
  return id;
}
const git = async (_root, args) => args[0] === "rev-parse" ? revision : quote;

test("scheduled checks confirm grounded gaps, queue work, and share the daily budget", async t => {
  const store = await fixture(t);
  await observe(store);
  let now = Date.parse("2026-10-13T11:00:00Z"), calls = 0;
  const dependencies = { now: () => now, git, generate: async (_prompt, options) => {
    calls++; assert.equal(options.directory, "/source/comm", "Source checks should run in the actual checkout.");
    assert.equal(queryGapScheduleStatus(store).running, true, "A live assessment should be visible while it runs.");
    return checked;
  }, maxCallsPerDay: 4 };
  const result = await runQueryGapSchedule(store, settings, dependencies);
  assert.equal(result.state, "confirmed", "A checked source quote should support a confirmed assessment.");
  assert.equal(result.work.state, "awaiting-evaluation", "Confirmed gaps should queue an evaluation draft automatically.");
  assert.equal(result.capturedIds.length, 1, "Missing source evidence should enter the existing learning flow.");
  assert.equal(store.get(result.capturedIds[0]).visibility, "private", "Captured source should stay private unless sharing is configured.");
  assert.equal(store.setting("calls:2026-10-13"), 1, "A check should consume the existing daily learning budget.");
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).notDue, true, "A repeated tick should respect its durable schedule.");
  now += 60_001;
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).idle, true, "Reviewed groups should not be checked repeatedly.");
  assert.equal(calls, 1, "An unchanged checked gap should make one model call.");
  assert.equal(queryGapScheduleStatus(store, settings, now).work.length, 1, "Queued work should be available without a CLI command.");
});

test("invalid quotes never confirm a gap and failures back off", async t => {
  const store = await fixture(t);
  await observe(store);
  let now = Date.parse("2026-10-13T11:00:00Z"), calls = 0;
  const dependencies = { now: () => now, git, generate: async () => { calls++; return { ...checked, sourceChecks: [{ path: "mail/cancel.js", revision, quote: "Invented unsupported source text" }] }; } };
  await assert.rejects(runQueryGapSchedule(store, settings, dependencies), /does not match/, "Invented source quotes should be rejected.");
  assert.equal(queryGapReport(store).groups[0].review, null, "Invalid output should not produce a checked review.");
  assert.equal(queryGapScheduleStatus(store, settings, now).work.length, 0, "Invalid output should not queue work.");
  now += 100;
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).notDue, true, "A failed call should still respect cadence.");
  assert.equal(calls, 1, "Errors should not cause calls on every maintenance tick.");
});

test("insufficient checks retry and source paths cannot escape the repository", async t => {
  const store = await fixture(t);
  await observe(store);
  let now = Date.parse("2026-10-13T11:00:00Z");
  const dependencies = { now: () => now, git, generate: async () => ({ ...checked, state: "insufficient", sourceChecks: [] }) };
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).state, "insufficient", "Missing checks should stay unresolved.");
  now += 60_001;
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).checked, 1, "Insufficient assessments should retry when due.");
  const second = await fixture(t);
  await observe(second);
  await assert.rejects(runQueryGapSchedule(second, settings, { now: () => now, git,
    generate: async () => ({ ...checked, sourceChecks: [{ path: "../private", revision, quote }] }) }), /Invalid current-source/, "Source paths should stay inside the repository.");
});

test("disabled scheduling, incomplete turns, and exhausted budgets make no model calls", async t => {
  const store = await fixture(t);
  await observe(store, { completed: false });
  const dependencies = { now: () => Date.parse("2026-10-13T11:00:00Z"), git, generate: () => assert.fail("This check should not run.") };
  assert.equal((await runQueryGapSchedule(store, { ...settings, enabled: false }, dependencies)).disabled, true, "Disabled scheduling should perform no checks.");
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).idle, true, "Unfinished turns should not be assessed.");
  await observe(store, { question: "Second completed question" });
  store.setting("calls:2026-10-13", 4);
  assert.equal((await runQueryGapSchedule(store, settings, dependencies)).budgetReached, true, "The total daily budget should gate assessment calls.");
  assert.equal(queryGapScheduleOptions().intervalMs, 6 * 3_600_000, "The default schedule should use six hours.");
});

test("concurrent schedule runs cannot duplicate an assessment", async t => {
  const store = await fixture(t);
  await observe(store);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let announce;
  const entered = new Promise(resolve => { announce = resolve; });
  const dependencies = { now: () => Date.parse("2026-10-13T11:00:00Z"), git,
    generate: async () => { announce(); await gate; return checked; } };
  const first = runQueryGapSchedule(store, settings, dependencies);
  await entered;
  try { assert.equal((await runQueryGapSchedule(store, settings, dependencies)).busy, true, "The learning lock should prevent overlapping checks."); }
  finally { release(); }
  await first;
});

test("maintenance runs the gap scheduler without a user command", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "query-gap-maintenance-"));
  const service = await createKnowledgeService({ directory, semantic: false, importLegacy: false, push: false,
    followUp: { enabled: false }, maxCallsPerDay: 4, queryGaps: settings }, { generate: () => assert.fail("An idle scheduler should not call the model.") });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  let checkedRuns = 0;
  service.checkQueryGaps = async () => { checkedRuns++; return { idle: true }; };
  await service.tick();
  assert.equal(checkedRuns, 1, "Normal maintenance should invoke the query-gap schedule.");
  assert.equal(service.queryGapStatus().enabled, true, "The schedule should be enabled by default.");
});

test("persisted schedules avoid restart catch-up calls and private questions stay out of captured evidence", async t => {
  const store = await fixture(t);
  await observe(store, { question: "Private task wording: what cancels the operation?" });
  const now = Date.parse("2026-10-13T11:00:00Z");
  const result = await runQueryGapSchedule(store, settings, { now: () => now, git, generate: async () => checked, shareRepositories: ["thunderbird"] });
  const captured = store.get(result.capturedIds[0]);
  assert.equal(captured.visibility, "shared", "Explicitly enabled project sharing should apply to checked source excerpts.");
  assert.doesNotMatch(JSON.stringify(captured), /Private task wording/, "Private query text should stay out of shared source evidence.");
  const reopened = await openKnowledgeStore(store.directory);
  try {
    assert.equal((await runQueryGapSchedule(reopened, settings, { now: () => now + 1000, generate: () => assert.fail("A restart should not bypass cadence.") })).notDue, true, "Persisted cadence should survive a restarted service.");
    const before = queryGapScheduleStatus(reopened, settings, now);
    const after = queryGapScheduleStatus(reopened, settings, now + 3000);
    assert.equal(after.nextAt, before.nextAt, "Status polling should retain a stable next-check timestamp.");
    assert.equal(after.work.length, 1, "Queued work should survive a restart.");
  } finally { reopened.close(); }
});

test("current source quotes are verified against a real Git revision", async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const execute = promisify(execFile), store = await fixture(t);
  const root = path.join(store.directory, "checkout");
  await mkdir(path.join(root, "mail"), { recursive: true });
  await execute("git", ["init", "--initial-branch=main", root]);
  await writeFile(path.join(root, "mail/cancel.js"), `${quote}\n`);
  await execute("git", ["add", "mail/cancel.js"], { cwd: root });
  await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "Fixture"], { cwd: root });
  const hash = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const at = "2026-10-13T10:00:00Z";
  const id = captureQueryObservation(store, { question: "What cancels the operation?", repository: "thunderbird", revision: hash, root }, { now: () => at });
  const task = await store.put({ kind: "evidence", repository: "thunderbird", at, text: "Original private task.", source: { type: "agent-turn", personal: true } });
  captureQueryOutcome(store, id, { status: "completed", evidenceId: task.id });
  const result = await runQueryGapSchedule(store, settings, { now: () => Date.parse("2026-10-13T11:00:00Z"),
    generate: async () => ({ ...checked, sourceChecks: [{ path: "mail/cancel.js", revision: hash, quote }] }) });
  assert.equal(result.state, "confirmed", "A real checked Git blob should permit confirmation.");
  assert.equal(store.get(result.capturedIds[0]).source.revision, hash, "Captured evidence should keep the actual source revision.");
});

test("unresolved retries cannot crowd out other completed queries", async t => {
  const store = await fixture(t);
  await observe(store, { question: "First question" });
  let now = Date.parse("2026-10-13T11:00:00Z");
  const dependencies = { now: () => now, git,
    generate: async () => ({ ...checked, state: "insufficient", sourceChecks: [] }) };
  const first = await runQueryGapSchedule(store, settings, dependencies);
  await observe(store, { question: "Second question" });
  now += 60_001;
  const second = await runQueryGapSchedule(store, settings, dependencies);
  assert.notEqual(second.key, first.key, "Unchecked queries should receive attention before an unresolved retry.");
});


test("scheduled review distinguishes original and current context from reviewer-only source text", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "query-gap-context-"));
  let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await openKnowledgeStore(directory);
  const reviewerOnly = "REVIEWER_ONLY_SECONDARY_SOURCE_DETAIL";
  const source = await store.put({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T10:00:00Z",
    paths: ["mail/cancel.js"], text: `# Cancellation\n${quote}\n${"Background context.\n".repeat(90)}## Other behavior\n${reviewerOnly}\n`,
    source: { type: "code-snapshot", revision, file: "mail/cancel.js", verified: true } });
  const originalContext = "The original task received only navigation hints.";
  const question = "cancelOperation";
  const observationId = captureQueryObservation(store, { repository: "thunderbird", revision, root: "/source/comm",
    question, query: question, text: originalContext, ids: [source.id] }, { now: () => "2026-10-13T10:00:00Z" });
  const task = await store.put({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T10:00:00Z",
    text: "The saved private task answer.", source: { type: "agent-turn", personal: true } });
  captureQueryOutcome(store, observationId, { status: "completed", evidenceId: task.id });
  const current = searchKnowledge(store, { query: question, question, repository: "thunderbird", maxChars: 12_000 });
  let prompt;
  await runQueryGapSchedule(store, { minAgeMs: 1 }, { now: () => Date.parse("2026-10-13T11:00:00Z"), git,
    generate: async input => { prompt = input; return { ...checked, state: "insufficient", sourceChecks: [] }; } });
  const field = label => JSON.parse(prompt.split("\n").find(line => line.startsWith(label)).slice(label.length));
  assert.equal(field("Original returned context (data): "), originalContext,
    "The scheduled reviewer should receive the exact original returned context.");
  assert.equal(field("Current returned context (data): "), current.text,
    "The scheduled reviewer should receive the exact current bounded search context.");
  const support = field("Reviewer-only supporting sources (data; not necessarily returned to the original task): ");
  assert.ok(support.some(record => record.text.includes(reviewerOnly)),
    "Additional full-source text should be explicitly labeled as reviewer-only support.");
  assert.ok(!current.text.includes(reviewerOnly), "Reviewer-only details should not be presented as current task context.");
});
