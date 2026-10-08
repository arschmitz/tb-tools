import { run } from "../../lib/utils.mjs";
import { getTbToolsIdFromCommitMessage } from "../../lib/commit-message.mjs";
import { getPatchIdentityAliases, migrateRepositoryPatchIdentities, resolvePatchIdentity } from "../../lib/patch-identity.mjs";

// Fixup refs retain obsolete source commits. Only author branches identify the
// current patch; commit dates cannot establish which rewrite is authoritative.
export async function findCurrentTrySource(state, runCommand = run) {
  if (!state.tbToolsId) return state.sourceHash;
  await migrateRepositoryPatchIdentities({ cwd: state.repositoryPath || state.path, runCommand, ids: [state.tbToolsId] });
  state.tbToolsId = resolvePatchIdentity(state.tbToolsId);
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: state.path, capture: true, silent: true })).trim();
  const refs = (await git("for-each-ref", "--format=%(refname)", `refs/heads/${state.branchNamespace || ""}`))
    .split("\n").filter(ref => ref && !ref.startsWith("refs/heads/tb-try-fixup/"));
  if (!refs.length) return "";
  const matches = (await git("log", "--format=%H%x00%B%x00", "--fixed-strings", "--regexp-ignore-case",
    ...getPatchIdentityAliases(state.tbToolsId).map(id => `--grep=${id.startsWith("http") ? "Differential Revision" : "TB-Tools-Id"}: ${id}`), ...refs, "--")).split("\0");
  const candidates = [];
  for (let index = 0; index + 1 < matches.length; index += 2) {
    if (getTbToolsIdFromCommitMessage(matches[index + 1]) === state.tbToolsId) candidates.push(matches[index].trim());
  }
  // If a patch was revised by a descendant commit with the same ID, only the
  // descendant is current. Divergent author versions are ambiguous.
  const tips = [];
  for (const hash of candidates) {
    let ancestor = false;
    for (const other of candidates) {
      if (hash !== other && await git("merge-base", "--is-ancestor", hash, other).then(() => true, () => false)) { ancestor = true; break; }
    }
    if (!ancestor) tips.push(hash);
  }
  const selectFromRef = async ref => {
    if (!refs.includes(ref)) return "";
    const matches = [];
    for (const hash of tips) {
      if (await git("merge-base", "--is-ancestor", hash, ref).then(() => true, () => false)) matches.push(hash);
    }
    if (matches.length !== 1) return "";
    // Retain the patch branch, so changing the user's checkout does not
    // change which version this worker follows. Rebases can move that ref.
    const direct = (await git("for-each-ref", `--points-at=${matches[0]}`, "--format=%(refname)", "refs/heads/"))
      .split("\n").filter(name => refs.includes(name));
    state.sourceRef = direct[0] || ref;
    return matches[0];
  };
  const tracked = await selectFromRef(state.sourceRef);
  if (tracked) return tracked;
  if (tips.length === 1) return tips[0];
  // Rebased copies can remain on old author branches. Use the active named
  // author stack once to resolve legacy tasks that did not record a branch.
  const activeRef = await git("symbolic-ref", "--quiet", "HEAD").catch(() => "");
  const active = await selectFromRef(activeRef);
  if (active) return active;
  return "";
}

export async function assertCurrentTrySource(state, runCommand = run) {
  const current = await findCurrentTrySource(state, runCommand);
  if (current !== state.sourceHash) {
    throw Object.assign(new Error(current
      ? `This Try tested an older patch (${state.sourceHash.slice(0, 12)}). The author branch now contains ${current.slice(0, 12)}. No repair or submission was started for the old version.`
      : "The current author version of this Try patch is missing or ambiguous. No repair or submission was started."), { code: "TRY_SOURCE_CHANGED", currentSourceHash: current });
  }
}
