import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeKeys = new Set([
  "graph", "snapshot", "codexAgent", "codexMessageDeltas", "abortController", "cancel", "freeformOperationRunning", "freeformOperationStatus",
]);

export function canResumePatchSession(session) {
  return Boolean(session && !session.cancelled && session.currentHash &&
    (session.codexSessionId || session.managedWorktree && session.originalHash || ["review", "complete"].includes(session.status)));
}

export function createPatchSessionStore({ directory } = {}) {
  const root = directory ?? ((process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis)
    ? "" : path.join(os.homedir(), ".tb-tools", "patch-sessions"));
  const previous = new Map();
  const filename = (kind, session) => path.join(root, `${createHash("sha256")
    .update(`${kind === "update" && ["verify", "freeform"].includes(session.mode) ? session.mode : kind}:${session.graph.path}:${session.revision}`).digest("hex")}.json`);
  return {
    list(graphs) {
      if (!root) return [];
      let files;
      try { files = readdirSync(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      return files.filter(file => file.endsWith(".json")).flatMap(file => {
        const saved = JSON.parse(readFileSync(path.join(root, file), "utf8"), (_key, value) =>
          value && Object.keys(value).length === 1 && Array.isArray(value.savedMapEntries) ? new Map(value.savedMapEntries) : value);
        if (!saved.taskGraph || !canResumePatchSession(saved.data)) return [];
        const graphIndex = graphs.findIndex(graph => graph.path === saved.taskGraph.repositoryPath);
        if (graphIndex < 0) return [];
        return [{ kind: saved.kind, session: { ...saved.data,
          graph: { ...graphs[graphIndex], ...saved.taskGraph, knownHashes: new Set() }, graphIndex,
          snapshot: null, codexAgent: null, codexTurnId: "", restored: true,
          interrupted: !["review", "complete", "cancelled"].includes(saved.data.status), abortController: new AbortController() } }];
      });
    },
    save(kind, session) {
      if (!root) return;
      const file = filename(kind, session);
      if (!canResumePatchSession(session)) {
        try {
          const existing = JSON.parse(readFileSync(file, "utf8"));
          if (canResumePatchSession(existing.data)) return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      session.updatedAt = new Date().toISOString();
      const data = Object.fromEntries(Object.entries(session).filter(([key, value]) =>
        !runtimeKeys.has(key) && typeof value !== "function"));
      const content = JSON.stringify({ version: 1, kind, graphPath: session.graph.path,
        taskGraph: session.graph.taskWorktree ? { path: session.graph.path, taskWorktree: true,
          taskId: session.graph.taskId, branchNamespace: session.graph.branchNamespace, repositoryPath: session.repositoryPath } : null, data }, (_key, value) =>
        value instanceof Map ? { savedMapEntries: [...value] } : value);
      if (previous.get(file) === content) return;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, file);
      previous.set(file, content);
    },
    load(kind, session) {
      if (!root) return null;
      let saved;
      try {
        let file = filename(kind, session);
        if (session.graph.taskWorktree) {
          const mode = session.mode || "update";
          const candidates = readdirSync(root).filter(name => name.endsWith(".json"))
            .map(name => { const value = JSON.parse(readFileSync(path.join(root, name), "utf8")); return { name, value }; })
            .filter(({ value }) => value.kind === kind && value.taskGraph?.repositoryPath === session.repositoryPath &&
              value.data.revision === session.revision && (value.data.mode || "update") === mode && canResumePatchSession(value.data))
            .sort((a, b) => String(b.value.data.updatedAt || b.value.data.id).localeCompare(String(a.value.data.updatedAt || a.value.data.id)));
          if (!candidates.length) return null;
          file = path.join(root, candidates[0].name);
        }
        saved = JSON.parse(readFileSync(file, "utf8"), (_key, value) =>
          value && Object.keys(value).length === 1 && Array.isArray(value.savedMapEntries)
            ? new Map(value.savedMapEntries) : value);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(`Could not read saved ${kind}: ${error.message}`);
      }
      if (saved.version !== 1 || saved.kind !== kind || (!session.graph.taskWorktree && saved.graphPath !== session.graph.path) ||
          saved.data.revision !== session.revision) return null;
      const restored = {
        ...session, ...saved.data,
        graph: { ...session.graph, ...(saved.taskGraph || {}) }, graphIndex: session.graphIndex,
        aiEnabled: session.aiEnabled, codexCommand: session.codexCommand,
        codexAgent: null, codexTurnId: "", abortController: new AbortController(),
        snapshot: null, cancelled: false, restored: true,
      };
      restored.interrupted = !["review", "complete", "cancelled"].includes(restored.status);
      return restored;
    },
  };
}

export async function getPatchSessionCheckoutHash(session, runCommand) {
  return String(await runCommand({
    cmd: "git", args: ["rev-parse", "HEAD"], cwd: session.graph.path, capture: true, silent: true,
  })).trim();
}

export async function assertPatchSessionCheckout(session, runCommand) {
  const head = await getPatchSessionCheckoutHash(session, runCommand);
  if (!session.currentHash || head !== session.currentHash) {
    const error = new Error(`Cannot resume ${session.revision}: this checkout is on a different commit. Check out ${session.currentHash || "the patch"} first, or start a new run. No files were changed.`);
    error.statusCode = 409;
    throw error;
  }
}
