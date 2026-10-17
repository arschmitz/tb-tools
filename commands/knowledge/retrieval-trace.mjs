export function createRetrievalTrace(enabled, onPhase) {
  const start = performance.now();
  const timings = {};
  const candidates = new Map();
  function phase(name, action) {
    const before = performance.now();
    onPhase?.({ phase: name, state: 'started' });
    try { return action(); }
    finally {
      timings[name] = performance.now() - before;
      onPhase?.({ phase: name, state: 'finished', ms: timings[name] });
    }
  }
  function candidate(id, detail) {
    if (!enabled) return;
    const prior = candidates.get(id) || { id, sources: [] };
    if (detail.source && !prior.sources.includes(detail.source)) prior.sources.push(detail.source);
    const rest = { ...detail };
    delete rest.source;
    for (const key of ['exactRank', 'semanticRank', 'legacyRank']) {
      if (prior[key] !== undefined && rest[key] !== undefined) rest[key] = Math.min(prior[key], rest[key]);
    }
    candidates.set(id, { ...prior, ...rest });
  }
  return { phase, candidate,
    finish(detail) {
      return enabled ? { ...detail, timings: { ...timings, total: performance.now() - start }, candidates: [...candidates.values()] } : undefined;
    },
  };
}
