import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const commPath = process.argv[2] || process.env.TB_COMM_PATH;
if (!commPath) throw new Error("Pass the Thunderbird comm checkout path.");
const executablePath = process.env.TB_DESKTOP_EXECUTABLE || path.resolve("dist",
  `Thunderbird-Commands-${process.platform}-${process.arch}`,
  process.platform === "darwin" ? "Thunderbird-Commands.app/Contents/MacOS/Thunderbird-Commands"
    : process.platform === "win32" ? "Thunderbird-Commands.exe" : "Thunderbird-Commands");
const testUserData = await fs.mkdtemp(path.join(os.tmpdir(), "tb-desktop-knowledge-"));
const directory = process.env.TB_KNOWLEDGE_SMOKE_CACHE || path.join(os.homedir(), ".tb-tools", "knowledge");
let electron;
try {
  electron = await _electron.launch({ executablePath, args: [`--comm=${commPath}`],
    env: { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: testUserData },
    timeout: 120_000 });
  const startModel = async () => electron.evaluate(({ app }, directory) => {
    const require = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
    const { createLocalEmbeddings } = require(app.getAppPath() + "/commands/knowledge/embeddings.mjs");
    globalThis.knowledgeSmokeErrors = [];
    globalThis.knowledgeSmokeModel = createLocalEmbeddings(directory, {
      onError: error => globalThis.knowledgeSmokeErrors.push(error.message),
    });
  }, directory);
  const waitForModel = async () => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await electron.evaluate(() => ({ ready: globalThis.knowledgeSmokeModel.ready,
        errors: globalThis.knowledgeSmokeErrors }));
      assert.deepEqual(state.errors, []);
      if (state.ready) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("The local knowledge model did not load.");
  };
  await startModel();
  await electron.evaluate(async () => { await globalThis.knowledgeSmokeModel.close(); });
  await startModel();
  await waitForModel();
  const vectors = await electron.evaluate(async () => {
    const texts = Array.from({ length: 32 }, (_, index) =>
      (`Calendar conflict resolution and source validation ${index}. `).repeat(90));
    const vectors = await globalThis.knowledgeSmokeModel.embed(texts, 30_000);
    return vectors?.map(vector => ({ dimensions: vector.length, finite: vector.every(Number.isFinite) }));
  });
  assert.equal(vectors?.length, 32);
  assert.ok(vectors.every(vector => vector.dimensions === 384 && vector.finite));
  await electron.evaluate(({ app }) => {
    const child = app.getAppMetrics().find(metric => metric.name === "Local knowledge search");
    if (!child || child.pid === process.pid) throw new Error("The model is not in a separate process.");
    globalThis.knowledgeSmokePending = globalThis.knowledgeSmokeModel
      .embed(["An interrupted model request"], 30_000).then(
        value => ({ value }), error => ({ error: error.message }));
    process.kill(child.pid, "SIGKILL");
  });
  const failure = await electron.evaluate(async () => ({
    pending: await globalThis.knowledgeSmokePending,
    fallback: await globalThis.knowledgeSmokeModel.embed(["Exact search remains available"]),
    ready: globalThis.knowledgeSmokeModel.ready,
    errors: globalThis.knowledgeSmokeErrors,
  }));
  assert.match(failure.pending.error, /exited/);
  assert.equal(failure.fallback, null);
  assert.equal(failure.ready, false);
  assert.equal(failure.errors.length, 1);
  const consoleAddress = await electron.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find(contents =>
      contents.getTitle() === "Thunderbird Desktop Console")?.getURL());
  assert.ok(consoleAddress?.startsWith("http://127.0.0.1:"));
  assert.equal((await fetch(consoleAddress)).ok, true);
  await electron.evaluate(async () => { await globalThis.knowledgeSmokeModel.close(); });
  await startModel();
  await waitForModel();
  const recovered = await electron.evaluate(async () => {
    const vectors = await globalThis.knowledgeSmokeModel.embed(["Recovered local model"], 10_000);
    await globalThis.knowledgeSmokeModel.close();
    return vectors?.[0]?.length;
  });
  assert.equal(recovered, 384);
  process.stdout.write("Packaged local model inference, helper failure, console survival, and model restart passed.\n");
} finally {
  if (electron) await electron.close();
  await fs.rm(testUserData, { recursive: true, force: true });
}
