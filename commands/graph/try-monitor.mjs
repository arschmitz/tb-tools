import path from "node:path";
import { findRustDependencyFailure, checkRustOriginUpdate } from "./try-rust.mjs";
import { resumeTryFixupSquash } from "./try-fixup.mjs";
import { randomUUID } from "node:crypto";
import { createTryMonitorStore, TRY_CHECK_INTERVAL_MS, TRY_STATUS_CHECK_INTERVAL_MS, isLatestTryWorkflow, reconcileTryAssessment, hasCompletedUnrelatedAssessment } from "./try-monitor-store.mjs";
import { createTreeherderClient } from "./treeherder.mjs";
import { createTryRepairer } from "./try-repair.mjs";
import { finishTrySubmission } from "./try-submission.mjs";
import { getAiUsageBlock } from "./ai-usage.mjs";

function recordInspection(attempt, inspection, now) {
  attempt.checkedAt = new Date(now).toISOString();
  attempt.summary = inspection.summary || `${inspection.jobs.length} jobs; ${inspection.failures.length} unsuccessful jobs.`;
  attempt.resultStatus = inspection.submissionFailed ? "submission-failed"
    : !inspection.complete ? "waiting" : inspection.failures.length ? "failed" : "passed";
  attempt.statusComplete = Boolean(inspection.complete || inspection.submissionFailed);
  attempt.statusError = "";
  attempt.failedJobCount = inspection.failures.length;
  const builds = inspection.jobs.filter(job => /^build[-/]/i.test(job.job_type_name || ""));
  attempt.buildValidationBlocked = Boolean(inspection.complete && builds.length &&
    !builds.some(job => job.state === "completed" && job.result === "success"));
}

export function createTryMonitor({ graphs, store = createTryMonitorStore(), treeherder,
  repairer, codexCommand, rustOriginCheck = checkRustOriginUpdate, aiEnabled = true, now = Date.now, onError = console.error, tickIntervalMs = 60000 } = {}) {
  const controller = new AbortController();
  treeherder ||= createTreeherderClient({ signal: controller.signal });
  repairer ||= createTryRepairer({ store, codexCommand, signal: controller.signal });
  let timer;
  let releaseOwner;
  const active = new Map();
  let stopped = false;
  let stopPromise;
  const aiAllowed = () => aiEnabled && !store.isAutomationPaused?.();
  const hasNewerTry = state => !isLatestTryWorkflow(state, store.list());
  function canStartAi(state) {
    if (stopped || hasNewerTry(state)) {
      if (!stopped) { state.phase = "superseded"; state.nextCheckAt = null; }
      return false;
    }
    return true;
  }
  async function advance(state) {
    if (state.phase === "squashing") { await resumeTryFixupSquash({ state, store }); return; }
    const attempt = state.attempts.at(-1);
    if (attempt.rustFailure) {
      state.phase = "rust-blocked";
      state.nextCheckAt = now() + TRY_CHECK_INTERVAL_MS;
      const update = await rustOriginCheck(state);
      attempt.rustOrigin = { ...update, checkedAt: new Date(now()).toISOString() };
      state.error = update.available
        ? "Failed due to Rust. Compatible updates are available from origin. Rebase onto the compatible source before another Try."
        : "Failed due to Rust. Waiting for compatible updates from origin; automatic retry is blocked.";
      return;
    }
    if (state.phase === "waiting-new-try") state.phase = attempt.assessment?.failures?.some(failure => failure.cause === "patch") ? "repairing" : "needs-evidence";
    if (state.phase === "submitting") {
      const url = attempt.url || await treeherder.findSubmission(attempt.marker, Date.parse(attempt.createdAt));
      if (url) finishTrySubmission(state, store, url, now() - TRY_STATUS_CHECK_INTERVAL_MS);
      else {
        state.error = "Waiting to reconcile an interrupted submission. No duplicate push will be made.";
        return;
      }
    }
    if (["waiting", "analyzing", "needs-evidence"].includes(state.phase)) {
      const inspection = await treeherder.inspect(attempt.url);
      recordInspection(attempt, inspection, now());
      if (inspection.submissionFailed) {
        attempt.status = "submission-failed";
        attempt.summary = inspection.summary;
        state.phase = "ready-to-submit";
        return;
      }
      if (inspection.summary) attempt.summary = inspection.summary;
      if (!inspection.complete) { state.phase = "waiting"; state.nextCheckAt = now() + TRY_STATUS_CHECK_INTERVAL_MS; return; }
      if (!inspection.failures.length && attempt.buildValidationBlocked) {
        state.phase = attempt.status = "build-blocked";
        attempt.summary = "No build completed successfully. Tests could not validate this patch.";
        state.nextCheckAt = null;
        return;
      }
      if (!inspection.failures.length) {
        if (attempt.assessment) attempt.previousAssessment = attempt.assessment;
        delete attempt.assessment;
        state.phase = attempt.status = "passed";
        attempt.summary = "All scheduled jobs completed successfully.";
        return;
      }
      if (!aiAllowed()) {
        state.phase = "needs-evidence";
        attempt.status = "needs-evidence";
        attempt.summary = "Try has failures. Enable AI to determine their cause and repair patch failures.";
        return;
      }
      const changedFailures = attempt.assessment &&
        (attempt.assessment.failures.length !== inspection.failures.length ||
          inspection.failures.some(job => !attempt.assessment.failures.some(failure => failure.id === String(job.id))));
      if (!attempt.assessment || changedFailures || attempt.assessmentError) {
        state.phase = "analyzing";
        attempt.assessmentAttempts = (attempt.assessmentAttempts || 0) + 1;
        delete attempt.assessmentError;
        store.save(state);
        try {
          const evidenceKey = JSON.stringify([attempt.id, inspection.revision, inspection.failures.map(job => String(job.id)).sort()]);
          const evidence = state.evidenceKey === evidenceKey && state.evidence
            ? state.evidence : await treeherder.compare(inspection, (completed, total, detail) => {
              const active = detail?.active?.map(push => `${push.repo} push ${push.push}: ${push.done}/${push.total} failed jobs`).join("; ");
              state.repairActivity = `Fetching CI evidence: ${completed} of ${total} pushes` +
                (detail ? ` (${detail.reused} pushes cached)` : "") + (active ? `; ${active}` : "");
              state.activityUpdatedAt = new Date(now()).toISOString();
              store.save(state);
            });
          state.evidenceKey = evidenceKey;
          state.evidence = evidence;
          store.save(state);
          if (!canStartAi(state)) return;
          state.repairActivity = "Evaluating failure evidence";
          store.save(state);
          attempt.assessment = await repairer.assess(state, evidence);
          attempt.verdictAt = new Date(now()).toISOString();
        } catch (error) {
          if (["TRY_SUPERSEDED", "TRY_SOURCE_CHANGED"].includes(error.code)) { state.phase = error.code === "TRY_SOURCE_CHANGED" ? "repairing" : "superseded"; state.error = error.message; state.nextCheckAt = null; return; }
          if (!stopped) {
            attempt.assessmentError = error.message;
            state.phase = "needs-evidence";
            state.nextCheckAt = now() + evidenceRetryDelay(attempt);
          }
          throw error;
        }
      }
      attempt.failureCategory = attempt.buildValidationBlocked ? attempt.assessment?.failureCategory : undefined;
      state.assessment = attempt.assessment;
      const failures = state.assessment.failures;
      const patchFailures = failures.filter(failure => failure.cause === "patch");
      if (patchFailures.length) {
        // Handle Rust updates only after attribution finds a patch failure.
        if (treeherder.evidence) {
          for (const job of inspection.failures.filter(job => patchFailures.some(failure => failure.id === String(job.id)) && /^build[-/]/i.test(job.job_type_name || ""))) {
            const failure = await treeherder.evidence(inspection.repo, job);
            const rustFailure = await findRustDependencyFailure({ failures: [failure] });
            if (rustFailure) {
              attempt.rustFailure = rustFailure;
              attempt.status = "patch-failed";
              attempt.summary = "Failed due to Rust dependency mismatch.";
              state.phase = "rust-blocked";
              state.error = "Failed due to Rust. Waiting for compatible updates from origin; automatic retry is blocked.";
              state.nextCheckAt = now() + TRY_CHECK_INTERVAL_MS;
              return;
            }
          }
        }
        state.phase = "repairing";
        state.repairReceipt = randomUUID();
        attempt.status = "patch-failed";
        attempt.summary = patchFailures.map(failure => failure.reason).join("\n");
        store.save(state);
      } else if (failures.some(failure => failure.cause === "unknown")) {
        state.phase = "repairing";
        state.repairActivity = "Investigating failures";
        state.repairReceipt = randomUUID();
        attempt.summary = "Investigating unresolved failures against current code and running focused checks.";
        store.save(state);
      } else if (attempt.buildValidationBlocked) {
        state.phase = attempt.status = "build-blocked";
        attempt.summary = "No build completed successfully. The failures appear unrelated, but tests did not validate this patch.";
        state.nextCheckAt = null;
        delete state.error;
        return;
      } else {
        state.phase = attempt.status = "passed";
        attempt.summary = "No patch-caused failures. " + failures.map(failure => failure.reason).join("\n");
        delete state.error;
        return;
      }
    }
    if (stopped) return;
    if (!aiAllowed() && ["repairing", "ready-to-submit"].includes(state.phase)) {
      state.error = "Enable AI to resume automated Try repair.";
      return;
    }
    if (state.phase === "repairing") {
      if (!canStartAi(state)) return;
      await repairer.repair(state);
    }
    if (stopped) return;
    if (state.phase === "ready-to-submit") {
      const newer = hasNewerTry(state);
      if (newer) state.phase = "superseded";
      else await repairer.submit(state);
    }
  }
  async function tick() {
    if (stopped) return;
    const scheduled = [];
    try {
      const paths = graphs && new Set(graphs.filter(graph => graph.path).map(graph => path.resolve(graph.path)));
      const workflows = store.list().filter(state => !paths || paths.has(path.resolve(state.path)));
      for (const saved of workflows) {
        if (stopped || active.size >= 4) break;
        const usageBlock = saved.attempts.at(-1)?.aiUsageBlock;
        if (usageBlock && (usageBlock.retryAt === null || usageBlock.retryAt > now()) && isLatestTryWorkflow(saved, workflows)) continue;
        // Older saved runs may still carry the previous 30-minute first poll.
        const lastStatus = Date.parse(saved.attempts.at(-1)?.checkedAt || saved.attempts.at(-1)?.createdAt || "");
        // A saved diagnosis is work to resume, not a Treeherder poll. Old
        // versions left these jobs behind a 30-minute evidence timer.
        const interrupted = /App Server was stopped|saved session can be resumed/i.test(saved.error || "");
        const resumeDiagnosis = (interrupted || (!saved.error && !saved.attempts.at(-1)?.assessmentError)) &&
          ["needs-evidence", "analyzing", "repairing", "ready-to-submit"].includes(saved.phase);
        const nextCheck = resumeDiagnosis ? 0 : saved.phase === "waiting" && !saved.error && Number.isFinite(lastStatus)
          ? Math.min(saved.nextCheckAt ?? Infinity, lastStatus + TRY_STATUS_CHECK_INTERVAL_MS) : saved.nextCheckAt;
        if (saved.imported || active.has(saved.id) ||
            ["passed", "build-blocked", "squashed", "paused", "superseded", "needs-rebase"].includes(saved.phase) ||
            (nextCheck > now() && !hasCompletedUnrelatedAssessment(saved.attempts.at(-1)) && isLatestTryWorkflow(saved, workflows))) continue;
        const release = store.lock(saved.id);
        if (!release) continue;
        const task = (async () => {
          let state;
          try {
            state = store.read(saved.id);
            delete state.attempts.at(-1).aiUsageBlock;
            const newer = hasNewerTry(state);
            if (newer && state.phase !== "squashing") { state.phase = "superseded"; state.nextCheckAt = null; return; }
            if (reconcileTryAssessment(state)) return;
            if (state.phase !== "waiting-new-try") state.error = "";
            state.nextCheckAt = now() + TRY_CHECK_INTERVAL_MS;
            store.save(state);
            if (state.aiPid) {
              try {
                process.kill(state.aiPid, 0);
                throw new Error("Waiting for the prior AI worker to exit before recovery.");
              } catch (error) {
                if (error.code !== "ESRCH") throw error;
                delete state.aiPid;
              }
            }
            state.workerPid = process.pid;
            store.save(state);
            await advance(state);
          } catch (error) {
            const usageBlock = getAiUsageBlock(error, now());
            if (state && usageBlock) {
              state.attempts.at(-1).aiUsageBlock = usageBlock;
              state.nextCheckAt = usageBlock.retryAt;
            }
            if (state && ["TRY_SUPERSEDED", "TRY_SOURCE_CHANGED"].includes(error.code)) { state.phase = error.code === "TRY_SOURCE_CHANGED" ? "repairing" : "superseded"; state.error = error.message; state.nextCheckAt = null; }
            else if (state) state.error = error.message;
            else onError(error);
          } finally {
            try { if (state) { delete state.workerPid; store.save(state); } } finally { release(); }
          }
        })();
        active.set(saved.id, task);
        const completed = task.finally(() => active.delete(saved.id));
        scheduled.push(completed);
      }
    } catch (error) { onError(error); }
    await Promise.allSettled(scheduled);
  }

  return {
    tick,
    start() {
      if (timer) return;
      const poll = () => {
        releaseOwner ||= store.lock("monitor-owner");
        if (releaseOwner) void tick();
      };
      poll();
      timer = setInterval(poll, tickIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true; clearInterval(timer); controller.abort();
      return stopPromise = Promise.allSettled([...active.values()]).then(() => { releaseOwner?.(); releaseOwner = undefined; });
    },
  };
}

function evidenceRetryDelay(attempt) {
  return Math.min(TRY_CHECK_INTERVAL_MS, 60000 * 2 ** Math.min(5, (attempt.assessmentAttempts || 1) - 1));
}
