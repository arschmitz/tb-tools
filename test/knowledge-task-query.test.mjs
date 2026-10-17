import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";
import { normalizeKnowledgeRequest, taskQueryParts } from "../commands/knowledge/task-query.mjs";
import { captureQueryObservation, captureQueryOutcome, queryGapReport, reviewQueryGap, queryGapWork } from "../commands/knowledge/query-gaps.mjs";
import { runQueryGapSchedule } from "../commands/knowledge/query-gap-scheduler.mjs";

const execute = promisify(execFile);
const revision = "a".repeat(40);
const sourceText = "function cancelPendingCalendarSave() { controller.abort(); }";
const sourcePath = "calendar/base/cancellation.js";
const unrelatedTerms = Array.from({ length: 96 }, (_, index) => `workflowtoken${index}`).join(" ");
const evidence = (text, extra = {}) => ({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T10:00:00Z",
  paths: [sourcePath], text, source: { type: "code-snapshot", revision, file: sourcePath, verified: true, fileRole: "production" }, ...extra });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-task-query-"));
  let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await openKnowledgeStore(directory);
  return store;
}

async function distractors(store) {
  for (let index = 0; index < 72; index++) {
    await store.put(evidence(`function unrelatedOperation${index}() { return "${unrelatedTerms}"; }`, {
      paths: [`unrelated/component${index}.js`],
      source: { type: "code-snapshot", revision, file: `unrelated/component${index}.js`, verified: true, fileRole: "production" },
    }));
  }
}

test("task request bounds keep the original question and explicit scope", () => {
  const question = `Explain cancellation before saving. ${"workflow ".repeat(1000)}`;
  const request = normalizeKnowledgeRequest({ question, taskType: "implementation", paths: [sourcePath, sourcePath],
    symbols: ["cancelPendingCalendarSave", "cancelPendingCalendarSave"], revision, filters: { role: "production" } },
  { question: "Unrelated fallback", taskType: "review", revision: "b".repeat(40) });
  assert.equal(request.question, question.slice(0, 6000), "A bounded question should keep the original request at the start.");
  assert.equal(request.questionTruncated, true, "A bounded question should record that text was omitted.");
  assert.equal(request.taskType, "implementation", "The explicit task type should take precedence over a fallback.");
  assert.deepEqual(request.paths, [sourcePath], "Duplicate explicit paths should be removed.");
  assert.deepEqual(request.symbols, ["cancelPendingCalendarSave"], "Duplicate symbols should be removed.");
  assert.deepEqual(request.filters, { role: "production" }, "Explicit scope should survive normalization.");
  assert.equal(request.revision, revision, "The selected revision should survive normalization.");
  const fallback = normalizeKnowledgeRequest({}, { question: "Original request", taskType: "review", revision });
  assert.deepEqual(fallback.paths, [], "A fallback request should not invent checkout-wide paths.");
  assert.deepEqual(fallback.filters, {}, "A task type should not infer strict source filters.");
  assert.throws(() => normalizeKnowledgeRequest({ paths: ["x".repeat(4097)] }), /paths entries exceed 4096/,
    "An oversized path should be rejected without changing its identifier.");
  assert.throws(() => normalizeKnowledgeRequest({ symbols: ["x".repeat(513)] }), /symbols entries exceed 512/,
    "An oversized symbol should be rejected without changing its identifier.");
  const bounded = normalizeKnowledgeRequest({ paths: ["x".repeat(4096)], symbols: ["x".repeat(512)] });
  assert.equal(bounded.paths[0].length, 4096, "A path at the supported size limit should remain intact.");
  assert.equal(bounded.symbols[0].length, 512, "A symbol at the supported size limit should remain intact.");
});

test("separate symbol and path searches survive a crowded question query", async t => {
  const store = await fixture(t);
  await distractors(store);
  const symbolTarget = await store.put(evidence(sourceText));
  const pathTarget = await store.put(evidence("function completeSave() { return true; }", {
    paths: ["calendar/transaction/finish-save.js"], source: { type: "code-snapshot", revision, file: "calendar/transaction/finish-save.js", verified: true },
  }));
  const foreign = await store.put(evidence(sourceText, { repository: "tb-tools" }));
  const request = normalizeKnowledgeRequest({ question: unrelatedTerms, symbols: ["cancelPendingCalendarSave"],
    paths: ["calendar/transaction/finish-save.js"], revision });
  const queryParts = taskQueryParts(request);
  const query = queryParts.map(part => part.query).join(" ");
  const flattened = searchKnowledge(store, { query, repository: "thunderbird", maxChars: 24_000 });
  assert.ok(!flattened.ids.includes(symbolTarget.id), "The crowded flat query should reproduce the lost symbol match.");
  assert.ok(!flattened.ids.includes(pathTarget.id), "The crowded flat query should reproduce the lost path match.");
  const result = searchKnowledge(store, { query, question: request.question, queryParts, repository: "thunderbird", maxChars: 24_000 });
  assert.ok(result.ids.includes(symbolTarget.id), "A separate symbol query should retrieve the implementation source.");
  assert.ok(result.ids.includes(pathTarget.id), "A separate path query should retrieve its source after the question term limit.");
  assert.ok(!result.ids.includes(foreign.id), "Every query part should preserve repository isolation.");
  assert.ok(result.text.includes(sourceText), "The selected context should contain the original source excerpt.");
});

test("every task query part obeys explicit file-role filters", async t => {
  const store = await fixture(t);
  const production = await store.put(evidence(sourceText));
  const testSource = await store.put(evidence(sourceText, {
    paths: ["calendar/test/cancellation.js"], source: { type: "code-snapshot", revision, fileRole: "test" },
  }));
  const request = normalizeKnowledgeRequest({ question: "Explain the operation", symbols: ["cancelPendingCalendarSave"],
    paths: ["calendar/test/cancellation.js"], filters: { role: "production" } });
  const parts = taskQueryParts(request);
  const result = searchKnowledge(store, { query: parts.map(part => part.query).join(" "), queryParts: parts,
    question: request.question, filters: request.filters, repository: "thunderbird" });
  assert.ok(result.ids.includes(production.id), "A matching production source should remain available through a symbol query.");
  assert.ok(!result.ids.includes(testSource.id), "An explicit test path should not bypass the production filter.");
});

test("console retrieval uses the original task despite a long workflow and unrelated checkout files", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-task-service-"));
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  const checkout = path.join(directory, "checkout");
  await mkdir(path.join(checkout, "unrelated"), { recursive: true });
  await execute("git", ["init", "--initial-branch=main", checkout]);
  for (let index = 0; index < 24; index++) {
    await writeFile(path.join(checkout, `unrelated/component${index}.js`), `const workflowtoken${index} = true;\n`);
  }
  await execute("git", ["add", "unrelated"], { cwd: checkout });
  await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "Fixture"], { cwd: checkout });
  const root = await realpath(checkout), semanticInputs = [];
  service = await createKnowledgeService({ directory: path.join(directory, "knowledge"), semantic: false,
    importLegacy: false, push: false, repositories: { [root]: "thunderbird" } }, {
    embeddings: { model: "test", embed: async inputs => { semanticInputs.push(...inputs); return null; }, close() {} },
  });
  await distractors(service.store);
  const target = await service.store.put(evidence(sourceText));
  const question = "Explain cancelPendingCalendarSave and its cancellation contract.";
  const request = normalizeKnowledgeRequest({ question, taskType: "implementation", paths: [sourcePath],
    symbols: ["cancelPendingCalendarSave"], revision, filters: { role: "production" } });
  const result = await service.beforeTurn({ cwd: root, prompt: `${question}\n${unrelatedTerms.repeat(8)}`,
    task: "Implementation workflow", knowledgeRequest: request });
  assert.ok(result.ids.includes(target.id), "The original question should retrieve its source through a long workflow prompt.");
  const group = queryGapReport(service.store, { includeAll: true }).groups[0];
  assert.equal(group.question, question, "The private observation should retain the original focused question.");
  assert.deepEqual(group.paths, [sourcePath], "Explicit task paths should replace unrelated checkout-wide path hints.");
  assert.deepEqual(group.knowledgeRequest, request, "The observation should retain the task request for replay.");
  assert.deepEqual(group.queryParts, taskQueryParts(request), "The observation should retain each separate search input.");
  assert.doesNotMatch(group.query, /workflowtoken|unrelated\/component/, "The query should exclude unrelated workflow and checkout terms.");
  assert.deepEqual(group.filters, { role: "production" }, "The service should apply the request's explicit scope.");
  assert.deepEqual(semanticInputs, [group.query], "Semantic search should use the same focused task query saved for replay.");
});

test("private observations preserve structured replay inputs and separate different task paths", async t => {
  const store = await fixture(t);
  const request = normalizeKnowledgeRequest({ question: "Explain the final operation", taskType: "review", paths: [sourcePath],
    symbols: ["cancelPendingCalendarSave"], revision, filters: { role: "production" } });
  const queryParts = taskQueryParts(request), query = queryParts.map(part => part.query).join(" ");
  const observationId = captureQueryObservation(store, { repository: "thunderbird", revision, question: request.question,
    query, paths: request.paths, filters: request.filters, knowledgeRequest: request, queryParts });
  const review = reviewQueryGap(store, { observationId, state: "confirmed", reason: "ranking", evidenceIds: [],
    explanation: "The implementation was absent from the selected context.", checkedBy: "Fixture source check",
    verification: "Checked the source and the original selected context." });
  const work = queryGapWork(store, review.key);
  assert.deepEqual(work.knowledgeRequest, request, "Queued work should preserve the complete structured request.");
  assert.deepEqual(work.queryParts, queryParts, "Queued work should replay the same separate query parts.");
  const other = normalizeKnowledgeRequest({ ...request, paths: ["calendar/other.js"] });
  captureQueryObservation(store, { repository: "thunderbird", revision, question: other.question,
    query, knowledgeRequest: other, queryParts: taskQueryParts(other) });
  assert.equal(queryGapReport(store).groups.length, 2, "The same question for different task paths should form separate gap groups.");
  assert.equal(store.all().length, 0, "Private task requests should not become searchable evidence.");
});

test("scheduled gap checks replay saved symbol searches", async t => {
  const store = await fixture(t);
  const source = await store.put(evidence(sourceText));
  const request = normalizeKnowledgeRequest({ question: unrelatedTerms, symbols: ["cancelPendingCalendarSave"], revision });
  const queryParts = taskQueryParts(request), query = queryParts.map(part => part.query).join(" ");
  const observationId = captureQueryObservation(store, { repository: "thunderbird", revision, root: "/source/comm",
    question: request.question, query, knowledgeRequest: request, queryParts }, { now: () => "2026-10-13T10:00:00Z" });
  const task = await store.put(evidence("Original private task answer.", { source: { type: "agent-turn", personal: true } }));
  captureQueryOutcome(store, observationId, { status: "completed", evidenceId: task.id });
  let prompt;
  const result = await runQueryGapSchedule(store, { minAgeMs: 1 }, {
    now: () => Date.parse("2026-10-13T11:00:00Z"), git: async () => revision,
    generate: async input => {
      prompt = input;
      return { state: "insufficient", reason: "ranking", explanation: "The original behavior needs a caller check.",
        verification: "The saved source excerpt is present; the caller has not been checked.", evidenceIds: [], sourceChecks: [] };
    },
  });
  assert.equal(result.state, "insufficient", "A source check without its caller should remain unresolved.");
  assert.ok(prompt.includes(source.id), "The scheduled check should retrieve the source through the saved symbol query.");
  assert.ok(prompt.includes(sourceText), "The scheduled check should receive the checked source excerpt.");
});


test("malformed saved query parts are rejected before retrieval or capture", async t => {
  const store = await fixture(t);
  const unknown = [{ kind: "workflow", query: "cancelPendingCalendarSave" }];
  const repeated = [{ kind: "question", query: "cancelPendingCalendarSave" }, { kind: "question", query: "unrelated" }];
  for (const queryParts of [unknown, repeated]) {
    assert.throws(() => searchKnowledge(store, { query: "cancelPendingCalendarSave", queryParts, repository: "thunderbird" }),
      /unknown or repeated/, "Malformed query parts should not become a fallback flat search.");
    assert.throws(() => captureQueryObservation(store, { question: "Explain cancellation", repository: "thunderbird", queryParts }),
      /unknown or repeated/, "Malformed query parts should not become a replayable observation.");
  }
  assert.equal(queryGapReport(store, { includeAll: true }).groups.length, 0, "Rejected query parts should not create private observations.");
});
