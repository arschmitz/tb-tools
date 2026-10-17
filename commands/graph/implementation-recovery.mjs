import path from "node:path";

// The console owns source changes. The AI worker must not perform these steps.
export async function recoverImplementationSource(state, { runCommand, commRevision = "origin/main", geckoRevision = "origin/main" }) {
  const geckoPath = path.dirname(state.path);
  const git = async (cwd, args) => String(await runCommand({ cmd: "git", args, cwd, capture: true, silent: true })).trim();
  const head = await git(state.path, ["rev-parse", "HEAD"]);
  if (head !== state.commitHash) throw new Error("The implementation changed before source recovery.");
  const branch = await git(state.path, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== state.branch) throw new Error("The implementation branch changed before source recovery.");
  const geckoHead = await git(geckoPath, ["rev-parse", "HEAD"]);
  let geckoTarget = await git(geckoPath, ["rev-parse", `${geckoRevision}^{commit}`]);
  // Keep a checkout that already contains the target; do not rewind newer source.
  if (await git(geckoPath, ["merge-base", "--is-ancestor", geckoTarget, geckoHead]).then(() => true, () => false)) geckoTarget = geckoHead;
  const commTarget = await git(state.path, ["rev-parse", `${commRevision}^{commit}`]);
  const base = await git(state.path, ["merge-base", head, commTarget]);
  if (base === commTarget && geckoHead === geckoTarget) return { changed: false, head, geckoHash: geckoHead };
  if (await git(state.path, ["status", "--porcelain"]) || await git(geckoPath, ["status", "--porcelain"])) {
    throw new Error("Source recovery must preserve uncommitted changes. Clean task source is required before switching revisions.");
  }
  if (geckoHead !== geckoTarget) await git(geckoPath, ["switch", "--detach", geckoTarget]);
  try {
    if (base !== commTarget) await git(state.path, ["rebase", "--onto", commTarget, base, branch]);
  } catch (error) {
    await git(state.path, ["rebase", "--abort"]).catch(() => {});
    if (geckoHead !== geckoTarget) await git(geckoPath, ["switch", "--detach", geckoHead]);
    throw error;
  }
  return { changed: true, head: await git(state.path, ["rev-parse", "HEAD"]), geckoHash: geckoTarget,
    baseHash: await git(state.path, ["rev-parse", "HEAD^"]) };
}
