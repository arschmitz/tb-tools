import { Worker } from "node:worker_threads";
import path from "node:path";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export function createLocalEmbeddings(directory, { model = EMBEDDING_MODEL, onError = () => {}, onReady = () => {},
  createWorker = (url, options) => new Worker(url, options) } = {}) {
  // The worker loads a file, so it cannot use the parent's inline-script option.
  const execArgv = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    if (process.execArgv[i] === "--input-type") { i++; continue; }
    if (!process.execArgv[i].startsWith("--input-type=")) execArgv.push(process.execArgv[i]);
  }
  const worker = createWorker(new URL("./embedding-worker.mjs", import.meta.url), {
    execArgv,
    workerData: { cache: path.join(directory, "models"), model },
  });
  const pending = new Map();
  let nextId = 0, ready = false, stopped = false, failed = false;
  function fail(error) {
    if (failed || stopped) return;
    failed = true;
    ready = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    onError(error);
  }
  worker.on("message", message => {
    if (failed || stopped) return;
    if (message.ready) { ready = true; onReady(); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message.vectors);
  });
  worker.on("error", fail);
  worker.on("exit", code => { if (!stopped) fail(new Error(`Local embedding worker exited (${code}).`)); });
  worker.unref();
  return {
    model,
    get ready() { return ready; },
    embed(texts, timeout = 1500) {
      if (!ready) return Promise.resolve(null);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, texts: texts.map(text => text.slice(0, 2000)) });
      });
    },
    close() { stopped = true; ready = false; for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(null); } pending.clear(); return worker.terminate(); },
  };
}
