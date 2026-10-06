import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AI_PROFILES, selectAiModel as selectModel } from "../commands/graph/ai-models.mjs";
import { getAiUsageBlock } from "../commands/graph/ai-usage.mjs";
import { saveAssessmentEvidence } from "../commands/graph/try-repair.mjs";
import { getConflictRanges } from "../commands/graph/rebase-resolution.mjs";
import { prepareAiRepositoryContext } from "../commands/graph/ai-repository-context.mjs";

test("console Git snapshot keeps exact diff whitespace outside the prompt", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-git-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diff = "diff --git a/a b/a\n+with trailing spaces  \n";
  const result = await prepareAiRepositoryContext({ cwd: directory, directory,
    runCommand: async ({ args }) => args[0] === "rev-parse" ? "abc\n"
      : args.includes("--format=") ? diff : "metadata\n" });
  assert.equal(result.head, "abc");
  assert.equal(result.diff, undefined);
  assert.equal(JSON.parse(await readFile(result.diffFile, "utf8")).diff, diff);
});

const selectAiModel = (models, task) => selectModel(models, task, DEFAULT_AI_PROFILES);

test("task policy uses the configured model and reasoning for every task", () => {
  const model = (id, efforts) => ({ id, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
  const models = [model("gpt-6-sol", ["low", "medium", "high"]), model("gpt-6-astra", ["medium", "high"])];
  assert.deepEqual(selectAiModel(models, "edit"), { model: "gpt-6-sol", effort: "medium" });
  assert.deepEqual(selectAiModel(models, "review"), { model: "gpt-6-sol", effort: "high" });
  assert.deepEqual(selectAiModel([models[0]], "repair"), { model: "gpt-6-sol", effort: "high" });
  assert.deepEqual(selectAiModel([{ ...models[1], hidden: true }, models[0]], "review"), { model: "gpt-6-sol", effort: "high" });
  assert.throws(() => selectAiModel([], "edit"), /No available/);
  for (const task of ["edit", "conflict", "review", "implement", "diagnosis", "repair"]) {
    assert.equal(selectAiModel(models, task).model, "gpt-6-sol");
    assert.throws(() => selectAiModel([models[1]], task), /Change it in Settings/);
    assert.throws(() => selectAiModel([{ ...models[0], hidden: true }, models[1]], task), /Change it in Settings/);
  }
});

test("usage block honors the reset and distinguishes network errors", () => {
  const error = new Error("You've hit your usage limit. Try again at Oct 5th, 2026 5:13 PM.");
  assert.equal(getAiUsageBlock(error, 0).retryAt, new Date(2026, 9, 5, 17, 13).getTime());
  assert.equal(getAiUsageBlock(new Error("network down")), null);
  assert.equal(getAiUsageBlock({ code: "usage_limit_exceeded", message: "limited" }).retryAt, null);
});

test("50-push evidence stays out of the first index and exact matches retain all job IDs", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-signatures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const job = (id, message) => ({ id, job: "test", logs: [{ name: "errorsummary_json", text: JSON.stringify({
    action: "test_result", test: "test.js", subtest: "focus", status: "FAIL", expected: "PASS", message,
  }) }] });
  const evidence = { failures: [job("a", "same"), job("b", "same"), job("c", "different")],
    baseline: Array.from({ length: 50 }, (_, i) => ({ repo: "try-comm-central", revision: `other-base-${i}`,
      jobs: Array.from({ length: 1000 }, (_, j) => ({ id: j, job_type_name: "irrelevant" })), failures: [job(`old-${i}`, "same")] })) };
  const file = await saveAssessmentEvidence(directory, { id: "run", attempts: [{}] }, evidence);
  const text = await readFile(file, "utf8"), index = JSON.parse(text);
  assert.ok(text.length < 3000, text.length);
  assert.equal(index.baseline, undefined);
  assert.equal(JSON.parse(await readFile(index.baselineIndex, "utf8")).length, 50);
  const groups = JSON.parse(await readFile(index.signaturesFile, "utf8"));
  assert.deepEqual(groups[0].jobs, ["a", "b"]);
  assert.equal(groups[0].matchCount, 50);
  assert.equal(groups[1].matchCount, 0);
  assert.equal(JSON.parse(await readFile(groups[0].matchesFile, "utf8")).length, 50);
});

test("conflict excerpts preserve original line numbers and leave full content separate", () => {
  const lines = [...Array(100).fill("before"), "<<<<<<< HEAD", "left", "=======", "right", ">>>>>>> branch", ...Array(100).fill("after")];
  const ranges = getConflictRanges(lines.join("\n"));
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startLine, 96);
  assert.equal(ranges[0].endLine, 110);
  assert.equal(ranges[0].text, lines.slice(95, 110).join("\n"));
  assert.deepEqual(getConflictRanges("unmarked add/delete conflict"), []);
});
