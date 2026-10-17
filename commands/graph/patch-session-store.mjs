import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeKeys = new Set([
  "resumeOnRestart",
  "updateOperationRunning", "graph", "snapshot", "codexAgent", "codexMessageDeltas", "abortController", "cancel", "freeformOperationRunning", "freeformOperationStatus",
]);

export function shouldResumeReviewAfterRestart(session) {
  return Boolean(canResumePatchSession(session) && !session.dismissed && !session.restored &&
    ["pulling", "reviewing"].includes(session.status));
}

export function canResumePatchSession(session) {
  const preparingCheckout = session?.managedWorktree && session.revision &&
    (session.status === "pulling" || ["paused", "error"].includes(session.status) &&
      (session.applyConflict || session.currentHash || session.reviewMainHash));
  return Boolean(session && !session.cancelled && !session.worktreeRemoved && (preparingCheckout || session.currentHash &&
    (session.codexSessionId || session.managedWorktree && session.originalHash || ["review", "complete"].includes(session.status))));
}

export function createPatchSessionStore({ directory } = {}) {
  const root = directory ?? ((process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis)
    ? "" : path.join(os.homedir(), ".tb-tools", "patch-sessions"));
  const previous = new Map();
  const filename = (kind, session) => path.join(root, `${createHash("sha256")
    .update(`${kind === "update" && ["verify", "freeform"].includes(session.mode) ? session.mode : kind}:${session.graph.path}:${session.revision}`).digest("hex")}.json`);
  return {
    list(graphs, { includeFinished = false } = {}) {
      if (!root) return [];
      let files;
      try { files = readdirSync(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      const records = files.filter(file => file.endsWith(".json")).map(file => JSON.parse(readFileSync(path.join(root, file), "utf8"), (_key, value) =>
          value && Object.keys(value).length === 1 && Array.isArray(value.savedMapEntries) ? new Map(value.savedMapEntries) : value));
      const latest = new Map();
      for (const saved of records) {
        const key = JSON.stringify([saved.kind, saved.taskGraph?.repositoryPath || saved.graphPath, saved.data.revision, saved.data.mode || "update"]);
        const previous = latest.get(key);
        if (!previous || String(saved.data.updatedAt || "") > String(previous.data.updatedAt || "")) latest.set(key, saved);
      }
      return [...latest.values()].flatMap(saved => {
        if (!saved.taskGraph || saved.data.worktreeRemoved && (!includeFinished || !existsSync(path.dirname(saved.taskGraph.path))) || (!canResumePatchSession(saved.data) &&
            !(includeFinished && ["complete", "cancelled", "canceled", ...(saved.kind === "review" ? ["error"] : [])].includes(saved.data.status)))) return [];
        const graphIndex = graphs.findIndex(graph => graph.path === saved.taskGraph.repositoryPath);
        if (graphIndex < 0) return [];
        return [{ kind: saved.kind, session: { ...saved.data,
          resumeOnRestart: saved.kind === "review" && shouldResumeReviewAfterRestart(saved.data),
          graph: { ...graphs[graphIndex], ...saved.taskGraph, knownHashes: new Set() }, graphIndex,
          snapshot: null, codexAgent: null, codexTurnId: "", restored: true,
          interrupted: !["review", "complete", "cancelled"].includes(saved.data.status), abortController: new AbortController() } }];
      });
    },
    save(kind, session) {
      if (!root) return;
      const file = filename(kind, session);
      if (!canResumePatchSession(session) && !session.worktreeRemoved && !session.dismissed &&
          !["complete", "cancelled", "canceled"].includes(session.status)) {
        try {
          const existing = JSON.parse(readFileSync(file, "utf8"));
          if (canResumePatchSession(existing.data)) return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const data = Object.fromEntries(Object.entries(session).filter(([key, value]) =>
        key !== "updatedAt" && !runtimeKeys.has(key) && typeof value !== "function"));
      const saved = { version: 1, kind, graphPath: session.graph.path,
        taskGraph: session.graph.taskWorktree ? { path: session.graph.path, taskWorktree: true,
          taskId: session.graph.taskId, branchNamespace: session.graph.branchNamespace, repositoryPath: session.repositoryPath } : null, data };
      const encode = value => JSON.stringify(value, (_key, value) =>
        value instanceof Map ? { savedMapEntries: [...value] } : value);
      const signature = encode(saved);
      if (previous.get(file) === signature) return;
      session.updatedAt = new Date().toISOString();
      data.updatedAt = session.updatedAt;
      const content = encode(saved);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, file);
      previous.set(file, signature);
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
              value.data.revision === session.revision && (value.data.mode || "update") === mode)
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
          saved.data.revision !== session.revision || !canResumePatchSession(saved.data)) return null;
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
