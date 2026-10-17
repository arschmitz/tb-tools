import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { digest } from "./store.mjs";
import { withKnowledgeLock } from "./sync.mjs";
import { compareReviewFinding, compareUpdateReply } from "./task-outcomes.mjs";

const execute = promisify(execFile);
const DAY = 86_400_000;
const hashPattern = /^[a-f0-9]{40}$/;

function readBoundedDiff(revision, { cwd, maxChars, timeout, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "show", "--format=", "--first-parent", "--no-ext-diff", revision],
      { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let diff = "", size = 0, errors = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { size += chunk.length; diff += chunk.slice(0, Math.max(0, maxChars - diff.length)); });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-1600); });
    const timer = setTimeout(() => child.kill(), Math.max(1, timeout));
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Follow-up diff read failed (${code}): ${errors}`));
      else resolve({ diff, truncated: size > maxChars });
    });
  });
}

export function followUpOptions(input = {}) {
  const bounded = (value, fallback, max) => Math.max(1, Math.min(max, Number(value) || fallback));
  return { enabled: input.enabled !== false, cadence: ["daily", "weekly", "monthly"].includes(input.cadence) ? input.cadence : "weekly",
    repositoryPath: input.repositoryPath || "", ref: input.ref || "refs/remotes/origin/HEAD",
    taskDirectory: input.taskDirectory,
    maxCommitsPerRun: bounded(input.maxCommitsPerRun, 20, 200), maxTasksPerRun: bounded(input.maxTasksPerRun, 5, 50),
    maxRemoteLookupsPerRun: bounded(input.maxRemoteLookupsPerRun, 10, 100), maxRunMs: bounded(input.maxRunMs, 60_000, 300_000),
    maxRunsPerDay: bounded(input.maxRunsPerDay, 2, 24),
    maxDiffChars: bounded(input.maxDiffChars, 100_000, 500_000) };
}

export function historyCompletion(store) {
  const explicit = store.setting("follow-up-history-completion");
  if (explicit) return explicit;
  const study = store.setting("thunderbird-history-deep-pass");
  const manifest = study?.manifestEvidence && store.get(study.manifestEvidence);
  if (!manifest) return null;
  const contents = JSON.parse(manifest.text);
  if (study.fullSecondPassComplete !== true || study.contiguousThrough < contents.commits.length) return null;
  return { revision: manifest.source.revision, evidence: study.checkpointEvidence, manifestEvidence: manifest.id };
}

export function completeFollowUpHistory(store, evidenceId) {
  const evidence = store.get(evidenceId);
  if (!evidence || evidence.repository !== "thunderbird" || evidence.kind !== "evidence" ||
      evidence.source.type !== "history-study-completion" || !hashPattern.test(evidence.source.revision)) {
    throw new Error("Supply a Thunderbird history-study-completion evidence record with an exact revision.");
  }
  const proof = JSON.parse(evidence.text);
  if (proof.fullSecondPassComplete !== true || !Number.isInteger(proof.total) || proof.total < 1 || proof.contiguousThrough !== proof.total) {
    throw new Error("History completion must cover every entry, including review and bug discussions.");
  }
  const manifestId = store.setting("thunderbird-history-deep-pass")?.manifestEvidence;
  const manifest = manifestId && store.get(manifestId);
  if (manifest && (JSON.parse(manifest.text).commits.length !== proof.total || manifest.source.revision !== evidence.source.revision)) {
    throw new Error("Completion does not match the current history manifest.");
  }
  const completion = { revision: evidence.source.revision, evidence: evidenceId };
  store.setting("follow-up-history-completion", completion);
  return completion;
}

export function revisionInMessage(message) {
  return message.match(/^Differential Revision:\s*https?:\/\/[^\s]+\/(D\d+)\s*$/m)?.[1] || "";
}

export function explicitBackout(message, hashes) {
  if (!/\b(?:backed out|backout|back out|revert(?:ed)?)\b/i.test(message)) return false;
  const references = message.match(/\b[a-f0-9]{12,40}\b/g) || [];
  return hashes.some(hash => references.some(reference => hash.startsWith(reference)));
}

export async function runKnowledgeFollowUp(store, settings = {}, dependencies = {}) {
  const options = followUpOptions(settings);
  if (!options.enabled) return { disabled: true };
  const completion = historyCompletion(store);
  if (!completion) return { waitingForHistory: true, reason: "Finish the current source, review, and bug discussion set first." };
  if (!options.repositoryPath) return { waitingForRepository: true };
  return withKnowledgeLock(store.directory, "outcome-follow-up", async () => {
    const now = dependencies.now || Date.now, started = now();
    const interval = ({ daily: 1, weekly: 7, monthly: 30 })[options.cadence] * DAY;
    const previousRun = store.setting("follow-up-last-run") || 0;
    const day = new Date(started).toISOString().slice(0, 10), usageKey = `follow-up-runs:${day}`;
    const usage = store.setting(usageKey) || 0;
    if (usage >= options.maxRunsPerDay) return { budgetReached: true, runs: usage };
    const window = store.setting("follow-up-window");
    if (!dependencies.force && !window && started - previousRun < interval) return { notDue: true, nextAt: new Date(previousRun + interval).toISOString() };
    store.setting(usageKey, usage + 1);
    const deadline = started + options.maxRunMs;
    let remoteLookups = 0;
    const expired = () => now() >= deadline || dependencies.signal?.aborted;
    const git = dependencies.git || (async args => (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: options.repositoryPath, timeout: Math.max(1, Math.min(30_000, deadline - now())), maxBuffer: 4_000_000,
      signal: dependencies.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })).stdout.trim());
    const remote = async action => {
      if (expired() || remoteLookups >= options.maxRemoteLookupsPerRun) throw new Error("Follow-up lookup or time budget reached.");
      remoteLookups++;
      return action({ signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - now())),
        ...(dependencies.signal ? [dependencies.signal] : [])]) });
    };
    const readDiff = async revision => {
      if (dependencies.git) {
        const diff = await git(["show", "--format=", "--first-parent", "--no-ext-diff", revision]);
        return { diff: diff.slice(0, options.maxDiffChars), truncated: diff.length > options.maxDiffChars };
      }
      return readBoundedDiff(revision, { cwd: options.repositoryPath, maxChars: options.maxDiffChars,
        timeout: Math.min(30_000, deadline - now()), signal: dependencies.signal });
    };
    const result = { commits: 0, tasks: 0, remoteLookups: 0, errors: [], aiCalls: 0 };
    if (!window && options.ref.startsWith("refs/remotes/origin/")) await remote(() => git(["fetch", "--no-tags", "origin"]));
    const target = window?.target || await git(["rev-parse", "--verify", `${options.ref}^{commit}`]);
    store.setting("follow-up-window", { target });
    let cursor = store.setting("follow-up-commit-cursor") || completion.revision;
    if (!hashPattern.test(target) || !hashPattern.test(cursor)) throw new Error("Follow-up needs exact Git revisions.");
    await git(["merge-base", "--is-ancestor", cursor, target]);
    const commits = (await git(["rev-list", "--first-parent", "--reverse", `${cursor}..${target}`])).split("\n").filter(Boolean);
    for (const revision of commits.slice(0, options.maxCommitsPerRun)) {
      if (expired()) break;
      const message = await git(["show", "--no-patch", "--format=%B", revision]);
      const paths = (await git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revision])).split("\n").filter(Boolean);
      const patch = await readDiff(revision);
      const record = await store.put({ kind: "evidence", visibility: "private", repository: "thunderbird",
        at: new Date(now()).toISOString(), title: `Landed patch: ${message.split("\n")[0]}`, paths,
        text: JSON.stringify({ message, ...patch }),
        source: { type: "landed-patch", revision, patch: revisionInMessage(message), reference: `git:${revision}` } });
      store.setting(`landed-patch:${revision}`, record.id);
      const pendingTasks = store.setting("follow-up-tasks") || {};
      pendingTasks[`history:${revision}`] = record.id;
      store.setting("follow-up-tasks", pendingTasks);
      cursor = revision;
      store.setting("follow-up-commit-cursor", cursor);
      result.commits++;
    }
    const taskIds = Object.entries(store.setting("follow-up-tasks") || {}).filter(([key, id]) =>
      store.setting(`follow-up-window-checked:${key}`) !== `${target}:${id}` &&
      !(key.startsWith("history:") && store.setting(`follow-up-history-checked:${key}`) === id)).sort(([a], [b]) =>
      (store.setting(`follow-up-checked:${a}`) || 0) - (store.setting(`follow-up-checked:${b}`) || 0));
    for (const [key, id] of taskIds.slice(0, options.maxTasksPerRun)) {
      if (expired()) break;
      try {
        const evidence = store.get(id);
        if (!evidence) continue;
        const captured = JSON.parse(evidence.text);
        const task = evidence.source.type === "landed-patch" ? { kind: "history", id: evidence.source.revision,
          revision: evidence.source.patch || "", revisionHash: evidence.source.revision,
          bugId: captured.message.match(/\bBug\s+(\d+)/i)?.[1] || "", findings: [], historyEvidence: id } : captured;
        let landings = task.kind === "history" ? [{ revision: task.revisionHash, message: captured.message }] : [];
        // Bug IDs alone cannot identify which implementation or review landed.
        const identity = /^D\d+$/.test(task.revision) ? task.revision : task.tbToolsId;
        if (!landings.length && identity && !identity.startsWith("-")) {
          const log = await git(["log", target, "--fixed-strings", `--grep=${identity}`, "--format=%H%x00%B%x00"]);
          const parts = log.split("\0");
          for (let index = 0; index + 1 < parts.length; index += 2) {
            const revision = parts[index].trim(), message = parts[index + 1];
            if (hashPattern.test(revision) && (revisionInMessage(message) === identity ||
                (!task.revision && message.match(/^TB-Tools-Id:\s*(\S+)\s*$/im)?.[1] === identity))) {
              landings.push({ revision, message });
            }
          }
        }
        if (!landings.length && hashPattern.test(task.revisionHash)) {
          try { await git(["merge-base", "--is-ancestor", task.revisionHash, target]);
            landings = [{ revision: task.revisionHash, message: "Exact task commit is in the checked branch." }];
          } catch (error) { if (error.code !== 1) throw error; }
        }
        const backouts = [];
        if (landings.length) {
          const log = await git(["log", target, "--fixed-strings", ...landings.map(item => `--grep=${item.revision.slice(0, 12)}`), "--format=%H%x00%B%x00"]);
          const parts = log.split("\0");
          for (let index = 0; index + 1 < parts.length; index += 2) {
            if (explicitBackout(parts[index + 1], landings.map(item => item.revision))) {
              backouts.push({ revision: parts[index].trim(), message: parts[index + 1] });
            }
          }
        }
        let discussion = {}, bug = null, bugComments = [], regressions = [];
        const gaps = [];
        if (task.revision && !dependencies.getReview) gaps.push("Review reader is unavailable.");
        if (task.bugId && !dependencies.getBug) gaps.push("Bug reader is unavailable.");
        if (/^D\d+$/.test(task.revision) && dependencies.getReview) {
          try { discussion = await remote(options => dependencies.getReview(task.revision, options)); }
          catch (error) { gaps.push(`Review: ${error.message}`); }
          if (!discussion.available || discussion.historyTruncated) gaps.push("Complete review discussion is unavailable.");
        }
        if (/^\d+$/.test(task.bugId) && dependencies.getBug) {
          try { bug = await remote(options => dependencies.getBug(task.bugId, options)); }
          catch (error) { gaps.push(`Bug: ${error.message}`); }
          if (!bug) gaps.push("Bug metadata is unavailable.");
          if (bug && dependencies.getBugComments) {
            try { bugComments = await remote(options => dependencies.getBugComments(task.bugId, options)); }
            catch (error) { gaps.push(`Bug comments: ${error.message}`); }
          }
          for (const regression of (bug?.regressions || []).slice(0, 3)) {
            if (!dependencies.getBug) break;
            try { regressions.push(await remote(options => dependencies.getBug(String(regression), options))); }
            catch (error) { gaps.push(`Regression ${regression}: ${error.message}`); break; }
          }
        }
        const landedDiffs = [];
        for (const landing of landings.slice(0, 3)) {
          if (expired()) break;
          landedDiffs.push({ revision: landing.revision, ...await readDiff(landing.revision) });
        }
        const findings = task.findings.map(issue => compareReviewFinding(issue, discussion));
        for (let index = 0; index < findings.length; index++) {
          const code = task.findings[index].originalSuggestion?.code;
          findings[index].suggestionTextInLandedPatch = !code || !landedDiffs.length || landedDiffs.some(item => item.truncated)
            ? "unknown" : landedDiffs.some(item => item.diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"))
              .map(line => line.slice(1)).join("\n").includes(code)) ? "present" : "not-found";
        }
        const relatedTurns = [];
        for (const threadId of task.threadIds || []) {
          const rows = store.db.prepare("SELECT body FROM records WHERE repository='thunderbird' AND json_extract(body,'$.source.type')='agent-turn' AND json_extract(body,'$.source.threadId')=?").all(threadId);
          for (const row of rows) {
            const turn = JSON.parse(row.body);
            relatedTurns.push({ id: turn.id, retrievalIds: JSON.parse(turn.text).retrievalIds || [] });
          }
        }
        const observation = { task, findings, updateReplies: (task.updates || []).map(item => compareUpdateReply(item, discussion)),
          relatedTurns, landings, landedDiffs, backouts, discussion: {
          available: discussion.available || false, historyTruncated: discussion.historyTruncated,
          comments: discussion.comments || [], inlineComments: discussion.inlineComments || [],
        }, bug, bugComments, regressions, gaps,
          checkedRevision: target,
          limits: "Landing, no backout, and no reply do not prove correctness. Backouts and related bugs need causal review. Text edits do not establish that a finding was wrong. Compare task validation with the cited external evidence." };
        const text = JSON.stringify(observation);
        if (text.length > 1_900_000) throw new Error("Outcome evidence exceeds the record limit; leave the task pending.");
        const observationKey = digest(observation);
        if (store.setting(`follow-up-observation:${key}`) !== observationKey) {
          const record = await store.put({ kind: "evidence", repository: "thunderbird", visibility: "private",
            at: new Date(now()).toISOString(), paths: evidence.paths, title: `${task.kind} follow-up: ${task.revision || `Bug ${task.bugId}`}`,
            text, source: { type: "task-outcome-check", personal: true, revision: target, taskId: task.id,
              evidence: id, reference: `task-outcome:${id}` } });
          store.setting(`follow-up-latest:${key}`, record.id);
          store.setting(`follow-up-observation:${key}`, observationKey);
        }
        store.setting(`follow-up-checked:${key}`, now());
        store.setting(`follow-up-window-checked:${key}`, `${target}:${id}`);
        if (task.kind === "history" && !gaps.length) store.setting(`follow-up-history-checked:${key}`, id);
        result.tasks++;
      } catch (error) { result.errors.push({ task: key, message: error.message }); }
    }
    result.remoteLookups = remoteLookups;
    result.remainingCommits = commits.length - result.commits;
    result.cursor = cursor;
    result.timeBudgetReached = expired();
    result.remainingTasks = Object.entries(store.setting("follow-up-tasks") || {}).filter(([key, id]) =>
      store.setting(`follow-up-window-checked:${key}`) !== `${target}:${id}` &&
      !(key.startsWith("history:") && store.setting(`follow-up-history-checked:${key}`) === id)).length;
    if (!result.remainingCommits && !result.remainingTasks) {
      store.setting("follow-up-last-run", started);
      store.setting("follow-up-window", null);
    }
    store.setting("lastFollowUp", { ...result, at: new Date(now()).toISOString(), cadence: options.cadence });
    store.setting("lastFollowUpRun", { ...result, at: new Date(now()).toISOString(), cadence: options.cadence });
    return result;
  });
}
