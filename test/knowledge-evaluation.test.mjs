import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSuite, scoreRetrieval, checkAnswer, answerRequest, validateHumanReview, scoreReturnedAnchors } from '../commands/knowledge/evaluation.mjs';
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const records = [
  { id: a, repository: 'thunderbird', kind: 'evidence', paths: [], source: { type: 'code-snapshot' }, text: 'first', at: '2026-01-01' },
  { id: b, repository: 'thunderbird', kind: 'evidence', paths: [], source: { type: 'shared-note', portableCopies: [a] }, text: 'copy', at: '2026-01-02' },
  { id: c, repository: 'tb-tools', kind: 'evidence', paths: [], source: {}, text: 'other', at: '2026-01-01' },
];
const store = { all: () => records, get: id => records.find(record => record.id === id) };
const item = { repository: 'thunderbird', evidence: [{ label: 'first', ids: [a] }, { label: 'missing', ids: ['d'.repeat(64)] }], facts: ['Completion uses a callback.'], prohibited: ['Returns a promise.'], limits: 'Pinned source only.' };
test('retrieval separates copies, missing evidence, rank and repository scope', () => {
  const score = scoreRetrieval(item, { ids: [c, b, a], text: 'context' }, store);
  assert.equal(score.recall, 0.5, 'Recall should count one independent requirement.');
  assert.equal(score.reciprocalRank, 0.5, 'The first relevant claim should rank second.');
  assert.equal(score.duplicateClaims, 1, 'Portable copies should count once.');
  assert.deepEqual(score.scopeErrors, [c], 'Another repository should be a scope error.');
  assert.equal(score.missing[0].available, false, 'An absent source should be an availability gap.');
});
test('empty and budget-excluded results retain expectations', () => {
  const score = scoreRetrieval(item, { ids: [], text: '' }, store);
  assert.equal(score.recall, 0, 'Empty context should have zero recall.');
  assert.equal(score.missing.length, 2, 'All source requirements should remain missing.');
  assert.equal(score.missing[0].available, true, 'Budget exclusion should differ from absent evidence.');
});
test('answers require semantic review and do not expose answer keys to generation', () => {
  const request = answerRequest({ ...item, question: 'When does it finish?', scope: 'Calendar', id: 'finish' }, 'context');
  assert.equal(request.facts, undefined, 'The generation request should omit expected facts.');
  const checks = checkAnswer(item, `It returns a promise ${a} ${c}`, [a]);
  assert.deepEqual(checks.unknownCitations, [c], 'Unknown citations should be reported.');
  assert.equal(checks.status, 'needs-source-review', 'A citation should not establish answer correctness.');
});
test('human reviews require complete fact checks and scores', () => {
  assert.throws(() => validateHumanReview(item, {}), /reviewer/, 'Incomplete reviews should fail.');
  const review = validateHumanReview(item, { reviewerKind: 'human', reviewer: 'Reviewer', rationale: 'Checked pinned implementation.', scores: { correctness: 2, completeness: 2, citationSupport: 2, scope: 2, uncertainty: 2 }, facts: [{ index: 0, verdict: 'supported', reason: 'The completed callback resolves.' }] });
  assert.equal(review.pass, true, 'A complete checked review should pass.');
});
test('initial cases keep explicit evidence, facts, limits and portable anchors', async () => {
  const suite = validateSuite(JSON.parse(await readFile(new URL('./fixtures/knowledge-evaluation/questions.json', import.meta.url), 'utf8')));
  assert.equal(suite.cases.length, 29, 'The initial suite should contain 29 checked questions.');
  assert.ok(suite.cases.some(item => item.intent === 'insufficient'), 'The suite should test insufficient evidence.');
  assert.ok(suite.cases.some(item => item.repository === 'tb-tools'), 'The suite should test repository distinctions.');
});

test('evaluation data is rejected before knowledge indexing and learning', async () => {
  const { validateRecord, digest } = await import('../commands/knowledge/store.mjs');
  const body = { version: 1, kind: 'evidence', visibility: 'private', repository: 'tb-tools', at: '2026-10-13T00:00:00Z', source: { type: 'code-snapshot' }, paths: ['test/fixtures/knowledge-evaluation/questions.json'], text: 'Expected answer data.' };
  assert.throws(() => validateRecord({ ...body, id: digest(body) }), /Evaluation data/, 'Benchmark fixtures should be rejected as learned evidence.');
});

test('original contract requirements exclude navigation maps and stale revisions', () => {
  const anchor = { revision: '1'.repeat(40), path: 'calendar/example.mjs', contains: ['completed();'] };
  const original = { ...records[0], source: { type: 'code-snapshot', revision: anchor.revision }, paths: [anchor.path], text: 'completed();' };
  const map = { ...original, id: b, source: { ...original.source, type: 'source-map' } };
  const localStore = { all: () => [map, original], get: id => [map, original].find(record => record.id === id) };
  const question = { ...item, evidence: [{ label: 'contract', ids: [], anchors: [anchor] }] };
  assert.equal(scoreRetrieval(question, { ids: [b], text: 'completed();' }, localStore).recall, 0, 'A navigation map should not establish the implementation contract.');
  assert.equal(scoreRetrieval(question, { ids: [a], text: 'completed();' }, localStore).recall, 1, 'The pinned original snapshot should satisfy the contract source.');
});

test('runner uses a consistent index snapshot and a configured answer adapter', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { openKnowledgeStore } = await import('../commands/knowledge/store.mjs');
  const { parseKnowledgeNote } = await import('../commands/knowledge/repository.mjs');
  const { runEvaluation } = await import('../commands/knowledge/evaluation-cli.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-runner-test-'));
  try {
    const checkout = path.join(directory, 'checkout');
    await mkdir(path.join(checkout, 'notes'), { recursive: true });
    const note = '<!-- knowledge: {"repository":"thunderbird","at":"2026-10-13T00:00:00Z","paths":["calendar/example.mjs"],"source":{"reference":"synthetic-test-only"}} -->\n# Completion callback\nThe iterator reports completion through a callback.\n';
    await writeFile(path.join(checkout, 'notes/test.md'), note);
    const git = args => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
    git(['init', '-q']); git(['add', 'notes/test.md']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Synthetic evaluation input']);
    const record = parseKnowledgeNote(note);
    const input = await openKnowledgeStore(path.join(directory, 'input'));
    await input.put(record); input.close();
    const question = { id: 'callback', question: 'How does the iterator report completion?', intent: 'async-contract', repository: 'thunderbird', scope: 'calendar/example.mjs', evidence: [{ label: 'callback', ids: [record.id] }], facts: ['Reports completion through a callback.'], prohibited: ['Returns a promise.'], limits: 'Synthetic evaluator test only.', anchors: [{ repository: 'knowledge', revision: git(['rev-parse', 'HEAD']), path: 'notes/test.md', id: record.id }] };
    const suiteFile = path.join(directory, 'suite.json');
    await writeFile(suiteFile, JSON.stringify({ version: 1, cases: [question] }));
    const provider = path.join(directory, 'provider.mjs');
    await writeFile(provider, `export const configuration = { provider: 'test', model: 'stub' }; export async function generate(request) { if (request.facts || request.prohibited) throw new Error('Answer key leaked'); if (request.system.startsWith('Review')) return JSON.stringify({rationale:'Checked the original callback source.',scores:{correctness:2,completeness:2,citationSupport:2,scope:2,uncertainty:2},facts:[{index:0,verdict:'supported',reason:'The source and answer state completion through a callback.'}],prohibitedClaims:[{index:0,verdict:'absent',reason:'The answer does not claim a promise.'}],sourceChecks:[{sourceIndex:0,quote:'The iterator reports completion through a callback.',reason:'The source states the callback contract.'}]}); return 'Completion uses a callback ${record.id}'; }`);
    const report = await runEvaluation(['--suite', suiteFile, '--repository-directory', checkout, '--index-source', path.join(directory, 'input/index.sqlite'), '--provider', provider, '--output', path.join(directory, 'result.json')]);
    assert.equal(report.summary.complete, 1, 'The real search pipeline should retrieve the synthetic evidence.');
    assert.equal(report.cases[0].answerReview.assurance, 'assistant-source-review', 'Generated answers should receive automatic source review.');
    assert.equal(report.summary.answerPassed, 1, 'The source-supported synthetic answer should pass its review.');
    assert.equal(report.semantic.status, 'not-requested', 'Exact mode should not substitute a semantic model.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saved human reviews bind to original answers without another generation', async () => {
  const { applySavedReviews } = await import('../commands/knowledge/evaluation-review.mjs');
  const { digest } = await import('../commands/knowledge/store.mjs');
  const question = { ...item, id: 'saved' }, answer = 'Completion uses a callback.';
  const report = { cases: [{ id: 'saved', answer }], summary: { answerReviewed: 0 } };
  const review = { reviewerKind: 'human', reviewer: 'Test reviewer', rationale: 'Synthetic review test.', answerDigest: digest(answer),
    scores: { correctness: 2, completeness: 2, citationSupport: 2, scope: 2, uncertainty: 2 },
    facts: [{ index: 0, verdict: 'supported', reason: 'The synthetic source states completion uses a callback.' }] };
  const updated = applySavedReviews({ cases: [question] }, report, { saved: review });
  assert.equal(updated.summary.answerReviewed, 1, 'The saved answer should accept its bound human review.');
  assert.equal(updated.cases[0].answer, answer, 'Review should preserve the original answer.');
  assert.equal(report.cases[0].humanReview, undefined, 'Review should leave the original report unchanged.');
  assert.throws(() => applySavedReviews({ cases: [question] }, report, { saved: { ...review, answerDigest: digest('another answer') } }), /another answer/,
    'A review for another answer should fail.');
  assert.throws(() => applySavedReviews({ cases: [question] }, report, { saved: { ...review, reviewerKind: 'model' } }), /reviewerKind human or assistant/,
    'A model audit should not be counted as human approval.');
});

test('mechanical citation checks recognize quoted section IDs and separate unquoted dependencies', () => {
  const section = 'f'.repeat(64);
  const context = JSON.stringify({ id: a, section: { id: section }, aliases: [b], evidence: [c] });
  const checks = checkAnswer(item, `${a} ${section} ${b} ${c}`, [a], context);
  assert.deepEqual(checks.unknownCitations, [], 'Quoted section IDs and declared source references should be recognized.');
  assert.deepEqual(checks.referenceOnlyCitations, [c], 'A dependency without quoted source text should require a support check.');
  assert.equal(checks.status, 'needs-source-review', 'Recognized identifiers should not establish citation support.');
});

test('copied fixture payloads and directory captures stay outside evidence', async () => {
  const { isEvaluationData } = await import('../commands/knowledge/evaluation-policy.mjs');
  const payload = { publication: 'Expected answers are evaluation data, never evidence.', cases: [{ question: 'Synthetic benchmark question.' }] };
  assert.ok(isEvaluationData({ paths: [], text: JSON.stringify(payload) }), 'A copied fixture with no file path should remain evaluation data.');
  assert.ok(isEvaluationData({ paths: [], text: JSON.stringify({ captured: JSON.stringify(payload) }) }), 'A serialized fixture capture should remain evaluation data.');
  assert.ok(isEvaluationData({ paths: ['test/fixtures/knowledge-evaluation'], text: 'directory capture' }), 'The benchmark directory itself should be excluded.');
  assert.equal(isEvaluationData({ paths: ['commands/knowledge/evaluation.mjs'], text: 'Evaluate retrieval with separate source and answer scores.' }), false,
    'Ordinary evaluation implementation should remain eligible code evidence.');
});

test('answer generation does not receive lookup paths from the expected scope', () => {
  const request = answerRequest({ ...item, id: 'lookup', question: 'Where is it implemented?', scope: 'calendar/expected-answer-file.mjs', filters: { role: 'production' } }, 'quoted context');
  assert.ok(!JSON.stringify(request).includes('expected-answer-file'), 'Expected lookup paths should remain outside the model prompt.');
  assert.match(request.scope, /production/, 'Explicit caller filters should remain in the model scope.');
});


async function anchorFixture(t, text) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { openKnowledgeStore } = await import('../commands/knowledge/store.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'returned-anchor-'));
  let memory;
  t.after(async () => { memory?.close(); await rm(directory, { recursive: true, force: true }); });
  memory = await openKnowledgeStore(directory);
  const record = await memory.put({ kind: 'evidence', repository: 'thunderbird', at: '2026-10-13T10:00:00Z',
    paths: ['calendar/contracts.js'], text, source: { type: 'code-snapshot', revision: 'a'.repeat(40), fileRole: 'production' } });
  return { memory, record };
}
const anchoredQuestion = (record, contains) => ({ repository: record.repository, filters: {},
  evidence: [{ label: 'checked source', ids: [record.id], anchors: [{ repository: record.repository,
    revision: record.source.revision, path: record.paths[0], contains }] }] });
const returnedRanges = (record, ranges) => ({ ids: [record.id], text: ranges.map(([start, end]) => JSON.stringify({
  id: record.id, section: { recordId: record.id, start, end }, text: record.text.slice(start, end),
})).join('\n') });

test('returned anchors distinguish parent recall from complete selected source excerpts', async t => {
  const first = 'saveOperation calls commitChanges after validation.';
  const second = 'readOnly calendars reject changes before writing.';
  const { memory, record } = await anchorFixture(t, `# Save\n${first}\n${'Background detail.\n'.repeat(70)}\n## Exception\n${second}\n`);
  const { searchKnowledge } = await import('../commands/knowledge/store.mjs');
  const question = anchoredQuestion(record, [first, second]);
  const args = { query: 'saveOperation readOnly', repository: record.repository, maxChars: 12000 };
  const partial = scoreRetrieval(question, searchKnowledge(memory, { ...args, maxSectionsPerClaim: 1 }), memory);
  assert.equal(partial.recall, 1, 'The parent source should remain a successful source-recall match.');
  assert.equal(partial.returnedAnchorRecall, 0, 'One selected section should not satisfy both checked source excerpts.');
  assert.equal(partial.returnedAnchorsComplete, false, 'The source-recall metric should not hide missing returned evidence.');
  const complete = scoreRetrieval(question, searchKnowledge(memory, args), memory);
  assert.equal(complete.returnedAnchorRecall, 1, 'Distinct returned sections from one source should cover both checked quotes.');
  assert.equal(complete.duplicateClaims, 0, 'Extra sections should not count as duplicate claims.');
});

test('adjacent source ranges support boundary quotes while missing ranges cannot be joined', async t => {
  const { memory, record } = await anchorFixture(t, 'left-side|middle-hidden|right-side');
  const question = anchoredQuestion(record, ['side|middle']);
  const adjacent = returnedRanges(record, [[0, 10], [10, 22]]);
  assert.equal(scoreReturnedAnchors(question, adjacent, memory).returnedAnchorsComplete, true,
    'Adjacent exact source ranges should support a quote across their shared boundary.');
  const separated = returnedRanges(record, [[0, 10], [23, record.text.length]]);
  assert.equal(scoreReturnedAnchors(question, separated, memory).returnedAnchorsComplete, false,
    'A missing source range should prevent a boundary quote from passing.');
  const fabricated = anchoredQuestion(record, ['left-side|right-side']);
  assert.equal(scoreReturnedAnchors(fabricated, separated, memory).returnedAnchorsComplete, false,
    'Disjoint excerpts should not create a quote absent from the original source.');
});

test('one anchor cannot combine required quotes from different physical sources', async t => {
  const { memory, record } = await anchorFixture(t, 'First source supplies its contract.');
  const second = await memory.put({ kind: 'evidence', repository: record.repository, at: record.at,
    paths: record.paths, text: 'Second source supplies an exception.', source: record.source });
  const result = { ids: [record.id, second.id], text: `${returnedRanges(record, [[0, record.text.length]]).text}\n${returnedRanges(second, [[0, second.text.length]]).text}` };
  const question = anchoredQuestion(record, [record.text, second.text]);
  assert.equal(scoreReturnedAnchors(question, result, memory).returnedAnchorsComplete, false,
    'Matching path and revision should not permit quotes to be combined across physical records.');
});

test('forged excerpts and unselected or wrong-scope sources cannot satisfy anchors', async t => {
  const { memory, record } = await anchorFixture(t, 'The operation rejects a read-only calendar.');
  const question = anchoredQuestion(record, [record.text]);
  const valid = returnedRanges(record, [[0, record.text.length]]);
  assert.equal(scoreReturnedAnchors(question, valid, memory).returnedAnchorsComplete, true,
    'An exact selected source range should satisfy its quote.');
  const entry = JSON.parse(valid.text);
  for (const altered of [
    { ...entry, text: 'Invented replacement text.' },
    { ...entry, section: { ...entry.section, start: -1 } },
    { ...entry, section: { ...entry.section, end: record.text.length + 1 } },
    { ...entry, section: { ...entry.section, start: 0.5 } },
  ]) {
    assert.equal(scoreReturnedAnchors(question, { ...valid, text: JSON.stringify(altered) }, memory).returnedAnchorsComplete, false,
      'Changed text or invalid source offsets should fail exact excerpt verification.');
  }
  assert.equal(scoreReturnedAnchors(question, { ...valid, ids: [] }, memory).returnedAnchorsComplete, false,
    'An excerpt outside the selected source IDs should not receive credit.');
  const unrelated = await memory.put({ kind: 'evidence', repository: record.repository, at: record.at,
    paths: record.paths, source: record.source, text: 'A different claim describes an unrelated operation.' });
  assert.equal(scoreReturnedAnchors(question, { ids: [unrelated.id], text: JSON.stringify({ ...entry, id: unrelated.id }) }, memory).returnedAnchorsComplete, false,
    'An unrelated selected claim should not borrow a real physical section from another claim.');
  assert.equal(scoreReturnedAnchors({ ...question, filters: { role: 'test' } }, valid, memory).returnedAnchorsComplete, false,
    'The selected physical source should obey explicit file-role scope.');
  const stale = { ...question, evidence: [{ ...question.evidence[0], anchors: [{ ...question.evidence[0].anchors[0], revision: 'b'.repeat(40) }] }] };
  assert.equal(scoreReturnedAnchors(stale, valid, memory).returnedAnchorsComplete, false,
    'The selected source revision should match its checked anchor.');
});

test('source-ID-only expectations remain unmeasured for excerpt coverage', () => {
  const result = scoreReturnedAnchors(item, { ids: [a], text: JSON.stringify({ id: a, text: records[0].text }) }, store);
  assert.equal(result.anchoredRequirements, 0, 'Source-ID-only cases should have no measured excerpt requirements.');
  assert.equal(result.returnedAnchorRecall, null, 'Unmeasured excerpt recall should remain null.');
  assert.equal(result.returnedAnchorsComplete, null, 'Unmeasured excerpt completeness should remain null.');
});

test('citations recognize a selected physical source behind a canonical claim', () => {
  const context = JSON.stringify({ id: b, section: { id: 'f'.repeat(64), recordId: a }, text: 'Original source excerpt.' });
  const checks = checkAnswer(item, a, [b], context);
  assert.deepEqual(checks.unknownCitations, [], 'A selected physical source citation should remain recognized through its canonical claim.');
});
