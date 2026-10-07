import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { createLocalEmbeddings } from "../commands/knowledge/embeddings.mjs";

function setup(t) {
  const worker = new EventEmitter();
  const messages = [], errors = [];
  worker.unref = () => {};
  worker.postMessage = message => messages.push(message);
  worker.terminate = async () => worker.emit("exit", 0);
  const embeddings = createLocalEmbeddings("/cache", {
    createWorker: () => worker, onError: error => errors.push(error.message),
  });
  t.after(() => embeddings.close());
  return { worker, messages, errors, embeddings };
}

test("standalone shutdown waits for the model process to exit before Node exits", async () => {
  const module = new URL("../commands/knowledge/embeddings.mjs", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    const { createLocalEmbeddings } = await import(${JSON.stringify(module)});
    const embeddings = createLocalEmbeddings('/unused-cache');
    await embeddings.close();
    process.stdout.write('model process closed');
  `], { timeout: 10_000 });
  assert.equal(stdout, "model process closed");
});

test("a model process failure rejects pending requests and leaves exact search available", async t => {
  const { worker, embeddings, errors } = setup(t);
  assert.equal(await embeddings.embed(["before loading"]), null);
  worker.emit("message", { ready: true });
  const first = assert.rejects(embeddings.embed(["first"]), /exited/);
  const second = assert.rejects(embeddings.embed(["second"]), /exited/);
  worker.emit("exit", 5);
  await Promise.all([first, second]);
  assert.equal(embeddings.ready, false);
  assert.equal(await embeddings.embed(["after failure"]), null);
  worker.emit("error", new Error("duplicate failure"));
  worker.emit("message", { ready: true });
  assert.equal(embeddings.ready, false);
  assert.equal(errors.length, 1);
});

test("initialization and send failures disable the model without an uncaught error", async t => {
  const { worker, embeddings, errors } = setup(t);
  worker.emit("message", { error: "model unavailable" });
  assert.deepEqual(errors, ["model unavailable"]);
  assert.equal(await embeddings.embed(["query"]), null);
  const other = setup(t);
  other.worker.emit("message", { ready: true });
  other.worker.postMessage = () => { throw new Error("process closed"); };
  await assert.rejects(other.embeddings.embed(["query"]), /process closed/);
  assert.equal(other.embeddings.ready, false);
});

test("model requests keep input limits, timeouts and clean shutdown", async t => {
  const { worker, embeddings, messages, errors } = setup(t);
  worker.emit("message", { ready: true });
  const completed = embeddings.embed(["a".repeat(3000)]);
  assert.equal(messages[0].texts[0].length, 2000);
  worker.emit("message", { id: messages[0].id, vectors: [[1, 0]] });
  assert.deepEqual(await completed, [[1, 0]]);
  assert.equal(await embeddings.embed(["slow"], 1), null);
  const pending = embeddings.embed(["during shutdown"]);
  await embeddings.close();
  assert.equal(await pending, null);
  assert.equal(embeddings.ready, false);
  assert.deepEqual(errors, []);
});
