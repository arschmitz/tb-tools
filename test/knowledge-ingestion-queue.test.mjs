import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { classifyLearningQueue } from "../commands/knowledge/claims.mjs";
import { enqueueKnowledgeBatch, drainKnowledgeQueue, knowledgeIngestionStatus, IngestionInputError } from "../commands/knowledge/ingestion-queue.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-ingestion-queue-"));
  const stores = [], releases = [], pending = [];
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = await openKnowledgeStore(directory);
  stores.push(store);
  return { store, releases, pending };
}

async function input(store, text = "First reviewed batch", visibility = "private", sourceType = "ingestion-test-input") {
  return store.put({ kind: "evidence", repository: "thunderbird", visibility,
    at: "2026-10-13T14:00:00Z", paths: [], text, source: { type: sourceType } });
}

const job = (store, queue, id) => knowledgeIngestionStatus(store, queue).jobs.find(item => item.id === id);

test("enqueue keeps immutable input identity and rejects a different entry mapping", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "identity";
  const first = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572, 573] });
  const repeated = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572, 573] });
  assert.equal(repeated.id, first.id, "The same input should retain its job ID.");
  assert.equal(repeated.createdAt, first.createdAt, "An idempotent enqueue should retain its creation time.");
  assert.equal(knowledgeIngestionStatus(store, queue).jobs.length, 1, "The same input should create one queue job.");
  await assert.rejects(enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [574] }),
    /different entry mapping/, "A conflicting mapping should reject the same input ID.");
  assert.deepEqual(job(store, queue, first.id).entryIndices, [572, 573], "A rejected mapping should preserve the original entries.");
  assert.equal(store.get(saved.id).text, saved.text, "Queue operations should preserve the immutable input.");
});

test("enqueue rejects missing or shared inputs and nonascending entries", async t => {
  const { store } = await fixture(t), saved = await input(store), shared = await input(store, "Shared input", "shared");
  for (const entryIndices of [[2, 1], [1, 1], [0], []]) {
    await assert.rejects(enqueueKnowledgeBatch(store, { queue: "invalid", inputEvidence: saved.id, entryIndices }),
      /ascending unique/, "Entry indices should be positive, unique and ascending.");
  }
  for (const inputEvidence of ["f".repeat(64), shared.id]) {
    await assert.rejects(enqueueKnowledgeBatch(store, { queue: "invalid", inputEvidence, entryIndices: [1] }),
      /saved private evidence/, "A queue input should be existing private evidence.");
  }
  assert.equal(knowledgeIngestionStatus(store, "invalid").jobs.length, 0, "Rejected inputs should not create queue jobs.");
});

test("a failed stage survives and the next explicit drain can retry", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "retry";
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  let calls = 0;
  await assert.rejects(drainKnowledgeQueue(store, { queue, maxBatches: 10,
    process: async (_job, progress) => { calls++; await progress("publishing"); throw new Error("Transport failed"); },
    verify: () => assert.fail("A failed processor should not reach verification.") }),
  /Transport failed/, "A processor failure should reject the drain.");
  const failed = job(store, queue, queued.id);
  assert.equal(failed.status, "failed", "A failed processor should retain a failed job.");
  assert.equal(failed.stage, "publishing", "Failure should retain the last completed stage update.");
  assert.equal(failed.attempts, 1, "One explicit drain should attempt a failing job once.");
  assert.equal(calls, 1, "A failure should not create an automatic retry loop.");
  assert.match(failed.error, /Transport failed/, "Failure state should retain the processor error.");
  const receipt = { remoteCommit: "a".repeat(40) };
  const result = await drainKnowledgeQueue(store, { queue, process: async current => {
    calls++; assert.equal(current.id, queued.id, "A retry should receive the original job ID."); return receipt;
  }, verify: async (_job, value) => value.remoteCommit === receipt.remoteCommit });
  const completed = job(store, queue, queued.id);
  assert.deepEqual(result.completed, [queued.id], "A verified retry should complete the original job.");
  assert.equal(completed.attempts, 2, "An explicit retry should increment the attempt count.");
  assert.equal(completed.createdAt, queued.createdAt, "A retry should preserve the original creation time.");
  assert.equal(completed.error, null, "A successful retry should clear the prior error.");
  const repeated = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  assert.equal(repeated.status, "completed", "Reenqueuing a completed input should preserve completion.");
});

test("verification must return literal true and invalid options do not claim work", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "verification";
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  await assert.rejects(drainKnowledgeQueue(store, { queue,
    process: () => assert.fail("A missing verifier should stop before processing.") }),
  /Invalid ingestion runner options/, "A runner should require an explicit verifier.");
  assert.equal(job(store, queue, queued.id).status, "ready", "Invalid runner options should leave the job ready.");
  assert.equal(job(store, queue, queued.id).attempts, 0, "Invalid options should not claim an attempt.");
  for (const verdict of [false, { verified: true }]) {
    await assert.rejects(drainKnowledgeQueue(store, { queue,
      process: async () => ({ remoteCommit: "a".repeat(40) }), verify: async () => verdict }),
    /publication was not verified/, "A verifier should return literal true before completion.");
    assert.equal(job(store, queue, queued.id).status, "failed", "An unverified result should leave the job failed.");
    assert.equal(job(store, queue, queued.id).stage, "verifying-publication", "A refused receipt should retain its verification stage.");
    assert.equal(job(store, queue, queued.id).result, undefined, "An unverified result should not be saved as completed output.");
  }
});

test("a producer can enqueue during processing without losing either job", async t => {
  const { store, releases, pending } = await fixture(t), queue = "producer";
  const firstInput = await input(store), secondInput = await input(store, "Second reviewed batch");
  const first = await enqueueKnowledgeBatch(store, { queue, inputEvidence: firstInput.id, entryIndices: [572] });
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  releases.push(held.resolve);
  const processed = [];
  const drain = drainKnowledgeQueue(store, { queue, maxBatches: 2, process: async (current, progress) => {
    processed.push(current.id);
    if (current.id === first.id) { entered.resolve(); await held.promise; }
    await progress("exporting"); return { inputEvidence: current.inputEvidence };
  }, verify: (current, receipt) => receipt.inputEvidence === current.inputEvidence });
  pending.push(drain);
  await entered.promise;
  const second = await enqueueKnowledgeBatch(store, { queue, inputEvidence: secondInput.id, entryIndices: [573] });
  assert.equal(knowledgeIngestionStatus(store, queue).jobs.length, 2, "Concurrent enqueue should preserve both jobs.");
  held.resolve();
  const result = await drain;
  assert.deepEqual(processed, [first.id, second.id], "The runner should process both inputs in queue order.");
  assert.deepEqual(result.completed, processed, "Both verified jobs should complete.");
  assert.ok(knowledgeIngestionStatus(store, queue).jobs.every(current => current.status === "completed"),
    "Stage and completion updates should preserve the concurrent producer's job.");
});

test("a live runner keeps ownership while another runner receives busy", async t => {
  const { store, releases, pending } = await fixture(t), saved = await input(store), queue = "runner";
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  releases.push(held.resolve);
  const drain = drainKnowledgeQueue(store, { queue, process: async () => {
    entered.resolve(); await held.promise; return { verifiedInput: saved.id };
  }, verify: () => true });
  pending.push(drain);
  await entered.promise;
  const overlapping = await drainKnowledgeQueue(store, { queue,
    process: () => assert.fail("A busy runner should not process the input."), verify: () => true });
  assert.equal(overlapping.busy, true, "An overlapping runner should report busy.");
  assert.equal(job(store, queue, queued.id).attempts, 1, "A live runner should keep the only claimed attempt.");
  held.resolve();
  assert.deepEqual((await drain).completed, [queued.id], "The original runner should retain ownership through completion.");
});

test("a deadline permits current work to finish and stops the next claim", async t => {
  const { store } = await fixture(t), queue = "deadline";
  const firstInput = await input(store), secondInput = await input(store, "Second reviewed batch");
  const first = await enqueueKnowledgeBatch(store, { queue, inputEvidence: firstInput.id, entryIndices: [572] });
  const second = await enqueueKnowledgeBatch(store, { queue, inputEvidence: secondInput.id, entryIndices: [573] });
  const deadline = "2026-10-13T15:56:24Z";
  let now = Date.parse(deadline) - 1, calls = 0;
  const result = await drainKnowledgeQueue(store, { queue, maxBatches: 10, deadline, now: () => now,
    process: async () => { calls++; now = Date.parse(deadline); return {}; }, verify: () => true });
  assert.deepEqual(result.completed, [first.id], "Work claimed before the deadline should finish verification.");
  assert.equal(result.deadlineReached, true, "The drain should report reaching its deadline.");
  assert.equal(calls, 1, "The deadline should prevent processing the next queued input.");
  assert.equal(job(store, queue, second.id).status, "ready", "An unclaimed input should remain ready after the deadline.");
  const expired = await drainKnowledgeQueue(store, { queue, deadline, now: () => now,
    process: () => assert.fail("An expired runner should not process work."), verify: () => true });
  assert.equal(expired.attempted, 0, "An expired invocation should not claim an attempt.");
});

test("an interrupted running job retries once per explicit invocation", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "interrupted";
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  const state = knowledgeIngestionStatus(store, queue);
  state.jobs[0] = { ...state.jobs[0], status: "running", stage: "exporting", attempts: 1 };
  store.setting(`ingestion-queue:${queue}`, state);
  let calls = 0;
  await assert.rejects(drainKnowledgeQueue(store, { queue, maxBatches: 10, process: async current => {
    calls++;
    assert.equal(current.recoveredInterruption, true, "A stale running state should be recorded as recovered.");
    assert.equal(current.previousStage, "exporting", "Recovery should retain the interrupted stage.");
    assert.equal(current.attempts, 2, "Recovery should increment the interrupted attempt count.");
    throw new Error("Retry failed");
  }, verify: () => true }), /Retry failed/, "A failed recovery should reject this invocation.");
  assert.equal(calls, 1, "A failed interrupted job should be tried once per invocation.");
  await drainKnowledgeQueue(store, { queue, process: async () => ({}), verify: () => true });
  assert.equal(job(store, queue, queued.id).attempts, 3, "A later explicit invocation should retry the preserved failure.");
  assert.equal(job(store, queue, queued.id).status, "completed", "A verified later retry should complete the interrupted input.");
});

test("invalid progress keeps a failed job without writing the invalid stage", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "stage";
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  await assert.rejects(drainKnowledgeQueue(store, { queue,
    process: async (_job, progress) => progress(""), verify: () => true }),
  /Invalid ingestion stage/, "An empty stage should reject the processor update.");
  assert.equal(job(store, queue, queued.id).status, "failed", "An invalid stage should leave a failed job.");
  assert.equal(job(store, queue, queued.id).stage, "processing", "An invalid stage should preserve the last valid stage.");
});

test("queue events stay private and do not create learning work", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "events";
  await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  await drainKnowledgeQueue(store, { queue, process: async (_job, progress) => {
    await progress("publishing"); return {};
  }, verify: () => true });
  const events = [...store.records({ sourceType: "ingestion-queue-transition" })];
  assert.ok(events.length > 1, "State transitions should retain durable event records.");
  for (const event of events) {
    assert.equal(event.visibility, "private", "Queue events should stay private.");
    assert.equal(event.source.chronologicalCoverage, false, "Queue events should not claim study coverage.");
    assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(event.id).state, "skipped",
      "A control event should be skipped by the learning queue.");
  }
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(saved.id).state, "pending",
    "Ordinary input evidence should retain its normal learning state.");
  const operationalInput = await input(store, JSON.stringify({ draftIds: [saved.id] }), "private", "ingestion-queue-input");
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(operationalInput.id).state, "skipped",
    "An operational input bundle should stay out of the learning queue.");
  store.db.prepare("UPDATE jobs SET state='pending' WHERE id=?").run(events[0].id);
  store.db.prepare("UPDATE jobs SET state='pending' WHERE id=?").run(operationalInput.id);
  assert.equal(classifyLearningQueue(store)["operational-queue-state"], 2,
    "Classification should skip both operational types restored to pending.");
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(events[0].id).state, "skipped",
    "A restored control event should return to skipped state.");
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(operationalInput.id).state, "skipped",
    "A restored operational input should return to skipped state.");
});

test("control events begin skipped before put returns to the queue", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "initial-state";
  const rememberFile = store.rememberFile;
  let observed = 0;
  // put calls this hook after committing the index and before returning the event.
  store.rememberFile = function(file, stat, id) {
    if (["ingestion-queue-transition", "ingestion-queue-input"].includes(this.get(id)?.source.type)) {
      observed++;
      assert.equal(this.db.prepare("SELECT state FROM jobs WHERE id=?").get(id).state, "skipped",
        "A committed control event should begin skipped before another learner can select it.");
    }
    return rememberFile.call(this, file, stat, id);
  };
  const operationalInput = await input(store, JSON.stringify({ draftIds: [saved.id] }), "private", "ingestion-queue-input");
  await enqueueKnowledgeBatch(store, { queue, inputEvidence: operationalInput.id, entryIndices: [572] });
  await drainKnowledgeQueue(store, { queue, process: async () => ({}), verify: () => true });
  assert.ok(observed > 1, "Enqueue and processing should expose their initial committed event state.");
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(saved.id).state, "pending",
    "Atomic control-event exclusion should preserve ordinary evidence jobs.");
});

test("continuous options reject unbounded runs before claiming work", async t => {
  const { store } = await fixture(t), saved = await input(store), queue = "continuous-options";
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  const deadline = "2026-10-13T23:00:00Z";
  const invalid = [
    { continuous: true },
    { continuous: "true", deadline },
    { continuous: true, deadline: "invalid" },
    { continuous: true, deadline, pollIntervalMs: 0 },
    { continuous: true, deadline, pollIntervalMs: 10001 },
    { continuous: true, deadline, pollIntervalMs: 1.5 },
    { continuous: true, deadline, signal: {} },
    { continuous: true, deadline, wait: false },
  ];

  for (const options of invalid) {
    await assert.rejects(drainKnowledgeQueue(store, { queue, ...options,
      process: () => assert.fail("Invalid options should not invoke the processor."), verify: () => true }),
    /Invalid ingestion runner options/, "Invalid continuous options should reject before claiming work.");
  }
  assert.equal(job(store, queue, queued.id).attempts, 0, "Rejected continuous options should preserve the ready job.");
});

test("continuous draining picks up groups that arrive while the queue is idle", async t => {
  const { store } = await fixture(t), queue = "continuous-arrivals";
  const firstInput = await input(store), secondInput = await input(store, "Second reviewed batch");
  let clock = Date.now(), waits = 0;
  const deadline = new Date(clock + 10000).toISOString();
  const groups = [], processed = [];

  const result = await drainKnowledgeQueue(store, { queue, continuous: true, maxBatches: 2,
    deadline, now: () => clock, pollIntervalMs: 1000,
    wait: async milliseconds => {
      clock += milliseconds;
      const entryIndices = waits++ ? [577, 578, 579, 580, 581] : [572, 573, 574, 575, 576];
      const saved = waits === 1 ? firstInput : secondInput;
      groups.push(await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices }));
    },
    process: async current => { processed.push(current.id); return { inputEvidence: current.inputEvidence }; },
    verify: (current, receipt) => receipt.inputEvidence === current.inputEvidence });

  assert.deepEqual(processed, groups.map(current => current.id), "Continuous draining should process both newly arrived groups.");
  assert.equal(waits, 2, "A producer should enqueue after each idle wait without losing runner ownership.");
  assert.equal(result.idleWaitMs, 2000, "The runner should report its observed idle wait time.");
  assert.equal(result.attempted, 2, "The configured batch bound should stop the continuous runner.");
  assert.deepEqual(result.completed, processed, "Only verified groups should appear in completion receipts.");
  assert.ok(groups.every(current => job(store, queue, current.id).status === "completed"),
    "Each immutable group should retain its own durable completed state.");
});

test("an idle continuous runner clamps its wait to the deadline", async t => {
  const { store } = await fixture(t), queue = "idle-deadline";
  let clock = Date.now();
  const deadline = new Date(clock + 7).toISOString(), waits = [];
  const result = await drainKnowledgeQueue(store, { queue, continuous: true, deadline, now: () => clock,
    pollIntervalMs: 1000, wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
    process: () => assert.fail("An empty queue should not invoke processing."), verify: () => true });

  assert.deepEqual(waits, [7], "An idle wait should not extend past the run deadline.");
  assert.equal(result.deadlineReached, true, "An idle runner should report reaching its deadline.");
  assert.equal(result.attempted, 0, "Waiting for work should not create a claimed attempt.");
  assert.equal(result.idleWaitMs, 7, "The reported wait should include only the observed idle duration.");
});

test("cancellation interrupts idle waiting and preserves a concurrent ready group", async t => {
  const { store, releases, pending } = await fixture(t), queue = "idle-cancel";
  const saved = await input(store), controller = new AbortController(), entered = Promise.withResolvers();
  releases.push(() => controller.abort());
  const deadline = new Date(Date.now() + 30000).toISOString();
  const drain = drainKnowledgeQueue(store, { queue, continuous: true, deadline, signal: controller.signal,
    pollIntervalMs: 10000, wait: (milliseconds, options) => {
      entered.resolve();
      return delay(milliseconds, undefined, options);
    },
    process: () => assert.fail("A canceled idle runner should not claim a new input."), verify: () => true });
  pending.push(drain);
  await entered.promise;

  const overlapping = await drainKnowledgeQueue(store, { queue,
    process: () => assert.fail("A live idle runner should retain queue ownership."), verify: () => true });
  assert.equal(overlapping.busy, true, "Runner ownership should remain exclusive during idle waits.");
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [572] });
  controller.abort();
  const result = await drain;

  assert.equal(result.aborted, true, "Cancellation should end the idle invocation normally.");
  assert.equal(result.attempted, 0, "An idle cancellation should not count an attempt.");
  assert.equal(job(store, queue, queued.id).status, "ready", "A producer's input should remain ready after cancellation.");
});

test("canceling claimed work keeps its verifier and prevents the next claim", async t => {
  const { store } = await fixture(t), queue = "active-cancel";
  const firstInput = await input(store), secondInput = await input(store, "Second reviewed batch");
  const first = await enqueueKnowledgeBatch(store, { queue, inputEvidence: firstInput.id, entryIndices: [572] });
  const second = await enqueueKnowledgeBatch(store, { queue, inputEvidence: secondInput.id, entryIndices: [573] });
  const controller = new AbortController(), verified = [];
  const result = await drainKnowledgeQueue(store, { queue, continuous: true, maxBatches: 2,
    deadline: new Date(Date.now() + 30000).toISOString(), signal: controller.signal,
    process: async current => { controller.abort(); return { inputEvidence: current.inputEvidence }; },
    verify: (current, receipt) => { verified.push(current.id); return receipt.inputEvidence === current.inputEvidence; } });

  assert.deepEqual(verified, [first.id], "Claimed work should still pass through its verifier after cancellation.");
  assert.deepEqual(result.completed, [first.id], "Cancellation should preserve only the verified current completion.");
  assert.equal(result.aborted, true, "The runner should report cancellation after finishing claimed work.");
  assert.equal(job(store, queue, second.id).status, "ready", "Cancellation should prevent claiming the next group.");
});

test("continuous processing keeps durable attempt timings and rejects a failure once", async t => {
  const { store } = await fixture(t), queue = "attempt-timings";
  const firstInput = await input(store), secondInput = await input(store, "Second reviewed batch");
  const first = await enqueueKnowledgeBatch(store, { queue, inputEvidence: firstInput.id, entryIndices: [572] });
  const second = await enqueueKnowledgeBatch(store, { queue, inputEvidence: secondInput.id, entryIndices: [573] });
  let clock = Date.parse(first.createdAt) + 20;
  await drainKnowledgeQueue(store, { queue, now: () => clock,
    process: async () => { clock += 5; return {}; }, verify: async () => { clock += 3; return true; } });

  assert.deepEqual(job(store, queue, first.id).timings,
    { queueWaitMs: 20, processMs: 5, verificationMs: 3, totalMs: 8 },
    "A verified attempt should retain separate queue, process and verification timings.");
  const before = clock;
  await assert.rejects(drainKnowledgeQueue(store, { queue, continuous: true, maxBatches: 10,
    deadline: new Date(clock + 10000).toISOString(), now: () => clock,
    wait: () => assert.fail("A processor failure should not enter automatic idle retry."),
    process: async (_current, progress) => { await progress("publishing"); clock += 7; throw new Error("Publication failed"); },
    verify: () => assert.fail("A failed processor should not reach its verifier.") }),
  /Publication failed/, "A continuous runner should reject a failed processor without retrying it.");

  const failed = job(store, queue, second.id);
  assert.equal(failed.attempts, 1, "A continuous invocation should attempt a failing job once.");
  assert.equal(failed.stage, "publishing", "Failure should preserve the processor's last stage.");
  assert.deepEqual(failed.timings,
    { queueWaitMs: Math.max(0, before - Date.parse(second.createdAt)), processMs: 7, totalMs: 7 },
    "A failed attempt should retain its measured queue and processing durations.");
  assert.deepEqual(JSON.parse(store.get(failed.eventEvidence).text).timings, failed.timings,
    "The immutable private transition should retain the same failed-attempt timings.");
});

test("idle wait errors remain errors unless cancellation caused them", async t => {
  const { store } = await fixture(t), queue = "idle-error";
  await assert.rejects(drainKnowledgeQueue(store, { queue, continuous: true,
    deadline: new Date(Date.now() + 30000).toISOString(),
    wait: async () => { throw Object.assign(new Error("Unrelated wait failure"), { name: "AbortError" }); },
    process: () => assert.fail("A wait failure should not invoke processing."), verify: () => true }),
  /Unrelated wait failure/, "An AbortError without a canceled signal should remain a runner failure.");
});

test("typed preflight rejection preserves input and continues unrelated work", async t => {
  const { store } = await fixture(t), queue = "input-correction";
  const badInput = await input(store, "Invalid public quote"), goodInput = await input(store, "Valid unrelated audit");
  const bad = await enqueueKnowledgeBatch(store, { queue, inputEvidence: badInput.id, entryIndices: [742] });
  const good = await enqueueKnowledgeBatch(store, { queue, inputEvidence: goodInput.id, entryIndices: [744] });
  const processed = [], verified = [];
  let clock = Date.parse(bad.createdAt) + 20;

  const result = await drainKnowledgeQueue(store, { queue, maxBatches: 2, now: () => clock,
    validate: current => {
      clock += 5;
      if (current.id === bad.id) throw new IngestionInputError("The quote has no public proof.");
    },
    process: current => { processed.push(current.id); clock += 7; return { input: current.inputEvidence }; },
    verify: (current, receipt) => { verified.push(current.id); clock += 3; return receipt.input === current.inputEvidence; } });

  assert.deepEqual(processed, [good.id], "Rejected input should not reach the processor.");
  assert.deepEqual(verified, [good.id], "Only processed input should reach publication verification.");
  assert.deepEqual(result.completed, [good.id], "Unrelated verified input should complete after a rejection.");
  assert.deepEqual(result.awaitingInputCorrection, [bad.id], "The drain should report the rejected input separately.");
  assert.equal(result.attempted, 2, "Rejected validation should count toward the attempt limit.");

  const rejected = job(store, queue, bad.id);
  assert.equal(rejected.status, "awaiting-input-correction", "Rejected input should retain a durable correction state.");
  assert.equal(rejected.stage, "validating-input", "Rejection should retain its preflight stage.");
  assert.equal(rejected.attempts, 1, "The invalid immutable input should have one attempted validation.");
  assert.equal(rejected.result, undefined, "An input rejection should not create a publication receipt.");
  assert.equal(store.get(badInput.id).text, badInput.text, "Input rejection should preserve the immutable draft.");
  assert.equal(rejected.timings.validationMs, 5, "The rejection should retain its validation duration.");
  assert.equal(rejected.timings.processMs, undefined, "Rejected validation should not claim processing time.");
  assert.equal(job(store, queue, good.id).timings.processMs, 7, "Processing time should exclude successful validation.");
  assert.equal(job(store, queue, good.id).timings.verificationMs, 3, "Publication verification should retain its own duration.");
  const event = store.get(rejected.eventEvidence);
  assert.equal(event.visibility, "private", "The rejected transition should remain private.");
  assert.deepEqual(JSON.parse(event.text).timings, rejected.timings, "The immutable event should retain the rejected attempt timings.");
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(event.id).state, "skipped",
    "The operational rejection event should remain excluded from learning.");
});

test("a restart skips rejected input and a new immutable correction can complete", async t => {
  const { store } = await fixture(t), queue = "correction-restart", badInput = await input(store);
  const bad = await enqueueKnowledgeBatch(store, { queue, inputEvidence: badInput.id, entryIndices: [742] });
  await drainKnowledgeQueue(store, { queue,
    validate: () => { throw new IngestionInputError("Invalid draft."); },
    process: () => assert.fail("Invalid input should not publish."), verify: () => true });

  const repeated = await enqueueKnowledgeBatch(store, { queue, inputEvidence: badInput.id, entryIndices: [742] });
  assert.equal(repeated.status, "awaiting-input-correction", "Idempotent enqueue should preserve rejected input state.");
  const restarted = await drainKnowledgeQueue(store, { queue,
    process: () => assert.fail("A restarted runner should not retry rejected input."), verify: () => true });
  assert.equal(restarted.attempted, 0, "Restarting should not claim the invalid immutable input again.");

  const correctionInput = await input(store, "Corrected public proof");
  const correction = await enqueueKnowledgeBatch(store, { queue, inputEvidence: correctionInput.id, entryIndices: [742] });
  const result = await drainKnowledgeQueue(store, { queue, validate: () => {},
    process: current => ({ input: current.inputEvidence }), verify: (current, receipt) => receipt.input === current.inputEvidence });
  assert.deepEqual(result.completed, [correction.id], "A new immutable correction should complete after verification.");
  assert.equal(job(store, queue, bad.id).attempts, 1, "Publishing a correction should preserve the original rejection attempt.");
  assert.equal(job(store, queue, bad.id).status, "awaiting-input-correction", "Correction should not rewrite the old job as completed.");
});

test("unknown preflight errors keep the existing stop and explicit retry contract", async t => {
  const { store } = await fixture(t), queue = "unknown-validation", saved = await input(store);
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [742] });
  const cause = new Error("The storage read failed.");
  cause.name = "IngestionInputError";
  cause.code = "INVALID_INGESTION_INPUT";

  await assert.rejects(drainKnowledgeQueue(store, { queue, validate: () => { throw cause; },
    process: () => assert.fail("An unknown validator failure should stop before processing."), verify: () => true }),
  error => error === cause, "A matching error name or code should not classify an unknown failure as input rejection.");
  assert.equal(job(store, queue, queued.id).status, "failed", "An unknown validation failure should retain failed state.");
  assert.equal(job(store, queue, queued.id).stage, "validating-input", "Unknown validation failure should retain the last stage.");

  const result = await drainKnowledgeQueue(store, { queue, process: () => ({}), verify: () => true });
  assert.deepEqual(result.completed, [queued.id], "A later explicit drain should retain the existing failed-job retry behavior.");
  assert.equal(job(store, queue, queued.id).attempts, 2, "An explicit retry should increment the failed job attempt count.");
});

test("typed errors outside preflight remain publication failures", async t => {
  const { store } = await fixture(t), saved = await input(store);
  for (const phase of ["process", "verify"]) {
    const queue = `typed-${phase}`;
    const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [742] });
    const error = new IngestionInputError("Publication failed.");
    await assert.rejects(drainKnowledgeQueue(store, { queue, validate: () => {},
      process: () => { if (phase === "process") throw error; return {}; },
      verify: () => { throw error; } }),
    actual => actual === error, "A typed processor or verifier error should still reject the drain.");
    assert.equal(job(store, queue, queued.id).status, "failed", "Publication failures should not become input-correction states.");
    assert.equal(job(store, queue, queued.id).result, undefined, "A failed publication should not retain a completed receipt.");
  }
});

test("preflight options do not bypass mandatory publication verification", async t => {
  const { store } = await fixture(t), queue = "validation-options", saved = await input(store);
  const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [742] });
  await assert.rejects(drainKnowledgeQueue(store, { queue, validate: true,
    process: () => assert.fail("Invalid options should not process input."), verify: () => true }),
  /Invalid ingestion runner options/, "A nonfunction validator should reject before claiming an attempt.");
  assert.equal(job(store, queue, queued.id).attempts, 0, "Rejected validator options should preserve the unclaimed input.");

  await assert.rejects(drainKnowledgeQueue(store, { queue, validate: () => {},
    process: () => ({}), verify: () => false }),
  /publication was not verified/, "Successful preflight should still require literal true publication verification.");
  assert.equal(job(store, queue, queued.id).status, "failed", "Refused publication verification should remain a failure.");
});

test("run limits reached during validation defer publishing the claimed input", async t => {
  const { store, releases, pending } = await fixture(t), saved = await input(store);
  for (const limit of ["deadline", "cancellation"]) {
    const queue = `validation-${limit}`;
    const queued = await enqueueKnowledgeBatch(store, { queue, inputEvidence: saved.id, entryIndices: [742] });
    const entered = Promise.withResolvers(), held = Promise.withResolvers();
    releases.push(held.resolve);
    const controller = new AbortController();
    let clock = Date.parse(queued.createdAt) + 1;
    const until = clock + 100;
    const drain = drainKnowledgeQueue(store, { queue, deadline: new Date(until).toISOString(),
      now: () => clock, signal: controller.signal,
      validate: async () => { entered.resolve(); await held.promise; },
      process: () => assert.fail("An expired or canceled preflight should not begin publishing."), verify: () => true });
    pending.push(drain);
    await entered.promise;
    if (limit === "deadline") clock = until;
    else controller.abort();
    held.resolve();

    const result = await drain;
    const deferred = job(store, queue, queued.id);
    assert.equal(result.attempted, 1, "A deferred validation should retain its claimed attempt.");
    assert.equal(deferred.status, "ready", "A run limit should preserve validated input for a later authorized run.");
    assert.equal(deferred.stage, "validation-deferred", "The job should identify why publishing did not start.");
    assert.equal(deferred.attempts, 1, "Deferral should preserve the attempt count.");
    assert.equal(deferred.timings.processMs, undefined, "Deferral should not claim processing time.");
    assert.equal(result.completed.length, 0, "A deferred preflight should not count as publication.");
    assert.equal(limit === "deadline" ? result.deadlineReached : result.aborted, true,
      "The drain should report the run limit that prevented publishing.");
  }
});

test("a producer arriving during rejected validation keeps its ready work", async t => {
  const { store, releases, pending } = await fixture(t), queue = "validation-producer";
  const badInput = await input(store), goodInput = await input(store, "Concurrent reviewed input");
  const bad = await enqueueKnowledgeBatch(store, { queue, inputEvidence: badInput.id, entryIndices: [742] });
  const entered = Promise.withResolvers(), held = Promise.withResolvers();
  releases.push(held.resolve);
  const drain = drainKnowledgeQueue(store, { queue, maxBatches: 2,
    validate: async current => {
      if (current.id === bad.id) {
        entered.resolve();
        await held.promise;
        throw new IngestionInputError("Invalid proof.");
      }
    },
    process: current => ({ input: current.inputEvidence }), verify: (current, receipt) => receipt.input === current.inputEvidence });
  pending.push(drain);
  await entered.promise;
  const good = await enqueueKnowledgeBatch(store, { queue, inputEvidence: goodInput.id, entryIndices: [744] });
  held.resolve();

  const result = await drain;
  assert.deepEqual(result.completed, [good.id], "A producer arriving during validation should retain its verified completion.");
  assert.equal(job(store, queue, bad.id).status, "awaiting-input-correction", "The rejected job should retain its correction state.");
  assert.equal(knowledgeIngestionStatus(store, queue).jobs.length, 2, "Rejection should preserve both concurrent queue jobs.");
});

test("typed rejection respects the attempt bound and the next claim deadline", async t => {
  const { store } = await fixture(t), queue = "rejection-limit";
  const firstInput = await input(store), secondInput = await input(store, "Later audit");
  const first = await enqueueKnowledgeBatch(store, { queue, inputEvidence: firstInput.id, entryIndices: [742] });
  const second = await enqueueKnowledgeBatch(store, { queue, inputEvidence: secondInput.id, entryIndices: [744] });
  let clock = Date.parse(first.createdAt) + 1;
  const until = clock + 100;
  const result = await drainKnowledgeQueue(store, { queue, maxBatches: 2,
    deadline: new Date(until).toISOString(), now: () => clock,
    validate: () => { clock = until; throw new IngestionInputError("Invalid proof."); },
    process: () => assert.fail("Rejected preflight should not start processing."), verify: () => true });

  assert.deepEqual(result.awaitingInputCorrection, [first.id], "Rejection should retain the first input before the deadline stops the next claim.");
  assert.equal(result.attempted, 1, "A reached deadline should prevent attempting the second input.");
  assert.equal(job(store, queue, second.id).attempts, 0, "The next input should remain unclaimed after the deadline.");
  const bounded = await drainKnowledgeQueue(store, { queue, maxBatches: 1,
    validate: () => { throw new IngestionInputError("Invalid second proof."); },
    process: () => assert.fail("A rejected input should not publish."), verify: () => true });
  assert.equal(bounded.attempted, 1, "A rejected validator should consume the configured batch bound.");
});
