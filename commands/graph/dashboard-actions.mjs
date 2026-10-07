import { access } from "node:fs/promises";
import { run } from "../../lib/utils.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import { checkoutCommit, rebaseCommit } from "./actions.mjs";
import {
  assertSafeWorktreeOwnership,
  findGraphPatchCommit,
  resolveGraphPatchUpdateWorkingCheckout,
} from "./patch-update.mjs";

export async function prepareDashboardPatchAction({ graphs, revision, action, runCommand = run }) {
  if (!["rebase", "ci-verify"].includes(action)) {
    throw Object.assign(new Error("Unknown dashboard patch action."), { statusCode: 400 });
  }
  const { graph, graphIndex, graphs: workingGraphs } = resolveGraphPatchUpdateWorkingCheckout({ graphs });
  const git = async args => String(await runCommand({ cmd: "git", args, cwd: graph.path, capture: true, silent: true })).trim();
  if (await git(["status", "--porcelain"])) {
    throw Object.assign(new Error("Commit or save the working checkout changes before starting this action."), { statusCode: 409 });
  }
  for (const marker of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD"]) {
    const file = await git(["rev-parse", "--path-format=absolute", "--git-path", marker]);
    const exists = await access(file).then(() => true, () => false);
    if (exists) throw Object.assign(new Error("Finish the active Git operation before starting this action."), { statusCode: 409 });
  }
  const found = await findGraphPatchCommit({ graph, revision, newest: true, runCommand });
  await assertSafeWorktreeOwnership({ graphs: workingGraphs, graph, hash: found.hash, runCommand });
  if (action === "ci-verify") {
    await checkoutCommit({ graph, hash: found.hash, requireLoaded: false, runCommand });
    return { graph, graphIndex, hash: found.hash };
  }
  await git(["fetch", "origin", DEFAULT_BRANCH]);
  const main = await git(["rev-parse", `origin/${DEFAULT_BRANCH}`]);
  const common = await git(["merge-base", main, found.hash]);
  if (common === main) {
    return { graph, graphIndex, result: { message: `${revision} is already based on origin/${DEFAULT_BRANCH}.` } };
  }
  await git(["switch", "--detach", main]);
  const result = await rebaseCommit({ graph, graphIndex, hash: found.hash,
    requireLoaded: false, rebaseMode: "descendants", runCommand });
  return { graph, graphIndex, result };
}
