import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Electron's allocator can trap on the native model's aligned allocations.
// Use the bundled WebAssembly runtime inside Electron's helper process.
const useWasm = Boolean(process.versions.electron);
if (useWasm) {
  const runtime = await import("onnxruntime-web/webgpu");
  const require = createRequire(import.meta.url);
  const directory = path.dirname(require.resolve("onnxruntime-web/webgpu"));
  runtime.env.wasm.numThreads = 1;
  runtime.env.wasm.wasmPaths = {
    mjs: pathToFileURL(path.join(directory, "ort-wasm-simd-threaded.jsep.mjs")).href,
    wasm: pathToFileURL(path.join(directory, "ort-wasm-simd-threaded.jsep.wasm")).href,
  };
  globalThis[Symbol.for("onnxruntime")] = {
    ...runtime,
    InferenceSession: {
      create: async (model, settings) => runtime.InferenceSession.create(
        typeof model === "string" ? new Uint8Array(await readFile(model)) : model, settings),
    },
  };
}
const { pipeline, env } = await import("@huggingface/transformers");
if (useWasm) env.useWasmCache = false;

const options = JSON.parse(process.argv[2]);
const send = message => process.parentPort ? process.parentPort.postMessage(message) : process.send(message);
const listen = listener => process.parentPort
  ? process.parentPort.on("message", event => listener(event.data))
  : process.on("message", listener);
if (!process.parentPort) process.on("disconnect", () => process.exit());
env.cacheDir = options.cache;
env.allowLocalModels = false;
try {
  const extractor = await pipeline("feature-extraction", options.model, { dtype: "q8", device: useWasm ? "auto" : "cpu" });
  let queue = Promise.resolve();
  listen(({ id, texts }) => {
    queue = queue.then(async () => {
      try {
        const output = await extractor(texts, { pooling: "mean", normalize: true });
        send({ id, vectors: output.tolist() });
      } catch (error) { send({ id, error: error.message }); }
    });
  });
  send({ ready: true });
} catch (error) { send({ error: error.message }); }
