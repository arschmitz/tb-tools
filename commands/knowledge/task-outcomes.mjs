import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { digest } from "./store.mjs";

const lines = value => String(value ?? "").replaceAll("\r\n", "\n");

export function compareReviewFinding(issue, discussion = {}) {
  const original = issue.originalUnavailable ? null : issue.originalSuggestion;
  const local = issue.postedDraft;
  const inlineId = local?.inlineId || issue.savedDraft?.inlineId;
  const matches = inlineId ? (discussion.inlineComments || []).filter(comment =>
    String(comment.commentId || comment.id) === String(inlineId)) : [];
  const remote = discussion.available === true && !discussion.historyTruncated && matches.length === 1 ? matches[0] : null;
  const posted = remote ? { comment: remote.content, code: remote.codeSuggestion?.content || "",
    hasCode: Boolean(remote.codeSuggestion), inlineId, url: remote.url } : local;
  return {
    findingKey: issue.findingKey || "", rating: issue.feedback?.rating || "", reason: issue.feedback?.reason || "",
    publication: remote ? "observed-posted" : local ? "console-published" : issue.state === "pending" ? "draft-only"
      : issue.state === "skipped" ? "not-posted" : "unknown",
    comment: !original || !posted ? "unknown" : lines(original.comment) === lines(posted.comment) ? "unchanged" : "edited",
    code: !original || !posted ? "unknown" : !original.hasCode ? (posted.hasCode ? "added" : "not-supplied")
      : !posted.hasCode ? "omitted" : lines(original.code) === lines(posted.code) ? "unchanged" : "edited",
    posted: posted || null,
    replies: remote ? (discussion.inlineComments || []).filter(comment => comment.replyToCommentPHID === remote.id) : [],
    limits: "Posting and ratings do not establish correctness. Missing original text cannot be reconstructed from an edited draft.",
  };
}

export function compareUpdateReply(item, discussion) {
  const saved = item.savedReply;
  return compareReviewFinding({ findingKey: item.id, state: item.draftSaved ? "pending" : "ready",
    originalSuggestion: saved ? { comment: saved.suggestedComment, hasCode: false, code: "" } : null,
    savedDraft: saved ? { comment: saved.comment, hasCode: false, code: "", inlineId: saved.inlineId } : null,
  }, discussion);
}

export function taskSnapshot(kind, state, resolveIdentity = value => value) {
  const identity = resolveIdentity(state.tbToolsId || String(state.commitMessage || "").match(/^TB-Tools-Id:\s*(\S+)\s*$/im)?.[1] || "");
  const revision = state.revision?.match(/^D\d+$/)?.[0] ||
    (String(state.commitMessage || "").match(/^Differential Revision:\s*(https?:\/\/\S+\/D\d+)\s*$/im)?.[1] || identity)
      .match(/\/(D\d+)$/)?.[1] || "";
  const findings = new Map();
  for (const issue of [...(state.findingHistory || []), ...(state.issues || [])]) {
    findings.set(issue.findingKey || issue.id, issue);
  }
  return {
    kind, id: state.id, revision, bugId: String(state.bugId || state.commitMessage?.match(/\bBug\s+(\d+)/i)?.[1] || ""),
    revisionHash: state.currentHash || state.commitHash || "", patchHash: state.rawPatchHash || "",
    tbToolsId: identity, createdAt: state.createdAt || "", updatedAt: state.updatedAt || "",
    status: state.status || state.phase || "", threadIds: [state.codexSessionId, ...Object.values(state.threads || {})]
      .map(value => typeof value === "string" ? value : value?.id).filter(Boolean),
    findings: [...findings.values()].map(issue => Object.fromEntries([
      "id", "findingKey", "title", "filePath", "lineNumber", "lineLength", "state", "suggestedComment", "codeSuggestion",
      "isDeletion", "rationale", "validation", "originalSuggestion", "originalUnavailable", "savedDraft", "postedDraft", "feedback",
    ].filter(key => issue[key] !== undefined).map(key => [key, issue[key]]))),
    feedbackHistory: state.findingFeedbackHistory || [],
    updates: state.items || [], reports: state.reports || [],
    reviewOutcome: state.reviewOutcome || "", reviewMessage: state.reviewMessage || "",
  };
}

export async function captureSavedTaskOutcomes(store, { taskDirectory = path.join(os.homedir(), ".tb-tools"), limit = 10 } = {}) {
  if (process.env.NODE_TEST_CONTEXT && taskDirectory === path.join(os.homedir(), ".tb-tools")) return { captured: 0, tasks: 0 };
  const tasks = store.setting("follow-up-tasks") || {};
  // Standalone knowledge copies can read task evidence without console helpers.
  const identityHelpers = await import("../../lib/patch-identity.mjs").catch(error => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  });
  let captured = 0;
  for (const [directory, defaultKind] of [["patch-sessions", ""], ["implementations", "implement"]]) {
    const root = path.join(taskDirectory, directory);
    const names = await readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      if (captured >= limit) break;
      const file = path.join(root, name), stat = await lstat(file);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      const key = `task-file:${digest(file)}`;
      if (store.setting(key) === fingerprint) continue;
      const saved = JSON.parse(await readFile(file, "utf8"));
      const kind = defaultKind || (saved.kind === "review" ? "review" : saved.data?.mode || "update");
      const state = saved.data || saved;
      if (!state.id) continue;
      if (saved.graphPath && !/[/\\]comm[/\\]?$/.test(saved.graphPath)) continue;
      const snapshot = taskSnapshot(kind, state, identityHelpers.resolvePatchIdentity), text = JSON.stringify(snapshot);
      if (text.length > 1_900_000) continue;
      const record = await store.put({ kind: "evidence", repository: "thunderbird", visibility: "private",
        at: new Date().toISOString(), title: `${kind} outcome: ${snapshot.revision || `Bug ${snapshot.bugId}`}`,
        paths: [...new Set(snapshot.findings.map(issue => issue.filePath).filter(Boolean))], text,
        source: { type: "task-outcome", personal: true, revision: snapshot.revisionHash, taskId: snapshot.id, taskKind: kind,
          reference: `saved-task:${kind}:${snapshot.id}` } });
      tasks[`${kind}:${state.id}`] = record.id;
      store.setting("follow-up-tasks", tasks);
      store.setting(key, fingerprint);
      captured++;
    }
  }
  return { captured, tasks: Object.keys(tasks).length };
}
