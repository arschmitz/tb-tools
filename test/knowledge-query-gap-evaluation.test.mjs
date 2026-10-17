import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { captureQueryObservation, captureQueryOutcome, reviewQueryGap, queryGapWork, queryGapReport } from "../commands/knowledge/query-gaps.mjs";
import { initializeGapEvaluations, runQueryGapEvaluations, gapEvaluationStatus, reviewGapAnswer, scoreGapRetrieval, gapEvaluationCase } from "../commands/knowledge/query-gap-evaluation.mjs";
import { createKnowledgeAnswerProvider } from "../commands/knowledge/answer-provider.mjs";
import { normalizeKnowledgeRequest, taskQueryParts } from "../commands/knowledge/task-query.mjs";

const revision = "a".repeat(40), quote = "function cancelOperation() { controller.abort(); }";
const git = async (_root, args) => args[0] === "show" ? quote : args[0] === "diff" ? "" : args[1] === "HEAD" ? revision : "blob";
const sourceReview = () => JSON.stringify({ rationale: "The source calls abort, and the answer identifies that call.",
  scores: { correctness: 2, completeness: 2, citationSupport: 2, scope: 2, uncertainty: 2 },
  facts: [{ index: 0, verdict: "supported", reason: "The source and answer both call controller.abort()." }],
  prohibitedClaims: [{ index: 0, verdict: "absent", reason: "The answer does not claim a runtime test." }, { index: 1, verdict: "absent", reason: "The answer states the source behavior without claiming that an excerpt proves overall correctness." }],
  sourceChecks: [{ sourceIndex: 0, quote, reason: "The original function aborts the operation." }] });
async function fixture(t, { reason = "missing-evidence", query = "cancelOperation", mode = "exact", knowledgeRequest, queryParts } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gap-evaluation-")), store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const source = await store.put({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T10:00:00Z", paths: ["mail/cancel.js"], text: quote,
    source: { type: "code-snapshot", revision, file: "mail/cancel.js", verified: true } });
  const observation = captureQueryObservation(store, { repository: "thunderbird", root: "/source/comm", revision, question: knowledgeRequest?.question || "How is the operation canceled?", query, mode, knowledgeRequest, queryParts, model: mode === "hybrid" ? "model" : null });
  captureQueryOutcome(store, observation, { status: "completed", evidenceId: source.id });
  const review = reviewQueryGap(store, { observationId: observation, state: "confirmed", reason, evidenceIds: [source.id],
    checkedBy: "Fixture source check", explanation: "Required source evidence is missing.", verification: "Checked the source function and caller." });
  initializeGapEvaluations(store);
  const work = { ...queryGapWork(store, review.key), sourceChecks: [{ path: "mail/cancel.js", revision, quote }], state: "awaiting-evaluation" };
  store.db.prepare("INSERT INTO query_gap_work VALUES (?, ?, ?)").run(review.key, "2026-10-13T10:00:00Z", JSON.stringify(work));
  return { store, source, work };
}

test("the worker verifies the original query and reviews its answer automatically", async t => {
  const { store, source } = await fixture(t);
  const prompts = [];
  const provider = createKnowledgeAnswerProvider({ generate: async text => { prompts.push(text); return text.startsWith("Review") ? sourceReview() : `cancelOperation calls controller.abort(). Source: ${source.id}`; }, directory: store.directory });
  const result = await runQueryGapEvaluations(store, {}, { git, provider, now: () => Date.parse("2026-10-13T11:00:00Z") });
  assert.equal(result.retrieval.pass, true, "The checked source and excerpt should be returned.");
  assert.equal(result.configuration.query, "cancelOperation", "The rerun should preserve the original query without expected-fact expansion.");
  const review = queryGapReport(store).groups[0].review;
  assert.equal(review.state, "resolved", "Successful evidence retrieval should close a retrieval gap.");
  assert.equal(review.resolutionScope, "answer", "A source-reviewed answer should state its answer scope.");
  assert.equal(result.answerQuality, "assistant-reviewed-pass", "Generated answers should receive automatic source review.");
  assert.doesNotMatch(prompts[0], /Explain the behavior relevant|prohibited|rubric/, "Answer generation should not receive the expected facts or review rubric.");
  assert.equal(gapEvaluationStatus(store).answerReviews, 0, "A checked answer should not wait for human review.");
  assert.equal(store.setting("calls:2026-10-13"), 2, "Answer generation and review should each consume one budgeted call.");
  assert.equal(store.all().length, 1, "Evaluation questions and answers should not enter knowledge records.");
});

test("missing sections and missing source evidence cannot resolve a gap", async t => {
  const { store, work, source } = await fixture(t, { query: "unique_unmatched_symbol" });
  const result = await runQueryGapEvaluations(store, {}, { git, provider: { generate: () => assert.fail("Missing evidence should not trigger answer generation.") } });
  assert.equal(result.retrieval.pass, false, "An unmatched query should fail retrieval.");
  assert.equal(queryGapReport(store).groups[0].review.state, "confirmed", "A failed rerun should leave the gap open.");
  const item = gapEvaluationCase(store, work);
  const wrongExcerpt = { ids: [source.id], text: JSON.stringify({ id: source.id, text: "An unrelated section." }) };
  assert.equal(scoreGapRetrieval(store, item, wrongExcerpt).pass, false, "A matching parent ID should not replace the required source excerpt.");
});

test("semantic unavailability never silently changes the recorded search mode", async t => {
  const { store } = await fixture(t, { mode: "hybrid" });
  const result = await runQueryGapEvaluations(store, {}, { git });
  assert.equal(result.status, "unavailable", "Unavailable embeddings should be reported.");
  assert.match(result.error, /not substituted/, "Unavailable hybrid search should preserve its limitation.");
  assert.equal(queryGapReport(store).groups[0].review.state, "confirmed", "Unavailable semantic search should not resolve the gap.");
});

test("changed source files prevent a stale evaluation from closing a gap", async t => {
  const { store } = await fixture(t);
  const result = await runQueryGapEvaluations(store, {}, { git: async (root, args) => args[1]?.includes(`:${"mail/cancel.js"}`) && args[1].startsWith("b") ? "different" : args[1] === "HEAD" ? "b".repeat(40) : git(root, args) });
  assert.equal(result.status, "unavailable", "A changed source file should invalidate the checked baseline.");
  assert.match(result.error, /changed/, "The result should explain the source change.");
  assert.equal(queryGapReport(store).groups[0].review.state, "confirmed", "A stale baseline should not resolve the gap.");
});

test("answer failures remain open and reviews bind to the saved answer", async t => {
  const { store, source, work } = await fixture(t, { reason: "answer-misuse" });
  const result = await runQueryGapEvaluations(store, {}, { git, maxCallsPerDay: 1, provider: { generate: async () => `Calls controller.abort(). ${source.id}` } });
  assert.equal(queryGapReport(store).groups[0].review.state, "confirmed", "An answer-use gap should remain open after retrieval passes.");
  const review = { reviewer: "Source reviewer", reviewerKind: "human", rationale: "Checked the source and answer; the cancellation call and scope agree.", answerDigest: result.answerDigest,
    scores: { correctness: 2, completeness: 2, citationSupport: 2, scope: 2, uncertainty: 2 },
    facts: [{ index: 0, verdict: "supported", reason: "The answer identifies the exact cancellation call." }] };
  assert.throws(() => reviewGapAnswer(store, work.key, { ...review, answerDigest: "wrong" }), /match/, "A review should bind to the saved answer digest.");
  assert.equal(reviewGapAnswer(store, work.key, review).answerQuality, "reviewed-pass", "A complete checked review should pass.");
  assert.equal(queryGapReport(store).groups[0].review.resolutionScope, "answer", "A checked answer review should state its answer scope.");
});

test("a budgeted source review resumes the saved answer without regenerating it", async t => {
  const { store, source } = await fixture(t, { reason: "answer-misuse" });
  let generated = 0, reviewed = 0;
  const provider = createKnowledgeAnswerProvider({ generate: async prompt => {
    if (prompt.startsWith("Review")) { reviewed++; return sourceReview(); }
    generated++; return `Calls controller.abort(). ${source.id}`;
  }, directory: store.directory });
  const first = await runQueryGapEvaluations(store, {}, { git, provider, maxCallsPerDay: 1, now: () => Date.parse("2026-10-13T11:00:00Z") });
  assert.equal(first.answerQuality, "waiting-for-source-review-budget", "A saved answer should wait for automatic review when the budget is exhausted.");
  assert.equal((await runQueryGapEvaluations(store, {}, { git, provider, maxCallsPerDay: 1, now: () => Date.parse("2026-10-13T12:00:00Z") })).idle, true, "An exhausted budget should not repeatedly rerun the pending review.");
  const second = await runQueryGapEvaluations(store, {}, { git, provider, maxCallsPerDay: 1, now: () => Date.parse("2026-10-14T11:00:00Z") });
  assert.equal(second.answer, first.answer, "The review should preserve the exact saved answer.");
  assert.equal(second.answerQuality, "assistant-reviewed-pass", "The next budget window should complete source review.");
  assert.equal(generated, 1, "Review resumption should not generate another answer.");
  assert.equal(reviewed, 1, "The saved answer should receive one source review.");
});

test("daily budget gates answer calls but deterministic retrieval still runs", async t => {
  const { store } = await fixture(t);
  store.setting("calls:2026-10-13", 4);
  const result = await runQueryGapEvaluations(store, {}, { git, now: () => Date.parse("2026-10-13T11:00:00Z"), provider: { generate: () => assert.fail("An exhausted budget should block generation.") } });
  assert.equal(result.retrieval.pass, true, "Retrieval checks should run without an AI call.");
  assert.equal(result.answerQuality, "waiting-for-budget", "Answer generation should wait for the daily budget.");
});

test("legacy observations without the original query cannot claim automatic resolution", async t => {
  const { store, work } = await fixture(t);
  work.queryCaptured = false;
  store.db.prepare("UPDATE query_gap_work SET body=? WHERE gap_key=?").run(JSON.stringify(work), work.key);
  const result = await runQueryGapEvaluations(store, {}, { git });
  assert.equal(result.retrieval.pass, true, "A natural-question rerun may still verify source retrieval.");
  assert.equal(queryGapReport(store).groups[0].review.state, "confirmed", "A missing original query should prevent automatic resolution.");
});


test("scheduled evaluations replay the saved task query parts", async t => {
  const knowledgeRequest = normalizeKnowledgeRequest({
    question: Array.from({ length: 96 }, (_, index) => `workflowtoken${index}`).join(" "),
    taskType: "implementation", symbols: ["cancelOperation"], paths: ["mail/cancel.js"], revision,
  });
  const queryParts = taskQueryParts(knowledgeRequest);
  const query = queryParts.map(part => part.query).join(" ");
  const { store } = await fixture(t, { query, knowledgeRequest, queryParts });
  const result = await runQueryGapEvaluations(store, {}, {
    git, maxCallsPerDay: 0, now: () => Date.parse("2026-10-13T11:00:00Z"),
    provider: { generate: () => assert.fail("A zero answer budget should leave retrieval verification independent of generation.") },
  });
  assert.equal(result.retrieval.pass, true, "The saved symbol and path queries should recover the checked excerpt after the question term limit.");
  assert.deepEqual(result.configuration.queryParts, queryParts, "The evaluation should replay the original separate search parts.");
  assert.deepEqual(result.configuration.knowledgeRequest, knowledgeRequest, "The evaluation report should preserve the original structured task metadata.");
  assert.equal(result.configuration.query, query, "The evaluation should retain the original full query for semantic replay.");
  assert.equal(result.answerQuality, "waiting-for-budget", "An exhausted answer budget should not prevent the retrieval check.");
});


test("a truncated task question cannot automatically resolve its original gap", async t => {
  const knowledgeRequest = normalizeKnowledgeRequest({ question: `Explain the operation. ${"workflow ".repeat(1000)}`,
    symbols: ["cancelOperation"], revision });
  const queryParts = taskQueryParts(knowledgeRequest), query = queryParts.map(part => part.query).join(" ");
  const { store } = await fixture(t, { query, knowledgeRequest, queryParts });
  const result = await runQueryGapEvaluations(store, {}, { git });
  assert.equal(result.retrieval.pass, true, "A truncated request should still allow a useful checked-source retrieval.");
  assert.equal(result.configuration.knowledgeRequest.questionTruncated, true, "Private capture and work should retain the truncation flag.");
  assert.equal(result.configuration.originalQueryCaptured, false, "A shortened task question should not count as a complete original request.");
  assert.equal(queryGapReport(store).groups[0].review.state, "confirmed", "Retrieval for a truncated task should not close the original gap automatically.");
});


test("gap retrieval requires every checked section from the selected source", async t => {
  const { store } = await fixture(t);
  const first = "saveOperation starts a validated write.";
  const second = "readOnly targets reject that write.";
  const source = await store.put({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T10:00:00Z",
    paths: ["mail/save.js"], text: `# Write contract\n${first}\n${"Background detail.\n".repeat(70)}## Exception\n${second}\n`,
    source: { type: "code-snapshot", revision, file: "mail/save.js", verified: true } });
  const item = { repository: "thunderbird", filters: {}, evidence: [{ label: "write contract and exception", ids: [source.id],
    anchors: [{ repository: "thunderbird", revision, path: "mail/save.js", contains: [first, second] }] }] };
  const args = { query: "saveOperation readOnly", repository: "thunderbird", maxChars: 12_000 };
  const partial = searchKnowledge(store, { ...args, maxSectionsPerClaim: 1 });
  assert.equal(scoreGapRetrieval(store, item, partial).pass, false,
    "Selecting the right parent should not close a gap when the exception excerpt is missing.");
  const complete = searchKnowledge(store, args);
  assert.equal(scoreGapRetrieval(store, item, complete).pass, true,
    "Returning both exact excerpts from one selected source should satisfy the checked gap.");
});
