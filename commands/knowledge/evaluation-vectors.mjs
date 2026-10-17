import { createHash } from 'node:crypto';

// Fingerprint stored vectors without loading their complete JSON payload into memory.
export function vectorSnapshot(db, model) {
  const hash = createHash('sha256');
  let rows = 0;
  for (const table of ['section_vectors', 'vectors']) {
    hash.update(JSON.stringify([table, model]) + '\n');
    for (const row of db.prepare(`SELECT id,vector FROM ${table} WHERE model=? ORDER BY id`).iterate(model)) {
      hash.update(row.id + '\0' + row.vector + '\n'); rows++;
    }
  }
  return { model, rows, digest: hash.digest('hex'),
    limit: 'Identifies exact stored vector JSON. Legacy vectors were reused; their original model package and weight revisions may be unavailable. A fingerprint alone cannot restore vectors.' };
}

export function readVectorCoverage(db, model) {
  const count = (sql, ...args) => db.prepare(sql).get(...args).count;
  const sections = count('SELECT count(*) AS count FROM sections');
  const vectors = count('SELECT count(*) AS count FROM section_vectors v JOIN sections s ON s.id=v.id WHERE v.model=?', model);
  const legacyVectors = count('SELECT count(*) AS count FROM vectors v JOIN records r ON r.id=v.id WHERE v.model=?', model);
  return { sections, vectors, legacyVectors,
    orphanSectionVectors: count('SELECT count(*) AS count FROM section_vectors WHERE model=?', model) - vectors,
    orphanLegacyVectors: count('SELECT count(*) AS count FROM vectors WHERE model=?', model) - legacyVectors };
}

export function vectorCoverageLabel(coverage) {
  if (coverage.sections && coverage.vectors === coverage.sections) return 'complete-section-vectors';
  return coverage.vectors ? 'partial-section-vectors' : coverage.legacyVectors ? 'legacy-only' : 'none';
}
