import { Worker } from "node:worker_threads";
import path from "node:path";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export function createLocalEmbeddings(directory, { model = EMBEDDING_MODEL, onError = () => {} } = {}) {
  const worker = new Worker(new URL("./embedding-worker.mjs", import.meta.url), {
    workerData: { cache: path.join(directory, "models"), model },
  });
  const pending = new Map();
  let nextId = 0, ready = false, stopped = false;
  function fail(error) {
    ready = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    onError(error);
  }
  worker.on("message", message => {
    if (message.ready) { ready = true; return; }
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
