import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../../lib/utils.mjs";

// Shared repairs stay on their owner's ref. Only the isolated Try checkout
// receives their changes; they never become part of another owner's fixup.
export async function prepareSharedTryValidation(state, store, runCommand = run) {
  if (!state.sharedFixes?.length) return;
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: state.workspace, capture: true, silent: true })).trim();
  const head = await git("rev-parse", "HEAD");
  const base = state.fixupHash || state.sourceHash;
  if (![base, state.validationHash].includes(head) || await git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("The shared repair checkout changed. No source was overwritten.");
  }
  const key = JSON.stringify(["owner-replay-v1", base, state.sharedFixes]);
  if (state.validationHash && state.validationKey === key) {
    await git("update-ref", `refs/tb-tools/repair-history/try-validation/${state.id}`, state.validationHash);
    if (head !== state.validationHash) await git("checkout", "--detach", state.validationHash);
    return;
  }
  // As in Amend, apply each repair delta to its owner, then replay descendants.
  // Preserve original commit messages and authors. Never add a validation commit.
  const repairs = [...state.sharedFixes];
  if (state.fixupHash) repairs.push({ hash: state.fixupHash, targetHash: state.fixupTargetHash || state.sourceHash });
  const byOwner = new Map();
  for (const repair of repairs) {
    await git("merge-base", "--is-ancestor", repair.targetHash, state.sourceHash);
    if (byOwner.has(repair.targetHash)) throw new Error("Two shared repairs claim the same owning patch.");
    byOwner.set(repair.targetHash, repair);
  }
  let earliest = repairs[0].targetHash;
  for (const repair of repairs.slice(1)) {
    if (await git("merge-base", "--is-ancestor", repair.targetHash, earliest).then(() => true, () => false)) earliest = repair.targetHash;
  }
  const boundary = await git("rev-parse", `${earliest}^`);
  const commits = (await git("rev-list", "--reverse", "--ancestry-path", `${boundary}..${state.sourceHash}`)).split("\n");
  if ([...byOwner.keys()].some(hash => !commits.includes(hash))) throw new Error("Shared repair owners must be in the linear outgoing stack.");
  const rewrites = new Map();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tb-shared-try-"));
  let tip;
  try {
    for (const original of commits) {
      const parents = (await git("show", "-s", "--format=%P", original)).split(" ").filter(Boolean);
      if (parents.length !== 1) throw new Error("Shared repair integration requires a linear stack.");
      const parent = rewrites.get(parents[0]) || parents[0];
      let tree = parent === parents[0] ? await git("rev-parse", `${original}^{tree}`)
        : (await git("merge-tree", "--write-tree", `--merge-base=${parents[0]}`, parent, original)).split("\n")[0];
      const author = (await git("show", "-s", "--format=%an%n%ae%n%aI", original)).split("\n");
      const messageFile = path.join(temporary, "message.txt");
      const message = await runCommand({ cmd: "git", args: ["show", "-s", "--format=format:%B", original], cwd: state.workspace, capture: true, silent: true });
      await writeFile(messageFile, message);
      const makeCommit = async () => String(await runCommand({ cmd: "git", args: ["commit-tree", tree, "-p", parent, "-F", messageFile],
        cwd: state.workspace, capture: true, silent: true,
        env: { GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_AUTHOR_DATE: author[2] } })).trim();
      const repair = byOwner.get(original);
      if (repair) {
        const rewritten = await makeCommit();
        const repairParent = await git("rev-parse", `${repair.hash}^`);
        tree = (await git("merge-tree", "--write-tree", `--merge-base=${repairParent}`, rewritten, repair.hash)).split("\n")[0];
      }
      tip = await makeCommit();
      rewrites.set(original, tip);
    }
    // Folding repairs into their owners must not change the combined source.
    let expected = base;
    let expectedTree = await git("rev-parse", `${base}^{tree}`);
    for (const [index, repair] of state.sharedFixes.entries()) {
      const parent = await git("rev-parse", `${repair.hash}^`);
      const tree = (await git("merge-tree", "--write-tree", `--merge-base=${parent}`, expected, repair.hash)).split("\n")[0];
      expectedTree = tree;
      if (index < state.sharedFixes.length - 1) {
        const messageFile = path.join(temporary, "comparison-message.txt");
        await writeFile(messageFile, await runCommand({ cmd: "git", args: ["show", "-s", "--format=format:%B", repair.hash], cwd: state.workspace, capture: true, silent: true }));
        expected = await git("commit-tree", tree, "-p", expected, "-F", messageFile);
      }
    }
    if (await git("rev-parse", `${tip}^{tree}`) !== expectedTree) {
      throw new Error("Applying shared repairs to their owners changed the combined source.");
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  // Save the intended checkout before moving HEAD, so a restart can finish it.
  state.validationHash = tip;
  state.validationKey = key;
  store.save(state);
  await git("update-ref", `refs/tb-tools/repair-history/try-validation/${state.id}`, tip);
  await git("checkout", "--detach", tip);
}

export async function reuseSharedTryRepair(state, report, store, runCommand = run) {
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: state.workspace, capture: true, silent: true })).trim();
  const candidates = store.list().filter(other => other.id !== state.id && other.path === state.path &&
    other.phase === "passed" && other.fixupTargetHash === report.targetHash && other.fixupHash && other.fixupRef);
  for (const other of candidates) {
    if (await git("rev-parse", "--verify", other.fixupRef) !== other.fixupHash) continue;
    const files = (await git("diff-tree", "--no-commit-id", "--name-only", "-r", other.fixupHash)).split("\n").filter(Boolean);
    if (!files.length || files.length !== report.files.length || files.some(file => !report.files.includes(file))) continue;
    if (await git("status", "--porcelain", "--untracked-files=no")) continue;
    state.sharedFixes ||= [];
    if (!state.sharedFixes.some(repair => repair.hash === other.fixupHash)) {
      state.sharedFixes.push({ monitorId: other.id, hash: other.fixupHash, targetHash: other.fixupTargetHash, files });
    }
    await prepareSharedTryValidation(state, store, runCommand);
    state.sharedRepairReport = report;
    delete state.pendingRepairReport;
    state.phase = "ready-to-submit";
    state.error = "";
    store.save(state);
    return true;
  }
  return false;
}
