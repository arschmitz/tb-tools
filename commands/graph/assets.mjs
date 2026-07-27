import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_CLIENT_SCRIPTS } from "./constants.mjs";

export function getGraphClientScriptPath(script) {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "client",
    script.source
  );
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

  for (const script of GRAPH_CLIENT_SCRIPTS) {
    const targetPath = path.join(path.dirname(outputPath), script.output);
    const targetDir = path.dirname(targetPath);

    if (!madeDirs.has(targetDir)) {
      await makeDir(targetDir, { recursive: true });
      madeDirs.add(targetDir);
    }
    await write(
      targetPath,
      await readBundle(getGraphClientScriptPath(script), "utf8")
    );
  }
}
