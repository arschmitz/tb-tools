import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getTbToolsIdFromCommitMessage,
  installTbToolsCommitMsgHook,
} from "../../lib/commit-message.mjs";
import { run } from "../../lib/utils.mjs";
import { formatPrettyDiffHtml, getDiffChangeCounts } from "./diff-renderer.mjs";
import {
  DEFAULT_MAX_DIFF_BYTES,
  FIELD_SEPARATOR,
  GRAPH_TRY_STORE_FILE,
  GRAPH_TRY_STORE_VERSION,
  GRAPH_WORKING_TREE_TRY_PREFIX,
  RECORD_SEPARATOR,
  WORKING_TREE_AUTHOR,
  WORKING_TREE_CHANGES_HASH,
} from "./constants.mjs";

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

export function parseBranchRefs(refsOutput = "") {
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

export function getGitAddAllArgs() {
  return ["add", "-A"];
}

export function getGitAmendArgs(messagePath, { includeChanges = false } = {}) {
  return includeChanges
    ? ["commit", "--amend", "-F", messagePath]
    : ["commit", "--amend", "--only", "-F", messagePath];
}

function normalizeCommitMessage(message = "") {
  return `${String(message).replace(/\r\n/g, "\n").trimEnd()}\n`;
}

export function ensureAmendedCommitMessage(actualMessage, expectedMessage, hash) {
  if (normalizeCommitMessage(actualMessage) === normalizeCommitMessage(expectedMessage)) {
    return;
  }

  const error = new Error(`Git reported a successful amend, but ${hash.slice(0, 12)} does not have the requested commit message.`);
  error.statusCode = 500;
  throw error;
}

export function getContentHash(value = "") {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeGraphTryRun(run = {}) {
  const url = String(run.url || "").trim();

  if (!url) {
    return null;
  }

  const createdAt = String(run.createdAt || new Date().toISOString());
  const patchId = String(run.patchId || "").trim();
  const tbToolsId = String(run.tbToolsId || run.tryId || run.localPatchId || "").trim();
  const hash = String(run.hash || "").trim();
  const id = String(run.id || getContentHash(`${tbToolsId}\0${patchId}\0${hash}\0${url}\0${createdAt}`));

  return {
    id,
    url,
    createdAt,
    hash,
    patchId,
    tbToolsId,
    subject: String(run.subject || "").trim(),
    label: String(run.label || "").trim(),
  };
}

function sortGraphTryRuns(runs = []) {
  return [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function normalizeGraphTrySubject(subject = "") {
  return String(subject || "").split("\n").find((line) => line.trim())?.trim() || "";
}

export function normalizeGraphTryStore(store = {}) {
  const legacyRuns = store && typeof store === "object" && store.runsByPatchId
    ? Object.values(store.runsByPatchId).flat()
    : [];
  const sourceRuns = Array.isArray(store?.runs) ? store.runs : legacyRuns;
  const seen = new Set();
  const runs = [];

  for (const sourceRun of sourceRuns) {
    const run = normalizeGraphTryRun(sourceRun);

    if (!run) {
      continue;
    }

    const identity = `${run.tbToolsId}\0${run.patchId}\0${run.hash}\0${run.url}\0${run.createdAt}`;

    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    runs.push(run);
  }

  return {
    version: GRAPH_TRY_STORE_VERSION,
    runs: sortGraphTryRuns(runs),
  };
}

export async function getGraphTryStorePath({
  graph,
  runCommand = run,
}) {
  const output = await runCommand({
    cmd: "git",
    args: ["rev-parse", "--git-path", GRAPH_TRY_STORE_FILE],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const storePath = output.trim() || path.join(".git", GRAPH_TRY_STORE_FILE);

  return path.isAbsolute(storePath) ? storePath : path.join(graph.path, storePath);
}

export async function readGraphTryStore({
  graph,
  runCommand = run,
} = {}) {
  try {
    const storePath = await getGraphTryStorePath({ graph, runCommand });
    return normalizeGraphTryStore(JSON.parse(await readFile(storePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return normalizeGraphTryStore();
    }

    if (error instanceof SyntaxError) {
      return normalizeGraphTryStore();
    }

    throw error;
  }
}

async function writeGraphTryStore({
  graph,
  store,
  runCommand = run,
}) {
  const storePath = await getGraphTryStorePath({ graph, runCommand });

  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(normalizeGraphTryStore(store), null, 2)}\n`);
}

export async function recordGraphTryRun({
  graph,
  tryRun,
  runCommand = run,
}) {
  const normalizedRun = normalizeGraphTryRun(tryRun);

  if (!normalizedRun) {
    return null;
  }

  const store = await readGraphTryStore({ graph, runCommand });
  const runs = store.runs.filter((run) => {
    const sameTarget = normalizedRun.tbToolsId && run.tbToolsId
      ? run.tbToolsId === normalizedRun.tbToolsId
      : normalizedRun.patchId
      ? run.patchId === normalizedRun.patchId
      : run.hash === normalizedRun.hash;

    return !(sameTarget && run.url === normalizedRun.url && run.createdAt === normalizedRun.createdAt);
  });
  const nextStore = {
    version: GRAPH_TRY_STORE_VERSION,
    runs: [normalizedRun, ...runs],
  };

  await writeGraphTryStore({
    graph,
    store: nextStore,
    runCommand,
  });

  return normalizedRun;
}

export function getGraphCommitTbToolsIdFromMessage(message = "") {
  return getTbToolsIdFromCommitMessage(message);
}

export async function getGraphCommitTbToolsId({
  graph,
  hash,
  message,
  runCommand = run,
}) {
  if (!graph || !hash || isWorkingTreeCommitHash(hash)) {
    return "";
  }

  const commitMessage = typeof message === "string"
    ? message
    : await getGraphCommitMessage({
      graph,
      hash,
      runCommand,
    });

  return getGraphCommitTbToolsIdFromMessage(commitMessage);
}

export function isWorkingTreeCommitHash(hash) {
  return hash === WORKING_TREE_CHANGES_HASH;
}

export function getWorkingTreeTryPatchId(changeId = "") {
  return changeId ? `${GRAPH_WORKING_TREE_TRY_PREFIX}${changeId}` : "";
}

function isWorkingTreeCommit(commit = {}) {
  return Boolean(commit.workingTree || isWorkingTreeCommitHash(commit.hash));
}

export async function getGraphCommitPatchId({
  graph,
  hash,
  runCommand = run,
}) {
  if (!graph || !hash || isWorkingTreeCommitHash(hash)) {
    return "";
  }

  if (graph.patchIdCache?.has(hash)) {
    return graph.patchIdCache.get(hash);
  }

  const output = await runCommand({
    cmd: "sh",
    args: [
      "-c",
      'git show --format= --patch --find-renames --no-ext-diff --no-color "$1" | git patch-id --stable',
      "tb-tools-patch-id",
      hash,
    ],
    cwd: graph.path,
    capture: true,
    silent: true,
  });

  const patchId = output.trim().split(/\s+/)[0] || "";

  graph.patchIdCache?.set(hash, patchId);

  return patchId;
}

function isGraphTryRunSubjectMatch(run, { subject = "", label = "" } = {}) {
  const normalizedSubject = normalizeGraphTrySubject(subject);

  if (!normalizedSubject || normalizeGraphTrySubject(run.subject) !== normalizedSubject) {
    return false;
  }

  return !label || !run.label || run.label === label;
}

function filterGraphTryRuns(store, {
  hash = "",
  label = "",
  patchId = "",
  subject = "",
  tbToolsId = "",
} = {}) {
  const runs = store?.runs || [];

  return sortGraphTryRuns(runs.flatMap((run) => {
    const subjectMatch = isGraphTryRunSubjectMatch(run, { subject, label });

    if (tbToolsId) {
      if (run.tbToolsId) {
        return run.tbToolsId === tbToolsId || subjectMatch
          ? [{ ...run, hash: hash || run.hash }]
          : [];
      }

      return (
        (hash && run.hash === hash) ||
        (patchId && run.patchId === patchId) ||
        subjectMatch
      ) ? [{ ...run, tbToolsId }] : [];
    }

    return (
      (hash && run.hash === hash) ||
      (patchId && run.patchId === patchId) ||
      subjectMatch
    ) ? [run] : [];
  }));
}

export async function getGraphTryRunsForCommit({
  graph,
  commit,
  store,
  runCommand = run,
}) {
  const normalizedStore = store || await readGraphTryStore({ graph, runCommand });
  const hash = String(commit?.hash || "").trim();
  const subject = normalizeGraphTrySubject(commit?.subject);
  const label = graph?.label || "";

  if (isWorkingTreeCommit(commit)) {
    const patchId = getWorkingTreeTryPatchId(commit?.changeId);
    return patchId ? filterGraphTryRuns(normalizedStore, { label, patchId, subject }) : [];
  }

  const hasStableRuns = normalizedStore.runs.some((tryRun) =>
    tryRun.tbToolsId || tryRun.patchId
  );

  if (!hasStableRuns) {
    return filterGraphTryRuns(normalizedStore, { hash, label, subject });
  }

  let tbToolsId = "";
  let patchId = "";

  try {
    tbToolsId = await getGraphCommitTbToolsId({
      graph,
      hash,
      runCommand,
    });
  } catch {
    tbToolsId = "";
  }

  try {
    patchId = await getGraphCommitPatchId({
      graph,
      hash,
      runCommand,
    });
  } catch {
    patchId = "";
  }

  if (!tbToolsId && !patchId) {
    return filterGraphTryRuns(normalizedStore, { hash, label, subject });
  }

  return filterGraphTryRuns(normalizedStore, {
    hash,
    label,
    patchId,
    subject,
    tbToolsId,
  });
}

export async function attachGraphTryRunsToCommits({
  graph,
  commits,
  runCommand = run,
}) {
  let store;

  try {
    store = await readGraphTryStore({ graph, runCommand });
  } catch {
    return commits;
  }

  if (!store.runs.length) {
    return commits;
  }

  return Promise.all(commits.map(async (commit) => {
    const tryRuns = await getGraphTryRunsForCommit({
      graph,
      commit,
      store,
      runCommand,
    });

    return tryRuns.length ? { ...commit, tryRuns } : commit;
  }));
}

export function isCheckedOutCommit(commit) {
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

export async function getRawWorkingTreeDiff({
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
    const graphPath = root.trim() || absolutePath;

    if (label === "comm" && runCommand === run) {
      await installTbToolsCommitMsgHook({
        cwd: graphPath,
        runCommand,
      }).catch(() => {});
    }

    return {
      label,
      path: graphPath,
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
  graph: checkoutGraph,
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
  const graph = checkoutGraph || { path: cwd };

  if (!includeWorkingTree || Number(offset) !== 0) {
    const commits = await attachGraphTryRunsToCommits({
      graph,
      commits: gitCommits,
      runCommand,
    });

    return {
      commits,
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
  const commits = await attachGraphTryRunsToCommits({
    graph,
    commits: insertWorkingTreeCommitsNearParent(gitCommits, workingTree.commits),
    runCommand,
  });

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
    const graphPath = root.trim() || absolutePath;

    if (label === "comm" && runCommand === run) {
      await installTbToolsCommitMsgHook({
        cwd: graphPath,
        runCommand,
      }).catch(() => {});
    }

    const gitCommits = parseGitLog(log);
    const workingTree = await getWorkingTreeCommits({
      cwd: absolutePath,
      parentHash: getCheckedOutCommitHash(gitCommits, headHash) || gitCommits[0]?.hash || "",
      diffs,
      maxDiffBytes,
      runCommand,
    });
    const commits = await attachGraphTryRunsToCommits({
      graph: { path: graphPath },
      commits: pruneMissingParents(insertWorkingTreeCommitsNearParent(gitCommits, workingTree.commits)),
      runCommand,
    });
    const commitDiffs = diffs
      ? {
          ...workingTree.diffs,
          ...await getCommitDiffs({ cwd: absolutePath, commits: gitCommits, maxDiffBytes, runCommand }),
        }
      : {};

    return {
      label,
      path: graphPath,
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
