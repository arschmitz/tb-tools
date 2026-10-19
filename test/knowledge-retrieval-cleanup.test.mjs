import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge, validateRecord } from "../commands/knowledge/store.mjs";
import { recordSections } from "../commands/knowledge/sections.mjs";
import { acceptLessons, learnKnowledge } from "../commands/knowledge/learning.mjs";
import { classifyLearningQueue } from "../commands/knowledge/claims.mjs";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";
import { retrievalArchiveReason, RETRIEVAL_POLICY_VERSION } from "../commands/knowledge/retrieval-policy.mjs";

const repository = "thunderbird";
const model = "retrieval-cleanup-test";

function evidence(text, source = {}, extra = {}) {
  return { kind: "evidence", repository, at: "2026-10-14T02:00:00Z", paths: [], text, source, ...extra };
}

function rawCapture(token = "RawCaptureOnlyToken") {
  return evidence(JSON.stringify({
    url: "https://phabricator.services.mozilla.com/D123456",
    body: `Complete human timeline. ${token}. Request and author response remain available.`,
    dom: "Browser navigation and duplicated diff cells. ".repeat(60),
    readScope: { completeHumanTimeline: true, completeSubmittedInlineThreads: true },
  }), { type: "browser-discussion", public: false, verified: false });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-retrieval-cleanup-"));
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = async () => {
    const store = await openKnowledgeStore(directory);
    stores.add(store);
    return store;
  };
  const close = store => {
    store.close();
    stores.delete(store);
  };
  return { store: await open(), directory, open, close };
}

function rowsFor(store, record) {
  return {
    search: store.db.prepare("SELECT * FROM search WHERE id=?").all(record.id),
    sections: store.db.prepare("SELECT * FROM sections WHERE record_id=?").all(record.id),
    legacyVectors: store.db.prepare("SELECT * FROM vectors WHERE id=?").all(record.id),
    sectionVectors: store.db.prepare("SELECT v.* FROM section_vectors v JOIN sections s ON s.id=v.id WHERE s.record_id=?").all(record.id),
    job: store.db.prepare("SELECT * FROM jobs WHERE id=?").get(record.id),
    archive: store.db.prepare("SELECT * FROM retrieval_archives WHERE id=?").get(record.id),
  };
}

function databaseRows(store) {
  const tables = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name,
    store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}

function seedLegacyDerivedRows(store, record, state = "pending") {
  // Recreate the disposable rows written before archive policy existed.
  store.db.prepare("DELETE FROM retrieval_archives WHERE id=?").run(record.id);
  store.db.prepare("DELETE FROM search WHERE id=?").run(record.id);
  store.db.prepare("INSERT INTO search VALUES (?, ?, ?)").run(record.id, record.repository, record.text);
  const sections = recordSections({ ...record, source: { ...record.source, type: "legacy-derived-fixture" } });
  for (const section of sections) {
    store.db.prepare("INSERT INTO sections VALUES (?, ?, ?)").run(section.id, record.id, JSON.stringify(section));
    store.db.prepare("INSERT INTO section_search VALUES (?, ?, ?)").run(section.id, record.repository, section.input);
    store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(section.id, model, "[1,0]");
  }
  store.db.prepare("INSERT INTO vectors VALUES (?, ?, ?)").run(record.id, model, "[1,0]");
  store.db.prepare("UPDATE jobs SET state=?,attempts=3,retry=123 WHERE id=?").run(state, record.id);
  return sections;
}

test("new archives keep exact ID access and begin excluded before put returns", async t => {
  const { store } = await fixture(t);
  const rememberFile = store.rememberFile;
  let observed = 0;
  store.rememberFile = function(file, stat, id) {
    const record = this.get(id);
    if (retrievalArchiveReason(record)) {
      observed++;
      const rows = rowsFor(this, record);
      assert.ok(rows.archive, "An archived record should have committed membership before put returns.");
      assert.equal(rows.archive.policy_version, RETRIEVAL_POLICY_VERSION,
        "Archive membership should record the policy version that classified it.");
      assert.deepEqual(rows.search, [], "An archived record should not enter record full-text search.");
      assert.deepEqual(rows.sections, [], "An archived record should not create searchable or embeddable sections.");
      assert.equal(rows.job.state, "skipped", "An archived input should begin skipped before a learner can claim it.");
    }
    return rememberFile.call(this, file, stat, id);
  };

  const raw = await store.put(rawCapture());
  const operational = await store.put(evidence("Saved resume cursor and worker lease.", { type: "history-study-checkpoint" }));
  assert.equal(observed, 2, "Both raw and operational records should be excluded at the insertion boundary.");
  assert.deepEqual(store.get(raw.id), raw, "ID access should retain the exact immutable raw capture.");
  assert.deepEqual(validateRecord(JSON.parse(await readFile(store.file(raw), "utf8"))), raw,
    "The original file should remain a valid immutable record.");
  assert.ok(store.recordIds().some(row => row.id === raw.id), "Metadata enumeration should retain archived IDs.");
  assert.ok([...store.records()].some(record => record.id === operational.id), "Explicit record enumeration should retain recovery records.");
  assert.deepEqual(store.searchableRecords(repository), [], "Default searchable bodies should exclude both archive classes.");
  assert.deepEqual(searchKnowledge(store, { query: "RawCaptureOnlyToken", repository }).ids, [],
    "Default context should not contain a raw browser capture.");
});

test("archiving a raw source preserves valid lesson citations and useful source evidence", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(rawCapture());
  const quote = "Request and author response remain available.";
  await acceptLessons(store, [raw], { lessons: [{
    title: "Keep the response with the review request",
    text: "ReviewResponseContract records the request and author response together.",
    component: "mail/review", paths: [], evidence: [raw.id], quotes: [{ id: raw.id, text: quote }], supersedes: [],
  }] });
  const lesson = [...store.records({ kind: "lesson" })][0];
  const source = await store.put(evidence("CurrentSourceContract returns the requested value.",
    { type: "code-snapshot", file: "mail/source.js", revision: "a".repeat(40), verified: true },
    { paths: ["mail/source.js"] }));
  const map = await store.put(evidence("LargeSourceMapContract\n".repeat(150),
    { type: "source-map", revision: "b".repeat(40) }, { repository: "other-project" }));
  const review = await store.put(evidence("AcceptedReviewContract retains its applied change.",
    { type: "review-feedback", accepted: true }));

  assert.equal(store.get(lesson.evidence[0]).id, raw.id, "A lesson should retain access to its archived exact proof.");
  assert.ok(store.get(raw.id).text.includes(lesson.quotes[0].text), "The original source should still validate its lesson quote.");
  assert.ok(searchKnowledge(store, { query: "ReviewResponseContract", repository }).ids.includes(lesson.id),
    "A cited lesson should remain searchable when its raw proof is archived.");
  assert.ok(searchKnowledge(store, { query: "CurrentSourceContract", repository }).ids.includes(source.id),
    "Verified source evidence should remain searchable.");
  assert.ok(searchKnowledge(store, { query: "LargeSourceMapContract", repository: "other-project" }).ids.includes(map.id),
    "A large map from another repository should remain searchable.");
  assert.ok(searchKnowledge(store, { query: "AcceptedReviewContract", repository }).ids.includes(review.id),
    "Ordinary accepted review evidence should retain its search behavior.");
  assert.equal(retrievalArchiveReason(source), "", "Current source should not be archived by size or history association.");
  assert.equal(retrievalArchiveReason(map), "", "An ordinary large source map should not be classified as operational data.");
  assert.equal(retrievalArchiveReason(lesson), "", "A useful lesson should not inherit its proof's archive classification.");
});

test("inventory exclusion uses the exact study tags and never excludes lessons or other maps", async t => {
  const { store } = await fixture(t);
  const proof = await store.put(evidence("CheckedBodyContract records a caller boundary.", { type: "git-diff" }));
  const tags = ["architecture-study-20261013", "architecture-relationships-20261013"];
  for (const study of tags) {
    const inventory = await store.put(evidence(`InventoryOnlyToken ${study}`, { type: "source-map", study }));
    const lesson = await store.put({
      kind: "lesson", repository, at: "2026-10-14T02:00:00Z", title: `Retained ${study} lesson`,
      paths: [], component: "mail/contracts", status: "provisional", supersedes: [],
      evidence: [proof.id], quotes: [{ id: proof.id, text: "CheckedBodyContract records a caller boundary." }],
      text: `RetainedInventoryLessonToken ${study} preserves its checked boundary.`, source: { type: "extraction", study },
    });

    assert.equal(retrievalArchiveReason(inventory), "generated-source-inventory",
      "Each exact inventory study should classify its evidence as generated inventory.");
    assert.deepEqual(rowsFor(store, inventory).sections, [], "An exact inventory study should not create searchable sections.");
    assert.equal(rowsFor(store, inventory).job.state, "skipped", "An exact inventory study should not create learning work.");
    assert.equal(retrievalArchiveReason(lesson), "", "A lesson with the same study tag should retain its knowledge role.");
    assert.ok(store.searchableRecords(repository).some(record => record.id === lesson.id),
      "A lesson with the inventory tag should remain available to default retrieval.");
  }

  const continuation = await store.put(evidence("BodyContinuationToken explains the whole function and its caller.",
    { type: "source-map", study: "architecture-body-continuation-20261013" }));
  const thirdParty = await store.put(evidence("ThirdPartyMapToken\n".repeat(200),
    { type: "source-map", study: "third-party-analysis" }, { paths: ["third_party/library/source.cc"] }));
  const code = await store.put(evidence("OrdinaryCodeMapToken exposes its checked implementation.",
    { type: "source-map", revision: "c".repeat(40) }, { paths: ["mail/module.js"] }));

  for (const record of [continuation, thirdParty, code]) {
    assert.equal(retrievalArchiveReason(record), "", "A different study or ordinary source map should not inherit inventory exclusion.");
    assert.ok(rowsFor(store, record).sections.length > 0, "A retained map should keep its searchable sections.");
  }
  assert.ok(searchKnowledge(store, { query: "BodyContinuationToken", repository }).ids.includes(continuation.id),
    "A body continuation under a different tag should remain searchable.");
  assert.ok(searchKnowledge(store, { query: "ThirdPartyMapToken", repository }).ids.includes(thirdParty.id),
    "An ordinary third-party map should remain searchable regardless of its size.");
});

test("dry-run cleanup reports old derived candidates without changing files or cache rows", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(rawCapture());
  seedLegacyDerivedRows(store, raw);
  const before = databaseRows(store);
  const bytes = await readFile(store.file(raw));
  const report = store.cleanRetrieval({ limit: 1 });

  assert.equal(report.examined, 1, "A dry run should inspect only its bounded page.");
  assert.equal(report.candidates, 1, "A dry run should identify the raw capture's old derived rows.");
  assert.equal(report.throughRowid, store.maxRecordRowid(), "A dry run should retain its snapshot cutoff.");
  assert.deepEqual(databaseRows(store), before, "Dry-run cleanup should leave every database row unchanged.");
  assert.deepEqual(await readFile(store.file(raw)), bytes, "Dry-run cleanup should leave immutable file bytes unchanged.");
});

test("bounded cleanup removes both vector generations and skips only pending jobs", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(rawCapture("CleanupRawToken"));
  const sections = seedLegacyDerivedRows(store, raw);
  const finished = await store.put(rawCapture("FinishedRawToken"));
  seedLegacyDerivedRows(store, finished, "done");
  const source = await store.put(evidence("CleanupSourceToken remains useful.", { type: "git-diff" }));
  const sourceBefore = rowsFor(store, source);
  const cutoff = store.maxRecordRowid();
  const first = store.cleanRetrieval({ apply: true, limit: 1, throughRowid: cutoff });

  assert.equal(first.examined, 1, "The first cleanup page should examine one record.");
  assert.equal(first.archived, 1, "The first page should archive its raw candidate.");
  assert.equal(first.removedSections, sections.length, "Cleanup should remove every section for the selected raw record.");
  assert.equal(first.removedSectionVectors, sections.length, "Cleanup should remove the selected section vectors.");
  assert.equal(first.removedLegacyVectors, 1, "Cleanup should also remove its old record vector.");
  assert.equal(first.skippedJobs, 1, "Cleanup should skip the selected pending learning job.");
  assert.equal(first.done, false, "A page with remaining records should preserve a continuation cursor.");
  assert.ok(first.nextRowid > 0, "The cleanup cursor should advance to the examined row.");

  const later = await store.put(rawCapture("ArrivedAfterCutoffToken"));
  seedLegacyDerivedRows(store, later);
  const second = store.cleanRetrieval({ apply: true, afterRowid: first.nextRowid, throughRowid: cutoff, limit: 10 });
  assert.equal(second.done, true, "The second page should finish only the fixed snapshot.");
  assert.equal(second.skippedJobs, 0, "A completed historical job should not be rewritten as skipped.");
  assert.equal(rowsFor(store, finished).job.state, "done", "Completed learning history should remain intact.");
  assert.equal(rowsFor(store, raw).job.attempts, 3, "Cleanup should preserve the historical job attempt count.");
  assert.deepEqual(rowsFor(store, source), sourceBefore, "Cleanup should preserve useful source search rows and jobs.");
  assert.equal(rowsFor(store, later).archive, undefined, "A record beyond the fixed cutoff should remain for a later pass.");
  assert.equal(rowsFor(store, later).job.state, "pending", "A later legacy fixture should not be claimed by the earlier pass.");
  assert.deepEqual(rowsFor(store, raw).legacyVectors, [], "Archived legacy vectors should not remain available to semantic search.");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM section_vectors WHERE id IN (SELECT value FROM json_each(?))")
    .get(JSON.stringify(sections.map(section => section.id))).count, 0,
  "Removed section vectors should not remain as orphan rows.");
});

test("cleanup invalidates warmed search claims without removing evidence records", async t => {
  const { store } = await fixture(t);
  const source = await store.put(evidence("WarmedSurvivingToken supplies the original source contract.", { type: "git-diff" }));
  const input = rawCapture("WarmedArchiveToken");
  input.source.portableCopies = [source.id];
  const raw = await store.put(input);
  seedLegacyDerivedRows(store, raw);
  const count = store.count(repository);
  const before = searchKnowledge(store, { query: "WarmedSurvivingToken", repository });
  assert.ok(before.ids.includes(raw.id), "The old fixture should warm the copied source's representative with the pre-policy capture.");
  store.cleanRetrieval({ apply: true });

  assert.equal(store.count(repository), count, "Cleanup should preserve the total immutable record count.");
  assert.deepEqual(searchKnowledge(store, { query: "WarmedSurvivingToken", repository }).ids, [source.id],
    "A warmed claim cache should use the surviving source instead of its archived representative.");
  assert.deepEqual(searchKnowledge(store, { query: "WarmedArchiveToken", repository }).ids, [],
    "A warmed claim cache should stop returning a newly archived capture.");
  assert.deepEqual(searchKnowledge(store, { query: "absent", repository, model, vector: [1, 0], semanticMode: "exact" }).ids, [],
    "Exact semantic fallback should not return the removed legacy or section vector.");
  assert.ok(store.get(raw.id), "Explicit proof lookup should remain available after cache invalidation.");
});

test("cleanup repeats safely and reopen rebuild and section migration do not restore archives", async t => {
  const { store, open, close } = await fixture(t);
  const raw = await store.put(rawCapture());
  seedLegacyDerivedRows(store, raw);
  const source = await store.put(evidence("RebuildUsefulToken survives cleanup.", { type: "git-diff" }));
  const rawBytes = await readFile(store.file(raw));
  const sourceBytes = await readFile(store.file(source));
  store.cleanRetrieval({ apply: true });
  const repeated = store.cleanRetrieval({ apply: true });
  assert.equal(repeated.removedSections, 0, "Repeated cleanup should not report previously removed sections again.");
  assert.equal(repeated.removedSectionVectors, 0, "Repeated cleanup should not report previously removed vectors again.");
  assert.equal(repeated.skippedJobs, 0, "Repeated cleanup should not rewrite a skipped learning job.");
  close(store);

  const reopened = await open();
  await reopened.rebuild();
  assert.deepEqual(rowsFor(reopened, raw).sections, [], "Reopening and rebuilding should not recreate archived sections.");
  assert.deepEqual(rowsFor(reopened, raw).search, [], "Rebuilding should not restore archived record full-text rows.");
  assert.ok(searchKnowledge(reopened, { query: "RebuildUsefulToken", repository }).ids.includes(source.id),
    "Rebuilding should preserve useful ordinary source search.");
  reopened.db.prepare("DELETE FROM settings WHERE key='sectionVersion'").run();
  close(reopened);

  const migrated = await open();
  assert.deepEqual(rowsFor(migrated, raw).sections, [], "A section-format migration should respect existing archive membership.");
  assert.ok(rowsFor(migrated, raw).archive, "Archive reasons should remain present after a section migration.");
  assert.deepEqual(await readFile(migrated.file(raw)), rawBytes, "Every rebuild path should preserve the original raw file.");
  assert.deepEqual(await readFile(migrated.file(source)), sourceBytes, "Every rebuild path should preserve the source file.");
});

test("pending archive jobs are skipped without model calls or lesson output", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(rawCapture());
  seedLegacyDerivedRows(store, raw);
  store.cleanRetrieval({ apply: true });
  store.db.prepare("UPDATE jobs SET state='pending',retry=0 WHERE id=?").run(raw.id);
  let calls = 0;
  await classifyLearningQueue(store);
  const result = await learnKnowledge(store, { generate: async () => { calls++; return { lessons: [] }; } });

  assert.equal(calls, 0, "An archived pending input should never reach the model.");
  assert.equal(rowsFor(store, raw).job.state, "skipped", "Reclassification should return a restored archive job to skipped.");
  assert.equal(result.learned, 0, "Skipped operational evidence should not produce a learned result.");
  assert.deepEqual([...store.records({ kind: "lesson" })], [], "Raw capture cleanup should not create lessons as a side effect.");
});

test("an embedding batch already in flight does not restore a cleaned section vector", { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-retrieval-cleanup-embed-"));
  let service;
  let release;
  t.after(async () => {
    release?.();
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const embeddings = {
    ready: true, model,
    async embed(texts) {
      entered();
      await gate;
      return texts.map(() => [1, 0]);
    },
    async close() {},
  };
  service = await createKnowledgeService({ directory, semantic: true, importLegacy: false }, { embeddings });
  const raw = await service.store.put(rawCapture("InflightRawToken"));
  const sections = seedLegacyDerivedRows(service.store, raw);
  service.store.db.prepare("DELETE FROM section_vectors WHERE model=?").run(model);
  const indexing = service.indexSemantic();
  await started;
  service.store.cleanRetrieval({ apply: true });
  release();
  await indexing;

  assert.equal(service.store.db.prepare("SELECT count(*) AS count FROM section_vectors WHERE id IN (SELECT value FROM json_each(?))")
    .get(JSON.stringify(sections.map(section => section.id))).count, 0,
  "A delayed embedding result should not restore vectors for removed sections.");
  assert.deepEqual(searchKnowledge(service.store, { query: "InflightRawToken", repository, model, vector: [1, 0] }).ids, [],
    "A delayed embedding result should not return archived text to context.");
});

test("stale full-text and legacy vector hits do not return an archived record", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(evidence(JSON.stringify({
    body: "StaleArchivedToken keeps its human response.", dom: "Duplicated navigation.",
  }), { type: "browser-discussion" }));
  const section = recordSections(raw)[0];
  // Leave archive membership intact while recreating stale derived hits.
  store.db.prepare("INSERT INTO sections VALUES (?, ?, ?)").run(section.id, raw.id, JSON.stringify(section));
  store.db.prepare("INSERT INTO section_search VALUES (?, ?, ?)").run(section.id, repository, section.input);
  store.db.prepare("INSERT INTO vectors VALUES (?, ?, ?)").run(raw.id, model, "[1,0]");

  assert.ok(raw.text.length <= 1200, "The raw fixture should qualify for legacy record-vector search.");
  assert.ok(store.isRetrievalArchived(raw.id), "The stale fixture should retain committed archive membership.");
  assert.deepEqual(searchKnowledge(store, { query: "StaleArchivedToken", repository }).ids, [],
    "A stale full-text hit should not return its archived record.");
  assert.deepEqual(searchKnowledge(store, {
    query: "AbsentExactToken", repository, model, vector: [1, 0], semanticMode: "exact",
  }).ids, [], "A stale legacy vector hit should not return its archived record.");
  assert.deepEqual(store.get(raw.id), raw, "Explicit ID lookup should still return the original archived proof.");
});

test("non-Boolean cleanup apply values reject without mutation", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(rawCapture());
  seedLegacyDerivedRows(store, raw);
  const before = databaseRows(store);
  const bytes = await readFile(store.file(raw));

  for (const apply of ["true", "false", 1, 0, null, [], {}]) {
    assert.throws(() => store.cleanRetrieval({ apply }), /Boolean apply value/,
      "A non-Boolean apply value should reject before cleanup changes any state.");
    assert.deepEqual(databaseRows(store), before, "Rejected cleanup options should preserve every cache row.");
  }
  assert.deepEqual(await readFile(store.file(raw)), bytes, "Rejected cleanup options should preserve immutable file bytes.");
});

test("shifted full-text rowids preserve neighboring records during fallback cleanup", async t => {
  const { store } = await fixture(t);
  const neighbor = await store.put(evidence("NeighborGuardToken remains useful.", { type: "git-diff" }));
  const raw = await store.put(evidence(JSON.stringify({ body: "ShiftedRawToken", dom: "Navigation." }),
    { type: "browser-discussion" }));
  store.db.prepare("DELETE FROM retrieval_archives WHERE id=?").run(raw.id);
  store.db.prepare("UPDATE jobs SET state='pending' WHERE id=?").run(raw.id);
  const section = recordSections(raw)[0];
  const inserted = store.db.prepare("INSERT INTO sections VALUES (?, ?, ?)")
    .run(section.id, raw.id, JSON.stringify(section));
  const sectionRowid = Number(inserted.lastInsertRowid);
  const parentRowid = store.db.prepare("SELECT rowid FROM records WHERE id=?").get(raw.id).rowid;
  const neighborSection = store.db.prepare("SELECT id FROM sections WHERE record_id=?").get(neighbor.id);
  const neighborSectionHit = store.db.prepare("SELECT id,repository,text FROM section_search WHERE id=?").get(neighborSection.id);
  const neighborParentHit = store.db.prepare("SELECT id,repository,text FROM search WHERE id=?").get(neighbor.id);

  // Put the neighbor at the candidate's expected rowids, and the candidate elsewhere.
  store.db.prepare("DELETE FROM section_search WHERE id=?").run(neighborSection.id);
  store.db.prepare("INSERT INTO section_search(rowid,id,repository,text) VALUES (?, ?, ?, ?)")
    .run(sectionRowid, neighborSectionHit.id, neighborSectionHit.repository, neighborSectionHit.text);
  store.db.prepare("INSERT INTO section_search(rowid,id,repository,text) VALUES (?, ?, ?, ?)")
    .run(sectionRowid + 1000, section.id, repository, section.input);
  store.db.prepare("DELETE FROM search WHERE id=?").run(neighbor.id);
  store.db.prepare("INSERT INTO search(rowid,id,repository,text) VALUES (?, ?, ?, ?)")
    .run(parentRowid, neighborParentHit.id, neighborParentHit.repository, neighborParentHit.text);
  store.db.prepare("INSERT INTO search(rowid,id,repository,text) VALUES (?, ?, ?, ?)")
    .run(parentRowid + 1000, raw.id, repository, raw.text);
  const neighborBefore = rowsFor(store, neighbor);

  const result = store.cleanRetrieval({ apply: true });

  assert.equal(result.archived, 1, "Fallback cleanup should archive only the selected raw record.");
  assert.equal(result.removedSections, 1, "Fallback cleanup should remove the selected raw section.");
  assert.deepEqual(rowsFor(store, neighbor), neighborBefore, "Rowid guards should preserve the neighboring record and its derived rows.");
  assert.deepEqual(store.db.prepare("SELECT id,repository,text FROM section_search WHERE id=?").get(neighborSection.id),
    neighborSectionHit, "The section rowid guard should preserve the neighbor's full-text hit.");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM section_search WHERE id=?").get(section.id).count, 0,
    "Fallback cleanup should remove the raw section hit at its shifted rowid.");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM search WHERE id=?").get(raw.id).count, 0,
    "Fallback cleanup should remove the raw parent hit at its shifted rowid.");
  assert.deepEqual(store.get(raw.id), raw, "Fallback cleanup should preserve the original raw record.");
});

test("completed archives do not repeat unindexed parent full-text deletion", async t => {
  const { store } = await fixture(t);
  const raw = await store.put(rawCapture());
  seedLegacyDerivedRows(store, raw);
  store.cleanRetrieval({ apply: true });
  const prepare = store.db.prepare;
  let fallbackScans = 0;
  t.after(() => { store.db.prepare = prepare; });
  store.db.prepare = function(sql) {
    if (/^\s*DELETE FROM search\b/i.test(sql) && !/\browid\b/i.test(sql)) fallbackScans++;
    return prepare.call(this, sql);
  };

  const result = store.cleanRetrieval({ apply: true });

  assert.equal(fallbackScans, 0, "A completed archive should not repeat an unindexed parent full-text scan.");
  assert.equal(result.archived, 0, "Repeated cleanup should not create another archive entry.");
  assert.equal(result.removedSections, 0, "Repeated cleanup should not remove previously deleted sections again.");
  assert.deepEqual(store.get(raw.id), raw, "Skipping a completed archive should preserve its exact proof.");
});
