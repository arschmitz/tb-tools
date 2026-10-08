import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migratePatchIdentityFields, resolvePatchIdentity } from "../../lib/patch-identity.mjs";

export const TRY_STATUS_CHECK_INTERVAL_MS = 60 * 1000;
export const TRY_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const TRY_MONITOR_DIRECTORY = path.join(os.homedir(), ".tb-tools", "try-monitor");

export function isLatestTryWorkflow(state, workflows) {
  const own = workflows.find(other => other.id === state.id);
  const attempt = state.attempts.at(-1);
  if (own && (own.attempts.at(-1)?.id !== attempt?.id || own.attempts.at(-1)?.url !== attempt?.url)) return false;
  const time = Date.parse(attempt?.createdAt || "") || 0;
  return !workflows.some(other => other.id !== state.id && other.path === state.path &&
    ((state.tbToolsId && resolvePatchIdentity(state.tbToolsId) === resolvePatchIdentity(other.tbToolsId)) || (state.sourceHash && state.sourceHash === other.sourceHash) || other.relatedWorkflowIds?.includes(state.id)) &&
    (Date.parse(other.attempts.at(-1)?.createdAt || "") || 0) > time);
}

function attachEvidence(state, initial) {
  let evidence = initial;
  Object.defineProperty(state, "evidence", {
    configurable: true, enumerable: false,
    get() { return evidence ??= JSON.parse(readFileSync(state.evidenceFile, "utf8")); },
    set(value) { Object.defineProperty(state, "evidence", { value, enumerable: true, writable: true, configurable: true }); },
  });
  return state;
}

// Each workflow has its own file. A push cannot overwrite another push's state.
export function createTryMonitorStore(directory = TRY_MONITOR_DIRECTORY) {
  const file = id => {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid Try monitor ID.");
    return path.join(directory, `${id}.json`);
  };
  return {
    directory,
    isAutomationPaused: () => existsSync(path.join(directory, ".automation-paused")),
    read(id) {
      const state = migratePatchIdentityFields(JSON.parse(readFileSync(file(id), "utf8")));
      return state.evidenceFile && !state.evidence ? attachEvidence(state) : state;
    },
    list() {
      if (!existsSync(directory)) return [];
      return readdirSync(directory).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name))
        .map(name => this.read(name.slice(0, -5)));
    },
    migrateIdentities(paths) {
      for (const saved of this.list()) {
        if (paths && !paths.has(saved.repositoryPath || saved.path)) continue;
        const release = this.lock(saved.id);
        if (!release) continue;
        try {
          const state = JSON.parse(readFileSync(file(saved.id), "utf8"));
          const before = JSON.stringify(state);
          migratePatchIdentityFields(state);
          if (JSON.stringify(state) !== before) this.save(state);
        } finally { release(); }
      }
    },
    save(state) {
      migratePatchIdentityFields(state);
      mkdirSync(directory, { recursive: true });
      const target = file(state.id);
      if (Object.prototype.propertyIsEnumerable.call(state, "evidence") && state.evidence) {
        const evidence = state.evidence;
        const evidenceDirectory = path.join(directory, "evidence");
        mkdirSync(evidenceDirectory, { recursive: true });
        const evidenceFile = path.join(evidenceDirectory, `${state.id}-${randomUUID()}.json`);
        const fd = openSync(evidenceFile, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify(evidence)); fsyncSync(fd); }
        finally { closeSync(fd); }
        state.evidenceFile = evidenceFile;
        attachEvidence(state, evidence);
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, target);
      const parent = openSync(directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
      return state;
    },
    lock(id) {
      mkdirSync(directory, { recursive: true });
      const lockPath = `${file(id)}.lock`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Publish a complete owner record atomically. A crash while writing
          // must not leave an empty lock that can never be recovered.
          const ownerPath = `${lockPath}.${randomUUID()}.owner`;
          writeFileSync(ownerPath, String(process.pid), { flag: "wx", mode: 0o600 });
          try { linkSync(ownerPath, lockPath); } finally { unlinkSync(ownerPath); }
          return () => unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const pid = Number(readFileSync(lockPath, "utf8"));
          if (!Number.isInteger(pid) || pid < 1) return null;
          try { process.kill(pid, 0); return null; } catch (probe) {
            if (probe.code !== "ESRCH") return null;
          }
          try { unlinkSync(lockPath); } catch (remove) { if (remove.code !== "ENOENT") throw remove; }
        }
      }
      return null;
    },
  };
}

export function isTryWorkerRunning(state) {
  return [state.aiPid, state.workerPid].some(pid => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

export function hasCompletedUnrelatedAssessment(attempt) {
  const failures = attempt?.assessment?.failures;
  return Boolean(attempt?.statusComplete && !attempt.buildValidationBlocked && !attempt.assessmentOutdated && failures?.length &&
    (attempt.failedJobCount === undefined || attempt.failedJobCount === failures.length) &&
    failures.every(failure => failure.cause === "unrelated"));
}

export function reconcileTryAssessment(state) {
  const attempt = state.attempts.at(-1);
  if (!["waiting", "analyzing", "needs-evidence", "repairing"].includes(state.phase) || !hasCompletedUnrelatedAssessment(attempt)) return false;
  state.phase = attempt.status = "passed";
  attempt.summary = "No patch-caused failures. " + attempt.assessment.failures.map(failure => failure.reason).join("\n");
  state.nextCheckAt = null;
  delete state.error;
  delete state.repairActivity;
  delete state.pendingRepairReport;
  delete attempt.assessmentError;
  return true;
}

export function getMonitoredTryVerdict(state, attempt = state.attempts.at(-1)) {
  if (!attempt) return "unknown";
  const failures = attempt.assessmentOutdated ? null : attempt.assessment?.failures;
  if (attempt.determinedVerdict === "patch-failed" || attempt.rustFailure ||
      failures?.some(failure => failure.cause === "patch")) return "patch-failed";
  if (attempt.buildValidationBlocked) return "build-blocked";
  if (attempt.determinedVerdict === "passed") return "passed";
  if (Array.isArray(failures) && failures.length) {
    if (failures.every(failure => failure.cause === "unrelated")) return "passed";
    return attempt.statusComplete && attempt.resultStatus === "failed" ? "failed-unclassified" : "needs-evidence";
  }
  if (attempt.rustFailure || attempt.buildValidationBlocked) return "patch-failed";
  if (attempt.status === "passed" || (attempt.statusComplete && attempt.resultStatus === "passed")) return "passed";
  if (attempt.status === "patch-failed") return "patch-failed";
  if (state.imported) return "unknown";
  if (attempt.statusComplete && ["failed", "submission-failed"].includes(attempt.resultStatus)) return "failed-unclassified";
  if (attempt === state.attempts.at(-1)) {
    if (state.phase === "analyzing" && !attempt.assessmentError) return "analyzing";
    if (["waiting", "submitting"].includes(state.phase) && !attempt.statusComplete) return "waiting";
  }
  return attempt.statusComplete ? "needs-evidence" : "waiting";
}

export function monitorRuns(state) {
  const attempts = state.attempts.filter(attempt => attempt.url);
  const sourceHashes = new Set([state.sourceHash, ...(state.sourceUpdates || []).map(update => update.sourceHash)]);
  return attempts.map((attempt, index) => ({
    id: attempt.id, url: attempt.url, createdAt: attempt.createdAt,
    hash: attempt.mergedInto || attempt.hash || state.sourceHash, testedHash: attempt.hash || state.sourceHash,
    mergedInto: attempt.mergedInto,
    sourceHash: state.sourceHash, fixupHash: state.fixupHash,
    isFixup: Boolean(!attempt.mergedInto && (attempt.isFixup ??
      (attempt.hash && !sourceHashes.has(attempt.hash)))),
    tbToolsId: state.tbToolsId, patchId: state.patchId, repairTargetTbToolsId: state.fixupTargetTbToolsId,
    subject: state.subject, label: state.label,
    monitorId: state.id,
    status: getMonitoredTryVerdict(state, attempt),
    imported: Boolean(state.imported),
    aiRunning: index === attempts.length - 1 && isTryWorkerRunning({ aiPid: state.aiPid }),
    workerRunning: index === attempts.length - 1 && isTryWorkerRunning(state),
    failureCategory: attempt.failureCategory,
    rustFailure: attempt.rustFailure,
    resultStatus: attempt.resultStatus,
    statusComplete: attempt.statusComplete,
    buildValidationBlocked: attempt.buildValidationBlocked,
    phase: index === attempts.length - 1 ? state.phase : "superseded",
    activity: index < attempts.length - 1 ? ""
      : ({ "waiting-new-try": "Waiting for new run", "rust-blocked": attempt.rustOrigin?.available ? "Rust update available; needs rebase" : "Waiting for Rust update", analyzing: state.repairActivity || "Preparing analysis", "needs-evidence": state.repairActivity || "Preparing analysis", repairing: state.repairActivity || "Working",
        "ready-to-submit": "Posting another Try", submitting: "Posting another Try" })[state.phase] || "",
    retryUrl: attempts[index + 1]?.url || "",
    summary: attempt.summary || "",
    error: attempt.statusError || (index === attempts.length - 1 ? state.error || "" : ""),
    assessment: attempt.assessment,
    checkedAt: attempt.checkedAt,
    updatedAt: [attempt.createdAt, attempt.checkedAt, attempt.verdictAt,
      index === attempts.length - 1 ? state.activityUpdatedAt : attempts[index + 1]?.createdAt]
      .filter(Boolean).sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0],
    nextCheckAt: index === attempts.length - 1 ? state.nextCheckAt : null,
  }));
}

export function mergeMonitoredTryRuns(graph, store, monitors = createTryMonitorStore().list()) {
  const matching = monitors.filter(state => path.resolve(state.path) === path.resolve(graph.path));
  const fresh = matching.flatMap(monitorRuns);
  const urls = new Set(fresh.map(run => run.url));
  return { ...store, runs: [...fresh, ...store.runs.filter(run => !urls.has(run.url))], monitors: matching };
}
