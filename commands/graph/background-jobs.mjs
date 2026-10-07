import { hasCompletedUnrelatedAssessment } from "./try-monitor-store.mjs";

const finished = new Set(["complete", "completed", "passed", "squashed", "cancelled", "canceled", "superseded", "failed", "done"]);
const waiting = new Set(["waiting", "monitoring", "ready-to-submit", "prompt", "review", "needs-evidence"]);
const inactive = new Set(["paused", "waiting-new-try", "rust-blocked", "needs-rebase", "build-blocked", "error"]);
const running = new Set(["running", "building", "preparing", "pulling", "reviewing", "applying", "amending", "posting", "implementing", "committing", "verifying", "submitting", "squashing", "cancelling"]);

export function summarizeBackgroundJob(kind, session) {
  let phase = session.phase || session.status || "unknown";
  const aiRunning = Boolean(session.aiPid && (() => {
    try { process.kill(session.aiPid, 0); return true; } catch { return false; }
  })());
  const workerRunning = Boolean(kind === "Try repair" && session.workerPid && (() => {
    try { process.kill(session.workerPid, 0); return true; } catch { return false; }
  })());
  const reconciled = kind === "Try repair" && !aiRunning && !workerRunning &&
    ["waiting", "analyzing", "needs-evidence", "repairing"].includes(phase) && hasCompletedUnrelatedAssessment(session.attempts?.at(-1));
  if (reconciled) phase = "passed";
  // A saved failure or a patch awaiting a new Try is history, not a job.
  if (!aiRunning && !workerRunning && inactive.has(phase)) return null;
  const state = aiRunning || workerRunning ? "running" : finished.has(phase) ? "finished"
    : waiting.has(phase) || (kind === "Try repair" && ["analyzing", "repairing"].includes(phase)) ? "waiting"
      : running.has(phase) ? "running" : null;
  if (!state) return null;
  const latest = session.attempts?.at(-1);
  const activity = session.activity?.at?.(-1);
  return {
    id: `${kind}:${session.id}`, kind, state, phase, aiRunning,
    cancelUrl: kind === "Build" && session.status === "running" && !session.cancelRequested
      ? `/api/mach-action/${encodeURIComponent(session.id)}/cancel` : "",
    title: session.subject || session.title || session.revision || session.branch || kind,
    detail: reconciled || (kind === "Try repair" && phase === "passed") ? "No patch-caused failures." : String(session.error || (kind === "Try repair" && phase === "waiting" ? latest?.summary || "Waiting for CI results." : session.repairActivity || activity?.title || latest?.summary || "")).slice(0, 600),
    repairTarget: session.fixupTargetSubject || "",
    nextAction: reconciled ? "" : state === "waiting" && kind === "Try repair"
      ? session.error ? "Retry the saved task after the displayed error." : phase === "waiting" ? "Check CI status." : "Resume the saved AI task." : "",
    checkout: session.workspace || session.graph?.path || session.path || "",
    revision: latest?.hash || session.fixupHash || session.sourceHash || session.currentHash || session.commitHash || "",
    createdAt: session.createdAt || session.startedAt || latest?.createdAt || null,
    updatedAt: [session.activityUpdatedAt, session.updatedAt, latest?.checkedAt].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null,
    nextCheckAt: state === "waiting" ? session.nextCheckAt || null : null,
    url: latest?.url || session.tryUrl || "",
  };
}
