import readlineSync from "readline-sync";
import { DEFAULT_BRANCH, git } from "../lib/git.mjs";

export function parseRefList(output = "") {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function parseMergedBugBranches(output = "", currentBranch = "") {
  return parseRefList(output).filter((branch) => branch !== currentBranch && /^Bug-\d+/.test(branch));
}

export function parseTbToolsStashes(output = "") {
  return output.split("\n").reduce((stashes, line) => {
    const match = line.match(/^(stash@\{(\d+)\}):\s*(.*)$/);
    if (match && /tb-tools/i.test(match[3])) {
      stashes.push({
        ref: match[1],
        index: Number(match[2]),
        message: match[3],
      });
    }

    return stashes;
  }, []);
}

async function safeGit(command, fallback, gitCommand) {
  try {
    return await gitCommand(command, undefined, true);
  } catch {
    return fallback;
  }
}

export async function getCleanupPlan({
  base = `origin/${DEFAULT_BRANCH}`,
  gitCommand = git,
} = {}) {
  const [refsOutput, branchesOutput, stashesOutput, currentBranchOutput] = await Promise.all([
    safeGit(["for-each-ref", "--format=%(refname)", "refs/tb-tools"], "", gitCommand),
    safeGit(["branch", "--merged", base, "--format=%(refname:short)"], "", gitCommand),
    safeGit(["stash", "list"], "", gitCommand),
    safeGit(["branch", "--show-current"], "", gitCommand),
  ]);

  return {
    refs: parseRefList(refsOutput),
    branches: parseMergedBugBranches(branchesOutput, currentBranchOutput.trim()),
    stashes: parseTbToolsStashes(stashesOutput),
  };
}

export function filterCleanupPlan(plan, {
  refs = true,
  branches = true,
  stashes = true,
} = {}) {
  return {
    refs: refs ? plan.refs : [],
    branches: branches ? plan.branches : [],
    stashes: stashes ? plan.stashes : [],
  };
}

export function getCleanupItemCount(plan) {
  return plan.refs.length + plan.branches.length + plan.stashes.length;
}

export function formatCleanupPlan(plan) {
  const lines = [];

  lines.push(`Checkpoint refs: ${plan.refs.length}`);
  lines.push(...plan.refs.map((ref) => `  ${ref}`));
  lines.push(`Merged Bug branches: ${plan.branches.length}`);
  lines.push(...plan.branches.map((branch) => `  ${branch}`));
  lines.push(`tb-tools stashes: ${plan.stashes.length}`);
  lines.push(...plan.stashes.map((stash) => `  ${stash.ref} ${stash.message}`));

  return lines.join("\n");
}

export function createCleanupCommand({
  getPlan = getCleanupPlan,
  gitCommand = git,
  prompts = readlineSync,
  write = console.log,
} = {}) {
  return async function cleanup(options = {}) {
    const plan = filterCleanupPlan(await getPlan(options), options);
    write(formatCleanupPlan(plan));

    if (!getCleanupItemCount(plan) || options.dryRun) {
      return;
    }

    if (!options.yes && !prompts.keyInYNStrict("Delete cleanup candidates? [y/n]:", { guide: false })) {
      return;
    }

    for (const ref of plan.refs) {
      await gitCommand(["update-ref", "-d", ref], undefined, true);
    }

    for (const branch of plan.branches) {
      await gitCommand(["branch", "-d", branch], undefined, true);
    }

    for (const stash of [...plan.stashes].sort((a, b) => b.index - a.index)) {
      await gitCommand(["stash", "drop", stash.ref], undefined, true);
    }
  };
}

export default createCleanupCommand();
