import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { getBug as defaultGetBug, updateBug as defaultUpdateBug } from "../../lib/bugzilla.mjs";
import defaultPhab, { comment as defaultComment } from "../../lib/phab.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import {
  ensureTbToolsIdInCommitMessage,
  getTbToolsIdFromCommitMessage,
} from "../../lib/commit-message.mjs";
import {
  getBugIdFromText,
  getBugUrl,
  getPhabRevisionFromText,
  getPhabUrl,
} from "../../lib/workflow.mjs";
import { getDefaultLintFiles, LINT_DIRS } from "../lint.mjs";
import { createSubmitCommand } from "../submit.mjs";
import { createTestCommand } from "../test.mjs";
import { createTryCommand } from "../try.mjs";
import { getNextBugBranchName } from "./branches.mjs";
import {
  CHECKIN_NEEDED_KEYWORD,
  DEFAULT_SUBMIT_OUTPUT_LIMIT,
  GRAPH_MACH_ACTION_BUILD,
  GRAPH_MACH_ACTION_BUILD_RUN,
  GRAPH_MACH_ACTION_RUN,
  GRAPH_MACH_ACTIONS,
  GRAPH_MACH_TERMINAL_STATUSES,
  GRAPH_SHELF_MESSAGE_PREFIX,
  GRAPH_SUBMIT_OPTIONS,
  GRAPH_UPDATE_DIRTY_ACTIONS,
  GRAPH_UPDATE_MODE_REBASE,
  GRAPH_UPDATE_MODE_UPDATE,
  GRAPH_UPDATE_MODES,
  WORKING_TREE_CHANGES_HASH,
} from "./constants.mjs";
import {
  chooseCheckoutBranch,
  choosePruneBranches,
  chooseRewordBranch,
  ensureAmendedCommitMessage,
  getContentHash,
  getCheckoutCommitPage,
  getGitAddAllArgs,
  getGitAmendArgs,
  getGraphCommitMessage,
  getGraphCommitPatchId,
  getGraphCurrentCommitMessage,
  getGraphTryRunsForCommit,
  getRawWorkingTreeDiff,
  getWorkingTreeCommits,
  getWorkingTreeTryPatchId,
  isCheckedOutCommit,
  isWorkingTreeCommitHash,
  parseBranchRefs,
  readGraphTryStore,
  recordGraphTryRun,
} from "./data.mjs";

const RUST_UPSTREAM_CHECKSUMS_PATH = "rust/checksums.json";
const RUST_UPSTREAM_FILES = {
  mc_workspace_toml: "Cargo.toml",
  mc_gkrust_toml: "toolkit/library/rust/shared/Cargo.toml",
  mc_hack_toml: "build/workspace-hack/Cargo.toml",
  mc_cargo_lock: "Cargo.lock",
};
const GRAPH_REBASE_MODE_SELECTED = "selected";
const GRAPH_REBASE_MODE_CHILDREN = "children";
const GRAPH_REBASE_MODE_DESCENDANTS = "descendants";
const GRAPH_REBASE_MODE_STACK = "stack";
const DEFAULT_GRAPH_REBASE_MODE = GRAPH_REBASE_MODE_DESCENDANTS;
const GRAPH_REBASE_MODES = new Set([
  GRAPH_REBASE_MODE_SELECTED,
  GRAPH_REBASE_MODE_CHILDREN,
  GRAPH_REBASE_MODE_DESCENDANTS,
  GRAPH_REBASE_MODE_STACK,
]);
const INTERACTIVE_REBASE_ACTION_PICK = "pick";
const INTERACTIVE_REBASE_ACTION_SQUASH = "squash";
const INTERACTIVE_REBASE_ACTION_FIXUP = "fixup";
const INTERACTIVE_REBASE_ACTION_EDIT = "edit";
const INTERACTIVE_REBASE_ACTION_DROP = "drop";
const INTERACTIVE_REBASE_ACTIONS = new Set([
  INTERACTIVE_REBASE_ACTION_PICK,
  INTERACTIVE_REBASE_ACTION_SQUASH,
  INTERACTIVE_REBASE_ACTION_FIXUP,
  INTERACTIVE_REBASE_ACTION_EDIT,
  INTERACTIVE_REBASE_ACTION_DROP,
]);

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

  const existingMessage = await getGraphCurrentCommitMessage({
    graph,
    runCommand,
  }).catch(() => "");
  const expectedTbToolsId = getTbToolsIdFromCommitMessage(existingMessage) || undefined;
  const commitMessageWithId = ensureTbToolsIdInCommitMessage(
    commitMessage,
    expectedTbToolsId,
  ).message;

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
  await writeMessage(
    messagePath,
    commitMessageWithId.endsWith("\n") ? commitMessageWithId : `${commitMessageWithId}\n`,
  );

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

  ensureAmendedCommitMessage(amendedMessage, commitMessageWithId, currentHashValue);

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

  const existingMessage = await getGraphCommitMessage({
    graph,
    hash: selectedHash,
    runCommand,
  }).catch(() => "");
  const expectedTbToolsId = getTbToolsIdFromCommitMessage(existingMessage) || undefined;
  const commitMessageWithId = ensureTbToolsIdInCommitMessage(
    commitMessage,
    expectedTbToolsId,
  ).message;

  const base = await getCurrentGraphBase(graph, runCommand);

  if (base.hash === selectedHash) {
    return amendCheckedOutCommit({
      graph,
      message: commitMessageWithId,
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
  const rewrittenCommits = [];
  let rewrittenHash = "";

  await writeMessage(
    messagePath,
    commitMessageWithId.endsWith("\n") ? commitMessageWithId : `${commitMessageWithId}\n`,
  );

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

        ensureAmendedCommitMessage(amendedMessage, commitMessageWithId, rewrittenHash);
        rewrittenCommits.push({
          originalHash: commit,
          hash: rewrittenHash,
        });
      } else {
        rewrittenCommits.push({
          originalHash: commit,
          hash: await getCurrentGraphHeadHash(graph, runCommand),
        });
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
    rewrittenCommits,
    amendedCount: stackCommits.length,
    rewrittenHash,
    currentHash,
    message: `${graph.label} amended message for ${selectedHash.slice(0, 12)}${stackCommits.length > 1 ? ` and replayed ${stackCommits.length - 1} descendant commit${stackCommits.length === 2 ? "" : "s"}` : ""} on branch ${branch}.`,
  };
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

async function getToolRefsAtCommit(graph, hash, runCommand) {
  return runCommand({
    cmd: "git",
    args: ["for-each-ref", "--sort=refname", "--format=%(refname)", "--points-at", hash, "refs/tb-tools"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
}

async function getToolRefsContainingCommit(graph, hash, runCommand) {
  return runCommand({
    cmd: "git",
    args: ["for-each-ref", "--sort=refname", "--format=%(refname)", "--contains", hash, "refs/tb-tools"],
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

function choosePruneRefs({
  containingRefs = "",
  tipRefs = "",
} = {}) {
  const containing = parseBranchRefs(containingRefs);
  const tips = parseBranchRefs(tipRefs).filter((ref) => containing.includes(ref));

  if (tips.length) {
    return [...new Set(tips)];
  }

  if (containing.length === 1) {
    return containing;
  }

  return [];
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

function normalizeRebaseMode(mode = DEFAULT_GRAPH_REBASE_MODE) {
  const normalized = String(mode || DEFAULT_GRAPH_REBASE_MODE).trim();

  if (!GRAPH_REBASE_MODES.has(normalized)) {
    const error = new Error(`Unknown rebase mode: ${normalized}`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function isCommitStackPrefix(candidate, target) {
  return candidate.every((commit, index) => target[index] === commit);
}

function getCommitStackSignature(commits) {
  return commits.join("\0");
}

function chooseRebaseStackCandidate({
  candidates = [],
  currentBranch = "",
  hash = "",
  preferredBranch = "",
} = {}) {
  if (!candidates.length) {
    return {
      branch: "",
      commits: [hash],
    };
  }

  const longestLength = Math.max(
    ...candidates.map((candidate) => candidate.commits.length),
  );
  const longestCandidates = candidates.filter(
    (candidate) => candidate.commits.length === longestLength,
  );
  const uniqueLongestStacks = new Set(
    longestCandidates.map((candidate) =>
      getCommitStackSignature(candidate.commits),
    ),
  );
  const preferredCandidate = longestCandidates.find(
    (candidate) => candidate.branch === preferredBranch,
  );
  const currentLongestCandidate = longestCandidates.find(
    (candidate) => candidate.branch === currentBranch,
  );
  const hintedCandidate = preferredCandidate || currentLongestCandidate;

  if (uniqueLongestStacks.size > 1 && !hintedCandidate) {
    const error = new Error(
      `Commit ${hash.slice(0, 12)} is contained by multiple descendant branch stacks (${longestCandidates.map((candidate) => candidate.branch).join(", ")}). Leave one source stack containing the commit, then try again.`,
    );
    error.statusCode = 409;
    throw error;
  }

  const selectedCandidate = hintedCandidate || longestCandidates[0];
  const targetCommits = selectedCandidate.commits;
  const divergentCandidates = candidates.filter(
    (candidate) => !isCommitStackPrefix(candidate.commits, targetCommits),
  );

  if (divergentCandidates.length && !hintedCandidate) {
    const error = new Error(
      `Commit ${hash.slice(0, 12)} is contained by divergent branch stacks (${divergentCandidates.map((candidate) => candidate.branch).join(", ")}). Leave one source stack containing the commit, then try again.`,
    );
    error.statusCode = 409;
    throw error;
  }

  const branch = chooseCheckoutBranch(
    longestCandidates.map((candidate) => candidate.branch).join("\n"),
    currentBranch,
  );

  return {
    branch: hintedCandidate?.branch || branch || selectedCandidate.branch,
    commits: targetCommits,
  };
}

async function getRebaseStackCandidate(graph, hash, branch, runCommand) {
  return {
    branch,
    commits: await getRebaseCommitStack(graph, hash, branch, runCommand),
  };
}

async function getWholeRebaseStackPrefix(graph, hash, runCommand) {
  const output = await runCommand({
    cmd: "git",
    args: [
      "rev-list",
      "--reverse",
      "--topo-order",
      `origin/${DEFAULT_BRANCH}..${hash}`,
    ],
    cwd: graph.path,
    capture: true,
    silent: true,
  }).catch(() => "");
  const commits = output.trim().split(/\s+/).filter(Boolean);
  const selectedIndex = commits.indexOf(hash);

  if (selectedIndex === -1) {
    return [];
  }

  return commits.slice(0, selectedIndex);
}

async function getRebaseCommitsForMode({
  graph,
  hash,
  mode,
  stackCommits,
  runCommand,
}) {
  if (mode === GRAPH_REBASE_MODE_SELECTED) {
    return [hash];
  }

  if (mode === GRAPH_REBASE_MODE_CHILDREN) {
    return stackCommits;
  }

  return [
    ...(await getWholeRebaseStackPrefix(graph, hash, runCommand)),
    ...stackCommits,
  ];
}

function uniqueCommits(commits = []) {
  return Array.from(new Set(commits.filter(Boolean)));
}

async function isCommitReachableFromMain(graph, hash, runCommand) {
  try {
    await runCommand({
      cmd: "git",
      args: ["merge-base", "--is-ancestor", hash, `origin/${DEFAULT_BRANCH}`],
      cwd: graph.path,
      silent: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function filterRebaseCommitsOnMain(graph, commits, runCommand) {
  const kept = [];
  const skipped = [];

  for (const hash of commits) {
    if (await isCommitReachableFromMain(graph, hash, runCommand)) {
      skipped.push(hash);
    } else {
      kept.push(hash);
    }
  }

  return { kept, skipped };
}

function isEmptyCherryPickError(error) {
  return /previous cherry-pick is now empty|nothing to commit|patch is empty/i.test(
    [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n"),
  );
}

function isCherryPickConflictError(error) {
  return /CONFLICT|fix conflicts|after resolving/i.test(
    [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n"),
  );
}

function getErrorOutput(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function abortGraphCherryPick(graph, runCommand) {
  await runCommand({
    cmd: "git",
    args: ["cherry-pick", "--abort"],
    cwd: graph.path,
    silent: true,
  }).catch(() => {});
}

async function resetGraphReplayState(graph, runCommand) {
  await abortGraphCherryPick(graph, runCommand);
  await runCommand({
    cmd: "git",
    args: ["reset", "--hard"],
    cwd: graph.path,
    silent: true,
  }).catch(() => {});
}

async function getGraphConflictFiles(graph, runCommand) {
  const output = await runCommand({
    cmd: "git",
    args: ["diff", "--name-only", "--diff-filter=U"],
    cwd: graph.path,
    capture: true,
    silent: true,
  }).catch(() => "");

  return output.trim().split(/\r?\n/).filter(Boolean);
}

async function getGraphConflictMarkerFiles(graph, files = []) {
  const markerFiles = [];
  const markerPattern = /^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/m;

  for (const file of files) {
    try {
      const content = await readFile(path.resolve(graph.path, file), "utf8");

      if (markerPattern.test(content)) {
        markerFiles.push(file);
      }
    } catch {
      // Deleted or binary conflict resolutions are handled by git's index state.
    }
  }

  return markerFiles;
}

function getConflictFileDetails(graph, files = []) {
  return files.map((file) => ({
    path: file,
    absolutePath: path.resolve(graph.path, file),
  }));
}

function createRebaseConflictError({
  session,
  conflictCommit,
  conflictIndex,
  conflictFiles,
  displayFiles = conflictFiles,
  markerFiles = [],
  cause,
  reason = "git-conflict",
}) {
  const error = new Error(
    `Rebase conflict while applying ${conflictCommit.slice(0, 12)}.`,
  );

  session.conflictCommit = conflictCommit;
  session.conflictIndex = conflictIndex;
  session.conflictFiles = conflictFiles;
  session.conflictReason = reason;
  error.statusCode = 409;
  error.rebaseState = session;
  error.rebaseConflict = {
    type: "conflict",
    reason,
    graphIndex: session.graphIndex,
    label: session.graph.label,
    path: session.graph.path,
    hash: session.hash,
    base: session.base.hash,
    branch: session.branch,
    mode: session.mode,
    conflictCommit,
    conflictIndex,
    totalCommits: session.stackCommits.length,
    files: getConflictFileDetails(session.graph, displayFiles),
    markerFiles: getConflictFileDetails(session.graph, markerFiles),
    message: error.message,
    output: getErrorOutput(cause),
    canContinue: true,
  };

  return error;
}

async function getRebaseStackBranches({
  graph,
  stackCommits,
  selectedHash = "",
  selectedCommitRefs = "",
  runCommand,
}) {
  const entries = [];

  for (const hash of stackCommits) {
    entries.push({
      hash,
      branches:
        hash === selectedHash
          ? parseBranchRefs(selectedCommitRefs)
          : parseBranchRefs(
              await getLocalBranchesAtCommit(graph, hash, runCommand),
            ),
    });
  }

  return entries;
}

function chooseRebaseResultBranch({
  stackBranchRefs = [],
  candidateBranch = "",
  currentBranch = "",
  preferredBranch = "",
}) {
  const lastBranches = stackBranchRefs.at(-1)?.branches || [];

  if (candidateBranch && lastBranches.includes(candidateBranch)) {
    return candidateBranch;
  }

  if (preferredBranch && lastBranches.includes(preferredBranch)) {
    return preferredBranch;
  }

  return chooseCheckoutBranch(lastBranches.join("\n"), currentBranch);
}

async function chooseSelectedRebaseResultBranch({
  graph,
  hash,
  branchRefs = "",
  currentBranch = "",
  preferredBranch = "",
  runCommand,
}) {
  const branch = chooseCheckoutBranch(branchRefs, preferredBranch || currentBranch);

  if (!branch) {
    return "";
  }

  const parents = await getCommitParents(graph, hash, runCommand);

  if (parents.length !== 1) {
    return branch;
  }

  return await isCommitReachableFromMain(graph, parents[0], runCommand)
    ? branch
    : "";
}

export async function getCurrentGraphBase(graph, runCommand) {
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

async function getCurrentGraphHeadHash(graph, runCommand) {
  const hash = await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  return hash.trim();
}

async function isCommitReachableFromCurrentHead(graph, hash, runCommand) {
  try {
    await runCommand({
      cmd: "git",
      args: ["merge-base", "--is-ancestor", hash, "HEAD"],
      cwd: graph.path,
      silent: true,
    });
    return true;
  } catch (error) {
    if (error?.code === 1) {
      return false;
    }
    throw error;
  }
}

async function getRefHash(graph, ref, runCommand) {
  const hash = await runCommand({
    cmd: "git",
    args: ["rev-parse", "--verify", ref],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  return hash.trim();
}

async function restoreGraphCheckout(graph, base, runCommand) {
  if (base.branch) {
    try {
      await runCommand({
        cmd: "git",
        args: ["switch", base.branch],
        cwd: graph.path,
        silent: true,
      });
      graph.branch = base.branch;
      return;
    } catch {
      // Fall through to the exact commit if the branch disappeared or is locked.
    }
  }

  await runCommand({
    cmd: "git",
    args: ["switch", "--detach", base.hash],
    cwd: graph.path,
    silent: true,
  }).catch(() => {});
  graph.branch = base.branch || "(detached)";
}

function normalizeGraphUpdateMode(mode = GRAPH_UPDATE_MODE_UPDATE) {
  const normalizedMode = String(mode || GRAPH_UPDATE_MODE_UPDATE).trim().toLowerCase();

  if (!GRAPH_UPDATE_MODES.has(normalizedMode)) {
    const error = new Error(`Unknown graph update mode: ${mode}`);
    error.statusCode = 400;
    throw error;
  }

  return normalizedMode;
}

function normalizeGraphDirtyAction(action = "") {
  const normalizedAction = String(action || "").trim().toLowerCase();

  if (!normalizedAction) {
    return "";
  }

  if (!GRAPH_UPDATE_DIRTY_ACTIONS.has(normalizedAction)) {
    const error = new Error(`Unknown dirty checkout action: ${action}`);
    error.statusCode = 400;
    throw error;
  }

  return normalizedAction;
}

async function getGraphDirtyStatus(graph, runCommand) {
  const status = await runCommand({
    cmd: "git",
    args: ["status", "--porcelain"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  return status.trim();
}

export async function getGraphDirtyCheckouts({
  graphs,
  runCommand = run,
}) {
  const dirty = [];

  for (const [index, graph] of graphs.entries()) {
    if (!graph) {
      continue;
    }

    const status = await getGraphDirtyStatus(graph, runCommand);

    if (status) {
      dirty.push({
        index,
        label: graph.label,
        path: graph.path,
        status,
      });
    }
  }

  return dirty;
}

async function amendGraphDirtyChanges(graph, runCommand) {
  await runCommand({
    cmd: "git",
    args: ["add", "-A"],
    cwd: graph.path,
    silent: true,
  });
  await runCommand({
    cmd: "git",
    args: ["commit", "--amend", "--no-edit"],
    cwd: graph.path,
    silent: true,
  });

  return {
    label: graph.label,
    path: graph.path,
    message: `${graph.label} amended uncommitted changes into the current commit.`,
  };
}

async function shelfGraphDirtyChanges(graph, runCommand) {
  const output = await runCommand({
    cmd: "git",
    args: ["stash", "push", "--include-untracked", "-m", `${GRAPH_SHELF_MESSAGE_PREFIX}: ${graph.label}`],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  if (/No local changes/i.test(output)) {
    return null;
  }

  return {
    label: graph.label,
    path: graph.path,
    stashRef: "stash@{0}",
    message: output.trim(),
  };
}

async function fetchGraphMain(graph, runCommand) {
  await runCommand({
    cmd: "git",
    args: ["fetch", "origin", DEFAULT_BRANCH],
    cwd: graph.path,
    silent: true,
  });
}

async function switchGraphToMain(graph, runCommand) {
  try {
    await runCommand({
      cmd: "git",
      args: ["switch", DEFAULT_BRANCH],
      cwd: graph.path,
      silent: true,
    });
  } catch {
    await runCommand({
      cmd: "git",
      args: ["switch", "-C", DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`],
      cwd: graph.path,
      silent: true,
    });
  }
}

async function fastForwardGraphMain(graph, runCommand) {
  await switchGraphToMain(graph, runCommand);
  await runCommand({
    cmd: "git",
    args: ["pull", "--ff-only", "origin", DEFAULT_BRANCH],
    cwd: graph.path,
    silent: true,
  });
}

async function getGraphRebaseWorkRef(graph, runCommand) {
  const branch = await getCurrentGraphBranch(graph, runCommand);

  if (!branch) {
    const currentHash = (await runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    })).trim();
    const containingBranchRefs = await getLocalBranchesContainingCommit(graph, currentHash, runCommand);
    const containingBranches = parseBranchRefs(containingBranchRefs);

    if (containingBranches.length === 1) {
      return {
        branch: containingBranches[0],
        ref: containingBranches[0],
      };
    }
  }

  return {
    branch,
    ref: branch || "HEAD",
  };
}

async function getGraphLocalCommitsOffMain(graph, ref, runCommand) {
  const output = await runCommand({
    cmd: "git",
    args: ["rev-list", "--reverse", "--topo-order", `origin/${DEFAULT_BRANCH}..${ref}`],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  return output.trim().split(/\s+/).filter(Boolean);
}

export async function updateGraphCheckout({
  graph,
  mode = GRAPH_UPDATE_MODE_UPDATE,
  runCommand = run,
}) {
  if (!graph) {
    const error = new Error("Unknown graph checkout.");
    error.statusCode = 404;
    throw error;
  }

  const updateMode = normalizeGraphUpdateMode(mode);

  await fetchGraphMain(graph, runCommand);

  if (updateMode === GRAPH_UPDATE_MODE_REBASE) {
    const workRef = await getGraphRebaseWorkRef(graph, runCommand);
    const localCommits = await getGraphLocalCommitsOffMain(graph, workRef.ref, runCommand);

    if (localCommits.length) {
      const rebaseArgs = workRef.branch
        ? ["rebase", "--update-refs", `origin/${DEFAULT_BRANCH}`, workRef.branch]
        : ["rebase", "--update-refs", `origin/${DEFAULT_BRANCH}`];

      await runCommand({
        cmd: "git",
        args: rebaseArgs,
        cwd: graph.path,
        silent: true,
      });

      const base = await getCurrentGraphBase(graph, runCommand);
      graph.branch = base.branch || "(detached)";

      return {
        action: "update-rebase",
        mode: updateMode,
        label: graph.label,
        path: graph.path,
        branch: graph.branch,
        currentHash: base.hash,
        commits: localCommits,
        rebasedCount: localCommits.length,
        message: `${graph.label} fetched origin/${DEFAULT_BRANCH} and rebased ${localCommits.length} local commit${localCommits.length === 1 ? "" : "s"}.`,
      };
    }
  }

  await fastForwardGraphMain(graph, runCommand);

  const base = await getCurrentGraphBase(graph, runCommand);
  graph.branch = base.branch || "(detached)";

  return {
    action: "update",
    mode: updateMode,
    label: graph.label,
    path: graph.path,
    branch: graph.branch,
    currentHash: base.hash,
    rebasedCount: 0,
    commits: [],
    message: `${graph.label} updated ${DEFAULT_BRANCH} from origin/${DEFAULT_BRANCH}.`,
  };
}

export async function unshelfGraphChanges({
  graph,
  stashRef = "stash@{0}",
  runCommand = run,
}) {
  if (!graph) {
    const error = new Error("Unknown graph checkout.");
    error.statusCode = 404;
    throw error;
  }

  await runCommand({
    cmd: "git",
    args: ["stash", "pop", stashRef],
    cwd: graph.path,
    silent: true,
  });

  return {
    label: graph.label,
    path: graph.path,
    stashRef,
    message: `${graph.label} unshelved ${stashRef}.`,
  };
}

export async function unshelfGraphShelves({
  graphs,
  shelves = [],
  runCommand = run,
}) {
  const results = [];
  const { session: outputSession, runCommand: runCommandWithOutput } =
    createGraphCommandOutputRecorder(runCommand);

  try {
    for (const shelf of shelves) {
      const graph = graphs[Number(shelf.graphIndex)];

      results.push(await unshelfGraphChanges({
        graph,
        stashRef: shelf.stashRef || "stash@{0}",
        runCommand: runCommandWithOutput,
      }));
    }

    return {
      action: "unshelf",
      shelves: results,
      output: outputSession.output || "",
      message: results.length
        ? `Unshelved ${results.length} checkout${results.length === 1 ? "" : "s"}.`
        : "No shelved changes to unshelve.",
    };
  } catch (error) {
    error.output = outputSession.output || "";
    throw error;
  }
}

function createGraphCommandOutputRecorder(runCommand = run) {
  const session = { output: "" };

  return {
    session,
    async runCommand(command) {
      appendSubmitOutput(session, `$ ${formatCommandForOutput(command)}\n`);

      try {
        const output = await runCommand(command);

        appendSubmitOutput(session, output);
        return output;
      } catch (error) {
        appendSubmitOutput(session, error.stdout || "");
        appendSubmitOutput(session, error.stderr || "");

        if (!error.stdout && !error.stderr && error.message) {
          appendSubmitOutput(session, `${error.message}\n`);
        }

        throw error;
      }
    },
  };
}

export async function runGraphRepositoryUpdate({
  graphs,
  mode = GRAPH_UPDATE_MODE_UPDATE,
  dirtyAction = "",
  runCommand = run,
}) {
  const { session: outputSession, runCommand: runCommandWithOutput } =
    createGraphCommandOutputRecorder(runCommand);
  try {
    const updateMode = normalizeGraphUpdateMode(mode);
    const normalizedDirtyAction = normalizeGraphDirtyAction(dirtyAction);
    const dirty = await getGraphDirtyCheckouts({
      graphs,
      runCommand: runCommandWithOutput,
    });
    const shelves = [];
    const dirtyResults = [];

    if (dirty.length && !normalizedDirtyAction) {
      const error = new Error(`Uncommitted changes found in ${dirty.map((item) => item.label).join(", ")}.`);
      error.statusCode = 409;
      error.dirty = dirty;
      error.output = outputSession.output || "";
      throw error;
    }

    for (const item of dirty) {
      const graph = graphs[item.index];

      if (normalizedDirtyAction === "amend") {
        dirtyResults.push(await amendGraphDirtyChanges(graph, runCommandWithOutput));
      } else if (normalizedDirtyAction === "shelf") {
        const shelf = await shelfGraphDirtyChanges(graph, runCommandWithOutput);

        if (shelf) {
          shelves.push({
            graphIndex: item.index,
            ...shelf,
          });
          dirtyResults.push({
            label: graph.label,
            path: graph.path,
            message: `${graph.label} shelved uncommitted changes.`,
          });
        }
      }
    }

    const results = [];

    for (const graph of graphs) {
      results.push(await updateGraphCheckout({
        graph,
        mode: updateMode,
        runCommand: runCommandWithOutput,
      }));
    }

    return {
      action: "update-graphs",
      mode: updateMode,
      dirtyAction: normalizedDirtyAction,
      dirty,
      dirtyResults,
      shelves,
      results,
      output: outputSession.output || "",
      message: results.map((result) => result.message).join(" "),
    };
  } catch (error) {
    error.output = error.output || outputSession.output || "";
    throw error;
  }
}

function parseLsRemoteHash(output = "") {
  const line = String(output).trim().split(/\r?\n/).find(Boolean) || "";
  const hash = line.split(/\s+/)[0] || "";

  return /^[0-9a-f]{7,64}$/i.test(hash) ? hash : "";
}

export async function getGraphOriginMainStatus({
  graph,
  runCommand = run,
}) {
  if (!graph) {
    const error = new Error("Unknown graph checkout.");
    error.statusCode = 404;
    throw error;
  }

  const localHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "--verify", `refs/remotes/origin/${DEFAULT_BRANCH}`],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();
  const remoteHash = parseLsRemoteHash(await runCommand({
    cmd: "git",
    args: ["ls-remote", "--heads", "origin", DEFAULT_BRANCH],
    cwd: graph.path,
    capture: true,
    silent: true,
  }));

  if (!remoteHash) {
    throw new Error(`Remote origin/${DEFAULT_BRANCH} was not found.`);
  }

  const upToDate = localHash === remoteHash;

  return {
    label: graph.label,
    path: graph.path,
    branch: DEFAULT_BRANCH,
    state: upToDate ? "current" : "stale",
    upToDate,
    localHash,
    remoteHash,
    message: upToDate
      ? `origin/${DEFAULT_BRANCH} is up to date.`
      : `origin/${DEFAULT_BRANCH} differs from remote.`,
  };
}

function getGraphByLabel(graphs = [], label) {
  return graphs.find((graph) => String(graph?.label || "").toLowerCase() === label) || null;
}

function getSha512(value = "") {
  return createHash("sha512").update(String(value), "utf8").digest("hex");
}

function parseRustChecksumFile(value = "") {
  const parsed = JSON.parse(value || "{}");

  return Object.fromEntries(Object.keys(RUST_UPSTREAM_FILES).map((key) => [key, String(parsed[key] || "")]));
}

function getRustMismatchDetails(expectedChecksums, actualChecksums) {
  return Object.entries(RUST_UPSTREAM_FILES)
    .filter(([key]) => expectedChecksums[key] !== actualChecksums[key])
    .map(([key, file]) => ({
      key,
      file,
      expected: expectedChecksums[key] || "",
      actual: actualChecksums[key] || "",
    }));
}

async function getOptionalGitRefHash({ cwd, ref, runCommand = run }) {
  try {
    return (await runCommand({
      cmd: "git",
      args: ["rev-parse", "--verify", ref],
      cwd,
      capture: true,
      silent: true,
    })).trim();
  } catch {
    return "";
  }
}

async function getRustFileChecksumsFromRef({ cwd, ref, runCommand = run }) {
  const entries = await Promise.all(Object.entries(RUST_UPSTREAM_FILES).map(async ([key, file]) => {
    const content = await runCommand({
      cmd: "git",
      args: ["show", `${ref}:${file}`],
      cwd,
      capture: true,
      silent: true,
    });

    return [key, getSha512(content)];
  }));

  return Object.fromEntries(entries);
}

export async function getGraphRustUpstreamStatus({
  graphs,
  commGraph = getGraphByLabel(graphs, "comm"),
  firefoxGraph = getGraphByLabel(graphs, "firefox"),
  runCommand = run,
  makeTempDir = mkdtemp,
  removeDir = rm,
}) {
  if (!commGraph || !firefoxGraph) {
    const error = new Error("Rust dependency status requires both comm and Firefox checkouts.");
    error.statusCode = 404;
    throw error;
  }

  const commLocalHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "--verify", `refs/remotes/origin/${DEFAULT_BRANCH}`],
    cwd: commGraph.path,
    capture: true,
    silent: true,
  })).trim();
  const checksumData = parseRustChecksumFile(await runCommand({
    cmd: "git",
    args: ["show", `refs/remotes/origin/${DEFAULT_BRANCH}:${RUST_UPSTREAM_CHECKSUMS_PATH}`],
    cwd: commGraph.path,
    capture: true,
    silent: true,
  }));
  const firefoxRemoteHash = parseLsRemoteHash(await runCommand({
    cmd: "git",
    args: ["ls-remote", "--heads", "origin", DEFAULT_BRANCH],
    cwd: firefoxGraph.path,
    capture: true,
    silent: true,
  }));

  if (!firefoxRemoteHash) {
    throw new Error(`Firefox remote origin/${DEFAULT_BRANCH} was not found.`);
  }

  const firefoxLocalHash = await getOptionalGitRefHash({
    cwd: firefoxGraph.path,
    ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
    runCommand,
  });
  let actualChecksums;

  if (firefoxLocalHash === firefoxRemoteHash) {
    actualChecksums = await getRustFileChecksumsFromRef({
      cwd: firefoxGraph.path,
      ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      runCommand,
    });
  } else {
    const firefoxRemoteUrl = (await runCommand({
      cmd: "git",
      args: ["remote", "get-url", "origin"],
      cwd: firefoxGraph.path,
      capture: true,
      silent: true,
    })).trim();
    const tempDir = await makeTempDir(path.join(os.tmpdir(), "tb-tools-rust-upstream-"));

    try {
      await runCommand({
        cmd: "git",
        args: ["init"],
        cwd: tempDir,
        capture: true,
        silent: true,
      });
      await runCommand({
        cmd: "git",
        args: ["fetch", "--depth=1", "--no-tags", firefoxRemoteUrl, firefoxRemoteHash],
        cwd: tempDir,
        capture: true,
        silent: true,
      });

      actualChecksums = await getRustFileChecksumsFromRef({
        cwd: tempDir,
        ref: "FETCH_HEAD",
        runCommand,
      });
    } finally {
      await removeDir(tempDir, { recursive: true, force: true });
    }
  }

  const mismatches = getRustMismatchDetails(checksumData, actualChecksums);
  const upToDate = mismatches.length === 0;

  return {
    type: "rust-upstream",
    label: "rust",
    state: upToDate ? "current" : "warning",
    upToDate,
    commLocalHash,
    firefoxRemoteHash,
    mismatches,
    message: upToDate
      ? "Rust dependencies match Firefox remote main."
      : "Rust dependencies are out of sync with Firefox remote main. Remote builds may fail.",
  };
}

function getFirstBugFromResponse(response, bugId) {
  if (Array.isArray(response?.bugs)) {
    return response.bugs.find((bug) => String(bug.id) === String(bugId)) || response.bugs[0] || null;
  }

  if (response?.id) {
    return response;
  }

  return null;
}

function normalizeBugStatus(response, bugId) {
  const bug = getFirstBugFromResponse(response, bugId);

  if (!bug) {
    return {
      id: bugId,
      url: getBugUrl(bugId),
      error: "Bug not found.",
    };
  }

  const keywords = Array.isArray(bug.keywords) ? bug.keywords : [];

  return {
    id: String(bug.id || bugId),
    url: getBugUrl(bug.id || bugId),
    status: bug.status || "",
    resolution: bug.resolution || "",
    summary: bug.summary || "",
    assignedTo: bug.assigned_to || "",
    isOpen: typeof bug.is_open === "boolean" ? bug.is_open : undefined,
    keywords,
    hasCheckinNeeded: keywords.includes(CHECKIN_NEEDED_KEYWORD),
  };
}

function normalizePhabricatorStatus(response, revision) {
  const id = revision.replace(/^D/i, "");
  const item = Array.isArray(response?.result)
    ? response.result.find((revisionItem) => String(revisionItem.id) === String(id)) || response.result[0]
    : response?.result || response;

  if (!item) {
    return {
      revision,
      url: getPhabUrl(revision),
      error: "Revision not found.",
    };
  }

  return {
    revision: `D${item.id || id}`,
    url: item.uri || getPhabUrl(`D${item.id || id}`),
    status: item.status || "",
    statusName: item.statusName || item.fields?.status?.name || "",
    title: item.title || item.fields?.title || "",
  };
}

function isAcceptedPhabricatorStatus(phabricator) {
  if (!phabricator || phabricator.error) {
    return false;
  }

  const status = `${phabricator.statusName || ""} ${phabricator.status || ""}`.toLowerCase();

  return /\baccepted\b/.test(status) || /status-accepted/.test(status);
}

function getGraphCommitIntegrationHaystack({ graph, hash, message }) {
  const commit = (graph.commits || []).find((item) => (
    item.hash === hash ||
    (hash === "HEAD" && isCheckedOutCommit(item)) ||
    (isWorkingTreeCommitHash(hash) && isWorkingTreeCommitHash(item.hash))
  ));

  return [
    message,
    commit?.subject,
    ...(commit?.refs || []),
  ].filter(Boolean).join("\n");
}

async function getBugzillaStatus({
  bugId,
  getBug = defaultGetBug,
}) {
  if (!bugId) {
    return null;
  }

  try {
    return normalizeBugStatus(await getBug(bugId), bugId);
  } catch (error) {
    return {
      id: bugId,
      url: getBugUrl(bugId),
      error: String(error?.message || error),
    };
  }
}

async function getPhabricatorStatus({
  revision,
  phab = defaultPhab,
}) {
  if (!revision) {
    return null;
  }

  const id = revision.replace(/^D/i, "");

  try {
    return normalizePhabricatorStatus(await phab({
      route: "differential.query",
      params: { ids: [Number(id)] },
    }), revision);
  } catch (error) {
    return {
      revision,
      url: getPhabUrl(revision),
      error: String(error?.message || error),
    };
  }
}

export async function getGraphCommitIntegrationStatus({
  graph,
  hash,
  runCommand = run,
  getBug = defaultGetBug,
  phab = defaultPhab,
}) {
  if (!graph) {
    const error = new Error("Unknown graph checkout.");
    error.statusCode = 404;
    throw error;
  }

  const message = await getGraphCommitMessage({
    graph,
    hash,
    runCommand,
  });
  const subject = getCommitSubjectFromMessage(message, hash);
  const haystack = getGraphCommitIntegrationHaystack({ graph, hash, message });
  let bugId = getBugIdFromText(haystack);
  const phabRevision = getPhabRevisionFromText(haystack);
  const [bug, phabricator] = await Promise.all([
    getBugzillaStatus({ bugId, getBug }),
    getPhabricatorStatus({ revision: phabRevision, phab }),
  ]);
  const tryRuns = await getGraphTryRunsForCommit({
    graph,
    commit: { hash, subject },
    runCommand,
  });
  let effectiveBug = bug;

  if (!bugId && phabricator && !phabricator.error) {
    bugId = getBugIdFromText(phabricator.title);
    effectiveBug = await getBugzillaStatus({ bugId, getBug });
  }

  return {
    bugId,
    phabRevision,
    bug: effectiveBug,
    phabricator,
    tryRuns,
  };
}

export async function markGraphBugForCheckin({
  graph,
  hash,
  bugId,
  runCommand = run,
  getBug = defaultGetBug,
  updateBug = defaultUpdateBug,
  phab = defaultPhab,
}) {
  const before = await getGraphCommitIntegrationStatus({
    graph,
    hash,
    runCommand,
    getBug,
    phab,
  });
  const targetBugId = String(bugId || before.bugId || before.bug?.id || "").trim();

  if (!targetBugId) {
    const error = new Error("No Bugzilla bug detected for this commit.");
    error.statusCode = 400;
    throw error;
  }

  if (!isAcceptedPhabricatorStatus(before.phabricator)) {
    const error = new Error("Only accepted Phabricator patches can be marked for checkin.");
    error.statusCode = 409;
    throw error;
  }

  if (!before.bug?.hasCheckinNeeded) {
    await updateBug(targetBugId, {
      keywords: {
        add: [CHECKIN_NEEDED_KEYWORD],
      },
    });
  }

  const integration = before.bug?.hasCheckinNeeded
    ? before
    : await getGraphCommitIntegrationStatus({
      graph,
      hash,
      runCommand,
      getBug,
      phab,
    });

  if (integration.bug && String(integration.bug.id) === targetBugId) {
    integration.bug.keywords = Array.from(new Set([
      ...(integration.bug.keywords || []),
      CHECKIN_NEEDED_KEYWORD,
    ]));
    integration.bug.hasCheckinNeeded = true;
  }

  return {
    ...integration,
    message: before.bug?.hasCheckinNeeded
      ? `Bug ${targetBugId} already has ${CHECKIN_NEEDED_KEYWORD}.`
      : `Bug ${targetBugId} marked for checkin.`,
  };
}

function parseGraphStatusFile(line) {
  if (!line) {
    return "";
  }

  const file = line.substring(3);
  return file.includes(" -> ") ? file.split(" -> ").pop() : file;
}

export async function getGraphChangedFilePaths({
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

export async function runGraphMach({
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

export async function runGraphLint({
  graph,
  session,
  all = false,
  runCommand = run,
}) {
  const targets = all
    ? LINT_DIRS
    : await getDefaultLintFiles({
      cwd: graph.path,
      runGit: (args, cwd, silent) => runCommand({
        cmd: "git",
        args,
        cwd,
        capture: true,
        silent,
      }),
    });

  if (!targets.length) {
    appendSubmitOutput(session, "No files to lint.\n");
    return;
  }

  await runGraphMach({
    graph,
    args: ["commlint", ...targets, "--fix"],
    session,
    runCommand,
  });
}

function normalizeGraphLintMode(mode = "outgoing") {
  const normalizedMode = String(mode || "outgoing").trim().toLowerCase();

  if (normalizedMode === "all" || normalizedMode === "outgoing") {
    return normalizedMode;
  }

  const error = new Error(`Unknown graph lint mode: ${mode}`);
  error.statusCode = 400;
  throw error;
}

function getGraphLintModeLabel(mode) {
  return mode === "all" ? "Lint all" : "Lint changed files";
}

export function createGraphLintSession({
  graph,
  graphIndex,
  mode = "outgoing",
  runCommand = run,
}) {
  const normalizedMode = normalizeGraphLintMode(mode);
  const session = {
    id: randomUUID(),
    graphIndex,
    mode: normalizedMode,
    label: graph.label,
    path: graph.path,
    status: "running",
    message: `${getGraphLintModeLabel(normalizedMode)} starting...`,
    output: "",
    error: "",
  };

  queueMicrotask(async () => {
    try {
      await runGraphLint({
        graph,
        session,
        all: normalizedMode === "all",
        runCommand,
      });
      session.status = "complete";
      session.message = `${getGraphLintModeLabel(normalizedMode)} complete.`;
    } catch (error) {
      session.status = "error";
      session.error = String(error?.message || error);
      session.message = session.error;
    }
  });

  return session;
}

export function serializeGraphLintSession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    mode: session.mode,
    label: session.label,
    path: session.path,
    status: session.status,
    message: session.message,
    output: session.output || "",
    error: session.error,
  };
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

function getCommitSubjectFromMessage(message = "", fallback = "") {
  return String(message || "").split("\n").find((line) => line.trim())?.trim() || fallback;
}

async function ensureCurrentGraphCommitTbToolsId({
  graph,
  current,
  message,
  runCommand = run,
  writeMessage = writeFile,
  removeMessage = unlink,
}) {
  const ensured = ensureTbToolsIdInCommitMessage(message);

  if (!ensured.added) {
    return {
      hash: current.hash,
      message: ensured.message,
      tbToolsId: ensured.id,
    };
  }

  const messagePath = path.join(os.tmpdir(), `tb-tools-id-${randomUUID()}.txt`);
  await writeMessage(
    messagePath,
    ensured.message.endsWith("\n") ? ensured.message : `${ensured.message}\n`,
  );

  try {
    await runCommand({
      cmd: "git",
      args: getGitAmendArgs(messagePath, { includeChanges: false }),
      cwd: graph.path,
      silent: true,
    });
  } finally {
    await removeMessage(messagePath).catch(() => {});
  }

  const hash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();
  const amendedMessage = await getGraphCommitMessage({
    graph,
    hash,
    runCommand,
  });

  ensureAmendedCommitMessage(amendedMessage, ensured.message, hash);

  return {
    hash,
    originalHash: current.hash === hash ? "" : current.hash,
    message: amendedMessage,
    tbToolsId: ensured.id,
  };
}

function shouldBackfillRebaseTryRunIds(graph, runCommand) {
  return runCommand === run || graph?.backfillTryRunIds;
}

async function getRebaseTryRunIdentityByHash({
  graph,
  stackCommits = [],
  runCommand = run,
}) {
  const identities = new Map();

  if (!shouldBackfillRebaseTryRunIds(graph, runCommand)) {
    return identities;
  }

  const store = await readGraphTryStore({ graph, runCommand }).catch(() => null);

  if (!store?.runs?.length) {
    return identities;
  }

  for (const commit of stackCommits) {
    const message = await getGraphCommitMessage({
      graph,
      hash: commit,
      runCommand,
    }).catch(() => "");

    if (!message || getTbToolsIdFromCommitMessage(message)) {
      continue;
    }

    const subject = getCommitSubjectFromMessage(message, commit);
    const tryRuns = await getGraphTryRunsForCommit({
      graph,
      commit: { hash: commit, subject },
      store,
      runCommand,
    }).catch(() => []);
    const tbToolsId = tryRuns.find((tryRun) => tryRun.tbToolsId)?.tbToolsId || "";

    if (!tbToolsId) {
      continue;
    }

    identities.set(commit, {
      message: ensureTbToolsIdInCommitMessage(message, tbToolsId).message,
      tbToolsId,
    });
  }

  return identities;
}

async function amendReplayedCommitTryRunIdentity({
  session,
  commit,
  runCommand = run,
}) {
  const identity = session.tryRunIdentityByHash?.get(commit);

  if (!identity?.message) {
    return getCurrentGraphHeadHash(session.graph, runCommand);
  }

  const messagePath = path.join(os.tmpdir(), `tb-tools-rebase-id-${randomUUID()}.txt`);
  await writeFile(
    messagePath,
    identity.message.endsWith("\n") ? identity.message : `${identity.message}\n`,
  );

  try {
    await runCommand({
      cmd: "git",
      args: getGitAmendArgs(messagePath, { includeChanges: false }),
      cwd: session.graph.path,
      silent: true,
    });
  } finally {
    await unlink(messagePath).catch(() => {});
  }

  const hash = await getCurrentGraphHeadHash(session.graph, runCommand);
  const amendedMessage = await getGraphCommitMessage({
    graph: session.graph,
    hash,
    runCommand,
  });

  ensureAmendedCommitMessage(amendedMessage, identity.message, hash);

  return hash;
}

export function normalizeGraphTryOptions(options = {}) {
  const selector = String(options.selector || (options.query ? "fuzzy" : "auto")).trim().toLowerCase();
  const normalized = {
    selector: ["auto", "fuzzy", "empty", "chooser"].includes(selector) ? selector : "auto",
    artifact: options.artifact === false || options.artifact === "false" ? false : true,
    comment: Boolean(options.comment),
  };
  const query = String(options.query || "").trim();
  const tasksRegex = String(options["tasks-regex"] || options.tasksRegex || "").trim();
  const preset = String(options.preset || "").trim();

  if (query) {
    normalized.query = query;
  }

  if (tasksRegex) {
    normalized["tasks-regex"] = tasksRegex;
  }

  if (preset) {
    normalized.preset = preset;
  }

  return normalized;
}

export async function getGraphTryTarget({
  graph,
  runCommand = run,
}) {
  const current = await getCurrentGraphBase(graph, runCommand);
  const diff = await getRawWorkingTreeDiff({
    cwd: graph.path,
    runCommand,
  });

  if (diff.trim()) {
    const changeId = getContentHash(diff);

    return {
      hash: WORKING_TREE_CHANGES_HASH,
      patchId: getWorkingTreeTryPatchId(changeId),
      subject: `Uncommitted changes on ${current.hash.slice(0, 12)}`,
      changeId,
    };
  }

  const message = await getGraphCommitMessage({
    graph,
    hash: current.hash,
    runCommand,
  });
  const commitWithId = await ensureCurrentGraphCommitTbToolsId({
    graph,
    current,
    message,
    runCommand,
  });
  const patchId = await getGraphCommitPatchId({
    graph,
    hash: commitWithId.hash,
    runCommand,
  });
  const subject = getCommitSubjectFromMessage(commitWithId.message, commitWithId.hash);

  return {
    hash: commitWithId.hash,
    originalHash: commitWithId.originalHash,
    patchId,
    tbToolsId: commitWithId.tbToolsId,
    subject,
  };
}

export async function runGraphTrySubmission({
  graph,
  session,
  options = {},
  runCommand = run,
  postComment = defaultComment,
}) {
  const normalizedOptions = normalizeGraphTryOptions(options);
  const target = await getGraphTryTarget({
    graph,
    runCommand,
  });
  const tryCommand = createTryCommand({
    runCommand: withGraphSubmitCwd(graph, session, runCommand),
    postComment,
  });
  const tryUrl = await tryCommand(normalizedOptions);

  if (!tryUrl) {
    throw new Error("Could not find a try URL in mach try output.");
  }

  const tryRun = await recordGraphTryRun({
    graph,
    tryRun: {
      ...target,
      id: randomUUID(),
      url: tryUrl,
      createdAt: new Date().toISOString(),
      label: graph.label,
    },
    runCommand,
  });

  return {
    tryUrl,
    tryRun,
    target,
    options: normalizedOptions,
  };
}

function createGraphRecordedTryCommand({
  graph,
  session,
  runCommand = run,
  postComment = defaultComment,
}) {
  return async (options = {}) => {
    const result = await runGraphTrySubmission({
      graph,
      session,
      options,
      runCommand,
      postComment,
    });

    return result.tryUrl;
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
    const previousCancelCurrentCommand = session.cancelCurrentCommand;

    session.cancelCurrentCommand = () => {
      child.kill("SIGTERM");
    };

    function clearCurrentCommand() {
      if (session.cancelCurrentCommand) {
        session.cancelCurrentCommand = previousCancelCurrentCommand;
      }
    }

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
    child.on("error", (error) => {
      clearCurrentCommand();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearCurrentCommand();
      promptPromise.then(() => {
        const stdoutText = Buffer.concat(stdout).toString();
        const stderrText = Buffer.concat(stderr).toString();

        if (code > 0 || signal) {
          const error = new Error(stderrText || `${command.cmd} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`);
          error.code = code;
          error.signal = signal;
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

export function serializeSubmitSession(session) {
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
  const tryCommand = createGraphRecordedTryCommand({
    graph,
    session,
    runCommand,
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

export function createGraphSubmitSession({
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

export function createGraphTrySession({
  graph,
  graphIndex,
  snapshotLimit,
  getSnapshot,
  options = {},
  runCommand = run,
  postComment = defaultComment,
}) {
  const session = {
    id: randomUUID(),
    graphIndex,
    label: graph.label,
    path: graph.path,
    status: "running",
    message: "Starting try run...",
    output: "",
    error: "",
    result: null,
    tryRun: null,
    snapshot: null,
  };

  queueMicrotask(async () => {
    try {
      const result = await runGraphTrySubmission({
        graph,
        session,
        options,
        runCommand,
        postComment,
      });

      session.result = result;
      session.tryRun = result.tryRun;
      session.snapshot = await getSnapshot(graph, snapshotLimit);
      session.status = "complete";
      session.message = "Try run submitted.";
    } catch (error) {
      session.status = "error";
      session.error = String(error?.message || error);
      session.message = session.error;
    }
  });

  return session;
}

export function serializeGraphTrySession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    label: session.label,
    path: session.path,
    status: session.status,
    message: session.message,
    output: session.output || "",
    error: session.error,
    result: session.result,
    tryRun: session.tryRun,
    snapshot: session.snapshot,
    links: session.tryRun
      ? [{ label: "Try", url: session.tryRun.url }]
      : [],
  };
}

function normalizeGraphMachAction(action = "") {
  const normalizedAction = String(action || "").trim().toLowerCase();

  if (!GRAPH_MACH_ACTIONS.has(normalizedAction)) {
    const error = new Error(`Unknown graph mach action: ${action}`);
    error.statusCode = 400;
    throw error;
  }

  return normalizedAction;
}

function getGraphMachActionLabel(action) {
  switch (action) {
    case GRAPH_MACH_ACTION_BUILD:
      return "Build";
    case GRAPH_MACH_ACTION_RUN:
      return "Run";
    case GRAPH_MACH_ACTION_BUILD_RUN:
      return "Build and run";
    default:
      return "Mach action";
  }
}

export function chooseGraphMachCheckout(graphs = []) {
  const entries = graphs
    .map((graph, index) => ({ graph, index }))
    .filter(({ graph }) => graph && !graph.error);
  const selected = entries.find(({ graph }) => graph.label === "comm") ||
    entries.find(({ graph }) => path.basename(graph.path || "") === "comm");

  if (!selected) {
    const error = new Error("Build, run, and try require the comm checkout tab.");
    error.statusCode = 409;
    throw error;
  }

  return selected;
}

function getGraphMachCommand(graph, args) {
  return {
    cmd: path.join("..", "mach"),
    args: Array.isArray(args) ? args : String(args).split(/\s+/).filter(Boolean),
    cwd: graph.path,
    capture: true,
  };
}

function appendGraphMachOutput(session, output = "") {
  appendSubmitOutput(session, output);
}

function isGraphMachRunAction(action) {
  return action === GRAPH_MACH_ACTION_RUN || action === GRAPH_MACH_ACTION_BUILD_RUN;
}

function runInjectedGraphMachCommand({ command, session, runCommand }) {
  appendGraphMachOutput(session, `$ ${formatCommandForOutput(command)}\n`);

  return runCommand(command).then((output) => {
    appendGraphMachOutput(session, output);
    return output;
  }, (error) => {
    appendGraphMachOutput(session, error.stdout || "");
    appendGraphMachOutput(session, error.stderr || "");
    throw error;
  });
}

function finishCanceledGraphMachSession(session) {
  const wasRunning = session.phase === "running";
  session.status = "canceled";
  session.phase = "";
  session.child = null;
  session.childPid = null;
  session.message = wasRunning ? "Run closed." : "Build canceled.";
}

function signalGraphMachProcessGroup(pid, signal = "SIGTERM") {
  if (!pid || process.platform === "win32") {
    return false;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (signal === 0 && error?.code === "EPERM") {
      return true;
    }

    return false;
  }
}

function isGraphMachProcessGroupAlive(pid) {
  return signalGraphMachProcessGroup(pid, 0);
}

function terminateGraphMachChild(session, signal = "SIGTERM") {
  const child = session.child;
  const pid = session.childPid || child?.pid;

  if (signalGraphMachProcessGroup(pid, signal)) {
    return true;
  }

  if (child && typeof child.kill === "function") {
    child.kill(signal);
    return true;
  }

  return false;
}

function scheduleGraphMachForceKill(session) {
  const child = session.child;
  const pid = session.childPid || child?.pid;

  if (!child && !pid) {
    return;
  }

  const timer = setTimeout(() => {
    if (!session.cancelRequested) {
      return;
    }

    if (pid) {
      signalGraphMachProcessGroup(pid, "SIGKILL");
    }

    if (child && session.child === child && typeof child.kill === "function") {
      child.kill("SIGKILL");
    }
  }, 5000);

  timer.unref?.();
  session.forceKillTimer = timer;
}

function runInteractiveGraphMachCommand({
  command,
  session,
  spawnCommand = spawn,
}) {
  appendGraphMachOutput(session, `$ ${formatCommandForOutput(command)}\n`);

  return new Promise((resolve, reject) => {
    const child = spawnCommand(command.cmd, command.args || [], {
      cwd: command.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];

    session.child = child;
    session.childPid = child.pid || null;

    function handleOutput(chunk, target) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      target.push(Buffer.from(text));
      appendGraphMachOutput(session, text);
    }

    child.stdout.on("data", (chunk) => handleOutput(chunk, stdout));
    child.stderr.on("data", (chunk) => handleOutput(chunk, stderr));
    child.on("error", (error) => {
      session.child = null;
      session.childPid = null;
      reject(error);
    });
    child.on("exit", (code, signal) => {
      const childPid = session.childPid || child.pid || null;
      if (session.forceKillTimer) {
        clearTimeout(session.forceKillTimer);
        session.forceKillTimer = null;
      }
      session.child = null;

      if (session.cancelRequested) {
        session.childPid = null;
        resolve("");
        return;
      }

      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();

      if (code > 0 || signal) {
        session.childPid = null;
        const error = new Error(stderrText || `${command.cmd} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`);
        error.code = code;
        error.stdout = stdoutText;
        error.stderr = stderrText;
        reject(error);
        return;
      }

      if (session.phase === "running" && isGraphMachProcessGroupAlive(childPid)) {
        session.childPid = childPid;
      } else {
        session.childPid = null;
      }

      resolve(stdoutText);
    });
  });
}

function isGraphMachDetachedRunAlive(session) {
  return Boolean(
    session.phase === "running" &&
    session.childPid &&
    isGraphMachProcessGroupAlive(session.childPid)
  );
}

function refreshGraphMachDetachedRunSession(session) {
  if (
    session.status !== "running" ||
    session.phase !== "running" ||
    session.child ||
    !session.childPid
  ) {
    return;
  }

  if (isGraphMachProcessGroupAlive(session.childPid)) {
    return;
  }

  session.status = "complete";
  session.phase = "";
  session.childPid = null;
  session.message = "Run finished.";
}

async function runGraphMachActionCommand({
  graph,
  args,
  session,
  runCommand = run,
}) {
  const command = getGraphMachCommand(graph, args);

  return runCommand === run
    ? runInteractiveGraphMachCommand({ command, session })
    : runInjectedGraphMachCommand({ command, session, runCommand });
}

export async function runGraphMachActionSession({
  graph,
  action,
  session,
  runCommand = run,
}) {
  const shouldBuild = action === GRAPH_MACH_ACTION_BUILD ||
    action === GRAPH_MACH_ACTION_RUN ||
    action === GRAPH_MACH_ACTION_BUILD_RUN;
  const shouldRun = isGraphMachRunAction(action);

  if (shouldBuild) {
    session.phase = "building";
    session.message = "Building...";
    await runGraphMachActionCommand({
      graph,
      args: ["build"],
      session,
      runCommand,
    });

    if (session.cancelRequested) {
      finishCanceledGraphMachSession(session);
      return;
    }
  }

  if (shouldRun) {
    session.phase = "running";
    session.message = "Running Thunderbird...";
    await runGraphMachActionCommand({
      graph,
      args: ["run"],
      session,
      runCommand,
    });

    if (session.cancelRequested) {
      finishCanceledGraphMachSession(session);
      return;
    }

    if (isGraphMachDetachedRunAlive(session)) {
      session.status = "running";
      session.phase = "running";
      session.message = "Thunderbird running.";
      return;
    }
  }

  session.status = "complete";
  session.phase = "";
  session.message = shouldRun
    ? action === GRAPH_MACH_ACTION_BUILD_RUN
      ? "Build and run finished."
      : "Run finished."
    : "Build complete.";
}

export function createGraphMachSession({
  graph,
  graphIndex,
  action,
  runCommand = run,
}) {
  const normalizedAction = normalizeGraphMachAction(action);
  const session = {
    id: randomUUID(),
    graphIndex,
    action: normalizedAction,
    label: graph.label,
    path: graph.path,
    status: "running",
    phase: "",
    message: `${getGraphMachActionLabel(normalizedAction)} starting...`,
    output: "",
    error: "",
    child: null,
    childPid: null,
    forceKillTimer: null,
    cancelRequested: false,
    cancel() {
      if (GRAPH_MACH_TERMINAL_STATUSES.has(session.status)) {
        return;
      }

      session.cancelRequested = true;
      session.message = session.phase === "running"
        ? "Closing run..."
        : "Canceling build...";

      if (session.child || session.childPid) {
        terminateGraphMachChild(session);
        scheduleGraphMachForceKill(session);
        if (!session.child) {
          finishCanceledGraphMachSession(session);
        }
      } else {
        finishCanceledGraphMachSession(session);
      }
    },
  };

  queueMicrotask(async () => {
    try {
      await runGraphMachActionSession({
        graph,
        action: normalizedAction,
        session,
        runCommand,
      });
    } catch (error) {
      if (session.cancelRequested) {
        finishCanceledGraphMachSession(session);
        return;
      }

      session.status = "error";
      session.phase = "";
      session.error = String(error?.message || error);
      session.message = session.error;
    }
  });

  return session;
}

export function serializeGraphMachSession(session) {
  refreshGraphMachDetachedRunSession(session);

  return {
    id: session.id,
    graphIndex: session.graphIndex,
    action: session.action,
    label: session.label,
    path: session.path,
    status: session.status,
    phase: session.phase,
    message: session.message,
    output: session.output || "",
    error: session.error,
    childPid: session.childPid || null,
    canCancel: !session.cancelRequested && !GRAPH_MACH_TERMINAL_STATUSES.has(session.status),
  };
}

export async function getCheckoutGraphSnapshot({
  graph,
  limit = 80,
  runCommand = run,
}) {
  const [branch, page] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    getCheckoutCommitPage({
      graph,
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

function recordSkippedRebaseCommit(session, commit, hash) {
  if (!session.skippedMainCommits.includes(commit)) {
    session.skippedMainCommits.push(commit);
  }
  session.skippedReplayedCommits.push({
    originalHash: commit,
    hash,
  });
}

async function finishRebaseReplay(session, runCommand) {
  const {
    graph,
    base,
    hash,
    branch,
    mode,
    stackCommits,
    stackBranchRefs,
    skippedMainCommits,
    rewrittenCommits,
    skippedReplayedCommits,
  } = session;
  const rewrittenHashByOriginalHash = new Map(
    rewrittenCommits.map((commit) => [commit.originalHash, commit.hash]),
  );
  const skippedHashByOriginalHash = new Map(
    skippedReplayedCommits.map((commit) => [commit.originalHash, commit.hash]),
  );
  const branchUpdates = [];

  for (const { hash: originalHash, branches } of stackBranchRefs) {
    const rewrittenHash =
      rewrittenHashByOriginalHash.get(originalHash) ||
      skippedHashByOriginalHash.get(originalHash);

    if (!rewrittenHash) {
      continue;
    }

    for (const branchName of branches) {
      await runCommand({
        cmd: "git",
        args: ["branch", "-f", branchName, rewrittenHash],
        cwd: graph.path,
        silent: true,
      });
      branchUpdates.push({
        branch: branchName,
        originalHash,
        hash: rewrittenHash,
      });
    }
  }

  let currentHash = rewrittenCommits.at(-1)?.hash ||
    skippedReplayedCommits.at(-1)?.hash ||
    base.hash;

  if (branch && !branchUpdates.some((update) => update.branch === branch)) {
    await runCommand({
      cmd: "git",
      args: ["branch", "-f", branch, currentHash],
      cwd: graph.path,
      silent: true,
    });
    branchUpdates.push({
      branch,
      originalHash: stackCommits.at(-1),
      hash: currentHash,
    });
  }

  if (branch) {
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
    mode,
    commits: stackCommits,
    skippedMainCommits,
    rewrittenCommits,
    branchUpdates,
    rebasedCount: rewrittenCommits.length,
    currentHash,
    detached: !branch,
    message: `${graph.label} rebased ${branch ? `branch ${branch}` : hash.slice(0, 12)}${rewrittenCommits.length > 1 ? ` (${rewrittenCommits.length} commits)` : ""} onto ${base.branch || base.hash.slice(0, 12)}${skippedMainCommits.length ? `; skipped ${skippedMainCommits.length} already on origin/${DEFAULT_BRANCH}` : ""}.`,
  };
}

function getInteractiveRebaseDefaultAction(subject = "", index = 0) {
  if (index > 0 && /^fixup!\s+/i.test(subject)) {
    return INTERACTIVE_REBASE_ACTION_FIXUP;
  }

  if (index > 0 && /^squash!\s+/i.test(subject)) {
    return INTERACTIVE_REBASE_ACTION_SQUASH;
  }

  return INTERACTIVE_REBASE_ACTION_PICK;
}

function normalizeInteractiveRebaseAction(action = "") {
  const normalized = String(action || INTERACTIVE_REBASE_ACTION_PICK)
    .trim()
    .toLowerCase();

  if (!INTERACTIVE_REBASE_ACTIONS.has(normalized)) {
    const error = new Error(`Unknown interactive rebase action: ${action}`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

async function getInteractiveRebaseCommitItems(graph, commits, runCommand) {
  const items = [];

  for (const [index, hash] of commits.entries()) {
    const message = await getGraphCommitMessage({
      graph,
      hash,
      runCommand,
    });
    const subject = getCommitSubjectFromMessage(message, hash);

    items.push({
      hash,
      shortHash: hash.slice(0, 12),
      subject,
      action: getInteractiveRebaseDefaultAction(subject, index),
    });
  }

  return items;
}

export async function getInteractiveRebasePlan({
  graph,
  hash,
  preferredBranch = "",
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);

  if (isWorkingTreeCommitHash(hash)) {
    const error = new Error("Uncommitted changes cannot start an interactive rebase.");
    error.statusCode = 409;
    throw error;
  }

  const currentBranch = await getCurrentGraphBranch(graph, runCommand);
  const [branchRefs, containingBranchRefs] = await Promise.all([
    getLocalBranchesAtCommit(graph, hash, runCommand),
    getLocalBranchesContainingCommit(graph, hash, runCommand),
  ]);
  const containingBranches = parseBranchRefs(containingBranchRefs);
  const stackCandidate = chooseRebaseStackCandidate({
    candidates: await Promise.all(
      containingBranches.map((candidateBranch) =>
        getRebaseStackCandidate(graph, hash, candidateBranch, runCommand),
      ),
    ),
    currentBranch,
    hash,
    preferredBranch,
  });
  const stackCommits = uniqueCommits(stackCandidate.commits);
  const { kept, skipped } = await filterRebaseCommitsOnMain(
    graph,
    stackCommits,
    runCommand,
  );

  if (skipped.length) {
    const error = new Error(
      `Cannot interactive rebase ${skipped.length === 1 ? "a commit that is" : "commits that are"} already on origin/${DEFAULT_BRANCH}.`,
    );
    error.statusCode = 409;
    throw error;
  }

  const parents = await getCommitParents(graph, kept[0], runCommand);

  if (parents.length !== 1) {
    const error = new Error(parents.length
      ? `Cannot interactive rebase merge commit ${kept[0].slice(0, 12)} because it has multiple parents.`
      : `Cannot interactive rebase root commit ${kept[0].slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  const stackBranchRefs = await getRebaseStackBranches({
    graph,
    stackCommits: kept,
    selectedHash: hash,
    selectedCommitRefs: branchRefs,
    runCommand,
  });
  const branch = chooseRebaseResultBranch({
    stackBranchRefs,
    candidateBranch: stackCandidate.branch,
    currentBranch,
    preferredBranch,
  });

  return {
    action: "interactive-rebase-plan",
    label: graph.label,
    path: graph.path,
    hash,
    branch,
    base: parents[0],
    commits: await getInteractiveRebaseCommitItems(graph, kept, runCommand),
  };
}

function normalizeInteractiveRebaseTodo({
  items = [],
  planCommits = [],
} = {}) {
  const planHashes = new Set(planCommits.map((commit) => commit.hash));
  const todoItems = Array.isArray(items) && items.length
    ? items
    : planCommits;
  const seen = new Set();
  let hasPreviousCommit = false;
  const todo = todoItems.map((item) => {
    const hash = String(item?.hash || "").trim();

    if (!planHashes.has(hash)) {
      const error = new Error(`Commit ${hash.slice(0, 12) || "(unknown)"} is not in the selected interactive rebase range.`);
      error.statusCode = 400;
      throw error;
    }

    if (seen.has(hash)) {
      const error = new Error(`Commit ${hash.slice(0, 12)} appears more than once in the interactive rebase todo.`);
      error.statusCode = 400;
      throw error;
    }

    seen.add(hash);
    const action = normalizeInteractiveRebaseAction(item?.action);

    if (!hasPreviousCommit && [
      INTERACTIVE_REBASE_ACTION_SQUASH,
      INTERACTIVE_REBASE_ACTION_FIXUP,
    ].includes(action)) {
      const error = new Error("The first interactive rebase commit cannot use squash or fixup.");
      error.statusCode = 400;
      throw error;
    }

    if (action !== INTERACTIVE_REBASE_ACTION_DROP) {
      hasPreviousCommit = true;
    }

    return {
      hash,
      action,
      subject: String(item?.subject || "").trim(),
    };
  });

  if (seen.size !== planHashes.size) {
    const error = new Error("Interactive rebase todo must include every commit in the selected range. Use Drop for commits you want to remove.");
    error.statusCode = 400;
    throw error;
  }

  return todo;
}

function setInteractiveRebaseRewrite(session, originalHash, hash) {
  const existing = session.rewrittenCommits.find((commit) =>
    commit.originalHash === originalHash
  );

  if (existing) {
    existing.hash = hash;
    return;
  }

  session.rewrittenCommits.push({
    originalHash,
    hash,
  });
}

function buildInteractiveSquashMessage(baseMessage = "", nextMessage = "") {
  return [
    String(baseMessage || "").trimEnd(),
    String(nextMessage || "").trimEnd(),
  ].filter(Boolean).join("\n\n");
}

async function amendInteractiveRebaseHead({
  graph,
  message,
  runCommand,
}) {
  const messagePath = path.join(os.tmpdir(), `tb-tools-interactive-rebase-${randomUUID()}.txt`);
  await writeFile(
    messagePath,
    message.endsWith("\n") ? message : `${message}\n`,
  );

  try {
    await runCommand({
      cmd: "git",
      args: getGitAmendArgs(messagePath, { includeChanges: true }),
      cwd: graph.path,
      silent: true,
    });
  } finally {
    await unlink(messagePath).catch(() => {});
  }

  const hash = await getCurrentGraphHeadHash(graph, runCommand);
  const amendedMessage = await getGraphCommitMessage({
    graph,
    hash,
    runCommand,
  });

  ensureAmendedCommitMessage(amendedMessage, message, hash);

  return {
    hash,
    message: amendedMessage,
  };
}

function createInteractiveRebasePauseError({
  session,
  item,
  index,
  hash,
}) {
  session.editPause = {
    commit: item.hash,
    index,
    hash,
  };

  const error = new Error(
    `Interactive rebase paused after applying ${item.hash.slice(0, 12)}.`,
  );
  error.statusCode = 409;
  error.rebaseState = session;
  error.rebaseConflict = {
    type: "edit",
    reason: "edit-stop",
    graphIndex: session.graphIndex,
    label: session.graph.label,
    path: session.graph.path,
    hash: session.hash,
    base: session.base.hash,
    branch: session.branch,
    mode: "interactive",
    conflictCommit: item.hash,
    conflictIndex: index,
    totalCommits: session.todo.length,
    files: [],
    markerFiles: [],
    message: error.message,
    output: "",
    canContinue: true,
  };

  return error;
}

function createInteractiveRebaseDirtyPauseError({
  session,
  output = "",
}) {
  const pause = session.editPause || {};
  const commit = pause.commit || session.hash;
  const error = new Error(
    "Interactive rebase cannot continue while the checkout has uncommitted changes. Amend, commit, or stash the manual work, then continue.",
  );

  error.statusCode = 409;
  error.rebaseState = session;
  error.rebaseConflict = {
    type: "edit",
    reason: "dirty-edit-stop",
    graphIndex: session.graphIndex,
    label: session.graph.label,
    path: session.graph.path,
    hash: session.hash,
    base: session.base.hash,
    branch: session.branch,
    mode: "interactive",
    conflictCommit: commit,
    conflictIndex: pause.index || 0,
    totalCommits: session.todo.length,
    files: [],
    markerFiles: [],
    message: error.message,
    output,
    canContinue: true,
  };

  return error;
}

async function commitInteractiveRebaseItem({
  session,
  item,
  index,
  runCommand,
}) {
  const { graph } = session;

  if (
    [
      INTERACTIVE_REBASE_ACTION_SQUASH,
      INTERACTIVE_REBASE_ACTION_FIXUP,
    ].includes(item.action)
  ) {
    if (!session.currentGroupOriginalHashes?.length) {
      const error = new Error(`${item.action} requires a previous picked commit.`);
      error.statusCode = 400;
      throw error;
    }

    const itemMessage = await getGraphCommitMessage({
      graph,
      hash: item.hash,
      runCommand,
    });
    const message = item.action === INTERACTIVE_REBASE_ACTION_SQUASH
      ? buildInteractiveSquashMessage(session.currentGroupMessage, itemMessage)
      : session.currentGroupMessage;
    const amended = await amendInteractiveRebaseHead({
      graph,
      message,
      runCommand,
    });
    const groupOriginalHashes = [
      ...session.currentGroupOriginalHashes,
      item.hash,
    ];

    for (const originalHash of groupOriginalHashes) {
      setInteractiveRebaseRewrite(session, originalHash, amended.hash);
    }

    session.currentGroupOriginalHashes = groupOriginalHashes;
    session.currentGroupMessage = amended.message;
    return amended.hash;
  }

  await runCommand({
    cmd: "git",
    args: ["commit", "-C", item.hash],
    cwd: graph.path,
    silent: true,
  });
  const rewrittenHash = await amendReplayedCommitTryRunIdentity({
    session,
    commit: item.hash,
    runCommand,
  });
  const message = await getGraphCommitMessage({
    graph,
    hash: rewrittenHash,
    runCommand,
  });

  setInteractiveRebaseRewrite(session, item.hash, rewrittenHash);
  session.currentGroupOriginalHashes = [item.hash];
  session.currentGroupMessage = message;

  if (item.action === INTERACTIVE_REBASE_ACTION_EDIT) {
    throw createInteractiveRebasePauseError({
      session,
      item,
      index,
      hash: rewrittenHash,
    });
  }

  return rewrittenHash;
}

async function applyInteractiveRebaseItem({
  session,
  item,
  index,
  runCommand,
}) {
  const { graph } = session;

  if (item.action === INTERACTIVE_REBASE_ACTION_DROP) {
    const hash = await getCurrentGraphHeadHash(graph, runCommand);

    setInteractiveRebaseRewrite(session, item.hash, hash);
    return hash;
  }

  try {
    await runCommand({
      cmd: "git",
      args: ["cherry-pick", "--no-commit", item.hash],
      cwd: graph.path,
      silent: true,
    });
  } catch (error) {
    const conflictFiles = await getGraphConflictFiles(graph, runCommand);

    if (conflictFiles.length || isCherryPickConflictError(error)) {
      throw createRebaseConflictError({
        session,
        conflictCommit: item.hash,
        conflictIndex: index,
        conflictFiles,
        cause: error,
      });
    }

    if (!isEmptyCherryPickError(error)) {
      throw error;
    }

    await resetGraphReplayState(graph, runCommand);
    setInteractiveRebaseRewrite(
      session,
      item.hash,
      await getCurrentGraphHeadHash(graph, runCommand),
    );
    return "";
  }

  try {
    return await commitInteractiveRebaseItem({
      session,
      item,
      index,
      runCommand,
    });
  } catch (error) {
    if (!isEmptyCherryPickError(error)) {
      throw error;
    }

    await resetGraphReplayState(graph, runCommand);
    setInteractiveRebaseRewrite(
      session,
      item.hash,
      await getCurrentGraphHeadHash(graph, runCommand),
    );
    return "";
  }
}

async function finishInteractiveRebaseReplay(session, runCommand) {
  const {
    graph,
    hash,
    branch,
    base,
    stackBranchRefs,
    rewrittenCommits,
    todo,
  } = session;
  const rewrittenHashByOriginalHash = new Map(
    rewrittenCommits.map((commit) => [commit.originalHash, commit.hash]),
  );
  const branchUpdates = [];
  let currentHash = await getCurrentGraphHeadHash(graph, runCommand);

  for (const { hash: originalHash, branches } of stackBranchRefs) {
    const rewrittenHash = rewrittenHashByOriginalHash.get(originalHash);

    if (!rewrittenHash) {
      continue;
    }

    for (const branchName of branches) {
      await runCommand({
        cmd: "git",
        args: ["branch", "-f", branchName, rewrittenHash],
        cwd: graph.path,
        silent: true,
      });
      branchUpdates.push({
        branch: branchName,
        originalHash,
        hash: rewrittenHash,
      });
    }
  }

  if (branch && !branchUpdates.some((update) => update.branch === branch)) {
    await runCommand({
      cmd: "git",
      args: ["branch", "-f", branch, currentHash],
      cwd: graph.path,
      silent: true,
    });
    branchUpdates.push({
      branch,
      originalHash: todo.at(-1)?.hash || hash,
      hash: currentHash,
    });
  }

  if (branch) {
    await runCommand({
      cmd: "git",
      args: ["switch", branch],
      cwd: graph.path,
      silent: true,
    });
    currentHash = await getCurrentGraphHeadHash(graph, runCommand);
    graph.branch = branch;
  } else {
    graph.branch = "(detached)";
  }

  const changedCount = todo.filter((item) =>
    item.action !== INTERACTIVE_REBASE_ACTION_DROP
  ).length;

  return {
    action: "interactive-rebase",
    label: graph.label,
    path: graph.path,
    hash,
    branch,
    base: base.hash,
    commits: todo.map((item) => item.hash),
    todo,
    rewrittenCommits,
    branchUpdates,
    rebasedCount: changedCount,
    currentHash,
    detached: !branch,
    message: `${graph.label} interactive rebased ${branch ? `branch ${branch}` : hash.slice(0, 12)} (${todo.length} commits) from ${base.hash.slice(0, 12)}.`,
  };
}

async function replayInteractiveRebase(session, startIndex, runCommand) {
  for (let index = startIndex; index < session.todo.length; index++) {
    await applyInteractiveRebaseItem({
      session,
      item: session.todo[index],
      index,
      runCommand,
    });
  }

  return finishInteractiveRebaseReplay(session, runCommand);
}

async function continueInteractiveRebaseSession({
  session,
  runCommand,
}) {
  if (session.editPause) {
    const status = await runCommand({
      cmd: "git",
      args: ["status", "--porcelain"],
      cwd: session.graph.path,
      capture: true,
      silent: true,
    });

    if (status.trim()) {
      throw createInteractiveRebaseDirtyPauseError({
        session,
        output: status,
      });
    }

    const pause = session.editPause;
    const hash = await getCurrentGraphHeadHash(session.graph, runCommand);
    const message = await getGraphCommitMessage({
      graph: session.graph,
      hash,
      runCommand,
    });

    setInteractiveRebaseRewrite(session, pause.commit, hash);
    session.currentGroupOriginalHashes = [pause.commit];
    session.currentGroupMessage = message;
    delete session.editPause;

    return replayInteractiveRebase(session, pause.index + 1, runCommand);
  }

  if (!session.conflictCommit) {
    const error = new Error("No interactive rebase stop is waiting to continue.");
    error.statusCode = 404;
    throw error;
  }

  const { graph, conflictCommit, conflictIndex } = session;
  const item = session.todo[conflictIndex];
  const conflictFiles = session.conflictFiles || [];
  const markerFiles = await getGraphConflictMarkerFiles(graph, conflictFiles);

  if (markerFiles.length) {
    throw createRebaseConflictError({
      session,
      conflictCommit,
      conflictIndex,
      conflictFiles,
      displayFiles: markerFiles,
      markerFiles,
      cause: new Error("Conflict markers are still present."),
      reason: "conflict-markers",
    });
  }

  if (conflictFiles.length) {
    await runCommand({
      cmd: "git",
      args: ["add", "-A", "--", ...conflictFiles],
      cwd: graph.path,
      silent: true,
    });
  }

  const remainingConflicts = await getGraphConflictFiles(graph, runCommand);

  if (remainingConflicts.length) {
    throw createRebaseConflictError({
      session,
      conflictCommit,
      conflictIndex,
      conflictFiles: remainingConflicts,
      cause: new Error("Conflicted files are still unresolved."),
    });
  }

  delete session.conflictCommit;
  delete session.conflictIndex;
  delete session.conflictFiles;

  await commitInteractiveRebaseItem({
    session,
    item,
    index: conflictIndex,
    runCommand,
  });

  return replayInteractiveRebase(session, conflictIndex + 1, runCommand);
}

export async function startInteractiveRebase({
  graph,
  graphIndex = null,
  hash,
  preferredBranch = "",
  items = [],
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);
  await ensureCleanGraph(graph, runCommand);

  const checkoutBase = await getCurrentGraphBase(graph, runCommand);
  const plan = await getInteractiveRebasePlan({
    graph,
    hash,
    preferredBranch,
    runCommand,
  });
  const todo = normalizeInteractiveRebaseTodo({
    items,
    planCommits: plan.commits,
  });
  const stackCommits = plan.commits.map((commit) => commit.hash);
  const stackBranchRefs = await getRebaseStackBranches({
    graph,
    stackCommits,
    selectedHash: hash,
    selectedCommitRefs: await getLocalBranchesAtCommit(graph, hash, runCommand),
    runCommand,
  });
  const session = {
    kind: "interactive-rebase",
    graph,
    graphIndex,
    checkoutBase,
    base: {
      branch: "",
      hash: plan.base,
    },
    hash,
    branch: plan.branch,
    mode: "interactive",
    stackCommits,
    stackBranchRefs,
    todo,
    tryRunIdentityByHash: await getRebaseTryRunIdentityByHash({
      graph,
      stackCommits,
      runCommand,
    }),
    rewrittenCommits: [],
    skippedMainCommits: [],
    skippedReplayedCommits: [],
    currentGroupOriginalHashes: [],
    currentGroupMessage: "",
  };
  let replayStarted = false;

  try {
    await runCommand({
      cmd: "git",
      args: ["switch", "--detach", plan.base],
      cwd: graph.path,
      silent: true,
    });
    replayStarted = true;

    return await replayInteractiveRebase(session, 0, runCommand);
  } catch (error) {
    if (error?.rebaseConflict) {
      throw error;
    }

    if (replayStarted) {
      await resetGraphReplayState(graph, runCommand);
      await restoreGraphCheckout(graph, checkoutBase, runCommand);
    }
    throw error;
  }
}

async function replayRebaseCommits(session, startIndex, runCommand) {
  const { graph, stackCommits, rewrittenCommits } = session;

  for (let index = startIndex; index < stackCommits.length; index++) {
    const commit = stackCommits[index];

    try {
      await runCommand({
        cmd: "git",
        args: ["cherry-pick", "--no-commit", commit],
        cwd: graph.path,
        silent: true,
      });
    } catch (error) {
      const conflictFiles = await getGraphConflictFiles(graph, runCommand);

      if (conflictFiles.length || isCherryPickConflictError(error)) {
        throw createRebaseConflictError({
          session,
          conflictCommit: commit,
          conflictIndex: index,
          conflictFiles,
          cause: error,
        });
      }

      if (!isEmptyCherryPickError(error)) {
        throw error;
      }

      await resetGraphReplayState(graph, runCommand);
      recordSkippedRebaseCommit(
        session,
        commit,
        await getCurrentGraphHeadHash(graph, runCommand),
      );
      continue;
    }

    try {
      await runCommand({
        cmd: "git",
        args: ["commit", "-C", commit],
        cwd: graph.path,
        silent: true,
      });
    } catch (error) {
      if (!isEmptyCherryPickError(error)) {
        throw error;
      }

      await resetGraphReplayState(graph, runCommand);
      recordSkippedRebaseCommit(
        session,
        commit,
        await getCurrentGraphHeadHash(graph, runCommand),
      );
      continue;
    }

    const rewrittenHash = await amendReplayedCommitTryRunIdentity({
      session,
      commit,
      runCommand,
    });

    rewrittenCommits.push({
      originalHash: commit,
      hash: rewrittenHash,
    });
  }

  return finishRebaseReplay(session, runCommand);
}

export async function continueRebaseCommit({
  session,
  runCommand = run,
}) {
  if (session?.kind === "interactive-rebase") {
    return continueInteractiveRebaseSession({
      session,
      runCommand,
    });
  }

  if (!session?.conflictCommit) {
    const error = new Error("No rebase conflict is waiting to continue.");
    error.statusCode = 404;
    throw error;
  }

  const { graph, conflictCommit, conflictIndex } = session;
  const conflictFiles = session.conflictFiles || [];
  const markerFiles = await getGraphConflictMarkerFiles(graph, conflictFiles);

  if (markerFiles.length) {
    throw createRebaseConflictError({
      session,
      conflictCommit,
      conflictIndex,
      conflictFiles,
      displayFiles: markerFiles,
      markerFiles,
      cause: new Error("Conflict markers are still present."),
      reason: "conflict-markers",
    });
  }

  if (conflictFiles.length) {
    await runCommand({
      cmd: "git",
      args: ["add", "-A", "--", ...conflictFiles],
      cwd: graph.path,
      silent: true,
    });
  }

  const remainingConflicts = await getGraphConflictFiles(graph, runCommand);

  if (remainingConflicts.length) {
    throw createRebaseConflictError({
      session,
      conflictCommit,
      conflictIndex,
      conflictFiles: remainingConflicts,
      cause: new Error("Conflicted files are still unresolved."),
    });
  }

  try {
    await runCommand({
      cmd: "git",
      args: ["commit", "-C", conflictCommit],
      cwd: graph.path,
      silent: true,
    });
    const rewrittenHash = await amendReplayedCommitTryRunIdentity({
      session,
      commit: conflictCommit,
      runCommand,
    });

    session.rewrittenCommits.push({
      originalHash: conflictCommit,
      hash: rewrittenHash,
    });
  } catch (error) {
    if (!isEmptyCherryPickError(error)) {
      throw error;
    }

    await resetGraphReplayState(graph, runCommand);
    recordSkippedRebaseCommit(
      session,
      conflictCommit,
      await getCurrentGraphHeadHash(graph, runCommand),
    );
  }

  delete session.conflictCommit;
  delete session.conflictIndex;
  delete session.conflictFiles;

  return replayRebaseCommits(session, conflictIndex + 1, runCommand);
}

function hasStackBranch(stackBranchRefs = [], branch = "") {
  return Boolean(branch) &&
    stackBranchRefs.some((entry) => entry.branches.includes(branch));
}

function choosePruneResultBranch({
  stackBranchRefs = [],
  candidateBranch = "",
  currentBranch = "",
  preferredBranch = "",
  selectedBranches = [],
} = {}) {
  if (hasStackBranch(stackBranchRefs, currentBranch)) {
    return currentBranch;
  }

  if (hasStackBranch(stackBranchRefs, preferredBranch)) {
    return preferredBranch;
  }

  if (hasStackBranch(stackBranchRefs, candidateBranch)) {
    return candidateBranch;
  }

  const selectedBranch = selectedBranches.find((branch) =>
    hasStackBranch(stackBranchRefs, branch)
  );

  if (selectedBranch) {
    return selectedBranch;
  }

  if (currentBranch && (
    currentBranch === candidateBranch ||
    selectedBranches.includes(currentBranch)
  )) {
    return currentBranch;
  }

  if (preferredBranch && (
    preferredBranch === candidateBranch ||
    selectedBranches.includes(preferredBranch)
  )) {
    return preferredBranch;
  }

  return candidateBranch || selectedBranches[0] || "";
}

async function pruneCommitFromBranchStack({
  graph,
  hash,
  parent,
  currentBranch,
  containingBranches = [],
  branchRefs = "",
  selectedBranches = [],
  preferredBranch = "",
  runCommand = run,
}) {
  const base = {
    branch: currentBranch,
    hash: await getCurrentGraphHeadHash(graph, runCommand),
  };
  const stackCandidate = chooseRebaseStackCandidate({
    candidates: await Promise.all(
      containingBranches.map((candidateBranch) =>
        getRebaseStackCandidate(graph, hash, candidateBranch, runCommand),
      ),
    ),
    currentBranch,
    hash,
    preferredBranch,
  });
  const selectedTipBranches = selectedBranches.filter((branch) =>
    parseBranchRefs(branchRefs).includes(branch)
  );
  const stackCommits = uniqueCommits(stackCandidate.commits);
  const stackBranchRefs = await getRebaseStackBranches({
    graph,
    stackCommits,
    selectedHash: hash,
    selectedCommitRefs: selectedTipBranches.join("\n"),
    runCommand,
  });
  const resultBranch = choosePruneResultBranch({
    stackBranchRefs,
    candidateBranch: stackCandidate.branch,
    currentBranch,
    preferredBranch,
    selectedBranches,
  });
  const descendants = stackCommits.slice(1);
  const rewrittenCommits = [];
  const branchUpdates = [];
  const replaySession = {
    graph,
    tryRunIdentityByHash: await getRebaseTryRunIdentityByHash({
      graph,
      stackCommits: descendants,
      runCommand,
    }),
  };
  let replayStarted = false;

  try {
    await runCommand({
      cmd: "git",
      args: ["switch", "--detach", parent],
      cwd: graph.path,
      silent: true,
    });
    replayStarted = true;

    for (const commit of descendants) {
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
      const rewrittenHash = await amendReplayedCommitTryRunIdentity({
        session: replaySession,
        commit,
        runCommand,
      });

      rewrittenCommits.push({
        originalHash: commit,
        hash: rewrittenHash,
      });
    }
  } catch (error) {
    if (replayStarted) {
      await resetGraphReplayState(graph, runCommand);
      await restoreGraphCheckout(graph, base, runCommand);
    }
    throw error;
  }

  const rewrittenHashByOriginalHash = new Map(
    rewrittenCommits.map((commit) => [commit.originalHash, commit.hash]),
  );

  for (const { hash: originalHash, branches } of stackBranchRefs) {
    const rewrittenHash = originalHash === hash
      ? parent
      : rewrittenHashByOriginalHash.get(originalHash);

    if (!rewrittenHash) {
      continue;
    }

    for (const branchName of branches) {
      await runCommand({
        cmd: "git",
        args: ["branch", "-f", branchName, rewrittenHash],
        cwd: graph.path,
        silent: true,
      });
      branchUpdates.push({
        branch: branchName,
        originalHash,
        hash: rewrittenHash,
      });
    }
  }

  let currentHash = rewrittenCommits.at(-1)?.hash || parent;

  if (resultBranch && !branchUpdates.some((update) => update.branch === resultBranch)) {
    await runCommand({
      cmd: "git",
      args: ["branch", "-f", resultBranch, currentHash],
      cwd: graph.path,
      silent: true,
    });
    branchUpdates.push({
      branch: resultBranch,
      originalHash: stackCommits.at(-1),
      hash: currentHash,
    });
  }

  if (resultBranch) {
    await runCommand({
      cmd: "git",
      args: ["switch", resultBranch],
      cwd: graph.path,
      silent: true,
    });
    currentHash = await getCurrentGraphHeadHash(graph, runCommand);
    graph.branch = resultBranch;
  } else {
    graph.branch = "(detached)";
  }

  const updatedBranches = Array.from(new Set(
    branchUpdates.map((update) => update.branch),
  ));

  return {
    action: "prune",
    label: graph.label,
    path: graph.path,
    hash,
    branches: updatedBranches,
    branchUpdates,
    parent,
    currentHash,
    branch: graph.branch,
    detached: !resultBranch,
    message: `${graph.label} pruned ${hash.slice(0, 12)} from ${updatedBranches.length === 1 ? "branch" : "branches"} ${updatedBranches.join(", ")}.`,
  };
}

export async function rebaseCommit({
  graph,
  hash,
  graphIndex = null,
  preferredBranch = "",
  rebaseMode = DEFAULT_GRAPH_REBASE_MODE,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);
  const mode = normalizeRebaseMode(rebaseMode);

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
  const stackCandidate =
    mode === GRAPH_REBASE_MODE_SELECTED
      ? {
          branch: await chooseSelectedRebaseResultBranch({
            graph,
            hash,
            branchRefs,
            currentBranch: base.branch,
            preferredBranch,
            runCommand,
          }),
          commits: [hash],
        }
      : chooseRebaseStackCandidate({
          candidates: await Promise.all(
            containingBranches.map((candidateBranch) =>
              getRebaseStackCandidate(graph, hash, candidateBranch, runCommand),
            ),
          ),
          currentBranch: base.branch,
          hash,
          preferredBranch,
        });
  const rawStackCommits = uniqueCommits(
    await getRebaseCommitsForMode({
      graph,
      hash,
      mode,
      stackCommits: stackCandidate.commits,
      runCommand,
    }),
  );
  const { kept: stackCommits, skipped: skippedMainCommits } =
    await filterRebaseCommitsOnMain(graph, rawStackCommits, runCommand);
  const stackBranchRefs = await getRebaseStackBranches({
    graph,
    stackCommits,
    selectedHash: hash,
    selectedCommitRefs: mode === GRAPH_REBASE_MODE_SELECTED && stackCandidate.branch
      ? `${stackCandidate.branch}\n`
      : mode === GRAPH_REBASE_MODE_SELECTED
        ? ""
        : branchRefs,
    runCommand,
  });
  const branch = chooseRebaseResultBranch({
    stackBranchRefs,
    candidateBranch: stackCandidate.branch,
    currentBranch: base.branch,
    preferredBranch,
  });

  if (stackCommits.includes(base.hash)) {
    const error = new Error(`Cannot rebase ${hash.slice(0, 12)} because the current checkout is inside the selected commit stack.`);
    error.statusCode = 409;
    throw error;
  }

  if (!stackCommits.length) {
    graph.branch = base.branch || "(detached)";
    return {
      action: "rebase",
      label: graph.label,
      path: graph.path,
      hash,
      branch: graph.branch,
      base: base.hash,
      mode,
      commits: [],
      skippedMainCommits,
      rewrittenCommits: [],
      branchUpdates: [],
      rebasedCount: 0,
      currentHash: base.hash,
      detached: !base.branch,
      message: `${graph.label} had no commits to rebase${skippedMainCommits.length ? `; skipped ${skippedMainCommits.length} already on origin/${DEFAULT_BRANCH}` : ""}.`,
    };
  }

  const session = {
    graph,
    graphIndex,
    base,
    hash,
    branch,
    mode,
    stackCommits,
    stackBranchRefs,
    skippedMainCommits,
    tryRunIdentityByHash: await getRebaseTryRunIdentityByHash({
      graph,
      stackCommits,
      runCommand,
    }),
    rewrittenCommits: [],
    skippedReplayedCommits: [],
  };
  let replayStarted = false;

  try {
    await runCommand({
      cmd: "git",
      args: ["switch", "--detach", base.hash],
      cwd: graph.path,
      silent: true,
    });
    replayStarted = true;

    return await replayRebaseCommits(session, 0, runCommand);
  } catch (error) {
    if (error?.rebaseConflict) {
      throw error;
    }

    if (replayStarted) {
      await resetGraphReplayState(graph, runCommand);
      await restoreGraphCheckout(graph, base, runCommand);
    }
    throw error;
  }
}

export async function pruneCommitBranches({
  graph,
  hash,
  preferredBranch = "",
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);

  if (isWorkingTreeCommitHash(hash)) {
    const error = new Error("Uncommitted changes cannot be pruned from the graph.");
    error.statusCode = 409;
    throw error;
  }

  await ensureCleanGraph(graph, runCommand);

  const [
    currentBranch,
    branchRefs,
    containingBranchRefs,
    toolTipRefs,
    containingToolRefs,
    parents,
  ] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    getLocalBranchesAtCommit(graph, hash, runCommand),
    getLocalBranchesContainingCommit(graph, hash, runCommand),
    getToolRefsAtCommit(graph, hash, runCommand),
    getToolRefsContainingCommit(graph, hash, runCommand),
    getCommitParents(graph, hash, runCommand),
  ]);
  const containingBranches = parseBranchRefs(containingBranchRefs);
  const branches = choosePruneBranches({
    containingRefs: containingBranchRefs,
    tipRefs: branchRefs,
    currentBranch,
    preferredBranch,
  });
  const containingToolRefNames = parseBranchRefs(containingToolRefs);
  const toolRefs = choosePruneRefs({
    containingRefs: containingToolRefs,
    tipRefs: toolTipRefs,
  });

  if (parents.length !== 1) {
    const error = new Error(parents.length
      ? `Cannot prune merge commit ${hash.slice(0, 12)} because it has multiple parents.`
      : `Cannot prune root commit ${hash.slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  const parent = parents[0];

  if (!containingBranches.length) {
    if (containingToolRefNames.length) {
      if (!toolRefs.length) {
        const error = new Error(`Commit ${hash.slice(0, 12)} is contained by multiple tb-tools refs (${containingToolRefNames.join(", ")}). Clean up old refs or leave one checkpoint containing the commit, then try again.`);
        error.statusCode = 409;
        throw error;
      }

      const base = await getCurrentGraphBase(graph, runCommand);
      const rewrittenRefs = [];

      for (const ref of toolRefs) {
        const refHash = await getRefHash(graph, ref, runCommand);

        if (refHash === hash) {
          await runCommand({
            cmd: "git",
            args: ["update-ref", ref, parent, refHash],
            cwd: graph.path,
            silent: true,
          });
          rewrittenRefs.push({ ref, hash: parent });
          continue;
        }

        let shouldRestoreCheckout = true;
        let rebaseCompleted = false;
        let rewrittenHash = "";

        try {
          await runCommand({
            cmd: "git",
            args: ["switch", "--detach", refHash],
            cwd: graph.path,
            silent: true,
          });
          await runCommand({
            cmd: "git",
            args: ["rebase", "--onto", parent, hash, "HEAD"],
            cwd: graph.path,
            silent: true,
          });
          rebaseCompleted = true;
          rewrittenHash = await getCurrentGraphHeadHash(graph, runCommand);
          await runCommand({
            cmd: "git",
            args: ["update-ref", ref, rewrittenHash, refHash],
            cwd: graph.path,
            silent: true,
          });
        } catch (error) {
          shouldRestoreCheckout = rebaseCompleted;
          throw error;
        } finally {
          if (shouldRestoreCheckout) {
            await restoreGraphCheckout(graph, base, runCommand);
          }
        }

        rewrittenRefs.push({ ref, hash: rewrittenHash });
      }

      const [newBranch, newCurrentHash] = await Promise.all([
        getCurrentGraphBranch(graph, runCommand),
        getCurrentGraphHeadHash(graph, runCommand),
      ]);
      graph.branch = newBranch.trim() || "(detached)";

      return {
        action: "prune",
        label: graph.label,
        path: graph.path,
        hash,
        branches: [],
        refs: rewrittenRefs,
        parent,
        currentHash: newCurrentHash,
        branch: graph.branch,
        detached: !newBranch.trim(),
        message: `${graph.label} pruned ${hash.slice(0, 12)} from ${toolRefs.length === 1 ? "ref" : "refs"} ${toolRefs.join(", ")}.`,
      };
    }

    const currentHead = await getCurrentGraphHeadHash(graph, runCommand);

    if (currentHead === hash) {
      await runCommand({
        cmd: "git",
        args: ["switch", "--detach", parent],
        cwd: graph.path,
        silent: true,
      });
    } else {
      const reachable = await isCommitReachableFromCurrentHead(graph, hash, runCommand);

      if (!reachable) {
        const error = new Error(`No local branches or the current checkout contain ${hash.slice(0, 12)}.`);
        error.statusCode = 409;
        throw error;
      }

      await runCommand({
        cmd: "git",
        args: ["rebase", "--onto", parent, hash, "HEAD"],
        cwd: graph.path,
        silent: true,
      });
    }

    const [newBranch, newCurrentHash] = await Promise.all([
      getCurrentGraphBranch(graph, runCommand),
      getCurrentGraphHeadHash(graph, runCommand),
    ]);
    graph.branch = newBranch.trim() || "(detached)";

    return {
      action: "prune",
      label: graph.label,
      path: graph.path,
      hash,
      branches: [],
      parent,
      currentHash: newCurrentHash,
      branch: graph.branch,
      detached: !newBranch.trim(),
      message: `${graph.label} pruned ${hash.slice(0, 12)} from current checkout.`,
    };
  }

  if (!branches.length) {
    const error = new Error(`Commit ${hash.slice(0, 12)} is contained by multiple local branches (${containingBranches.join(", ")}). Check out the branch to prune and try again.`);
    error.statusCode = 409;
    throw error;
  }

  return pruneCommitFromBranchStack({
    graph,
    hash,
    parent,
    currentBranch,
    containingBranches,
    branchRefs,
    selectedBranches: branches,
    preferredBranch,
    runCommand,
  });
}

export async function createBranchForCommit({
  graph,
  hash,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);

  if (isWorkingTreeCommitHash(hash)) {
    const error = new Error("Uncommitted changes cannot be used as a branch point.");
    error.statusCode = 409;
    throw error;
  }

  const message = await getGraphCommitMessage({
    graph,
    hash,
    runCommand,
  });
  const bugId = getBugIdFromText(message);

  if (!bugId) {
    const error = new Error(
      `No Bugzilla bug number found in ${hash.slice(0, 12)}.`,
    );
    error.statusCode = 400;
    throw error;
  }

  const branchData = await runCommand({
    cmd: "git",
    args: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const branch = getNextBugBranchName(branchData.split(/\r?\n/).filter(Boolean), bugId);

  await runCommand({
    cmd: "git",
    args: ["branch", branch, hash],
    cwd: graph.path,
    silent: true,
  });

  return {
    action: "branch",
    label: graph.label,
    path: graph.path,
    hash,
    createdBranch: branch,
    message: `${graph.label} created branch ${branch} at ${hash.slice(0, 12)}.`,
  };
}

export async function discardWorkingTreeChanges({
  graph,
  hash,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);

  if (!isWorkingTreeCommitHash(hash)) {
    const error = new Error("Only uncommitted changes can be discarded with this action.");
    error.statusCode = 400;
    throw error;
  }

  await runCommand({
    cmd: "git",
    args: ["reset", "--hard", "HEAD"],
    cwd: graph.path,
    silent: true,
  });
  await runCommand({
    cmd: "git",
    args: ["clean", "-fd"],
    cwd: graph.path,
    silent: true,
  });

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
  graph.branch = branch.trim() || "(detached)";

  return {
    action: "prune",
    label: graph.label,
    path: graph.path,
    hash,
    branch: graph.branch,
    currentHash: currentHash.trim(),
    message: `${graph.label} discarded uncommitted changes.`,
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
  preferredBranch = "",
  rebaseMode = DEFAULT_GRAPH_REBASE_MODE,
  runCommand = run,
}) {
  const graph = graphs[Number(graphIndex)];

  switch (action) {
    case "checkout":
      return checkoutCommit({ graph, hash, runCommand });
    case "rebase":
      return rebaseCommit({
        graph,
        graphIndex: Number(graphIndex),
        hash,
        preferredBranch,
        rebaseMode,
        runCommand,
      });
    case "branch":
      return createBranchForCommit({ graph, hash, runCommand });
    case "prune":
      if (isWorkingTreeCommitHash(hash)) {
        return discardWorkingTreeChanges({ graph, hash, runCommand });
      }

      return pruneCommitBranches({
        graph,
        hash,
        preferredBranch,
        runCommand,
      });
    default: {
      const error = new Error(`Unknown graph action: ${action}`);
      error.statusCode = 400;
      throw error;
    }
  }
}
