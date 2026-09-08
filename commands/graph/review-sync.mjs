import { constants as fsConstants } from "node:fs";
import {
  copyFile as defaultCopyFile,
  cp as defaultCopyDirectory,
  readdir as defaultReadDirectory,
  rm as defaultRemove,
} from "node:fs/promises";
import path from "node:path";
import { run } from "../../lib/utils.mjs";

export const REVIEW_SYNC_CONFIRMATION = "SYNC REVIEW";
const REPOSITORIES = ["firefox", "comm"];

function createReviewSyncError(message, details = {}, statusCode = 409) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.reviewSync = details;
  return error;
}

function getCheckoutKind(graph = {}) {
  return graph.checkout === "review" ? "review" : "working";
}

function getRepositoryKind(graph = {}) {
  return String(graph.repository || "").trim().toLowerCase();
}

function getGraphLabel(graph = {}) {
  return graph.label || `${getCheckoutKind(graph)} ${getRepositoryKind(graph)}`;
}

function getPair(graphs, repository) {
  const matching = graphs.filter(
    (graph) => graph && getRepositoryKind(graph) === repository,
  );
  const working = matching.filter((graph) => getCheckoutKind(graph) === "working");
  const review = matching.filter((graph) => getCheckoutKind(graph) === "review");

  if (working.length !== 1 || review.length !== 1) {
    throw createReviewSyncError(
      "Sync Review requires one Working and one Review Firefox checkout plus one Working and one Review comm checkout.",
      { reason: "incomplete-checkout-pair", repository },
    );
  }

  const source = working[0];
  const destination = review[0];

  if (path.resolve(source.path) === path.resolve(destination.path)) {
    throw createReviewSyncError(
      `${getGraphLabel(source)} and ${getGraphLabel(destination)} must be separate clones.`,
      { reason: "same-checkout-path", repository },
      400,
    );
  }

  return { repository, source, destination };
}

export function getReviewSyncPairs(graphs = []) {
  if (!Array.isArray(graphs)) {
    throw createReviewSyncError(
      "Sync Review requires configured checkout graphs.",
      { reason: "missing-checkout-graphs" },
      400,
    );
  }

  return REPOSITORIES.map((repository) => getPair(graphs, repository));
}

function normalizeConfirmation(value = "") {
  return String(value || "").trim();
}

function createGitCommand(graph, args) {
  return {
    cmd: "git",
    args,
    cwd: graph.path,
    capture: true,
    silent: true,
  };
}

async function runGit(graph, args, runCommand) {
  return runCommand(createGitCommand(graph, args));
}

async function getSourceState(graph, runCommand) {
  await runGit(graph, ["rev-parse", "--git-dir"], runCommand);
  const status = await runGit(graph, ["status", "--porcelain"], runCommand);
  const trackedStatus = status
    .split("\n")
    .filter((line) => line && !line.startsWith("?? "))
    .join("\n")
    .trim();

  if (trackedStatus) {
    throw createReviewSyncError(
      `${getGraphLabel(graph)} has tracked Working changes. Commit, stash, or discard them before syncing Review so copied build artifacts match the checked-out source.`,
      { reason: "source-dirty", label: getGraphLabel(graph), status: trackedStatus },
    );
  }

  const hash = (await runGit(graph, ["rev-parse", "--verify", "HEAD"], runCommand)).trim();
  let branch = "";

  try {
    branch = (await runGit(
      graph,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      runCommand,
    )).trim();
  } catch {
    // A detached Working checkout is still a valid sync source.
  }

  return { hash, branch };
}

async function verifyDestination(graph, runCommand) {
  await runGit(graph, ["rev-parse", "--git-dir"], runCommand);
  await runGit(graph, ["rev-parse", "--verify", "HEAD"], runCommand);
}

async function abortReviewOperations(graph, runCommand) {
  for (const args of [
    ["rebase", "--abort"],
    ["cherry-pick", "--abort"],
    ["merge", "--abort"],
    ["am", "--abort"],
  ]) {
    await runGit(graph, args, runCommand).catch(() => {});
  }
}

async function syncReviewRepository({
  source,
  destination,
  sourceState,
  preservePaths = [],
  runCommand,
}) {
  await abortReviewOperations(destination, runCommand);
  await runGit(destination, ["reset", "--hard"], runCommand);
  const cleanArgs = ["clean", "-ffdx"];

  for (const preservePath of preservePaths) {
    cleanArgs.push("-e", `${preservePath}/`);
  }

  await runGit(destination, cleanArgs, runCommand);
  await runGit(destination, ["switch", "--detach"], runCommand);

  // The wildcard refspec deliberately replaces every ordinary review ref.
  // --prune removes review-only local branches, tags, remotes, and tool refs.
  await runGit(destination, [
    "fetch",
    "--no-tags",
    "--prune",
    "--refmap=+refs/*:refs/*",
    source.path,
    "+refs/*:refs/*",
    sourceState.hash,
  ], runCommand);
  await runGit(destination, ["reset", "--hard", sourceState.hash], runCommand);

  if (sourceState.branch) {
    await runGit(destination, ["switch", "--force", sourceState.branch], runCommand);
  } else {
    await runGit(destination, ["switch", "--detach", sourceState.hash], runCommand);
  }

  // Reflogs would otherwise retain review-only commits even after their refs
  // were pruned. Pruning now makes this operation intentionally non-recoverable.
  await runGit(destination, [
    "reflog",
    "expire",
    "--expire=now",
    "--expire-unreachable=now",
    "--all",
  ], runCommand);
  await runGit(destination, ["gc", "--prune=now"], runCommand);

  destination.branch = sourceState.branch || "(detached)";

  return {
    repository: getRepositoryKind(destination),
    source: {
      label: getGraphLabel(source),
      path: source.path,
      branch: sourceState.branch || "(detached)",
      hash: sourceState.hash,
    },
    destination: {
      label: getGraphLabel(destination),
      path: destination.path,
      branch: destination.branch,
      hash: sourceState.hash,
    },
  };
}

function getNestedDestinationPaths(pair, pairs) {
  const destinationPath = path.resolve(pair.destination.path);

  return pairs
    .filter((candidate) => candidate !== pair)
    .map((candidate) => path.relative(destinationPath, path.resolve(candidate.destination.path)))
    .filter((relativePath) => (
      relativePath &&
      !relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath)
    ));
}

function isObjectDirectory(entry) {
  return entry.isDirectory() && entry.name.startsWith("obj-");
}

function isMozconfig(entry) {
  return entry.isFile() && (
    entry.name.startsWith("mozconfig") || entry.name.startsWith(".mozconfig")
  );
}

function getMatchingNames(entries, predicate) {
  return entries.filter(predicate).map((entry) => entry.name).sort();
}

async function syncBuildArtifacts({
  source,
  destination,
  readDirectory,
  remove,
  copyDirectory,
  copyFile,
}) {
  const [sourceEntries, destinationEntries] = await Promise.all([
    readDirectory(source.path, { withFileTypes: true }),
    readDirectory(destination.path, { withFileTypes: true }),
  ]);
  const sourceObjectDirectories = getMatchingNames(sourceEntries, isObjectDirectory);
  const destinationObjectDirectories = getMatchingNames(destinationEntries, isObjectDirectory);
  const sourceMozconfigs = getMatchingNames(sourceEntries, isMozconfig);
  const destinationMozconfigs = getMatchingNames(destinationEntries, isMozconfig);
  const sourceNames = new Set([...sourceObjectDirectories, ...sourceMozconfigs]);
  const removed = [];
  const copied = [];

  for (const name of [...destinationObjectDirectories, ...destinationMozconfigs]) {
    if (!sourceNames.has(name)) {
      await remove(path.join(destination.path, name), { recursive: true, force: true });
      removed.push(name);
    }
  }

  for (const name of sourceObjectDirectories) {
    const sourcePath = path.join(source.path, name);
    const destinationPath = path.join(destination.path, name);

    await remove(destinationPath, { recursive: true, force: true });
    await copyDirectory(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      mode: fsConstants.COPYFILE_FICLONE,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    copied.push(name);
  }

  for (const name of sourceMozconfigs) {
    await copyFile(
      path.join(source.path, name),
      path.join(destination.path, name),
      fsConstants.COPYFILE_FICLONE,
    );
    copied.push(name);
  }

  return { copied, removed };
}

export async function syncReviewCheckoutFromWorking({
  graphs,
  confirmation,
  runCommand = run,
  readDirectory = defaultReadDirectory,
  remove = defaultRemove,
  copyDirectory = defaultCopyDirectory,
  copyFile = defaultCopyFile,
}) {
  if (normalizeConfirmation(confirmation) !== REVIEW_SYNC_CONFIRMATION) {
    throw createReviewSyncError(
      `Type ${REVIEW_SYNC_CONFIRMATION} to replace the Review checkout.`,
      { reason: "confirmation-required" },
      400,
    );
  }

  const pairs = getReviewSyncPairs(graphs);
  const sourceStates = new Map();

  // Validate every Git repository and resolve every source ref before the
  // first destructive command can run against either Review clone.
  await Promise.all(pairs.flatMap(({ source, destination, repository }) => [
    getSourceState(source, runCommand).then((state) => sourceStates.set(repository, state)),
    verifyDestination(destination, runCommand),
  ]));

  const repositories = [];

  for (const pair of pairs) {
    repositories.push(await syncReviewRepository({
      ...pair,
      sourceState: sourceStates.get(pair.repository),
      preservePaths: getNestedDestinationPaths(pair, pairs),
      runCommand,
    }));
  }

  const firefoxPair = pairs.find(({ repository }) => repository === "firefox");
  const artifacts = await syncBuildArtifacts({
    source: firefoxPair.source,
    destination: firefoxPair.destination,
    readDirectory,
    remove,
    copyDirectory,
    copyFile,
  });

  return {
    action: "sync-review-from-working",
    repositories,
    artifacts,
    message: `Review now matches Working Git history for Firefox and comm. Copied ${artifacts.copied.length} build artifact${artifacts.copied.length === 1 ? "" : "s"}${artifacts.removed.length ? ` and removed ${artifacts.removed.length} stale artifact${artifacts.removed.length === 1 ? "" : "s"}` : ""}.`,
  };
}
