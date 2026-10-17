import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKnowledgeService } from '../commands/knowledge/service.mjs';
import { indexKnowledgeSections } from '../commands/knowledge/semantic-index.mjs';

async function fixture(t, stall = false, malformed = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tb-section-index-command-'));
  const embeddings = { ready: true, model: 'test-model', async embed(texts) { return stall ? null : texts.map(() => malformed ? [] : [1, 0]); }, async close() {} };
  const service = await createKnowledgeService({ directory, semantic: true, importLegacy: false }, { embeddings });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return service;
}

test('section indexing reports partial batches and completes every section rather than every record', async t => {
  const service = await fixture(t);
  await service.store.put({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-13T00:00:00Z', source: {}, text: 'A source line with several words.\n'.repeat(2000) });
  const count = service.store.db.prepare('SELECT count(*) AS count FROM sections').get().count;
  assert.ok(count > 32, 'One large record should create more than one embedding batch.');
  const progress = [];
  const partial = await indexKnowledgeSections(service, { maxBatches: 1, onProgress: value => progress.push(value) });
  assert.equal(partial.status, 'partial', 'A bounded run should report partial coverage.');
  assert.equal(partial.remaining, count - 32, 'Remaining coverage should count sections rather than records.');
  assert.equal(progress.length, 1, 'The batch should report its progress.');
  const complete = await indexKnowledgeSections(service);
  assert.equal(complete.status, 'complete', 'An unbounded run should complete all remaining sections.');
  assert.equal(complete.sectionVectors[0].count, count, 'The final vector count should cover every section.');
  assert.deepEqual(complete.legacyVectors, [], 'Section indexing should not claim to create old record vectors.');
  const repeated = await indexKnowledgeSections(service);
  assert.equal(repeated.batches, 0, 'An already complete index should perform no extra batches.');
});

test('failed embedding batches do not claim complete semantic coverage', async t => {
  const service = await fixture(t, true);
  await service.store.put({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-13T00:00:00Z', source: {}, text: 'A source without vectors.' });
  await assert.rejects(indexKnowledgeSections(service), /made no progress/, 'A stalled model should report the remaining evidence gap.');
  await assert.rejects(indexKnowledgeSections(service, { maxBatches: 0 }), /positive/, 'An invalid batch limit should fail clearly.');
});

test('empty embeddings cannot count as indexed source evidence', async t => {
  const service = await fixture(t, false, true);
  await service.store.put({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-13T00:00:00Z', source: {}, text: 'A source with an invalid vector result.' });
  await assert.rejects(indexKnowledgeSections(service), /Invalid local embedding/, 'An empty embedding should fail before coverage is recorded.');
  assert.equal(service.store.db.prepare('SELECT count(*) AS count FROM section_vectors').get().count, 0, 'An invalid vector should not be saved as indexed evidence.');
});

test('a source arriving at the end of a batch prevents false completion', async t => {
  const service = await fixture(t);
  await service.store.put({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-13T00:00:00Z', source: {}, text: 'First source.' });
  const original = service.indexSemantic.bind(service);
  let added = false;
  service.indexSemantic = async () => {
    const count = await original();
    if (!added) { added = true; await service.store.put({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-13T00:00:00Z', source: {}, text: 'Source arriving during indexing.' }); }
    return count;
  };
  const bounded = await indexKnowledgeSections(service, { maxBatches: 1 });
  assert.equal(bounded.status, 'partial', 'A new source should keep bounded coverage partial.');
  assert.equal(bounded.remaining, 1, 'Final coverage should include the new source.');
  const complete = await indexKnowledgeSections(service);
  assert.equal(complete.status, 'complete', 'The remaining source should be indexed on the next run.');
});
