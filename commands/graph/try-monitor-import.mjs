import { randomUUID } from "node:crypto";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { readGraphTryStore } from "./data.mjs";
import { parseTryUrl } from "./treeherder.mjs";

// Historical records carry no AI verdict and must never start monitoring.
export async function importRecordedTryRuns({ graphs, store, runCommand = run }) {
  const lock = store.lock("import");
  if (!lock) return;
  try {
    const known = new Set(store.list().flatMap(state => state.attempts.map(attempt => attempt.url)));
    for (const graph of graphs.filter(graph => (graph.repository || graph.label) === "comm" && graph.checkout !== "review" && !graph.error)) {
      const recorded = await readGraphTryStore({ graph, runCommand });
      for (const attempt of recorded.runs) {
        const identity = attempt.tbToolsId || attempt.patchId || attempt.hash;
        if (!identity) continue;
        if (known.has(attempt.url)) continue;
        try { parseTryUrl(attempt.url); } catch { continue; }
        const state = { version: 1, id: randomUUID(), path: graph.path, label: graph.label,
          hash: attempt.hash, sourceHash: attempt.hash, subject: attempt.subject,
          tbToolsId: attempt.tbToolsId, patchId: attempt.patchId,
          geckoPath: path.dirname(graph.path), geckoHash: "", imported: true,
          phase: "paused", nextCheckAt: null, attempts: [{ ...attempt, status: attempt.status || "unknown" }] };
        store.save(state);
        known.add(attempt.url);
      }
    }
  } finally { lock(); }
}
