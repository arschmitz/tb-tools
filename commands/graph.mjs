import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import openUrl from "open";
import { run } from "../lib/utils.mjs";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";
const DEFAULT_MAX_DIFF_BYTES = 200000;

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

export function choosePruneBranches(refsOutput = "", currentBranch = "") {
  return refsOutput
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean)
    .filter((branch) => branch !== currentBranch);
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

  const diffClasses = {
    d: "file",
    i: "file",
    "@": "info",
    "-": "delete",
    "+": "insert",
    " ": "context",
  };

  return Object.entries(files).map(([file, lines]) => {
    const diffLines = lines.map((line) => {
      const type = line.charAt(0);
      const className = diffClasses[type] || "context";
      return `<pre class="${className}">${escapeDiffHtml(line)}</pre>`;
    }).join("\n");

    return `<section class="pretty-file">
      <h3>
        <span class="title">${escapeDiffHtml(file)}</span>
        <button class="copy-path" type="button" data-path="${escapeHtml(file)}">copy path</button>
      </h3>
      <div class="file-diff">${diffLines}</div>
    </section>`;
  }).join("\n");
}

export function truncateDiff(diff, maxDiffBytes = DEFAULT_MAX_DIFF_BYTES) {
  const maxBytes = Number(maxDiffBytes);
  const fullHtml = formatPrettyDiffHtml(diff);

  if (!maxBytes || maxBytes < 1 || Buffer.byteLength(diff, "utf8") <= maxBytes) {
    return {
      text: diff,
      html: fullHtml,
      truncated: false,
    };
  }

  const truncatedText = `${Buffer.from(diff).subarray(0, maxBytes).toString("utf8")}\n\n[diff truncated at ${maxBytes} bytes]`;

  return {
    text: truncatedText,
    html: `${formatPrettyDiffHtml(truncatedText)}<pre class="info">[diff truncated at ${maxBytes} bytes]</pre>`,
    truncated: true,
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
      const diff = await runCommand({
        cmd: "git",
        args: getGitShowArgs(commit.hash),
        cwd,
        capture: true,
        silent: true,
      });

      diffs[commit.hash] = truncateDiff(diff, maxDiffBytes);
    } catch (error) {
      diffs[commit.hash] = {
        text: "",
        truncated: false,
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
  runCommand = run,
}) {
  const output = await runCommand({
    cmd: "git",
    args: getGitLogArgs(limit, offset),
    cwd,
    capture: true,
    silent: true,
  });
  const commits = parseGitLog(output);

  return {
    commits,
    offset,
    nextOffset: offset + commits.length,
    hasMore: commits.length === Number(limit),
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
    const [root, branch, log] = await Promise.all([
      runCommand({ cmd: "git", args: ["rev-parse", "--show-toplevel"], cwd: absolutePath, capture: true, silent: true }),
      runCommand({ cmd: "git", args: ["branch", "--show-current"], cwd: absolutePath, capture: true, silent: true }),
      runCommand({ cmd: "git", args: getGitLogArgs(limit), cwd: absolutePath, capture: true, silent: true }),
    ]);

    const commits = pruneMissingParents(parseGitLog(log));
    const commitDiffs = diffs
      ? await getCommitDiffs({ cwd: absolutePath, commits, maxDiffBytes, runCommand })
      : {};

    return {
      label,
      path: root.trim() || absolutePath,
      branch: branch.trim() || "(detached)",
      limit,
      commits,
      commitCount: commits.length,
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
  await ensureCleanGraph(graph, runCommand);

  const branchRefs = await getLocalBranchesAtCommit(graph, hash, runCommand);
  const branch = chooseCheckoutBranch(branchRefs, graph.branch);
  const target = branch || hash;

  await runCommand({
    cmd: "git",
    args: ["rebase", target],
    cwd: graph.path,
    silent: true,
  });

  const currentHash = (await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: graph.path,
    capture: true,
    silent: true,
  })).trim();

  return {
    action: "rebase",
    label: graph.label,
    path: graph.path,
    hash,
    target,
    currentHash,
    message: `${graph.label} rebased onto ${branch ? `branch ${branch}` : hash.slice(0, 12)}.`,
  };
}

export async function pruneCommitBranches({
  graph,
  hash,
  runCommand = run,
}) {
  ensureKnownGraphCommit(graph, hash);
  await ensureCleanGraph(graph, runCommand);

  const [currentBranch, branchRefs] = await Promise.all([
    getCurrentGraphBranch(graph, runCommand),
    getLocalBranchesAtCommit(graph, hash, runCommand),
  ]);
  const branches = choosePruneBranches(branchRefs, currentBranch);

  if (!branches.length) {
    const error = new Error(currentBranch && branchRefs.split("\n").map((branch) => branch.trim()).includes(currentBranch)
      ? `Cannot prune ${currentBranch} because it is currently checked out.`
      : `No local branch tips found at ${hash.slice(0, 12)}.`);
    error.statusCode = 409;
    throw error;
  }

  for (const branch of branches) {
    await runCommand({
      cmd: "git",
      args: ["branch", "-d", "--", branch],
      cwd: graph.path,
      silent: true,
    });
  }

  return {
    action: "prune",
    label: graph.label,
    path: graph.path,
    hash,
    branches,
    message: `${graph.label} pruned ${branches.length === 1 ? "branch" : "branches"} ${branches.join(", ")} at ${hash.slice(0, 12)}.`,
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
      <div class="summary">
        <strong>${escapeHtml(graph.label)}</strong>
        <span>${escapeHtml(graph.path)}</span>
        <span>${escapeHtml(graph.branch || "")}</span>
        <span>${graph.commitCount} commit(s)</span>
      </div>
      <div class="workspace">
        <div class="graph" id="graph-${index}"></div>
        <aside class="diff-viewer" id="diff-${index}">
          <div class="diff-header">
            <strong class="diff-title">No commit selected</strong>
            <span class="diff-meta"></span>
            <button class="checkout-commit" type="button" hidden>Checkout</button>
            <span class="checkout-status"></span>
          </div>
          <pre class="diff-body">Select a commit in the graph.</pre>
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
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
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
    .workspace { display: grid; grid-template-columns: minmax(360px, 1fr) minmax(400px, 46vw); gap: 10px; align-items: start; }
    .graph, .diff-viewer { background: #fff; border: 1px solid #d6dae1; border-radius: 8px; overflow: auto; }
    .graph { padding: 10px; min-height: 220px; }
    .diff-viewer { max-height: calc(100vh - 112px); position: sticky; top: 78px; }
    .diff-header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid #d6dae1; }
    .diff-title { font-size: 13px; }
    .diff-meta { color: #59616d; font-size: 12px; }
    .checkout-commit, .load-more { border: 1px solid #1f5f9f; border-radius: 4px; background: #1f5f9f; color: #fff; cursor: pointer; font-size: 12px; padding: 4px 8px; }
    .checkout-commit:disabled, .load-more:disabled { cursor: wait; opacity: 0.65; }
    .checkout-status, .graph-status { color: #59616d; font-size: 12px; }
    .checkout-status.error, .graph-status.error { color: #9b1c1c; }
    .diff-body, .error { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.38; white-space: pre-wrap; }
    .diff-body { margin: 0; padding: 10px; tab-size: 2; }
    .load-sentinel { block-size: 1px; inline-size: 100%; }
    .graph svg { overflow: visible; }
    .commit-row, .commit-row * { cursor: pointer; }
    .commit-row:focus { outline: none; }
    .commit-row-hitbox { fill: transparent; pointer-events: all; transition: fill 120ms ease, stroke 120ms ease; }
    .commit-row.hover .commit-row-hitbox, .commit-row:focus-visible .commit-row-hitbox { fill: rgba(31, 95, 159, 0.08); }
    .commit-row.active .commit-row-hitbox { fill: rgba(31, 95, 159, 0.14); stroke: rgba(31, 95, 159, 0.35); stroke-width: 1; }
    .commit-row.active.hover .commit-row-hitbox { fill: rgba(31, 95, 159, 0.18); }
    .commit-row.current .commit-row-hitbox { fill: rgba(245, 158, 11, 0.18); stroke: rgba(180, 83, 9, 0.35); stroke-width: 1; }
    .commit-row.current.hover .commit-row-hitbox { fill: rgba(245, 158, 11, 0.24); }
    .commit-row.current.active .commit-row-hitbox { fill: rgba(245, 158, 11, 0.3); stroke: rgba(31, 95, 159, 0.48); }
    .context-menu { background: #fff; border: 1px solid #b9c0cc; border-radius: 6px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.18); color: #20242a; min-width: 160px; padding: 4px; position: fixed; z-index: 5; }
    .context-menu[hidden] { display: none; }
    .context-menu-title { color: #59616d; font-size: 12px; max-width: 260px; overflow: hidden; padding: 6px 8px 4px; text-overflow: ellipsis; white-space: nowrap; }
    .context-menu button { background: transparent; border: 0; border-radius: 4px; color: inherit; cursor: pointer; display: block; font: inherit; padding: 7px 8px; text-align: left; width: 100%; }
    .context-menu button:hover, .context-menu button:focus { background: rgba(31, 95, 159, 0.1); outline: none; }
    .context-menu button[data-action="prune"] { color: #9b1c1c; }
    .pretty-file { margin: 0 0 10px; }
    .pretty-file h3 { align-items: center; background: linear-gradient(#fafafa, #eaeaea); border: 1px solid #d8d8d8; border-bottom: 0; color: #555; display: flex; font: 13px sans-serif; justify-content: space-between; margin: 0; overflow: hidden; padding: 7px 6px; text-shadow: 0 1px 0 white; }
    .pretty-file .title { margin-left: 0.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .copy-path { border: 1px solid #c4c8d0; border-radius: 4px; background: #fff; color: #20242a; cursor: pointer; font-size: 12px; padding: 4px 8px; }
    .file-diff { border: 1px solid #d8d8d8; overflow: auto; padding: 0.25em 0; }
    .file-diff pre { margin: 0; text-indent: 0.5em; }
    .file { color: #8b949e; }
    .delete { background-color: #fdd; }
    .insert { background-color: #dfd; }
    .info { color: #a0b; }
    .error { color: #9b1c1c; }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
      .diff-viewer { position: static; max-height: none; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111418; color: #f1f3f6; }
      header, .summary, .graph, .diff-viewer, .tab { background: #191d23; color: #f1f3f6; border-color: #323844; }
      .summary span, .diff-meta { color: #acb4c0; }
      .diff-header { border-color: #323844; }
      .pretty-file h3 { background: linear-gradient(#252b35, #1f242d); border-color: #323844; color: #d7dce4; text-shadow: none; }
      .copy-path { background: #111418; border-color: #424b59; color: #f1f3f6; }
      .checkout-commit, .load-more { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .checkout-status, .graph-status { color: #acb4c0; }
      .checkout-status.error, .graph-status.error { color: #ff9f9f; }
      .file-diff { border-color: #323844; }
      .delete { background-color: #5a2026; }
      .insert { background-color: #1f4b2b; }
      .info { color: #d19cff; }
      .tab.active { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .commit-row.hover .commit-row-hitbox, .commit-row:focus-visible .commit-row-hitbox { fill: rgba(75, 158, 255, 0.12); }
      .commit-row.active .commit-row-hitbox { fill: rgba(75, 158, 255, 0.2); stroke: rgba(75, 158, 255, 0.42); }
      .commit-row.active.hover .commit-row-hitbox { fill: rgba(75, 158, 255, 0.26); }
      .commit-row.current .commit-row-hitbox { fill: rgba(251, 191, 36, 0.22); stroke: rgba(251, 191, 36, 0.42); }
      .commit-row.current.hover .commit-row-hitbox { fill: rgba(251, 191, 36, 0.28); }
      .commit-row.current.active .commit-row-hitbox { fill: rgba(251, 191, 36, 0.34); stroke: rgba(75, 158, 255, 0.55); }
      .context-menu { background: #191d23; border-color: #424b59; color: #f1f3f6; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42); }
      .context-menu-title { color: #acb4c0; }
      .context-menu button:hover, .context-menu button:focus { background: rgba(75, 158, 255, 0.16); }
      .context-menu button[data-action="prune"] { color: #ff9f9f; }
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
  <script>${gitgraphScript}</script>
  <script>
    const GRAPHS = ${safeScriptJson(graphs)};
    const INTERACTIVE = ${safeScriptJson({
      enabled: Boolean(interactive.enabled),
      pageSize: interactive.pageSize || 80,
      token: interactive.token,
    })};
    const SVG_NS = "http://www.w3.org/2000/svg";
    const COMMIT_DOT_RADIUS = 10;
    const COMMIT_ROW_HEIGHT = 28;
    const COMMIT_ROW_HORIZONTAL_INSET = 4;

    const graphStates = GRAPHS.map((graph) => ({
      graph,
      commits: graph.commits ? [...graph.commits] : [],
      offset: graph.commits ? graph.commits.length : 0,
      hasMore: Boolean(INTERACTIVE.enabled),
      loading: false,
      gitgraph: null,
      rendered: false,
      sentinelReady: true,
      lastScrollY: window.scrollY,
      scrolledTowardBottom: false,
      selectedHash: "",
      currentHash: getCurrentCommitHash(graph.commits || []),
    }));
    const contextMenu = document.getElementById("commit-context-menu");
    let contextMenuState = null;

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

    function getGraphContainer(index) {
      return document.getElementById("graph-" + index);
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

    function getCommitForMessage(text, commits) {
      const abbrev = (text.textContent || "").split(" ")[0];

      return commits.find((commit) => commit.hash.substring(0, 7) === abbrev);
    }

    function isCurrentCommit(commit) {
      return Array.isArray(commit.refs) && commit.refs.includes("HEAD");
    }

    function getCurrentCommitHash(commits) {
      return commits.find(isCurrentCommit)?.hash || "";
    }

    function hideCommitContextMenu() {
      contextMenu.hidden = true;
      contextMenuState = null;
    }

    function showCommitContextMenu(event, index, commit) {
      if (!INTERACTIVE.enabled) {
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

    function ensureGitgraph(index) {
      const state = graphStates[index];

      if (state.gitgraph) {
        return state.gitgraph;
      }

      const container = getGraphContainer(index);
      container.replaceChildren();
      state.gitgraph = GitgraphJS.createGitgraph(container, {
        template: GitgraphJS.templateExtend(GitgraphJS.TemplateName.Metro, {
          branch: {
            spacing: 24,
            label: {
              borderRadius: 4,
              font: "normal 10px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
            },
          },
          commit: {
            spacing: 30,
            dot: {
              // GitGraph's dot size is a radius; 10 renders as a 20px dot.
              size: COMMIT_DOT_RADIUS,
              strokeColor: "#ffffff",
              strokeWidth: 2,
            },
            message: { font: "normal 16px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" },
          },
        }),
      });

      return state.gitgraph;
    }

    function renderLoadedGraph(index) {
      const state = graphStates[index];
      const gitgraph = ensureGitgraph(index);

      if (!state.commits.length) {
        setGraphStatus(index, state.loading ? "Loading commits..." : "No commits found.");
        return;
      }

      const commits = pruneLoadedParents(state.commits).map((commit) => ({
        ...commit,
        onClick: () => showDiff(state.graph, index, commit),
        onMessageClick: () => showDiff(state.graph, index, commit),
      }));

      gitgraph.import(commits);
      scheduleGraphEnhancements(index);
      state.rendered = true;
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

        state.commits.push(...result.commits);
        state.offset = result.nextOffset;
        state.hasMore = result.hasMore;
        renderLoadedGraph(index);
      } catch (error) {
        setGraphStatus(index, error && error.message ? error.message : String(error), { error: true });
      } finally {
        state.loading = false;
      }
    }

    async function showDiff(graph, index, commit) {
      const viewer = document.getElementById("diff-" + index);
      const title = viewer.querySelector(".diff-title");
      const meta = viewer.querySelector(".diff-meta");
      const body = viewer.querySelector(".diff-body");
      const checkoutButton = viewer.querySelector(".checkout-commit");
      const checkoutStatus = viewer.querySelector(".checkout-status");
      const diff = graph.diffs && graph.diffs[commit.hash];

      graphStates[index].selectedHash = commit.hash;
      updateCommitRowStates(index);

      title.textContent = commit.hash.substring(0, 12) + " " + commit.subject;
      meta.textContent = commit.author.name + " <" + commit.author.email + ">";
      checkoutButton.hidden = !INTERACTIVE.enabled;
      checkoutButton.disabled = false;
      checkoutButton.dataset.graphIndex = String(index);
      checkoutButton.dataset.hash = commit.hash;
      checkoutButton.dataset.label = graph.label;
      checkoutStatus.classList.remove("error");
      checkoutStatus.textContent = "";

      if (INTERACTIVE.enabled) {
        body.textContent = "Loading diff...";

        try {
          const response = await fetch(
            "/api/graph/" + index + "/diff/" + encodeURIComponent(commit.hash) +
              "?token=" + encodeURIComponent(INTERACTIVE.token)
          );
          const result = await response.json();

          if (!response.ok) {
            throw new Error(result.error || response.statusText);
          }

          if (result.html) {
            body.innerHTML = result.html;
          } else {
            body.textContent = result.text || "No diff for this commit.";
          }
        } catch (error) {
          body.textContent = error && error.message ? error.message : String(error);
        }

        return;
      }

      if (!diff) {
        body.textContent = "Diff data was not embedded for this commit.";
        return;
      }

      if (diff.error) {
        body.textContent = diff.error;
        return;
      }

      if (diff.html) {
        body.innerHTML = diff.html;
        return;
      }

      body.textContent = diff.text || "No diff for this commit.";
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
          confirm: "Rebase " + label + " onto " + shortHash + "?",
          progress: "Rebasing...",
        };
      }

      if (action === "prune") {
        return {
          confirm: "Prune local branch tips at " + shortHash + " in " + label + "?",
          progress: "Pruning...",
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
          }),
        });
        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || response.statusText);
        }

        status.textContent = result.message;
        if (result.currentHash) {
          graphStates[graphIndex].currentHash = result.currentHash;
        } else if (action === "checkout") {
          graphStates[graphIndex].currentHash = hash;
        }
        updateCommitRowStates(graphIndex);
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

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".context-menu")) {
        hideCommitContextMenu();
      }

      const checkoutButton = event.target.closest(".checkout-commit");
      if (checkoutButton) {
        checkoutSelectedCommit(checkoutButton);
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
        ensureGitgraph(index);

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

      if (!graph.commits.length) {
        container.textContent = "No commits found.";
        state.rendered = true;
        return;
      }

      try {
        const gitgraph = ensureGitgraph(index);
        const commits = graph.commits.map((commit) => ({
          ...commit,
          onClick: () => showDiff(graph, index, commit),
          onMessageClick: () => showDiff(graph, index, commit),
        }));

        gitgraph.import(commits);
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
      renderGraph(index);
    }

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => showTab(Number(tab.dataset.index)));
    });

    window.addEventListener("scroll", trackScrollDirection, { passive: true });

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

      window.addEventListener("pagehide", () => {
        clearInterval(heartbeat);
        sendCloseSignal();
      }, { once: true });
      window.addEventListener("beforeunload", sendCloseSignal, { once: true });
    }

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

export async function startInteractiveGraphServer({
  html,
  graphs,
  token,
  pageSize = 80,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  port = 0,
  host = "127.0.0.1",
  heartbeatIntervalMs = 2000,
  heartbeatTimeoutMs = 8000,
  runCommand = run,
  serverFactory = createServer,
}) {
  const serverGraphs = graphs.map((graph) => ({
    ...graph,
    knownHashes: new Set(),
  }));
  const sockets = new Set();
  let closeTimer;
  let lastHeartbeat;
  let shuttingDown = false;
  const heartbeatTimer = setInterval(() => {
    if (lastHeartbeat && Date.now() - lastHeartbeat > heartbeatTimeoutMs) {
      shutdown(0);
    }
  }, heartbeatIntervalMs);

  function shutdown(delay = 0) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
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
          runCommand,
        });

        page.commits.forEach((commit) => graph.knownHashes.add(commit.hash));
        sendJson(response, 200, { ok: true, ...page });
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
        sendJson(response, 200, { ok: true, ...result });
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
        sendJson(response, 200, { ok: true, ...result });
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
        shutdown(50);
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

export function waitForInteractiveServerClose(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    const close = () => {
      if (server.listening) {
        server.close();
      }
    };
    const cleanup = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      resolve();
    };

    server.once("close", cleanup);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
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

      await waitForClose(graphServer.server);
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
