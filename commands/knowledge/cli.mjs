import { readKnowledgeRepository, syncKnowledgeRepository } from "./repository.mjs";
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

export async function runKnowledgeCommand(argv = [], { config = {}, generate } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    directory: { type: "string" }, repository: { type: "string" }, file: { type: "string" },
    config: { type: "string" },
  } });
  const [action = "status", ...terms] = positionals;
  if (!["status", "search", "show", "record", "import", "maintain", "sync", "index", "watch"].includes(action)) throw new Error("Use status, search, show, record, import, maintain, sync, index, or watch.");
  if (values.config) {
    const settings = JSON.parse(await readFile(values.config, "utf8"));
    config = { ai: { enabled: true, knowledge: { importLegacy: false, ...settings }, command: settings.command } };
  }
  const options = knowledgeOptions(config);
  if (values.directory) options.directory = knowledgeDirectory({ ai: { knowledge: { directory: values.directory } } });
  options.semantic = action === "index" || (action === "watch" && options.semantic);
  const service = await createKnowledgeService(options, { generate });
  try {
    const { store } = service;
    await atomicWrite(path.join(store.directory, "AGENTS.md"), knowledgeInstructions(store.directory, options.repositoryDirectory));
    await readKnowledgeRepository(store, options.repositoryDirectory);
    let result;
    if (action === "status") result = {
      directory: store.directory, repositoryDirectory: options.repositoryDirectory, enabled: options.enabled, remoteConfigured: Boolean(options.remote),
      push: options.push, shareRepositories: options.shareRepositories,
      records: store.db.prepare("SELECT kind,visibility,count(*) AS count FROM records GROUP BY kind,visibility").all(),
      jobs: store.db.prepare("SELECT state,count(*) AS count FROM jobs GROUP BY state").all(),
      vectors: store.db.prepare("SELECT model,count(*) AS count FROM vectors GROUP BY model").all(),
      lastRetrieval: store.setting("lastRetrieval"), lastLearning: store.setting("lastLearning"),
      lastSync: store.setting("lastSync"), lastHistory: store.setting("lastHistory"), lastError: store.setting("lastError"), semanticError: store.setting("semanticError"),
    };
    if (action === "search") {
      const repository = values.repository || (await repositoryContext(process.cwd(), options.repositories)).repository;
      result = searchKnowledge(store, { query: terms.join(" "), repository, maxChars: options.maxContextChars });
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
      const target = store.all().length;
      for (let i = 0; i < Math.ceil(target / 32); i++) await service.indexSemantic();
      result = { vectors: store.db.prepare("SELECT model,count(*) AS count FROM vectors GROUP BY model").all() };
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
