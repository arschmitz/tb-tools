import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openKnowledgeStore, searchKnowledge } from '../commands/knowledge/store.mjs';
import { scoreRetrieval } from '../commands/knowledge/evaluation.mjs';

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tb-retrieval-trace-'));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
const evidence = (text, extra = {}) => ({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-01T00:00:00Z', source: {}, text, ...extra });

test('rank-first search retains the old bm25 candidates and scope before limits', async t => {
  const store = await setup(t);
  for (let index = 0; index < 80; index++) await store.put(evidence(`targetSymbol ${index % 3 ? 'other' : 'targetSymbol'} ${index}`, { source: { language: index === 79 ? 'Rust' : 'JavaScript' } }));
  const expression = '"targetSymbol"';
  const old = store.db.prepare('SELECT s.body,bm25(section_search) AS rank FROM section_search JOIN sections s ON s.id=section_search.id WHERE section_search MATCH ? AND repository=? ORDER BY rank LIMIT 60').all(expression, 'thunderbird').map(row => JSON.parse(row.body).recordId);
  const result = searchKnowledge(store, { query: 'targetSymbol', repository: 'thunderbird', trace: true, maxChars: 24000, limit: 80 });
  const actual = result.trace.candidates.filter(candidate => candidate.exactRank).sort((a, b) => a.exactRank - b.exactRank).map(candidate => candidate.id);
  assert.deepEqual(actual, old, 'Rank-first candidates should retain the old bm25 ordering.');
  const scoped = searchKnowledge(store, { query: 'targetSymbol', repository: 'thunderbird', filters: { language: 'Rust' }, trace: true });
  assert.equal(scoped.ids.length, 1, 'Explicit scope should apply before the candidate limit.');
  store.db.exec("INSERT INTO section_search(section_search,rank) VALUES ('rank','bm25(0,0,0)')");
  const configured = searchKnowledge(store, { query: 'targetSymbol', repository: 'thunderbird', trace: true, maxChars: 24000, limit: 80 });
  assert.deepEqual(configured.trace.candidates.filter(candidate => candidate.exactRank).sort((a, b) => a.exactRank - b.exactRank).map(candidate => candidate.id), old,
    'A changed cache rank mapping should not alter the original bm25 contract.');
});

test('trace identifies context budgets, result limits and selected sections without changing retrieval', async t => {
  const store = await setup(t);
  const large = await store.put(evidence('needleSymbol\n'.repeat(300), { title: 'Large', paths: Array.from({ length: 80 }, (_, index) => `calendar/very-long-path-${index}.js`) }));
  const small = await store.put(evidence('needleSymbol short claim'));
  const events = [];
  const args = { query: 'needleSymbol', repository: 'thunderbird', maxChars: 2000 };
  const plain = searchKnowledge(store, args);
  const traced = searchKnowledge(store, { ...args, trace: true, onPhase: event => events.push(event) });
  assert.deepEqual(traced.ids, plain.ids, 'Tracing should preserve selected sources.');
  assert.equal(traced.text, plain.text, 'Tracing should preserve the context text.');
  assert.equal(plain.trace, undefined, 'Ordinary calls should omit trace data.');
  assert.equal(traced.trace.candidates.find(candidate => candidate.id === large.id).disposition, 'context-budget', 'An oversized source should report budget exclusion.');
  assert.equal(traced.trace.candidates.find(candidate => candidate.id === small.id).disposition, 'selected', 'A fitting source should report selection.');
  assert.ok(events.some(event => event.phase === 'exact' && event.state === 'finished'), 'Phase events should report exact-search completion.');
  const limited = searchKnowledge(store, { ...args, maxChars: 24000, limit: 1, trace: true });
  assert.ok(limited.trace.candidates.some(candidate => candidate.disposition === 'result-limit'), 'Sources after the selected limit should report that limit.');
  const scored = scoreRetrieval({ repository: 'thunderbird', evidence: [{ label: 'large', ids: [large.id] }] }, traced, store);
  assert.equal(scored.missing[0].diagnosis, 'context-budget', 'The evaluator should separate budget exclusion from missing evidence.');
});

test('trace distinguishes missing sources, scope exclusions and missing lesson dependencies', async t => {
  const store = await setup(t);
  const target = await store.put(evidence('scopedSymbol', { source: { language: 'JavaScript' } }));
  const missing = 'e'.repeat(64);
  const lesson = await store.put({ ...evidence('scopedSymbol missing dependency'), kind: 'lesson', status: 'provisional', component: 'calendar', evidence: [missing], quotes: [], supersedes: [] });
  const traced = searchKnowledge(store, { query: 'scopedSymbol', repository: 'thunderbird', trace: true });
  assert.equal(traced.trace.candidates.find(candidate => candidate.id === lesson.id).disposition, 'missing-lesson-evidence', 'A lesson without its dependency should report the missing evidence.');
  const scoped = searchKnowledge(store, { query: 'scopedSymbol', repository: 'thunderbird', filters: { language: 'Rust' }, trace: true });
  const scored = scoreRetrieval({ repository: 'thunderbird', evidence: [{ label: 'scope', ids: [target.id] }, { label: 'absent', ids: [missing] }] }, scoped, store);
  assert.equal(scored.missing[0].diagnosis, 'scope-filter', 'A source with the wrong explicit scope should report scope exclusion.');
  assert.equal(scored.missing[1].diagnosis, 'source-absent', 'An unavailable source should report absence.');
});

test('natural questions retain identifiers and quoted function words', async () => {
  const { retrievalTerms } = await import('../commands/knowledge/retrieval-terms.mjs');
  assert.deepEqual(retrievalTerms('Where is cal.iterate.forEach implemented, and can I await it?').words,
    ['cal', 'iterate', 'forEach', 'implemented', 'await'], 'Natural questions should omit function words and retain the named API.');
  assert.deepEqual(retrievalTerms('the and for').words, ['the', 'and', 'for'], 'A query of only function words should retain its search terms.');
  assert.deepEqual(retrievalTerms('Where is `for` in array.for and files/for.js?').words, ['for', 'array', 'files'],
    'Quoted words and names in dotted APIs and paths should remain searchable.');
  assert.deepEqual(retrievalTerms('When does When run?').words, ['When', 'run'], 'A capitalized identifier should remain searchable.');
});

test('legacy vectors preserve migration, scope and UTF-16 length rules', async t => {
  const store = await setup(t);
  const short = await store.put(evidence('legacyTarget', { source: { language: 'JavaScript' } }));
  const migrated = await store.put(evidence('migratedTarget'));
  const unicode = await store.put(evidence('😀'.repeat(700)));
  const long = await store.put(evidence('x'.repeat(1300)));
  const foreign = await store.put({ ...evidence('foreignTarget'), repository: 'tb-tools' });
  for (const record of [short, migrated, unicode, long, foreign]) store.db.prepare('INSERT INTO vectors VALUES (?, ?, ?)').run(record.id, 'test', '[1,0]');
  const section = store.db.prepare('SELECT id FROM sections WHERE record_id=?').get(migrated.id);
  store.db.prepare('INSERT INTO section_vectors VALUES (?, ?, ?)').run(section.id, 'test', '[0,1]');
  store.db.prepare('INSERT INTO sections VALUES (?, ?, ?)').run('null-parent', null, '{}');
  store.db.prepare('INSERT INTO section_vectors VALUES (?, ?, ?)').run('null-parent', 'test', '[1,0]');
  const result = searchKnowledge(store, { query: 'unrelated', repository: 'thunderbird', model: 'test', vector: [1, 0], trace: true });
  assert.deepEqual(result.ids, [short.id], 'Legacy scoring should omit migrated, long, foreign and UTF-16-over-limit records.');
  assert.ok(result.trace.timings['legacy-semantic'] >= 0, 'Tracing should measure the legacy semantic phase.');
  const scoped = searchKnowledge(store, { query: 'unrelated', repository: 'thunderbird', model: 'test', vector: [1, 0], filters: { language: 'Rust' }, trace: true });
  assert.deepEqual(scoped.ids, [], 'Legacy candidates should honor explicit scope before scoring.');
});

test('task transcripts remain searchable while checked source evidence ranks ahead', async t => {
  const store = await setup(t);
  const transcript = await store.put(evidence('originalEvidence target target target', { source: { type: 'agent-turn', personal: true } }));
  const original = await store.put(evidence('originalEvidence target', { source: { type: 'code-snapshot', verified: true } }));
  const result = searchKnowledge(store, { query: 'originalEvidence target', repository: 'thunderbird', trace: true, maxChars: 24000 });
  assert.equal(result.ids[0], original.id, 'Original source evidence should rank ahead of a task transcript.');
  assert.ok(result.ids.includes(transcript.id), 'A matching transcript should remain available.');
  assert.match(result.text, /check its original sources/, 'The transcript should retain its verification limit.');
});

test('legacy similarity orders and bounds candidates instead of assigning every hit the same score', async t => {
  const store = await setup(t);
  const records = [];
  for (let index = 0; index < 61; index++) {
    const record = await store.put(evidence(`legacyCase${index}`)); records.push(record);
    const similarity = 0.4 + index / 120;
    store.db.prepare('INSERT INTO vectors VALUES (?, ?, ?)').run(record.id, 'test', JSON.stringify([similarity, Math.sqrt(1 - similarity ** 2)]));
  }
  const result = searchKnowledge(store, { query: 'unrelated', repository: 'thunderbird', model: 'test', vector: [1, 0], trace: true, maxChars: 24000 });
  assert.equal(result.ids[0], records.at(-1).id, 'The highest legacy similarity should rank first.');
  assert.equal(result.trace.candidates.filter(candidate => candidate.legacyRank).length, 60, 'Legacy candidates should use the same bounded candidate count as section vectors.');
  assert.ok(!result.trace.candidates.some(candidate => candidate.id === records[0].id), 'The lowest similarity should fall outside the candidate limit.');
});

test('cached replacement decisions refresh when new immutable lessons arrive', async t => {
  const store = await setup(t);
  const source = await store.put(evidence('cacheRule original source'));
  const old = await store.put({ ...evidence('cacheRule older claim', { source: { revision: 'a'.repeat(40) }, paths: ['calendar/example.js'] }),
    kind: 'lesson', component: 'calendar', status: 'provisional', evidence: [source.id], quotes: [], supersedes: [] });
  const first = searchKnowledge(store, { query: 'cacheRule', repository: 'thunderbird', trace: true, maxChars: 24000 });
  assert.ok(first.ids.includes(old.id), 'The older lesson should remain before a checked replacement exists.');
  const repeated = searchKnowledge(store, { query: 'cacheRule', repository: 'thunderbird', trace: true, maxChars: 24000 });
  assert.equal(repeated.trace.timings.supersession, undefined, 'An unchanged record set should reuse replacement decisions.');
  const newer = await store.put({ ...evidence('cacheRule checked replacement', { source: { revision: 'b'.repeat(40) }, paths: ['calendar/example.js'] }),
    kind: 'lesson', component: 'calendar', status: 'supported', evidence: [source.id], quotes: [], supersedes: [old.id] });
  const updated = searchKnowledge(store, { query: 'cacheRule', repository: 'thunderbird', trace: true, maxChars: 24000 });
  assert.ok(updated.ids.includes(newer.id), 'The checked replacement should be selected.');
  assert.ok(!updated.ids.includes(old.id), 'New immutable evidence should refresh the cached retirement decision.');
  const historical = searchKnowledge(store, { query: 'cacheRule ' + 'a'.repeat(40), repository: 'thunderbird', trace: true, maxChars: 24000 });
  assert.ok(historical.ids.includes(old.id), 'An explicit historical revision should still expose its retired lesson.');
});

test('semantic snapshots record vector changes independently of immutable source IDs', async t => {
  const store = await setup(t);
  const { vectorSnapshot } = await import('../commands/knowledge/evaluation-vectors.mjs');
  const record = await store.put(evidence('vectorSnapshotTarget'));
  store.db.prepare('INSERT INTO vectors VALUES (?, ?, ?)').run(record.id, 'test', '[1,0]');
  const before = vectorSnapshot(store.db, 'test');
  store.db.prepare('UPDATE vectors SET vector=? WHERE id=? AND model=?').run('[0,1]', record.id, 'test');
  const after = vectorSnapshot(store.db, 'test');
  assert.notEqual(before.digest, after.digest, 'Changed vectors should change the semantic snapshot even when source IDs stay fixed.');
  assert.equal(after.rows, 1, 'The vector snapshot should retain its row count.');
});

test('old orphan vectors cannot count as usable semantic coverage', async t => {
  const store = await setup(t);
  const { readVectorCoverage, vectorCoverageLabel } = await import('../commands/knowledge/evaluation-vectors.mjs');
  await store.put(evidence('coverageTarget'));
  store.db.prepare('INSERT INTO section_vectors VALUES (?, ?, ?)').run('orphan', 'test', '[1,0]');
  store.db.prepare('INSERT INTO vectors VALUES (?, ?, ?)').run('missing-record', 'test', '[1,0]');
  const absent = readVectorCoverage(store.db, 'test');
  assert.equal(absent.vectors, 0, 'An old vector without a current section should not count as usable coverage.');
  assert.equal(absent.orphanSectionVectors, 1, 'The report should retain the orphan section-vector count.');
  assert.equal(vectorCoverageLabel(absent), 'none', 'Only orphan vectors should report no usable semantic coverage.');
  const section = store.db.prepare('SELECT id FROM sections LIMIT 1').get();
  store.db.prepare('INSERT INTO section_vectors VALUES (?, ?, ?)').run(section.id, 'test', '[1,0]');
  assert.equal(vectorCoverageLabel(readVectorCoverage(store.db, 'test')), 'complete-section-vectors', 'A matching vector for every current section should report complete coverage.');
});
