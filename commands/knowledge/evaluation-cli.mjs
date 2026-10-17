import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openKnowledgeStore, searchKnowledge, digest, validateRecord } from './store.mjs';
import { readKnowledgeRepository, parseKnowledgeNote } from './repository.mjs';
import { createLocalEmbeddings } from './embeddings.mjs';
import { openEvaluationIndex } from './evaluation-index.mjs';
import { vectorSnapshot, readVectorCoverage, vectorCoverageLabel } from './evaluation-vectors.mjs';
import { readReviewSources, reviewAssistantAnswer } from './evaluation-source-review.mjs';
import { verifySuiteAnchors } from './evaluation-verification.mjs';
import { validateSuite, scoreRetrieval, answerRequest, checkAnswer, validateAnswerReview } from './evaluation.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20_000_000 }).trim();
const root = fileURLToPath(new URL('../../', import.meta.url));
async function codeFingerprint() {
  const files = (await readdir(path.join(root, 'commands/knowledge'))).filter(name => name.endsWith('.mjs')).sort();
  return Object.fromEntries(await Promise.all(files.map(async name => [name, digest(await readFile(path.join(root, 'commands/knowledge', name), 'utf8'))])));
}
export async function runEvaluation(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'compare-transcripts': { type: 'boolean', default: false }, 'compare-terms': { type: 'boolean', default: false }, corpus: { type: 'string' }, 'index-source': { type: 'string' }, cache: { type: 'string' }, 'source-directory': { type: 'string' },
    suite: { type: 'string', default: path.join(root, 'test/fixtures/knowledge-evaluation/questions.json') },
    'repository-directory': { type: 'string' }, output: { type: 'string' },
    'top-k': { type: 'string', default: '10' }, 'max-chars': { type: 'string', default: '10000' },
    mode: { type: 'string', default: 'exact' }, provider: { type: 'string' }, reviews: { type: 'string' },
    'model-cache': { type: 'string' }, 'model-timeout': { type: 'string', default: '30000' },
  } });
  if (!values['repository-directory'] || !values.output) throw new Error('Specify --repository-directory and --output outside the knowledge checkout.');
  const repositoryDirectory = path.resolve(values['repository-directory']);
  const output = path.resolve(values.output);
  if (output === repositoryDirectory || output.startsWith(repositoryDirectory + path.sep)) throw new Error('Results must stay outside the knowledge checkout.');
  const limit = Number(values['top-k']), maxChars = Number(values['max-chars']);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 24000) throw new Error('Use positive top-k and max-chars from 1 to 24000.');
  if (values['compare-terms'] && values['compare-transcripts']) throw new Error('Compare one retrieval policy at a time.');
  if (!['exact', 'hybrid'].includes(values.mode)) throw new Error('Use exact or hybrid. Hybrid uses the real combined search pipeline.');
  const raw = await readFile(values.suite, 'utf8'), suite = validateSuite(JSON.parse(raw));
  const code = { revision: git(root, ['rev-parse', 'HEAD']), dirty: git(root, ['status', '--porcelain']), files: await codeFingerprint() };
  const directory = values.cache ? path.resolve(values.cache) : await mkdtemp(path.join(os.tmpdir(), 'tb-knowledge-evaluation-'));
  if (directory === repositoryDirectory || directory.startsWith(repositoryDirectory + path.sep)) throw new Error('Cache must stay outside the knowledge checkout.');
  await mkdir(directory, { recursive: true });
  const markerFile = path.join(directory, 'evaluation-cache.json');
  const corpusRaw = values.corpus ? await readFile(values.corpus, 'utf8') : null;
  const corpusKey = corpusRaw ? digest({ pinnedManifest: corpusRaw }) : digest({ revision: git(repositoryDirectory, ['rev-parse', 'HEAD']), dirty: git(repositoryDirectory, ['status', '--porcelain']) });
  const marker = await readFile(markerFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (marker && !marker.indexSnapshot && marker.corpusKey !== corpusKey) throw new Error('Corpus changed. Use a new evaluation cache.');
  if (!marker && (await readdir(directory)).length) throw new Error('Use an empty evaluation cache; do not use the live knowledge cache.');
  await writeFile(markerFile, JSON.stringify(marker || { corpusKey, evaluationOnly: true, indexSnapshot: Boolean(values['index-source']), sourceDirectory: values['index-source'] ? path.dirname(path.resolve(values['index-source'])) : null }));
  const snapshotOrigin = Boolean(values['index-source']);
  const store = snapshotOrigin ? await openEvaluationIndex(path.resolve(values['index-source'])) : await openKnowledgeStore(directory);
  let embeddings, semanticError;
  try {
    const sourceRoots = { knowledge: repositoryDirectory, 'tb-tools': root, thunderbird: values['source-directory'] };
    const verification = verifySuiteAnchors(suite, sourceRoots);
    if (verification.errors.length) throw new Error(`Fixture anchors failed verification: ${JSON.stringify(verification.errors)}`);
    const before = git(repositoryDirectory, ['rev-parse', 'HEAD']);
    if (values.corpus && snapshotOrigin) throw new Error('Select a pinned corpus or an index source, not both.');
    let corpusManifest;
    if (values.corpus) {
      corpusManifest = JSON.parse(corpusRaw);
      if (corpusManifest.version !== 1 || !/^[a-f0-9]{40}$/.test(corpusManifest.revision) || !Array.isArray(corpusManifest.entries)) throw new Error('Invalid corpus manifest.');
      for (const entry of corpusManifest.entries) {
        if (!/^(?:notes\/[a-z0-9-]+\.md|records\/[a-f0-9]{64}\.json)$/.test(entry.path)) throw new Error('Corpus entries must be ordinary public notes or records.');
        if (git(repositoryDirectory, ['rev-parse', `${corpusManifest.revision}:${entry.path}`]) !== entry.blob) throw new Error('Pinned corpus blob differs.');
        const text = execFileSync('git', ['show', `${corpusManifest.revision}:${entry.path}`], { cwd: repositoryDirectory, encoding: 'utf8', maxBuffer: 8_000_000 });
        const record = entry.path.startsWith('notes/') ? parseKnowledgeNote(text) : validateRecord(JSON.parse(text));
        if (record.visibility !== 'shared') throw new Error('A public corpus manifest cannot import private records.');
        await store.put(record);
      }
    } else if (!snapshotOrigin) await readKnowledgeRepository(store, repositoryDirectory);
    const records = store.all();
    store.evaluationRecords = records;
    const recordIds = records.map(record => record.id).sort();
    const snapshot = digest(recordIds);
    console.error(`Evaluation corpus: ${records.length} records; snapshot ${snapshot}.`);
    const provider = values.provider ? await import(pathToFileURL(path.resolve(values.provider)).href) : null;
    if (provider && (typeof provider.generate !== 'function' || !provider.configuration)) throw new Error('Provider must export generate(request) and configuration.');
    const reviews = values.reviews ? JSON.parse(await readFile(values.reviews, 'utf8')) : {};
    if (values.mode === 'hybrid') {
      embeddings = createLocalEmbeddings(values['model-cache'] || directory, { onError: error => { semanticError = error.message; } });
      const deadline = Date.now() + Number(values['model-timeout']);
      while (!embeddings.ready && !semanticError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (!embeddings.ready) semanticError ||= 'Embedding model readiness timed out.';
      if (!semanticError && !snapshotOrigin) {
        const sections = store.db.prepare('SELECT s.id,s.body FROM sections s LEFT JOIN section_vectors v ON s.id=v.id AND v.model=? WHERE v.id IS NULL ORDER BY s.id').all(embeddings.model);
        for (let offset = 0; offset < sections.length; offset += 32) {
          const batch = sections.slice(offset, offset + 32);
          const vectors = await embeddings.embed(batch.map(row => JSON.parse(row.body).input), 30000);
          if (!vectors || vectors.length !== batch.length || vectors.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) { semanticError = 'Embedding batch failed or timed out.'; break; }
          for (let index = 0; index < batch.length; index++) store.db.prepare('INSERT OR REPLACE INTO section_vectors VALUES (?, ?, ?)').run(batch[index].id, embeddings.model, JSON.stringify(vectors[index]));
          if (offset % 3200 === 0) console.error(`Indexed ${offset + batch.length}/${sections.length} evaluation sections.`);
        }
      }
    }
    const vectorCoverage = embeddings ? readVectorCoverage(store.db, embeddings.model) : null;
    if (embeddings && !semanticError && !vectorCoverage.vectors && !vectorCoverage.legacyVectors) semanticError = 'The index snapshot has no vectors for this model.';
    const report = {
      version: 1, at: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, suiteDigest: digest(raw), verification,
      code,
      corpus: { revision: before, dirty: git(repositoryDirectory, ['status', '--porcelain']), recordCount: records.length, snapshot, recordIds, manifest: corpusManifest || null, origin: snapshotOrigin ? 'pinned read-only SQLite transaction; checkout was not reimported' : corpusManifest ? 'bounded pinned public corpus; not full-library ranking' : 'fresh shared checkout import' },
      configuration: { mode: values.mode, limit, maxChars, model: embeddings?.model || null, embedding: embeddings ? { dtype: 'q8', device: 'cpu', pooling: 'mean', normalize: true, inputLimit: 2000 } : null, provider: provider?.configuration || null,
        indexSource: values['index-source'] || null, compareTerms: values['compare-terms'], compareTranscripts: values['compare-transcripts'], query: 'Natural question supplied verbatim; all exact terms retained by default. compare-terms tests optional function-word omission against the all-terms reference. No expected-answer query expansion.', cache: directory },
      semantic: { status: values.mode === 'exact' ? 'not-requested' : semanticError ? 'unavailable' : 'available', error: semanticError || null, vectorCoverage,
        coverage: embeddings ? vectorCoverageLabel(vectorCoverage) : 'not-requested',
        vectorSnapshot: embeddings ? vectorSnapshot(store.db, embeddings.model) : null },
      answerQuality: provider ? 'assistant source review enabled' : 'not-run: no provider configured', cases: [],
    };
    for (const item of suite.cases) {
      if (semanticError) { report.cases.push({ id: item.id, status: 'unavailable', error: semanticError }); continue; }
      const vector = embeddings ? (await embeddings.embed([item.question], 30000))?.[0] : undefined;
      if (embeddings && (!vector?.length || vector.some(value => !Number.isFinite(value)))) { report.cases.push({ id: item.id, status: 'unavailable', error: 'Query embedding unavailable; exact search was not substituted.' }); continue; }
      let reference;
      if (values['compare-terms'] || values['compare-transcripts']) {
        const started = performance.now();
        const prior = searchKnowledge(store, { query: item.question, question: item.question, repository: item.repository,
          filters: item.filters || {}, limit, maxChars, vector, model: embeddings?.model, trace: true, termPolicy: 'all', preferOriginalSources: !values['compare-transcripts'] });
        reference = { termPolicy: 'all', preferOriginalSources: !values['compare-transcripts'], searchMs: performance.now() - started, ids: prior.ids, retrieval: scoreRetrieval(item, prior, store), trace: prior.trace, context: prior.text };
      }
      const searchStarted = performance.now();
      console.error(`Evaluating ${item.id}.`);
      const result = searchKnowledge(store, { query: item.question, question: item.question, repository: item.repository,
        filters: item.filters || {}, limit, maxChars, vector, model: embeddings?.model, trace: true, termPolicy: values['compare-terms'] ? 'salient' : 'all',
        onPhase: event => { if (event.state === 'finished') console.error(`  ${event.phase}: ${Math.round(event.ms)} ms.`); } });
      const row = { id: item.id, intent: item.intent, status: 'evaluated', searchMs: performance.now() - searchStarted, ids: result.ids, queryVectorDigest: vector ? digest(vector) : null, retrieval: scoreRetrieval(item, result, store), trace: result.trace, reference, context: result.text };
      if (provider) {
        row.answer = await provider.generate(answerRequest(item, result.text));
        if (typeof row.answer !== 'string') throw new Error('Provider generate must return answer text.');
        row.answerChecks = checkAnswer(item, row.answer, result.ids, result.text);
        if (reviews[item.id]) {
          if (reviews[item.id].answerDigest !== digest(row.answer)) throw new Error(`Review for ${item.id} refers to another answer.`);
          row.answerReview = validateAnswerReview(item, reviews[item.id]);
        } else row.answerReview = await reviewAssistantAnswer(provider, item, row.answer, result.text, readReviewSources(item, sourceRoots));
        if (row.answerChecks.missingCitation || row.answerChecks.unknownCitations.length) row.answerReview.pass = false;
        if (row.answerReview.reviewerKind === 'human') row.humanReview = row.answerReview;
      }
      report.cases.push(row);
      console.error(`${item.id}: recall ${row.retrieval.recall}; ${Math.round(row.searchMs)} ms.`);
    }
    const scored = report.cases.filter(row => row.retrieval);
    const mean = key => scored.length ? scored.reduce((sum, row) => sum + row.retrieval[key], 0) / scored.length : null;
    report.summary = { evaluated: scored.length, unavailable: report.cases.length - scored.length,
      complete: scored.filter(row => row.retrieval.complete).length, recall: mean('recall'), precision: mean('precision'),
      reciprocalRank: mean('reciprocalRank'), ndcg: mean('ndcg'),
      scopeErrors: scored.flatMap(row => row.retrieval.scopeErrors).length,
      failedCases: scored.filter(row => !row.retrieval.complete).map(row => row.id),
      answerReviewed: scored.filter(row => row.answerReview).length,
      answerPassed: scored.filter(row => row.answerReview?.pass).length,
      reviewsByKind: Object.fromEntries(['assistant', 'human'].map(kind => [kind, scored.filter(row => row.answerReview?.reviewerKind === kind).length])),
      coverageByIntent: Object.fromEntries([...new Set(suite.cases.map(item => item.intent))].map(intent => [intent, {
        total: suite.cases.filter(item => item.intent === intent).length,
        complete: scored.filter(row => row.intent === intent && row.retrieval.complete).length }])) };
    if (values['compare-terms'] || values['compare-transcripts']) {
      report.comparison = { referencePolicy: 'all', currentPolicy: values['compare-terms'] ? 'salient' : 'all with lower task-transcript weight', sameReadSnapshot: snapshotOrigin,
        referenceComplete: scored.filter(row => row.reference.retrieval.complete).length,
        improved: scored.filter(row => row.retrieval.recall > row.reference.retrieval.recall).map(row => row.id),
        regressed: scored.filter(row => row.retrieval.recall < row.reference.retrieval.recall).map(row => row.id),
        note: 'Policies run against the same store. Reference search runs first; cache warmth can affect timing. This compares source recall, not answer correctness.' };
    }
    if (before !== git(repositoryDirectory, ['rev-parse', 'HEAD'])) report.corpus.changedDuringRun = true;
    report.code.changedDuringRun = digest(code.files) !== digest(await codeFingerprint());
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ output, summary: report.summary, semantic: report.semantic }, null, 2));
    return report;
  } finally { await embeddings?.close(); store.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEvaluation(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
