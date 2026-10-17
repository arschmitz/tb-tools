import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { openKnowledgeStore, searchKnowledge } from '../commands/knowledge/store.mjs';
import { searchSectionVectors } from '../commands/knowledge/vector-search.mjs';
import { createVectorIndex } from '../commands/knowledge/vector-index.mjs';
import { openEvaluationIndex } from '../commands/knowledge/evaluation-index.mjs';
import { createKnowledgeService } from '../commands/knowledge/service.mjs';

const require = createRequire(import.meta.url);
let nativeAvailable = true;
try { require('usearch'); } catch { nativeAvailable = false; }
const nativeTest = (name, run) => test(name, { skip: !nativeAvailable && 'The optional native vector binding is unavailable.' }, run);

const model = 'vector-search-test';
const options = { repository: 'thunderbird', model, vector: [1, 0] };
const ids = result => result.hits.map(hit => hit.id);
const circle = angle => [Math.cos(angle), Math.sin(angle)];

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-vector-search-'));
  const stores = [];
  t.after(async () => { for (const store of stores.reverse()) store.close(); await rm(directory, { recursive: true, force: true }); });
  const store = await openKnowledgeStore(directory);
  stores.push(store);
  return { store, directory, stores };
}

async function source(store, index, vector, { repository = 'thunderbird', vectorModel = model } = {}) {
  const record = await store.put({ kind: 'evidence', repository, at: '2026-10-13T00:00:00Z',
    title: `Vector source ${index}`, component: `Vector component ${index}`, text: `Source ${index} supplies an independent contract for operation${index}.`,
    paths: [`calendar/vector${index}.js`], source: { type: 'code-snapshot', file: `calendar/vector${index}.js`, revision: 'a'.repeat(40), verified: true } });
  const section = store.db.prepare('SELECT * FROM sections WHERE record_id=?').get(record.id);
  store.db.prepare('INSERT INTO section_vectors VALUES (?,?,?)').run(section.id, vectorModel, JSON.stringify(vector));
  return { record, section };
}

async function seed(store, count = 640, offset = 0) {
  const rows = [];
  for (let index = 0; index < count; index++) rows.push(await source(store, index + offset, circle((index + 0.17) * 2 * Math.PI / count)));
  return rows;
}

function oracle(store, args = options) {
  return store.db.prepare(`SELECT v.rowid,v.id,v.vector,s.body,s.record_id FROM section_vectors v
    JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id
    WHERE r.repository=? AND v.model=? ORDER BY r.rowid,s.rowid`).all(args.repository, args.model)
    .filter(row => !args.eligible || args.eligible.has(row.record_id))
    .map(row => ({ id: row.id, rowid: row.rowid, body: row.body,
      score: JSON.parse(row.vector).reduce((sum, value, index) => sum + value * (args.vector[index] || 0), 0) }))
    .filter(row => row.score > 0.35).sort((a, b) => b.score - a.score).slice(0, 60);
}

function maintain(store, limit = 128) {
  const passes = [];
  for (let batch = 0; batch < 40; batch++) {
    const status = store.vectorIndex.maintain({ limit });
    passes.push(status);
    assert.equal(status.error, undefined, 'A valid native index batch should complete without an error.');
    assert.ok(status.processed <= limit, 'Each native maintenance pass should respect its row limit.');
    if (status.ready) return passes;
    assert.equal(status.pending, true, 'An unfinished valid index should request another bounded pass.');
  }
  assert.fail('The isolated index should become ready within its bounded fixture passes.');
}

function assertExact(store, args = options) {
  const result = searchSectionVectors(store, args);
  assert.deepEqual(result.hits, oracle(store, args), 'Fallback results should equal the original exhaustive scores and stable top 60 order.');
  assert.equal(result.details.mode, 'exact', 'The query should use exact search when the graph cannot serve the complete scope.');
  return result;
}

test('exact search preserves strict threshold, stable ties, top 60, repository and model', async t => {
  const { store, directory } = await fixture(t);
  await seed(store, 90);
  await source(store, 'foreign', [1, 0], { repository: 'tb-tools' });
  await source(store, 'other-model', [1, 0], { vectorModel: 'other-model' });
  const exact = searchSectionVectors(store, { ...options, mode: 'exact' });
  assert.deepEqual(exact.hits, oracle(store), 'Streaming exact search should preserve the original exhaustive output.');
  assert.equal(exact.details.scored, 90, 'Exact scoring should exclude different repositories and models.');
  await assert.rejects(access(path.join(directory, 'vector-index-v5.sqlite')), { code: 'ENOENT' }, 'An exact query should not create a derived index.');
  const boundary = await source(store, 'boundary', [0.35, Math.sqrt(1 - 0.35 ** 2)]);
  const above = await source(store, 'above', [0.3500000001, Math.sqrt(1 - 0.3500000001 ** 2)]);
  const tie = await source(store, 'tie', [0.3500000001, Math.sqrt(1 - 0.3500000001 ** 2)]);
  const scoped = searchSectionVectors(store, { ...options, mode: 'exact', eligible: new Set([boundary.record.id, above.record.id, tie.record.id]) });
  assert.deepEqual(ids(scoped), [above.section.id, tie.section.id], 'The threshold should exclude exactly 0.35 and preserve source order for equal scores.');
  const many = await seed(store, 180, 1000);
  assert.equal(many.length, 180, 'The extended fixture should supply more than 60 positive neighbors.');
  const limited = searchSectionVectors(store, { ...options, mode: 'exact' });
  assert.equal(limited.hits.length, 60, 'The final exact result should contain at most 60 hits.');
  assert.deepEqual(limited.hits, oracle(store), 'The top 60 should match exhaustive scoring after additional inserts.');
});

nativeTest('a ready graph rescored from source vectors preserves retrieval choices with bounded candidates', async t => {
  const { store } = await fixture(t);
  await seed(store);
  const passes = maintain(store);
  assert.ok(passes.length > 1, 'A large source partition should backfill across multiple bounded passes.');
  const args = { ...options, vector: circle(0.137) };
  const indexed = searchSectionVectors(store, args);
  assert.equal(indexed.details.mode, 'indexed', 'A ready normalized partition above the activation size should use the graph.');
  assert.equal(indexed.details.approximate, true, 'Indexed results should identify approximate candidate selection.');
  assert.ok(indexed.details.scored <= 368, 'Indexed retrieval should rescore no more than 368 original vectors including recent writes.');
  assert.equal(indexed.details.candidates, indexed.details.scored, 'Every indexed candidate should be rescored from the authoritative source.');
  assert.deepEqual(indexed.hits, oracle(store, args), 'The deterministic ring fixture should preserve the exact top 60 and original scores.');
  const request = { ...args, query: 'unmatchedprobe', maxChars: 18_000, trace: true };
  const exact = searchKnowledge(store, { ...request, semanticMode: 'exact' });
  const result = searchKnowledge(store, request);
  assert.deepEqual(result.ids, exact.ids, 'The production pipeline should select the same independent sources for this fixture.');
  assert.equal(result.text, exact.text, 'The task should receive the same complete context after indexed candidate selection.');
  assert.equal(result.trace.semanticSearch.mode, 'indexed', 'The retrieval trace should expose indexed semantic search.');
});

nativeTest('explicit scope uses exact search even when its neighbors fall outside the global candidate set', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  const eligible = new Set(rows.slice(112, 124).map(row => row.record.id));
  const result = assertExact(store, { ...options, eligible });
  assert.equal(result.details.reason, 'explicit-scope', 'An explicit scope should bypass approximate global candidates.');
  assert.equal(result.details.scored, 12, 'Only eligible original vectors should be scored.');
  const request = { ...options, query: 'unmatchedprobe', filters: { component: rows[122].record.component }, trace: true };
  const actual = searchKnowledge(store, request);
  const expected = searchKnowledge(store, { ...request, semanticMode: 'exact' });
  assert.deepEqual(actual.ids, expected.ids, 'An explicit component filter should preserve exhaustive production results.');
  assert.equal(actual.trace.semanticSearch.mode, 'exact', 'Filtered production retrieval should expose its exact fallback.');
});

nativeTest('same-count updates, deletes and inserts invalidate a ready graph until maintenance completes', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  const changed = rows[320];
  store.db.prepare('UPDATE section_vectors SET vector=? WHERE id=? AND model=?').run('[1,0]', changed.section.id, model);
  const updated = assertExact(store);
  assert.equal(updated.details.reason, 'index-pending', 'A same-count vector update should invalidate the completed generation.');
  assert.equal(updated.hits[0].id, changed.section.id, 'The fallback should immediately return the updated original vector.');
  maintain(store);
  assert.equal(searchSectionVectors(store, options).hits[0].id, changed.section.id, 'Incremental maintenance should publish the updated winner.');
  store.db.prepare('DELETE FROM section_vectors WHERE id=? AND model=?').run(changed.section.id, model);
  assertExact(store);
  maintain(store);
  assert.equal(ids(searchSectionVectors(store, options)).includes(changed.section.id), false, 'A deleted source vector should leave the ready graph.');
  const inserted = await source(store, 'inserted', [1, 0]);
  assert.equal(assertExact(store).hits[0].id, inserted.section.id, 'A newly inserted best vector should be visible before graph maintenance.');
  maintain(store);
  assert.equal(searchSectionVectors(store, options).hits[0].id, inserted.section.id, 'Maintenance should add new original vectors to the graph.');
});

nativeTest('orphan removal and source restoration update graph eligibility without vector writes', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  const selected = rows[0].section;
  store.db.prepare('DELETE FROM sections WHERE id=?').run(selected.id);
  assertExact(store);
  maintain(store);
  assert.equal(ids(searchSectionVectors(store, options)).includes(selected.id), false, 'A vector without its source section should be absent from retrieval.');
  store.db.prepare('INSERT INTO sections VALUES (?,?,?)').run(selected.id, selected.record_id, selected.body);
  assert.equal(ids(assertExact(store)).includes(selected.id), true, 'Restoring an orphan source should immediately restore exact retrieval.');
  maintain(store);
  assert.equal(ids(searchSectionVectors(store, options)).includes(selected.id), true, 'Section restoration should journal its existing vector for the graph.');
});

nativeTest('unsupported vectors and mixed dimensions force fallback for the entire repository and model', async t => {
  const { store } = await fixture(t);
  await seed(store);
  const unsupported = await source(store, 'non-normalized', [3, 0]);
  maintain(store);
  const result = assertExact(store);
  assert.equal(result.details.reason, 'unsupported-vectors', 'A non-normalized source should prevent partial graph coverage.');
  assert.equal(result.hits[0].id, unsupported.section.id, 'Fallback should preserve the original dot-product behavior for unsupported vectors.');
  store.db.prepare('UPDATE section_vectors SET vector=? WHERE id=?').run('[1,0,0]', unsupported.section.id);
  maintain(store);
  const mixed = assertExact(store);
  assert.equal(mixed.details.reason, 'mixed-dimensions', 'Different source dimensions should force whole-scope fallback.');
});

nativeTest('lost derived state backfills from authoritative vectors after the durable journal is pruned', async t => {
  const { store, stores, directory } = await fixture(t);
  await seed(store);
  maintain(store);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM semantic_vector_changes').get().count, 0, 'A completed graph should allow durable journal entries to be pruned.');
  const expected = oracle(store);
  store.close(); stores.pop();
  for (const suffix of ['', '-wal', '-shm']) await rm(path.join(directory, `vector-index-v5.sqlite${suffix}`), { force: true });
  const reopened = await openKnowledgeStore(directory); stores.push(reopened);
  assert.deepEqual(assertExact(reopened).hits, expected, 'Loss of the derived file should preserve all exact retrieval evidence.');
  await assert.rejects(access(path.join(directory, 'vector-index-v5.sqlite')), { code: 'ENOENT' }, 'Fallback queries should not rebuild or create the missing sidecar.');
  maintain(reopened);
  assert.equal(searchSectionVectors(reopened, options).details.mode, 'indexed', 'A missing graph should rebuild from current source rows even with an empty journal.');
  assert.deepEqual(searchSectionVectors(reopened, options).hits, expected, 'Rebuilt candidate search should preserve source scores and order.');
});

nativeTest('read-only evaluations retain a pinned source snapshot without opening a writable sidecar', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  const readers = [];
  t.after(() => { for (const reader of readers) reader.close(); });
  const reader = await openEvaluationIndex(path.join(store.directory, 'index.sqlite')); readers.push(reader);
  const readonly = createVectorIndex(reader, { readOnly: true });
  t.after(() => readonly.close());
  reader.vectorIndex = readonly;
  const expected = oracle(reader);
  store.db.prepare('UPDATE section_vectors SET vector=? WHERE id=?').run('[1,0]', rows[320].section.id);
  maintain(store);
  const actual = assertExact(reader);
  assert.equal(actual.details.reason, 'read-only', 'Pinned evaluation should explicitly use the read-only exact path.');
  assert.deepEqual(actual.hits, expected, 'Later source and graph updates should not alter the pinned evaluation snapshot.');
  assert.equal(searchSectionVectors(store, options).hits[0].id, rows[320].section.id, 'The writer should independently see its newer graph generation.');
  assert.equal(readonly.maintain().reason, 'read-only', 'Read-only maintenance should refuse to open or repair the sidecar.');
});

async function serviceFixture(t, enabled = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'knowledge-vector-service-'));
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  service = await createKnowledgeService({ directory, semantic: false, importLegacy: false }, enabled ? { embeddings: { ready: false, model, async embed() { return null; }, async close() {} } } : {});
  return { service, close: async () => { await service.close(); service = null; } };
}

test('service start backfills an existing embedding cache and continues bounded batches', { timeout: 5000 }, async t => {
  const { service } = await serviceFixture(t);
  const calls = [];
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  service.store.vectorIndex.maintain = args => {
    calls.push(args);
    const ready = calls.length === 3;
    if (ready) complete();
    return { ready, pending: !ready, processed: 16 };
  };
  service.start();
  await completed;
  assert.deepEqual(calls, Array(3).fill({ limit: 16 }), 'Startup should schedule bounded maintenance and continue until the existing cache is ready.');
  await service.indexSemantic();
  const count = await service.indexSemantic();
  assert.equal(count, 0, 'Derived maintenance should preserve the empty embedding count.');
  assert.equal(calls.length, 4, 'An explicit semantic indexing pass should maintain the graph even when no embeddings are missing.');
});

test('service close waits for active maintenance and cancels pending continuation', { timeout: 5000 }, async t => {
  const { service, close } = await serviceFixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  service.store.vectorIndex.maintain = async args => { calls.push(args); entered(); await pending; return { ready: false, pending: true, processed: 16 }; };
  service.start();
  await started;
  let closed = false;
  const closing = close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'Closing the service should wait for its active native maintenance pass.');
  release();
  await closing;
  service.start();
  assert.equal(calls.length, 1, 'A stopped service should not schedule a pending batch or restart maintenance.');
});


nativeTest('conflict-tolerant source updates remain journaled while initial backfill is incomplete', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store);
  const partial = store.vectorIndex.maintain({ limit: 16 });
  assert.equal(partial.ready, false, 'One small batch should leave initial backfill incomplete.');
  const generation = store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='semantic_vector_changes'").get().seq;
  store.db.prepare('UPDATE OR IGNORE section_vectors SET vector=? WHERE id=? AND model=?').run('[-1,0]', rows[0].section.id, model);
  const updatedGeneration = store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='semantic_vector_changes'").get().seq;
  assert.ok(updatedGeneration > generation, 'An outer conflict policy should still create a newer vector journal generation.');
  assertExact(store);
  maintain(store);
  for (const vector of [[1, 0], [-1, 0]]) {
    const args = { ...options, vector };
    const result = searchSectionVectors(store, args);
    assert.equal(result.details.mode, 'indexed', 'The graph should be ready after backfill and change replay.');
    assert.deepEqual(result.hits, oracle(store, args), 'The completed graph should preserve both old and new query results after a mid-backfill update.');
  }
});


test('disabled semantics leave derived maintenance stopped', async t => {
  const { service, close } = await serviceFixture(t, false);
  let calls = 0;
  service.store.vectorIndex.maintain = () => { calls++; return { ready: true, pending: false }; };
  service.start();
  await service.indexSemantic();
  await close();
  assert.equal(calls, 0, 'A disabled semantic service should not build a derived vector index.');
});


nativeTest('another source connection invalidates vectors when repository and vector identities change', async t => {
  const { store, stores, directory } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  const writer = await openKnowledgeStore(directory); stores.push(writer);
  const changed = rows[320];
  writer.db.prepare('UPDATE section_vectors SET vector=? WHERE id=? AND model=?').run('[1,0]', changed.section.id, model);
  assert.equal(assertExact(store).hits[0].id, changed.section.id, 'A separate source connection should invalidate the prior graph generation.');
  maintain(store);
  assert.equal(searchSectionVectors(store, options).hits[0].id, changed.section.id, 'The graph should consume committed changes from another source connection.');
  const movedRecord = { ...changed.record, repository: 'tb-tools' };
  writer.db.prepare('UPDATE records SET repository=?,body=? WHERE id=?').run('tb-tools', JSON.stringify(movedRecord), changed.record.id);
  assert.equal(ids(assertExact(store)).includes(changed.section.id), false, 'A moved record should leave the original repository before graph maintenance.');
  maintain(store);
  assert.equal(ids(searchSectionVectors(store, options)).includes(changed.section.id), false, 'Record repository changes should remove stale graph membership.');
  const moved = assertExact(store, { ...options, repository: 'tb-tools' });
  assert.equal(moved.hits[0].id, changed.section.id, 'The new repository should receive the original vector through exact fallback.');
  const target = await source(writer, 'new-identity', [1, 0], { vectorModel: 'other-model' });
  writer.db.prepare('UPDATE section_vectors SET id=?,model=? WHERE id=? AND model=?').run(target.section.id, 'moved-model', changed.section.id, model);
  assertExact(store);
  maintain(store);
  assert.equal(searchSectionVectors(store, { ...options, repository: 'tb-tools' }).hits.length, 0, 'Changing vector identity should remove its old repository and model entry.');
  const replacement = assertExact(store, { ...options, model: 'moved-model' });
  assert.equal(replacement.hits[0].id, target.section.id, 'Changing vector identity should index the new source and model key.');
});

nativeTest('a damaged derived file falls back to original evidence without query repair', async t => {
  const { store, directory } = await fixture(t);
  await seed(store, 75);
  const file = path.join(directory, 'vector-index-v5.sqlite');
  const damage = 'This is an intentionally damaged disposable vector index.';
  await writeFile(file, damage);
  const result = assertExact(store);
  assert.equal(result.details.reason, 'index-error', 'An invalid derived database should use exact semantic retrieval.');
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(file, 'utf8'), damage, 'A failed graph query should preserve the damaged file instead of repairing it.');
});

test('an unavailable optional native binding preserves exact semantic retrieval', async t => {
  const { store, directory } = await fixture(t);
  await seed(store, 75);
  const load = Module._load;
  t.mock.method(Module, '_load', function(request, ...args) {
    if (request === 'usearch') throw Object.assign(new Error('The isolated fixture has no native module.'), { code: 'MODULE_NOT_FOUND' });
    return Reflect.apply(load, this, [request, ...args]);
  });
  const status = store.vectorIndex.maintain();
  assert.equal(status.reason, 'native-unavailable', 'A missing optional binding should stop native maintenance without losing source vectors.');
  const result = assertExact(store);
  assert.equal(result.details.reason, 'native-unavailable', 'Search should expose its exact fallback when the optional binding is absent.');
  await assert.rejects(access(path.join(directory, 'vector-index-v5.sqlite')), { code: 'ENOENT' }, 'A missing binding should not create an unusable sidecar.');
});

test('read-only fallback works without native code or a derived index', async t => {
  const { store, directory } = await fixture(t);
  await seed(store, 75);
  let reader;
  t.after(() => { reader?.vectorIndex.close(); reader?.close(); });
  reader = await openEvaluationIndex(path.join(directory, 'index.sqlite'));
  reader.vectorIndex = createVectorIndex(reader, { readOnly: true });
  const result = assertExact(reader);
  assert.equal(result.details.reason, 'read-only', 'A pinned reader should use exact source scoring without native indexing.');
  assert.equal(reader.vectorIndex.maintain().reason, 'read-only', 'A pinned reader should decline maintenance before loading native code.');
  await assert.rejects(access(path.join(directory, 'vector-index-v5.sqlite')), { code: 'ENOENT' }, 'Read-only search and maintenance should never create a sidecar.');
});

nativeTest('candidate selection and rescoring share one source snapshot during an external update', async t => {
  const { store, stores, directory } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  const expected = oracle(store);
  const writer = await openKnowledgeStore(directory); stores.push(writer);
  const candidates = store.vectorIndex.candidates.bind(store.vectorIndex);
  let writes = 0;
  store.vectorIndex.candidates = (args, consume) => candidates(args, result => {
    writer.db.prepare('UPDATE section_vectors SET vector=? WHERE id=? AND model=?').run('[-1,0]', rows[0].section.id, model);
    writes++;
    return consume(result);
  });
  const result = searchSectionVectors(store, options);
  assert.equal(writes, 1, 'The test should commit an external update after candidate selection and before source rescoring.');
  assert.equal(result.details.mode, 'indexed', 'The in-flight query should keep its matching old graph and source snapshots.');
  assert.deepEqual(result.hits, expected, 'Rescoring should use the same source snapshot that validated the graph generation.');
  store.vectorIndex.candidates = candidates;
  const following = assertExact(store);
  assert.equal(ids(following).includes(rows[0].section.id), false, 'The next query should observe the committed update through exact fallback.');
});


test('equal scores preserve the pre-index SQL order after reverse vector insertion and replacement', async t => {
  const { store } = await fixture(t);
  const rows = [];
  for (let index = 0; index < 65; index++) rows.push(await source(store, index, [1, 0]));
  const vectors = store.db.prepare('SELECT id,model,vector FROM section_vectors ORDER BY rowid DESC').all();
  store.db.exec('DELETE FROM section_vectors');
  for (const row of vectors) store.db.prepare('INSERT INTO section_vectors VALUES (?,?,?)').run(row.id, row.model, row.vector);
  store.db.prepare('INSERT OR REPLACE INTO section_vectors VALUES (?,?,?)').run(rows[1].section.id, model, '[1,0]');
  store.db.exec('DROP INDEX section_vectors_model');
  const original = store.db.prepare(`SELECT v.id,v.vector FROM section_vectors v
    JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id
    WHERE v.model=? AND r.repository=?`).all(model, 'thunderbird')
    .map(row => ({ id: row.id, score: JSON.parse(row.vector).reduce((sum, value, index) => sum + value * (options.vector[index] || 0), 0) }))
    .filter(row => row.score > 0.35).sort((a, b) => b.score - a.score).slice(0, 60);
  assert.deepEqual(original.map(row => row.id), rows.slice(0, 60).map(row => row.section.id), 'The original SQL plan should resolve score ties in source order despite reversed vector insertion.');
  store.db.exec('CREATE INDEX section_vectors_model ON section_vectors(model)');
  const result = searchSectionVectors(store, { ...options, mode: 'exact' });
  assert.deepEqual(ids(result), original.map(row => row.id), 'The streaming path should preserve the old top 60 tie order after adding its model index.');
  assert.deepEqual(result.hits, oracle(store), 'Replacement vector row IDs should not change source-order ties.');
});


nativeTest('an inserted winner remains retrievable after it leaves the recent-write supplement', async t => {
  const { store } = await fixture(t);
  await seed(store);
  maintain(store);
  const winner = await source(store, 'aged-winner', [1, 0]);
  maintain(store);
  assert.equal(searchSectionVectors(store, options).hits[0].id, winner.section.id, 'The new source should initially be the exact-scored winner.');
  for (let index = 0; index < 140; index++) {
    await source(store, `later-${index}`, [-1, 0]);
  }
  maintain(store);
  const result = searchSectionVectors(store, options);
  assert.equal(result.details.mode, 'indexed', 'The aged-write regression should exercise a ready graph.');
  assert.equal(result.hits[0].id, winner.section.id, 'The graph should retain a winning insertion after more than 128 later writes.');
  assert.deepEqual(result.hits, oracle(store), 'Older graph neighbors should preserve exact fixture results after recent-write protection expires.');
});

nativeTest('an aged insertion survives a prior vector replacement and deletion without intermediate searches', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store);
  maintain(store);
  store.db.prepare('UPDATE section_vectors SET vector=? WHERE id=? AND model=?').run('[1,0]', rows[320].section.id, model);
  maintain(store);
  store.db.prepare('DELETE FROM section_vectors WHERE id=? AND model=?').run(rows[320].section.id, model);
  maintain(store);
  const winner = await source(store, 'replacement-aged-winner', [1, 0]);
  maintain(store);
  const initial = searchSectionVectors(store, options);
  assert.equal(initial.details.mode, 'indexed', 'The first search after replacement, deletion, and insertion should use the completed graph.');
  assert.equal(initial.hits[0].id, winner.section.id, 'The inserted source should be the exact-scored winner before later writes.');
  for (let index = 0; index < 129; index++) await source(store, `replacement-later-${index}`, [-1, 0]);
  maintain(store);
  const aged = searchSectionVectors(store, options);
  assert.equal(aged.details.mode, 'indexed', 'The final search should use the completed graph after recent-write protection expires.');
  assert.equal(aged.hits[0].id, winner.section.id, 'The graph should retain an aged winner after the full replacement, deletion, and insertion sequence.');
  assert.deepEqual(aged.hits, oracle(store), 'The completed graph should preserve exact top 60 results without intervening native searches.');
});

nativeTest('backfill restarts when source row IDs are reused for an already imported key', async t => {
  const { store } = await fixture(t);
  const rows = await seed(store, 8);
  const partial = store.vectorIndex.maintain({ limit: 2 });
  assert.equal(partial.ready, false, 'A two-row batch should leave the eight-row fixture incomplete.');
  assert.ok(partial.processed >= 1, 'The partial batch should import the key that will be replaced.');
  store.db.exec('DELETE FROM section_vectors WHERE rowid>2');
  store.db.prepare('INSERT OR REPLACE INTO section_vectors VALUES (?,?,?)').run(rows[0].section.id, model, '[1,0]');
  assert.equal(store.db.prepare('SELECT rowid FROM section_vectors WHERE id=?').get(rows[0].section.id).rowid, 3, 'Replacing the first vector should reuse a row ID inside the initial backfill range.');
  const passes = maintain(store, 2);
  assert.equal(passes.at(-1).ready, true, 'Backfill should reset and converge when an imported key reappears at a reused row ID.');
  assert.deepEqual(searchSectionVectors(store, options).hits, oracle(store), 'The rebuilt cache should preserve the remaining authoritative vector results.');
});

nativeTest('more than 240 tied vectors preserve the original source order through exact fallback', async t => {
  const { store } = await fixture(t);
  const rows = [];
  for (let index = 0; index < 640; index++) rows.push(await source(store, index, [1, 0]));
  maintain(store);
  const result = assertExact(store);
  assert.equal(result.details.scored, 640, 'A tied candidate boundary should score the full source partition.');
  assert.deepEqual(ids(result), rows.slice(0, 60).map(row => row.section.id), 'A native tie order should not displace the original first 60 source sections.');
});

async function graphFiles(t, directory) {
  const { DatabaseSync } = await import('node:sqlite');
  let metadata;
  t.after(() => metadata?.close());
  metadata = new DatabaseSync(path.join(directory, 'vector-index-v5.sqlite'), { readOnly: true });
  const files = metadata.prepare('SELECT file FROM segments ORDER BY id').all().map(row => path.join(directory, 'vector-index-v5', row.file));
  metadata.close(); metadata = null;
  return files;
}

nativeTest('a persisted immutable graph serves a reopened store without rebuilding or changing graph files', async t => {
  const { store, stores, directory } = await fixture(t);
  await seed(store);
  maintain(store);
  const expected = oracle(store);
  const files = await graphFiles(t, directory);
  assert.ok(files.length > 0, 'Completed metadata should reference at least one saved native graph.');
  const { readFile } = await import('node:fs/promises');
  const original = await Promise.all(files.map(file => readFile(file)));
  store.close(); stores.pop();
  const reopened = await openKnowledgeStore(directory); stores.push(reopened);
  const result = searchSectionVectors(reopened, options);
  assert.equal(result.details.mode, 'indexed', 'A reopened store should use its committed immutable graph before maintenance.');
  assert.deepEqual(result.hits, expected, 'Loading a saved graph should preserve the exact fixture neighbors and scores.');
  assert.deepEqual(await graphFiles(t, directory), files, 'Retrieval should not publish replacement graph files.');
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), original, 'Retrieval should leave all published graph bytes unchanged.');
});

for (const damage of ['missing', 'corrupt']) {
  nativeTest(`a ${damage} immutable graph falls back until maintenance publishes a replacement`, async t => {
    const { store, directory } = await fixture(t);
    await seed(store);
    maintain(store);
    const files = await graphFiles(t, directory);
    assert.ok(files.length > 0, 'The fixture should create a native graph before it is damaged.');
    if (damage === 'missing') await rm(files[0]);
    else {
      assert.equal(searchSectionVectors(store, options).details.mode, 'indexed', 'The corruption fixture should first cache a validated graph view.');
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(files[0]);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(files[0], bytes);
    }
    const fallback = assertExact(store);
    assert.equal(fallback.details.approximate, false, 'An unavailable or altered immutable graph should retain exact retrieval.');
    maintain(store);
    const repaired = searchSectionVectors(store, options);
    assert.equal(repaired.details.mode, 'indexed', 'Maintenance should rebuild a damaged disposable graph from source vectors.');
    assert.deepEqual(repaired.hits, oracle(store), 'A repaired graph should preserve every exact fixture hit and source score.');
  });
}


nativeTest('reset rollback preserves the previously committed immutable graph files', async t => {
  const { store, directory } = await fixture(t);
  await seed(store);
  maintain(store);
  const files = await graphFiles(t, directory);
  const { readFile } = await import('node:fs/promises');
  const previous = await Promise.all(files.map(file => readFile(file)));
  store.setting('semanticVectorEpoch', 'isolated-source-recreation');
  const { Index } = require('usearch');
  const save = Index.prototype.save;
  let unpublished;
  t.mock.method(Index.prototype, 'save', function(file) {
    Reflect.apply(save, this, [file]); unpublished = file;
    throw new Error('Deliberate graph save failure.');
  });
  const failed = store.vectorIndex.maintain({ limit: 16 });
  assert.equal(failed.ready, false, 'A failed reset batch should not claim a ready graph.');
  assert.match(failed.error, /Deliberate graph save failure/, 'The fixture should fail while saving the new graph inside the reset transaction.');
  assert.deepEqual(await graphFiles(t, directory), files, 'Rolling back a reset should retain the previously committed graph manifest.');
  await assert.doesNotReject(Promise.all(files.map(file => readFile(file))), 'Rolling back a reset should preserve every file referenced by the committed manifest.');
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), previous, 'A failed replacement should leave all previously published graph bytes unchanged.');
  await assert.rejects(access(unpublished), { code: 'ENOENT' }, 'A failed reset should remove its written but unpublished graph file.');
  t.mock.restoreAll();
  maintain(store);
  const rebuilt = searchSectionVectors(store, options);
  assert.equal(rebuilt.details.mode, 'indexed', 'A later successful reset should publish a usable replacement graph.');
  assert.deepEqual(rebuilt.hits, oracle(store), 'The successful replacement should retain the authoritative source results.');
});


nativeTest('maintenance recreates a removed graph directory while the metadata writer stays open', async t => {
  const { store, directory } = await fixture(t);
  await seed(store);
  maintain(store);
  assert.ok((await graphFiles(t, directory)).length > 0, 'The fixture should have a committed graph before its directory is removed.');
  await rm(path.join(directory, 'vector-index-v5'), { recursive: true, force: true });
  assertExact(store);
  maintain(store);
  const result = searchSectionVectors(store, options);
  assert.equal(result.details.mode, 'indexed', 'Maintenance should recreate the graph directory without closing the metadata writer.');
  assert.deepEqual(result.hits, oracle(store), 'A directory rebuild should preserve all authoritative fixture results.');
  assert.ok((await graphFiles(t, directory)).length > 0, 'The rebuilt directory should contain the committed replacement graph.');
});
