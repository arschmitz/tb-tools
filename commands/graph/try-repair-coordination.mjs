import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { getTbToolsIdFromCommitMessage } from "../../lib/commit-message.mjs";
import { getPatchIdentityAliases, migrateRepositoryPatchIdentities, resolvePatchIdentity } from "../../lib/patch-identity.mjs";
import { saveAiContext } from "./ai-context.mjs";

const waitingRepairs = new Set();

// Use patch identities, not workflow IDs or rewritten commit hashes. Parent
// and child repairs share ownership while unrelated stacks can run together.
export async function getTryRepairScope(state, runCommand = run) {
  await migrateRepositoryPatchIdentities({ cwd: state.repositoryPath || state.path, runCommand, ids: [state.tbToolsId] });
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: state.path, capture: true, silent: true })).trim();
  const common = await git("rev-parse", "--git-common-dir");
  const repository = await realpath(path.resolve(state.path, common));
  const boundaries = (await git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/", "refs/heads/main"))
    .split("\n").filter(Boolean);
  const commits = (await git("log", "--format=%H%x00%B%x00", state.sourceHash,
    ...(boundaries.length ? ["--not", ...boundaries] : []), "--")).split("\0");
  const identities = new Set();
  for (let i = 0; i + 1 < commits.length; i += 2) {
    identities.add(getTbToolsIdFromCommitMessage(commits[i + 1]) || commits[i].trim());
  }
  if (!identities.size) identities.add(state.tbToolsId || state.sourceHash);
  return [...new Set([...identities].flatMap(getPatchIdentityAliases))].sort().map(identity => "repair-" + createHash("sha256").update(`${repository}\0${identity}`).digest("hex"));
}

export async function acquireTryRepairScope({ state, store, signal, runCommand = run }) {
  const keys = await getTryRepairScope(state, runCommand);
  while (true) {
    signal?.throwIfAborted();
    let wake;
    const changed = new Promise(resolve => { wake = resolve; });
    // Subscribe before trying the locks, so a release cannot be missed.
    let waitingKey;
    const watcher = watch(store.directory, (_event, filename) => {
      if (String(filename) === `${waitingKey}.json.lock`) wake();
    });
    const abort = () => wake();
    signal?.addEventListener("abort", abort, { once: true });
    const waiter = { directory: store.directory, keys, wake };
    waitingRepairs.add(waiter);
    const releases = [];
    let acquired = false;
    let timer;
    try {
      for (const key of keys) {
        const release = store.lock(key);
        if (!release) { waitingKey = key; break; }
        releases.push(release);
      }
      if (releases.length === keys.length) {
        acquired = true;
        return () => {
          releases.reverse().forEach(release => release());
          for (const waiter of waitingRepairs) {
            if (waiter.directory === store.directory && waiter.keys.some(key => keys.includes(key))) waiter.wake();
          }
        };
      }
      releases.reverse().forEach(release => release());
      releases.length = 0;
      if (state.repairActivity !== "Waiting for related repair") {
        state.repairActivity = "Waiting for related repair";
        store.save(state);
      }
      // File events start the next step immediately. This timeout only
      // recovers a lock whose process died without removing its file.
      timer = setTimeout(wake, 1000);
      await changed;
    } finally {
      waitingRepairs.delete(waiter);
      if (!acquired) releases.reverse().forEach(release => release());
      clearTimeout(timer);
      watcher.close();
      signal?.removeEventListener("abort", abort);
    }
  }
}

export async function getRelatedTryRepairs(state, store, runCommand = run) {
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: state.path, capture: true, silent: true })).trim();
  const related = [];
  for (const other of store.list()) {
    if (other.id === state.id || other.imported || path.resolve(other.path) !== path.resolve(state.path)) continue;
    const hash = other.fixupRef ? await git("rev-parse", "--verify", other.fixupRef).catch(() => "") : "";
    if (!hash && !["analyzing", "repairing", "ready-to-submit", "submitting"].includes(other.phase)) continue;
    const details = { monitorId: other.id, phase: other.phase, activity: other.repairActivity,
      sourceHash: other.sourceHash, assessment: other.assessment, hash, ref: other.fixupRef, targetHash: other.fixupTargetHash || other.sourceHash,
      subject: other.fixupTargetSubject || other.subject, report: other.repairReport,
      runs: other.attempts.map(({ url, hash, status, assessment }) => ({ url, hash, status, assessment })) };
    related.push({ monitorId: other.id, phase: other.phase, sourceHash: other.sourceHash,
      hash, ref: other.fixupRef, targetHash: details.targetHash, subject: details.subject,
      files: other.repairReport?.files || [],
      failures: (other.assessment?.failures || []).map(({ id, cause }) => ({ id, cause })),
      detailsFile: await saveAiContext(details, { directory: path.join(store.directory, "related-repairs") }) });
  }
  return related;
}


export function getTryRepairOwnerRef(targetId) {
  return "refs/tb-tools/repair-owners/" + createHash("sha256").update(resolvePatchIdentity(targetId)).digest("hex");
}

export async function assertTryRepairOwner({ state, targetId, expectedHash, runCommand = run }) {
  const ref = getTryRepairOwnerRef(targetId);
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: state.path, capture: true, silent: true })).trim();
  let hash = "";
  for (const id of getPatchIdentityAliases(targetId)) {
    const oldRef = "refs/tb-tools/repair-owners/" + createHash("sha256").update(id).digest("hex");
    const ownerHash = await git("rev-parse", "--verify", oldRef).catch(() => "");
    if (ownerHash) hash = ownerHash;
    if (ownerHash && ownerHash !== expectedHash && ownerHash !== state.fixupHash &&
      /^fixup! /.test(await git("show", "-s", "--format=%s", ownerHash))) {
      throw Object.assign(new Error(`This patch already has fixup ${ownerHash.slice(0, 12)}. Its owning workflow must incorporate this repair; a second fixup will not be published.`),
        { code: "TRY_REPAIR_OWNED", ownerRef: oldRef, ownerHash });
    }
  }
  return { ref, hash };
}
