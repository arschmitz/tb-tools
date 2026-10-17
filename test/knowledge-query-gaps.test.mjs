import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";
import { captureQueryObservation, captureQueryOutcome, queryGapReport, reviewQueryGap, queryGapWork } from "../commands/knowledge/query-gaps.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "query-gaps-"));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
const observation = { question: "Which caller cancels the operation?", repository: "thunderbird", revision: "abc", paths: ["mail/example.js"], ids: [] };
const checked = observationId => ({ observationId, state: "confirmed", reason: "missing-evidence", explanation: "No source documents the caller contract.", checkedBy: "source reviewer", verification: "Checked the implementation and caller at abc; the relationship is absent from indexed evidence.", evidenceIds: [] });

test("observations group within revision and scope without entering search or learning", async t => {
  const store = await fixture(t);
  captureQueryObservation(store, observation);
  const id = captureQueryObservation(store, observation);
  captureQueryObservation(store, { ...observation, revision: "def" });
  captureQueryObservation(store, { ...observation, repository: "tb-tools" });
  const report = queryGapReport(store, { repository: "thunderbird" });
  assert.equal(report.groups.length, 2, "Different source revisions should remain separate.");
  assert.equal(report.groups[0].count, 2, "Repeated questions should share a gap group.");
  assert.equal(store.all().length, 0, "Query diagnostics should not become evidence records.");
  assert.deepEqual(searchKnowledge(store, { query: observation.question, repository: "thunderbird" }).ids, [], "Query text should not answer itself through search.");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0, "Query diagnostics should not enter learning jobs.");
  assert.equal(captureQueryOutcome(store, id, { status: "completed", turnId: "turn" }), true, "An outcome should attach to its exact observation.");
  assert.equal(queryGapReport(store).groups.find(g => g.count === 2).outcome.turnId, "turn", "The latest observation should retain its own outcome.");
});

test("only checked confirmed gaps create work drafts and resolution requires an evaluation", async t => {
  const store = await fixture(t);
  const id = captureQueryObservation(store, observation);
  const key = queryGapReport(store).groups[0].key;
  assert.throws(() => queryGapWork(store, key), /confirmed/, "Unchecked signals should not create work.");
  assert.throws(() => reviewQueryGap(store, { ...checked(id), verification: "" }), /verification/, "Reviews should require a stated check.");
  reviewQueryGap(store, checked(id));
  const work = queryGapWork(store, key);
  assert.equal(work.action, "focused-source-check", "Missing evidence should produce a focused source request.");
  assert.equal(work.executable, false, "A work request should not execute automatically.");
  assert.equal(work.evaluationDraft.ready, false, "An evaluation draft should require checked facts and anchors.");
  assert.throws(() => reviewQueryGap(store, { ...checked(id), state: "resolved" }), /evaluation/, "Resolution should require an evaluation case.");
  reviewQueryGap(store, { ...checked(id), state: "resolved", evaluationCaseId: "caller-contract", verification: "Checked caller-contract rerun: passed at abc." });
  assert.throws(() => queryGapWork(store, key), /confirmed/, "Resolved gaps should not generate new work.");
});

test("review evidence cannot cross repositories and indexing gaps do not request another scan", async t => {
  const store = await fixture(t);
  const foreign = await store.put({ kind: "evidence", repository: "tb-tools", at: new Date().toISOString(), text: "caller contract", source: { type: "code-snapshot" } });
  const id = captureQueryObservation(store, observation);
  assert.throws(() => reviewQueryGap(store, { ...checked(id), evidenceIds: [foreign.id] }), /repository/, "Evidence should belong to the query repository.");
  const review = reviewQueryGap(store, { ...checked(id), reason: "indexing" });
  assert.equal(queryGapWork(store, review.key).action, "retrieval-or-answer-fix", "Indexing failures should request a retrieval fix.");
});

test("retention survives rebuild and reopening and does not infer failure from success", async t => {
  const store = await fixture(t);
  const id = captureQueryObservation(store, { ...observation, ids: ["result"] }, { maxObservations: 1 });
  assert.equal(queryGapReport(store).groups.length, 0, "Queries with results should not automatically be called failures.");
  assert.equal(queryGapReport(store, { includeAll: true }).groups.length, 1, "All observations should be available for checked review.");
  reviewQueryGap(store, { ...checked(id), state: "dismissed" });
  captureQueryObservation(store, { ...observation, question: "New query" }, { maxObservations: 1 });
  assert.equal(captureQueryOutcome(store, id, {}), false, "Expired observations should not accept outcomes.");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM query_gap_reviews").get().n, 0, "Expired groups should lose their reviews.");
  await store.rebuild();
  const second = await openKnowledgeStore(store.directory);
  try { assert.equal(queryGapReport(second).groups.length, 1, "Local diagnostics should survive rebuild and reopening."); }
  finally { second.close(); }
});

test("console retrieval captures its question and attaches the completed turn", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "query-gap-service-"));
  const service = await createKnowledgeService({ directory, semantic: false, importLegacy: false, push: false });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await service.beforeTurn({ cwd: process.cwd(), prompt: "Where is a unique_missing_query_symbol implemented?" });
  assert.ok(result.context.queryObservationId, "Console retrieval should return an observation identifier.");
  await service.capture({ context: result.context, prompt: "question", message: "Insufficient evidence", turnId: "completed-turn", status: "completed", retrievalIds: result.ids });
  const group = queryGapReport(service.store, { includeAll: true }).groups[0];
  assert.equal(group.mode, "exact", "Unavailable embeddings should be recorded as exact search.");
  assert.equal(group.outcome.turnId, "completed-turn", "The turn should attach to its retrieval observation.");
});

test("changed source is only a signal and explicit scopes form separate groups", async t => {
  const store = await fixture(t);
  captureQueryObservation(store, { ...observation, ids: ["record"], applicability: [{ id: "record", state: "Scoped files changed; recheck this lesson against current source." }], filters: { role: "production" } });
  captureQueryObservation(store, { ...observation, filters: { role: "test" } });
  const groups = queryGapReport(store).groups;
  assert.equal(groups.length, 2, "Different explicit scopes should remain separate.");
  assert.ok(groups.some(group => group.signals.includes("changed-source")), "Changed source should produce a check signal.");
  assert.ok(groups.every(group => group.review === null), "Signals should not become confirmed diagnoses.");
});

test("CLI searches create observations that can be reviewed and exported as work", async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(os.tmpdir(), "gap-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = async (...args) => JSON.parse((await execute(process.execPath,
    ["commands/knowledge/cli.mjs", ...args, "--directory", directory], { cwd: process.cwd() })).stdout);
  const result = await run("search", "--repository", "thunderbird", observation.question);
  assert.ok(result.queryObservationId, "CLI searches should record an observation.");
  const report = await run("gaps", "--repository", "thunderbird");
  assert.equal(report.groups.length, 1, "An empty search should appear in the signal report.");
  const filename = path.join(directory, "checked-review.json");
  await writeFile(filename, JSON.stringify(checked(result.queryObservationId)));
  const review = await run("gap-review", "--file", filename);
  const work = await run("gap-work", review.key);
  assert.equal(work.question, observation.question, "A work draft should preserve the original question.");
  assert.equal(work.evaluationDraft.ready, false, "The CLI should not mark a draft evaluation ready.");
});
