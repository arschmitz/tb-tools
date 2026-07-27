import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import openUrl from "open";
import {
  formatChangeCountLabel,
  formatPrettyDiffHtml,
  getDiffChangeCounts,
} from "./graph/diff-renderer.mjs";
import { getGraphHtmlStyles } from "./graph/templates.mjs";
import { run } from "../lib/utils.mjs";

export function getPrettyDiffCommand({
  publish = false,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const bin = publish ? "gist-diff" : "pretty-diff";
  const extension = platform === "win32" ? ".cmd" : "";
  const commandPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    ".bin",
    `${bin}${extension}`
  );

  return exists(commandPath) ? commandPath : bin;
}

export function parseDiffArgs(args = []) {
  const diffArgs = [];
  let publish = false;

  for (const arg of args) {
    if (arg === "--gist" || arg === "--publish" || arg === "-g") {
      publish = true;
      continue;
    }

    if (arg === "--public") {
      publish = true;
    }

    diffArgs.push(arg);
  }

  return {
    args: diffArgs,
    publish,
  };
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function getDiffOutputPath({
  output,
  tmpdir = os.tmpdir(),
  now = Date.now,
} = {}) {
  if (output) {
    return path.resolve(output);
  }

  return path.join(tmpdir, `tb-diff-${now()}.html`);
}

export function buildDiffHtml({
  diff = "",
  args = [],
} = {}) {
  const { insertions, deletions } = getDiffChangeCounts(diff);
  const diffHtml = formatPrettyDiffHtml(diff);
  const title = "TB Tools Diff";
  const command = ["git", "diff", ...args].join(" ");
  const statsLabel = formatChangeCountLabel(insertions, deletions);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
${getGraphHtmlStyles()}
    .diff-page .diff-viewer { max-height: none; position: static; }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
  </header>
  <main class="diff-page">
    <aside class="diff-viewer">
      <div class="diff-header">
        <strong class="diff-title">${escapeHtml(command)}</strong>
        <span class="diff-stats" aria-label="${statsLabel}">
          <span class="stat-additions">+${insertions}</span>
          <span class="stat-deletions">-${deletions}</span>
        </span>
      </div>
      <div class="diff-body">${diffHtml || "<pre class=\"diff-placeholder\">No diff.</pre>"}</div>
    </aside>
  </main>
</body>
</html>`;
}

export function createDiffCommand({
  runCommand = run,
  getCommand = getPrettyDiffCommand,
  write = writeFile,
  makeDir = mkdir,
  open = openUrl,
  getOutputPath = getDiffOutputPath,
  cwd = () => process.cwd(),
} = {}) {
  return async function diff(args = []) {
    const options = parseDiffArgs(args);

    if (options.publish) {
      await runCommand({
        cmd: getCommand({ publish: true }),
        args: options.args,
      });
      return undefined;
    }

    const workingDirectory = typeof cwd === "function" ? cwd() : cwd;
    const diffText = await runCommand({
      cmd: "git",
      args: ["diff", ...options.args],
      cwd: workingDirectory,
      capture: true,
      silent: true,
    });
    const outputPath = getOutputPath();

    await makeDir(path.dirname(outputPath), { recursive: true });
    await write(outputPath, buildDiffHtml({
      diff: diffText,
      args: options.args,
    }));
    await open(outputPath);

    return outputPath;
  };
}

export default createDiffCommand();
