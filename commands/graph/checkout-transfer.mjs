import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import { getBugIdFromText } from "../../lib/workflow.mjs";
import { run } from "../../lib/utils.mjs";

const COPY_MODE_COMMIT = "commit";
const COPY_MODE_STACK = "stack";

function createTransferError(message, details = {}, statusCode = 409) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.transfer = details;
  return error;
}

function normalizeCopyMode(mode = COPY_MODE_COMMIT) {
  const normalized = String(mode || COPY_MODE_COMMIT).trim().toLowerCase();

  if (normalized !== COPY_MODE_COMMIT && normalized !== COPY_MODE_STACK) {
    throw createTransferError(`Unknown checkout copy mode: ${mode}`, {}, 400);
  }

  return normalized;
}

function getCheckoutKind(graph = {}) {
  return graph.checkout === "review" ? "review" : "working";
}

function getRepositoryKind(graph = {}) {
  return String(graph.repository || "").trim().toLowerCase();
}

async function getDestinationStatus(graph, runCommand) {
  return runCommand({
    cmd: "git",
    args: ["status", "--porcelain"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
}

async function ensureCleanDestination({ graph, discardDirty, runCommand }) {
  const status = await getDestinationStatus(graph, runCommand);
  const trackedStatus = status
    .split("\n")
    .filter((line) => line && !line.startsWith("?? "))
    .join("\n")
    .trim();

  if (!trackedStatus) {
    return;
  }

  if (!discardDirty) {
    throw createTransferError(
      `${graph.label} has local changes. Commit, stash, or discard them before copying commits.`,
      {
        reason: "destination-dirty",
        status: trackedStatus,
        graph: { label: graph.label, path: graph.path },
      },
    );
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
}

async function getCopyCommits({ graph, hash, mode, runCommand }) {
  const verifiedHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "--verify", `${hash}^{commit}`],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();

  if (mode === COPY_MODE_COMMIT) {
    return [verifiedHash];
  }

  const commits = (await runCommand({
    cmd: "git",
    args: ["rev-list", "--reverse", `origin/${DEFAULT_BRANCH}..${verifiedHash}`],
    cwd: graph.path,
    capture: true,
    silent: true,
  }))
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!commits.length) {
    throw createTransferError(
      `No local stack ending at ${verifiedHash.slice(0, 12)} is available to copy.`,
      { reason: "empty-stack", hash: verifiedHash },
    );
  }

  return commits;
}

async function getSuggestedBranchName({ graph, hash, runCommand }) {
  const matchingBranches = (await runCommand({
    cmd: "git",
    args: [
      "for-each-ref",
      "--format=%(refname:short)",
      "--points-at",
      hash,
      "refs/heads",
    ],
    cwd: graph.path,
    capture: true,
    silent: true,
  }))
    .split("\n")
    .map((value) => value.trim())
    .filter((branch) => branch && branch !== DEFAULT_BRANCH);

  if (matchingBranches.length) {
    return matchingBranches[0];
  }

  const message = await runCommand({
    cmd: "git",
    args: ["show", "-s", "--format=%B", hash],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const bugId = getBugIdFromText(message);

  return bugId ? `Bug-${bugId}` : `copy-${hash.slice(0, 12)}`;
}

async function validateNewBranch({ graph, branch, runCommand }) {
  if (!branch) {
    throw createTransferError("A destination branch name is required.", {}, 400);
  }

  await runCommand({
    cmd: "git",
    args: ["check-ref-format", "--branch", branch],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  try {
    await runCommand({
      cmd: "git",
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      cwd: graph.path,
      capture: true,
      silent: true,
    });
  } catch {
    return;
  }

  throw createTransferError(
    `${graph.label} already has a local branch named ${branch}. Choose a different destination branch.`,
    { reason: "branch-exists", branch },
  );
}

async function importSourceCommits({ source, destination, sourceCommits, runCommand }) {
  const sourceTip = sourceCommits.at(-1);

  await runCommand({
    cmd: "git",
    args: [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      source.path,
      sourceTip,
    ],
    cwd: destination.path,
    capture: true,
    silent: true,
  });
}

async function getNewCommits({ sourceCommits, destination, runCommand }) {
  const commits = [];

  for (const hash of sourceCommits) {
    try {
      await runCommand({
        cmd: "git",
        args: ["merge-base", "--is-ancestor", hash, `origin/${DEFAULT_BRANCH}`],
        cwd: destination.path,
        capture: true,
        silent: true,
      });
    } catch {
      commits.push(hash);
    }
  }

  return commits;
}

async function restoreDestination({ graph, branch, originalBranch, originalHash, runCommand }) {
  await runCommand({
    cmd: "git",
    args: ["cherry-pick", "--abort"],
    cwd: graph.path,
    capture: true,
    silent: true,
  }).catch(() => {});

  if (originalBranch) {
    await runCommand({
      cmd: "git",
      args: ["switch", originalBranch],
      cwd: graph.path,
      capture: true,
      silent: true,
    }).catch(() => {});
  } else {
    await runCommand({
      cmd: "git",
      args: ["switch", "--detach", originalHash],
      cwd: graph.path,
      capture: true,
      silent: true,
    }).catch(() => {});
  }

  await runCommand({
    cmd: "git",
    args: ["branch", "-D", branch],
    cwd: graph.path,
    capture: true,
    silent: true,
  }).catch(() => {});
}

export async function copyGraphCommitsBetweenCheckouts({
  source,
  destination,
  hash,
  mode = COPY_MODE_COMMIT,
  branch = "",
  discardDirty = false,
  runCommand = run,
}) {
  if (!source || !destination) {
    throw createTransferError("Both source and destination checkouts are required.", {}, 404);
  }

  if (source.path === destination.path) {
    throw createTransferError("Choose a different destination checkout.", {}, 400);
  }

  if (getCheckoutKind(source) === getCheckoutKind(destination)) {
    throw createTransferError(
      "Commits can only be copied between the Working and Review checkout pairs.",
      {},
      400,
    );
  }

  if (getRepositoryKind(source) !== getRepositoryKind(destination)) {
    throw createTransferError(
      "Commits can only be copied between matching comm or Firefox repositories.",
      {},
      400,
    );
  }

  const copyMode = normalizeCopyMode(mode);
  const sourceCommits = await getCopyCommits({
    graph: source,
    hash,
    mode: copyMode,
    runCommand,
  });
  const destinationBranch = String(branch || "").trim() ||
    await getSuggestedBranchName({
      graph: source,
      hash: sourceCommits.at(-1),
      runCommand,
    });

  await ensureCleanDestination({ graph: destination, discardDirty, runCommand });
  await validateNewBranch({ graph: destination, branch: destinationBranch, runCommand });
  await importSourceCommits({
    source,
    destination,
    sourceCommits,
    runCommand,
  });

  const commits = await getNewCommits({
    sourceCommits,
    destination,
    runCommand,
  });

  if (!commits.length) {
    throw createTransferError(
      "Every selected commit is already contained in the destination origin/main.",
      { reason: "already-on-main" },
    );
  }

  const [originalBranch, originalHash] = await Promise.all([
    runCommand({
      cmd: "git",
      args: ["branch", "--show-current"],
      cwd: destination.path,
      capture: true,
      silent: true,
    }).then((value) => value.trim()),
    runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: destination.path,
      capture: true,
      silent: true,
    }).then((value) => value.trim()),
  ]);

  try {
    await runCommand({
      cmd: "git",
      args: ["switch", "--create", destinationBranch, `origin/${DEFAULT_BRANCH}`],
      cwd: destination.path,
      capture: true,
      silent: true,
    });

    for (const commit of commits) {
      await runCommand({
        cmd: "git",
        args: ["cherry-pick", "-x", commit],
        cwd: destination.path,
        capture: true,
        silent: true,
      });
    }
  } catch (error) {
    await restoreDestination({
      graph: destination,
      branch: destinationBranch,
      originalBranch,
      originalHash,
      runCommand,
    });
    throw error;
  }

  const currentHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: destination.path,
    capture: true,
    silent: true,
  })).trim();
  destination.branch = destinationBranch;

  return {
    action: "copy-commits",
    source: { label: source.label, path: source.path },
    destination: { label: destination.label, path: destination.path },
    mode: copyMode,
    branch: destinationBranch,
    copiedCommits: commits,
    currentHash,
    message: `Copied ${commits.length} commit${commits.length === 1 ? "" : "s"} from ${source.label} to ${destination.label} on ${destinationBranch}.`,
  };
}
