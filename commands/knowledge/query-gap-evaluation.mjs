import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest, searchKnowledge } from "./store.mjs";
import { withKnowledgeLock } from "./sync.mjs";
import { reviewQueryGap, queryGapReport } from "./query-gaps.mjs";
import { validateSuite, answerRequest, checkAnswer, validateAnswerReview, scoreReturnedAnchors } from "./evaluation.mjs";
import { reviewAssistantAnswer } from "./evaluation-source-review.mjs";
import { matchesScope } from "./routing.mjs";

const execute = promisify(execFile);
const sourceKinds = new Set(["code-snapshot", "git-file", "landed-patch", "git-commit"]);
const retrievalReasons = new Set(["missing-evidence", "indexing", "ranking", "wrong-scope", "stale-evidence"]);
const localGit = async (root, args, signal) => (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd: root, signal, timeout: 10_000, maxBuffer: 2_000_000 })).stdout;

export function initializeGapEvaluations(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS query_gap_work (gap_key TEXT PRIMARY KEY, at TEXT, body TEXT);
    CREATE TABLE IF NOT EXISTS query_gap_evaluations
      (gap_key TEXT PRIMARY KEY, at TEXT, retry_at INTEGER, fingerprint TEXT, body TEXT);`);
}

function eligibleRecords(store, work, check) {
  return store.db.prepare("SELECT body FROM records WHERE repository=? AND json_extract(body,'$.source.revision')=? AND instr(json_extract(body,'$.text'),?)>0")
    .all(work.repository, check.revision, check.quote).map(row => JSON.parse(row.body))
    .filter(record => sourceKinds.has(record.source.type) && record.paths.includes(check.path) && !record.source.personal);
}

export function gapEvaluationCase(store, work) {
  if (!Array.isArray(work.sourceChecks) || !work.sourceChecks.length) throw new Error("Gap evaluation needs checked source excerpts.");
  const evidence = work.sourceChecks.map(check => ({ label: check.path,
    ids: eligibleRecords(store, work, check).map(record => record.id),
    anchors: [{ repository: work.repository, revision: check.revision, path: check.path, contains: [check.quote] }] }));
  const item = { id: work.evaluationDraft.id, repository: work.repository, question: work.question,
    intent: work.intent || "general", scope: [...new Set(work.sourceChecks.map(check => check.path))].join(", "),
    filters: work.filters || {}, evidence,
    facts: work.sourceChecks.map(check => `Explain the behavior relevant to the question in ${check.path}. Checked source excerpt: ${check.quote}`),
    prohibited: ["Claiming a runtime test passed without test-run evidence.", "Claiming the source excerpt alone proves the answer is correct."],
    anchors: evidence.flatMap(group => group.anchors),
    limits: "Source identity and exact excerpts are independently checked. Expected semantic interpretations require review. This case verifies retrieval of the checked source, not every fact needed by the question." };
  validateSuite({ version: 1, cases: [item] });
  return item;
}

export function scoreGapRetrieval(store, item, result) {
  const coverage = scoreReturnedAnchors(item, result, store);
  const scopeErrors = result.ids.filter(id => {
    const record = store.get(id);
    return !record || record.repository !== item.repository || !matchesScope(record, item.filters);
  });
  const requirements = item.evidence.map((group, index) => ({ label: group.label, available: group.ids.length > 0,
    passed: coverage.requirements[index].passed === true, ids: group.ids,
    matchedSourceIds: coverage.requirements[index].matchedSourceIds, anchors: coverage.requirements[index].anchors }));
  return { pass: !scopeErrors.length && requirements.every(group => group.passed), requirements, scopeErrors,
    contextChars: result.text.length, limits: "Checks the selected source and exact returned excerpt. It does not grade answer meaning." };
}

async function sourceCheck(work, root, git, signal) {
  const sources = [];
  let remaining = 120000;
  const current = (await git(root, ["rev-parse", "HEAD"], signal)).trim();
  if (!/^[a-f0-9]{40}$/.test(current)) throw new Error("Current source revision is unavailable.");
  for (const check of work.sourceChecks) {
    if (!/^[a-f0-9]{40}$/.test(check.revision) || !check.path || check.path.startsWith("/") || check.path.includes("\\") ||
        check.path.split("/").some(part => ["..", ".", ""].includes(part)) || (work.repository === "thunderbird" && check.path.startsWith("suite/"))) throw new Error("Invalid evaluation source anchor.");
    const source = await git(root, ["show", `${check.revision}:${check.path}`], signal);
    if (!source.includes(check.quote)) throw new Error("Evaluation source excerpt no longer matches its anchor.");
    const before = (await git(root, ["rev-parse", `${check.revision}:${check.path}`], signal)).trim();
    const after = (await git(root, ["rev-parse", `${current}:${check.path}`], signal)).trim();
    if (before !== after) throw new Error("Checked source file changed; the gap needs another source assessment.");
    await git(root, ["diff", "--quiet", "HEAD", "--", check.path], signal);
    const text = source.slice(0, Math.max(0, remaining)); remaining -= text.length;
    sources.push({ repository: work.repository, revision: check.revision, path: check.path, text, truncated: text.length !== source.length });
  }
  return { revision: current, sources };
}

export async function runQueryGapEvaluations(store, settings = {}, dependencies = {}) {
  initializeGapEvaluations(store);
  if (settings.enabled === false) return { disabled: true };
  return withKnowledgeLock(store.directory, "learning", async () => {
    const now = (dependencies.now || Date.now)(), day = new Date(now).toISOString().slice(0, 10);
    const groups = new Map(queryGapReport(store, { includeAll: true }).groups.map(group => [group.key, group]));
    const rows = store.db.prepare("SELECT gap_key,body FROM query_gap_work ORDER BY at ASC").all();
    if (!rows.length) return { idle: true };
    const corpus = digest(store.db.prepare("SELECT id FROM records ORDER BY id").all().map(row => row.id));
    let selected;
    for (const row of rows) {
      const group = groups.get(row.gap_key), work = JSON.parse(row.body);
      if (!group || !["confirmed", "resolved"].includes(group.review?.state)) continue;
      const prior = store.db.prepare("SELECT * FROM query_gap_evaluations WHERE gap_key=?").get(row.gap_key);
      const report = prior && JSON.parse(prior.body);
      if (report?.answerReview || report?.humanReview || (report?.answer && !dependencies.provider)) continue;
      if (report?.answer && (store.setting(`calls:${day}`) || 0) >= (dependencies.maxCallsPerDay ?? 4)) continue;
      if (prior?.retry_at > now) continue;
      const signature = digest([work, corpus, dependencies.codeFingerprint || "", dependencies.model || null,
        store.db.prepare("SELECT count(*) AS n FROM section_vectors WHERE model=?").get(dependencies.model || "").n]);
      if (prior?.fingerprint === signature && report?.retrieval?.pass && !dependencies.provider) continue;
      selected = { group, work, signature, previous: report }; break;
    }
    if (!selected) return { idle: true };
    const { group, work, signature, previous } = selected;
    const at = new Date(now).toISOString(), root = work.sourceRoot || group.sourceRoot;
    const report = { version: 1, key: work.key, at, question: work.question, repository: work.repository,
      status: "evaluating", answerQuality: "not-run", provider: dependencies.provider?.configuration || null,
      corpus, codeFingerprint: dependencies.codeFingerprint || null, private: true };
    const save = retry => store.db.prepare("INSERT OR REPLACE INTO query_gap_evaluations VALUES (?, ?, ?, ?, ?)")
      .run(work.key, at, retry, signature, JSON.stringify(report));
    store.setting("query-gap-evaluation-active", { pid: process.pid, key: work.key, startedAt: at, aiRunning: false });
    try {
      if (!root) throw new Error("Source checkout is unavailable for this evaluation.");
      const checked = await sourceCheck(work, root, dependencies.git || localGit, dependencies.signal);
      report.sourceRevision = checked.revision;
      const item = gapEvaluationCase(store, work);
      report.case = item;
      const configuration = { mode: work.mode || group.mode || "exact", model: work.model || group.model || null,
        query: work.query || group.query || work.question, queryParts: work.queryParts || group.queryParts,
        knowledgeRequest: work.knowledgeRequest || group.knowledgeRequest, question: work.question, repository: work.repository,
        originalQueryCaptured: work.queryCaptured === true && !work.queryTruncated && !(work.knowledgeRequest || group.knowledgeRequest)?.questionTruncated,
        filters: work.filters || {}, limit: work.limit || group.limit || 10, maxChars: work.maxContextChars || group.maxContextChars || 10_000 };
      report.configuration = configuration;
      let vector;
      if (configuration.mode === "hybrid") {
        if (!dependencies.embed || configuration.model !== dependencies.model) throw new Error("Original embedding model is unavailable; exact search was not substituted.");
        vector = (await dependencies.embed([configuration.query], 300))?.[0];
        if (!vector?.length) throw new Error("Query embedding is unavailable; exact search was not substituted.");
      }
      dependencies.signal?.throwIfAborted();
      report.corpus = digest(store.db.prepare("SELECT id FROM records ORDER BY id").all().map(row => row.id));
      const result = searchKnowledge(store, { ...configuration, vector, trace: true });
      report.ids = result.ids; report.context = result.text; report.trace = result.trace;
      report.retrieval = scoreGapRetrieval(store, item, result);
      report.baseline = scoreGapRetrieval(store, item, { ids: group.ids, text: work.contextText || group.contextText || "" });
      report.status = report.retrieval.pass ? "retrieval-verified" : "retrieval-failed";
      if (report.retrieval.pass && configuration.originalQueryCaptured && !report.baseline.pass && retrievalReasons.has(work.reason) && group.review.state === "confirmed") {
        reviewQueryGap(store, { ...group.review, state: "resolved", observationId: group.review.observationId,
          checkedBy: "Scheduled retrieval evaluation", evaluationCaseId: item.id, resolutionScope: "retrieval",
          verification: `Original query rerun in ${configuration.mode} mode at ${report.sourceRevision}; every checked source excerpt is present in selected context. This resolves evidence retrieval only. Generated-answer correctness has not been established.` });
        report.resolutionScope = "retrieval";
      }
      const budgetKey = `calls:${day}`;
      const canCall = () => (store.setting(budgetKey) || 0) < (dependencies.maxCallsPerDay ?? 4);
      const reserveCall = () => store.setting(budgetKey, (store.setting(budgetKey) || 0) + 1);
      if (previous?.answer) {
        report.answer = previous.answer; report.answerDigest = previous.answerDigest; report.answerChecks = previous.answerChecks;
        report.answerContext = previous.answerContext || previous.context;
        report.answerRetrieval = previous.answerRetrieval || previous.retrieval;
        report.answerProvider = previous.answerProvider || previous.provider;
      }
      if (!report.answer && report.retrieval.pass && dependencies.provider && canCall()) {
        reserveCall();
        store.setting("query-gap-evaluation-active", { pid: process.pid, key: work.key, startedAt: at, aiRunning: true });
        const answer = await dependencies.provider.generate(answerRequest(item, result.text), { signal: dependencies.signal });
        if (typeof answer !== "string" || !answer.trim() || answer.length > 100_000) throw new Error("Evaluation answer is empty or oversized.");
        report.answer = answer;
        report.answerDigest = digest(report.answer);
        report.answerChecks = checkAnswer(item, report.answer, result.ids, result.text);
        report.answerContext = result.text; report.answerRetrieval = report.retrieval; report.answerProvider = report.provider;
      }
      if (report.answer && dependencies.provider && canCall()) {
        reserveCall();
        store.setting("query-gap-evaluation-active", { pid: process.pid, key: work.key, startedAt: at, aiRunning: true });
        report.answerReview = await reviewAssistantAnswer(dependencies.provider, item, report.answer, report.answerContext, checked.sources, { signal: dependencies.signal });
        if (!report.answerRetrieval.pass || !report.retrieval.pass) report.answerReview.pass = false;
        report.answerQuality = report.answerReview.pass ? "assistant-reviewed-pass" : "assistant-reviewed-fail";
        if (report.answerReview.pass) {
          reviewQueryGap(store, { ...group.review, state: "resolved", observationId: group.review.observationId,
            checkedBy: report.answerReview.reviewer, evaluationCaseId: item.id, resolutionScope: "answer",
            verification: `Saved answer ${report.answerDigest} passed assistant source review in all five dimensions. ${report.answerReview.rationale}` });
          report.resolutionScope = "answer";
        }
      } else if (report.answer) report.answerQuality = "waiting-for-source-review-budget";
      else if (report.retrieval.pass && dependencies.provider) report.answerQuality = "waiting-for-budget";
      report.retrievalWasPreviouslyVerified = previous?.retrieval?.pass || false;
      save(report.retrieval.pass && report.answer ? 0 : now + (settings.retryMs || 3_600_000));
      store.setting("lastQueryGapEvaluation", { key: report.key, at, status: report.status, answerQuality: report.answerQuality });
      return report;
    } catch (error) {
      report.status = "unavailable"; report.error = error.message;
      save(now + (settings.retryMs || 3_600_000));
      store.setting("lastQueryGapEvaluation", { key: report.key, at, status: report.status, error: error.message });
      if (dependencies.signal?.aborted) throw error;
      return report;
    } finally { store.setting("query-gap-evaluation-active", null); }
  });
}

export function gapEvaluationStatus(store) {
  initializeGapEvaluations(store);
  const rows = store.db.prepare("SELECT body FROM query_gap_evaluations ORDER BY at DESC LIMIT 10").all().map(row => JSON.parse(row.body));
  const active = store.setting("query-gap-evaluation-active");
  let running = false;
  if (active?.pid) { try { process.kill(active.pid, 0); running = true; } catch { /* The saved worker stopped. */ } }
  return { running, aiRunning: running && active.aiRunning, active: running ? active : null,
    latest: store.setting("lastQueryGapEvaluation"), reports: rows,
    answerReviews: rows.filter(row => row.answer && !row.answerReview && !row.humanReview).length };
}

export function reviewGapAnswer(store, key, input) {
  initializeGapEvaluations(store);
  const row = store.db.prepare("SELECT body FROM query_gap_evaluations WHERE gap_key=?").get(key);
  if (!row) throw new Error("Gap evaluation not found.");
  const report = JSON.parse(row.body);
  if (!report.answer || input.answerDigest !== report.answerDigest) throw new Error("Review must match the saved answer.");
  report.answerReview = validateAnswerReview(report.case, input);
  if (input.reviewerKind === "human") report.humanReview = report.answerReview;
  if (report.answerReview.pass && (!report.retrieval.pass || report.answerChecks.missingCitation || report.answerChecks.unknownCitations.length)) throw new Error("An answer cannot pass with missing evidence or unsupported citations.");
  report.answerQuality = report.answerReview.pass ? "reviewed-pass" : "reviewed-fail";
  if (report.answerReview.pass) {
    const group = queryGapReport(store, { includeAll: true }).groups.find(group => group.key === key);
    if (group) reviewQueryGap(store, { ...group.review, state: "resolved", observationId: group.review.observationId,
      checkedBy: input.reviewer, evaluationCaseId: report.case.id, resolutionScope: "answer",
      verification: `Saved answer ${report.answerDigest} passed source-based review in all five dimensions. ${input.rationale}` });
  }
  store.db.prepare("UPDATE query_gap_evaluations SET body=? WHERE gap_key=?").run(JSON.stringify(report), key);
  return { key, answerQuality: report.answerQuality, review: report.answerReview };
}
