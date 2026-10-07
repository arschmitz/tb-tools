import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatAiContext } from "../commands/graph/ai-context.mjs";
import { createTryRepairer } from "../commands/graph/try-repair.mjs";
import { createTryMonitorStore } from "../commands/graph/try-monitor-store.mjs";

test("large AI context stays complete in a stable private file", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = { comments: ["original requirement", "old report\n".repeat(50000), "latest instruction"] };
  const prompt = await formatAiContext(value, { directory });
  assert.ok(prompt.length < 1000);
  assert.equal(await formatAiContext(value, { directory }), prompt);
  const file = path.join(directory, (await readdir(directory))[0]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), value);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("Try assessment prompts stay small without dropping any failure or raw evidence", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-try-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTryMonitorStore(directory);
  const failures = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `test-${i}`, platform: "linux", logs: [{ name: "errorsummary_json", text: "error context\n".repeat(10000), fullLogPath: `/logs/full-${i}.log` }], suggestions: [{ bug: 123 }] }));
  const evidence = { failures, baseline: [{ repo: "comm-central", revision: "baseline", jobs: [], failures }] };
  const state = { id: "test", path: directory, sourceHash: "abc", attempts: [{ id: "one" }] };
  let prompt;
  const repairer = createTryRepairer({ store, runCommand: async () => "", generate: async input => {
    prompt = input.prompt;
    return { failures: failures.map(({ id }) => ({ id, cause: "unrelated", reason: "matching baseline", evidence: ["exact signature"] })) };
  } });
  await repairer.assess(state, evidence);
  assert.ok(prompt.length < 5000, prompt.length);
  assert.ok(!prompt.includes("error context"));
  assert.match(prompt, /latest 50 Try pushes/);
  assert.match(prompt, /A match does not require the same base/);
  assert.match(prompt, /If all failures are existing, the Try result is Pass/);
  const indexPath = prompt.match(/Evidence index: (.+?)\. It lists/)[1];
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  assert.equal(index.failures.length, 30);
  const jobText = await readFile(index.failures[29].file, "utf8");
  assert.ok(jobText.length < 2000);
  const job = JSON.parse(jobText);
  assert.equal(job.logs[0].fullLogPath, "/logs/full-29.log");
  assert.equal(JSON.parse(await readFile(job.logs[0].excerptFile, "utf8")).text, failures[29].logs[0].text);
  assert.deepEqual(JSON.parse(await readFile(job.details, "utf8")).suggestions, [{ bug: 123 }]);
});
