import { getNextBugBranchName } from "./branches.mjs";

// Implement owns a permanent bug branch, including in an isolated checkout.
export async function publishImplementationResult(state, { runCommand, save }) {
  if (!state.commitHash || !state.branch?.startsWith("tb-task/")) return;
  const cwd = state.repositoryPath || state.path;
  const git = async args => String(await runCommand({ cmd: "git", args, cwd, capture: true, silent: true })).trim();
  if (!state.resultBranch) {
    const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n");
    state.resultBranch = getNextBugBranchName(branches, state.bugId);
    save(state);
  }
  const ref = `refs/heads/${state.resultBranch}`;
  const current = await git(["for-each-ref", "--format=%(objectname)", ref]);
  if (current && current !== state.commitHash) throw new Error(`The bug branch ${state.resultBranch} changed outside Implement. Preserve that work before continuing.`);
  const old = await git(["for-each-ref", "--format=%(objectname)", `refs/heads/${state.branch}`]);
  if (old) {
    if (old !== state.commitHash) throw new Error("The implementation branch changed before migration to its bug branch.");
    const trees = await git(["worktree", "list", "--porcelain"]);
    if (trees.split("\n").includes(`branch ${ref}`)) throw new Error(`The bug branch ${state.resultBranch} is already checked out elsewhere.`);
    // Rename the actual working branch. Git also updates its worktree's HEAD.
    await git(["branch", "-M", state.branch, state.resultBranch]);
  } else if (!current) {
    // A completed task may already have removed its isolated checkout and refs.
    await git(["update-ref", ref, state.commitHash, "0".repeat(40)]);
  }
  state.branch = state.resultBranch;
  delete state.resultBranch;
  delete state.resultPublishedHash;
  save(state);
}
