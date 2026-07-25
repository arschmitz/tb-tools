import update from "./update.mjs";
import { git, getCommit, getCurrentBranch } from "../lib/git.mjs";
import { mach } from "../lib/utils.mjs";

export default async function rebase({ build, run } = {}) {
  const startCommit = await getCommit();
  const startBranch = await getCurrentBranch();
  let stashed;
  try {
    const stashOutput = await git(["stash", "push", "--include-untracked", "-m", "tb-tools rebase"], undefined, true);
    stashed = !/No local changes/.test(stashOutput);
  } catch {
    // no changes to stash
  }
  await update();

  if (startBranch) {
    await git(["switch", startBranch]);
  } else {
    await git(["switch", "--detach", startCommit]);
  }

  await git(["fetch", "origin", "main"], undefined, true);
  await git(["rebase", "origin/main"]);

  if (stashed) {
    await git(["stash", "pop"]);
  }

  if (build || run) {
    await mach("build");
  }

  if (run) {
    await mach("run");
  }
}
