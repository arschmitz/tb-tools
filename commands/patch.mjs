import readlineSync from "readline-sync";
import { createCheckpoint, git, restoreCheckpoint } from "../lib/git.mjs";
import { run } from "../lib/utils.mjs";

export function normalizeRevision(revision) {
  if (!revision) {
    throw new Error("A Phabricator revision is required, for example `tb patch D123456`.");
  }

  return /^D/i.test(revision) ? revision.toUpperCase() : `D${revision}`;
}

export function getPatchArgs({
  revision,
  applyTo,
  raw = false,
  diffId,
  name,
  noCommit = false,
  noBookmark = false,
  noTopic = false,
  noBranch = false,
  skipDependencies = false,
  includeAbandoned = false,
  safeMode = false,
  forceVcs = false,
} = {}) {
  if (raw && applyTo) {
    throw new Error("moz-phab patch does not allow --raw with --apply-to.");
  }

  const args = ["patch", normalizeRevision(revision)];

  if (applyTo) {
    args.push("--apply-to", applyTo);
  }

  if (raw) {
    args.push("--raw");
  }

  if (diffId) {
    args.push("--diff-id", String(diffId));
  }

  if (name) {
    args.push("--name", name);
  }

  if (noCommit) {
    args.push("--no-commit");
  }

  if (noBookmark) {
    args.push("--no-bookmark");
  }

  if (noTopic) {
    args.push("--no-topic");
  }

  if (noBranch) {
    args.push("--no-branch");
  }

  if (skipDependencies) {
    args.push("--skip-dependencies");
  }

  if (includeAbandoned) {
    args.push("--include-abandoned");
  }

  if (safeMode) {
    args.push("--safe-mode");
  }

  if (forceVcs) {
    args.push("--force-vcs");
  }

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
    applyTo,
    raw = false,
    diffId,
    name,
    noCommit = false,
    noBookmark = false,
    noTopic = false,
    noBranch = false,
    skipDependencies = false,
    includeAbandoned = false,
    safeMode = false,
    forceVcs = false,
  } = {}) {
    const patchArgs = getPatchArgs({
      revision,
      applyTo,
      raw,
      diffId,
      name,
      noCommit,
      noBookmark,
      noTopic,
      noBranch,
      skipDependencies,
      includeAbandoned,
      safeMode,
      forceVcs,
    });
    const patchCheckpoint = checkpoint ? await createPatchCheckpoint("patch-start") : undefined;

    if (bug) {
      await switchBranch(bug);
    }

    try {
      await runCommand({
        cmd: "moz-phab",
        args: patchArgs,
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
