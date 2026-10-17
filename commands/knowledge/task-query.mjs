import { retrievalPlan } from "./routing.mjs";

const kinds = new Set(["question", "symbols", "paths"]);
const string = (value, name) => {
  if (typeof value !== "string") throw new Error(`Knowledge ${name} must be a string.`);
  return value.trim();
};

function list(value, name, maxLength) {
  if (!Array.isArray(value)) throw new Error(`Knowledge ${name} must be an array.`);
  const selected = new Set();
  for (const item of value) {
    const entry = string(item, name);
    if (entry.length > maxLength) throw new Error(`Knowledge ${name} entries exceed ${maxLength} characters.`);
    if (entry) selected.add(entry);
    if (selected.size === 100) break;
  }
  return [...selected];
}

// Keep the task request separate from instructions added by later workflow phases.
export function normalizeKnowledgeRequest(input = {}, fallback = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Knowledge request must be an object.");
  const question = string(input.question ?? fallback.question ?? "", "question");
  return {
    question: question.slice(0, 6000),
    questionTruncated: input.questionTruncated === true || question.length > 6000,
    taskType: string(input.taskType ?? fallback.taskType ?? "", "task type").slice(0, 80),
    paths: list(input.paths ?? [], "paths", 4096),
    symbols: list(input.symbols ?? [], "symbols", 512),
    revision: string(input.revision ?? fallback.revision ?? "", "revision").slice(0, 200),
    filters: retrievalPlan(question, input.filters ?? {}).filters,
  };
}

function joinValues(values) {
  const selected = [];
  let size = 0;
  for (const value of values) {
    if (size + value.length + 1 > 6000) continue;
    selected.push(value);
    size += value.length + 1;
  }
  return selected.join(" ");
}

export function taskQueryParts(request) {
  return [
    { kind: "question", query: request.question },
    { kind: "symbols", query: joinValues(request.symbols) },
    { kind: "paths", query: joinValues(request.paths) },
  ].filter(part => part.query.trim());
}

// Saved parts reproduce the exact candidate searches used by the original task.
export function normalizeQueryParts(parts) {
  if (parts === undefined) return undefined;
  if (!Array.isArray(parts) || parts.length > 3) throw new Error("Knowledge query needs at most three parts.");
  const seen = new Set();
  return parts.map(part => {
    if (!part || !kinds.has(part.kind) || seen.has(part.kind)) throw new Error("Knowledge query part is unknown or repeated.");
    const query = string(part.query, "query part");
    if (!query || query.length > 6000) throw new Error("Knowledge query parts must contain 1 to 6000 characters.");
    seen.add(part.kind);
    return { kind: part.kind, query };
  });
}
