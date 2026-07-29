import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRAPH_CLIENT_SCRIPTS,
  GRAPH_CLIENT_STYLESHEETS,
} from "./constants.mjs";

export function getGraphClientAssetPath(asset) {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "client",
    asset.source
  );
}

export function getGraphClientScriptPath(script) {
  return getGraphClientAssetPath(script);
}

export function getGraphClientStylesheetPath(stylesheet = GRAPH_CLIENT_STYLESHEETS[0]) {
  return getGraphClientAssetPath(stylesheet);
}

export function getGraphHtmlStyles({ readStyle = readFileSync } = {}) {
  return readStyle(getGraphClientStylesheetPath(), "utf8");
}

export function getGraphOutputPath(output) {
  return output ? path.resolve(output) : path.join(os.tmpdir(), "tb-tools-branch-graph.html");
}

export async function writeGraphClientAssets({
  outputPath,
  readBundle = readFile,
  write = writeFile,
  makeDir = mkdir,
}) {
  const madeDirs = new Set();

  for (const asset of [...GRAPH_CLIENT_STYLESHEETS, ...GRAPH_CLIENT_SCRIPTS]) {
    const targetPath = path.join(path.dirname(outputPath), asset.output);
    const targetDir = path.dirname(targetPath);

    if (!madeDirs.has(targetDir)) {
      await makeDir(targetDir, { recursive: true });
      madeDirs.add(targetDir);
    }
    await write(
      targetPath,
      await readBundle(getGraphClientAssetPath(asset), "utf8")
    );
  }
}
