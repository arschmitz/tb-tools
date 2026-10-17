function ascendingIndices(indices) {
  return Array.isArray(indices) && indices.length > 0 && indices.every((index, offset) =>
    Number.isSafeInteger(index) && index > 0 && (!offset || index > indices[offset - 1]));
}

// A batch lists only its selected rows. Missing neighbors do not gain coverage.
export function sparsePublicationCoverage(rows) {
  const coverage = [...rows].sort((a, b) => a.index - b.index);
  const selectedIndices = coverage.map(row => row.index);
  if (!ascendingIndices(selectedIndices)) throw new Error("Invalid publication entry indices.");

  return { range: { start: selectedIndices[0], end: selectedIndices.at(-1) }, selectedIndices, coverage };
}

export function validatePublicationSelection(batch, { partial = false } = {}) {
  const { range, coverage, selectedIndices } = batch;
  if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end) ||
      range.start < 1 || range.end < range.start || !Array.isArray(coverage) || !coverage.length) {
    throw new Error("Invalid publication range.");
  }
  const indices = coverage.map(row => row.index).sort((a, b) => a - b);
  if (!ascendingIndices(indices) || indices[0] !== range.start || indices.at(-1) !== range.end) {
    throw new Error("Publication rows differ from the declared range.");
  }

  if (selectedIndices !== undefined) {
    if (!partial || !ascendingIndices(selectedIndices) || selectedIndices.length !== indices.length ||
        selectedIndices.some((index, offset) => index !== indices[offset])) {
      throw new Error("Publication rows differ from the explicit selection.");
    }
  } else if (indices.length !== range.end - range.start + 1) {
    throw new Error("Dense publication coverage has a gap.");
  }
  return indices;
}

// Group ready work across gaps while retaining each draft as an atomic input.
export function selectIngestionBatch(drafts, now, {
  minimum = 5, maximum = 10, flushAfterMs = 120000, deadline = Infinity,
} = {}) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(minimum) || minimum < 1 ||
      !Number.isSafeInteger(maximum) || maximum < minimum ||
      !Number.isSafeInteger(flushAfterMs) || flushAfterMs < 0 ||
      !(Number.isFinite(deadline) || deadline === Infinity)) {
    throw new Error("Invalid ingestion batch options.");
  }
  if (now >= deadline) return [];

  const ready = Object.values(drafts).filter(draft => !draft.job && draft.status !== "awaiting-input-correction");
  const seen = new Set();
  for (const draft of ready) {
    if (!ascendingIndices(draft.indices) || draft.indices.length > maximum || !Number.isFinite(Date.parse(draft.savedAt))) {
      throw new Error("Invalid ready draft metadata.");
    }
    for (const index of draft.indices) {
      if (seen.has(index)) throw new Error("Duplicate ready entry assignment.");
      seen.add(index);
    }
  }
  ready.sort((a, b) => a.indices[0] - b.indices[0]);

  const selected = [];
  let count = 0;
  for (const draft of ready) {
    if (count + draft.indices.length > maximum) break;
    selected.push(draft);
    count += draft.indices.length;
  }
  if (!selected.length) return [];

  const oldest = Math.min(...selected.map(draft => Date.parse(draft.savedAt)));
  const shouldFlush = now - oldest >= flushAfterMs || deadline - now <= flushAfterMs;
  return count >= minimum || shouldFlush ? selected : [];
}
