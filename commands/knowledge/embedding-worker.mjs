import { pipeline, env } from "@huggingface/transformers";

const options = JSON.parse(process.argv[2]);
const send = message => process.parentPort ? process.parentPort.postMessage(message) : process.send(message);
const listen = listener => process.parentPort
  ? process.parentPort.on("message", event => listener(event.data))
  : process.on("message", listener);
if (!process.parentPort) process.on("disconnect", () => process.exit());
env.cacheDir = options.cache;
env.allowLocalModels = false;
try {
  const extractor = await pipeline("feature-extraction", options.model, { dtype: "q8", device: "cpu" });
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
