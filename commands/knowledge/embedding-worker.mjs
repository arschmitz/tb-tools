import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env } from "@huggingface/transformers";

env.cacheDir = workerData.cache;
env.allowLocalModels = false;
const extractor = await pipeline("feature-extraction", workerData.model, { dtype: "q8", device: "cpu" });
parentPort.postMessage({ ready: true });
let queue = Promise.resolve();
parentPort.on("message", ({ id, texts }) => {
  queue = queue.then(async () => {
    try {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      parentPort.postMessage({ id, vectors: output.tolist() });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
});
