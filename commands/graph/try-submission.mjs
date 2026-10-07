import { randomUUID } from "node:crypto";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { getTbToolsIdFromCommitMessage } from "../../lib/commit-message.mjs";
import { createTryMonitorStore, getMonitoredTryVerdict, TRY_STATUS_CHECK_INTERVAL_MS } from "./try-monitor-store.mjs";
import { parseTryUrl } from "./treeherder.mjs";

export async function prepareMonitoredTry({ graph, target, options, runCommand = run,
  store = createTryMonitorStore(), now = Date.now(), implementationId = "" } = {}) {
  const cwd = graph?.path || process.cwd();
  const git = async (args, directory = cwd) => (await runCommand({ cmd: "git", args, cwd: directory, capture: true, silent: true })).trim();
  const root = await git(["rev-parse", "--show-toplevel"]);
  const hash = await git(["rev-parse", "HEAD"]);
  const message = await git(["show", "-s", "--format=%B", hash]);
  const dirty = Boolean(await git(["status", "--porcelain"]));
  const geckoPath = path.dirname(root);
  let geckoHash = "";
  try { geckoHash = await git(["rev-parse", "HEAD"], geckoPath); } catch { /* Report unsupported layouts if a repair is needed. */ }
  let state = {
    version: 1, id: randomUUID(), implementationId, path: root, label: graph?.label || "comm",
    hash: target?.hash || hash, sourceHash: hash, subject: target?.subject || message.split("\n")[0],
    tbToolsId: target?.tbToolsId || getTbToolsIdFromCommitMessage(message), patchId: target?.patchId || "",
    geckoPath, geckoHash, dirty, options: { ...options, comment: false },
    phase: "submitting", nextCheckAt: now + TRY_STATUS_CHECK_INTERVAL_MS, attempts: [],
  };
  const existing = store.list().find(saved => saved.path === root && saved.fixupHash === hash && saved.phase !== "superseded");
  const release = store.lock(existing?.id || state.id);
  if (!release) throw new Error("This patch has an active Try worker. Wait for it before posting another Try.");
  try {
    if (existing) {
      state = store.read(existing.id);
      if (state.fixupHash !== hash) throw new Error("The fixup changed before submission. Refresh the graph.");
      state.options = { ...options, comment: false };
      state.dirty = dirty;
      if (state.geckoHash !== geckoHash) {
        state.geckoHash = geckoHash;
        state.workspace = "";
        state.workspaceGeneration = (state.workspaceGeneration || 0) + 1;
      }
    }
    addTryAttempt(state, now);
    state.nextCheckAt = now + TRY_STATUS_CHECK_INTERVAL_MS;
    store.save(state);
  } catch (error) {
    release();
    throw error;
  }
  return { state, store, release };
}

export function addTryAttempt(state, now = Date.now()) {
  const previous = state.attempts.at(-1);
  const verdict = previous && getMonitoredTryVerdict(state, previous);
  if (["passed", "patch-failed"].includes(verdict)) previous.determinedVerdict = verdict;
  const id = randomUUID();
  const attempt = { id, marker: `tb-try-monitor:${id}`, createdAt: new Date(now).toISOString(),
    hash: state.validationHash || state.fixupHash || state.sourceHash, sharedFixes: state.sharedFixes || [], isFixup: Boolean(state.fixupHash), status: "submitting", url: "" };
  state.attempts.push(attempt);
  state.phase = "submitting";
  return attempt;
}

export function saveTrySubmissionOutput(state, store, output) {
  const attempt = state.attempts.at(-1);
  // A crash after mach prints the URL must still leave a recoverable receipt.
  attempt.output = `${attempt.output || ""}${output}`.slice(-200000);
  for (const candidate of attempt.output.match(/https:\/\/treeherder\.mozilla\.org\/jobs[^\s<>"']*/g) || []) {
    try { parseTryUrl(candidate); attempt.url = candidate; } catch { /* Wait for the complete URL. */ }
  }
  store.save(state);
}

export function finishTrySubmission(state, store, url, now = Date.now()) {
  parseTryUrl(url);
  const attempt = state.attempts.at(-1);
  attempt.url = url;
  attempt.status = "waiting";
  state.phase = "waiting";
  state.nextCheckAt = now + TRY_STATUS_CHECK_INTERVAL_MS;
  state.error = "";
  store.save(state);
}
