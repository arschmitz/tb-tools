import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export function createDiffCommand({
  runCommand = run,
  getCommand = getPrettyDiffCommand,
} = {}) {
  return async function diff(args = []) {
    const options = parseDiffArgs(args);

    await runCommand({
      cmd: getCommand({ publish: options.publish }),
      args: options.args,
    });
  };
}

export default createDiffCommand();
