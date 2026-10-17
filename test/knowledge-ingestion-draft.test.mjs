import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, digest } from "../commands/knowledge/store.mjs";
import { IngestionInputError } from "../commands/knowledge/ingestion-queue.mjs";
import { HISTORY_PUBLIC_SOURCE_TYPES, validateIngestionDrafts } from "../commands/knowledge/ingestion-draft.mjs";
import { INGESTION_ACCESS_GAP_STATUS } from "../commands/knowledge/ingestion-access-gap.mjs";

const at = "2026-10-13T23:00:00Z", file = "mail/module.js", text = "export function value() { return 4; }";
const record = input => {
  const body = { version: 1, kind: "evidence", visibility: "private", repository: "thunderbird", at,
    paths: [file], text, source: { type: "git-diff", revision: "a".repeat(40), public: true, verified: true }, ...input };
  return { ...body, id: digest(body) };
};
const local = (key = "source", input = {}) => {
  const body = record(input);
  delete body.id;
  return { localKey: key, ...body };
};
const lesson = (id = "local:source", extra = {}) => ({ title: "Keep the return value", text: "The function returns four.",
  component: "Mail module", paths: [file], evidence: [id], quotes: [{ id, text }], supersedes: [], ...extra });
const draft = (extra = {}) => ({ at, range: { start: 1, end: 1 }, selectedIndices: [1],
  coverage: [{ index: 1, status: "examined", bugs: [], reviews: [] }], records: [local()], existingEvidence: [],
  lessons: [lesson()], reusedClaims: [], ...extra });
const noRecords = () => assert.fail("A local-only draft should not read durable records.");
const rejectInput = async (body, options = {}) => assert.rejects(
  validateIngestionDrafts([body], { getRecord: noRecords, ...options }), IngestionInputError,
  "Malformed draft input should reject with the typed input error.");

test("valid local and durable evidence uses exact immutable IDs without writes or input mutation", async () => {
  const saved = record(), body = draft({ records: [], existingEvidence: [saved.id], lessons: [lesson(saved.id)] });
  const before = canonical(body), reads = [];
  const getRecord = id => { reads.push(id); return id === saved.id ? saved : undefined; };
  const first = await validateIngestionDrafts([body], { getRecord });
  const second = await validateIngestionDrafts([body], { getRecord });

  assert.deepEqual(first, second, "The same exact inputs should return deterministic validation results.");
  assert.deepEqual(first.lessonStatuses, [{ title: body.lessons[0].title, status: "provisional" }],
    "Historical Git evidence should retain the existing learner's provisional status.");
  assert.deepEqual(reads, [saved.id, saved.id], "Each pass should read only the one referenced durable record.");
  assert.equal(canonical(body), before, "Validation should preserve the caller's draft bytes.");
  const localResult = await validateIngestionDrafts([draft()], { getRecord: noRecords });
  assert.equal(localResult.localRecordIds["local:source"], saved.id, "A local record should use the same checksum as store.put.");
});

test("missing, conflicting and stale local identities reject before a durable lookup", async () => {
  await rejectInput(draft({ lessons: [lesson("local:missing")] }));
  await rejectInput(draft({ records: [local(), local("source", { text: "different source body" })] }));
  await rejectInput(draft({ records: [{ ...local(), id: "f".repeat(64) }] }));
  await rejectInput(draft({ existingEvidence: ["local:missing"] }));
  await rejectInput(draft({ coverage: [{ index: 1, status: "examined", sourceEvidence: ["local:missing"] }] }));
  await rejectInput(draft({ records: [{ ...local(), paths: ["../private"] }] }));
});

test("public source formats require explicit trusted types and selected evidence", async () => {
  for (const type of ["commit-diff", "git-unreviewed-format", "browser-discussion"]) {
    await rejectInput(draft({ records: [local("source", { source: { type, public: true, verified: true } })] }));
  }
  const unselected = record();
  await rejectInput(draft({ records: [], lessons: [lesson(unselected.id)] }), { getRecord: () => unselected });
  await rejectInput(draft({ records: [local("source", { source: { type: "git-diff", public: false, verified: true } })] }));
  await rejectInput(draft({ records: [local("source", { source: { type: "git-diff", public: true, verified: true, personal: true } })] }));
  const body = draft({ records: [local("source", { source: { type: "git-chain-context", revision: "a".repeat(40), public: true, verified: true } })] });
  await validateIngestionDrafts([body], { getRecord: noRecords, publicSourceTypes: HISTORY_PUBLIC_SOURCE_TYPES });
  assert.equal(HISTORY_PUBLIC_SOURCE_TYPES.includes("commit-diff"), false, "The reviewed union should not add the unsupported commit-diff alias.");
  assert.equal(Object.isFrozen(HISTORY_PUBLIC_SOURCE_TYPES), true, "The trusted history type list should be immutable.");
});

test("lesson quote membership and exact text use the existing learner validation", async () => {
  await rejectInput(draft({ lessons: [lesson(undefined, { quotes: [{ id: "local:source", text: "An invented quotation" }] })] }));
  await rejectInput(draft({ records: [local(), local("other", { text: text + "\nAnother source line." })],
    lessons: [lesson(undefined, { quotes: [{ id: "local:other", text }] })] }));
  await rejectInput(draft({ lessons: [lesson(undefined, { quotes: [{ id: "local:source", text: "short" }] })] }));
});

test("proposal status is predicted by acceptLessons without promoting unquoted current context", async () => {
  const snapshot = local("current", { source: { type: "code-snapshot", file, revision: "b".repeat(40), public: true, verified: true } });
  const current = draft({ records: [snapshot], lessons: [lesson("local:current")] });
  const supported = await validateIngestionDrafts([current], { getRecord: noRecords });
  assert.equal(supported.lessonStatuses[0].status, "supported", "An observed quoted current contract should retain the learner's supported status.");
  for (const intent of [{ status: "provisional" }, { classification: "proposed-rule" }, { text: "Proposed optional convention." }]) {
    await rejectInput(draft({ records: [snapshot], lessons: [lesson("local:current", intent)] }));
  }
  const proposed = draft({ records: [local(), snapshot], lessons: [lesson(undefined,
    { classification: "proposed-rule", evidence: ["local:source", "local:current"] })] });
  const result = await validateIngestionDrafts([proposed], { getRecord: noRecords });
  assert.equal(result.lessonStatuses[0].status, "provisional", "A Git-primary proposal with unquoted current context should remain provisional.");
});

test("prose and exact quotes beginning with a known local alias remain data", async () => {
  const literal = "local:source", body = draft({ records: [local("source", { text: literal })],
    lessons: [lesson(undefined, { title: literal, text: literal, quotes: [{ id: "local:source", text: literal }] })] });
  const result = await validateIngestionDrafts([body], { getRecord: noRecords });
  assert.equal(result.lessonStatuses[0].title, literal, "A title equal to an alias should remain literal prose.");
  assert.equal(body.lessons[0].quotes[0].text, literal, "An exact quote equal to an alias should retain its bytes.");
});

test("dense legacy coverage and explicit sparse selection retain exact assignments", async () => {
  const legacy = draft({ range: { start: 1, end: 2 }, coverage: [{ index: 1, status: "examined" }, { index: 2, status: "examined" }] });
  delete legacy.selectedIndices;
  assert.deepEqual((await validateIngestionDrafts([legacy], { getRecord: noRecords })).selectedIndices, [1, 2],
    "Dense legacy coverage should preserve its full sequence.");
  const sparse = draft({ range: { start: 1, end: 3 }, selectedIndices: [1, 3],
    coverage: [{ index: 1, status: "examined" }, { index: 3, status: "examined" }] });
  const result = await validateIngestionDrafts([sparse], { getRecord: noRecords, expectedIndices: [1, 3] });
  assert.deepEqual(result.selectedIndices, [1, 3], "Explicit sparse coverage should not invent the missing row.");
  await rejectInput(sparse, { expectedIndices: [1, 2, 3] });
  await rejectInput({ ...sparse, selectedIndices: undefined });
  await rejectInput(draft({ selectedIndices: [2] }));
  await rejectInput(draft({ range: { start: 1, end: 2 } }));
  await assert.rejects(validateIngestionDrafts([draft(), draft()], { getRecord: noRecords }), IngestionInputError,
    "Two drafts should not claim the same row.");
  await rejectInput(draft({ coverage: [{ index: 1, status: "pending" }] }));
});

test("an exact combined assignment allows disjoint dense inputs without filling coverage", async () => {
  const first = draft(), third = draft({ range: { start: 3, end: 3 }, coverage: [{ index: 3, status: "examined" }] });
  delete first.selectedIndices;
  delete third.selectedIndices;
  await assert.rejects(validateIngestionDrafts([first, third], { getRecord: noRecords }), IngestionInputError,
    "Disjoint legacy drafts should require an explicit combined assignment.");
  const result = await validateIngestionDrafts([first, third], { getRecord: noRecords, expectedIndices: [1, 3] });
  assert.deepEqual(result.selectedIndices, [1, 3], "An exact combined assignment should preserve only the two audited rows.");
});

test("unused unsupported source context remains available but cannot support a lesson", async () => {
  const context = record({ source: { type: "commit-diff", revision: "c".repeat(40), public: true, verified: true } });
  const body = draft({ existingEvidence: [context.id] }), getRecord = id => id === context.id ? context : undefined;
  const result = await validateIngestionDrafts([body], { getRecord });
  assert.equal(result.lessonStatuses[0].status, "provisional", "Unused legacy context should preserve the valid cited Git lesson.");
  await rejectInput({ ...body, lessons: [lesson(context.id)] }, { getRecord });
});

test("missing durable records, corrupt stored records and lookup errors stay unknown failures", async () => {
  const saved = record(), body = draft({ records: [], existingEvidence: [saved.id], lessons: [lesson(saved.id)] });
  for (const getRecord of [() => undefined, () => ({ ...saved, text: "corrupt stored body" })]) {
    await assert.rejects(validateIngestionDrafts([body], { getRecord }), error => !(error instanceof IngestionInputError),
      "A missing or corrupt durable dependency should remain a storage failure.");
  }
  const fault = new Error("Storage unavailable");
  await assert.rejects(validateIngestionDrafts([body], { getRecord: () => { throw fault; } }),
    error => error === fault, "An unexpected lookup failure should preserve its original error.");
});

test("access gaps use exact private denial proof and never admit that raw evidence to a lesson", async () => {
  const url = "https://phabricator.services.mozilla.com/D123", readScope = { accessDenied: true, contentRead: false,
    completeAvailableContext: false, completeHumanTimeline: false, completeSubmittedInlineThreads: false };
  const denial = record({ paths: [], source: { type: "browser-discussion", url, public: false, verified: false, readScope },
    text: JSON.stringify({ url, title: "Access Denied: Restricted Differential Revision",
      body: "You do not have permission to view this object.", readScope }) });
  const row = { index: 1, status: INGESTION_ACCESS_GAP_STATUS, reason: "Exact denial retained.", bugs: [],
    reviews: [{ url, status: "access-denied", contentRead: false, completeAvailableContext: false, evidence: [denial.id] }] };
  const body = draft({ coverage: [row], records: [], existingEvidence: [denial.id], lessons: [] });
  const getRecord = id => id === denial.id ? denial : undefined;
  const result = await validateIngestionDrafts([body], { getRecord });
  assert.deepEqual(result.selectedIndices, [1], "An exact gap should retain its selected audit row without claiming content was read.");
  await rejectInput({ ...body, lessons: [lesson(denial.id)] }, { getRecord });
  await rejectInput({ ...body, coverage: [{ ...row, status: "examined" }] }, { getRecord });
  await rejectInput({ ...body, coverage: [{ ...row, reviews: [{ ...row.reviews[0], contentRead: true }] }] }, { getRecord });
});

test("reused shared lessons retain private comparison context without making a new proof", async () => {
  const proof = record(), old = record({ kind: "lesson", visibility: "shared", evidence: [proof.id], quotes: [{ id: proof.id, text }],
    status: "provisional", supersedes: [], component: "Mail module", source: { type: "extraction" } });
  const browser = record({ source: { type: "browser-discussion", public: false, verified: false } });
  const getRecord = id => new Map([proof, old, browser].map(r => [r.id, r])).get(id);
  const reuse = { id: old.id, evidence: [proof.id], quotes: old.quotes };
  const body = draft({ records: [], existingEvidence: [proof.id], lessons: [], reusedClaims: [reuse] });
  await validateIngestionDrafts([body], { getRecord });
  await rejectInput({ ...body, existingEvidence: [], reusedClaims: [reuse] }, { getRecord });
  const comparison = { ...body, existingEvidence: [proof.id, browser.id],
    reusedClaims: [{ ...reuse, evidence: [browser.id], quotes: [{ id: browser.id, text }] }] };
  const result = await validateIngestionDrafts([comparison], { getRecord });
  assert.deepEqual(result.lessonStatuses, [], "Private reuse comparison should not create or promote a new lesson.");
  await rejectInput({ ...comparison, lessons: [lesson(browser.id)] }, { getRecord });
});
