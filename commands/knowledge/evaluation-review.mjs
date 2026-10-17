import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest } from './store.mjs';
import { validateSuite, validateAnswerReview, checkAnswer } from './evaluation.mjs';
import { verifySuiteAnchors } from './evaluation-verification.mjs';
import { readReviewSources, reviewAssistantAnswer } from './evaluation-source-review.mjs';

export function applySavedReviews(suite, report, reviews) {
  const cases = new Map(suite.cases.map(item => [item.id, item]));
  const answers = new Map(report.cases.map(row => [row.id, row]));
  for (const [id, review] of Object.entries(reviews)) {
    if (!cases.has(id) || !answers.has(id)) throw new Error(`Unknown answer review: ${id}`);
    if (!['human', 'assistant'].includes(review.reviewerKind)) throw new Error('Use reviewerKind human or assistant.');
  }
  const updated = report.cases.map(row => {
    const review = reviews[row.id];
    if (!review) return row;
    if (typeof row.answer !== 'string' || review.answerDigest !== digest(row.answer)) throw new Error(`Review for ${row.id} refers to another answer.`);
    const answerReview = validateAnswerReview(cases.get(row.id), review);
    answerReview.mechanicalChecks = checkAnswer(cases.get(row.id), row.answer, row.ids || [], row.context || '');
    if (answerReview.mechanicalChecks.missingCitation || answerReview.mechanicalChecks.unknownCitations.length) answerReview.pass = false;
    return { ...row, answerReview, ...(review.reviewerKind === 'human' ? { humanReview: answerReview } : {}) };
  });
  return { ...report, cases: updated, reviewedAt: new Date().toISOString(),
    answerQuality: updated.filter(row => typeof row.answer === 'string').every(row => row.answerReview || row.humanReview) ? 'source-reviewed; reviewer kind and evidence recorded' : 'partly source-reviewed',
    summary: { ...report.summary, answerReviewed: updated.filter(row => row.answerReview || row.humanReview).length,
      answerPassed: updated.filter(row => (row.answerReview || row.humanReview)?.pass).length,
      reviewsByKind: Object.fromEntries(['assistant', 'human'].map(kind => [kind, updated.filter(row => (row.answerReview || row.humanReview)?.reviewerKind === kind).length])) } };
}

export async function runSavedReview(argv) {
  const { values } = parseArgs({ args: argv, options: {
    suite: { type: 'string', default: fileURLToPath(new URL('../../test/fixtures/knowledge-evaluation/questions.json', import.meta.url)) },
    report: { type: 'string' }, reviews: { type: 'string' }, output: { type: 'string' }, provider: { type: 'string' },
    'repository-directory': { type: 'string' }, 'source-directory': { type: 'string' },
  } });
  if (!values.report || !values.output || Boolean(values.reviews) === Boolean(values.provider)) throw new Error('Specify a report, new output file, and either reviews or a provider.');
  if (path.resolve(values.report) === path.resolve(values.output)) throw new Error('Preserve the original report; use another output file.');
  const raw = await readFile(values.suite, 'utf8');
  const suite = validateSuite(JSON.parse(raw)), report = JSON.parse(await readFile(values.report, 'utf8'));
  if (report.suiteDigest !== digest(raw)) throw new Error('The review question set differs from the generated-answer run.');
  let reviews;
  if (values.reviews) reviews = JSON.parse(await readFile(values.reviews, 'utf8'));
  else {
    const roots = { knowledge: values['repository-directory'], thunderbird: values['source-directory'], 'tb-tools': fileURLToPath(new URL('../../', import.meta.url)) };
    const verification = verifySuiteAnchors(suite, roots);
    if (verification.errors.length) throw new Error(`Review source anchors failed verification: ${JSON.stringify(verification.errors)}`);
    const provider = await import(pathToFileURL(path.resolve(values.provider)).href);
    if (typeof provider.generate !== 'function' || !provider.configuration) throw new Error('Review provider must export generate and configuration.');
    reviews = {};
    for (const row of report.cases) {
      if (typeof row.answer !== 'string') continue;
      const item = suite.cases.find(item => item.id === row.id);
      reviews[row.id] = await reviewAssistantAnswer(provider, item, row.answer, row.context, readReviewSources(item, roots));
      console.error(`${row.id}: assistant review ${reviews[row.id].pass ? 'pass' : 'fail'}.`);
    }
  }
  const result = applySavedReviews(suite, report, reviews);
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true, mode: 0o700 });
  await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: values.output, reviewed: result.summary.answerReviewed, passed: result.summary.answerPassed }));
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSavedReview(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
