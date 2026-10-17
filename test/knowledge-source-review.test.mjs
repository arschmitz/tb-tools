import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceReviewRequest, reviewAssistantAnswer } from '../commands/knowledge/evaluation-source-review.mjs';
import { validateAnswerReview } from '../commands/knowledge/evaluation.mjs';
import { applySavedReviews } from '../commands/knowledge/evaluation-review.mjs';

const id = 'a'.repeat(64);
const item = { question: 'When does it finish?', id: 'finish', repository: 'thunderbird', filters: {},
  facts: ['Completion uses a callback.'], prohibited: ['Returns a promise.'], limits: 'Synthetic source test only.' };
const sources = [{ repository: 'thunderbird', revision: 'b'.repeat(40), path: 'calendar/example.js', text: 'completed();', truncated: false }];
const context = JSON.stringify({ id, text: 'completed();' });
const verdict = () => ({ rationale: 'Checked completion in the original source and saved answer.',
  scores: { correctness: 2, completeness: 2, citationSupport: 2, scope: 2, uncertainty: 2 },
  facts: [{ index: 0, verdict: 'supported', reason: 'The source calls the completion callback.' }],
  prohibitedClaims: [{ index: 0, verdict: 'absent', reason: 'The answer does not claim a promise.' }],
  sourceChecks: [{ sourceIndex: 0, quote: 'completed();', reason: 'This invokes completion.' }] });
const provider = generate => ({ configuration: { provider: 'synthetic-test', model: 'stub' }, generate });

test('automatic source reviews check exact answers, facts, prohibited claims and source excerpts', async () => {
  const request = sourceReviewRequest(item, 'saved answer', context, sources);
  assert.equal(JSON.parse(request.context).savedAnswer, 'saved answer', 'Review should use the saved answer without generating another answer.');
  assert.match(request.system, /remains correct even when the reviewer has additional evidence/, 'Honest evidence limits should remain correct when the reviewer sees extra source text.');
  const review = await reviewAssistantAnswer(provider(async () => JSON.stringify(verdict())), item, `Uses the completion callback ${id}`, context, sources);
  assert.equal(review.pass, true, 'A fully supported answer should pass assistant source review.');
  assert.equal(review.assurance, 'assistant-source-review', 'The result should state that an assistant checked the sources.');
  assert.throws(() => validateAnswerReview(item, { ...review, sourceChecks: [{ sourceIndex: 0, quote: 'invented();', reason: 'Wrong quote.' }] }), /excerpts/, 'A saved review should reject a fabricated source quote.');
  await assert.rejects(reviewAssistantAnswer(provider(async () => JSON.stringify({ ...verdict(), sourceChecks: [{ sourceIndex: 0, quote: 'invented();', reason: 'Wrong quote.' }] })), item, id, context, sources), /differs/, 'An automatic review should reject an invented source quote.');
});

test('missing facts and prohibited claims cannot pass through a high model score', async () => {
  const missing = verdict(); missing.facts[0].verdict = 'missing';
  const review = await reviewAssistantAnswer(provider(async () => JSON.stringify(missing)), item, id, context, sources);
  assert.equal(review.pass, false, 'A missing required fact should fail even when the model assigns full scores.');
  const prohibited = verdict(); prohibited.prohibitedClaims[0].verdict = 'present';
  assert.equal((await reviewAssistantAnswer(provider(async () => JSON.stringify(prohibited)), item, id, context, sources)).pass, false, 'A prohibited claim should prevent a pass.');
  const uncited = await reviewAssistantAnswer(provider(async () => JSON.stringify(verdict())), item, 'Uses a callback.', context, sources);
  assert.equal(uncited.pass, false, 'An uncited answer should not pass on model scores alone.');
  const saved = applySavedReviews({ cases: [item] }, { cases: [{ id: item.id, answer: 'Uses a callback.', context }], summary: {} }, { [item.id]: uncited });
  assert.equal(saved.summary.answerPassed, 0, 'Attaching a saved review should preserve the citation failure instead of trusting its model scores.');
  assert.equal(saved.summary.reviewsByKind.assistant, 1, 'The saved source review should count as assistant review.');
  await assert.rejects(reviewAssistantAnswer(provider(async () => JSON.stringify({ ...verdict(), prohibitedClaims: [] })), item, id, context, sources), /prohibited/, 'The reviewer should check every prohibited claim.');
});
