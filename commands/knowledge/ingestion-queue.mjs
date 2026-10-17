import { canonical, digest, validateRecord } from "./store.mjs";
import { withKnowledgeLock } from "./sync.mjs";
import { setTimeout as delay } from "node:timers/promises";

export class IngestionInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "IngestionInputError";
  }
}

function queueKey(queue) {
  if (typeof queue !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(queue)) {
    throw new Error("Invalid ingestion queue name.");
  }
  return `ingestion-queue:${queue}`;
}

export function knowledgeIngestionStatus(store, queue) {
  return store.setting(queueKey(queue)) || { version: 1, jobs: [] };
}

async function updateQueue(store, queue, update) {
  const key = queueKey(queue);
  const result = await withKnowledgeLock(store.directory, `${key}:state`, async () => {
    const state = knowledgeIngestionStatus(store, queue);
    const result = await update(state);
    store.setting(key, state);
    return { value: result };
  });
  if (result.busy) throw new Error("Ingestion queue state is busy; retry the operation.");
  return result.value;
}

async function transition(store, queue, job, changes) {
  const at = new Date().toISOString();
  const next = { ...job, ...changes, updatedAt: at };
  const event = await store.put({ kind: "evidence", visibility: "private", repository: job.repository,
    at, paths: [], source: { type: "ingestion-queue-transition", queue, job: job.id,
      inputEvidence: job.inputEvidence, previous: job.eventEvidence || null, chronologicalCoverage: false },
    text: JSON.stringify(next) });
  return { ...next, eventEvidence: event.id };
}

export async function enqueueKnowledgeBatch(store, { queue, inputEvidence, entryIndices }) {
  queueKey(queue);
  if (!/^[a-f0-9]{64}$/.test(inputEvidence || "") || !Array.isArray(entryIndices) || !entryIndices.length ||
      entryIndices.some((value, index) => !Number.isSafeInteger(value) || value < 1 || (index && value <= entryIndices[index - 1]))) {
    throw new Error("Ingestion needs an immutable input ID and ascending unique entry indices.");
  }
  const input = store.get(inputEvidence);
  if (!input || input.kind !== "evidence" || input.visibility !== "private") {
    throw new Error("Ingestion input must be saved private evidence.");
  }
  validateRecord(input);
  const id = digest([queue, inputEvidence]);
  return updateQueue(store, queue, async state => {
    const existing = state.jobs.find(job => job.id === id);
    if (existing) {
      if (canonical(existing.entryIndices) !== canonical(entryIndices)) throw new Error("Ingestion input has a different entry mapping.");
      return existing;
    }
    const at = new Date().toISOString();
    const job = await transition(store, queue, { id, inputEvidence, entryIndices,
      repository: input.repository, createdAt: at, attempts: 0 }, { status: "ready", stage: "queued" });
    state.jobs.push(job);
    return job;
  });
}

// The processor must be idempotent. A process can stop after publishing but
// before saving completion, so a later runner may receive the same input again.
// If provided, validate checks input without publishing. It must throw
// IngestionInputError when that input needs correction.
export async function drainKnowledgeQueue(store, { queue, process, verify, validate, maxBatches = 1,
  deadline, now = Date.now, continuous = false, pollIntervalMs = 1000, signal,
  wait = (milliseconds, options) => delay(milliseconds, undefined, options) } = {}) {
  const key = queueKey(queue);
  if (typeof process !== "function" || typeof verify !== "function" || typeof now !== "function" ||
      (validate !== undefined && typeof validate !== "function") ||
      !Number.isSafeInteger(maxBatches) || maxBatches < 1 ||
      (deadline !== undefined && !Number.isFinite(Date.parse(deadline))) ||
      typeof continuous !== "boolean" || (continuous && deadline === undefined) ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10000 ||
      typeof wait !== "function" || (signal !== undefined && !(signal instanceof AbortSignal))) {
    throw new Error("Invalid ingestion runner options.");
  }
  const until = deadline === undefined ? Infinity : Date.parse(deadline);
  const stopped = () => signal?.aborted || now() >= until;
  const elapsed = began => Math.max(0, now() - began);

  return withKnowledgeLock(store.directory, `${key}:runner`, async () => {
    const completed = [], awaitingInputCorrection = [], attempted = new Set();
    let idleWaitMs = 0;

    while (attempted.size < maxBatches && !stopped()) {
      const job = await updateQueue(store, queue, async state => {
        // Lock acquisition can wait. Check the run limit before claiming work.
        if (stopped()) return null;

        const index = state.jobs.findIndex(item => !attempted.has(item.id) &&
          ["ready", "failed", "running"].includes(item.status));
        if (index < 0) return null;
        const old = state.jobs[index];
        const next = await transition(store, queue, old, { status: "running", stage: "processing",
          previousStage: old.stage, recoveredInterruption: old.status === "running",
          attempts: old.attempts + 1, startedAt: new Date().toISOString(), error: null,
          timings: { queueWaitMs: elapsed(Date.parse(old.createdAt)) } });
        state.jobs[index] = next;
        return next;
      });

      if (!job) {
        if (!continuous || stopped()) break;

        // Keep runner ownership, but release the state lock for producers.
        const began = now();
        const milliseconds = Math.max(0, Math.min(pollIntervalMs, until - began));
        try {
          await wait(milliseconds, { signal });
        } catch (error) {
          if (error.name !== "AbortError" || !signal?.aborted) throw error;
          idleWaitMs += elapsed(began);
          break;
        }
        idleWaitMs += elapsed(began);
        continue;
      }

      attempted.add(job.id);
      const began = now(), timings = { ...job.timings };
      let validationBegan, verificationBegan;
      let processBegan = validate ? undefined : began;
      const updateJob = changes => updateQueue(store, queue, async state => {
        const index = state.jobs.findIndex(item => item.id === job.id);
        if (index < 0) throw new Error("Ingestion job disappeared.");
        state.jobs[index] = await transition(store, queue, state.jobs[index], changes);
        return state.jobs[index];
      });
      const progress = async stage => {
        if (typeof stage !== "string" || !stage.trim() || stage.length > 100) throw new Error("Invalid ingestion stage.");
        await updateJob({ stage });
      };
      try {
        const input = store.get(job.inputEvidence);
        if (!input || input.visibility !== "private") throw new Error("Ingestion input is unavailable.");
        validateRecord(input);

        if (validate) {
          validationBegan = now();
          await updateJob({ stage: "validating-input" });
          // Only this read-only preflight may reject input for correction.
          // Publication and receipt failures must still stop the runner.
          try {
            await validate(job);
          } catch (error) {
            if (!(error instanceof IngestionInputError)) throw error;

            timings.validationMs = elapsed(validationBegan);
            timings.totalMs = elapsed(began);
            const rejected = await updateJob({ status: "awaiting-input-correction",
              failedAt: new Date().toISOString(), error: String(error.message || error).slice(0, 2000), timings });
            awaitingInputCorrection.push(rejected.id);
            continue;
          }

          timings.validationMs = elapsed(validationBegan);
          if (stopped()) {
            timings.totalMs = elapsed(began);
            await updateJob({ status: "ready", stage: "validation-deferred", timings });
            break;
          }

          processBegan = now();
          await updateJob({ stage: "processing", timings: { ...timings } });
        }

        const result = await process(job, progress);

        timings.processMs = elapsed(processBegan);
        verificationBegan = now();
        await updateJob({ stage: "verifying-publication", timings: { ...timings } });
        if (await verify(job, result) !== true) throw new Error("Ingestion publication was not verified.");

        timings.verificationMs = elapsed(verificationBegan);
        timings.totalMs = elapsed(began);
        const saved = await updateJob({ status: "completed", stage: "completed",
          finishedAt: new Date().toISOString(), result, timings });
        completed.push(saved.id);
      } catch (error) {
        if (verificationBegan === undefined) {
          if (processBegan !== undefined) timings.processMs = elapsed(processBegan);
          else if (validationBegan !== undefined) timings.validationMs = elapsed(validationBegan);
        } else timings.verificationMs = elapsed(verificationBegan);
        timings.totalMs = elapsed(began);
        await updateJob({ status: "failed", failedAt: new Date().toISOString(),
          error: String(error.message || error).slice(0, 2000), timings });
        throw error;
      }
    }

    return { completed, awaitingInputCorrection, attempted: attempted.size, deadlineReached: now() >= until,
      aborted: Boolean(signal?.aborted), idleWaitMs };
  });
}
