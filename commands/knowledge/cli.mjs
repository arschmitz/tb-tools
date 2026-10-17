import { readKnowledgeRepository, syncKnowledgeRepository, knowledgeRepositoryRemote } from "./repository.mjs";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKnowledgeService, knowledgeOptions, repositoryContext } from "./service.mjs";
import { importLegacyKnowledge } from "./import.mjs";
import { searchKnowledge } from "./store.mjs";
import { syncKnowledge, saveLocalKnowledgeHistory } from "./sync.mjs";
import { atomicWrite } from "./store.mjs";
import { knowledgeDirectory, knowledgeInstructions } from "./instructions.mjs";
import { acceptLessons } from "./learning.mjs";
import { publishProjectLessons, repairPortableRecords } from "./publication.mjs";
import { indexKnowledgeSections } from "./semantic-index.mjs";
import { claimGroups, classifyLearningQueue } from "./claims.mjs";
import { completeFollowUpHistory, historyCompletion } from "./follow-up.mjs";

import { captureQueryObservation, queryGapReport, reviewQueryGap, queryGapWork } from "./query-gaps.mjs";

export async function runKnowledgeCommand(argv = [], { config = {}, generate } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    directory: { type: "string" }, repository: { type: "string" }, file: { type: "string" },
    config: { type: "string" }, "repository-directory": { type: "string" },
    all: { type: "boolean" }, component: { type: "string" }, language: { type: "string" }, role: { type: "string" },
    batches: { type: "string" }, trace: { type: "boolean", default: false }, generated: { type: "string" }, imported: { type: "string" },
    apply: { type: "boolean", default: false }, "after-rowid": { type: "string" }, "through-rowid": { type: "string" },
  } });
  const [action = "status", ...terms] = positionals;
  if (!["status", "search", "show", "record", "lesson", "publish", "repair", "catalog", "rebuild", "clean", "import", "maintain", "sync", "index", "watch", "follow-up", "history-complete", "gaps", "gap-review", "gap-work"].includes(action)) throw new Error("Use status, search, show, record, lesson, publish, repair, catalog, rebuild, clean, import, maintain, sync, index, watch, follow-up, history-complete, gaps, gap-review, or gap-work.");
  if (values.config) {
    const settings = JSON.parse(await readFile(values.config, "utf8"));
    config = { ai: { enabled: true, knowledge: { importLegacy: false, ...settings }, command: settings.command } };
  }
  const options = knowledgeOptions(config);
  if (values.directory) options.directory = knowledgeDirectory({ ai: { knowledge: { directory: values.directory } } });
  if (values["repository-directory"]) options.repositoryDirectory = path.resolve(values["repository-directory"]);
  options.semantic = action === "index" || (action === "watch" && options.semantic);
  const service = await createKnowledgeService(options, { generate });
  try {
    const { store } = service;
    await atomicWrite(path.join(store.directory, "AGENTS.md"), knowledgeInstructions(store.directory, options.repositoryDirectory));
    await readKnowledgeRepository(store, options.repositoryDirectory);
    let result;
    if (action === "status") result = {
      directory: store.directory, repositoryDirectory: options.repositoryDirectory, enabled: options.enabled,
      remoteConfigured: Boolean(options.remote || await knowledgeRepositoryRemote(options.repositoryDirectory)),
      push: options.push, shareRepositories: options.shareRepositories,
      records: store.db.prepare("SELECT kind,visibility,count(*) AS count FROM records GROUP BY kind,visibility").all(),
      jobs: store.db.prepare("SELECT state,count(*) AS count FROM jobs GROUP BY state").all(),
      vectors: store.db.prepare("SELECT model,count(*) AS count FROM vectors GROUP BY model").all(),
      sectionVectors: store.db.prepare("SELECT model,count(*) AS count FROM section_vectors GROUP BY model").all(),
      retrievalArchives: store.retrievalArchiveStatus(),
      lastRetrieval: store.setting("lastRetrieval"), lastLearning: store.setting("lastLearning"),
      queryGaps: service.queryGapStatus(),
      lastSync: store.setting("lastSync"), lastHistory: store.setting("lastHistory"), lastPublication: store.setting("lastPublication"),
      lastError: store.setting("lastError"), semanticError: store.setting("semanticError"),
      semanticLastError: store.setting("semanticLastError"),
      followUp: { options: options.followUp, historyComplete: historyCompletion(store),
        lastCapture: store.setting("lastTaskCapture"), lastCheck: store.setting("lastFollowUp"), lastRun: store.setting("lastFollowUpRun") },
    };
    if (action === "gaps") result = queryGapReport(store, { repository: values.repository, includeAll: values.all });
    if (action === "gap-review") {
      if (!values.file) throw new Error("gap-review needs --file with a checked review JSON file.");
      result = reviewQueryGap(store, JSON.parse(await readFile(values.file, "utf8")));
    }
    if (action === "gap-work") result = queryGapWork(store, terms[0]);
    if (action === "history-complete") result = completeFollowUpHistory(store, terms[0]);
    if (action === "follow-up") result = await service.followUp({ force: true });
    if (action === "search") {
      const repository = values.repository || (await repositoryContext(process.cwd(), options.repositories)).repository;
      const filters = Object.fromEntries(["component", "language", "role", "generated", "imported"]
        .filter(key => values[key] !== undefined).map(key => {
          if (["generated", "imported"].includes(key)) {
            if (!["true", "false"].includes(values[key])) throw new Error(`--${key} needs true or false.`);
            return [key, values[key] === "true"];
          }
          return [key, values[key]];
        }));
      result = searchKnowledge(store, { query: terms.join(" "), repository, filters, maxChars: options.maxContextChars, trace: values.trace });
      result.queryObservationId = captureQueryObservation(store, { question: terms.join(" "), query: terms.join(" "), text: result.text, repository,
        filters, ids: result.ids, retrieval: result.retrieval, maxContextChars: options.maxContextChars, mode: "exact" });
    }
    if (action === "show") {
      result = store.get(terms[0]);
      if (!result) throw new Error("Knowledge record not found.");
    }
    if (action === "record") {
      if (!values.file) throw new Error("record needs --file with an evidence JSON file.");
      const input = JSON.parse(await readFile(values.file, "utf8"));
      if (input.kind && input.kind !== "evidence") throw new Error("Record evidence; lessons must pass cited extraction.");
      if (!input.source || !(input.source.reference || input.source.revision || input.source.file || input.source.url)) {
        throw new Error("Evidence needs a source reference, revision, file, or URL.");
      }
      result = await store.put({ ...input, kind: "evidence", at: input.at || new Date().toISOString(),
        visibility: input.visibility || "private" });
      await saveLocalKnowledgeHistory(store);
    }
    if (action === "import") result = { imported: await importLegacyKnowledge(store, options.memoryDirectory) };
    if (action === "lesson") {
      if (!values.file) throw new Error("lesson needs --file with a cited lessons JSON batch.");
      const input = JSON.parse(await readFile(values.file, "utf8"));
      const evidence = [...new Set((input.lessons || []).flatMap(lesson => lesson.evidence || []))].map(id => store.get(id));
      if (evidence.some(record => !record)) throw new Error("Missing lesson evidence.");
      result = { accepted: await acceptLessons(store, evidence, input), publication: await publishProjectLessons(store, options) };
    }
    if (action === "repair") result = { ...await repairPortableRecords(store), skipped: classifyLearningQueue(store) };
    if (action === "publish") {
      result = { publication: await publishProjectLessons(store, options), sync: await syncKnowledgeRepository(store, options) };
      store.setting("lastSync", { ...result.sync, at: new Date().toISOString() });
    }
    if (action === "rebuild") result = { records: await store.rebuild() };
    if (action === "clean") {
      const cutoff = values["through-rowid"] === undefined ? store.maxRecordRowid() : Number(values["through-rowid"]);
      let cursor = values["after-rowid"] === undefined ? 0 : Number(values["after-rowid"]);
      const maxBatches = values.batches === undefined ? Infinity : Number(values.batches);
      if (!(maxBatches === Infinity || Number.isSafeInteger(maxBatches) && maxBatches > 0)) throw new Error("Use a positive batch count.");
      result = { apply: values.apply, throughRowid: cutoff, nextRowid: cursor, batches: 0, done: false,
        examined: 0, candidates: 0, archived: 0, removedSections: 0, removedSectionVectors: 0, removedLegacyVectors: 0, skippedJobs: 0, reasons: {} };
      while (!result.done && result.batches < maxBatches) {
        const page = store.cleanRetrieval({ apply: values.apply, afterRowid: cursor, throughRowid: cutoff });
        for (const key of ["examined", "candidates", "archived", "removedSections", "removedSectionVectors", "removedLegacyVectors", "skippedJobs"]) {
          result[key] += page[key];
        }
        for (const [reason, count] of Object.entries(page.reasons)) {
          result.reasons[reason] = (result.reasons[reason] || 0) + count;
        }

        result.done = page.done;
        cursor = page.nextRowid;
        result.nextRowid = cursor;
        result.batches++;
        if (values.apply) store.setting("retrievalCleanup", { ...result, at: new Date().toISOString() });
        if (result.batches % 10 === 0) console.error(`${result.examined} records checked; ${result.removedSections} search sections removed.`);
        await delay(0);
      }
      result.status = store.retrievalArchiveStatus();
    }
    if (action === "catalog") {
      const records = store.all(values.repository), groups = claimGroups(records), seen = new Set();
      result = records.filter(record => record.kind === "lesson").map(record => groups.representatives.get(record.id))
        .filter(record => { if (seen.has(record.id)) return false; seen.add(record.id); return true; })
        .map(({ id, repository, component, title, status, paths, source }) => ({ id, repository, component, title, status, paths,
          file: store.get(id).visibility === "shared" ? `records/${id}.json` : store.file(store.get(id)),
          sourceAt: source.sourceAt || store.get(id).at }))
        .sort((a, b) => (a.repository + a.component + a.title).localeCompare(b.repository + b.component + b.title));
    }
    if (action === "maintain") { await service.tick(); result = store.setting("lastLearning"); }
    if (action === "sync") {
      result = { history: await saveLocalKnowledgeHistory(store), remote: await (options.repositoryDirectory ? syncKnowledgeRepository(store, options) : syncKnowledge(store, options)) };
      store.setting("lastHistory", { ...result.history, at: new Date().toISOString() });
      store.setting("lastSync", { ...result.remote, at: new Date().toISOString() });
    }
    if (action === "index") {
      const started = Date.now();
      while (!service.semanticReady && Date.now() - started < 60_000) {
        if (store.setting("semanticError")) throw new Error(store.setting("semanticError"));
        await delay(250);
      }
      if (!service.semanticReady) throw new Error("Local embedding model is not ready. Exact search remains available.");
      result = await indexKnowledgeSections(service, { maxBatches: values.batches === undefined ? null : Number(values.batches),
        onProgress: progress => { if (progress.batches % 20 === 0 || !progress.remainingEstimate) console.error(`${progress.embeddedSections} sections embedded; about ${progress.remainingEstimate} remain.`); } });
      result.vectors = result.legacyVectors;
    }
    if (action === "watch") {
      await service.initialize();
      await new Promise(resolve => {
        const stop = () => { clearInterval(keepAlive); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
        const keepAlive = setInterval(() => {}, 60_000);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      result = { stopped: true };
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { await service.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Standalone use does not read tb-tools settings or import global memories by default.
  runKnowledgeCommand(process.argv.slice(2), { config: { ai: { enabled: true, knowledge: { importLegacy: false } } } })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
