export async function indexKnowledgeSections(service, { maxBatches = null, onProgress } = {}) {
  if (maxBatches !== null && (!Number.isInteger(maxBatches) || maxBatches < 1)) throw new Error('Use a positive maximum batch count.');
  if (!service.semanticReady || !service.semanticModel) throw new Error('The local embedding model is not ready. Exact search remains available.');
  const { store } = service, model = service.semanticModel;
  const pending = () => store.db.prepare('SELECT count(*) AS count FROM sections s LEFT JOIN section_vectors v ON s.id=v.id AND v.model=? WHERE v.id IS NULL').get(model).count;
  const indexed = () => store.db.prepare('SELECT count(*) AS count FROM section_vectors WHERE model=?').get(model).count;
  let remaining = pending(), batches = 0, embeddedSections = 0;
  const initialPending = remaining, initialVectors = indexed();
  if (!remaining) await service.indexSemantic();
  while (remaining && (maxBatches === null || batches < maxBatches)) {
    const count = await service.indexSemantic(); batches++;
    if (!count) {
      remaining = pending();
      if (!remaining) break;
      throw new Error(`Semantic indexing made no progress; ${remaining} sections remain.`);
    }
    embeddedSections += count;
    remaining = Math.max(0, remaining - count);
    // Check new arrivals or another indexer's work when the estimated backlog ends.
    if (!remaining) remaining = pending();
    onProgress?.({ model, batches, remainingEstimate: remaining, embeddedSections });
  }
  remaining = pending();
  return { model, status: remaining ? 'partial' : 'complete', initialPending, remaining, batches, embeddedSections,
    indexedSections: indexed() - initialVectors, vectorIndex: store.setting("vectorIndexStatus"),
    sectionVectors: store.db.prepare('SELECT model,count(*) AS count FROM section_vectors GROUP BY model').all(),
    legacyVectors: store.db.prepare('SELECT model,count(*) AS count FROM vectors GROUP BY model').all() };
}
