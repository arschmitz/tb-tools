import { readKnowledgeRepository, syncKnowledgeRepository } from "./repository.mjs";
import os from "node:os";
import { generateKnowledge } from "./generate.mjs";
import { knowledgeDirectory, knowledgeInstructions } from "./instructions.mjs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath } from "node:fs/promises";
import { openKnowledgeStore, searchKnowledge, digest, atomicWrite } from "./store.mjs";
import { importLegacyKnowledge } from "./import.mjs";
import { createLocalEmbeddings } from "./embeddings.mjs";
import { learnKnowledge, writeComponentGuides } from "./learning.mjs";
import { syncKnowledge, saveLocalKnowledgeHistory, withKnowledgeLock } from "./sync.mjs";
import { publishProjectLessons } from "./publication.mjs";
import { classifyLearningQueue } from "./claims.mjs";

const execute = promisify(execFile);
const git = async (cwd, args) => (await execute("git", args, { cwd, timeout: 3000, maxBuffer: 100_000 })).stdout.trim();
const expand = value => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);

export function knowledgeOptions(config = {}) {
  const options = config.ai?.knowledge || {};
  return { enabled: config.ai?.enabled === true && options.enabled !== false,
    directory: knowledgeDirectory(config),
    memoryDirectory: expand(options.memoryDirectory || "~/.codex/memories"),
    repositoryDirectory: options.repositoryDirectory ? expand(options.repositoryDirectory) : "",
    remote: options.remote || "", push: options.push !== false,
    semantic: options.semantic !== false, importLegacy: options.importLegacy !== false,
    maxCallsPerDay: Math.max(0, Math.min(24, Number(options.maxCallsPerDay ?? 4) || 0)),
    maxContextChars: Math.max(1000, Math.min(24_000, Number(options.maxContextChars) || 10_000)),
    command: config.ai?.command, repositories: options.repositories || {},
    shareRepositories: Array.isArray(options.shareRepositories) ? options.shareRepositories : [],
  };
}

export async function repositoryContext(cwd, repositories = {}) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const revision = await git(root, ["rev-parse", "HEAD"]);
  let repository = repositories[root];
  if (!repository) {
    for (const [configuredPath, identity] of Object.entries(repositories)) {
      if (await realpath(configuredPath).catch(() => "") === root) { repository = identity; break; }
    }
  }
  if (!repository) {
    if (await access(path.join(root, "mail/config/version.txt")).then(() => true, () => false)) repository = "thunderbird";
    else if (await access(path.join(root, "commands/graph/patch-update.mjs")).then(() => true, () => false)) repository = "tb-tools";
    else {
      // Root commits survive clone moves and avoid storing credential-bearing remote URLs.
      const initial = await git(root, ["rev-list", "--max-parents=0", "HEAD"]);
      repository = `git:${digest(initial).slice(0, 24)}`;
    }
  }
  const [changed, recent] = await Promise.all([
    git(root, ["diff", "--name-only", "HEAD"]),
    git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"]),
  ]);
  const paths = [...new Set(`${changed}\n${recent}`.split("\n").filter(Boolean))].slice(0, 100);
  return { repository, revision, paths, root };
}

export async function createKnowledgeService(options, { generate, embeddings, warn = message => console.warn(message) } = {}) {
  options = { maxContextChars: 10_000, maxCallsPerDay: 4, shareRepositories: [], repositories: {}, ...options };
  options.maxContextChars = Math.max(1000, Math.min(24_000, Number(options.maxContextChars) || 10_000));
  const store = await openKnowledgeStore(options.directory);
  await store.rebuild();
  const semantic = embeddings ?? (options.semantic ? createLocalEmbeddings(options.directory, {
    onError: error => { store.setting("semanticError", error.message); },
  }) : null);
  let timer, running = false, stopped = false, activeAbort, activeJob;
  const error = (stage, failure) => {
    store.setting("lastError", { stage, message: failure.message, at: new Date().toISOString() });
    warn(`Knowledge ${stage}: ${failure.message}`);
  };
  async function generateLessons(prompt) {
    activeAbort = new AbortController();
    try {
      return await (generate || generateKnowledge)(prompt, {
        command: options.command, directory: options.directory, signal: activeAbort.signal,
      });
    } finally { activeAbort = null; }
  }
  async function indexEmbeddings() {
    if (!semantic?.ready) return;
    const missing = store.db.prepare("SELECT r.id,r.body FROM records r LEFT JOIN vectors v ON r.id=v.id AND v.model=? WHERE v.id IS NULL LIMIT 32").all(semantic.model);
    if (!missing.length) return;
    const vectors = await semantic.embed(missing.map(row => {
      const record = JSON.parse(row.body);
      return `${record.title || ""}\n${record.component || ""}\n${record.text}`;
    }), 30_000);
    if (!vectors) return;
    for (let i = 0; i < missing.length; i++) {
      if (!Array.isArray(vectors[i]) || vectors[i].some(n => !Number.isFinite(n))) throw new Error("Invalid local embedding.");
      store.db.prepare("INSERT OR REPLACE INTO vectors VALUES (?, ?, ?)").run(missing[i].id, semantic.model, JSON.stringify(vectors[i]));
    }
    store.setting("semanticError", null);
  }
  const service = {
    store,
    async indexSemantic() { await indexEmbeddings(); },
    get semanticReady() { return semantic?.ready === true; },
    async captureSource({ cwd, title, text, paths = [], revision, type = "source", context: suppliedContext }) {
      const context = suppliedContext || await repositoryContext(cwd, options.repositories);
      const source = { type, revision: revision || context.revision };
      const key = `source:${digest({ repository: context.repository, source, text })}`;
      if (store.setting(key)) return;
      const record = await store.put({ kind: "evidence", repository: context.repository,
        at: new Date().toISOString(), title, text, paths, source,
        visibility: options.shareRepositories?.includes(context.repository) ? "shared" : "private" });
      store.setting(key, record.id);
    },
    async beforeTurn({ cwd, prompt, task }) {
      const started = Date.now();
      const context = await repositoryContext(cwd, options.repositories);
      // Prefer paths, symbols, and the actual request over repeated prompt boilerplate.
      const query = `${context.paths.slice(0, 20).join(" ")} ${task || ""} ${prompt.slice(-6000)}`;
      const vectors = await semantic?.embed([query], 300).catch(failure => {
        store.setting("semanticError", failure.message); return null;
      });
      const result = searchKnowledge(store, { query, repository: context.repository,
        vector: vectors?.[0], model: semantic?.model, maxChars: options.maxContextChars - Math.min(1600, options.maxContextChars / 4) });
      const applicability = [];
      for (const id of result.ids.slice(0, 6)) {
        const record = store.get(id);
        if (record.kind !== "lesson") continue;
        let state = "No exact source baseline; verify before relying on this lesson.";
        if (/^[a-f0-9]{40}$/.test(record.source.revision) && record.paths.length) {
          try {
            await git(context.root, ["diff", "--quiet", record.source.revision, "--", ...record.paths]);
            state = "Scoped files match the recorded revision. This does not independently verify the lesson.";
          } catch (failure) {
            state = failure.code === 1 ? "Scoped files changed; recheck this lesson against current source."
              : "Recorded source revision is unavailable; verify this lesson.";
          }
        }
        applicability.push({ id, state });
      }
      if (applicability.length) {
        const note = `Current-source checks: ${JSON.stringify(applicability)}\n`;
        if (result.text.length + note.length <= options.maxContextChars) result.text += note;
      }
      store.setting("lastRetrieval", { at: new Date().toISOString(), milliseconds: Date.now() - started,
        characters: result.text.length, ids: result.ids, repository: context.repository });
      return { ...result, context };
    },
    async capture({ context, prompt, message, task, threadId, turnId, status, events = [], truncated = false }) {
      if (!context) return;
      const text = JSON.stringify({ request: prompt, response: message, events, truncated });
      await store.put({ kind: "evidence", repository: context.repository, paths: context.paths,
        at: new Date().toISOString(), title: `${task || "AI"} task: ${status || "unknown"}`,
        text: text.slice(0, 1_900_000), source: { type: "agent-turn", revision: context.revision,
          threadId, turnId, status, personal: true, truncated: truncated || text.length > 1_900_000 } });
    },
    async captureReview({ event, session }) {
      if (!session.graph?.path) return;
      const context = await repositoryContext(session.graph.path, options.repositories);
      for (const item of session.items || []) {
        const fields = {};
        for (const key of ["content", "codeSuggestion", "assessment", "rationale", "recommendation", "validation", "appliedSummary", "changeSummary", "state", "changeAccepted", "changeReverted", "changesAmended"]) {
          if (item[key] !== undefined) fields[key] = item[key];
        }
        const source = { type: "review-feedback", revision: session.currentHash || context.revision,
          patch: session.revision, comment: item.url || item.id || "", event,
          accepted: item.changeAccepted === true || item.changesAmended === true,
          reverted: item.changeReverted === true };
        const key = `review:${digest({ source, fields })}`;
        if (store.setting(key)) continue;
        const record = await store.put({ kind: "evidence", repository: context.repository,
          at: new Date().toISOString(), title: `${session.revision}: ${event}`,
          paths: item.filePath ? [item.filePath] : context.paths, source, text: JSON.stringify(fields),
          visibility: options.shareRepositories?.includes(context.repository) ? "shared" : "private" });
        store.setting(key, record.id);
      }
    },
    tick() {
      if (running || stopped) return activeJob || Promise.resolve();
      running = true;
      activeJob = (async () => {
        if (options.importLegacy) {
          try { await importLegacyKnowledge(store, options.memoryDirectory); } catch (failure) { error("import", failure); }
        }
        if (stopped) return;
        const syncDue = Date.now() - (store.setting("lastSyncAttempt") || 0) > 300_000;
        if (syncDue) {
          store.setting("lastSyncAttempt", Date.now());
          try { store.setting("lastHistory", { ...await saveLocalKnowledgeHistory(store), at: new Date().toISOString() }); }
          catch (failure) { error("history", failure); }
        }
        if (stopped) return;
        try { await indexEmbeddings(); } catch (failure) { error("embedding", failure); }
        if (stopped) return;
        try { store.setting("lastLearning", { ...await learnKnowledge(store, { generate: generateLessons,
          maxCallsPerDay: options.maxCallsPerDay }), at: new Date().toISOString() }); }
        catch (failure) { error("learning", failure); }
        if (stopped) return;
        if (options.push !== false) {
          try { await publishProjectLessons(store, options); }
          catch (failure) { error("publication", failure); }
        }
        if (syncDue) {
          try { store.setting("lastSync", { ...await (options.repositoryDirectory ? syncKnowledgeRepository(store, options) : syncKnowledge(store, options)), at: new Date().toISOString() }); }
          catch (failure) { error("sync", failure); }
        }
      })().finally(() => { running = false; });
      return activeJob;
    },
    start() {
      if (timer || stopped) return;
      // Capture/retrieval is immediate; maintenance runs separately from task completion.
      timer = setInterval(() => { void this.tick().catch(failure => error("maintenance", failure)); }, 30_000);
      timer.unref();
    },
    async initialize() {
      await withKnowledgeLock(options.directory, "initialize", async () => {
        await atomicWrite(path.join(options.directory, "AGENTS.md"), knowledgeInstructions(options.directory, options.repositoryDirectory));
        if (options.importLegacy) await importLegacyKnowledge(store, options.memoryDirectory);
        await readKnowledgeRepository(store, options.repositoryDirectory);
        classifyLearningQueue(store);
        if (options.push !== false) await publishProjectLessons(store, options);
        await writeComponentGuides(store);
      });
      this.start();
      return this;
    },
    async close() { stopped = true; clearInterval(timer); activeAbort?.abort(); await activeJob; await semantic?.close(); store.close(); },
  };
  return service;
}
