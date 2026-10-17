import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { compareReviewFinding, compareUpdateReply, captureSavedTaskOutcomes, taskSnapshot } from "../commands/knowledge/task-outcomes.mjs";
import { completeFollowUpHistory, historyCompletion, runKnowledgeFollowUp } from "../commands/knowledge/follow-up.mjs";
import { rateGraphPatchReviewFinding } from "../commands/graph/patch-review-feedback.mjs";
import { addGraphPatchReviewInline, submitGraphPatchReview } from "../commands/graph/patch-review.mjs";
import { createPatchSessionStore } from "../commands/graph/patch-session-store.mjs";
import { saveGraphPatchUpdateReply } from "../commands/graph/patch-update.mjs";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const message = "Bug 22 - Correct the return\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123\n";
async function storeFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-outcomes-"));
  const store = await openKnowledgeStore(path.join(directory, "knowledge"));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}
async function completedHistory(store) {
  const record = await store.put({ kind: "evidence", repository: "thunderbird", visibility: "private",
    at: new Date().toISOString(), paths: [], text: JSON.stringify({ fullSecondPassComplete: true, contiguousThrough: 1, total: 1 }),
    source: { type: "history-study-completion", revision: A, reference: "test manifest completion" } });
  completeFollowUpHistory(store, record.id);
  return record;
}
function review() {
  return { id: "review-id", aiEnabled: true, graph: { path: "/review/comm" }, revision: "D123", currentHash: B,
    rawPatchHash: "raw-one", status: "review", currentIssueIndex: 0,
    issues: [{ id: "one", filePath: "mail/file.mjs", lineNumber: 1, state: "ready",
      suggestedComment: "Original comment", codeSuggestion: "return fixed;" }] };
}

test("ratings survive saving and edited drafts retain the generated comment and code", async t => {
  const { directory, store } = await storeFor(t), session = review();
  rateGraphPatchReviewFinding({ session, itemId: "one", rating: "up", reason: "Confirmed with a test" });
  await addGraphPatchReviewInline({ session, itemId: "one", kind: "comment", message: "Edited comment",
    createInlineComment: async () => ({ inlineId: 17 }) });
  assert.equal(session.issues[0].originalSuggestion.comment, "Original comment");
  assert.equal(session.issues[0].originalSuggestion.code, "return fixed;");
  assert.equal(compareReviewFinding(session.issues[0]).publication, "draft-only");
  await submitGraphPatchReview({ session, outcome: "comment", publishReview: async () => {} });
  const comparison = compareReviewFinding(session.issues[0]);
  assert.equal(comparison.comment, "edited");
  assert.equal(comparison.code, "omitted");
  const sessions = path.join(directory, "patch-sessions");
  createPatchSessionStore({ directory: sessions }).save("review", session);
  const captured = await captureSavedTaskOutcomes(store, { taskDirectory: directory });
  assert.equal(captured.captured, 1);
  const snapshot = JSON.parse(store.get(store.setting("follow-up-tasks")["review:review-id"]).text);
  assert.equal(snapshot.findings[0].feedback.rating, "up");
  assert.equal(snapshot.findings[0].postedDraft.comment, "Edited comment");
  assert.equal((await captureSavedTaskOutcomes(store, { taskDirectory: directory })).captured, 0);
  const saved = JSON.parse(await readFile(path.join(sessions, (await readdir(sessions))[0]), "utf8"));
  rateGraphPatchReviewFinding({ session: saved.data, itemId: "one", rating: "down", reason: "Later evidence disproved it" });
  assert.equal(saved.data.findingFeedbackHistory.length, 2);
  rateGraphPatchReviewFinding({ session: saved.data, itemId: "one", rating: "" });
  assert.equal(saved.data.issues[0].feedback.rating, "");
});

test("publication failure does not manufacture posted feedback or an original legacy suggestion", async () => {
  const session = review();
  await addGraphPatchReviewInline({ session, itemId: "one", kind: "suggestion", message: "Original comment",
    codeSuggestion: "return edited;", createInlineComment: async () => ({ inlineId: 18 }) });
  await assert.rejects(submitGraphPatchReview({ session, outcome: "comment", publishReview: async () => { throw new Error("failed"); } }));
  assert.equal(compareReviewFinding(session.issues[0]).publication, "draft-only");
  assert.equal(session.issues[0].postedDraft, undefined);
  const legacy = review(); legacy.issues[0].state = "posted";
  rateGraphPatchReviewFinding({ session: legacy, itemId: "one", rating: "down" });
  assert.equal(compareReviewFinding(legacy.issues[0]).comment, "unknown");
  assert.equal(legacy.issues[0].originalUnavailable, true);
  assert.throws(() => rateGraphPatchReviewFinding({ session, itemId: "one", rating: "yes" }));
});

test("remote inline IDs link edited code and author replies without guessing from similar text", () => {
  const issue = { originalSuggestion: { comment: "Comment", hasCode: true, code: "return fixed;" },
    savedDraft: { inlineId: 17 }, state: "pending" };
  const result = compareReviewFinding(issue, { available: true, inlineComments: [
    { id: "PHID-original", commentId: "17", content: "Comment", codeSuggestion: { content: "return edited;" } },
    { id: "PHID-reply", replyToCommentPHID: "PHID-original", content: "This loses the null case." },
  ] });
  assert.equal(result.publication, "observed-posted");
  assert.equal(result.code, "edited");
  assert.equal(result.replies.length, 1);
  assert.equal(compareReviewFinding(issue, { available: true, inlineComments: [{ content: "Comment" }] }).publication, "draft-only");
});

test("Update replies compare the generated text with the published reply ID", () => {
  const item = { id: "reply", state: "ready", suggestedReply: "Generated reply" };
  const session = { items: [item], currentItemIndex: 0 };
  saveGraphPatchUpdateReply({ session, itemId: "reply", message: "Edited reply", receipt: { inlineId: 29 } });
  item.suggestedReply = "Later reassessment";
  const result = compareUpdateReply(item, { available: true, inlineComments: [{ commentId: "29", content: "Edited reply" }] });
  assert.equal(result.publication, "observed-posted");
  assert.equal(result.comment, "edited");
  assert.equal(item.savedReply.suggestedComment, "Generated reply");
});

test("follow-up waits for full history and cannot accept partial or mismatched completion", async t => {
  const { store } = await storeFor(t);
  let calls = 0;
  assert.equal((await runKnowledgeFollowUp(store, { repositoryPath: "/source" }, { git: async () => { calls++; } })).waitingForHistory, true);
  assert.equal(calls, 0);
  const manifest = await store.put({ kind: "evidence", repository: "thunderbird", at: new Date().toISOString(), paths: [],
    text: JSON.stringify({ commits: [A, B] }), source: { type: "history-study-manifest", revision: A } });
  store.setting("thunderbird-history-deep-pass", { manifestEvidence: manifest.id, contiguousThrough: 1, fullSecondPassComplete: true });
  assert.equal(historyCompletion(store), null);
  await assert.rejects(completedHistory(store), /does not match/);
});

test("bounded ingestion resumes its cursor, joins task evidence, and enforces the daily budget", async t => {
  const { store, directory } = await storeFor(t);
  await completedHistory(store);
  await mkdir(path.join(directory, "patch-sessions"));
  const session = review();
  rateGraphPatchReviewFinding({ session, itemId: "one", rating: "up" });
  await addGraphPatchReviewInline({ session, itemId: "one", kind: "suggestion", message: "Original comment",
    createInlineComment: async () => ({ inlineId: 17 }) });
  await submitGraphPatchReview({ session, outcome: "comment", publishReview: async () => {} });
  await writeFile(path.join(directory, "patch-sessions", "review.json"), JSON.stringify({ kind: "review", graphPath: "/source/comm", data: session }));
  await captureSavedTaskOutcomes(store, { taskDirectory: directory });
  const git = async args => {
    if (args[0] === "fetch" || args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return C;
    if (args[0] === "rev-list") return args.at(-1).startsWith(A) ? `${B}\n${C}` : C;
    if (args[0] === "diff-tree") return "mail/file.mjs";
    if (args[0] === "show") return args.includes("--no-patch") ? message : "@@ -1 +1 @@\n-old\n+return fixed;";
    if (args[0] === "log") return args.some(arg => arg.startsWith("--grep=" + B.slice(0, 12)))
      ? `${"d".repeat(40)}\0Backed out ${B.slice(0, 12)} for test failures\0` : `${B}\0${message}\0`;
    throw new Error(`Unexpected command ${args}`);
  };
  let lookups = 0;
  const dependencies = { git, now: () => Date.parse("2026-10-10T12:00:00Z"), force: true,
    getReview: async () => { lookups++; return { available: true, comments: [], inlineComments: [] }; },
    getBug: async id => { lookups++; return { id, regressions: [] }; }, getBugComments: async () => { lookups++; return []; } };
  const options = { repositoryPath: "/source", maxCommitsPerRun: 1, maxTasksPerRun: 1, maxRemoteLookupsPerRun: 4 };
  const first = await runKnowledgeFollowUp(store, options, dependencies);
  assert.equal(first.commits, 1); assert.equal(first.cursor, B); assert.equal(first.remainingCommits, 1);
  assert.ok(first.remoteLookups <= 4);
  const outcome = JSON.parse(store.get(store.setting("follow-up-latest:review:review-id")).text);
  assert.equal(outcome.findings[0].code, "unchanged");
  assert.equal(outcome.findings[0].suggestionTextInLandedPatch, "present");
  assert.equal(outcome.backouts.length, 1);
  assert.equal(store.get(store.setting("follow-up-latest:review:review-id")).visibility, "private");
  const second = await runKnowledgeFollowUp(store, options, dependencies);
  assert.equal(second.cursor, C);
  const priorLookups = lookups;
  assert.equal((await runKnowledgeFollowUp(store, options, dependencies)).budgetReached, true);
  assert.equal(lookups, priorLookups);
});

test("real Git follow-up reads the selected branch without changing the checkout", async t => {
  const { store, directory } = await storeFor(t);
  const repo = path.join(directory, "comm"); await mkdir(repo);
  const execute = promisify(execFile);
  const git = async args => (await execute("git", args, { cwd: repo })).stdout.trim();
  await git(["init", "-b", "main"]); await git(["config", "user.name", "Test"]); await git(["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repo, "file.mjs"), "old\n"); await git(["add", "."]); await git(["commit", "-m", "Initial source"]);
  const baseline = await git(["rev-parse", "HEAD"]);
  const completion = await store.put({ kind: "evidence", repository: "thunderbird", at: new Date().toISOString(), paths: [],
    text: JSON.stringify({ fullSecondPassComplete: true, contiguousThrough: 1, total: 1 }),
    source: { type: "history-study-completion", revision: baseline } });
  completeFollowUpHistory(store, completion.id);
  await writeFile(path.join(repo, "file.mjs"), "fixed\n"); await git(["add", "."]); await git(["commit", "-m", message]);
  const landed = await git(["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "file.mjs"), "old\n"); await git(["add", "."]); await git(["commit", "-m", `Backed out ${landed.slice(0, 12)} for a failure`]);
  const target = await git(["rev-parse", "HEAD"]);
  const task = await store.put({ kind: "evidence", repository: "thunderbird", at: new Date().toISOString(), paths: ["file.mjs"],
    text: JSON.stringify({ kind: "review", id: "actual", revision: "D123", revisionHash: landed, findings: [] }), source: { type: "task-outcome" } });
  store.setting("follow-up-tasks", { "review:actual": task.id });
  const result = await runKnowledgeFollowUp(store, { repositoryPath: repo, ref: "HEAD", maxTasksPerRun: 1 }, {
    getReview: async () => ({ available: true, inlineComments: [], comments: [] }), force: true,
  });
  assert.equal(result.commits, 2);
  const observation = JSON.parse(store.get(store.setting("follow-up-latest:review:actual")).text);
  assert.equal(observation.landings[0].revision, landed);
  assert.equal(observation.backouts[0].revision, target);
  assert.equal(await git(["rev-parse", "HEAD"]), target);
  assert.equal(await git(["status", "--porcelain"]), "");
  assert.equal(taskSnapshot("implement", { id: "task", tbToolsId: "https://phabricator.services.mozilla.com/D456", reports: [] }).revision, "D456");
});
