import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeKeys = new Set([
  "graph", "snapshot", "codexAgent", "codexMessageDeltas", "abortController", "cancel", "freeformOperationRunning", "freeformOperationStatus",
]);

export function canResumePatchSession(session) {
  return Boolean(session && !session.cancelled && session.currentHash &&
    (session.codexSessionId || ["review", "complete"].includes(session.status)));
}

export function createPatchSessionStore({ directory } = {}) {
  const root = directory ?? ((process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis)
    ? "" : path.join(os.homedir(), ".tb-tools", "patch-sessions"));
  const previous = new Map();
  const filename = (kind, session) => path.join(root, `${createHash("sha256")
    .update(`${kind === "update" && ["verify", "freeform"].includes(session.mode) ? session.mode : kind}:${session.graph.path}:${session.revision}`).digest("hex")}.json`);
  return {
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
      const data = Object.fromEntries(Object.entries(session).filter(([key, value]) =>
        !runtimeKeys.has(key) && typeof value !== "function"));
      const content = JSON.stringify({ version: 1, kind, graphPath: session.graph.path, data }, (_key, value) =>
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
        saved = JSON.parse(readFileSync(filename(kind, session), "utf8"), (_key, value) =>
          value && Object.keys(value).length === 1 && Array.isArray(value.savedMapEntries)
            ? new Map(value.savedMapEntries) : value);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error(`Could not read saved ${kind}: ${error.message}`);
      }
      if (saved.version !== 1 || saved.kind !== kind || saved.graphPath !== session.graph.path ||
          saved.data.revision !== session.revision) return null;
      const restored = {
        ...session, ...saved.data,
        graph: session.graph, graphIndex: session.graphIndex,
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
