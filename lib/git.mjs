import chalk from "chalk";
import ora from "ora";
import { run, getUrls } from "./utils.mjs";
import { checkbox, input } from "@inquirer/prompts";

export const DEFAULT_BRANCH = "main";

export async function git(command, cwd, silent) {
  const args = Array.isArray(command) ? command : command.split(" ");
  return run({ cmd: "git", cwd, args, capture: true, silent });
}

export async function getCommitMessage() {
  return git(["log", "-1", "--format=%B"], undefined, true);
}

export async function getReviewers() {
  const lines = (await getCommitMessage()).split(/\n/);
  const messageParts = lines[0].split(".");
  return messageParts[messageParts.length - 1].split(",");
}

export async function getIndividualReviewers() {
  return (await getReviewers()).filter((item) => !/^#/.test(item)).join(",");
}

export async function getGroupReviewers() {
  return (await getReviewers()).filter((item) => /^#/.test(item)).join(",");
}

export async function getRevision() {
  const message = await getCommitMessage();
  const urls = getUrls(message) || [];
  const phabUrl = urls[urls.length - 1];

  if (!phabUrl) {
    throw new Error("No Phabricator revision URL found in the current commit message.");
  }

  const parts = phabUrl.split("/");
  return parts[parts.length - 1];
}

export async function pullUp(repo = "comm") {
  const cwd = repo === "comm" ? "." : "..";
  const label = repo === "comm" ? "Thunderbird" : "Firefox";
  const status = ora({
    text: `Updating ${label}`,
    spinner: "aesthetic"
  }).start();

  await git(["fetch", "origin", DEFAULT_BRANCH], cwd, true);

  try {
    await git(["switch", DEFAULT_BRANCH], cwd, true);
  } catch {
    await git(["switch", "-C", DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`], cwd, true);
  }

  await git(["pull", "--ff-only", "origin", DEFAULT_BRANCH], cwd, true);

  status.succeed();
}

export async function getCommit(cwd) {
  return (await git(["rev-parse", "HEAD"], cwd, true)).trim();
}

export async function getCurrentBranch(cwd) {
  return (await git(["branch", "--show-current"], cwd, true)).trim();
}

export async function getStackParent(cwd) {
  return (await git(["merge-base", "HEAD", `origin/${DEFAULT_BRANCH}`], cwd, true)).trim();
}

export async function createCheckpoint(name, cwd) {
  const branch = await getCurrentBranch(cwd);
  const commit = await getCommit(cwd);
  const ref = `refs/tb-tools/${name}`;

  await git(["update-ref", ref, commit], cwd, true);

  return { branch, commit, ref };
}

export async function restoreCheckpoint(checkpoint, cwd, { clean = false } = {}) {
  const commit = typeof checkpoint === "string" ? checkpoint : checkpoint.commit;
  const branch = typeof checkpoint === "string" ? "" : checkpoint.branch;

  if (branch) {
    try {
      await git(["switch", branch], cwd, true);
    } catch {
      await git(["switch", "--detach", commit], cwd, true);
    }
  } else {
    await git(["switch", "--detach", commit], cwd, true);
  }

  await git(["reset", "--hard", commit], cwd, true);

  if (clean) {
    await git(["clean", "-fd"], cwd, true);
  }
}

export async function isWorkingTreeClean(cwd) {
  const status = await git(["status", "--porcelain"], cwd, true);
  return !status.trim();
}

export async function ensureWorkingTreeClean(message = "Commit or stash changes and try again", cwd) {
  if (!(await isWorkingTreeClean(cwd))) {
    throw new Error(message);
  }
}

function parseStatusLine(line) {
  if (!line) {
    return null;
  }

  const code = line.substring(0, 2);
  let file = line.substring(3);

  if (file.includes(" -> ")) {
    file = file.split(" -> ").pop();
  }

  if (code === "??") {
    return { status: "?", file };
  }

  if (code.includes("D")) {
    return { status: "!", file };
  }

  if (code.includes("A")) {
    return { status: "A", file };
  }

  return { status: "M", file };
}

export async function getFileStatus({
  modified = true,
  added = true,
  removed = true,
  untracked = true
} = {}) {
  const status = await git(["status", "--porcelain"], undefined, true);
  let files = status.split("\n").map(parseStatusLine).filter(Boolean);

  if (!modified) {
    files = files.filter(({ status }) => status !== "M");
  }

  if (!added) {
    files = files.filter(({ status }) => status !== "A");
  }

  if (!removed) {
    files = files.filter(({ status }) => status !== "!");
  }

  if (!untracked) {
    files = files.filter(({ status }) => status !== "?");
  }

  return files;
}

export async function getChangedFilePaths(base = `origin/${DEFAULT_BRANCH}`) {
  let committedFiles;

  try {
    const mergeBase = (await git(["merge-base", "HEAD", base], undefined, true)).trim();
    committedFiles = await git(["diff", "--name-only", mergeBase, "HEAD"], undefined, true);
  } catch {
    committedFiles = await git(["show", "--name-only", "--format=", "HEAD"], undefined, true);
  }

  committedFiles = committedFiles.split("\n").filter(Boolean);
  const dirtyFiles = (await getFileStatus()).map(({ file }) => file);

  return Array.from(new Set([...committedFiles, ...dirtyFiles]));
}

export async function addRemoveFiles() {
  const files = await getFileStatus({ modified: false, added: false, removed: false });

  if (!files.length) {
    return;
  }

  const choices = files.map((file) => ({
    name: `${chalk.green("Added")} - ${file.file}`,
    value: file
  }));

  const filesToUpdate = await checkbox({
    message: "Select new files to add",
    choices,
    pageSize: 30
  });

  for (const file of filesToUpdate) {
    try {
      await git(["add", "--", file.file], undefined, true);
    } catch (error) {
      console.error(error);
    }
  }
}

export async function stageFiles() {
  await git(["add", "-u"], undefined, true);
  await addRemoveFiles();
}

export async function amend({ addRemove = true } = {}) {
  if (addRemove) {
    await stageFiles();
  }
  await git(["commit", "--amend", "--no-edit"], undefined, true);
}

export async function getBranch() {
  return getCurrentBranch();
}

export async function commit() {
  const branch = await getBranch();
  const prefix = branch.split("_")[0].replace("-", " ");
  const text = await input({ message: "Enter commit message:", required: true });
  const reviewers = await input({ message: "Enter reviewers seperated by commas:" });
  const message = `${prefix} - ${text}. r=${reviewers}`;

  await stageFiles();

  try {
    await git(["commit", "-m", message], undefined, true);

    console.info(`${chalk.green("✓ Created new commit - ")} ${message}`);
  } catch (error) {
    console.error(error);
    console.info(`${chalk.red("✖ No changes found")}`);
  }
}

export async function showPendingCommits(base = `origin/${DEFAULT_BRANCH}`) {
  return git(["log", "--oneline", "--decorate", `${base}..HEAD`]);
}

export async function discardLastCommit() {
  await git(["reset", "--hard", "HEAD~1"]);
}

export async function handleConflict() {
  await git(["rebase", "--continue"]);
}
