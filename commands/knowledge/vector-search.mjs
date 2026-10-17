import { withVectorSnapshot, VECTOR_INDEX_VERSION } from './vector-index.mjs';

export const VECTOR_SEARCH_VERSION = `hnsw-${VECTOR_INDEX_VERSION}-240-recent128-source-ties-2`;

// Score source vectors before loading any section text. Retain only the best 60 rows.
export function searchSectionVectors(store, { repository, model, vector, eligible, mode = 'auto' }) {
  if (!['auto', 'exact'].includes(mode)) throw new Error('Use auto or exact for semantic search.');
  return withVectorSnapshot(store.db, () => {
    function score({ ids, details }) {
      const where = ['v.model=?', 'r.repository=?'];
      const values = [model, repository];
      if (eligible) { where.push('s.record_id IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify([...eligible])); }
      if (ids) { where.push('v.id IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(ids)); }
      const rows = store.db.prepare(`SELECT v.rowid,v.id,v.vector,r.rowid AS recordOrder,s.rowid AS sectionOrder FROM section_vectors v
        JOIN sections s ON s.id=v.id JOIN records r ON r.id=s.record_id WHERE ${where.join(' AND ')}`).iterate(...values);
      const hits = [];
      let scored = 0;
      for (const row of rows) {
        const similarity = JSON.parse(row.vector).reduce((sum, n, index) => sum + n * (vector[index] || 0), 0);
        scored++;
        if (!(similarity > 0.35)) continue;
        let start = 0, end = hits.length;
        while (start < end) {
          const middle = (start + end) >>> 1;
          const other = hits[middle];
          if (other.score > similarity || (other.score === similarity &&
              (other.recordOrder < row.recordOrder || (other.recordOrder === row.recordOrder && other.sectionOrder <= row.sectionOrder)))) start = middle + 1;
          else end = middle;
        }
        if (start < 60) { hits.splice(start, 0, { id: row.id, rowid: row.rowid, score: similarity, recordOrder: row.recordOrder, sectionOrder: row.sectionOrder }); if (hits.length > 60) hits.pop(); }
      }
      const section = store.db.prepare('SELECT body FROM sections WHERE id=?');
      return { hits: hits.map(({ id, rowid, score }) => ({ id, rowid, score, body: section.get(id).body })), details: { ...details, scored } };
    }
    if (mode === 'exact' || !store.vectorIndex) return score({ ids: null, details: { mode: 'exact', approximate: false, reason: mode === 'exact' ? 'requested' : 'index-unavailable' } });
    return store.vectorIndex.candidates({ repository, model, vector, eligible }, score);
  });
}
