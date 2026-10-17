// Run with --input PINNED_INDEX --sizes 1000,10000,50000 --queries 20 --output REPORT.json.
// All writes use fresh temporary caches. This runner never loads an embedding model.
// Repeat a saved scenario with --worker QUERIES.json --mode indexed --repeats 10 --output REPORT.json.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openKnowledgeStore, searchKnowledge, digest } from '../commands/knowledge/store.mjs';
import { recordSections } from '../commands/knowledge/sections.mjs';
import { searchSectionVectors, VECTOR_SEARCH_VERSION } from '../commands/knowledge/vector-search.mjs';

const root = path.resolve(import.meta.dirname, '..');
const execute = promisify(execFile);
const sourceFiles = ['commands/knowledge/store.mjs', 'commands/knowledge/vector-index.mjs',
  'commands/knowledge/vector-search.mjs', 'commands/knowledge/sections.mjs', 'commands/knowledge/claims.mjs',
  'commands/knowledge/routing.mjs', 'commands/knowledge/retrieval-queries.mjs', 'commands/knowledge/retrieval-terms.mjs',
  'commands/knowledge/task-query.mjs', 'commands/knowledge/retrieval-trace.mjs', 'package.json', 'package-lock.json',
  'test/knowledge-vector-benchmark.mjs'];
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { count: sorted.length, mean: mean(sorted), p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function codeFingerprint() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await fileHash(path.join(root, file))])));
}
function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}
function unit(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map(value => value / norm);
}
function noisy(vector, noise, next) {
  return unit(vector.map(value => value + (next() - 0.5) * noise / Math.sqrt(vector.length)));
}
function mixed(left, right, next) {
  return noisy(unit(left.map((value, index) => value * 0.65 + right[index] * 0.35)), 0.01, next);
}
function oldSectionScan(store, { repository, model, vector }) {
  const rows = store.db.prepare('SELECT s.body,v.vector FROM section_vectors v JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id WHERE model=? AND repository=?').all(model, repository);
  const hits = rows.map(row => ({ ...row, score: JSON.parse(row.vector).reduce((sum, n, index) => sum + n * (vector[index] || 0), 0) }))
    .filter(row => row.score > 0.35).sort((a, b) => b.score - a.score).slice(0, 60)
    .map(row => ({ ...row, id: JSON.parse(row.body).id }));
  return { hits, details: { mode: 'old-full-scan', scored: rows.length, materializedSectionBodies: rows.length } };
}
async function databaseBytes(directory) {
  const result = {};
  for (const name of ['index.sqlite', 'index.sqlite-wal', 'vector-index.sqlite', 'vector-index.sqlite-wal',
    'vector-index-v5.sqlite', 'vector-index-v5.sqlite-wal']) {
    result[name] = await stat(path.join(directory, name)).then(value => value.size, error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
  }
  const graphDirectory = path.join(directory, 'vector-index-v5');
  const graphs = await readdir(graphDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  result.graphFiles = graphs.filter(name => name.endsWith('.usearch')).length;
  result.graphBytes = 0;
  for (const name of graphs.filter(name => name.endsWith('.usearch'))) result.graphBytes += (await stat(path.join(graphDirectory, name))).size;
  return result;
}
function snapshot(store, repository, model) {
  const vectors = createHash('sha256'), records = createHash('sha256');
  let vectorCount = 0, recordCount = 0;
  for (const row of store.db.prepare('SELECT id,body FROM records WHERE repository=? ORDER BY id').iterate(repository)) {
    records.update(row.id + '\0' + row.body + '\n'); recordCount++;
  }
  for (const row of store.db.prepare('SELECT v.id,v.vector FROM section_vectors v JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id WHERE v.model=? AND r.repository=? ORDER BY v.id').iterate(model, repository)) {
    vectors.update(row.id + '\0' + row.vector + '\n'); vectorCount++;
  }
  return { repository, model, recordCount, vectorCount, recordHash: records.digest('hex'), vectorHash: vectors.digest('hex') };
}
async function buildIndex(directory) {
  const store = await openKnowledgeStore(directory);
  const timings = [];
  const start = performance.now();
  let result, processed = 0;
  do {
    const before = performance.now();
    result = store.vectorIndex.maintain({ limit: 16 });
    timings.push(performance.now() - before);
    if (result.error || (!result.ready && !result.pending)) throw new Error(`Native index build failed: ${JSON.stringify(result)}`);
    processed += result.processed || 0;
    await new Promise(resolve => setImmediate(resolve));
  } while (result.pending);
  const elapsedMs = performance.now() - start;
  store.close();
  return { elapsedMs, processed, batchLimit: 16, batchMs: distribution(timings),
    yield: 'setImmediate between measured batches; production adds a 25 ms timer',
    bytes: await databaseBytes(directory) };
}
function stressCenters() {
  const next = random(0x54424b31);
  return Array.from({ length: 32 }, () => unit(Array.from({ length: 384 }, () => next() - 0.5)));
}
async function createStress(directory, size, queryCount) {
  const store = await openKnowledgeStore(directory);
  const centers = stressCenters(), next = random(0x54424b32);
  const model = 'benchmark-clustered-384', repository = 'tb-tools';
  const recordInsert = store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
  const sectionInsert = store.db.prepare('INSERT INTO sections VALUES(?,?,?)');
  const textInsert = store.db.prepare('INSERT INTO section_search VALUES(?,?,?)');
  const vectorInsert = store.db.prepare('INSERT INTO section_vectors VALUES(?,?,?)');
  for (let first = 0; first < size; first += 256) {
    store.db.exec('BEGIN IMMEDIATE');
    for (let index = first; index < Math.min(size, first + 256); index++) {
      const cluster = index % centers.length, term = `cluster_${String(cluster).padStart(3, '0')}`;
      const body = { version: 1, kind: 'evidence', visibility: 'private', repository,
        at: '2026-10-13T00:00:00Z', title: `Synthetic ${term} source ${index}`, paths: [`benchmark/${term}/source-${index}.mjs`],
        source: { type: 'evaluation-fixture' }, text: `Synthetic retrieval evaluation fixture ${index}. The ${term} source describes a distinct callback, lifecycle, and cleanup contract. This is benchmark data, not knowledge evidence.` };
      const record = { ...body, id: digest(body) }, section = recordSections(record)[0];
      recordInsert.run(record.id, repository, record.kind, record.visibility, JSON.stringify(record));
      sectionInsert.run(section.id, record.id, JSON.stringify(section));
      textInsert.run(section.id, repository, section.input);
      vectorInsert.run(section.id, model, JSON.stringify(noisy(centers[cluster], 0.4, next)));
    }
    store.db.exec('COMMIT');
  }
  const queryRandom = random(0x54424b33);
  const queries = Array.from({ length: queryCount }, (_, index) => {
    const cluster = index % centers.length;
    return { id: `independent-cluster-query-${index}`, kind: 'independent-synthetic',
      query: `What is the cluster_${String(cluster).padStart(3, '0')} callback and cleanup contract?`,
      vector: noisy(centers[cluster], 0.4, queryRandom), repository, model };
  });
  const corpus = snapshot(store, repository, model);
  store.close();
  return { name: `stress-${size}`, kind: 'synthetic-stress', directory, corpus, queries,
    limits: 'Seeded nonidentical 384-dimensional vectors in 32 clusters. Stress recall is separate from the real-source quality gate.' };
}
async function createReal(directory, input, queryCount) {
  const wal = await stat(`${input}-wal`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (wal?.size) throw new Error('Use a closed pinned source snapshot without a WAL file.');
  const before = await fileHash(input);
  await mkdir(directory, { recursive: true });
  await copyFile(input, path.join(directory, 'index.sqlite'));
  const store = await openKnowledgeStore(directory);
  const scope = store.db.prepare('SELECT v.model,r.repository,count(*) AS count FROM section_vectors v JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id GROUP BY v.model,r.repository ORDER BY count DESC,v.model,r.repository LIMIT 1').get();
  if (!scope || scope.count < 512) throw new Error('The real source needs at least 512 usable section vectors.');
  const rows = store.db.prepare('SELECT v.rowid,v.id,v.vector,s.record_id,r.body FROM section_vectors v JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id WHERE v.model=? AND r.repository=? ORDER BY v.id').all(scope.model, scope.repository)
    .map(row => ({ rowid: row.rowid, id: row.id, recordId: row.record_id, vector: JSON.parse(row.vector), title: JSON.parse(row.body).title || 'Source contract' }));
  const recent = new Set(rows.slice().sort((left, right) => right.rowid - left.rowid).slice(0, 128).map(row => row.id));
  const olderRows = rows.filter(row => !recent.has(row.id));
  const next = random(0x54424b34);
  const queries = [];
  for (let index = 0; index < queryCount; index++) {
    const left = olderRows[Math.floor((index + 0.5) * olderRows.length / queryCount) % olderRows.length];
    let right, score = -Infinity;
    for (const row of olderRows) {
      const similarity = row.vector.reduce((sum, value, dimension) => sum + value * left.vector[dimension], 0);
      if (row.id !== left.id && similarity < 0.99999 && similarity > score) { right = row; score = similarity; }
    }
    if (!right) throw new Error('The real source needs distinct vector directions.');
    queries.push({ id: `real-mixed-query-${index}`, kind: 'mixed-section-vector', query: left.title,
      vector: mixed(left.vector, right.vector, next), repository: scope.repository, model: scope.model,
      inputSections: [left.id, right.id] });
  }
  const fixtureFile = path.join(root, 'test/fixtures/knowledge-evaluation/questions.json');
  const suite = JSON.parse(await readFile(fixtureFile, 'utf8'));
  for (const item of suite.cases.filter(item => item.repository === scope.repository)) {
    const lexical = searchKnowledge(store, { query: item.question, repository: scope.repository, limit: 3 });
    const matched = olderRows.filter(row => lexical.ids.includes(row.recordId));
    const left = matched[0] || olderRows[queries.length % olderRows.length];
    const right = matched.find(row => row.id !== left.id) || olderRows[(olderRows.indexOf(left) + 1) % olderRows.length];
    queries.push({ id: `fixture-${item.id}`, kind: 'fixture-question-section-proxy', query: item.question,
      vector: mixed(left.vector, right.vector, next), repository: scope.repository, model: scope.model,
      inputSections: [left.id, right.id] });
  }
  const corpus = snapshot(store, scope.repository, scope.model);
  store.close();
  if (before !== await fileHash(input)) throw new Error('The input snapshot changed while it was copied.');
  return { name: 'real', kind: 'real-source-vectors', directory, corpus, queries,
    input: { path: input, sha256: before, questionFixtureHash: await fileHash(fixtureFile), excludedRecentQueryInputs: recent.size },
    limits: 'Queries mix distinct existing section vectors with seeded perturbation; neither input comes from the newest128 vectors. Fixture questions use an explicitly labeled section-vector proxy, not a newly computed question embedding. This checks ANN approximation and output preservation, not language-model answer quality.' };
}
async function worker(file, mode, output, repeats = 1) {
  const fingerprintBefore = await codeFingerprint();
  const scenario = JSON.parse(await readFile(file, 'utf8'));
  const store = await openKnowledgeStore(scenario.directory);
  if (mode === 'old') store.db.exec('DROP INDEX IF EXISTS section_vectors_model');
  const sectionSearch = query => mode === 'old' ? oldSectionScan(store, query)
    : searchSectionVectors(store, { ...query, mode: mode === 'indexed' ? 'auto' : 'exact' });
  const pipeline = query => searchKnowledge(store, { ...query, semanticMode: mode === 'indexed' ? 'auto' : 'exact', trace: true });
  for (const query of scenario.queries.slice(0, 3)) sectionSearch(query);
  global.gc?.();
  const rssBefore = process.memoryUsage().rss, sections = [], pipelines = [], memory = [];
  const queries = Array.from({ length: repeats }, () => scenario.queries).flat();
  function sampleMemory(phase, completed) {
    if (repeats > 1 && completed % scenario.queries.length === 0) {
      global.gc?.();
      memory.push({ phase, completed, ...process.memoryUsage() });
    }
  }
  for (const query of queries) {
    const start = performance.now(), result = sectionSearch(query), elapsedMs = performance.now() - start;
    sections.push({ id: query.id, kind: query.kind, elapsedMs, ids: result.hits.map(hit => hit.id), details: result.details });
    sampleMemory('sections', sections.length);
  }
  const rssAfterSections = process.memoryUsage().rss, peakRssAfterSections = process.resourceUsage().maxRSS * 1024;
  if (mode !== 'old') {
    for (const query of scenario.queries.slice(0, 3)) pipeline(query);
    for (const query of queries) {
      const start = performance.now(), result = pipeline(query), elapsedMs = performance.now() - start;
      pipelines.push({ id: query.id, elapsedMs, ids: result.ids, contextHash: digest(result.text), contextChars: result.text.length,
        semantic: result.trace.semanticSearch });
      sampleMemory('pipelines', pipelines.length);
    }
  }
  const modeCounts = {}, fallbackReasons = {};
  for (const result of sections) {
    modeCounts[result.details.mode] = (modeCounts[result.details.mode] || 0) + 1;
    if (mode === 'indexed' && result.details.mode !== 'indexed') {
      const reason = result.details.reason || 'unknown';
      fallbackReasons[reason] = (fallbackReasons[reason] || 0) + 1;
    }
  }
  const pipelineModeCounts = {}, pipelineFallbackReasons = {};
  for (const result of pipelines) {
    const pipelineMode = result.semantic?.mode || 'absent';
    pipelineModeCounts[pipelineMode] = (pipelineModeCounts[pipelineMode] || 0) + 1;
    if (mode === 'indexed' && pipelineMode !== 'indexed') {
      const reason = result.semantic?.reason || 'unknown';
      pipelineFallbackReasons[reason] = (pipelineFallbackReasons[reason] || 0) + 1;
    }
  }
  const report = { mode, repeats, rankingTime: new Date(Date.now()).toISOString(), vectorSearchVersion: VECTOR_SEARCH_VERSION,
    code: fingerprintBefore, codeUnchanged: JSON.stringify(fingerprintBefore) === JSON.stringify(await codeFingerprint()),
    memory, modeCounts, fallbackReasons, pipelineModeCounts, pipelineFallbackReasons,
    indexedSectionMs: distribution(sections.filter(result => result.details.mode === 'indexed').map(result => result.elapsedMs)),
    fallbackSectionMs: distribution(sections.filter(result => mode === 'indexed' && result.details.mode !== 'indexed').map(result => result.elapsedMs)),
    indexedPipelineMs: distribution(pipelines.filter(result => result.semantic?.mode === 'indexed').map(result => result.elapsedMs)),
    fallbackPipelineMs: distribution(pipelines.filter(result => mode === 'indexed' && result.semantic?.mode !== 'indexed').map(result => result.elapsedMs)),
    sectionMs: distribution(sections.map(result => result.elapsedMs)),
    pipelineMs: distribution(pipelines.map(result => result.elapsedMs)),
    scored: distribution(sections.map(result => result.details.scored)),
    rssBefore, rssAfterSections, peakRssAfterSections, rssAfter: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024,
    sections, pipelines };
  store.close();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
function compare(scenario, results) {
  const { old, exact, indexed } = results;
  const recalls = exact.sections.map((result, index) => {
    const selected = new Set(indexed.sections[index].ids);
    return { id: result.id, kind: result.kind, expected: result.ids.length,
      recall: result.ids.length ? result.ids.filter(id => selected.has(id)).length / result.ids.length : 1,
      missing: result.ids.filter(id => !selected.has(id)) };
  });
  const lostSources = exact.pipelines.flatMap((result, index) => {
    const selected = new Set(indexed.pipelines[index].ids), missing = result.ids.filter(id => !selected.has(id));
    return missing.length ? [{ id: result.id, missing }] : [];
  });
  const sourceOrderChanges = exact.pipelines.filter((result, index) => JSON.stringify(result.ids) !== JSON.stringify(indexed.pipelines[index].ids)).map(result => result.id);
  const contextChanges = exact.pipelines.filter((result, index) => result.contextHash !== indexed.pipelines[index].contextHash).map(result => result.id);
  const oldScanMismatches = exact.sections.filter((result, index) => JSON.stringify(result.ids) !== JSON.stringify(old.sections[index].ids)).map(result => result.id);
  const meanRecall = mean(recalls.map(item => item.recall)), minimumRecall = Math.min(...recalls.map(item => item.recall));
  const indexedQueries = indexed.sections.filter(result => result.details.mode === 'indexed').length;
  const unexpectedFallbacks = indexed.sections.filter(result => result.details.mode !== 'indexed' && result.details.reason !== 'candidate-boundary-tie')
    .map(result => ({ id: result.id, reason: result.details.reason || 'unknown' }));
  const nativeSearchGate = { passed: indexedQueries > 0 && !unexpectedFallbacks.length, indexedQueries, unexpectedFallbacks,
    allowedFallbackReasons: ['candidate-boundary-tie'] };
  const qualityGate = { passed: meanRecall >= 0.99 && minimumRecall >= 0.95 && !lostSources.length && !sourceOrderChanges.length && !contextChanges.length && !oldScanMismatches.length,
    requirements: 'mean recall@60 >= 0.99; minimum >= 0.95; identical selected sources and context; streaming exact agrees with old scan' };
  return { meanRecallAt60: meanRecall, minimumRecallAt60: minimumRecall, recalls, lostSources, sourceOrderChanges,
    contextChanges, oldScanMismatches, nativeSearchGate, qualityGate,
    realQualityGate: scenario.kind === 'real-source-vectors' ? qualityGate : null,
    passed: nativeSearchGate.passed && qualityGate.passed };
}
async function main() {
  const rankingTime = Date.parse('2026-10-14T00:00:00Z');
  Date.now = () => rankingTime;
  const { values } = parseArgs({ options: { input: { type: 'string' }, sizes: { type: 'string', default: '1000,10000,50000' },
    queries: { type: 'string', default: '20' }, repeats: { type: 'string', default: '1' }, output: { type: 'string' }, worker: { type: 'string' }, mode: { type: 'string' } } });
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 50) throw new Error('Use 1–50 repetitions.');
  if (values.worker) return worker(values.worker, values.mode, values.output, repeats);
  if (!values.input || !values.output) throw new Error('Use --input PINNED_INDEX --output REPORT.json [--sizes 1000,10000,50000] [--queries 20].');
  const queryCount = Number(values.queries), sizes = values.sizes.split(',').filter(Boolean).map(Number);
  if (!Number.isInteger(queryCount) || queryCount < 1 || queryCount > 200 || sizes.some(size => !Number.isInteger(size) || size < 512 || size > 100000)) throw new Error('Use 1–200 queries and stress sizes of 512–100000 vectors.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tb-vector-benchmark-'));
  const fingerprintBefore = await codeFingerprint();
  const nativeName = VECTOR_SEARCH_VERSION.startsWith('hnsw-') ? 'usearch' : 'libsql';
  const nativePackageFile = path.join(root, 'node_modules', nativeName, 'package.json');
  const nativePackage = JSON.parse(await readFile(nativePackageFile, 'utf8'));
  const report = { version: 2, at: new Date().toISOString(), rankingTime: new Date(rankingTime).toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, native: { name: nativeName, version: nativePackage.version, packageHash: await fileHash(nativePackageFile) } },
    vectorSearchVersion: VECTOR_SEARCH_VERSION, directory, code: fingerprintBefore, scenarios: [],
    limits: 'Fresh child process per query mode excludes index-build RSS. Section memory is measured before warming full retrieval and its claim cache. Warm timings have three warmup queries; OS file caches are not reset. No wall-clock CI thresholds. Old-scan timings cover section search only. Ranking time is fixed across all variants. Indexed and fallback timings are separate. Real and synthetic results must not be combined.' };
  const configs = [{ name: 'real' }, ...sizes.map(size => ({ name: `stress-${size}`, size }))];
  for (const config of configs) {
    process.stderr.write(`Preparing ${config.name}.\n`);
    const scenarioDirectory = path.join(directory, config.name);
    const scenario = config.size ? await createStress(scenarioDirectory, config.size, queryCount)
      : await createReal(scenarioDirectory, path.resolve(values.input), queryCount);
    const file = path.join(scenarioDirectory, 'benchmark-queries.json');
    await writeFile(file, JSON.stringify(scenario) + '\n');
    const { queries, ...description } = scenario;
    const entry = { ...description, queryCount: queries.length, queryKinds: [...new Set(queries.map(query => query.kind))], phase: 'prepared', results: {} };
    report.scenarios.push(entry);
    await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
    try {
      process.stderr.write(`Building ${scenario.name}: ${scenario.corpus.vectorCount} vectors.\n`);
      entry.build = await buildIndex(scenarioDirectory);
      entry.phase = 'querying';
      await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
      for (const mode of ['old', 'exact', 'indexed']) {
        const output = path.join(scenarioDirectory, `${mode}.json`);
        await execute(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', file, '--mode', mode, '--output', output],
          { cwd: root, maxBuffer: 1024 * 1024 });
        entry.results[mode] = JSON.parse(await readFile(output, 'utf8'));
        await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
      }
      entry.comparison = compare(scenario, entry.results);
      entry.phase = 'complete';
      report.codeUnchanged = JSON.stringify(fingerprintBefore) === JSON.stringify(await codeFingerprint());
      await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
      process.stderr.write(`${scenario.name}: recall ${entry.comparison.meanRecallAt60.toFixed(4)}, minimum ${entry.comparison.minimumRecallAt60.toFixed(4)}, lost sources ${entry.comparison.lostSources.length}; built in ${entry.build.elapsedMs.toFixed(0)} ms.\n`);
    } catch (error) {
      entry.phase = 'failed';
      entry.error = String(error.stack || error).slice(0, 16_000);
      report.passed = false;
      report.codeUnchanged = JSON.stringify(fingerprintBefore) === JSON.stringify(await codeFingerprint());
      await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
      throw error;
    }
  }
  report.passed = report.codeUnchanged && report.scenarios.every(item => item.comparison.passed);
  await writeFile(path.resolve(values.output), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output: path.resolve(values.output), directory, passed: report.passed, codeUnchanged: report.codeUnchanged }) + '\n');
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
