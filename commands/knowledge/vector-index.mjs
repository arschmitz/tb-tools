import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const VECTOR_INDEX_VERSION = 5;
export const VECTOR_CANDIDATES = 240;
export const VECTOR_RECENT = 128;
const journal = 'semantic_vector_changes';
const epochKey = 'semanticVectorEpoch';

export function installVectorJournal(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${journal} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, model TEXT, UNIQUE(id,model));
      CREATE INDEX IF NOT EXISTS section_vectors_model ON section_vectors(model);`);
    db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(epochKey, JSON.stringify(randomUUID()));
    // An outer OR IGNORE also applies inside triggers. Remove the prior key first.
    const queue = select => `DELETE FROM ${journal} WHERE (id,model) IN (${select});
      INSERT INTO ${journal}(id,model) ${select};`;
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const keys = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW'];
      const vectorChanges = keys.map(key => queue(`SELECT ${key}.id,${key}.model`)).join('\n');
      const sectionChanges = keys.map(key => queue(`SELECT id,model FROM section_vectors WHERE id=${key}.id`)).join('\n');
      const recordChanges = keys.map(key => queue(`SELECT v.id,v.model FROM section_vectors v JOIN sections s ON s.id=v.id WHERE s.record_id=${key}.id`)).join('\n');
      for (const [table, statements] of [['section_vectors', vectorChanges], ['sections', sectionChanges], ['records', recordChanges]]) {
        db.exec(`DROP TRIGGER IF EXISTS semantic_${table}_${event.toLowerCase()};
          CREATE TRIGGER semantic_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${statements} END;`);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function sourceState(db) {
  const epoch = db.prepare('SELECT value FROM settings WHERE key=?').get(epochKey)?.value;
  if (!epoch) return null;
  const seq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(journal)?.seq || 0;
  return { epoch, seq };
}

let snapshot = 0;
export function withVectorSnapshot(db, action) {
  const name = `vector_snapshot_${++snapshot}`;
  db.exec(`SAVEPOINT ${name}`);
  try { return action(); }
  finally { db.exec(`RELEASE ${name}`); }
}

function tableName(repository, model, dimensions) {
  return `v_${createHash('sha256').update(JSON.stringify([repository, model, dimensions])).digest('hex').slice(0, 32)}`;
}
function dimensionsOf(text) {
  let vector;
  try { vector = JSON.parse(text); } catch { return 0; }
  if (!Array.isArray(vector) || vector.length < 2 || vector.length > 4096 || vector.some(n => !Number.isFinite(n))) return 0;
  const norm = vector.reduce((sum, n) => sum + n * n, 0);
  return Math.abs(norm - 1) <= 0.0001 ? vector.length : 0;
}

const SEGMENT_SIZE = 4096;
const ownedFile = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.usearch$/;

// The source database owns vectors. These files can be rebuilt without changing evidence.
export function createVectorIndex(store, { readOnly = false } = {}) {
  const file = path.join(store.directory, 'vector-index-v5.sqlite');
  const directory = path.join(store.directory, 'vector-index-v5');
  let writer, reader, native, loadError, closed = false, damaged = false;
  const views = new Map(), verified = new Map(), builders = [];
  function open(create) {
    if (closed || readOnly || loadError) return null;
    if (!native) {
      try { native = require('usearch'); }
      catch { loadError = 'native-unavailable'; return null; }
    }
    if (!create && !existsSync(file)) return null;
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!writer) {
        writer = new DatabaseSync(file);
        chmodSync(file, 0o600);
        writer.exec('PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      }
      return writer;
    }
    if (!reader) {
      reader = new DatabaseSync(file, { readOnly: true });
      reader.exec('PRAGMA busy_timeout=50;');
    }
    return reader;
  }
  function index(dimensions) {
    return new native.Index({ dimensions, metric: 'ip', quantization: 'f32', connectivity: 32, expansion_add: 200, expansion_search: 400 });
  }
  function graphPath(name) {
    if (!ownedFile.test(name)) throw new Error('Invalid derived graph filename.');
    return path.join(directory, name);
  }
  function verifyGraph(segment) {
    const filename = graphPath(segment.file);
    const stat = statSync(filename, { bigint: true });
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, segment.digest].join(':');
    if (verified.get(segment.file) !== signature) {
      if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== segment.digest) throw new Error('Derived graph checksum mismatch.');
      verified.delete(segment.file); verified.set(segment.file, signature);
      if (verified.size > 4096) verified.delete(verified.keys().next().value);
    }
    return filename;
  }
  function checkGraph(graph, segment, dimensions) {
    if (Number(graph.size()) !== segment.size || Number(graph.dimensions()) !== dimensions) throw new Error('Derived graph shape mismatch.');
  }
  function view(segment, dimensions) {
    const filename = verifyGraph(segment);
    let graph = views.get(segment.file);
    if (graph) { checkGraph(graph, segment, dimensions); views.delete(segment.file); views.set(segment.file, graph); return graph; }
    if (views.size >= 16) {
      const oldest = views.keys().next().value;
      graph = views.get(oldest); views.delete(oldest);
    }
    graph ||= index(dimensions);
    graph.view(filename);
    checkGraph(graph, segment, dimensions);
    views.set(segment.file, graph);
    return graph;
  }
  function schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS state (singleton INTEGER PRIMARY KEY, epoch TEXT, version INTEGER, cursor INTEGER, maxrow INTEGER, seq INTEGER, complete INTEGER);
      CREATE TABLE IF NOT EXISTS partitions (name TEXT PRIMARY KEY, repository TEXT, model TEXT, dimensions INTEGER, size INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS partitions_scope ON partitions(repository,model);
      CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY AUTOINCREMENT, partition TEXT, file TEXT, digest TEXT, size INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS segments_partition ON segments(partition,id);
      CREATE TABLE IF NOT EXISTS entries (key INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, model TEXT, repository TEXT, partition TEXT, segment INTEGER, UNIQUE(id,model));
      CREATE INDEX IF NOT EXISTS entries_scope ON entries(repository,model,partition);
      CREATE INDEX IF NOT EXISTS entries_partition ON entries(partition,key);`);
  }
  function reset(db, source) {
    db.exec('DELETE FROM entries; DELETE FROM segments; DELETE FROM partitions; DELETE FROM state;');
    const maxrow = store.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM section_vectors').get().n;
    db.prepare('INSERT INTO state VALUES (1,?,?,?,?,?,?)').run(source.epoch, VECTOR_INDEX_VERSION, 0, maxrow, source.seq, 0);
    builders.length = 0; views.clear(); damaged = false;
  }
  function cleanup(db) {
    const referenced = new Set(db.prepare('SELECT file FROM segments').all().map(row => row.file));
    for (const name of readdirSync(directory)) {
      if (!ownedFile.test(name) || referenced.has(name)) continue;
      // Windows can retain a mapped file until its reader releases the mapping.
      try { unlinkSync(graphPath(name)); verified.delete(name); } catch { /* Retry on a later batch. */ }
    }
  }
  return {
    file,
    maintain({ limit = 128 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Use a vector maintenance batch of 1 to 1000 rows.');
      const started = performance.now(), published = [];
      let result;
      try {
        const db = open(true);
        if (!db) return { ready: false, pending: false, reason: readOnly ? 'read-only' : loadError || 'closed' };
        schema(db);
        result = withVectorSnapshot(store.db, () => {
          const source = sourceState(store.db);
          if (!source) return { ready: false, pending: false, reason: 'old-source-schema' };
          db.exec('BEGIN IMMEDIATE');
          try {
            let state = db.prepare('SELECT * FROM state WHERE singleton=1').get();
            cleanup(db);
            const missing = db.prepare('SELECT file FROM segments').all().some(row => !existsSync(graphPath(row.file)));
            if (!state || state.epoch !== source.epoch || state.version !== VECTOR_INDEX_VERSION || damaged || missing) {
              reset(db, source); state = db.prepare('SELECT * FROM state WHERE singleton=1').get();
            }
            if (state.seq > source.seq) { db.exec('ROLLBACK'); builders.length = 0; return { ready: false, pending: false, reason: 'older-source-snapshot' }; }
            const dirty = new Map();
            function apply(id, model) {
              const row = store.db.prepare(`SELECT v.vector,r.repository FROM section_vectors v
                JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id WHERE v.id=? AND v.model=?`).get(id, model);
              if (!row) return;
              const dimensions = dimensionsOf(row.vector);
              let partition = null, segment = null, builder;
              if (dimensions) {
                partition = tableName(row.repository, model, dimensions);
                db.prepare('INSERT OR IGNORE INTO partitions(name,repository,model,dimensions) VALUES (?,?,?,?)').run(partition, row.repository, model, dimensions);
                segment = db.prepare('SELECT * FROM segments WHERE partition=? AND size<? ORDER BY id DESC LIMIT 1').get(partition, SEGMENT_SIZE);
                if (!segment) {
                  const id = Number(db.prepare('INSERT INTO segments(partition) VALUES (?)').run(partition).lastInsertRowid);
                  segment = { id, partition, size: 0, file: null };
                }
                if (dirty.has(segment.id)) builder = dirty.get(segment.id).builder;
                else {
                  const slot = dirty.size;
                  builder = builders[slot];
                  if (!segment.file) builder = { graph: index(dimensions), file: null };
                  else if (!builder || builder.file !== segment.file) {
                    builder ||= { graph: index(dimensions) };
                    builder.graph.load(verifyGraph(segment)); checkGraph(builder.graph, segment, dimensions);
                    builder.file = segment.file;
                  }
                  builders[slot] = builder;
                  dirty.set(segment.id, { builder, segment });
                }
              }
              const key = db.prepare('INSERT INTO entries(id,model,repository,partition,segment) VALUES (?,?,?,?,?)').run(id, model, row.repository, partition, segment?.id ?? null).lastInsertRowid;
              if (segment) {
                builder.graph.add(BigInt(key), new Float32Array(JSON.parse(row.vector)), 1);
                db.prepare('UPDATE segments SET size=size+1 WHERE id=?').run(segment.id);
                db.prepare('UPDATE partitions SET size=size+1 WHERE name=?').run(partition);
              }
            }
            const backfill = state.cursor < state.maxrow;
            const rows = backfill
              ? store.db.prepare('SELECT rowid,id,model FROM section_vectors WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(state.cursor, state.maxrow, limit)
              : store.db.prepare(`SELECT seq,id,model FROM ${journal} WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?`).all(state.seq, source.seq, limit);
            let processed = 0;
            // Reused source row IDs and replacements both require a new graph snapshot.
            if (rows.some(row => db.prepare('SELECT key FROM entries WHERE id=? AND model=?').get(row.id, row.model))) {
              reset(db, source);
              db.exec('COMMIT');
              return { ready: false, pending: true, processed: 0, reason: 'source-replaced', generation: source.seq };
            }
            for (const row of rows) {
              apply(row.id, row.model); processed++;
              if (backfill) state.cursor = row.rowid; else state.seq = row.seq;
              if (performance.now() - started >= 20) break;
            }
            if (processed === rows.length && rows.length < limit) {
              if (backfill) state.cursor = state.maxrow; else state.seq = source.seq;
            }
            for (const { builder, segment } of dirty.values()) {
              const name = `${randomUUID()}.usearch`, filename = graphPath(name);
              published.push(filename);
              builder.graph.save(filename); chmodSync(filename, 0o600);
              const fd = openSync(filename, 'r');
              try { fsyncSync(fd); } finally { closeSync(fd); }
              const digest = createHash('sha256').update(readFileSync(filename)).digest('hex');
              db.prepare('UPDATE segments SET file=?,digest=? WHERE id=?').run(name, digest, segment.id);
              builder.file = name;
            }
            state.complete = Number(state.cursor >= state.maxrow && state.seq === source.seq);
            db.prepare('UPDATE state SET cursor=?,seq=?,complete=? WHERE singleton=1').run(state.cursor, state.seq, state.complete);
            db.exec('COMMIT'); published.length = 0;
            return { ready: Boolean(state.complete), pending: !state.complete, processed, generation: state.seq };
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        });
        // A new replacement gets a higher sequence, so this cannot erase an unseen write.
        if (result.ready) store.db.prepare(`DELETE FROM ${journal} WHERE seq<=?`).run(result.generation);
      } catch (error) {
        builders.length = 0; damaged = true;
        for (const filename of published) { try { unlinkSync(filename); } catch { /* Cleanup retries later. */ } }
        result = { ready: false, pending: false, reason: 'index-error', error: error.message };
      }
      return { ...result, ms: performance.now() - started };
    },
    candidates({ repository, model, vector, eligible }, consume = result => result) {
      const fallback = reason => consume({ ids: null, details: { mode: 'exact', reason, approximate: false } });
      if (eligible) return fallback('explicit-scope');
      if (readOnly) return fallback('read-only');
      if (!Array.isArray(vector) || !vector.length || vector.some(n => !Number.isFinite(n)) || !vector.some(n => n !== 0)) return fallback('unsupported-query');
      const query = new Float32Array(vector);
      if (query.some(n => !Number.isFinite(n)) || !query.some(n => n !== 0)) return fallback('unsupported-query');
      try {
        const source = sourceState(store.db);
        if (!source) return fallback('old-source-schema');
        const db = open(false);
        if (!db) return fallback(loadError || 'index-missing');
        return withVectorSnapshot(db, () => {
          const state = db.prepare('SELECT * FROM state WHERE singleton=1').get();
          if (!state || state.epoch !== source.epoch || state.version !== VECTOR_INDEX_VERSION) return fallback('index-mismatch');
          if (!state.complete || state.seq !== source.seq) return fallback('index-pending');
          const partitions = db.prepare('SELECT * FROM partitions WHERE repository=? AND model=? AND size>0').all(repository, model);
          if (db.prepare('SELECT key FROM entries WHERE repository=? AND model=? AND partition IS NULL LIMIT 1').get(repository, model)) return fallback('unsupported-vectors');
          if (partitions.some(part => part.dimensions !== vector.length)) return fallback('mixed-dimensions');
          const part = partitions[0];
          if (!part || part.size < 512) return fallback('small-partition');
          const segments = db.prepare('SELECT * FROM segments WHERE partition=? ORDER BY id').all(part.name);
          const matches = [];
          for (const segment of segments) {
            const result = view(segment, part.dimensions).search(query, Math.min(VECTOR_CANDIDATES, segment.size), 1);
            if (result.keys.length !== Math.min(VECTOR_CANDIDATES, segment.size)) return fallback('short-index-result');
            for (let i = 0; i < result.keys.length; i++) {
              const key = Number(result.keys[i]), distance = result.distances[i];
              if (!Number.isSafeInteger(key) || key < 1 || !Number.isFinite(distance)) return fallback('invalid-index-result');
              matches.push({ key, distance });
            }
          }
          matches.sort((a, b) => a.distance - b.distance || a.key - b.key);
          const best = matches.slice(0, VECTOR_CANDIDATES);
          if (best.length < VECTOR_CANDIDATES) return fallback('short-index-result');
          const cutoff = best.at(-1).distance;
          if (cutoff - best[59].distance <= 1e-5 * (1 + Math.abs(best[0].distance) + Math.abs(cutoff))) return fallback('candidate-boundary-tie');
          const ids = db.prepare('SELECT id FROM entries WHERE key IN (SELECT value FROM json_each(?)) AND partition=?').all(JSON.stringify(best.map(row => row.key)), part.name).map(row => row.id);
          if (ids.length !== best.length) return fallback('missing-index-mapping');
          const recent = db.prepare('SELECT id FROM entries WHERE partition=? ORDER BY key DESC LIMIT ?').all(part.name, VECTOR_RECENT).map(row => row.id);
          const combined = [...new Set([...ids, ...recent])];
          return consume({ ids: combined, details: { mode: 'indexed', approximate: true, candidates: combined.length, graphCandidates: ids.length, recentCandidates: recent.length, population: part.size, segments: segments.length, generation: state.seq } });
        });
      } catch {
        damaged = true;
        return fallback('index-error');
      }
    },
    close() { closed = true; views.clear(); builders.length = 0; verified.clear(); reader?.close(); writer?.close(); reader = writer = null; },
  };
}
