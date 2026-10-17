export function exactSectionStatement(eligible) {
  const scope = eligible ? ' AND id IN (SELECT id FROM sections WHERE record_id IN (SELECT value FROM json_each(?)))' : '';
  // Let SQLite rank text matches before loading section bodies. Keep the original bm25 scoring.
  return `SELECT s.body,h.rank FROM
    (SELECT id,rank FROM section_search WHERE section_search MATCH ? AND rank MATCH 'bm25()' AND repository=?${scope}
     ORDER BY rank LIMIT ?) h JOIN sections s ON s.id=h.id ORDER BY h.rank`;
}

export function exactSectionHits(db, { expression, repository, eligible, limit }) {
  return db.prepare(exactSectionStatement(eligible)).all(expression, repository, ...(eligible ? [JSON.stringify([...eligible])] : []), limit);
}
