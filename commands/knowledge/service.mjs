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
import { VECTOR_SEARCH_VERSION } from "./vector-search.mjs";
import { learnKnowledge, writeComponentGuides } from "./learning.mjs";
import { syncKnowledge, saveLocalKnowledgeHistory, withKnowledgeLock } from "./sync.mjs";
import { publishProjectLessons } from "./publication.mjs";
import { classifyLearningQueue } from "./claims.mjs";
import { captureSavedTaskOutcomes } from "./task-outcomes.mjs";
import { followUpOptions, runKnowledgeFollowUp } from "./follow-up.mjs";
import { createFollowUpSources } from "./follow-up-sources.mjs";

import { captureQueryObservation, captureQueryOutcome } from "./query-gaps.mjs";
import { normalizeKnowledgeRequest, taskQueryParts } from "./task-query.mjs";

import { queryGapScheduleOptions, runQueryGapSchedule, queryGapScheduleStatus } from "./query-gap-scheduler.mjs";

import { runQueryGapEvaluations, gapEvaluationStatus, reviewGapAnswer } from "./query-gap-evaluation.mjs";
import { createKnowledgeAnswerProvider } from "./answer-provider.mjs";

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
    followUp: followUpOptions(options.followUp),
    queryGaps: queryGapScheduleOptions(options.queryGaps),
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

export async function createKnowledgeService(options, { generate, embeddings, followUpDependencies = createFollowUpSources(), warn = message => console.warn(message) } = {}) {
  options = { maxContextChars: 10_000, maxCallsPerDay: 4, shareRepositories: [], repositories: {}, ...options };
  options.maxContextChars = Math.max(1000, Math.min(24_000, Number(options.maxContextChars) || 10_000));
  const store = await openKnowledgeStore(options.directory);
  await store.rebuild();
  if (options.semantic || embeddings) {
    const previousError = store.setting("semanticError");
    if (previousError) store.setting("semanticLastError", { message: previousError, observedAt: new Date().toISOString() });
    store.setting("semanticError", null);
  }
  const semantic = embeddings ?? (options.semantic ? createLocalEmbeddings(options.directory, {
    onError: error => {
      store.setting("semanticError", error.message);
      store.setting("semanticLastError", { message: error.message, at: new Date().toISOString() });
    },
    onReady: () => { store.setting("semanticError", null); },
  }) : null);
  let timer, vectorTimer, vectorJob, lastVectorError, running = false, stopped = false, activeAbort, activeJob, followUpAbort, queryGapAbort, queryGapEvaluationAbort;
  const error = (stage, failure) => {
    store.setting("lastError", { stage, message: failure.message, at: new Date().toISOString() });
    warn(`Knowledge ${stage}: ${failure.message}`);
  };
  function scheduleVectorMaintenance(delay = 0) {
    if (stopped || vectorTimer || !(options.semantic || embeddings)) return;
    vectorTimer = setTimeout(() => {
      vectorTimer = null;
      void maintainVectorIndex().catch(failure => error("vector-index", failure));
    }, delay);
    vectorTimer.unref();
  }
  function maintainVectorIndex() {
    if (stopped || !(options.semantic || embeddings)) return Promise.resolve();
    if (vectorJob) return vectorJob;
    vectorJob = (async () => {
      let status;
      try { status = await store.vectorIndex.maintain({ limit: 16 }); }
      catch (failure) { status = { ready: false, pending: false, error: failure.message }; }
      if (stopped) return status;
      const previous = store.setting("vectorIndexStatus");
      if (JSON.stringify({ ...previous, ms: undefined }) !== JSON.stringify({ ...status, ms: undefined })) {
        store.setting("vectorIndexStatus", status);
      }
      const failure = status.error || (status.reason === "native-unavailable"
        ? "The native vector index is unavailable. Exact semantic search remains available." : null);
      if (failure && failure !== lastVectorError) error("vector-index", new Error(failure));
      lastVectorError = failure;
      if (status.pending && !status.error) scheduleVectorMaintenance(25);
      else { clearTimeout(vectorTimer); vectorTimer = null; }
      return status;
    })().finally(() => { vectorJob = null; });
    return vectorJob;
  }
  async function generateLessons(prompt) {
    activeAbort = new AbortController();
    try {
      return await (generate || generateKnowledge)(prompt, {
        command: options.command, directory: options.directory, signal: activeAbort.signal,
      });
    } finally { activeAbort = null; }
  }
  async function indexEmbeddings() {
    if (!semantic?.ready) return 0;
    store.setting("semanticError", null);
    const missing = store.db.prepare("SELECT s.id,s.body FROM sections s LEFT JOIN section_vectors v ON s.id=v.id AND v.model=? WHERE v.id IS NULL LIMIT 32").all(semantic.model);
    if (!missing.length) return 0;
    const vectors = await semantic.embed(missing.map(row => {
      const record = JSON.parse(row.body);
      return record.input;
    }), 30_000);
    if (!vectors) return 0;
    if (!Array.isArray(vectors) || vectors.length !== missing.length ||
        vectors.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) {
      throw new Error("Invalid local embedding.");
    }
    for (let i = 0; i < missing.length; i++) {
      if (!Array.isArray(vectors[i]) || vectors[i].some(n => !Number.isFinite(n))) throw new Error("Invalid local embedding.");
      // Cleanup can remove a section while its embedding is being computed.
      store.db.prepare(`INSERT OR REPLACE INTO section_vectors (id,model,vector)
        SELECT id,?,? FROM sections WHERE id=?`).run(semantic.model, JSON.stringify(vectors[i]), missing[i].id);
    }
    store.setting("semanticError", null);
    return missing.length;
  }
  const service = {
    store,
    queryGapStatus() {
      return { ...queryGapScheduleStatus(store, { ...options.queryGaps, totalMaxCallsPerDay: options.maxCallsPerDay }),
        evaluations: gapEvaluationStatus(store) };
    },
    reviewGapAnswer(key, review) { return reviewGapAnswer(store, key, review); },
    async evaluateQueryGaps() {
      queryGapEvaluationAbort = new AbortController();
      try {
        return await runQueryGapEvaluations(store, options.queryGaps, {
          provider: createKnowledgeAnswerProvider({ generate: generate || generateKnowledge, command: options.command, directory: options.directory }),
          embed: semantic?.ready ? (texts, timeout) => semantic.embed(texts, timeout) : null, model: semantic?.model,
          maxCallsPerDay: options.maxCallsPerDay, signal: queryGapEvaluationAbort.signal,
          codeFingerprint: digest({ search: searchKnowledge.toString(), feedback: runQueryGapEvaluations.toString(), vectorSearch: VECTOR_SEARCH_VERSION }),
        });
      } finally { queryGapEvaluationAbort = null; }
    },
    async checkQueryGaps() {
      queryGapAbort = new AbortController();
      try {
        return await runQueryGapSchedule(store, options.queryGaps, {
          generate: (prompt, runOptions) => (generate || generateKnowledge)(prompt, {
            ...runOptions, command: options.command }),
          repositories: options.repositories, maxCallsPerDay: options.maxCallsPerDay,
          shareRepositories: options.shareRepositories,
          signal: queryGapAbort.signal,
        });
      } finally { queryGapAbort = null; }
    },
    async followUp({ force = false } = {}) {
      if (options.followUp?.enabled === false) return { disabled: true };
      followUpAbort = new AbortController();
      try {
        store.setting("lastTaskCapture", await captureSavedTaskOutcomes(store, options.followUp));
        return await runKnowledgeFollowUp(store, options.followUp, { ...followUpDependencies, force, signal: followUpAbort.signal });
      } finally { followUpAbort = null; }
    },
    async indexSemantic() {
      const count = await indexEmbeddings();
      await maintainVectorIndex();
      return count;
    },
    get semanticReady() { return semantic?.ready === true; },
    get semanticModel() { return semantic?.model || null; },
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
    async beforeTurn({ cwd, prompt, task, filters, knowledgeRequest }) {
      const started = Date.now();
      const context = await repositoryContext(cwd, options.repositories);
      const request = normalizeKnowledgeRequest(knowledgeRequest, { question: prompt, taskType: task, revision: context.revision });
      request.filters = { ...request.filters, ...filters };
      const queryParts = taskQueryParts(request);
      const query = queryParts.map(part => part.query).join("\n");
      context.paths = request.paths;
      context.knowledgeRequest = request;
      const vectors = await semantic?.embed([query], 300).catch(failure => {
        store.setting("semanticError", failure.message); return null;
      });
      const result = searchKnowledge(store, { query, queryParts, question: request.question, filters: request.filters, repository: context.repository,
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
      const queryObservationId = captureQueryObservation(store, { question: request.question, knowledgeRequest: request, query, queryParts, text: result.text, ...context, filters: request.filters,
        ids: result.ids, applicability, retrieval: result.retrieval,
        maxContextChars: options.maxContextChars - Math.min(1600, options.maxContextChars / 4), mode: vectors?.[0] ? "hybrid" : "exact",
        model: vectors?.[0] ? semantic?.model : null });
      return { ...result, context: { ...context, queryObservationId } };
    },
    async capture({ context, prompt, message, task, threadId, turnId, status, retrievalIds = [], events = [], truncated = false }) {
      if (!context) return;
      const text = JSON.stringify({ request: prompt, response: message, retrievalIds, events, truncated });
      const record = await store.put({ kind: "evidence", repository: context.repository, paths: context.paths,
        at: new Date().toISOString(), title: `${task || "AI"} task: ${status || "unknown"}`,
        text: text.slice(0, 1_900_000), source: { type: "agent-turn", revision: context.revision,
          threadId, turnId, status, personal: true, truncated: truncated || text.length > 1_900_000 } });
      if (context.queryObservationId) captureQueryOutcome(store, context.queryObservationId,
        { status, threadId, turnId, evidenceId: record.id });
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
        try { store.setting("lastFollowUp", { ...await this.followUp(), at: new Date().toISOString() }); }
        catch (failure) { error("follow-up", failure); }
        if (stopped) return;
        const syncDue = Date.now() - (store.setting("lastSyncAttempt") || 0) > 300_000;
        if (syncDue) {
          store.setting("lastSyncAttempt", Date.now());
          try { store.setting("lastHistory", { ...await saveLocalKnowledgeHistory(store), at: new Date().toISOString() }); }
          catch (failure) { error("history", failure); }
        }
        if (stopped) return;
        try { await this.indexSemantic(); } catch (failure) { error("embedding", failure); }
        if (stopped) return;
        try { await this.checkQueryGaps(); } catch (failure) { error("query-gap-check", failure); }
        if (stopped) return;
        try { await this.evaluateQueryGaps(); } catch (failure) { error("query-gap-evaluation", failure); }
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
      scheduleVectorMaintenance();
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
    async close() {
      stopped = true;
      clearInterval(timer); clearTimeout(vectorTimer);
      activeAbort?.abort(); followUpAbort?.abort(); queryGapAbort?.abort(); queryGapEvaluationAbort?.abort();
      await activeJob; await vectorJob; await semantic?.close();
      store.close();
    },
  };
  return service;
}
