import { readFile } from "node:fs/promises";
import path from "node:path";

export async function getRepositoryMilestone(repositoryPath) {
  const versionPath = path.join(repositoryPath, "mail", "config", "version.txt");
  const version = (await readFile(versionPath, "utf8")).trim();
  const majorVersion = version.split(".")[0];

  if (!/^\d+$/.test(majorVersion)) {
    throw new Error(`Cannot determine the target milestone from ${versionPath}.`);
  }

  return `${majorVersion} Branch`;
}
