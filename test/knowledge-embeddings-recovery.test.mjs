import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalEmbeddings } from "../commands/knowledge/embeddings.mjs";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";

function worker() {
  const result = new EventEmitter();
  result.unref = () => {};
  result.postMessage = message => { result.lastMessage = message; };
  result.terminate = async () => { result.emit("exit", 1); };
  return result;
}

test("embedding processes receive the model cache without parent inline options", async () => {
  const previous = process.execArgv;
  process.execArgv = ["--input-type=module", "--input-type", "module", "--import", "./test/block-external-apis.mjs"];
  let options;
  const fake = worker();
  try {
    const runtime = createLocalEmbeddings("/tmp/knowledge", { createWorker: (url, value) => {
      assert.match(url.pathname, /embedding-worker\.mjs$/);
      options = value; return fake;
    } });
    assert.equal(options.execArgv, undefined);
    assert.equal(options.cache, "/tmp/knowledge/models");
    await runtime.close();
  } finally { process.execArgv = previous; }
});

test("worker failure retains the first cause and rejects pending embedding requests", async () => {
  const fake = worker(), errors = [];
  let readyCalls = 0;
  const runtime = createLocalEmbeddings("/tmp/knowledge", { createWorker: () => fake,
    onError: error => errors.push(error.message), onReady: () => { readyCalls++; } });
  fake.emit("message", { ready: true });
  assert.equal(runtime.ready, true);
  const request = runtime.embed(["A source-linked lesson"]);
  const rejected = assert.rejects(request, /Model initialization failed/);
  fake.emit("error", new Error("Model initialization failed"));
  fake.emit("exit", 1);
  fake.emit("message", { ready: true });
  await rejected;
  assert.deepEqual(errors, ["Model initialization failed"]);
  assert.equal(runtime.ready, false);
  assert.equal(readyCalls, 1);
  assert.equal(await runtime.embed(["Retry"]), null);
  await runtime.close();
  assert.equal(errors.length, 1);
});

test("a new semantic runtime can recover from a saved error without losing its diagnostic", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-semantic-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = await openKnowledgeStore(directory);
  previous.setting("semanticError", "Local embedding worker exited (1).");
  previous.close();
  const semantic = { ready: false, model: "test", embed: async () => [], close: async () => {} };
  const service = await createKnowledgeService({ directory, semantic: true, importLegacy: false }, { embeddings: semantic });
  try {
    assert.equal(service.store.setting("semanticError"), null);
    assert.equal(service.store.setting("semanticLastError").message, "Local embedding worker exited (1).");
    semantic.ready = true;
    await service.indexSemantic();
    assert.equal(service.semanticReady, true);
    assert.equal(service.store.setting("semanticError"), null);
  } finally { await service.close(); }
});
