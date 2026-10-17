import { randomUUID } from "node:crypto";
import { digest } from "./store.mjs";
import { normalizeKnowledgeRequest, normalizeQueryParts } from "./task-query.mjs";

const reasons = new Set(["missing-evidence", "indexing", "ranking", "wrong-scope", "missing-exception", "stale-evidence", "answer-misuse"]);
const states = new Set(["confirmed", "dismissed", "resolved"]);

// These tables contain private diagnostics, not evidence for search or learning.
export function initializeQueryGaps(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS query_observations
    (id TEXT PRIMARY KEY, gap_key TEXT, at TEXT, body TEXT);
    CREATE INDEX IF NOT EXISTS query_observations_group ON query_observations(gap_key, at);
    CREATE TABLE IF NOT EXISTS query_gap_reviews
    (gap_key TEXT PRIMARY KEY, observation_id TEXT, at TEXT, body TEXT);`);
}

export function captureQueryObservation(store, input, { now = () => new Date().toISOString(), maxObservations = 1000 } = {}) {
  initializeQueryGaps(store);
  const knowledgeRequest = input.knowledgeRequest === undefined ? undefined : normalizeKnowledgeRequest(input.knowledgeRequest);
  const queryParts = normalizeQueryParts(input.queryParts);
  const question = knowledgeRequest?.question ?? String(input.question || "").slice(-6000);
  if (!question.trim() || !input.repository) return null;
  const body = { repository: input.repository, revision: input.revision || "", question,
    ...(knowledgeRequest ? { knowledgeRequest } : {}), ...(queryParts ? { queryParts } : {}),
    queryCaptured: input.query !== undefined, queryTruncated: String(input.query || "").length > 20_000,
    query: String(input.query || input.question || "").slice(-20_000), contextText: String(input.text || "").slice(0, 24_000),
    limit: input.limit || 10, sourceRoot: input.root || "", paths: (input.paths || []).slice(0, 100), filters: input.filters || {},
    ids: [...new Set(input.ids || [])].slice(0, 100), mode: input.mode || "exact",
    model: input.model || null, maxContextChars: input.maxContextChars || null,
    retrieval: input.retrieval || null, applicability: (input.applicability || []).slice(0, 6),
    signals: [] };
  if (!body.ids.length) body.signals.push("no-results");
  if (body.applicability.some(item => item.state.startsWith("Scoped files changed"))) body.signals.push("changed-source");
  const identity = [body.repository, body.revision, question.trim().replace(/\s+/g, " ").toLowerCase(), body.filters];
  if (knowledgeRequest || queryParts) identity.push({ knowledgeRequest, queryParts });
  const key = digest(identity);
  const id = randomUUID(), at = now();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("INSERT INTO query_observations VALUES (?, ?, ?, ?)").run(id, key, at, JSON.stringify(body));
    store.db.prepare(`DELETE FROM query_observations WHERE id IN
      (SELECT id FROM query_observations ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
      .run(Math.max(1, Math.min(10000, Number(maxObservations) || 1000)));
    store.db.exec("DELETE FROM query_gap_reviews WHERE gap_key NOT IN (SELECT gap_key FROM query_observations); COMMIT");
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
  return id;
}

export function captureQueryOutcome(store, observationId, { status, threadId, turnId, evidenceId }) {
  initializeQueryGaps(store);
  const row = store.db.prepare("SELECT body FROM query_observations WHERE id=?").get(observationId);
  if (!row) return false;
  const body = JSON.parse(row.body);
  body.outcome = { status, threadId, turnId, evidenceId };
  store.db.prepare("UPDATE query_observations SET body=? WHERE id=?").run(JSON.stringify(body), observationId);
  return true;
}

export function queryGapReport(store, { repository, includeAll = false } = {}) {
  initializeQueryGaps(store);
  const groups = new Map();
  const rows = store.db.prepare("SELECT * FROM query_observations ORDER BY at DESC, rowid DESC").all();
  for (const row of rows) {
    const body = JSON.parse(row.body);
    if (repository && body.repository !== repository) continue;
    if (!groups.has(row.gap_key)) {
      const review = store.db.prepare("SELECT body FROM query_gap_reviews WHERE gap_key=?").get(row.gap_key);
      groups.set(row.gap_key, { key: row.gap_key, observationId: row.id, lastAt: row.at, count: 0,
        ...body, review: review ? JSON.parse(review.body) : null });
    }
    groups.get(row.gap_key).count++;
  }
  return { private: true, automaticScans: false,
    groups: [...groups.values()].filter(group => includeAll || group.signals.length || group.review)
      .sort((a, b) => Number(b.review?.state === "confirmed") - Number(a.review?.state === "confirmed") || b.count - a.count || b.lastAt.localeCompare(a.lastAt)) };
}

export function reviewQueryGap(store, input) {
  initializeQueryGaps(store);
  if (!states.has(input.state)) throw new Error("Gap state must be confirmed, dismissed, or resolved.");
  if (!reasons.has(input.reason)) throw new Error("Gap review needs a supported reason.");
  for (const field of ["explanation", "checkedBy", "verification"]) {
    if (typeof input[field] !== "string" || !input[field].trim() || input[field].length > 6000) throw new Error(`Gap review needs ${field} (at most 6000 characters).`);
  }
  const row = store.db.prepare("SELECT * FROM query_observations WHERE id=?").get(input.observationId);
  if (!row) throw new Error("Query observation not found or expired.");
  const observation = JSON.parse(row.body);
  if (!Array.isArray(input.evidenceIds)) throw new Error("Gap review needs an evidenceIds array.");
  const evidenceIds = [...new Set(input.evidenceIds)];
  if (evidenceIds.some(id => store.get(id)?.repository !== observation.repository)) throw new Error("Review evidence must exist in the observation repository.");
  if (input.state === "resolved" && !input.evaluationCaseId) throw new Error("Resolution needs an evaluation case ID and a checked rerun in verification.");
  const review = { state: input.state, reason: input.reason, explanation: input.explanation,
    checkedBy: input.checkedBy, verification: input.verification, evidenceIds,
    resolutionScope: input.resolutionScope || null, observationId: row.id, evaluationCaseId: input.evaluationCaseId || null, at: new Date().toISOString() };
  store.db.prepare("INSERT OR REPLACE INTO query_gap_reviews VALUES (?, ?, ?, ?)")
    .run(row.gap_key, row.id, review.at, JSON.stringify(review));
  return { key: row.gap_key, ...review };
}

// Drafts require source checking before they can enter the evaluation suite.
export function queryGapWork(store, key) {
  const group = queryGapReport(store, { includeAll: true }).groups.find(item => item.key === key);
  if (!group || group.review?.state !== "confirmed") throw new Error("Work drafts require a confirmed gap.");
  const scan = ["missing-evidence", "missing-exception", "stale-evidence"].includes(group.review.reason);
  return { private: true, executable: false, key, action: scan ? "focused-source-check" : "retrieval-or-answer-fix",
    repository: group.repository, revision: group.revision, paths: group.paths, question: group.question,
    sourceRoot: group.sourceRoot, query: group.query, queryParts: group.queryParts, knowledgeRequest: group.knowledgeRequest,
    queryCaptured: group.queryCaptured, queryTruncated: group.queryTruncated, contextText: group.contextText, mode: group.mode, model: group.model,
    limit: group.limit, maxContextChars: group.maxContextChars, intent: group.retrieval?.intent,
    filters: group.filters, reason: group.review.reason, explanation: group.review.explanation,
    verification: group.review.verification, evidenceIds: group.review.evidenceIds,
    instructions: "Check existing scan coverage first. Verify original sources and scope. Publish only eligible verified project evidence. Add a checked evaluation case and rerun it before marking this gap resolved.",
    evaluationDraft: { id: `query-gap-${key.slice(0, 16)}`, question: group.question, repository: group.repository,
      evidenceIds: group.review.evidenceIds, requiredFacts: [], prohibitedClaims: [],
      ready: false, limits: "Fill required facts, exceptions, source anchors, and verification limits from checked evidence. This is not a validated evaluation case." } };
}
