// Question intent changes ranking only. Explicit scope filters require recorded values.
const questions = {
  implementation: /\bwhere\s+(?:is|are)\b[^?.]*?\b(?:implemented|implementation|defined|located)\b|\bwhere\s+(?:does|do)\b[^?.]*?\b(?:live|reside)\b/gi,
  reason: /\bwhy\s+(?:was|were|is|did|has)\b[^?.]*?\b(?:changed|change|removed|added|replaced)\b/gi,
  testing: /\bhow\s+(?:(?:should|can|do)\s+(?:i|we)\s+|to\s+)(?:test|verify)\b/gi,
};

export function retrievalPlan(question, filters = {}) {
  const explicit = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (!["component", "language", "role", "generated", "imported"].includes(key)) throw new Error(`Unknown knowledge scope filter: ${key}`);
    if (["generated", "imported"].includes(key)) {
      if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
    } else if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`);
    if (key === "role" && !["production", "test"].includes(value)) throw new Error("role must be production or test.");
    explicit[key] = value;
  }
  const intents = Object.entries(questions).filter(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(String(question));
  }).map(([intent]) => intent);
  return {
    intent: intents.length === 1 ? intents[0] : "general",
    filters: explicit,
    explanation: intents.length === 1 ? {
      implementation: "Prefer source maps and implementation observations. Check the recorded revision against current source.",
      reason: "Prefer commits and explicitly accepted review feedback. Acceptance does not establish policy.",
      testing: "Prefer recorded test and harness evidence. Check the harness and affected paths.",
    }[intents[0]] : "Use general search for an ambiguous, mixed, or unrecognized question.",
    scopeLimit: "Explicit filters require matching recorded metadata. Missing or uncertain metadata does not match. Ranking preferences do not exclude other evidence.",
  };
}

export function matchesScope(record, filters) {
  if (!Object.keys(filters).length) return true;
  const source = record.source || {};
  // Inferred file roles in navigation maps are not explicit scope metadata.
  if (source.scopeUncertain === true || source.metadataVerified === false || source.metadataInferred === true) return false;
  const values = { component: record.component ?? source.component, language: source.language,
    role: source.fileRole, generated: source.generated, imported: source.imported };
  return Object.entries(filters).every(([key, value]) => values[key] === value);
}

export function evidencePreference(record, intent, { preferOriginalSources = true } = {}) {
  const source = record.source || {};
  if (intent === "implementation") {
    if (["source-map", "code-snapshot"].includes(source.type)) return { factor: 1.8, reason: "Recorded source map or implementation snapshot." };
    if (/\bstructural source map\b/i.test(record.title || "")) return { factor: 1.5, reason: "Navigation map title; declaration candidates still need source checks." };
  }
  if (intent === "reason") {
    if (["git-commit", "commit", "git-history", "landed-patch"].includes(source.type)) return { factor: 1.8, reason: "Recorded commit evidence." };
    if (source.type === "review-feedback" && source.accepted === true && source.reverted !== true) return { factor: 1.8, reason: "Review feedback explicitly records acceptance." };
  }
  if (intent === "testing" && (source.fileRole === "test" || ["test", "test-result", "test-harness"].includes(source.type))) {
    return { factor: 1.8, reason: "Recorded test role, result, or harness." };
  }
  if (preferOriginalSources && source.type === "agent-turn") return { factor: 0.5, reason: "Recorded task transcript; check its original sources before relying on its answer." };
  return { factor: 1, reason: "General matching evidence; no preferred source metadata." };
}
