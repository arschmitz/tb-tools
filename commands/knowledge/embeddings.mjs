import { fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

function createEmbeddingProcess(url, data) {
  const args = [JSON.stringify(data)];
  const worker = process.versions.electron && process.type === "browser"
    ? createRequire(import.meta.url)("electron").utilityProcess.fork(fileURLToPath(url), args,
      { serviceName: "Local knowledge search", stdio: "pipe" })
    : fork(url, args, { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  // A native model failure must not terminate the console process.
  worker.stdout?.resume();
  worker.stderr?.resume();
  let exited = false;
  worker.once("exit", () => { exited = true; });
  return {
    on: (event, listener) => worker.on(event, listener),
    postMessage: message => worker.postMessage ? worker.postMessage(message) : worker.send(message),
    unref() { worker.unref?.(); worker.channel?.unref(); },
    terminate() {
      if (exited) return Promise.resolve();
      worker.ref?.();
      worker.channel?.ref();
      return new Promise(resolve => {
        worker.once("exit", resolve);
        if (!worker.kill()) worker.once("spawn", () => worker.kill());
      });
    },
  };
}

export function createLocalEmbeddings(directory, {
  model = EMBEDDING_MODEL, onError = () => {}, createWorker = createEmbeddingProcess,
} = {}) {
  const worker = createWorker(new URL("./embedding-worker.mjs", import.meta.url), {
    cache: path.join(directory, "models"), model,
  });
  const pending = new Map();
  let nextId = 0, ready = false, stopped = false, failed = false;
  function fail(error) {
    if (stopped || failed) return;
    failed = true;
    ready = false;
    error = error instanceof Error ? error : new Error(String(error));
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    onError(error);
  }
  worker.on("message", message => {
    if (stopped || failed) return;
    if (message.error && !message.id) { fail(new Error(message.error)); return; }
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
        try { worker.postMessage({ id, texts: texts.map(text => text.slice(0, 2000)) }); }
        catch (error) { fail(error); }
      });
    },
    close() { stopped = true; ready = false; for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(null); } pending.clear(); return worker.terminate(); },
  };
}
