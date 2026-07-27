import ora from "ora";
import { DEFAULT_BRANCH, git } from "../lib/git.mjs";
import { mach } from "../lib/utils.mjs";

export const LINT_DIRS = ["build", "calendar", "chat", "docs", "mail", "tools"];

function getOutputPaths(output = "") {
  return String(output).split("\n").filter(Boolean);
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean)));
}

export async function isHeadPublishedOnMain({
  base = `origin/${DEFAULT_BRANCH}`,
  cwd,
  runGit = git,
} = {}) {
  try {
    await runGit(["merge-base", "--is-ancestor", "HEAD", base], cwd, true);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentCommitLintFiles({
  base = `origin/${DEFAULT_BRANCH}`,
  cwd,
  runGit = git,
} = {}) {
  if (await isHeadPublishedOnMain({ base, cwd, runGit })) {
    return [];
  }

  const output = await runGit([
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--diff-filter=ACMR",
    "-r",
    "--root",
    "HEAD",
  ], cwd, true);

  return getOutputPaths(output);
}

export async function getUncommittedLintFiles({
  cwd,
  runGit = git,
} = {}) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(["diff", "--name-only", "--diff-filter=ACMR"], cwd, true),
    runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd, true),
    runGit(["ls-files", "--others", "--exclude-standard"], cwd, true),
  ]);

  return uniquePaths([
    ...getOutputPaths(unstaged),
    ...getOutputPaths(staged),
    ...getOutputPaths(untracked),
  ]);
}

export async function getDefaultLintFiles({
  base = `origin/${DEFAULT_BRANCH}`,
  cwd,
  runGit = git,
} = {}) {
  const [commitFiles, uncommittedFiles] = await Promise.all([
    getCurrentCommitLintFiles({ base, cwd, runGit }),
    getUncommittedLintFiles({ cwd, runGit }),
  ]);

  return uniquePaths([...commitFiles, ...uncommittedFiles]);
}

export function createLintCommand({
  getLintFiles = getDefaultLintFiles,
  runMach = mach,
  createSpinner = ora,
} = {}) {
  return async function lint({
    all = false,
    base = `origin/${DEFAULT_BRANCH}`,
    cwd,
  } = {}) {
    const lintSpinner = createSpinner({
      text: "Linting",
      spinner: "aesthetic"
    }).start();

    try {
      const lintAll = all === true || all === "true";
      const targets = lintAll ? LINT_DIRS : await getLintFiles({ base, cwd });

      if (!targets.length) {
        lintSpinner.succeed("No files to lint.");
        return targets;
      }

      await runMach(["commlint", ...targets, "--fix"]);
      lintSpinner.succeed();
      return targets;
    } catch (error) {
      lintSpinner.fail();
      throw error;
    }
  };
}

export default createLintCommand();
