import os from "node:os";
import path from "node:path";
import { isTryWorkerRunning } from "./try-monitor-store.mjs";
import { pruneStorage, STORAGE_LIMITS } from "./storage-retention.mjs";

export function isActiveTryTask(state) {
  return isTryWorkerRunning(state) || (!state.imported &&
    ["waiting", "monitoring", "analyzing", "needs-evidence", "repairing", "ready-to-submit", "submitting", "squashing"].includes(state.phase));
}

export async function pruneTryStorage({ store,
  evidenceDirectory = path.join(os.homedir(), ".tb-tools", "try-evidence") }) {
  const states = store.list();
  const active = states.filter(isActiveTryTask);
  const assessments = path.join(store.directory, "assessment-evidence");
  const evidence = path.join(store.directory, "evidence");
  for (const saved of states.filter(state => !isActiveTryTask(state) && state.evidenceFile)) {
    const release = store.lock(saved.id);
    if (!release) continue;
    try {
      const state = store.read(saved.id);
      if (isActiveTryTask(state)) continue;
      delete state.evidenceFile;
      delete state.evidence;
      state.evidencePrunedAt = new Date().toISOString();
      store.save(state);
    } finally { release(); }
  }
  return {
    cache: await pruneStorage({ directory: evidenceDirectory, ...STORAGE_LIMITS.tryEvidence }),
    assessments: await pruneStorage({ directory: assessments, maxBytes: 0, maxAgeMs: 0,
      keepPaths: active.map(state => path.join(assessments, state.id)) }),
    evidence: await pruneStorage({ directory: evidence, maxBytes: 0, maxAgeMs: 0,
      keepPaths: store.list().map(state => state.evidenceFile).filter(Boolean) }),
  };
}
