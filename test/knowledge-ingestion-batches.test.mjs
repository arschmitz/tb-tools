import test from "node:test";
import assert from "node:assert/strict";
import { selectIngestionBatch, sparsePublicationCoverage, validatePublicationSelection } from "../commands/knowledge/ingestion-batches.mjs";

const time = Date.parse("2026-10-13T23:00:00Z");
const draft = (indices, savedAt = time) => ({ indices, savedAt: new Date(savedAt).toISOString(), job: null });

test("ready entries across gaps share one bounded publication", () => {
  const drafts = { a: draft([1, 2]), b: draft([8]), c: draft([11, 12]), d: draft([20, 21, 22, 23, 24, 25]) };
  const selected = selectIngestionBatch(drafts, time);

  assert.deepEqual(selected.flatMap(item => item.indices), [1, 2, 8, 11, 12],
    "Five audited entries should share a publication without adding their unread neighbors.");
  assert.equal(drafts.a.job, null, "Selection should not mutate a draft or claim publication.");
});

test("small groups wait for a bounded interval and flush before the deadline", () => {
  const drafts = { a: draft([3]), b: draft([9]) };

  assert.deepEqual(selectIngestionBatch(drafts, time + 119999), [], "A small group should wait at most two minutes.");
  assert.equal(selectIngestionBatch(drafts, time + 120000).length, 2, "The oldest ready age should flush a small group.");
  assert.equal(selectIngestionBatch(drafts, time, { deadline: time + 120000 }).length, 2,
    "A short remaining run should flush ready work before its deadline.");
  assert.deepEqual(selectIngestionBatch(drafts, time, { deadline: time }), [], "An expired run should select no work.");
});

test("blocked and already queued drafts do not hold ready work", () => {
  const drafts = { blocked: { ...draft([1]), status: "awaiting-input-correction" },
    queued: { ...draft([2]), job: "immutable-job" }, next: draft([5, 6, 7, 8, 9]) };

  assert.deepEqual(selectIngestionBatch(drafts, time).flatMap(item => item.indices), [5, 6, 7, 8, 9],
    "Ready work should continue while rejected and queued drafts retain their own states.");
});

test("invalid assignments and options fail before selection", () => {
  for (const drafts of [{ a: draft([1]), b: draft([1]) }, { a: draft([3, 2]) },
    { a: draft([]) }, { a: { ...draft([1]), savedAt: "unknown" } }, { a: draft(Array.from({ length: 11 }, (_, i) => i + 1)) }]) {
    assert.throws(() => selectIngestionBatch(drafts, time), /Invalid|Duplicate/,
      "Duplicate, unordered, empty, undated or oversized drafts should be rejected.");
  }
  for (const options of [{ minimum: 0 }, { maximum: 4 }, { flushAfterMs: -1 }, { deadline: NaN }]) {
    assert.throws(() => selectIngestionBatch({}, time, options), /Invalid/,
      "Invalid batch settings should reject before claiming work.");
  }
});

test("sparse coverage preserves exact rows and needs explicit partial selection", () => {
  const rows = [{ index: 9, hash: "nine" }, { index: 3, hash: "three" }];
  const batch = sparsePublicationCoverage(rows);

  assert.deepEqual(batch.selectedIndices, [3, 9], "The explicit selection should list only supplied rows.");
  assert.deepEqual(batch.range, { start: 3, end: 9 }, "The range should describe the selection's endpoints.");
  assert.equal(batch.coverage.length, 2, "A gap should not create synthetic coverage rows.");
  assert.equal(rows[0].index, 9, "Sorting should preserve the caller's original input order.");
  assert.deepEqual(validatePublicationSelection(batch, { partial: true }), [3, 9],
    "Partial publication should accept the exact sparse selection.");
  assert.throws(() => validatePublicationSelection(batch), /explicit selection/,
    "Sparse coverage should not claim complete range publication.");
});

test("publication rejects added, omitted and duplicated selection rows", () => {
  const batch = sparsePublicationCoverage([{ index: 3 }, { index: 9 }]);
  for (const altered of [{ ...batch, selectedIndices: [3] }, { ...batch, selectedIndices: [3, 4, 9] },
    { ...batch, coverage: [...batch.coverage, { index: 3 }] }, { ...batch, range: { start: 2, end: 9 } }]) {
    assert.throws(() => validatePublicationSelection(altered, { partial: true }), /differ/,
      "Rows, endpoints and the declared selection should agree exactly.");
  }
  assert.throws(() => sparsePublicationCoverage([{ index: 3 }, { index: 3 }]), /Invalid/,
    "A duplicate input should not produce a sparse publication descriptor.");
});

test("legacy dense coverage still requires every entry", () => {
  const range = { start: 3, end: 5 };
  assert.deepEqual(validatePublicationSelection({ range, coverage: [{ index: 3 }, { index: 4 }, { index: 5 }] }), [3, 4, 5],
    "A complete legacy range should remain valid.");
  assert.throws(() => validatePublicationSelection({ range, coverage: [{ index: 3 }, { index: 5 }] }, { partial: true }), /gap/,
    "A legacy range without explicit selected indices should retain the dense coverage gate.");
});
