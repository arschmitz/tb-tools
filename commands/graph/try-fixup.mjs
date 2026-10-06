import { assertCurrentTrySource } from "./try-source.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { createTryMonitorStore } from "./try-monitor-store.mjs";

export async function updateRefs(cwd, input) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["update-ref", "--stdin"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(error || "Could not update branch refs.")));
    child.stdin.end(input);
  });
}

// Construct every replacement object before changing any branch. Ref updates use
// expected old hashes in one transaction, including aliases and fork branches.
export async function squashTryFixup({ graph, hash, store = createTryMonitorStore(), runCommand = run, transaction = updateRefs }) {
  const state = store.list().find(item => item.path === graph.path && item.fixupHash === hash && item.phase !== "squashed");
  if (!state) throw new Error("This fixup is no longer available. Refresh the graph.");
  const release = store.lock(state.id);
  if (!release) throw Object.assign(new Error("This Try is being checked or repaired. Try Amend after that work finishes."), { code: "TRY_BUSY" });
  const git = async (...args) => (await runCommand({ cmd: "git", args, cwd: graph.path, capture: true, silent: true })).trim();
  let temporary;
  try {
    await assertCurrentTrySource(state, runCommand);
    if (state.attempts.at(-1)?.buildValidationBlocked) throw new Error("No build completed successfully. Run a matching-source Try before Amend.");
    if (!["passed", "paused", "needs-evidence", "waiting"].includes(state.phase)) throw new Error("Wait for the current repair or submission before amending.");
    const clean = async () => {
      if (await git("status", "--porcelain")) throw new Error("Commit or shelf working changes before amending a Try fixup.");
      const paths = await git("rev-parse", "--git-path", "rebase-merge");
      // The normal status guard also catches conflicts; reject an active sequencer.
      const { existsSync } = await import("node:fs");
      for (const name of [paths, await git("rev-parse", "--git-path", "rebase-apply"), await git("rev-parse", "--git-path", "CHERRY_PICK_HEAD")]) {
        if (existsSync(path.resolve(graph.path, name))) throw new Error("Finish the active Git operation before amending.");
      }
    };
    await clean();
    const originalHead = await git("rev-parse", "HEAD");
    const originalBranch = await git("branch", "--show-current");
    const source = await git("rev-parse", `${hash}^`);
    if (source !== state.sourceHash) throw new Error("The fixup parent changed. Refresh and review it before amending.");
    const parent = state.fixupTargetHash || source;
    await git("merge-base", "--is-ancestor", parent, source);
    const parentParents = (await git("show", "-s", "--format=%P", parent)).split(" ").filter(Boolean);
    if (parentParents.length !== 1) throw new Error("Cannot amend a root or merge commit with this action.");
    const branches = (await git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/tb-tools/repair-owners/"))
      .split("\n").filter(Boolean).map(line => line.split(" "));
    const descendants = (await git("rev-list", "--reverse", "--topo-order", "--ancestry-path", `${parent}..`, "--branches"))
      .split("\n").filter(Boolean);
    const rewrites = new Map();
    temporary = await mkdtemp(path.join(os.tmpdir(), "tb-try-amend-"));
    async function makeCommit(old, tree, parents) {
      const author = (await git("show", "-s", "--format=%an%n%ae%n%aI", old)).split("\n");
      const messagePath = path.join(temporary, "message.txt");
      // Keep the original message, including whitespace and commit IDs.
      const message = await runCommand({ cmd: "git", args: ["show", "-s", "--format=format:%B", old],
        cwd: graph.path, capture: true, silent: true });
      await writeFile(messagePath, message);
      return (await runCommand({ cmd: "git", args: ["commit-tree", tree, ...parents.flatMap(p => ["-p", p]), "-F", messagePath],
        cwd: graph.path, capture: true, silent: true,
        env: { GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_AUTHOR_DATE: author[2] } })).trim();
    }
    // Apply only the repair delta to its owner. Descendant changes stay in
    // their own commits when the stack is replayed below.
    const repairedTree = parent === source ? await git("rev-parse", `${hash}^{tree}`)
      : (await git("merge-tree", "--write-tree", `--merge-base=${source}`, parent, hash)).split("\n")[0];
    const replacement = await makeCommit(parent, repairedTree, parentParents);
    rewrites.set(parent, replacement);
    for (const old of descendants) {
      if (old === hash) {
        rewrites.set(hash, rewrites.get(source));
        continue;
      }
      const parents = (await git("show", "-s", "--format=%P", old)).split(" ").filter(Boolean);
      if (parents.length !== 1 || !rewrites.has(parents[0])) throw new Error("This stack contains an unsupported merge. No branches were changed.");
      const nextParent = rewrites.get(parents[0]);
      const tree = (await git("merge-tree", "--write-tree", `--merge-base=${parents[0]}`, nextParent, old)).split("\n")[0];
      rewrites.set(old, await makeCommit(old, tree, [nextParent]));
    }
    // An unreferenced fixup may not occur in --branches.
    const sourceReplacement = rewrites.get(source);
    rewrites.set(hash, sourceReplacement);
    if (await git("rev-parse", `${sourceReplacement}^{tree}`) !== await git("rev-parse", `${hash}^{tree}`)) {
      throw new Error("Moving this repair to its owner changed the tested stack. No branches were changed.");
    }
    const updates = branches.filter(([, old]) => rewrites.has(old));
    const checkoutPath = await realpath(graph.path);
    const worktrees = (await git("worktree", "list", "--porcelain")).split("\n\n");
    for (const entry of worktrees) {
      if (entry.split("\n").includes(`worktree ${checkoutPath}`)) continue;
      if (updates.some(([ref]) => entry.split("\n").includes(`branch ${ref}`))) {
        throw new Error("A branch to amend is checked out elsewhere. Switch that checkout before amending.");
      }
    }
    await clean();
    if (await git("rev-parse", "HEAD") !== originalHead || await git("branch", "--show-current") !== originalBranch) {
      throw new Error("The checkout changed during Amend. No branches were changed.");
    }
    const nextHead = rewrites.get(originalHead);
    state.squash = { replacement, sourceReplacement, originalHead, originalBranch, nextHead, updates,
      rewrites: Object.fromEntries(rewrites), resumePhase: state.phase };
    state.phase = "squashing";
    store.save(state);
    await resumeTryFixupSquash({ state, store, runCommand, transaction });
    return { hash: replacement, rewrittenHash: replacement, currentHash: nextHead || originalHead,
      message: "Amended the patch with its Try fixup and preserved descendant branches." };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    release();
  }
}

export async function resumeTryFixupSquash({ state, store, runCommand = run, transaction = updateRefs }) {
  const plan = state.squash;
  if (!plan) throw new Error("The saved Amend plan is missing.");
  const sourceReplacement = plan.sourceReplacement || plan.replacement;
  const git = async (...args) => (await runCommand({ cmd: "git", args, cwd: state.path, capture: true, silent: true })).trim();
  const positions = await Promise.all(plan.updates.map(async ([ref, old]) => {
    const hash = await git("rev-parse", ref);
    return hash === old ? "old" : hash === plan.rewrites[old] ? "new" : "changed";
  }));
  if (positions.includes("changed") || (positions.includes("old") && positions.includes("new"))) {
    throw new Error("Branches changed during Amend recovery. Inspect the saved plan before continuing.");
  }
  const head = await git("rev-parse", "HEAD");
  const branch = await git("branch", "--show-current");
  if (await git("status", "--porcelain") || ![plan.originalHead, plan.nextHead].includes(head) ||
      (branch && branch !== plan.originalBranch)) {
    throw new Error("The checkout changed during Amend recovery. Restore the clean saved checkout before continuing.");
  }
  if (positions.includes("old")) {
    if (plan.nextHead && branch) await git("switch", "--detach", plan.originalHead);
    await transaction(state.path, "start\n" + plan.updates.map(([ref, old]) => `update ${ref} ${plan.rewrites[old]} ${old}\n`).join("") + "prepare\ncommit\n");
  }
  if (plan.nextHead) {
    if (plan.originalBranch) await git("switch", plan.originalBranch);
    else await git("reset", "--keep", plan.nextHead);
  }
  if (state.workspace) {
    const privateGit = async (...args) => (await runCommand({ cmd: "git", args, cwd: state.workspace, capture: true, silent: true })).trim();
    if (![state.fixupHash, sourceReplacement].includes(await privateGit("rev-parse", "HEAD")) || await privateGit("status", "--porcelain")) {
      throw new Error("The saved repair checkout changed during Amend. Inspect it before completing recovery.");
    }
    await privateGit("switch", "--detach", sourceReplacement);
  }
  state.previousHashes = [...(state.previousHashes || []), state.hash, state.sourceHash, state.fixupHash];
  state.hash = state.sourceHash = state.squashedHash = sourceReplacement;
  state.fixupTargetHash = state.fixupTargetSubject = "";
  // Keep each tested revision and verdict, while attaching all existing runs
  // to the amended patch. New repair attempts still belong to their own fixup.
  for (const attempt of state.attempts) attempt.mergedInto = sourceReplacement;
  state.fixupHash = "";
  // A later repair must start from the amended patch, in a new isolated checkout.
  state.workspace = "";
  state.workspaceGeneration = (state.workspaceGeneration || 0) + 1;
  state.phase = plan.resumePhase;
  state.error = "";
  state.nextCheckAt = state.phase === "passed" ? null : Date.now();
  store.save(state);
}
