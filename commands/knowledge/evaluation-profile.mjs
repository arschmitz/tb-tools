import { fork, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './store.mjs';
import { exactSectionHits, exactSectionStatement } from './retrieval-queries.mjs';

const oldStatement = 'SELECT s.body,bm25(section_search) AS rank FROM section_search JOIN sections s ON s.id=section_search.id WHERE section_search MATCH ? AND repository=? ORDER BY rank LIMIT ?';
const self = fileURLToPath(import.meta.url);

async function worker(input) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(input.index, { readOnly: true });
  try {
    db.exec('BEGIN');
    const words = [...new Set(input.query.match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 80);
    const expression = words.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
    const args = [expression, input.repository, input.limit];
    const sql = input.variant === 'old' ? oldStatement : exactSectionStatement(null);
    const metadata = { sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
      records: db.prepare('SELECT count(*) AS count FROM records').get().count,
      sections: db.prepare('SELECT count(*) AS count FROM sections').get().count,
      pageCount: db.prepare('PRAGMA page_count').get().page_count,
      indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map(row => row.name),
      plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args), words };
    process.send({ state: 'started', metadata });
    const start = performance.now();
    const rows = input.variant === 'old' ? db.prepare(sql).all(...args) : exactSectionHits(db, { expression, repository: input.repository, eligible: null, limit: input.limit });
    const ms = performance.now() - start;
    process.send({ state: 'completed', ms, candidates: rows.map(row => ({ id: JSON.parse(row.body).id, recordId: JSON.parse(row.body).recordId, rank: row.rank, bodyDigest: digest(row.body) })) });
  } finally { db.close(); }
}

function profileVariant(input) {
  return new Promise(resolve => {
    const child = fork(self, ['--worker', JSON.stringify(input)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let metadata, error = '', queryTimer;
    const setupTimer = setTimeout(() => finish({ status: 'setup-timeout' }), 30000);
    const finish = result => {
      clearTimeout(setupTimer); clearTimeout(queryTimer);
      child.removeAllListeners('message');
      child.kill();
      resolve({ variant: input.variant, metadata, ...result });
    };
    child.stderr.on('data', data => { error = (error + data).slice(-4000); });
    child.on('message', message => {
      if (message.state === 'started') {
        metadata = message.metadata;
        clearTimeout(setupTimer);
        queryTimer = setTimeout(() => finish({ status: 'query-timeout', timeoutMs: input.timeoutMs }), input.timeoutMs);
      } else if (message.state === 'completed') finish({ status: 'completed', ms: message.ms, candidates: message.candidates });
    });
    child.on('error', failure => finish({ status: 'error', error: failure.message }));
    child.on('exit', code => { if (code !== 0 && code !== null) finish({ status: 'error', error }); });
  });
}

export async function runProfile(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'index-source': { type: 'string' }, output: { type: 'string' }, query: { type: 'string' },
    repository: { type: 'string', default: 'thunderbird' }, limit: { type: 'string', default: '60' },
    'timeout-ms': { type: 'string', default: '30000' }, variant: { type: 'string', default: 'both' },
  } });
  const limit = Number(values.limit), timeoutMs = Number(values['timeout-ms']);
  if (!values['index-source'] || !values.output || !values.query || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !['old', 'rank-first', 'both'].includes(values.variant)) throw new Error('Provide index-source, output and query; use a positive limit and timeout-ms up to 60000.');
  const input = { index: path.resolve(values['index-source']), query: values.query, repository: values.repository, limit, timeoutMs };
  const sourceFiles = ['store.mjs', 'retrieval-queries.mjs', 'evaluation-profile.mjs'];
  const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(new URL(file, import.meta.url), 'utf8'))])));
  const report = { version: 1, at: new Date().toISOString(), runtime: process.version, configuration: input,
    code: { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(self), encoding: 'utf8' }).trim(), hashes },
    limits: 'Isolated exact-candidate SQL profiling, not total retrieval or answer quality. Each child pins its own read-only snapshot. A timeout is a lower time bound, not a measured duration. Concurrent index changes and cache warmth can differ between variants.', results: [] };
  for (const variant of values.variant === 'both' ? ['old', 'rank-first'] : [values.variant]) {
    const result = await profileVariant({ ...input, variant }); report.results.push(result);
    console.error(`${variant}: ${result.status}${result.ms !== undefined ? `, ${Math.round(result.ms)} ms` : ''}.`);
  }
  if (report.results.length === 2 && report.results.every(result => result.status === 'completed')) report.sameCandidates = digest(report.results[0].candidates) === digest(report.results[1].candidates);
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true, mode: 0o700 });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output: values.output, results: report.results.map(({ variant, status, ms, timeoutMs }) => ({ variant, status, ms, timeoutMs })) }));
  return report;
}
if (process.argv[2] === '--worker') worker(JSON.parse(process.argv[3])).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (process.argv[1] && path.resolve(process.argv[1]) === self) runProfile(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
