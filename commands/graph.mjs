import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hljs from "highlight.js";
import openUrl from "open";
import { run } from "../lib/utils.mjs";
import { comment as defaultComment } from "../lib/phab.mjs";
import { DEFAULT_BRANCH } from "../lib/git.mjs";
import { createSubmitCommand } from "./submit.mjs";
import { createTestCommand } from "./test.mjs";
import { createTryCommand } from "./try.mjs";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";
const DEFAULT_MAX_DIFF_BYTES = 200000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SUBMIT_OUTPUT_LIMIT = 160000;
const WORKING_TREE_CHANGES_HASH = "uncommitted-changes";
const GRAPH_SUBMIT_OPTIONS = {
  artifact: true,
  flavor: "all",
  selector: "auto",
};
const GRAPH_LINT_DIRS = ["build", "calendar", "chat", "docs", "mail", "tools"];
const WORKING_TREE_AUTHOR = {
  name: "Working tree",
  email: "",
  timestamp: 0,
};
const HIGHLIGHT_LANGUAGE_BY_EXTENSION = new Map([
  [".c", "c"],
  [".cc", "cpp"],
  [".cjs", "javascript"],
  [".cpp", "cpp"],
  [".css", "css"],
  [".ftl", "ini"],
  [".h", "cpp"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".html", "xml"],
  [".ini", "ini"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".md", "markdown"],
  [".mm", "objectivec"],
  [".mozbuild", "python"],
  [".py", "python"],
  [".rs", "rust"],
  [".scss", "scss"],
  [".sh", "bash"],
  [".toml", "ini"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".xml", "xml"],
  [".xhtml", "xml"],
  [".xul", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);
const HIGHLIGHT_LANGUAGE_BY_BASENAME = new Map([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["moz.build", "python"],
  ["moz.configure", "python"],
  ["package-lock.json", "json"],
  ["package.json", "json"],
]);

export function parseDecorations(decorations = "") {
  const refs = [];

  for (const decoration of decorations.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (decoration.includes(" -> ")) {
      const [source, target] = decoration.split(" -> ").map((item) => item.trim());
      if (source === "HEAD") {
        refs.push("HEAD");
      }
      refs.push(target);
      continue;
    }

    refs.push(decoration);
  }

  return Array.from(new Set(refs));
}

export function parseGitLog(output = "") {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, decorations, authorName, authorEmail, authorTimestamp, subject] = record.split(FIELD_SEPARATOR);

      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: parseDecorations(decorations),
        author: {
          name: authorName || "",
          email: authorEmail || "",
          timestamp: Number(authorTimestamp || 0) * 1000,
        },
        subject: subject || hash,
      };
    });
}

export function pruneMissingParents(commits) {
  const knownHashes = new Set(commits.map((commit) => commit.hash));

  return commits.map((commit) => ({
    ...commit,
    parents: commit.parents.filter((parent) => knownHashes.has(parent)),
  }));
}

export function chooseCheckoutBranch(refsOutput = "", preferredBranch = "") {
  const branches = refsOutput
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean);

  if (preferredBranch && preferredBranch !== "(detached)" && branches.includes(preferredBranch)) {
    return preferredBranch;
  }

  return branches[0] || "";
}

function parseBranchRefs(refsOutput = "") {
  return refsOutput
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean);
}

function isNamedBranch(branch = "") {
  return branch && branch !== "(detached)";
}

function uniqueBranches(branches) {
  return [...new Set(branches)];
}

export function choosePruneBranches({
  containingRefs = "",
  tipRefs = "",
  currentBranch = "",
  preferredBranch = "",
} = {}) {
  const containingBranches = parseBranchRefs(containingRefs);
  const tipBranches = parseBranchRefs(tipRefs).filter((branch) => containingBranches.includes(branch));
  const preferredBranches = [currentBranch, preferredBranch]
    .filter(isNamedBranch)
    .filter((branch) => containingBranches.includes(branch));
  const preferred = uniqueBranches(preferredBranches)[0];

  if (preferred) {
    return [preferred];
  }

  if (tipBranches.length) {
    return uniqueBranches(tipBranches);
  }

  if (containingBranches.length === 1) {
    return containingBranches;
  }

  return [];
}

export function chooseRebaseBranch({
  containingRefs = "",
  tipRefs = "",
  currentBranch = "",
} = {}) {
  const containingBranches = uniqueBranches(parseBranchRefs(containingRefs));
  const tipBranches = uniqueBranches(parseBranchRefs(tipRefs))
    .filter((branch) => containingBranches.includes(branch));

  if (tipBranches.length) {
    return chooseCheckoutBranch(tipBranches.join("\n"), currentBranch);
  }

  const nonCurrentBranches = containingBranches.filter((branch) => branch !== currentBranch);

  if (nonCurrentBranches.length === 1) {
    return nonCurrentBranches[0];
  }

  if (containingBranches.length === 1) {
    return containingBranches[0];
  }

  return "";
}

export function chooseRewordBranch({
  containingRefs = "",
  tipRefs = "",
  currentBranch = "",
} = {}) {
  const containingBranches = uniqueBranches(parseBranchRefs(containingRefs));
  const tipBranches = uniqueBranches(parseBranchRefs(tipRefs))
    .filter((branch) => containingBranches.includes(branch));

  if (currentBranch && currentBranch !== "(detached)" && containingBranches.includes(currentBranch)) {
    return currentBranch;
  }

  if (tipBranches.length === 1) {
    return tipBranches[0];
  }

  if (containingBranches.length === 1) {
    return containingBranches[0];
  }

  return "";
}

function getGitLogArgs(limit, offset = 0) {
  const args = [
    "log",
    "--all",
    "--topo-order",
    "--decorate=short",
    "--date=unix",
    `--format=${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%at${FIELD_SEPARATOR}%s`,
  ];

  if (limit) {
    args.splice(3, 0, `--max-count=${limit}`);
  }

  if (offset) {
    args.splice(3, 0, `--skip=${offset}`);
  }

  return args;
}

function getGitShowArgs(hash) {
  return [
    "show",
    "--format=",
    "--patch",
    "--find-renames",
    "--no-ext-diff",
    "--no-color",
    hash,
  ];
}

function getGitWorkingTreeDiffArgs() {
  return [
    "diff",
    "--patch",
    "--find-renames",
    "--no-ext-diff",
    "--no-color",
    "HEAD",
  ];
}

function getGitUntrackedArgs() {
  return ["ls-files", "--others", "--exclude-standard", "-z"];
}

function getGitNoIndexDiffArgs(file) {
  return [
    "diff",
    "--no-index",
    "--patch",
    "--no-ext-diff",
    "--no-color",
    "--",
    "/dev/null",
    file,
  ];
}

function getGitCommitMessageArgs(hash = "HEAD") {
  const args = ["log", "-1", "--format=%B"];

  if (hash && hash !== "HEAD") {
    args.push(hash);
  }

  return args;
}

function getGitAddAllArgs() {
  return ["add", "-A"];
}

function getGitAmendArgs(messagePath, { includeChanges = false } = {}) {
  return includeChanges
    ? ["commit", "--amend", "-F", messagePath]
    : ["commit", "--amend", "--only", "-F", messagePath];
}

function normalizeCommitMessage(message = "") {
  return `${String(message).replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function ensureAmendedCommitMessage(actualMessage, expectedMessage, hash) {
  if (normalizeCommitMessage(actualMessage) === normalizeCommitMessage(expectedMessage)) {
    return;
  }

  const error = new Error(`Git reported a successful amend, but ${hash.slice(0, 12)} does not have the requested commit message.`);
  error.statusCode = 500;
  throw error;
}

function getContentHash(value = "") {
  return createHash("sha256").update(value).digest("hex");
}

export function isWorkingTreeCommitHash(hash) {
  return hash === WORKING_TREE_CHANGES_HASH;
}

function isCheckedOutCommit(commit) {
  return Array.isArray(commit?.refs) && commit.refs.includes("HEAD");
}

function getCheckedOutCommitHash(commits, headHash = "") {
  return String(headHash || "").trim() || commits.find(isCheckedOutCommit)?.hash || "";
}

function insertWorkingTreeCommitsNearParent(gitCommits, workingTreeCommits) {
  if (!workingTreeCommits.length) {
    return gitCommits;
  }

  const orderedCommits = [...gitCommits];

  for (const workingTreeCommit of workingTreeCommits) {
    const parentHash = workingTreeCommit.parents[0] || "";
    const parentIndex = orderedCommits.findIndex((commit) => commit.hash === parentHash);

    if (parentIndex === -1) {
      orderedCommits.unshift(workingTreeCommit);
    } else {
      orderedCommits.splice(parentIndex, 0, workingTreeCommit);
    }
  }

  return orderedCommits;
}

function getWorkingTreeCommit({ parentHash, changeId = "", timestamp = Date.now() }) {
  return {
    hash: WORKING_TREE_CHANGES_HASH,
    parents: parentHash ? [parentHash] : [],
    refs: ["uncommitted"],
    author: {
      ...WORKING_TREE_AUTHOR,
      timestamp,
    },
    subject: "Uncommitted changes",
    workingTree: true,
    changeId,
  };
}

async function runDiffCommand(command, runCommand) {
  try {
    return await runCommand(command);
  } catch (error) {
    if (error?.code === 1 && typeof error.stdout === "string") {
      return error.stdout;
    }

    throw error;
  }
}

function parseNullSeparated(output = "") {
  return output.split("\0").filter(Boolean);
}

async function getUntrackedDiff({
  cwd,
  runCommand = run,
}) {
  const output = await runCommand({
    cmd: "git",
    args: getGitUntrackedArgs(),
    cwd,
    capture: true,
    silent: true,
  });
  const files = parseNullSeparated(output);
  const diffs = [];

  for (const file of files) {
    const diff = await runDiffCommand({
      cmd: "git",
      args: getGitNoIndexDiffArgs(file),
      cwd,
      capture: true,
      silent: true,
    }, runCommand);

    if (diff.trim()) {
      diffs.push(diff.trimEnd());
    }
  }

  return diffs.join("\n");
}

async function getRawWorkingTreeDiff({
  cwd,
  runCommand = run,
}) {
  const diff = await runDiffCommand({
    cmd: "git",
    args: getGitWorkingTreeDiffArgs(),
    cwd,
    capture: true,
    silent: true,
  }, runCommand);

  const untrackedDiff = await getUntrackedDiff({ cwd, runCommand });

  return [diff.trimEnd(), untrackedDiff].filter(Boolean).join("\n");
}

export async function getWorkingTreeDiff({
  cwd,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  runCommand = run,
}) {
  return truncateDiff(await getRawWorkingTreeDiff({ cwd, runCommand }), maxDiffBytes);
}

export async function getWorkingTreeCommits({
  cwd,
  parentHash = "",
  diffs = true,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  runCommand = run,
}) {
  const diff = await getRawWorkingTreeDiff({ cwd, runCommand });
  const hasChanges = Boolean(diff.trim());
  const commits = [];
  const commitDiffs = {};

  if (hasChanges) {
    commits.push(getWorkingTreeCommit({
      parentHash,
      changeId: getContentHash(diff),
    }));

    if (diffs) {
      commitDiffs[WORKING_TREE_CHANGES_HASH] = truncateDiff(diff, maxDiffBytes);
    }
  }

  return {
    commits,
    diffs: commitDiffs,
  };
}

async function getCheckoutHeadHash({
  cwd,
  runCommand = run,
}) {
  try {
    return (await runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd,
      capture: true,
      silent: true,
    })).trim();
  } catch {
    return "";
  }
}

export async function getGraphCurrentCommitMessage({
  graph,
  runCommand = run,
}) {
  return getGraphCommitMessage({
    graph,
    hash: "HEAD",
    runCommand,
  });
}

export async function getGraphCommitMessage({
  graph,
  hash = "HEAD",
  runCommand = run,
}) {
  if (!graph) {
    throw new Error("Unknown graph checkout.");
  }

  const targetHash = isWorkingTreeCommitHash(hash) ? "HEAD" : hash;

  return runCommand({
    cmd: "git",
    args: getGitCommitMessageArgs(targetHash),
    cwd: graph.path,
    capture: true,
    silent: true,
  });
}

async function amendCheckedOutCommit({
  graph,
  message,
  expectedChangeId = "",
  includeChanges = false,
  runCommand = run,
  writeMessage = writeFile,
  removeMessage = unlink,
}) {
  if (!graph) {
    const error = new Error("Unknown graph checkout.");
    error.statusCode = 404;
    throw error;
  }

  const commitMessage = String(message || "");

  if (!commitMessage.trim()) {
    const error = new Error("Commit message cannot be empty.");
    error.statusCode = 400;
    throw error;
  }

  if (includeChanges) {
    const workingTree = await getWorkingTreeCommits({
      cwd: graph.path,
      diffs: false,
      runCommand,
    });
    const workingTreeCommit = workingTree.commits[0];

    if (!workingTreeCommit) {
      const error = new Error("No uncommitted changes to amend.");
      error.statusCode = 409;
      throw error;
    }

    if (expectedChangeId && workingTreeCommit.changeId !== expectedChangeId) {
      const error = new Error("Working tree changed since this diff was loaded. Select uncommitted changes again before amending.");
      error.statusCode = 409;
      throw error;
    }
  }

  const messagePath = path.join(os.tmpdir(), `tb-tools-amend-${randomUUID()}.txt`);

  await writeMessage(messagePath, commitMessage.endsWith("\n") ? commitMessage : `${commitMessage}\n`);

  try {
    if (includeChanges) {
      await runCommand({
        cmd: "git",
        args: getGitAddAllArgs(),
        cwd: graph.path,
        silent: true,
      });
    }
    await runCommand({
      cmd: "git",
      args: getGitAmendArgs(messagePath, { includeChanges }),
      cwd: graph.path,
      silent: true,
    });
  } finally {
    await removeMessage(messagePath).catch(() => {});
  }

  const [branch, currentHash] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    }),
  ]);
  const currentHashValue = currentHash.trim();
  const amendedMessage = await getGraphCommitMessage({
    graph,
    hash: currentHashValue,
    runCommand,
  });

  ensureAmendedCommitMessage(amendedMessage, commitMessage, currentHashValue);

  graph.branch = branch || "(detached)";

  return {
    action: "amend",
    label: graph.label,
    path: graph.path,
    branch: graph.branch,
    hash: currentHashValue,
    rewrittenHash: currentHashValue,
    currentHash: currentHashValue,
    message: `${graph.label} amended current commit ${currentHashValue.slice(0, 12)}.`,
  };
}

export async function amendCurrentCommit({
  graph,
  message,
  expectedChangeId = "",
  includeChanges = false,
  runCommand = run,
  writeMessage = writeFile,
  removeMessage = unlink,
}) {
  return amendCheckedOutCommit({
    graph,
    message,
    expectedChangeId,
    includeChanges,
    runCommand,
    writeMessage,
    removeMessage,
  });
}

export async function amendCommitMessage({
  graph,
  hash = "HEAD",
  message,
  expectedChangeId = "",
  includeChanges = false,
  runCommand = run,
  writeMessage = writeFile,
  removeMessage = unlink,
}) {
  const selectedHash = String(hash || "HEAD");

  if (includeChanges && selectedHash !== "HEAD" && !isWorkingTreeCommitHash(selectedHash)) {
    const error = new Error("Uncommitted changes can only be amended into the checked out commit.");
    error.statusCode = 400;
    throw error;
  }

  if (includeChanges || selectedHash === "HEAD" || isWorkingTreeCommitHash(selectedHash)) {
    return amendCheckedOutCommit({
      graph,
      message,
      expectedChangeId,
      includeChanges,
      runCommand,
      writeMessage,
      removeMessage,
    });
  }

  if (!graph) {
    const error = new Error("Unknown graph checkout.");
    error.statusCode = 404;
    throw error;
  }

  ensureKnownGraphCommit(graph, selectedHash);

  const commitMessage = String(message || "");

  if (!commitMessage.trim()) {
    const error = new Error("Commit message cannot be empty.");
    error.statusCode = 400;
    throw error;
  }

  const base = await getCurrentGraphBase(graph, runCommand);

  if (base.hash === selectedHash) {
    return amendCheckedOutCommit({
      graph,
      message: commitMessage,
      runCommand,
      writeMessage,
      removeMessage,
    });
  }

  await ensureCleanGraph(graph, runCommand);

  const [branchRefs, containingBranchRefs, parents] = await Promise.all([
    getLocalBranchesAtCommit(graph, selectedHash, runCommand),
    getLocalBranchesContainingCommit(graph, selectedHash, runCommand),
    getCommitParents(graph, selectedHash, runCommand),
  ]);
  const containingBranches = parseBranchRefs(containingBranchRefs);
  const branch = chooseRewordBranch({
    containingRefs: containingBranchRefs,
    tipRefs: branchRefs,
    currentBranch: base.branch,
  });

  if (!containingBranches.length) {
    const error = new Error(`No local branches contain ${selectedHash.slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  if (!branch) {
    const error = new Error(`Commit ${selectedHash.slice(0, 12)} is contained by multiple local branches (${containingBranches.join(", ")}). Check out the branch to amend and try again.`);
    error.statusCode = 409;
    throw error;
  }

  if (parents.length !== 1) {
    const error = new Error(parents.length
      ? `Cannot amend merge commit ${selectedHash.slice(0, 12)} because it has multiple parents.`
      : `Cannot amend root commit ${selectedHash.slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  const parent = parents[0];
  const stackCommits = await getRebaseCommitStack(graph, selectedHash, branch, runCommand);
  const messagePath = path.join(os.tmpdir(), `tb-tools-amend-${randomUUID()}.txt`);
  let rewrittenHash = "";

  await writeMessage(messagePath, commitMessage.endsWith("\n") ? commitMessage : `${commitMessage}\n`);

  try {
    await runCommand({
      cmd: "git",
      args: ["switch", "--detach", parent],
      cwd: graph.path,
      silent: true,
    });

    for (const [index, commit] of stackCommits.entries()) {
      await runCommand({
        cmd: "git",
        args: ["cherry-pick", "--no-commit", commit],
        cwd: graph.path,
        silent: true,
      });

      await runCommand({
        cmd: "git",
        args: ["commit", "-C", commit],
        cwd: graph.path,
        silent: true,
      });

      if (index === 0) {
        await runCommand({
          cmd: "git",
          args: getGitAmendArgs(messagePath, { includeChanges: false }),
          cwd: graph.path,
          silent: true,
        });
        rewrittenHash = (await runCommand({
          cmd: "git",
          args: ["rev-parse", "HEAD"],
          cwd: graph.path,
          capture: true,
          silent: true,
        })).trim();
        const amendedMessage = await getGraphCommitMessage({
          graph,
          hash: rewrittenHash,
          runCommand,
        });

        ensureAmendedCommitMessage(amendedMessage, commitMessage, rewrittenHash);
      }
    }
  } finally {
    await removeMessage(messagePath).catch(() => {});
  }

  let currentHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();

  await runCommand({
    cmd: "git",
    args: ["branch", "-f", branch, currentHash],
    cwd: graph.path,
    silent: true,
  });
  await runCommand({
    cmd: "git",
    args: ["switch", branch],
    cwd: graph.path,
    silent: true,
  });
  currentHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();
  graph.branch = branch;

  return {
    action: "amend",
    label: graph.label,
    path: graph.path,
    hash: selectedHash,
    branch,
    parent,
    commits: stackCommits,
    amendedCount: stackCommits.length,
    rewrittenHash,
    currentHash,
    message: `${graph.label} amended message for ${selectedHash.slice(0, 12)}${stackCommits.length > 1 ? ` and replayed ${stackCommits.length - 1} descendant commit${stackCommits.length === 2 ? "" : "s"}` : ""} on branch ${branch}.`,
  };
}

export function splitPrettyDiffFiles(diff) {
  const files = {};
  let filename;

  for (const line of diff.split("\n")) {
    if (!line || line.startsWith("*")) {
      continue;
    }

    if (line.startsWith("diff --")) {
      filename = line.replace(/^diff --(?:cc |git a\/)(\S+).*$/, "$1");
      files[filename] = [];
    }

    if (filename) {
      files[filename].push(line);
    }
  }

  return Object.keys(files).length ? files : null;
}

function parseDiffHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

  if (!match) {
    return null;
  }

  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function isOldFileMarker(line) {
  return /^--- /.test(line);
}

function isNewFileMarker(line) {
  return /^\+\+\+ /.test(line);
}

function isDiffMetadataLine(line) {
  return (
    line.startsWith("diff --") ||
    line.startsWith("index ") ||
    isOldFileMarker(line) ||
    isNewFileMarker(line) ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ")
  );
}

function getDiffLineNumbers(line, state) {
  const hunk = parseDiffHunkHeader(line);

  if (hunk) {
    state.oldLine = hunk.oldLine;
    state.newLine = hunk.newLine;
    return { oldLine: "", newLine: "" };
  }

  const inHunk = state.oldLine !== null && state.newLine !== null;

  if (!inHunk) {
    return { oldLine: "", newLine: "" };
  }

  if (line.startsWith("+")) {
    return { oldLine: "", newLine: state.newLine++ };
  }

  if (line.startsWith("-")) {
    return { oldLine: state.oldLine++, newLine: "" };
  }

  if (line.startsWith(" ")) {
    return {
      oldLine: state.oldLine++,
      newLine: state.newLine++,
    };
  }

  return { oldLine: "", newLine: "" };
}

function getDiffLineClass(line, state) {
  const inHunk = state.oldLine !== null && state.newLine !== null;

  if (!inHunk && isDiffMetadataLine(line)) {
    return "file";
  }

  if (line.startsWith("@@")) {
    return "info";
  }

  if (line.startsWith("+")) {
    return "insert";
  }

  if (line.startsWith("-")) {
    return "delete";
  }

  if (line.startsWith(" ")) {
    return "context";
  }

  return "file";
}

function shouldRenderDiffLine(line, state) {
  const inHunk = state.oldLine !== null && state.newLine !== null;

  return inHunk || line.startsWith("@@") || !isDiffMetadataLine(line);
}

function countDiffChanges(lines) {
  let inHunk = false;

  return lines.reduce((counts, line) => {
    if (parseDiffHunkHeader(line)) {
      inHunk = true;
    } else if (line.startsWith("+") && (inHunk || !isNewFileMarker(line))) {
      counts.insertions++;
    } else if (line.startsWith("-") && (inHunk || !isOldFileMarker(line))) {
      counts.deletions++;
    }

    return counts;
  }, { insertions: 0, deletions: 0 });
}

export function formatChangeCountLabel(insertions, deletions) {
  const additionLabel = insertions === 1 ? "addition" : "additions";
  const deletionLabel = deletions === 1 ? "deletion" : "deletions";

  return `${insertions} ${additionLabel} and ${deletions} ${deletionLabel}`;
}

export function getDiffChangeCounts(diff) {
  const files = splitPrettyDiffFiles(diff);

  if (!files) {
    return { insertions: 0, deletions: 0 };
  }

  return Object.values(files).reduce((totals, lines) => {
    const { insertions, deletions } = countDiffChanges(lines);

    totals.insertions += insertions;
    totals.deletions += deletions;

    return totals;
  }, { insertions: 0, deletions: 0 });
}

function getHighlightLanguage(file) {
  const normalized = String(file || "").toLowerCase();
  const basename = path.basename(normalized);

  if (HIGHLIGHT_LANGUAGE_BY_BASENAME.has(basename)) {
    return HIGHLIGHT_LANGUAGE_BY_BASENAME.get(basename);
  }

  if (basename.endsWith(".sys.mjs")) {
    return "javascript";
  }

  const extension = path.extname(basename);
  return HIGHLIGHT_LANGUAGE_BY_EXTENSION.get(extension) || "";
}

function highlightDiffCode(content, language) {
  if (!language || !content) {
    return escapeDiffHtml(content);
  }

  if (!hljs.getLanguage(language)) {
    return escapeDiffHtml(content);
  }

  try {
    return hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    }).value;
  } catch {
    return escapeDiffHtml(content);
  }
}

function formatDiffLineContent(line, className, language) {
  if (className === "insert" || className === "delete" || className === "context") {
    const marker = className === "context" ? " " : line.charAt(0);
    const content = line.slice(1);

    return `<span class="line-marker">${escapeDiffHtml(marker)}</span><span class="line-content">${highlightDiffCode(content, language)}</span>`;
  }

  return `<span class="line-marker"></span><span class="line-content">${escapeDiffHtml(line)}</span>`;
}

function escapeDiffHtml(value = "") {
  return String(value)
    .replace(/\$/g, "$$$$")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\t/g, "    ");
}

export function formatPrettyDiffHtml(diff) {
  const files = splitPrettyDiffFiles(diff);

  if (!files) {
    return "";
  }

  return Object.entries(files).map(([file, lines]) => {
    const { insertions, deletions } = countDiffChanges(lines);
    const changeCountLabel = formatChangeCountLabel(insertions, deletions);
    const language = getHighlightLanguage(file);
    const lineNumberState = { oldLine: null, newLine: null };
    const diffLines = lines.reduce((rendered, line) => {
      if (!shouldRenderDiffLine(line, lineNumberState)) {
        return rendered;
      }

      const { oldLine, newLine } = getDiffLineNumbers(line, lineNumberState);
      const className = getDiffLineClass(line, lineNumberState);

      rendered.push(`<tr class="diff-line ${className}">
          <td class="line-number old-line">${oldLine}</td>
          <td class="line-number new-line">${newLine}</td>
          <td class="line-code">${formatDiffLineContent(line, className, language)}</td>
        </tr>`);
      return rendered;
    }, []).join("\n");

    return `<section class="pretty-file">
      <h3>
        <span class="file-heading">
          <span class="file-icon" aria-hidden="true"></span>
          <span class="title">${escapeDiffHtml(file)}</span>
        </span>
        <span class="file-actions">
          <span class="file-stats" aria-label="${changeCountLabel}">
            <span class="stat-additions">+${insertions}</span>
            <span class="stat-deletions">-${deletions}</span>
          </span>
          <button class="copy-path" type="button" data-path="${escapeHtml(file)}">Copy path</button>
        </span>
      </h3>
      <div class="file-diff"><table class="diff-table"><tbody>${diffLines}</tbody></table></div>
    </section>`;
  }).join("\n");
}

export function truncateDiff(diff, maxDiffBytes = DEFAULT_MAX_DIFF_BYTES) {
  const maxBytes = Number(maxDiffBytes);
  const fullHtml = formatPrettyDiffHtml(diff);
  const changeCounts = getDiffChangeCounts(diff);

  if (!maxBytes || maxBytes < 1 || Buffer.byteLength(diff, "utf8") <= maxBytes) {
    return {
      text: diff,
      html: fullHtml,
      truncated: false,
      ...changeCounts,
    };
  }

  const truncatedText = `${Buffer.from(diff).subarray(0, maxBytes).toString("utf8")}\n\n[diff truncated at ${maxBytes} bytes]`;

  return {
    text: truncatedText,
    html: `${formatPrettyDiffHtml(truncatedText)}<pre class="info">[diff truncated at ${maxBytes} bytes]</pre>`,
    truncated: true,
    ...changeCounts,
  };
}

export async function getCommitDiffs({
  cwd,
  commits,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  runCommand = run,
}) {
  const diffs = {};

  for (const commit of commits) {
    try {
      if (isWorkingTreeCommitHash(commit.hash)) {
        diffs[commit.hash] = await getWorkingTreeDiff({
          cwd,
          maxDiffBytes,
          runCommand,
        });
      } else {
        const diff = await runCommand({
          cmd: "git",
          args: getGitShowArgs(commit.hash),
          cwd,
          capture: true,
          silent: true,
        });

        diffs[commit.hash] = truncateDiff(diff, maxDiffBytes);
      }
    } catch (error) {
      diffs[commit.hash] = {
        text: "",
        truncated: false,
        insertions: 0,
        deletions: 0,
        error: String(error?.message || error),
      };
    }
  }

  return diffs;
}

export async function getCommitDiff({
  cwd,
  hash,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  runCommand = run,
}) {
  if (isWorkingTreeCommitHash(hash)) {
    return getWorkingTreeDiff({
      cwd,
      maxDiffBytes,
      runCommand,
    });
  }

  const diff = await runCommand({
    cmd: "git",
    args: getGitShowArgs(hash),
    cwd,
    capture: true,
    silent: true,
  });

  return truncateDiff(diff, maxDiffBytes);
}

export async function getCheckoutGraphMetadata({
  label,
  cwd,
  runCommand = run,
}) {
  const absolutePath = path.resolve(cwd);

  try {
    const [root, branch] = await Promise.all([
      runCommand({ cmd: "git", args: ["rev-parse", "--show-toplevel"], cwd: absolutePath, capture: true, silent: true }),
      runCommand({ cmd: "git", args: ["branch", "--show-current"], cwd: absolutePath, capture: true, silent: true }),
    ]);

    return {
      label,
      path: root.trim() || absolutePath,
      branch: branch.trim() || "(detached)",
      commits: [],
      commitCount: 0,
      diffs: {},
    };
  } catch (error) {
    return {
      label,
      path: absolutePath,
      commits: [],
      commitCount: 0,
      diffs: {},
      error: String(error?.message || error),
    };
  }
}

export async function getCheckoutCommitPage({
  cwd,
  offset = 0,
  limit = 80,
  includeWorkingTree = false,
  workingTreeCount = 0,
  runCommand = run,
}) {
  const effectiveOffset = includeWorkingTree
    ? Math.max(0, Number(offset) - Number(workingTreeCount || 0))
    : offset;
  const output = await runCommand({
    cmd: "git",
    args: getGitLogArgs(limit, effectiveOffset),
    cwd,
    capture: true,
    silent: true,
  });
  const gitCommits = parseGitLog(output);

  if (!includeWorkingTree || Number(offset) !== 0) {
    return {
      commits: gitCommits,
      offset,
      nextOffset: Number(offset) + gitCommits.length,
      hasMore: gitCommits.length === Number(limit),
      workingTreeCount,
    };
  }

  const headHash = await getCheckoutHeadHash({
    cwd,
    runCommand,
  });
  const workingTree = await getWorkingTreeCommits({
    cwd,
    parentHash: getCheckedOutCommitHash(gitCommits, headHash) || gitCommits[0]?.hash || "",
    diffs: false,
    runCommand,
  });
  const commits = insertWorkingTreeCommitsNearParent(gitCommits, workingTree.commits);

  return {
    commits,
    offset,
    nextOffset: Number(offset) + commits.length,
    hasMore: gitCommits.length === Number(limit),
    workingTreeCount: workingTree.commits.length,
  };
}

export async function getCheckoutGraphData({
  label,
  cwd,
  limit,
  diffs = true,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  runCommand = run,
}) {
  const absolutePath = path.resolve(cwd);

  try {
    const [root, branch, log, headHash] = await Promise.all([
      runCommand({ cmd: "git", args: ["rev-parse", "--show-toplevel"], cwd: absolutePath, capture: true, silent: true }),
      runCommand({ cmd: "git", args: ["branch", "--show-current"], cwd: absolutePath, capture: true, silent: true }),
      runCommand({ cmd: "git", args: getGitLogArgs(limit), cwd: absolutePath, capture: true, silent: true }),
      getCheckoutHeadHash({ cwd: absolutePath, runCommand }),
    ]);

    const gitCommits = parseGitLog(log);
    const workingTree = await getWorkingTreeCommits({
      cwd: absolutePath,
      parentHash: getCheckedOutCommitHash(gitCommits, headHash) || gitCommits[0]?.hash || "",
      diffs,
      maxDiffBytes,
      runCommand,
    });
    const commits = pruneMissingParents(insertWorkingTreeCommitsNearParent(gitCommits, workingTree.commits));
    const commitDiffs = diffs
      ? {
          ...workingTree.diffs,
          ...await getCommitDiffs({ cwd: absolutePath, commits: gitCommits, maxDiffBytes, runCommand }),
        }
      : {};

    return {
      label,
      path: root.trim() || absolutePath,
      branch: branch.trim() || "(detached)",
      limit,
      commits,
      commitCount: gitCommits.length,
      workingTreeCount: workingTree.commits.length,
      diffs: commitDiffs,
    };
  } catch (error) {
    return {
      label,
      path: absolutePath,
      limit,
      commits: [],
      commitCount: 0,
      diffs: {},
      error: String(error?.message || error),
    };
  }
}

function ensureKnownGraphCommit(graph, hash) {
  if (!graph) {
    throw new Error("Unknown graph checkout.");
  }

  if (!graph.knownHashes?.has(hash)) {
    throw new Error("Commit has not been loaded by this graph.");
  }
}

async function ensureCleanGraph(graph, runCommand) {
  const status = await runCommand({
    cmd: "git",
    args: ["status", "--porcelain"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  if (status.trim()) {
    const error = new Error(`${graph.label} has local changes. Commit or stash them before changing commits.`);
    error.statusCode = 409;
    throw error;
  }
}

async function getLocalBranchesAtCommit(graph, hash, runCommand) {
  return runCommand({
    cmd: "git",
    args: ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", hash, "refs/heads"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
}

async function getLocalBranchesContainingCommit(graph, hash, runCommand) {
  return runCommand({
    cmd: "git",
    args: ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", hash, "refs/heads"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
}

async function getCurrentGraphBranch(graph, runCommand) {
  const branch = await runCommand({
    cmd: "git",
    args: ["branch", "--show-current"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  return branch.trim();
}

async function getCommitParents(graph, hash, runCommand) {
  const output = await runCommand({
    cmd: "git",
    args: ["rev-list", "--parents", "-n", "1", hash],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const [commit, ...parents] = output.trim().split(/\s+/).filter(Boolean);

  if (commit !== hash) {
    throw new Error(`Could not find parents for ${hash.slice(0, 12)}.`);
  }

  return parents;
}

async function getRebaseCommitStack(graph, hash, branch, runCommand) {
  if (!branch) {
    return [hash];
  }

  const output = await runCommand({
    cmd: "git",
    args: ["rev-list", "--reverse", "--topo-order", "--ancestry-path", `${hash}..${branch}`],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const descendants = output.trim().split(/\s+/).filter(Boolean);

  return [hash, ...descendants.filter((commit) => commit !== hash)];
}

async function getCurrentGraphBase(graph, runCommand) {
  const [branch, hash] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    }),
  ]);

  return {
    branch,
    hash: hash.trim(),
  };
}

function parseGraphStatusFile(line) {
  if (!line) {
    return "";
  }

  const file = line.substring(3);
  return file.includes(" -> ") ? file.split(" -> ").pop() : file;
}

async function getGraphChangedFilePaths({
  graph,
  base = `origin/${DEFAULT_BRANCH}`,
  runCommand = run,
}) {
  let committedFiles;

  try {
    const mergeBase = (await runCommand({
      cmd: "git",
      args: ["merge-base", "HEAD", base],
      cwd: graph.path,
      capture: true,
      silent: true,
    })).trim();
    committedFiles = await runCommand({
      cmd: "git",
      args: ["diff", "--name-only", mergeBase, "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    });
  } catch {
    committedFiles = await runCommand({
      cmd: "git",
      args: ["show", "--name-only", "--format=", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    });
  }

  const dirtyFiles = await runCommand({
    cmd: "git",
    args: ["status", "--porcelain"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  return Array.from(new Set([
    ...committedFiles.split("\n").filter(Boolean),
    ...dirtyFiles.split("\n").map(parseGraphStatusFile).filter(Boolean),
  ]));
}

async function runGraphMach({
  graph,
  args,
  session,
  runCommand = run,
}) {
  const command = {
    cmd: path.join("..", "mach"),
    args: Array.isArray(args) ? args : String(args).split(/\s+/).filter(Boolean),
    cwd: graph.path,
    capture: true,
  };

  return runCommand === run
    ? runInteractiveSubmitCommand({ command, session })
    : runInjectedSubmitCommand({ command, session, runCommand });
}

async function runGraphLint({
  graph,
  session,
  runCommand = run,
}) {
  await runGraphMach({
    graph,
    args: ["commlint", ...GRAPH_LINT_DIRS, "--fix"],
    session,
    runCommand,
  });
}

function withGraphSubmitCwd(graph, session, runCommand) {
  return (command) => {
    const commandWithCwd = {
      ...command,
      cwd: command.cwd || graph.path,
    };

    return runCommand === run
      ? runInteractiveSubmitCommand({ command: commandWithCwd, session })
      : runInjectedSubmitCommand({ command: commandWithCwd, session, runCommand });
  };
}

function getSubmitLinks(result = {}) {
  const links = [];

  if (result.phabUrl) {
    links.push({
      label: result.phabRevision || "Phabricator",
      url: result.phabUrl,
    });
  }

  if (result.tryUrl) {
    links.push({
      label: "Try",
      url: result.tryUrl,
    });
  }

  return links;
}

function stripAnsi(value = "") {
  const escapeCharacter = String.fromCharCode(27);

  return String(value).replace(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function appendSubmitOutput(session, output = "") {
  if (!output) {
    return;
  }

  session.output = `${session.output || ""}${stripAnsi(output)}`;

  if (session.output.length > DEFAULT_SUBMIT_OUTPUT_LIMIT) {
    session.output = session.output.slice(-DEFAULT_SUBMIT_OUTPUT_LIMIT);
  }
}

export function getInteractiveYesNoPrompt(output = "") {
  const text = stripAnsi(output).replace(/\r/g, "\n");
  const tail = text.slice(-2000);
  const match = tail.match(/(?:^|\n)([^\n]*(?:\[[Yy]\/[Nn]\]|\[[Nn]\/[Yy]\]|\((?:yes|no|always|y|n|a)(?:\/(?:yes|no|always|y|n|a)){1,3}\)\?)[^\n]*)$/i);

  if (!match) {
    return "";
  }

  return match[1].trim();
}

function askSubmitConfirm(session, message, source = "tb-tools") {
  return new Promise((resolve, reject) => {
    if (session.prompt) {
      reject(new Error("Submit is already waiting on a browser prompt."));
      return;
    }

    session.status = "prompt";
    session.message = "Waiting for input.";
    session.prompt = {
      id: randomUUID(),
      type: "confirm",
      source,
      message,
    };
    session.pendingPrompt = { resolve, reject };
  });
}

export function answerSubmitSessionPrompt(session, promptId, answer) {
  if (!session.prompt || !session.pendingPrompt) {
    const error = new Error("Submit is not waiting for input.");
    error.statusCode = 409;
    throw error;
  }

  if (session.prompt.id !== promptId) {
    const error = new Error("Submit prompt is no longer active.");
    error.statusCode = 409;
    throw error;
  }

  const pendingPrompt = session.pendingPrompt;
  session.prompt = null;
  session.pendingPrompt = null;
  session.status = "running";
  session.message = "Running submit...";
  appendSubmitOutput(session, `\n> ${answer ? "yes" : "no"}\n`);
  pendingPrompt.resolve(Boolean(answer));
}

function formatCommandForOutput(command) {
  return [command.cmd, ...(command.args || [])].join(" ");
}

function runInjectedSubmitCommand({ command, session, runCommand }) {
  appendSubmitOutput(session, `$ ${formatCommandForOutput(command)}\n`);

  return runCommand(command).then((output) => {
    appendSubmitOutput(session, output);
    return output;
  }, (error) => {
    appendSubmitOutput(session, error.stdout || "");
    appendSubmitOutput(session, error.stderr || "");
    throw error;
  });
}

export async function runInteractiveSubmitCommand({
  command,
  session,
  spawnCommand = spawn,
}) {
  appendSubmitOutput(session, `$ ${formatCommandForOutput(command)}\n`);
  const initialOutputLength = session.output.length;

  return new Promise((resolve, reject) => {
    const child = spawnCommand(command.cmd, command.args || [], {
      cwd: command.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let promptSearchStart = initialOutputLength;
    let promptPromise = Promise.resolve();

    function handleOutput(chunk, target) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      target.push(Buffer.from(text));
      appendSubmitOutput(session, text);

      if (session.prompt) {
        return;
      }

      const searchable = session.output.slice(promptSearchStart);
      const prompt = getInteractiveYesNoPrompt(searchable);

      if (!prompt) {
        return;
      }

      promptSearchStart = session.output.length;
      promptPromise = promptPromise.then(async () => {
        const answer = await askSubmitConfirm(session, prompt, command.cmd);
        child.stdin.write(answer ? "y\n" : "n\n");
      }).catch((error) => {
        child.kill();
        throw error;
      });
    }

    child.stdout.on("data", (chunk) => handleOutput(chunk, stdout));
    child.stderr.on("data", (chunk) => handleOutput(chunk, stderr));
    child.on("error", reject);
    child.on("exit", (code) => {
      promptPromise.then(() => {
        const stdoutText = Buffer.concat(stdout).toString();
        const stderrText = Buffer.concat(stderr).toString();

        if (code > 0) {
          const error = new Error(stderrText || `${command.cmd} exited with code ${code}`);
          error.code = code;
          error.stdout = stdoutText;
          error.stderr = stderrText;
          reject(error);
          return;
        }

        resolve(stdoutText);
      }, reject);
    });
  });
}

function serializeSubmitSession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    status: session.status,
    message: session.message,
    prompt: session.prompt,
    result: session.result,
    links: session.links,
    error: session.error,
    snapshot: session.snapshot,
    output: session.output || "",
  };
}

function createBrowserSubmitPrompts(session) {
  return {
    keyInYNStrict(message) {
      return askSubmitConfirm(session, message);
    },
  };
}

function createBrowserSubmitSpinner(session, text) {
  appendSubmitOutput(session, `${text}\n`);

  return {
    succeed() {
      appendSubmitOutput(session, `Done: ${text}\n`);
    },
    fail() {
      appendSubmitOutput(session, `Failed: ${text}\n`);
    },
  };
}

async function checkGraphSubmitChanges({
  graph,
  prompts,
  message,
  runCommand = run,
}) {
  const status = await runCommand({
    cmd: "git",
    args: ["status", "--porcelain"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  if (!status.trim()) {
    return;
  }

  const amend = await prompts.keyInYNStrict("Amend commit? [y/n]:");

  if (!amend) {
    throw new Error(message);
  }

  try {
    await runCommand({ cmd: "git", args: ["add", "-A"], cwd: graph.path, silent: true });
    await runCommand({ cmd: "git", args: ["commit", "--amend", "--no-edit"], cwd: graph.path, silent: true });
  } catch (error) {
    throw new Error("Commit failed aborting!", { cause: error });
  }
}

function createGraphSubmitRunner({
  graph,
  session,
  runCommand = run,
  postComment = defaultComment,
}) {
  const prompts = createBrowserSubmitPrompts(session);
  const graphRunCommand = withGraphSubmitCwd(graph, session, runCommand);
  const testChanged = createTestCommand({
    getChangedFiles: () => getGraphChangedFilePaths({ graph, runCommand }),
    runMach: (args) => runGraphMach({ graph, args, session, runCommand }),
  });
  const tryCommand = createTryCommand({
    runCommand: graphRunCommand,
    postComment,
  });

  return createSubmitCommand({
    checkChanges: (message) => checkGraphSubmitChanges({
      graph,
      prompts,
      message,
      runCommand,
    }),
    lint: () => runGraphLint({ graph, session, runCommand }),
    testChanged,
    tryCommand,
    prompts,
    postComment,
    getCommitMessage: () => getGraphCurrentCommitMessage({ graph, runCommand }),
    runCommand: graphRunCommand,
    createSpinner: (text) => createBrowserSubmitSpinner(session, text),
  });
}

function createGraphSubmitSession({
  graph,
  graphIndex,
  snapshotLimit,
  getSnapshot,
  runCommand = run,
  postComment = defaultComment,
}) {
  const session = {
    id: randomUUID(),
    graphIndex,
    status: "running",
    message: "Starting submit...",
    prompt: null,
    pendingPrompt: null,
    result: null,
    links: [],
    error: "",
    snapshot: null,
  };
  const submit = createGraphSubmitRunner({
    graph,
    session,
    runCommand,
    postComment,
  });

  session.answer = (promptId, answer) => {
    answerSubmitSessionPrompt(session, promptId, answer);
  };

  queueMicrotask(async () => {
    try {
      const result = await submit(GRAPH_SUBMIT_OPTIONS, []);
      session.result = result;
      session.links = getSubmitLinks(result);
      session.snapshot = await getSnapshot(graph, snapshotLimit);
      session.status = "complete";
      session.message = "Submit complete.";
    } catch (error) {
      session.status = "error";
      session.error = String(error?.message || error);
      session.message = session.error;
      if (session.pendingPrompt) {
        session.pendingPrompt.reject(error);
        session.pendingPrompt = null;
        session.prompt = null;
      }
    }
  });

  return session;
}

export async function getCheckoutGraphSnapshot({
  graph,
  limit = 80,
  runCommand = run,
}) {
  const [branch, page] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    getCheckoutCommitPage({
      cwd: graph.path,
      offset: 0,
      limit,
      includeWorkingTree: true,
      runCommand,
    }),
  ]);

  return {
    label: graph.label,
    path: graph.path,
    branch: branch || "(detached)",
    commits: page.commits,
    commitCount: page.commits.filter((commit) => !commit.workingTree).length,
    workingTreeCount: page.workingTreeCount,
    offset: page.offset,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
  };
}

export async function checkoutCommit({
  graph,
  hash,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);
  await ensureCleanGraph(graph, runCommand);

  const branchRefs = await getLocalBranchesAtCommit(graph, hash, runCommand);
  const branch = chooseCheckoutBranch(branchRefs, graph.branch);

  if (branch) {
    await runCommand({
      cmd: "git",
      args: ["switch", branch],
      cwd: graph.path,
      silent: true,
    });

    graph.branch = branch;
    return {
      label: graph.label,
      path: graph.path,
      hash,
      branch,
      detached: false,
      message: `${graph.label} checked out branch ${branch} at ${hash.slice(0, 12)}.`,
    };
  }

  await runCommand({
    cmd: "git",
    args: ["switch", "--detach", hash],
    cwd: graph.path,
    silent: true,
  });

  graph.branch = "(detached)";
  return {
    label: graph.label,
    path: graph.path,
    hash,
    detached: true,
    message: `${graph.label} checked out ${hash.slice(0, 12)} as detached HEAD.`,
  };
}

export async function rebaseCommit({
  graph,
  hash,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);

  if (isWorkingTreeCommitHash(hash)) {
    const error = new Error("Uncommitted changes cannot be rebased from the graph.");
    error.statusCode = 409;
    throw error;
  }

  await ensureCleanGraph(graph, runCommand);

  const base = await getCurrentGraphBase(graph, runCommand);

  if (base.hash === hash) {
    const error = new Error(`Cannot rebase ${hash.slice(0, 12)} because it is already checked out.`);
    error.statusCode = 409;
    throw error;
  }

  const [branchRefs, containingBranchRefs] = await Promise.all([
    getLocalBranchesAtCommit(graph, hash, runCommand),
    getLocalBranchesContainingCommit(graph, hash, runCommand),
  ]);
  const containingBranches = parseBranchRefs(containingBranchRefs);
  const branch = chooseRebaseBranch({
    containingRefs: containingBranchRefs,
    tipRefs: branchRefs,
    currentBranch: base.branch,
  });

  if (!branch && containingBranches.length > 1) {
    const error = new Error(`Commit ${hash.slice(0, 12)} is contained by multiple local branches (${containingBranches.join(", ")}). Check out the target base and leave only one source branch containing the commit, then try again.`);
    error.statusCode = 409;
    throw error;
  }

  const stackCommits = await getRebaseCommitStack(graph, hash, branch, runCommand);

  if (stackCommits.includes(base.hash)) {
    const error = new Error(`Cannot rebase ${hash.slice(0, 12)} because the current checkout is inside the selected commit stack.`);
    error.statusCode = 409;
    throw error;
  }

  await runCommand({
    cmd: "git",
    args: ["switch", "--detach", base.hash],
    cwd: graph.path,
    silent: true,
  });

  for (const commit of stackCommits) {
    await runCommand({
      cmd: "git",
      args: ["cherry-pick", "--no-commit", commit],
      cwd: graph.path,
      silent: true,
    });

    await runCommand({
      cmd: "git",
      args: ["commit", "-C", commit],
      cwd: graph.path,
      silent: true,
    });
  }

  let currentHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();

  if (branch) {
    await runCommand({
      cmd: "git",
      args: ["branch", "-f", branch, currentHash],
      cwd: graph.path,
      silent: true,
    });
    await runCommand({
      cmd: "git",
      args: ["switch", branch],
      cwd: graph.path,
      silent: true,
    });
    currentHash = (await runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    })).trim();
    graph.branch = branch;
  } else {
    graph.branch = "(detached)";
  }

  return {
    action: "rebase",
    label: graph.label,
    path: graph.path,
    hash,
    branch,
    base: base.hash,
    commits: stackCommits,
    rebasedCount: stackCommits.length,
    currentHash,
    detached: !branch,
    message: `${graph.label} rebased ${branch ? `branch ${branch}` : hash.slice(0, 12)}${stackCommits.length > 1 ? ` (${stackCommits.length} commits)` : ""} onto ${base.branch || base.hash.slice(0, 12)}.`,
  };
}

export async function pruneCommitBranches({
  graph,
  hash,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);

  if (isWorkingTreeCommitHash(hash)) {
    const error = new Error("Uncommitted changes cannot be pruned from the graph.");
    error.statusCode = 409;
    throw error;
  }

  await ensureCleanGraph(graph, runCommand);

  const [currentBranch, branchRefs, containingBranchRefs, parents] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    getLocalBranchesAtCommit(graph, hash, runCommand),
    getLocalBranchesContainingCommit(graph, hash, runCommand),
    getCommitParents(graph, hash, runCommand),
  ]);
  const containingBranches = parseBranchRefs(containingBranchRefs);
  const branches = choosePruneBranches({
    containingRefs: containingBranchRefs,
    tipRefs: branchRefs,
    currentBranch,
  });

  if (!containingBranches.length) {
    const error = new Error(`No local branches contain ${hash.slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  if (!branches.length) {
    const error = new Error(`Commit ${hash.slice(0, 12)} is contained by multiple local branches (${containingBranches.join(", ")}). Check out the branch to prune and try again.`);
    error.statusCode = 409;
    throw error;
  }

  if (parents.length !== 1) {
    const error = new Error(parents.length
      ? `Cannot prune merge commit ${hash.slice(0, 12)} because it has multiple parents.`
      : `Cannot prune root commit ${hash.slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  const parent = parents[0];

  for (const branch of branches) {
    await runCommand({
      cmd: "git",
      args: ["rebase", "--onto", parent, hash, branch],
      cwd: graph.path,
      silent: true,
    });
  }

  const [newBranch, currentHash] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    }),
  ]);
  graph.branch = newBranch.trim() || "(detached)";

  return {
    action: "prune",
    label: graph.label,
    path: graph.path,
    hash,
    branches,
    parent,
    currentHash: currentHash.trim(),
    branch: graph.branch,
    message: `${graph.label} pruned ${hash.slice(0, 12)} from ${branches.length === 1 ? "branch" : "branches"} ${branches.join(", ")}.`,
  };
}

export async function checkoutGraphCommit({
  graphs,
  graphIndex,
  hash,
  runCommand = run,
}) {
  return checkoutCommit({
    graph: graphs[Number(graphIndex)],
    hash,
    runCommand,
  });
}

export async function runGraphCommitAction({
  graphs,
  graphIndex,
  hash,
  action,
  runCommand = run,
}) {
  const graph = graphs[Number(graphIndex)];

  switch (action) {
    case "checkout":
      return checkoutCommit({ graph, hash, runCommand });
    case "rebase":
      return rebaseCommit({ graph, hash, runCommand });
    case "prune":
      return pruneCommitBranches({ graph, hash, runCommand });
    default: {
      const error = new Error(`Unknown graph action: ${action}`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function getGraphHtmlStyles() {
  return buildGraphHtml({ graphs: [], gitgraphScript: "" }).match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
}

export function buildGraphHtml({
  graphs,
  gitgraphScript,
  interactive = { enabled: false },
}) {
  const tabButtons = graphs.map((graph, index) => (
    `<button class="tab${index === 0 ? " active" : ""}" data-index="${index}">${escapeHtml(graph.label)}</button>`
  )).join("\n");
  const tabPanels = graphs.map((graph, index) => (
    `<section class="panel${index === 0 ? " active" : ""}" data-index="${index}">
      <div class="summary" data-index="${index}">
        <strong>${escapeHtml(graph.label)}</strong>
        <span class="summary-path">${escapeHtml(graph.path)}</span>
        <span class="summary-branch">${escapeHtml(graph.branch || "")}</span>
        <span class="summary-count">${graph.commitCount} commit(s)</span>
        <span class="summary-working-tree"${graph.workingTreeCount ? "" : " hidden"}>${graph.workingTreeCount || 0} uncommitted change set</span>
      </div>
      <div class="workspace" data-index="${index}">
        <div class="graph" id="graph-${index}"></div>
        <div
          class="pane-resizer"
          role="separator"
          aria-label="Resize graph and diff panes"
          aria-orientation="vertical"
          aria-controls="graph-${index} diff-${index}"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="54"
          tabindex="0"
          data-index="${index}"
        ></div>
        <aside class="diff-viewer" id="diff-${index}">
          <div class="diff-header">
            <strong class="diff-title">No commit selected</strong>
            <span class="diff-meta"></span>
            <pre class="diff-message" hidden></pre>
            <span class="diff-stats" hidden aria-label="">
              <span class="stat-additions"></span>
              <span class="stat-deletions"></span>
            </span>
            <button class="checkout-commit" type="button" hidden>Checkout</button>
            <button class="amend-commit" type="button" hidden>Amend</button>
            <button class="submit-commit" type="button" hidden>Submit</button>
            <span class="checkout-status"></span>
          </div>
          <div class="diff-body"><pre class="diff-placeholder">Select a commit in the graph.</pre></div>
        </aside>
      </div>
    </section>`
  )).join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>TB Tools Branch Graph</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --diff-border: #d0d7de;
      --diff-header-bg: #f6f8fa;
      --diff-bg: #ffffff;
      --diff-code: #24292f;
      --diff-muted: #57606a;
      --diff-gutter-bg: #f6f8fa;
      --diff-gutter-border: #d8dee4;
      --diff-file-line-bg: #f6f8fa;
      --diff-hunk-bg: #ddf4ff;
      --diff-hunk-code: #0969da;
      --diff-delete-bg: #ffebe9;
      --diff-delete-gutter: #ffd7d5;
      --diff-insert-bg: #e6ffec;
      --diff-insert-gutter: #ccffd8;
      --diff-hover-bg: #f6f8fa;
    }
    body { margin: 0; background: #f6f7f9; color: #20242a; }
    header { padding: 12px 16px 8px; border-bottom: 1px solid #d6dae1; background: #fff; position: sticky; top: 0; z-index: 1; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab { border: 1px solid #b9c0cc; background: #fff; color: #20242a; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
    .tab.active { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    main { padding: 12px; }
    .panel { display: none; }
    .panel.active { display: block; }
    .summary { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; padding: 8px 10px; margin-bottom: 10px; background: #fff; border: 1px solid #d6dae1; border-radius: 8px; }
    .summary span { color: #59616d; font-size: 12px; }
    .workspace { --graph-pane-width: 54%; display: grid; grid-template-columns: minmax(320px, var(--graph-pane-width)) 12px minmax(320px, 1fr); align-items: start; }
    .graph, .diff-viewer { background: #fff; border: 1px solid #d6dae1; border-radius: 8px; overflow: auto; }
    .graph { padding: 10px; min-height: 220px; }
    .diff-viewer { max-height: calc(100vh - 112px); position: sticky; top: 78px; }
    .pane-resizer { align-items: center; align-self: stretch; cursor: col-resize; display: flex; justify-content: center; min-height: 220px; position: sticky; top: 78px; touch-action: none; user-select: none; height: calc(100vh - 112px); }
    .pane-resizer::before { background: #c7ced9; border-radius: 999px; content: ""; display: block; height: 100%; max-height: calc(100vh - 132px); min-height: 140px; transition: background 120ms ease, box-shadow 120ms ease, width 120ms ease; width: 4px; }
    .pane-resizer:hover::before, .pane-resizer:focus-visible::before, .pane-resizer.dragging::before { background: #1f5f9f; box-shadow: 0 0 0 3px rgba(31, 95, 159, 0.14); width: 5px; }
    .pane-resizer:focus-visible { outline: none; }
    body.is-resizing-panes { cursor: col-resize; user-select: none; }
    .diff-header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid #d6dae1; }
    .diff-title { font-size: 13px; }
    .diff-meta { color: #59616d; font-size: 12px; }
    .diff-message { border-top: 1px solid #edf0f4; color: #20242a; flex: 0 0 100%; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2px 0 0; max-height: 220px; overflow: auto; padding: 8px 0 0; white-space: pre-wrap; }
    .diff-message a { color: #0969da; text-decoration: none; }
    .diff-message a:hover, .diff-message a:focus { text-decoration: underline; }
    .diff-message[hidden] { display: none; }
    .diff-stats { display: flex; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; gap: 6px; white-space: nowrap; }
    .diff-stats[hidden] { display: none; }
    .checkout-commit, .amend-commit, .submit-commit, .load-more { border: 1px solid #1f5f9f; border-radius: 4px; background: #1f5f9f; color: #fff; cursor: pointer; font-size: 12px; padding: 4px 8px; }
    .checkout-commit:disabled, .amend-commit:disabled, .submit-commit:disabled, .load-more:disabled { cursor: wait; opacity: 0.65; }
    .checkout-status, .graph-status { color: #59616d; font-size: 12px; }
    .checkout-status.error, .graph-status.error { color: #9b1c1c; }
    .diff-body { margin: 0; padding: 10px; tab-size: 2; }
    .diff-placeholder, .error { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.38; margin: 0; white-space: pre-wrap; }
    .load-sentinel { block-size: 1px; inline-size: 100%; }
    .graph svg { overflow: visible; }
    .lane-path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .commit-dot { stroke: #ffffff; stroke-width: 2; }
    .commit-hash, .commit-message { dominant-baseline: central; font: normal 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; pointer-events: none; }
    .commit-hash { fill: #59616d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .branch-label-bg { stroke-width: 1; }
    .branch-label-text { dominant-baseline: central; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; pointer-events: none; }
    .commit-row, .commit-row * { cursor: pointer; }
    .commit-row:focus { outline: none; }
    .commit-row-hitbox { fill: transparent; pointer-events: all; transition: fill 120ms ease, stroke 120ms ease; }
    .commit-row.hover .commit-row-hitbox, .commit-row:focus-visible .commit-row-hitbox { fill: rgba(31, 95, 159, 0.08); }
    .commit-row.active .commit-row-hitbox { fill: rgba(31, 95, 159, 0.14); stroke: rgba(31, 95, 159, 0.35); stroke-width: 1; }
    .commit-row.active.hover .commit-row-hitbox { fill: rgba(31, 95, 159, 0.18); }
    .commit-row.working-tree .commit-row-hitbox { fill: rgba(31, 95, 159, 0.06); stroke: rgba(31, 95, 159, 0.2); stroke-width: 1; }
    .commit-row.working-tree.hover .commit-row-hitbox, .commit-row.working-tree:focus-visible .commit-row-hitbox { fill: rgba(31, 95, 159, 0.12); }
    .commit-row.working-tree.active .commit-row-hitbox { fill: rgba(31, 95, 159, 0.2); stroke: rgba(31, 95, 159, 0.44); }
    .commit-row.current .commit-row-hitbox { fill: rgba(245, 158, 11, 0.18); stroke: rgba(180, 83, 9, 0.35); stroke-width: 1; }
    .commit-row.current.hover .commit-row-hitbox { fill: rgba(245, 158, 11, 0.24); }
    .commit-row.current.active .commit-row-hitbox { fill: rgba(245, 158, 11, 0.3); stroke: rgba(31, 95, 159, 0.48); }
    .context-menu { background: #fff; border: 1px solid #b9c0cc; border-radius: 6px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.18); color: #20242a; min-width: 160px; padding: 4px; position: fixed; z-index: 5; }
    .context-menu[hidden] { display: none; }
    .context-menu-title { color: #59616d; font-size: 12px; max-width: 260px; overflow: hidden; padding: 6px 8px 4px; text-overflow: ellipsis; white-space: nowrap; }
    .context-menu button { background: transparent; border: 0; border-radius: 4px; color: inherit; cursor: pointer; display: block; font: inherit; padding: 7px 8px; text-align: left; width: 100%; }
    .context-menu button:hover, .context-menu button:focus { background: rgba(31, 95, 159, 0.1); outline: none; }
    .context-menu button[data-action="prune"] { color: #9b1c1c; }
    .amend-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(720px, calc(100vw - 32px)); padding: 0; width: 680px; }
    .amend-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .amend-form { display: grid; gap: 10px; margin: 0; padding: 16px; }
    .amend-title { font-size: 16px; margin: 0; }
    .amend-form label { color: #59616d; font-size: 12px; font-weight: 600; }
    .amend-message { border: 1px solid #b9c0cc; border-radius: 6px; box-sizing: border-box; color: #20242a; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; min-height: 160px; padding: 8px; resize: vertical; width: 100%; }
    .amend-error { color: #9b1c1c; font-size: 12px; margin: 0; min-height: 16px; }
    .amend-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .amend-actions button { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .amend-cancel { background: #fff; color: #20242a; }
    .amend-submit { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .amend-submit:disabled { cursor: wait; opacity: 0.65; }
    .submit-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(520px, calc(100vw - 32px)); padding: 0; width: 500px; }
    .submit-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .submit-panel { display: grid; gap: 12px; padding: 16px; }
    .submit-title { font-size: 16px; margin: 0; }
    .submit-status, .submit-question { margin: 0; }
    .submit-status { color: #59616d; font-size: 13px; }
    .submit-status.error { color: #9b1c1c; }
    .submit-prompt { border: 1px solid #d6dae1; border-radius: 6px; display: grid; gap: 10px; padding: 10px; }
    .submit-prompt[hidden], .submit-links[hidden] { display: none; }
    .submit-prompt-actions, .submit-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .submit-prompt-actions button, .submit-actions button { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .submit-answer-yes { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .submit-answer-no, .submit-close { background: #fff; color: #20242a; }
    .submit-close:disabled { cursor: wait; opacity: 0.65; }
    .submit-links { border-top: 1px solid #edf0f4; display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; }
    .submit-links a { border: 1px solid #d0d7de; border-radius: 999px; color: #0969da; font-size: 13px; padding: 5px 9px; text-decoration: none; }
    .submit-links a:hover, .submit-links a:focus { background: #f6f8fa; text-decoration: underline; }
    .submit-output { background: #f6f8fa; border: 1px solid #d6dae1; border-radius: 6px; color: #24292f; font: 12px/1.42 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: min(42vh, 360px); overflow: auto; padding: 10px; white-space: pre-wrap; }
    .pretty-file { background: var(--diff-bg); border: 1px solid var(--diff-border); border-radius: 6px; margin: 0 0 12px; overflow: hidden; }
    .pretty-file h3 { align-items: center; background: var(--diff-header-bg); border-bottom: 1px solid var(--diff-border); color: var(--diff-code); display: flex; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; gap: 12px; justify-content: space-between; margin: 0; min-height: 32px; overflow: hidden; padding: 8px 10px; }
    .file-heading { align-items: center; display: flex; gap: 8px; min-width: 0; }
    .file-icon { border: 1px solid var(--diff-muted); border-radius: 2px; box-sizing: border-box; flex: 0 0 auto; height: 14px; opacity: 0.72; position: relative; width: 11px; }
    .file-icon::after { border-top: 1px solid var(--diff-muted); content: ""; left: 2px; position: absolute; right: 2px; top: 4px; }
    .pretty-file .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-actions { align-items: center; display: flex; flex: 0 0 auto; gap: 8px; }
    .file-stats { display: flex; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; gap: 6px; white-space: nowrap; }
    .stat-additions { color: #1a7f37; }
    .stat-deletions { color: #cf222e; }
    .copy-path { background: var(--diff-header-bg); border: 1px solid var(--diff-border); border-radius: 6px; color: var(--diff-code); cursor: pointer; font-size: 12px; padding: 4px 8px; }
    .copy-path:hover, .copy-path:focus { background: var(--diff-hover-bg); outline: none; }
    .file-diff { background: var(--diff-bg); overflow: auto; }
    .diff-table { border-collapse: collapse; border-spacing: 0; table-layout: auto; width: max-content; min-width: 100%; }
    .diff-line { height: 24px; }
    .line-number { background: var(--diff-gutter-bg); box-sizing: border-box; color: var(--diff-muted); font: 12px/24px ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 44px; padding: 0 10px; text-align: right; user-select: none; vertical-align: top; white-space: nowrap; width: 44px; }
    .new-line { border-right: 1px solid var(--diff-gutter-border); }
    .line-code { background: var(--diff-bg); color: var(--diff-code); font: 14px/24px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 24px; vertical-align: top; white-space: pre; width: 100%; }
    .line-marker { display: inline-block; text-align: center; user-select: none; width: 1ch; }
    .line-content { display: inline; }
    .line-content .hljs-comment, .line-content .hljs-quote { color: #6e7781; }
    .line-content .hljs-keyword, .line-content .hljs-selector-tag, .line-content .hljs-subst { color: #cf222e; }
    .line-content .hljs-number, .line-content .hljs-literal, .line-content .hljs-variable, .line-content .hljs-template-variable { color: #0550ae; }
    .line-content .hljs-string, .line-content .hljs-doctag, .line-content .hljs-regexp { color: #0a3069; }
    .line-content .hljs-title, .line-content .hljs-section, .line-content .hljs-selector-id { color: #8250df; }
    .line-content .hljs-type, .line-content .hljs-class .hljs-title { color: #953800; }
    .line-content .hljs-tag, .line-content .hljs-name, .line-content .hljs-attribute { color: #116329; }
    .line-content .hljs-symbol, .line-content .hljs-bullet, .line-content .hljs-link { color: #0969da; }
    .line-content .hljs-built_in, .line-content .hljs-builtin-name { color: #953800; }
    .line-content .hljs-meta { color: #57606a; }
    .diff-line.file .line-number, .diff-line.file .line-code { background: var(--diff-file-line-bg); color: var(--diff-muted); }
    .diff-line.info .line-number, .diff-line.info .line-code { background: var(--diff-hunk-bg); color: var(--diff-hunk-code); }
    .diff-line.delete .line-marker { color: #cf222e; }
    .diff-line.delete .old-line { background: var(--diff-delete-gutter); }
    .diff-line.delete .new-line, .diff-line.delete .line-code { background: var(--diff-delete-bg); }
    .diff-line.insert .line-marker { color: #1a7f37; }
    .diff-line.insert .old-line, .diff-line.insert .new-line { background: var(--diff-insert-gutter); }
    .diff-line.insert .line-code { background: var(--diff-insert-bg); }
    .diff-line.context:hover .line-number, .diff-line.context:hover .line-code { background: var(--diff-hover-bg); }
    .diff-line.delete:hover .old-line { background: #ffc7c2; }
    .diff-line.delete:hover .new-line, .diff-line.delete:hover .line-code { background: #ffdfdc; }
    .diff-line.insert:hover .old-line, .diff-line.insert:hover .new-line { background: #bef5cb; }
    .diff-line.insert:hover .line-code { background: #dafbe1; }
    .file, .info, .delete, .insert { color: inherit; }
    .error { color: #9b1c1c; }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
      .pane-resizer { display: none; }
      .diff-viewer { position: static; max-height: none; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --diff-border: #30363d;
        --diff-header-bg: #161b22;
        --diff-bg: #0d1117;
        --diff-code: #e6edf3;
        --diff-muted: #7d8590;
        --diff-gutter-bg: #161b22;
        --diff-gutter-border: #30363d;
        --diff-file-line-bg: #161b22;
        --diff-hunk-bg: #112d4e;
        --diff-hunk-code: #79c0ff;
        --diff-delete-bg: #490202;
        --diff-delete-gutter: #67060c;
        --diff-insert-bg: #04260f;
        --diff-insert-gutter: #033a16;
        --diff-hover-bg: #161b22;
      }
      body { background: #111418; color: #f1f3f6; }
      header, .summary, .graph, .diff-viewer, .tab { background: #191d23; color: #f1f3f6; border-color: #323844; }
      .summary span, .diff-meta { color: #acb4c0; }
      .diff-message { border-color: #323844; color: #f1f3f6; }
      .diff-message a { color: #79c0ff; }
      .pane-resizer::before { background: #424b59; }
      .pane-resizer:hover::before, .pane-resizer:focus-visible::before, .pane-resizer.dragging::before { background: #4b9eff; box-shadow: 0 0 0 3px rgba(75, 158, 255, 0.18); }
      .diff-header { border-color: #323844; }
      .stat-additions { color: #3fb950; }
      .stat-deletions { color: #f85149; }
      .copy-path { color: var(--diff-code); }
      .line-content .hljs-comment, .line-content .hljs-quote { color: #8b949e; }
      .line-content .hljs-keyword, .line-content .hljs-selector-tag, .line-content .hljs-subst { color: #ff7b72; }
      .line-content .hljs-number, .line-content .hljs-literal, .line-content .hljs-variable, .line-content .hljs-template-variable { color: #79c0ff; }
      .line-content .hljs-string, .line-content .hljs-doctag, .line-content .hljs-regexp { color: #a5d6ff; }
      .line-content .hljs-title, .line-content .hljs-section, .line-content .hljs-selector-id { color: #d2a8ff; }
      .line-content .hljs-type, .line-content .hljs-class .hljs-title { color: #ffa657; }
      .line-content .hljs-tag, .line-content .hljs-name, .line-content .hljs-attribute { color: #7ee787; }
      .line-content .hljs-symbol, .line-content .hljs-bullet, .line-content .hljs-link { color: #58a6ff; }
      .line-content .hljs-built_in, .line-content .hljs-builtin-name { color: #ffa657; }
      .line-content .hljs-meta { color: #8b949e; }
      .diff-line.delete .line-marker { color: #f85149; }
      .diff-line.insert .line-marker { color: #3fb950; }
      .checkout-commit, .amend-commit, .submit-commit, .load-more { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .checkout-status, .graph-status { color: #acb4c0; }
      .checkout-status.error, .graph-status.error { color: #ff9f9f; }
      .diff-line.delete:hover .old-line { background: #78191e; }
      .diff-line.delete:hover .new-line, .diff-line.delete:hover .line-code { background: #5c0b0f; }
      .diff-line.insert:hover .old-line, .diff-line.insert:hover .new-line { background: #0f5323; }
      .diff-line.insert:hover .line-code { background: #06361a; }
      .tab.active { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .commit-row.hover .commit-row-hitbox, .commit-row:focus-visible .commit-row-hitbox { fill: rgba(75, 158, 255, 0.12); }
      .commit-row.active .commit-row-hitbox { fill: rgba(75, 158, 255, 0.2); stroke: rgba(75, 158, 255, 0.42); }
      .commit-row.active.hover .commit-row-hitbox { fill: rgba(75, 158, 255, 0.26); }
      .commit-row.working-tree .commit-row-hitbox { fill: rgba(75, 158, 255, 0.12); stroke: rgba(75, 158, 255, 0.28); }
      .commit-row.working-tree.hover .commit-row-hitbox, .commit-row.working-tree:focus-visible .commit-row-hitbox { fill: rgba(75, 158, 255, 0.18); }
      .commit-row.working-tree.active .commit-row-hitbox { fill: rgba(75, 158, 255, 0.28); stroke: rgba(75, 158, 255, 0.52); }
      .commit-row.current .commit-row-hitbox { fill: rgba(251, 191, 36, 0.22); stroke: rgba(251, 191, 36, 0.42); }
      .commit-row.current.hover .commit-row-hitbox { fill: rgba(251, 191, 36, 0.28); }
      .commit-row.current.active .commit-row-hitbox { fill: rgba(251, 191, 36, 0.34); stroke: rgba(75, 158, 255, 0.55); }
      .context-menu { background: #191d23; border-color: #424b59; color: #f1f3f6; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42); }
      .context-menu-title { color: #acb4c0; }
      .context-menu button:hover, .context-menu button:focus { background: rgba(75, 158, 255, 0.16); }
      .context-menu button[data-action="prune"] { color: #ff9f9f; }
      .amend-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .amend-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .amend-form label { color: #acb4c0; }
      .amend-message { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .amend-error { color: #ff9f9f; }
      .amend-cancel { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .amend-submit { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .submit-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .submit-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .submit-status { color: #acb4c0; }
      .submit-status.error { color: #ff9f9f; }
      .submit-prompt { border-color: #424b59; }
      .submit-prompt-actions button, .submit-actions button { border-color: #424b59; }
      .submit-answer-yes { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .submit-answer-no, .submit-close { background: #191d23; color: #f1f3f6; }
      .submit-links { border-color: #323844; }
      .submit-links a { border-color: #424b59; color: #79c0ff; }
      .submit-links a:hover, .submit-links a:focus { background: #161b22; }
      .submit-output { background: #0d1117; border-color: #424b59; color: #e6edf3; }
    }
  </style>
</head>
<body>
  <header>
    <h1>TB Tools Branch Graph</h1>
    <nav class="tabs">${tabButtons}</nav>
  </header>
  <main>${tabPanels}</main>
  <div class="context-menu" id="commit-context-menu" hidden role="menu" aria-label="Commit actions">
    <div class="context-menu-title"></div>
    <button type="button" role="menuitem" data-action="checkout">Checkout</button>
    <button type="button" role="menuitem" data-action="rebase">Rebase</button>
    <button type="button" role="menuitem" data-action="prune">Prune</button>
  </div>
  <dialog class="amend-dialog" id="amend-dialog">
    <form class="amend-form">
      <h2 class="amend-title">Amend Commit</h2>
      <label for="amend-message">Commit message</label>
      <textarea id="amend-message" class="amend-message" rows="9" required></textarea>
      <p class="amend-error" role="alert"></p>
      <div class="amend-actions">
        <button class="amend-cancel" type="button">Cancel</button>
        <button class="amend-submit" type="submit">Amend</button>
      </div>
    </form>
  </dialog>
  <dialog class="submit-dialog" id="submit-dialog">
    <div class="submit-panel">
      <h2 class="submit-title">Submit Current Commit</h2>
      <p class="submit-status" role="status">Starting submit...</p>
      <div class="submit-prompt" hidden>
        <p class="submit-question"></p>
        <div class="submit-prompt-actions">
          <button class="submit-answer-yes" type="button" data-answer="true">Yes</button>
          <button class="submit-answer-no" type="button" data-answer="false">No</button>
        </div>
      </div>
      <div class="submit-links" hidden></div>
      <pre class="submit-output" aria-label="Submit output"></pre>
      <div class="submit-actions">
        <button class="submit-close" type="button">Close</button>
      </div>
    </div>
  </dialog>
  <script>${gitgraphScript}</script>
  <script>
    const GRAPHS = ${safeScriptJson(graphs)};
    const INTERACTIVE = ${safeScriptJson({
      enabled: Boolean(interactive.enabled),
      pageSize: interactive.pageSize || 80,
      pollIntervalMs: interactive.pollIntervalMs || 3000,
      token: interactive.token,
    })};
    const SVG_NS = "http://www.w3.org/2000/svg";
    const COMMIT_DOT_RADIUS = 10;
    const COMMIT_ROW_HEIGHT = 28;
    const COMMIT_ROW_HORIZONTAL_INSET = 4;
    const LANE_LEFT = 14;
    const LANE_TOP = 14;
    const LANE_SPACING = 20;
    const LANE_MESSAGE_GAP = 18;
    const LANE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ca8a04", "#dc2626", "#0891b2", "#7c3aed", "#db2777", "#ea580c", "#0f766e"];
    const COMMIT_HASH_WIDTH = 116;
    const BRANCH_LABEL_HEIGHT = 18;
    const BRANCH_LABEL_GAP = 5;
    const BRANCH_LABEL_PADDING_X = 6;
    const BRANCH_LABEL_TEXT_WIDTH = 7.25;
    const COMMIT_SUBJECT_GAP = 8;
    const PANE_MIN_WIDTH = 320;
    const PANE_RESIZE_KEY_STEP = 32;
    const PANE_WIDTH_STORAGE_PREFIX = "tb-tools:branch-graph:pane-width:";
    const BUGZILLA_BUG_URL = "https://bugzilla.mozilla.org/show_bug.cgi?id=";
    const PHABRICATOR_REVISION_URL = "https://phabricator.services.mozilla.com/D";
    const COMMIT_MESSAGE_LINK_PATTERN = /(https?:\\/\\/[^\\s<>"']+|\\b[Bb]ug\\s+#?\\d{4,8}\\b|\\b(?:phab-)?D\\d{4,}\\b)/g;

    const graphStates = GRAPHS.map((graph) => {
      const commits = placeWorkingTreeCommits(graph.commits ? [...graph.commits] : []);
      graph.commits = commits;

      return {
        graph,
        commits,
        offset: commits.length,
        hasMore: Boolean(INTERACTIVE.enabled),
        loading: false,
        gitgraph: null,
        rendered: false,
        sentinelReady: true,
        lastScrollY: window.scrollY,
        scrolledTowardBottom: false,
        selectedHash: "",
        currentHash: getCurrentCommitHash(commits),
        workingTreeCount: graph.workingTreeCount || 0,
        snapshotSignature: "",
        refreshing: false,
        branchColors: new Map(),
        nextBranchColorIndex: 0,
      };
    });
    const contextMenu = document.getElementById("commit-context-menu");
    const amendDialog = document.getElementById("amend-dialog");
    const amendForm = amendDialog.querySelector(".amend-form");
    const amendMessage = amendDialog.querySelector(".amend-message");
    const amendError = amendDialog.querySelector(".amend-error");
    const amendSubmit = amendDialog.querySelector(".amend-submit");
    const submitDialog = document.getElementById("submit-dialog");
    const submitTitle = submitDialog.querySelector(".submit-title");
    const submitStatus = submitDialog.querySelector(".submit-status");
    const submitPrompt = submitDialog.querySelector(".submit-prompt");
    const submitQuestion = submitDialog.querySelector(".submit-question");
    const submitLinks = submitDialog.querySelector(".submit-links");
    const submitOutput = submitDialog.querySelector(".submit-output");
    const submitClose = submitDialog.querySelector(".submit-close");
    let contextMenuState = null;
    let amendDialogState = null;
    let submitDialogState = null;
    let submitPollTimer = null;
    const pendingPaneEnhancements = new Set();

    function showError(container, message) {
      const error = document.createElement("pre");
      error.className = "error";
      error.textContent = message;
      container.replaceChildren(error);
    }

    function pruneLoadedParents(commits) {
      const knownHashes = new Set(commits.map((commit) => commit.hash));

      return commits.map((commit) => ({
        ...commit,
        parents: commit.parents.filter((parent) => knownHashes.has(parent)),
      }));
    }

    function getCommitSnapshotFingerprint(commit) {
      return [
        commit.hash,
        (commit.parents || []).join(","),
        (commit.refs || []).join(","),
        commit.subject || "",
        commit.workingTree ? "working" : "commit",
        commit.changeId || "",
      ].join("\\u001f");
    }

    function getSnapshotFingerprint({ branch = "", workingTreeCount = 0, commits = [] } = {}) {
      return [
        branch,
        String(workingTreeCount || 0),
        commits.map(getCommitSnapshotFingerprint).join("\\u001e"),
      ].join("\\u001d");
    }

    function getStateSnapshotFingerprint(state) {
      return getSnapshotFingerprint({
        branch: state.graph.branch,
        workingTreeCount: state.workingTreeCount,
        commits: state.commits,
      });
    }

    function getGraphContainer(index) {
      return document.getElementById("graph-" + index);
    }

    function setGraphSummary(index) {
      const state = graphStates[index];
      const summary = document.querySelector('.summary[data-index="' + index + '"]');

      if (!summary) {
        return;
      }

      summary.querySelector(".summary-path").textContent = state.graph.path || "";
      summary.querySelector(".summary-branch").textContent = state.graph.branch || "";
      summary.querySelector(".summary-count").textContent = (state.graph.commitCount || 0) + " commit(s)";

      const workingTree = summary.querySelector(".summary-working-tree");
      const count = state.workingTreeCount || 0;
      workingTree.hidden = !count;
      workingTree.textContent = count + " uncommitted change set" + (count === 1 ? "" : "s");
    }

    function getWorkspace(index) {
      return document.querySelector('.workspace[data-index="' + index + '"]');
    }

    function getPaneStorageKey(index) {
      const graph = graphStates[index].graph;

      return PANE_WIDTH_STORAGE_PREFIX + graph.label + ":" + graph.path;
    }

    function getPaneWidthLimits(workspace) {
      const resizer = workspace.querySelector(".pane-resizer");
      const totalWidth = Math.max(
        0,
        workspace.getBoundingClientRect().width - (resizer ? resizer.getBoundingClientRect().width : 0)
      );
      const minWidth = Math.min(PANE_MIN_WIDTH, Math.floor(totalWidth / 2));

      return {
        min: minWidth,
        max: Math.max(minWidth, totalWidth - minWidth),
        total: totalWidth,
      };
    }

    function updatePaneResizerValue(index, width, totalWidth) {
      const resizer = getWorkspace(index)?.querySelector(".pane-resizer");

      if (!resizer || !totalWidth) {
        return;
      }

      const percent = Math.round((width / totalWidth) * 100);
      resizer.setAttribute("aria-valuenow", String(percent));
      resizer.setAttribute("aria-valuetext", percent + "% graph pane width");
    }

    function schedulePaneEnhancement(index) {
      if (pendingPaneEnhancements.has(index)) {
        return;
      }

      pendingPaneEnhancements.add(index);
      window.requestAnimationFrame(() => {
        pendingPaneEnhancements.delete(index);
        enhanceGraphRows(index);
      });
    }

    function setGraphPaneWidth(index, width, { persist = true } = {}) {
      const workspace = getWorkspace(index);

      if (!workspace || window.matchMedia("(max-width: 980px)").matches) {
        return;
      }

      const limits = getPaneWidthLimits(workspace);
      const clampedWidth = Math.min(limits.max, Math.max(limits.min, width));

      workspace.style.setProperty("--graph-pane-width", clampedWidth + "px");
      updatePaneResizerValue(index, clampedWidth, limits.total);
      schedulePaneEnhancement(index);

      if (!persist) {
        return;
      }

      try {
        localStorage.setItem(getPaneStorageKey(index), String(Math.round(clampedWidth)));
      } catch {
        // Private browsing or file restrictions can make storage unavailable.
      }
    }

    function restoreGraphPaneWidth(index) {
      const workspace = getWorkspace(index);

      if (!workspace || window.matchMedia("(max-width: 980px)").matches) {
        return;
      }

      try {
        const storedWidth = Number(localStorage.getItem(getPaneStorageKey(index)));

        if (Number.isFinite(storedWidth) && storedWidth > 0) {
          setGraphPaneWidth(index, storedWidth, { persist: false });
          return;
        }
      } catch {
        // Keep the default CSS split if storage is unavailable.
      }

      const graphPane = workspace.querySelector(".graph");
      const limits = getPaneWidthLimits(workspace);

      updatePaneResizerValue(index, graphPane.getBoundingClientRect().width, limits.total);
    }

    function startPaneResize(event) {
      if (event.button !== 0 || window.matchMedia("(max-width: 980px)").matches) {
        return;
      }

      event.preventDefault();

      const resizer = event.currentTarget;
      const index = Number(resizer.dataset.index);
      const graphPane = getGraphContainer(index);
      const startX = event.clientX;
      const startWidth = graphPane.getBoundingClientRect().width;
      const pointerId = event.pointerId;

      resizer.classList.add("dragging");
      document.body.classList.add("is-resizing-panes");
      resizer.setPointerCapture(pointerId);

      const handlePointerMove = (moveEvent) => {
        setGraphPaneWidth(index, startWidth + moveEvent.clientX - startX);
      };
      const stopResize = () => {
        resizer.classList.remove("dragging");
        document.body.classList.remove("is-resizing-panes");
        resizer.removeEventListener("pointermove", handlePointerMove);
        resizer.removeEventListener("pointerup", stopResize);
        resizer.removeEventListener("pointercancel", stopResize);

        if (resizer.hasPointerCapture(pointerId)) {
          resizer.releasePointerCapture(pointerId);
        }
      };

      resizer.addEventListener("pointermove", handlePointerMove);
      resizer.addEventListener("pointerup", stopResize);
      resizer.addEventListener("pointercancel", stopResize);
    }

    function resizePaneFromKeyboard(event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }

      const index = Number(event.currentTarget.dataset.index);
      const workspace = getWorkspace(index);

      if (!workspace || window.matchMedia("(max-width: 980px)").matches) {
        return;
      }

      event.preventDefault();

      const limits = getPaneWidthLimits(workspace);
      const currentWidth = getGraphContainer(index).getBoundingClientRect().width;
      const step = event.shiftKey ? PANE_RESIZE_KEY_STEP * 4 : PANE_RESIZE_KEY_STEP;

      if (event.key === "Home") {
        setGraphPaneWidth(index, limits.min);
      } else if (event.key === "End") {
        setGraphPaneWidth(index, limits.max);
      } else {
        setGraphPaneWidth(index, currentWidth + (event.key === "ArrowRight" ? step : -step));
      }
    }

    function getTranslate(node) {
      const match = (node.getAttribute("transform") || "").match(/translate\\((-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\)/);

      return {
        x: match ? Number(match[1]) : 0,
        y: match ? Number(match[2]) : 0,
      };
    }

    function setTranslate(node, x, y) {
      node.setAttribute("transform", "translate(" + Number(x.toFixed(2)) + ", " + Number(y.toFixed(2)) + ")");
    }

    function centerBranchLabelsVertically(index) {
      const container = getGraphContainer(index);

      for (const text of container.querySelectorAll("svg text")) {
        const labelGroup = text.parentElement;
        const labelContainer = labelGroup && labelGroup.parentElement;
        const labelTransform = labelContainer && labelContainer.getAttribute("transform");

        if (
          !labelGroup ||
          !labelContainer ||
          !labelTransform ||
          !labelGroup.firstElementChild ||
          labelGroup.firstElementChild.tagName.toLowerCase() !== "rect"
        ) {
          continue;
        }

        let labelBounds;

        try {
          labelBounds = labelGroup.getBBox();
        } catch {
          continue;
        }

        if (!labelBounds.width || !labelBounds.height) {
          continue;
        }

        const labelTranslate = getTranslate(labelContainer);
        const labelY = COMMIT_DOT_RADIUS - labelBounds.y - labelBounds.height / 2;

        setTranslate(labelContainer, labelTranslate.x, labelY);
      }
    }

    function updateCommitRowStates(index) {
      const container = getGraphContainer(index);
      const { currentHash, selectedHash } = graphStates[index];

      for (const row of container.querySelectorAll(".commit-row")) {
        row.classList.toggle("active", row.dataset.hash === selectedHash);
        row.classList.toggle("current", row.dataset.hash === currentHash);
      }
    }

    function getCommitRowsWidth(container, svg) {
      let width = container.clientWidth || 0;
      const hitboxes = Array.from(container.querySelectorAll(".commit-row-hitbox"));

      for (const hitbox of hitboxes) {
        hitbox.setAttribute("visibility", "hidden");
      }

      try {
        width = Math.max(width, svg.getBBox().width + COMMIT_ROW_HORIZONTAL_INSET * 2);
      } catch {
        // The graph may be between render passes; the next scheduled pass will retry.
      } finally {
        for (const hitbox of hitboxes) {
          hitbox.removeAttribute("visibility");
        }
      }

      return Math.max(width, 1);
    }

    function getLaneX(lane) {
      return LANE_LEFT + lane * LANE_SPACING;
    }

    function getLaneY(rowIndex) {
      return LANE_TOP + rowIndex * 30;
    }

    function normalizeBranchRef(ref = "") {
      return String(ref)
        .replace(/^refs\\/heads\\//, "")
        .replace(/^refs\\/remotes\\//, "")
        .replace(/^remotes\\//, "")
        .trim();
    }

    function isBranchRef(ref = "") {
      const branch = normalizeBranchRef(ref);

      return Boolean(
        branch &&
        branch !== "HEAD" &&
        branch !== "uncommitted" &&
        !branch.startsWith("tag: ") &&
        !branch.endsWith("/HEAD")
      );
    }

    function getCommitBranchRefs(commit) {
      if (!commit || !Array.isArray(commit.refs)) {
        return [];
      }

      return Array.from(new Set(commit.refs
        .filter(isBranchRef)
        .map(normalizeBranchRef)));
    }

    function getPrioritizedCommitBranchRefs(index, commit) {
      const branches = getCommitBranchRefs(commit);
      const currentBranch = normalizeBranchRef(graphStates[index]?.graph?.branch || "");

      if (!currentBranch || !branches.includes(currentBranch)) {
        return branches;
      }

      return [
        currentBranch,
        ...branches.filter((branch) => branch !== currentBranch),
      ];
    }

    function getPrimaryBranchRef(index, commit) {
      return getPrioritizedCommitBranchRefs(index, commit)[0] || "";
    }

    function getBranchColor(index, branch, fallbackIndex = 0) {
      const name = normalizeBranchRef(branch);

      if (!name) {
        return LANE_COLORS[fallbackIndex % LANE_COLORS.length];
      }

      const state = graphStates[index];

      if (!state.branchColors.has(name)) {
        state.branchColors.set(name, LANE_COLORS[state.nextBranchColorIndex % LANE_COLORS.length]);
        state.nextBranchColorIndex++;
      }

      return state.branchColors.get(name);
    }

    function getColorTint(color, alpha) {
      const match = /^#([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(color);

      if (!match) {
        return color;
      }

      return "rgba(" + parseInt(match[1], 16) + ", " + parseInt(match[2], 16) + ", " + parseInt(match[3], 16) + ", " + alpha + ")";
    }

    function getLaneColor(index, branch, lane) {
      return getBranchColor(index, branch, lane);
    }

    function getKnownParentHashes(commits, commit) {
      const knownHashes = new Set(commits.map(({ hash }) => hash));

      return (commit.parents || []).filter((parent) => knownHashes.has(parent));
    }

    function getLaneRows(index, commits) {
      const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
      let lanes = [];
      let maxLaneCount = 1;

      return commits.map((commit, rowIndex) => {
        let lane = lanes.findIndex(({ hash }) => hash === commit.hash);
        const explicitBranch = getPrimaryBranchRef(index, commit);

        if (lane === -1) {
          lanes.push({
            hash: commit.hash,
            branch: explicitBranch,
          });
          lane = lanes.length - 1;
        } else if (explicitBranch) {
          lanes[lane] = {
            ...lanes[lane],
            branch: explicitBranch,
          };
        }

        const lanesBefore = lanes.map((item) => ({ ...item }));
        const branch = explicitBranch || lanesBefore[lane]?.branch || "";
        const parents = getKnownParentHashes(commits, commit);
        const lanesAfter = lanesBefore
          .filter((item, index) => index !== lane)
          .map((item) => ({ ...item }));
        const parentItems = parents
          .filter((parent, parentIndex) => parents.indexOf(parent) === parentIndex)
          .map((parent, parentIndex) => {
            const existing = lanesAfter.find((item) => item.hash === parent);
            const parentBranch = getPrimaryBranchRef(index, commitsByHash.get(parent)) || (parentIndex === 0 ? branch : "");

            if (existing) {
              if (parentBranch && !existing.branch) {
                existing.branch = parentBranch;
              }
              return null;
            }

            return {
              hash: parent,
              branch: parentBranch,
            };
          })
          .filter(Boolean);

        lanesAfter.splice(lane, 0, ...parentItems);

        maxLaneCount = Math.max(maxLaneCount, lanesBefore.length, lanesAfter.length);
        lanes = lanesAfter;

        return {
          commit,
          rowIndex,
          lane,
          branch,
          lanesBefore,
          lanesAfter,
          parents,
          get maxLaneCount() {
            return maxLaneCount;
          },
        };
      });
    }

    function createSvgElement(name, attributes = {}) {
      const node = document.createElementNS(SVG_NS, name);

      Object.entries(attributes).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          node.setAttribute(key, String(value));
        }
      });

      return node;
    }

    function getLanePathD(fromLane, fromRow, toLane, toRow) {
      const fromX = getLaneX(fromLane);
      const fromY = getLaneY(fromRow);
      const toX = getLaneX(toLane);
      const toY = getLaneY(toRow);

      if (fromX === toX) {
        return "M " + fromX + " " + fromY + " L " + toX + " " + toY;
      }

      const midY = fromY + (toY - fromY) / 2;

      return [
        "M " + fromX + " " + fromY,
        "C " + fromX + " " + midY + " " + toX + " " + midY + " " + toX + " " + toY,
      ].join(" ");
    }

    function drawLanePath(svg, index, fromLane, fromRow, toLane, toRow, branch) {
      const path = createSvgElement("path", {
        class: "lane-path",
        d: getLanePathD(fromLane, fromRow, toLane, toRow),
        stroke: getLaneColor(index, branch, fromLane),
        "stroke-width": 4,
      });

      svg.append(path);
    }

    function drawLaneContinuations(svg, index, row, rowCount) {
      if (row.rowIndex >= rowCount - 1) {
        return;
      }

      row.lanesBefore.forEach((laneState, beforeLane) => {
        if (laneState.hash === row.commit.hash) {
          return;
        }

        const afterLane = row.lanesAfter.findIndex(({ hash }) => hash === laneState.hash);

        if (afterLane === -1) {
          return;
        }

        drawLanePath(svg, index, beforeLane, row.rowIndex, afterLane, row.rowIndex + 1, laneState.branch || row.lanesAfter[afterLane]?.branch);
      });

      row.parents.forEach((parent) => {
        const afterLane = row.lanesAfter.findIndex(({ hash }) => hash === parent);

        if (afterLane !== -1) {
          drawLanePath(svg, index, row.lane, row.rowIndex, afterLane, row.rowIndex + 1, row.lanesAfter[afterLane]?.branch || row.branch);
        }
      });
    }

    function getCommitForMessage(text, commits) {
      const abbrev = (text.textContent || "").split(" ")[0];

      return commits.find((commit) => commit.hash.startsWith(abbrev) || commit.hash.substring(0, 7) === abbrev);
    }

    function isCurrentCommit(commit) {
      return Array.isArray(commit.refs) && commit.refs.includes("HEAD");
    }

    function isWorkingTreeCommit(commit) {
      return Boolean(commit && commit.workingTree);
    }

    function placeWorkingTreeCommits(commits) {
      const orderedCommits = commits.filter((commit) => !isWorkingTreeCommit(commit));
      const workingTreeCommits = commits.filter(isWorkingTreeCommit);

      for (const commit of workingTreeCommits) {
        const parentHash = commit.parents && commit.parents[0];
        const parentIndex = orderedCommits.findIndex((item) => item.hash === parentHash);

        if (parentIndex === -1) {
          orderedCommits.unshift(commit);
        } else {
          orderedCommits.splice(parentIndex, 0, commit);
        }
      }

      return orderedCommits;
    }

    function getCurrentCommitHash(commits) {
      return commits.find(isCurrentCommit)?.hash || "";
    }

    function formatCommitTitle(commit) {
      if (isWorkingTreeCommit(commit)) {
        return commit.subject;
      }

      return commit.hash.substring(0, 12) + " " + commit.subject;
    }

    function formatCommitMeta(commit) {
      if (isWorkingTreeCommit(commit)) {
        return "Current staged, unstaged, and untracked changes";
      }

      return commit.author.name + " <" + commit.author.email + ">";
    }

    function hideCommitContextMenu() {
      contextMenu.hidden = true;
      contextMenuState = null;
    }

    function showCommitContextMenu(event, index, commit) {
      if (!INTERACTIVE.enabled || isWorkingTreeCommit(commit)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      contextMenuState = {
        graphIndex: index,
        hash: commit.hash,
        label: graphStates[index].graph.label,
        subject: commit.subject,
      };
      contextMenu.querySelector(".context-menu-title").textContent =
        commit.hash.substring(0, 12) + " " + commit.subject;
      contextMenu.hidden = false;

      const x = Math.max(8, Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - 8));
      const y = Math.max(8, Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - 8));
      contextMenu.style.left = x + "px";
      contextMenu.style.top = y + "px";
      contextMenu.querySelector("button").focus();
    }

    function ensureCommitRowHitbox(commitGroup, width) {
      let hitbox = Array.from(commitGroup.children).find((node) => node.classList.contains("commit-row-hitbox"));
      const commitTranslate = getTranslate(commitGroup);

      if (!hitbox) {
        hitbox = document.createElementNS(SVG_NS, "rect");
        hitbox.classList.add("commit-row-hitbox");
        commitGroup.insertBefore(hitbox, commitGroup.firstChild);
      }

      hitbox.setAttribute("x", String(-commitTranslate.x - COMMIT_ROW_HORIZONTAL_INSET));
      hitbox.setAttribute("y", String(COMMIT_DOT_RADIUS - COMMIT_ROW_HEIGHT / 2));
      hitbox.setAttribute("width", String(width));
      hitbox.setAttribute("height", String(COMMIT_ROW_HEIGHT));
      hitbox.setAttribute("rx", "5");

      return hitbox;
    }

    function getBranchLabelWidth(branch) {
      return Math.max(28, branch.length * BRANCH_LABEL_TEXT_WIDTH + BRANCH_LABEL_PADDING_X * 2);
    }

    function addBranchLabels(group, index, commit, x, y, fallbackLane) {
      let nextX = x;

      for (const branch of getPrioritizedCommitBranchRefs(index, commit)) {
        const color = getBranchColor(index, branch, fallbackLane);
        const labelWidth = getBranchLabelWidth(branch);
        const rect = createSvgElement("rect", {
          class: "branch-label-bg",
          x: nextX,
          y: y - BRANCH_LABEL_HEIGHT / 2,
          width: labelWidth,
          height: BRANCH_LABEL_HEIGHT,
          rx: 3,
          fill: getColorTint(color, 0.15),
          stroke: getColorTint(color, 0.58),
        });
        const label = createSvgElement("text", {
          class: "branch-label-text",
          x: nextX + BRANCH_LABEL_PADDING_X,
          y,
          fill: color,
        });

        label.textContent = branch;
        group.append(rect, label);
        nextX += labelWidth + BRANCH_LABEL_GAP;
      }

      return nextX;
    }

    function addLaneCommitRow({ svg, index, row, messageX, width }) {
      const state = graphStates[index];
      const { commit, lane, rowIndex } = row;
      const y = getLaneY(rowIndex);
      const branchColor = getLaneColor(index, row.branch, lane);
      const group = createSvgElement("g", {
        class: "commit-row" + (isWorkingTreeCommit(commit) ? " working-tree" : ""),
        transform: "translate(0, 0)",
        role: "button",
        tabindex: "0",
        "aria-label": "Show diff for " + commit.hash.substring(0, 12) + " " + commit.subject,
      });
      const hitbox = createSvgElement("rect", {
        class: "commit-row-hitbox",
        x: 0,
        y: y - COMMIT_ROW_HEIGHT / 2,
        width,
        height: COMMIT_ROW_HEIGHT,
        rx: 5,
      });
      const dot = createSvgElement("circle", {
        class: "commit-dot",
        cx: getLaneX(lane),
        cy: y,
        r: COMMIT_DOT_RADIUS,
        fill: branchColor,
      });
      const hash = createSvgElement("text", {
        class: "commit-hash",
        x: messageX,
        y,
      });
      const branchRefs = getCommitBranchRefs(commit);
      let subjectX = messageX + COMMIT_HASH_WIDTH;
      const message = createSvgElement("text", {
        class: "commit-message",
        x: subjectX,
        y,
      });

      group.dataset.hash = commit.hash;
      hash.textContent = commit.hash.substring(0, 12);
      message.textContent = commit.subject;
      group.append(hitbox, dot, hash);

      if (branchRefs.length) {
        subjectX = addBranchLabels(group, index, commit, subjectX, y, lane) + COMMIT_SUBJECT_GAP;
        message.setAttribute("x", subjectX);
      }

      group.append(message);
      group.addEventListener("pointerover", () => group.classList.add("hover"));
      group.addEventListener("pointerout", (event) => {
        if (!group.contains(event.relatedTarget)) {
          group.classList.remove("hover");
        }
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showDiff(state.graph, index, commit);
        }
      });
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        showDiff(state.graph, index, commit);
      });
      group.addEventListener("contextmenu", (event) => showCommitContextMenu(event, index, commit));
      svg.append(group);
    }

    function renderLaneGraph(index, commits) {
      const container = getGraphContainer(index);
      const rows = getLaneRows(index, commits);
      const maxLaneCount = rows.reduce((max, row) => Math.max(max, row.maxLaneCount), 1);
      const messageX = getLaneX(maxLaneCount) + LANE_MESSAGE_GAP;
      const height = rows.length ? getLaneY(rows.length - 1) + LANE_TOP : 1;
      const width = Math.max(container.clientWidth || 0, messageX + 720);
      const svg = createSvgElement("svg", {
        width,
        height,
        viewBox: "0 0 " + width + " " + height,
      });

      rows.forEach((row) => drawLaneContinuations(svg, index, row, rows.length));
      rows.forEach((row) => addLaneCommitRow({
        svg,
        index,
        row,
        messageX,
        width,
      }));

      container.replaceChildren(svg);
      updateCommitRowStates(index);
    }

    function decorateCommitRows(index) {
      const state = graphStates[index];
      const container = getGraphContainer(index);
      const svg = container.querySelector("svg");
      const commits = state.commits.length ? state.commits : state.graph.commits || [];

      if (!svg || !commits.length) {
        return;
      }

      const width = getCommitRowsWidth(container, svg);

      for (const text of container.querySelectorAll("svg text")) {
        const messageGroup = text.parentElement;
        const firstMessageChild = messageGroup && messageGroup.firstElementChild;

        if (!messageGroup || firstMessageChild?.tagName.toLowerCase() === "rect") {
          continue;
        }

        const commit = getCommitForMessage(text, commits);
        const innerGroup = messageGroup.parentElement;
        const commitGroup = innerGroup && innerGroup.parentElement;

        if (!commit || !commitGroup) {
          continue;
        }

        const hitbox = ensureCommitRowHitbox(commitGroup, width);
        commitGroup.classList.add("commit-row");
        commitGroup.classList.toggle("working-tree", isWorkingTreeCommit(commit));
        commitGroup.dataset.hash = commit.hash;
        commitGroup.setAttribute("role", "button");
        commitGroup.setAttribute("tabindex", "0");
        commitGroup.setAttribute("aria-label", "Show diff for " + commit.hash.substring(0, 12) + " " + commit.subject);

        if (!commitGroup.dataset.commitRowDecorated) {
          commitGroup.dataset.commitRowDecorated = "true";
          commitGroup.addEventListener("pointerover", () => commitGroup.classList.add("hover"));
          commitGroup.addEventListener("pointerout", (event) => {
            if (!commitGroup.contains(event.relatedTarget)) {
              commitGroup.classList.remove("hover");
            }
          });
          commitGroup.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              showDiff(state.graph, index, commit);
            }
          });
          hitbox.addEventListener("click", (event) => {
            event.stopPropagation();
            showDiff(state.graph, index, commit);
          });
          commitGroup.addEventListener("contextmenu", (event) => showCommitContextMenu(event, index, commit));
        }

        if (isCurrentCommit(commit)) {
          state.currentHash = commit.hash;
        }
      }

      updateCommitRowStates(index);
    }

    function enhanceGraphRows(index) {
      centerBranchLabelsVertically(index);
      decorateCommitRows(index);
    }

    function scheduleGraphEnhancements(index) {
      window.requestAnimationFrame(() => {
        enhanceGraphRows(index);
        window.requestAnimationFrame(() => enhanceGraphRows(index));
      });
      window.setTimeout(() => enhanceGraphRows(index), 80);
    }

    function setGraphStatus(index, message, { error = false, canLoad = false } = {}) {
      const container = getGraphContainer(index);
      let status = container.querySelector(".graph-status");

      if (!status) {
        status = document.createElement("div");
        status.className = "graph-status";
        container.append(status);
      }

      status.classList.toggle("error", error);
      status.textContent = message;

      if (canLoad) {
        const button = document.createElement("button");
        button.className = "load-more";
        button.type = "button";
        button.textContent = "Load more";
        button.addEventListener("click", () => loadMoreCommits(index));
        status.append(" ", button);
      }
    }

    function ensureLoadSentinel(index) {
      if (!INTERACTIVE.enabled) {
        return;
      }

      const container = getGraphContainer(index);
      let sentinel = container.querySelector(".load-sentinel");

      if (!sentinel) {
        sentinel = document.createElement("div");
        sentinel.className = "load-sentinel";
        sentinel.dataset.index = String(index);
        loadObserver.observe(sentinel);
      }

      container.append(sentinel);
    }

    function renderLoadedGraph(index) {
      const state = graphStates[index];

      if (!state.commits.length) {
        state.rendered = true;
        state.snapshotSignature = getStateSnapshotFingerprint(state);
        setGraphSummary(index);
        setGraphStatus(index, state.loading ? "Loading commits..." : "No commits found.");
        return;
      }

      state.currentHash = getCurrentCommitHash(state.commits) || state.currentHash;
      renderLaneGraph(index, pruneLoadedParents(state.commits));
      scheduleGraphEnhancements(index);
      state.rendered = true;
      state.snapshotSignature = getStateSnapshotFingerprint(state);
      setGraphSummary(index);
      ensureLoadSentinel(index);
      setGraphStatus(
        index,
        state.hasMore
          ? "Loaded " + state.commits.length + " commits. Scroll down to load more."
          : "Loaded all " + state.commits.length + " commits.",
        { canLoad: state.hasMore }
      );
    }

    async function loadMoreCommits(index) {
      const state = graphStates[index];

      if (!INTERACTIVE.enabled || state.loading || !state.hasMore || state.graph.error) {
        return;
      }

      state.loading = true;
      setGraphStatus(index, "Loading commits...");

      try {
        const response = await fetch(
          "/api/graph/" + index + "/commits?offset=" + state.offset +
            "&limit=" + INTERACTIVE.pageSize +
            "&token=" + encodeURIComponent(INTERACTIVE.token)
        );
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        state.commits = placeWorkingTreeCommits([...state.commits, ...result.commits]);
        state.graph.commits = state.commits;
        state.offset = result.nextOffset;
        state.hasMore = result.hasMore;
        state.workingTreeCount = result.workingTreeCount || state.workingTreeCount || 0;
        state.graph.workingTreeCount = state.workingTreeCount;
        state.graph.commitCount = state.commits.filter((commit) => !isWorkingTreeCommit(commit)).length;
        renderLoadedGraph(index);
      } catch (error) {
        setGraphStatus(index, error && error.message ? error.message : String(error), { error: true });
      } finally {
        state.loading = false;
      }
    }

    function setDiffText(body, text) {
      const placeholder = document.createElement("pre");
      placeholder.className = "diff-placeholder";
      placeholder.textContent = text;
      body.replaceChildren(placeholder);
    }

    function setDiffHtml(body, html) {
      body.innerHTML = html;
    }

    function formatDiffChangeCountLabel(insertions, deletions) {
      const additionLabel = insertions === 1 ? "addition" : "additions";
      const deletionLabel = deletions === 1 ? "deletion" : "deletions";

      return insertions + " " + additionLabel + " and " + deletions + " " + deletionLabel;
    }

    function setDiffStats(stats, diff) {
      const insertions = Number(diff && diff.insertions);
      const deletions = Number(diff && diff.deletions);

      if (!Number.isFinite(insertions) || !Number.isFinite(deletions)) {
        stats.hidden = true;
        stats.setAttribute("aria-label", "");
        stats.querySelector(".stat-additions").textContent = "";
        stats.querySelector(".stat-deletions").textContent = "";
        return;
      }

      stats.hidden = false;
      stats.setAttribute("aria-label", formatDiffChangeCountLabel(insertions, deletions));
      stats.querySelector(".stat-additions").textContent = "+" + insertions;
      stats.querySelector(".stat-deletions").textContent = "-" + deletions;
    }

    function clearDiffSelection(index, message = "Select a commit in the graph.") {
      const viewer = document.getElementById("diff-" + index);

      if (!viewer) {
        return;
      }

      graphStates[index].selectedHash = "";
      viewer.querySelector(".diff-title").textContent = "No commit selected";
      viewer.querySelector(".diff-meta").textContent = "";
      setCommitMessage(viewer.querySelector(".diff-message"), "");
      viewer.querySelector(".checkout-commit").hidden = true;
      viewer.querySelector(".amend-commit").hidden = true;
      viewer.querySelector(".checkout-status").textContent = "";
      setDiffStats(viewer.querySelector(".diff-stats"), null);
      setDiffText(viewer.querySelector(".diff-body"), message);
      updateCommitRowStates(index);
    }

    function setCommitMessage(messageElement, message = "") {
      const text = String(message || "").trimEnd();

      messageElement.replaceChildren(...getLinkedCommitMessageNodes(text));
      messageElement.hidden = !text;
    }

    function getCommitMessageLinkUrl(text) {
      if (/^https?:\\/\\//i.test(text)) {
        return text;
      }

      const bugMatch = /^bug\\s+#?(\\d{4,8})$/i.exec(text);
      if (bugMatch) {
        return BUGZILLA_BUG_URL + bugMatch[1];
      }

      const phabMatch = /^(?:phab-)?D(\\d{4,})$/i.exec(text);
      if (phabMatch) {
        return PHABRICATOR_REVISION_URL + phabMatch[1];
      }

      return "";
    }

    function splitLinkTrailingPunctuation(text) {
      const match = /^(.*?)([.,;:)]+)?$/.exec(text);

      if (!match) {
        return [text, ""];
      }

      return [match[1], match[2] || ""];
    }

    function getLinkedCommitMessageNodes(message) {
      const nodes = [];
      let index = 0;

      for (const match of message.matchAll(COMMIT_MESSAGE_LINK_PATTERN)) {
        const rawText = match[0];
        const start = match.index || 0;

        if (start > index) {
          nodes.push(document.createTextNode(message.slice(index, start)));
        }

        const [linkText, trailingText] = splitLinkTrailingPunctuation(rawText);
        const href = getCommitMessageLinkUrl(linkText);

        if (href) {
          const link = document.createElement("a");
          link.href = href;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = linkText;
          nodes.push(link);
        } else {
          nodes.push(document.createTextNode(linkText));
        }

        if (trailingText) {
          nodes.push(document.createTextNode(trailingText));
        }

        index = start + rawText.length;
      }

      if (index < message.length) {
        nodes.push(document.createTextNode(message.slice(index)));
      }

      return nodes;
    }

    async function loadSelectedCommitMessage(index, commit, messageElement) {
      if (!INTERACTIVE.enabled || isWorkingTreeCommit(commit)) {
        setCommitMessage(messageElement, "");
        return;
      }

      setCommitMessage(messageElement, "Loading commit message...");

      try {
        const response = await fetch(
          "/api/graph/" + index + "/message/" + encodeURIComponent(commit.hash) +
            "?token=" + encodeURIComponent(INTERACTIVE.token)
        );
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        if (graphStates[index].selectedHash !== commit.hash) {
          return;
        }

        setCommitMessage(messageElement, result.message || commit.subject);
      } catch (error) {
        if (graphStates[index].selectedHash === commit.hash) {
          setCommitMessage(messageElement, "Could not load commit message: " + (error && error.message ? error.message : String(error)));
        }
      }
    }

    function selectCommitActionResult(index, hash, message) {
      const state = graphStates[index];
      const viewer = document.getElementById("diff-" + index);
      const commit = hash ? state.commits.find((item) => item.hash === hash) : null;

      if (!commit) {
        clearDiffSelection(index, message);
        return;
      }

      showDiff(state.graph, index, commit);
      viewer.querySelector(".checkout-status").textContent = message || "";
    }

    function getLoadedGitCommitLimit(state) {
      const loadedGitCommits = state.commits.filter((commit) => !isWorkingTreeCommit(commit)).length;

      return Math.max(INTERACTIVE.pageSize, loadedGitCommits);
    }

    function resetRenderedGraph(index) {
      const state = graphStates[index];

      state.gitgraph = null;
      state.rendered = false;
      getGraphContainer(index).replaceChildren();
    }

    function applyGraphSnapshot(index, snapshot, { force = false } = {}) {
      const state = graphStates[index];
      const nextSignature = getSnapshotFingerprint(snapshot);

      if (!force && state.snapshotSignature === nextSignature) {
        return false;
      }

      const previousSelectedHash = state.selectedHash;
      state.graph.label = snapshot.label || state.graph.label;
      state.graph.path = snapshot.path || state.graph.path;
      state.graph.branch = snapshot.branch || "";
      state.graph.commitCount = snapshot.commitCount || 0;
      state.graph.workingTreeCount = snapshot.workingTreeCount || 0;
      state.graph.diffs = {};
      state.commits = placeWorkingTreeCommits(snapshot.commits || []);
      state.graph.commits = state.commits;
      state.offset = snapshot.nextOffset || state.commits.length;
      state.hasMore = Boolean(snapshot.hasMore);
      state.workingTreeCount = snapshot.workingTreeCount || 0;
      state.currentHash = getCurrentCommitHash(state.commits);
      state.snapshotSignature = nextSignature;
      setGraphSummary(index);
      resetRenderedGraph(index);
      renderLoadedGraph(index);

      if (!previousSelectedHash) {
        return true;
      }

      const selectedCommit = state.commits.find((commit) => commit.hash === previousSelectedHash);

      if (selectedCommit) {
        showDiff(state.graph, index, selectedCommit);
      } else {
        clearDiffSelection(index, "Graph updated. The selected commit is no longer loaded.");
      }

      return true;
    }

    async function refreshGraphFromServer(index, { force = false } = {}) {
      const state = graphStates[index];

      if (!INTERACTIVE.enabled || state.loading || state.refreshing || state.graph.error) {
        return false;
      }

      state.refreshing = true;

      try {
        const response = await fetch(
          "/api/graph/" + index + "/snapshot?limit=" + getLoadedGitCommitLimit(state) +
            "&token=" + encodeURIComponent(INTERACTIVE.token)
        );
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        return applyGraphSnapshot(index, result, { force });
      } catch (error) {
        setGraphStatus(index, error && error.message ? error.message : String(error), { error: true });
        return false;
      } finally {
        state.refreshing = false;
      }
    }

    function pollGraphUpdates() {
      if (!INTERACTIVE.enabled) {
        return;
      }

      graphStates.forEach((state, index) => {
        if (state.rendered || state.commits.length) {
          refreshGraphFromServer(index);
        }
      });
    }

    async function showDiff(graph, index, commit) {
      const viewer = document.getElementById("diff-" + index);
      const title = viewer.querySelector(".diff-title");
      const meta = viewer.querySelector(".diff-meta");
      const commitMessage = viewer.querySelector(".diff-message");
      const stats = viewer.querySelector(".diff-stats");
      const body = viewer.querySelector(".diff-body");
      const checkoutButton = viewer.querySelector(".checkout-commit");
      const amendButton = viewer.querySelector(".amend-commit");
      const submitButton = viewer.querySelector(".submit-commit");
      const checkoutStatus = viewer.querySelector(".checkout-status");
      const diff = graph.diffs && graph.diffs[commit.hash];

      graphStates[index].selectedHash = commit.hash;
      updateCommitRowStates(index);

      title.textContent = formatCommitTitle(commit);
      meta.textContent = formatCommitMeta(commit);
      setCommitMessage(commitMessage, "");
      checkoutButton.hidden = !INTERACTIVE.enabled || isWorkingTreeCommit(commit);
      checkoutButton.disabled = false;
      checkoutButton.dataset.graphIndex = String(index);
      checkoutButton.dataset.hash = commit.hash;
      checkoutButton.dataset.label = graph.label;
      amendButton.hidden = !INTERACTIVE.enabled;
      amendButton.disabled = false;
      amendButton.textContent = isWorkingTreeCommit(commit) ? "Amend" : "Amend Message";
      amendButton.dataset.graphIndex = String(index);
      amendButton.dataset.hash = commit.hash;
      amendButton.dataset.label = graph.label;
      amendButton.dataset.changeId = commit.changeId || "";
      amendButton.dataset.includeChanges = String(isWorkingTreeCommit(commit));
      submitButton.hidden = !INTERACTIVE.enabled || isWorkingTreeCommit(commit) || !isCurrentCommit(commit);
      submitButton.disabled = false;
      submitButton.dataset.graphIndex = String(index);
      submitButton.dataset.hash = commit.hash;
      submitButton.dataset.label = graph.label;
      checkoutStatus.classList.remove("error");
      checkoutStatus.textContent = "";
      setDiffStats(stats, null);

      if (INTERACTIVE.enabled) {
        setDiffText(body, "Loading diff...");
        loadSelectedCommitMessage(index, commit, commitMessage);

        try {
          const response = await fetch(
            "/api/graph/" + index + "/diff/" + encodeURIComponent(commit.hash) +
              "?token=" + encodeURIComponent(INTERACTIVE.token)
          );
          const result = await response.json();

          if (!response.ok) {
            throw new Error(result.error || response.statusText);
          }

          setDiffStats(stats, result);
          if (result.html) {
            setDiffHtml(body, result.html);
          } else {
            setDiffText(body, result.text || "No diff for this commit.");
          }
        } catch (error) {
          setDiffStats(stats, null);
          setDiffText(body, error && error.message ? error.message : String(error));
        }

        return;
      }

      if (!diff) {
        setDiffText(body, "Diff data was not embedded for this commit.");
        return;
      }

      if (diff.error) {
        setDiffText(body, diff.error);
        return;
      }

      setDiffStats(stats, diff);
      if (diff.html) {
        setDiffHtml(body, diff.html);
        return;
      }

      setDiffText(body, diff.text || "No diff for this commit.");
    }

    function getCommitActionDetails(action, label, hash) {
      const shortHash = hash.substring(0, 12);

      if (action === "checkout") {
        return {
          confirm: "Checkout " + shortHash + " in " + label + "? Branch tips will check out the branch; other commits will use detached HEAD.",
          progress: "Checking out...",
        };
      }

      if (action === "rebase") {
        return {
          confirm: "Rebase " + shortHash + " in " + label + " onto the current checkout?",
          progress: "Rebasing...",
        };
      }

      if (action === "prune") {
        return {
          confirm: "Prune commit " + shortHash + " from local branch history in " + label + "?",
          progress: "Pruning commit...",
        };
      }

      return {
        confirm: "Run " + action + " on " + shortHash + " in " + label + "?",
        progress: "Running...",
      };
    }

    async function runCommitAction(action, { graphIndex, hash, label }) {
      const details = getCommitActionDetails(action, label, hash);
      const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

      if (!confirm(details.confirm)) {
        return;
      }

      status.classList.remove("error");
      status.textContent = details.progress;

      try {
        const response = await fetch("/api/commit-action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: INTERACTIVE.token,
            graphIndex,
            hash,
            action,
            snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
          }),
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        if (result.branch) {
          graphStates[graphIndex].graph.branch = result.branch;
        }
        if (result.currentHash) {
          graphStates[graphIndex].currentHash = result.currentHash;
        } else if (action === "checkout") {
          graphStates[graphIndex].currentHash = hash;
        }
        updateCommitRowStates(graphIndex);

        if (result.snapshot) {
          applyGraphSnapshot(graphIndex, result.snapshot, { force: true });
        } else {
          await refreshGraphFromServer(graphIndex, { force: true });
        }

        status.textContent = result.message;
      } catch (error) {
        status.classList.add("error");
        status.textContent = error && error.message ? error.message : String(error);
      }
    }

    async function checkoutSelectedCommit(button) {
      button.disabled = true;

      try {
        await runCommitAction("checkout", {
          graphIndex: Number(button.dataset.graphIndex),
          hash: button.dataset.hash,
          label: button.dataset.label,
        });
      } finally {
        button.disabled = false;
      }
    }

    function closeAmendDialog() {
      amendDialogState = null;
      amendError.textContent = "";
      amendSubmit.disabled = false;
      amendDialog.close();
    }

    async function openAmendDialog(button) {
      const graphIndex = Number(button.dataset.graphIndex);
      const hash = button.dataset.hash || "HEAD";
      const includeChanges = button.dataset.includeChanges === "true";
      const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

      button.disabled = true;
      status.classList.remove("error");
      status.textContent = "Loading commit message...";

      try {
        const response = await fetch(
          "/api/graph/" + graphIndex + "/message/" + encodeURIComponent(hash) +
            "?token=" + encodeURIComponent(INTERACTIVE.token)
        );
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        amendDialogState = {
          graphIndex,
          hash,
          changeId: button.dataset.changeId || "",
          includeChanges,
          label: button.dataset.label,
        };
        amendDialog.querySelector(".amend-title").textContent = includeChanges
          ? "Amend " + button.dataset.label + " current commit"
          : "Amend " + button.dataset.label + " commit " + hash.substring(0, 12);
        amendMessage.value = result.message || "";
        amendError.textContent = "";
        status.textContent = "";
        amendDialog.showModal();
        amendMessage.focus();
        amendMessage.setSelectionRange(amendMessage.value.length, amendMessage.value.length);
      } catch (error) {
        status.classList.add("error");
        status.textContent = error && error.message ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    }

    async function submitAmendDialog() {
      if (!amendDialogState) {
        return;
      }

      const message = amendMessage.value;

      if (!message.trim()) {
        amendError.textContent = "Commit message cannot be empty.";
        return;
      }

      amendSubmit.disabled = true;
      amendError.textContent = "Amending...";

      try {
        const response = await fetch("/api/amend-message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: INTERACTIVE.token,
            graphIndex: amendDialogState.graphIndex,
            hash: amendDialogState.hash,
            expectedChangeId: amendDialogState.changeId,
            includeChanges: amendDialogState.includeChanges,
            message,
            snapshotLimit: getLoadedGitCommitLimit(graphStates[amendDialogState.graphIndex]),
          }),
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        const graphIndex = amendDialogState.graphIndex;

        closeAmendDialog();

        if (result.snapshot) {
          applyGraphSnapshot(graphIndex, result.snapshot, { force: true });
        } else {
          await refreshGraphFromServer(graphIndex, { force: true });
        }

        selectCommitActionResult(graphIndex, result.rewrittenHash || result.currentHash, result.message);
      } catch (error) {
        amendError.textContent = error && error.message ? error.message : String(error);
      } finally {
        amendSubmit.disabled = false;
      }
    }

    function closeSubmitDialog() {
      if (submitPollTimer) {
        window.clearTimeout(submitPollTimer);
        submitPollTimer = null;
      }

      submitDialog.close();
    }

    function setSubmitLinkNodes(links) {
      submitLinks.replaceChildren();

      if (!links || !links.length) {
        submitLinks.hidden = true;
        return;
      }

      for (const linkInfo of links) {
        const link = document.createElement("a");
        link.href = linkInfo.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = linkInfo.label || linkInfo.url;
        submitLinks.append(link);
      }

      submitLinks.hidden = false;
    }

    function renderSubmitSession(session) {
      submitStatus.textContent = session.message || session.status || "";
      submitStatus.classList.toggle("error", session.status === "error");
      submitClose.disabled = session.status === "running" || session.status === "prompt";
      submitOutput.textContent = session.output || "";
      submitOutput.scrollTop = submitOutput.scrollHeight;

      if (session.prompt) {
        submitPrompt.hidden = false;
        submitQuestion.textContent = session.prompt.message;
        submitDialogState.promptId = session.prompt.id;
      } else {
        submitPrompt.hidden = true;
        submitQuestion.textContent = "";
        submitDialogState.promptId = "";
      }

      setSubmitLinkNodes(session.links || []);

      if (session.status === "complete" && session.snapshot && !submitDialogState.appliedSnapshot) {
        submitDialogState.appliedSnapshot = true;
        applyGraphSnapshot(submitDialogState.graphIndex, session.snapshot, { force: true });
      }
    }

    async function pollSubmitSession() {
      if (!submitDialogState) {
        return;
      }

      try {
        const response = await fetch(
          "/api/submit/" + encodeURIComponent(submitDialogState.sessionId) +
            "?token=" + encodeURIComponent(INTERACTIVE.token)
        );
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        renderSubmitSession(result);

        if (result.status === "running") {
          submitPollTimer = window.setTimeout(pollSubmitSession, 500);
        }
      } catch (error) {
        submitStatus.classList.add("error");
        submitStatus.textContent = error && error.message ? error.message : String(error);
      }
    }

    async function openSubmitDialog(button) {
      const graphIndex = Number(button.dataset.graphIndex);
      const status = document.getElementById("diff-" + graphIndex).querySelector(".checkout-status");

      if (!confirm("Submit the currently checked out commit in " + button.dataset.label + "?")) {
        return;
      }

      button.disabled = true;
      status.classList.remove("error");
      status.textContent = "Starting submit...";

      try {
        const response = await fetch("/api/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: INTERACTIVE.token,
            graphIndex,
            hash: button.dataset.hash,
            snapshotLimit: getLoadedGitCommitLimit(graphStates[graphIndex]),
          }),
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        submitDialogState = {
          graphIndex,
          sessionId: result.id,
          promptId: "",
          appliedSnapshot: false,
        };
        submitTitle.textContent = "Submit " + button.dataset.label + " current commit";
        submitPrompt.hidden = true;
        submitQuestion.textContent = "";
        submitLinks.hidden = true;
        submitLinks.replaceChildren();
        submitOutput.textContent = "";
        renderSubmitSession(result);
        status.textContent = "";
        submitDialog.showModal();
        pollSubmitSession();
      } catch (error) {
        status.classList.add("error");
        status.textContent = error && error.message ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    }

    async function answerSubmitPrompt(answer) {
      if (!submitDialogState || !submitDialogState.promptId) {
        return;
      }

      submitStatus.classList.remove("error");
      submitStatus.textContent = "Running submit...";
      submitPrompt.hidden = true;

      try {
        const response = await fetch(
          "/api/submit/" + encodeURIComponent(submitDialogState.sessionId) + "/answer",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token: INTERACTIVE.token,
              promptId: submitDialogState.promptId,
              answer,
            }),
          }
        );
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        renderSubmitSession(result);
        pollSubmitSession();
      } catch (error) {
        submitStatus.classList.add("error");
        submitStatus.textContent = error && error.message ? error.message : String(error);
      }
    }

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".context-menu")) {
        hideCommitContextMenu();
      }

      const checkoutButton = event.target.closest(".checkout-commit");
      if (checkoutButton) {
        checkoutSelectedCommit(checkoutButton);
        return;
      }

      const amendButton = event.target.closest(".amend-commit");
      if (amendButton) {
        openAmendDialog(amendButton);
        return;
      }

      const submitButton = event.target.closest(".submit-commit");
      if (submitButton) {
        openSubmitDialog(submitButton);
        return;
      }

      const button = event.target.closest(".copy-path");
      if (!button) {
        return;
      }

      if (navigator.clipboard) {
        navigator.clipboard.writeText(button.dataset.path);
      }
    });

    contextMenu.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");

      if (!button || !contextMenuState) {
        return;
      }

      event.stopPropagation();
      const actionState = contextMenuState;
      hideCommitContextMenu();
      runCommitAction(button.dataset.action, actionState);
    });

    amendForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitAmendDialog();
    });

    amendDialog.querySelector(".amend-cancel").addEventListener("click", closeAmendDialog);
    submitClose.addEventListener("click", closeSubmitDialog);
    submitDialog.querySelectorAll("button[data-answer]").forEach((button) => {
      button.addEventListener("click", () => answerSubmitPrompt(button.dataset.answer === "true"));
    });

    window.addEventListener("scroll", hideCommitContextMenu, { passive: true });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideCommitContextMenu();
      }
    });

    function handleSentinelIntersections(entries) {
      for (const entry of entries) {
        const index = Number(entry.target.dataset.index);
        const state = graphStates[index];

        if (!entry.isIntersecting) {
          state.sentinelReady = true;
          continue;
        }

        if (
          !state.sentinelReady ||
          !state.scrolledTowardBottom ||
          !document.querySelector('.panel[data-index="' + index + '"]').classList.contains("active")
        ) {
          continue;
        }

        state.sentinelReady = false;
        state.scrolledTowardBottom = false;
        loadMoreCommits(index);
      }
    }

    const loadObserver = INTERACTIVE.enabled
      ? new IntersectionObserver(handleSentinelIntersections, { rootMargin: "0px 0px 240px 0px" })
      : null;

    function trackScrollDirection() {
      if (!INTERACTIVE.enabled) {
        return;
      }

      const activePanel = document.querySelector(".panel.active");
      const index = Number(activePanel.dataset.index);
      const state = graphStates[index];

      if (window.scrollY > state.lastScrollY) {
        state.scrolledTowardBottom = true;
      }

      state.lastScrollY = window.scrollY;
    }

    function renderGraph(index) {
      const state = graphStates[index];
      const graph = state.graph;
      const container = document.getElementById("graph-" + index);

      if (graph.error) {
        showError(container, graph.error);
        return;
      }

      if (INTERACTIVE.enabled) {
        if (!state.commits.length) {
          loadMoreCommits(index);
        } else {
          renderLoadedGraph(index);
        }

        return;
      }

      if (state.rendered) {
        return;
      }

      if (!state.commits.length) {
        container.textContent = "No commits found.";
        state.rendered = true;
        return;
      }

      try {
        state.currentHash = getCurrentCommitHash(state.commits) || state.currentHash;
        renderLaneGraph(index, state.commits);
        scheduleGraphEnhancements(index);
        state.rendered = true;
      } catch (error) {
        showError(container, error && error.message ? error.message : String(error));
      }
    }

    function showTab(index) {
      document.querySelectorAll(".tab, .panel").forEach((node) => node.classList.remove("active"));
      document.querySelector('.tab[data-index="' + index + '"]').classList.add("active");
      document.querySelector('.panel[data-index="' + index + '"]').classList.add("active");
      restoreGraphPaneWidth(index);
      renderGraph(index);
      scheduleGraphEnhancements(index);
    }

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => showTab(Number(tab.dataset.index)));
    });

    document.querySelectorAll(".pane-resizer").forEach((resizer) => {
      resizer.addEventListener("pointerdown", startPaneResize);
      resizer.addEventListener("keydown", resizePaneFromKeyboard);
    });

    window.addEventListener("scroll", trackScrollDirection, { passive: true });
    window.addEventListener("resize", () => {
      const activePanel = document.querySelector(".panel.active");

      if (activePanel) {
        restoreGraphPaneWidth(Number(activePanel.dataset.index));
      }
    }, { passive: true });

    if (INTERACTIVE.enabled) {
      function sendCloseSignal() {
        const payload = JSON.stringify({ token: INTERACTIVE.token });

        if (navigator.sendBeacon) {
          navigator.sendBeacon("/api/close", new Blob([payload], { type: "application/json" }));
          return;
        }

        fetch("/api/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          keepalive: true,
        });
      }

      const heartbeat = setInterval(() => {
        fetch("/api/ping", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: INTERACTIVE.token }),
          keepalive: true,
        }).catch(() => {});
      }, 2000);
      const graphPoll = setInterval(pollGraphUpdates, INTERACTIVE.pollIntervalMs);

      window.addEventListener("pagehide", () => {
        clearInterval(heartbeat);
        clearInterval(graphPoll);
        sendCloseSignal();
      }, { once: true });
      window.addEventListener("beforeunload", sendCloseSignal, { once: true });
    }

    restoreGraphPaneWidth(0);
    renderGraph(0);
  </script>
</body>
</html>`;
}

function getGitgraphBundlePath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "@gitgraph",
    "js",
    "lib",
    "gitgraph.umd.js"
  );
}

export function getGraphOutputPath(output) {
  return output ? path.resolve(output) : path.join(os.tmpdir(), "tb-tools-branch-graph.html");
}

async function readRequestJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function validateToken(token, expectedToken) {
  if (token !== expectedToken) {
    const error = new Error("Invalid interactive graph token.");
    error.statusCode = 403;
    throw error;
  }
}

function formatDurationLabel(milliseconds) {
  const seconds = Math.ceil(Number(milliseconds || 0) / 1000);
  const unit = seconds === 1 ? "second" : "seconds";

  return `${seconds} ${unit}`;
}

export async function startInteractiveGraphServer({
  html,
  graphs,
  token,
  pageSize = 80,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  port = 0,
  host = "127.0.0.1",
  heartbeatIntervalMs = 2000,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  runCommand = run,
  postComment = defaultComment,
  serverFactory = createServer,
}) {
  const serverGraphs = graphs.map((graph) => ({
    ...graph,
    knownHashes: new Set(),
    workingTreeCount: 0,
  }));
  const submitSessions = new Map();
  const sockets = new Set();
  let closeTimer;
  let lastHeartbeat;
  let shuttingDown = false;
  const heartbeatTimer = setInterval(() => {
    if (lastHeartbeat && Date.now() - lastHeartbeat > heartbeatTimeoutMs) {
      shutdown(0, `browser heartbeat timed out after ${formatDurationLabel(heartbeatTimeoutMs)}`);
    }
  }, heartbeatIntervalMs);

  function shutdown(delay = 0, reason = "server shutdown requested") {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.closeReason = reason;
    closeTimer = setTimeout(() => {
      clearInterval(heartbeatTimer);

      if (server.listening) {
        server.close();
      }

      setTimeout(() => {
        sockets.forEach((socket) => socket.destroy());
      }, 250);
    }, delay);
  }

  async function getServerGraphSnapshot(graph, limit) {
    const snapshot = await getCheckoutGraphSnapshot({
      graph,
      limit,
      runCommand,
    });

    graph.branch = snapshot.branch;
    graph.workingTreeCount = snapshot.workingTreeCount || 0;
    graph.commitCount = snapshot.commitCount || 0;
    graph.knownHashes = new Set(snapshot.commits.map((commit) => commit.hash));

    return snapshot;
  }

  function getRequestLimit(value) {
    return Math.max(1, Number(value || pageSize) || pageSize);
  }

  const server = serverFactory(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
        lastHeartbeat = Date.now();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }

      const commitPageMatch = url.pathname.match(/^\/api\/graph\/(\d+)\/commits$/);
      if (request.method === "GET" && commitPageMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(commitPageMatch[1])];

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const limit = Math.max(1, Number(url.searchParams.get("limit") || pageSize) || pageSize);
        const page = await getCheckoutCommitPage({
          cwd: graph.path,
          offset,
          limit,
          includeWorkingTree: true,
          workingTreeCount: graph.workingTreeCount,
          runCommand,
        });

        graph.workingTreeCount = page.workingTreeCount || graph.workingTreeCount || 0;
        page.commits.forEach((commit) => graph.knownHashes.add(commit.hash));
        sendJson(response, 200, { ok: true, ...page });
        return;
      }

      const snapshotMatch = url.pathname.match(/^\/api\/graph\/(\d+)\/snapshot$/);
      if (request.method === "GET" && snapshotMatch) {
        validateToken(url.searchParams.get("token"), token);
        lastHeartbeat = Date.now();
        const graph = serverGraphs[Number(snapshotMatch[1])];

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        const limit = getRequestLimit(url.searchParams.get("limit"));
        const snapshot = await getServerGraphSnapshot(graph, limit);

        sendJson(response, 200, { ok: true, ...snapshot });
        return;
      }

      const commitMessageMatch = url.pathname.match(/^\/api\/graph\/(\d+)\/current-message$/);
      if (request.method === "GET" && commitMessageMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(commitMessageMatch[1])];

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }

        const message = await getGraphCurrentCommitMessage({
          graph,
          runCommand,
        });
        sendJson(response, 200, { ok: true, message });
        return;
      }

      const selectedCommitMessageMatch = url.pathname.match(/^\/api\/graph\/(\d+)\/message\/(.+)$/);
      if (request.method === "GET" && selectedCommitMessageMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(selectedCommitMessageMatch[1])];
        const hash = decodeURIComponent(selectedCommitMessageMatch[2]);

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD" && !graph.knownHashes.has(hash)) {
          sendJson(response, 404, { ok: false, error: "Commit has not been loaded by this graph." });
          return;
        }

        const message = await getGraphCommitMessage({
          graph,
          hash,
          runCommand,
        });
        sendJson(response, 200, { ok: true, message });
        return;
      }

      const diffMatch = url.pathname.match(/^\/api\/graph\/(\d+)\/diff\/(.+)$/);
      if (request.method === "GET" && diffMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(diffMatch[1])];
        const hash = decodeURIComponent(diffMatch[2]);

        if (!graph?.knownHashes.has(hash)) {
          sendJson(response, 404, { ok: false, error: "Commit has not been loaded by this graph." });
          return;
        }

        const diff = await getCommitDiff({
          cwd: graph.path,
          hash,
          maxDiffBytes,
          runCommand,
        });
        sendJson(response, 200, { ok: true, ...diff });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/checkout") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const result = await checkoutGraphCommit({
          graphs: serverGraphs,
          graphIndex: body.graphIndex,
          hash: body.hash,
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          serverGraphs[Number(body.graphIndex)],
          getRequestLimit(body.snapshotLimit)
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/commit-action") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const result = await runGraphCommitAction({
          graphs: serverGraphs,
          graphIndex: body.graphIndex,
          hash: body.hash,
          action: body.action,
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          serverGraphs[Number(body.graphIndex)],
          getRequestLimit(body.snapshotLimit)
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/api/amend-current" || url.pathname === "/api/amend-message")) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const graph = serverGraphs[Number(body.graphIndex)];
        const hash = String(body.hash || "HEAD");

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD" && !graph.knownHashes.has(hash)) {
          sendJson(response, 404, { ok: false, error: "Commit has not been loaded by this graph." });
          return;
        }

        const result = await amendCommitMessage({
          graph,
          hash,
          message: body.message,
          expectedChangeId: body.expectedChangeId,
          includeChanges: Boolean(body.includeChanges),
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          graph,
          getRequestLimit(body.snapshotLimit)
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/submit") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        lastHeartbeat = Date.now();
        const graphIndex = Number(body.graphIndex);
        const graph = serverGraphs[graphIndex];

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        const current = await getCurrentGraphBase(graph, runCommand);
        const requestedHash = String(body.hash || current.hash);

        if (requestedHash !== current.hash) {
          sendJson(response, 409, { ok: false, error: "Submit is only available for the currently checked out commit." });
          return;
        }

        const session = createGraphSubmitSession({
          graph,
          graphIndex,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
          getSnapshot: getServerGraphSnapshot,
          runCommand,
          postComment,
        });

        submitSessions.set(session.id, session);
        sendJson(response, 200, { ok: true, ...serializeSubmitSession(session) });
        return;
      }

      const submitStatusMatch = url.pathname.match(/^\/api\/submit\/([^/]+)$/);
      if (request.method === "GET" && submitStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        lastHeartbeat = Date.now();
        const session = submitSessions.get(decodeURIComponent(submitStatusMatch[1]));

        if (!session) {
          sendJson(response, 404, { ok: false, error: "Unknown submit session." });
          return;
        }

        sendJson(response, 200, { ok: true, ...serializeSubmitSession(session) });
        return;
      }

      const submitAnswerMatch = url.pathname.match(/^\/api\/submit\/([^/]+)\/answer$/);
      if (request.method === "POST" && submitAnswerMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        lastHeartbeat = Date.now();
        const session = submitSessions.get(decodeURIComponent(submitAnswerMatch[1]));

        if (!session) {
          sendJson(response, 404, { ok: false, error: "Unknown submit session." });
          return;
        }

        session.answer(body.promptId, body.answer);
        sendJson(response, 200, { ok: true, ...serializeSubmitSession(session) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ping") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        lastHeartbeat = Date.now();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/close") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        sendJson(response, 200, { ok: true });
        shutdown(50, "browser tab closed");
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        ok: false,
        error: String(error?.message || error),
      });
    }
  });
  server.shutdown = shutdown;
  heartbeatTimer.unref?.();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, resolve);
  });

  server.once("close", () => {
    clearInterval(heartbeatTimer);
    if (closeTimer) {
      clearTimeout(closeTimer);
    }
  });

  const address = server.address();

  return {
    server,
    graphs: serverGraphs,
    url: `http://${host}:${address.port}/`,
  };
}

export function waitForInteractiveServerClose(server, signalSource = process) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    const close = () => {
      if (typeof server.shutdown === "function") {
        server.shutdown(0, "terminal signal received");
        return;
      }

      if (server.listening) {
        server.close();
      }
    };
    const cleanup = () => {
      signalSource.off("SIGINT", close);
      signalSource.off("SIGTERM", close);
      resolve(server.closeReason || "server closed");
    };

    server.once("close", cleanup);
    signalSource.once("SIGINT", close);
    signalSource.once("SIGTERM", close);
  });
}

export function createGraphCommand({
  getCheckoutData = getCheckoutGraphData,
  getCheckoutMetadata = getCheckoutGraphMetadata,
  readBundle = readFile,
  write = writeFile,
  makeDir = mkdir,
  open = openUrl,
  startServer = startInteractiveGraphServer,
  waitForClose = waitForInteractiveServerClose,
  makeToken = randomUUID,
  runCommand = run,
  log = console.log,
} = {}) {
  return async function graph({
    limit = 80,
    output,
    open: shouldOpen = true,
    comm = true,
    firefox = true,
    diffs = true,
    maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
    interactive = false,
    pageSize = 80,
    port = 0,
  } = {}) {
    const count = Number(limit) || 80;
    const commitPageSize = Number(pageSize) || 80;
    const parsedDiffByteLimit = Number(maxDiffBytes);
    const diffByteLimit = Number.isFinite(parsedDiffByteLimit)
      ? parsedDiffByteLimit
      : DEFAULT_MAX_DIFF_BYTES;
    const checkouts = [];

    if (comm) {
      checkouts.push({ label: "comm", cwd: "." });
    }

    if (firefox) {
      checkouts.push({ label: "firefox", cwd: ".." });
    }

    if (!checkouts.length) {
      throw new Error("At least one checkout tab must be enabled.");
    }

    const [gitgraphScript, graphs] = await Promise.all([
      readBundle(getGitgraphBundlePath(), "utf8"),
      Promise.all(checkouts.map((checkout) => {
        if (interactive) {
          return getCheckoutMetadata(checkout);
        }

        return getCheckoutData({
          ...checkout,
          limit: count,
          diffs,
          maxDiffBytes: diffByteLimit,
        });
      })),
    ]);
    const token = interactive ? makeToken() : undefined;
    const html = buildGraphHtml({
      graphs,
      gitgraphScript,
      interactive: {
        enabled: interactive,
        pageSize: commitPageSize,
        token,
      },
    });
    const outputPath = getGraphOutputPath(output);

    if (interactive) {
      const graphServer = await startServer({
        html,
        graphs,
        token,
        pageSize: commitPageSize,
        maxDiffBytes: diffByteLimit,
        port,
        runCommand,
      });

      log(`Interactive graph running at ${graphServer.url}`);
      log("Close the browser tab or press Ctrl-C to stop the server.");

      if (shouldOpen) {
        await open(graphServer.url);
      }

      const closeReason = await waitForClose(graphServer.server);
      if (closeReason) {
        log(`Interactive graph stopped: ${closeReason}.`);
      }
      return graphServer.url;
    }

    await makeDir(path.dirname(outputPath), { recursive: true });
    await write(outputPath, html);

    if (shouldOpen) {
      await open(outputPath);
    }

    return outputPath;
  };
}

export default createGraphCommand();
