import readlineSync from "readline-sync";
import { createCheckpoint, git, restoreCheckpoint } from "../lib/git.mjs";
import { run } from "../lib/utils.mjs";

export function normalizeRevision(revision) {
  if (!revision) {
    throw new Error("A Phabricator revision is required, for example `tb patch D123456`.");
  }

  return /^D/i.test(revision) ? revision.toUpperCase() : `D${revision}`;
}

export function getPatchArgs({ revision, skipDependencies = true } = {}) {
  const args = ["patch", normalizeRevision(revision)];

  if (skipDependencies) {
    args.push("--skip-dependencies");
  }

  args.push("--apply-to", "here");

  return args;
}

export async function switchToBugBranch(bugId, { gitCommand = git } = {}) {
  if (!bugId) {
    return;
  }

  const branch = `Bug-${bugId}`;

  try {
    await gitCommand(["switch", "-c", branch]);
  } catch {
    await gitCommand(["switch", branch]);
  }

  return branch;
}

export function createPatchCommand({
  runCommand = run,
  createPatchCheckpoint = createCheckpoint,
  restorePatchCheckpoint = restoreCheckpoint,
  switchBranch = switchToBugBranch,
  prompts = readlineSync,
} = {}) {
  return async function patch({
    revision,
    bug,
    checkpoint = true,
    rollback = true,
    skipDependencies = true,
  } = {}) {
    const patchCheckpoint = checkpoint ? await createPatchCheckpoint("patch-start") : undefined;

    if (bug) {
      await switchBranch(bug);
    }

    try {
      await runCommand({
        cmd: "moz-phab",
        args: getPatchArgs({ revision, skipDependencies }),
        capture: true,
      });
    } catch (error) {
      if (patchCheckpoint && rollback) {
        const shouldRollback = prompts.keyInYNStrict("Patch failed. Roll back to checkpoint? [y/n]:", { guide: false });

        if (shouldRollback) {
          await restorePatchCheckpoint(patchCheckpoint, undefined, { clean: true });
        }
      }

      throw error;
    }
  };
}

export default createPatchCommand();
