import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CACHE_FILE_NAME = "phabricator-cache.json";
const CACHE_VERSION = 1;

export function getPhabricatorCachePath(cachePath) {
  if (cachePath) {
    return cachePath;
  }

  if (process.env.TB_TOOLS_PHAB_CACHE_PATH) {
    return process.env.TB_TOOLS_PHAB_CACHE_PATH;
  }

  if (
    process.env.TB_TOOLS_DISABLE_PERSISTENT_PHAB_STATE === "1" ||
    process.env.NODE_TEST_CONTEXT ||
    globalThis.__tbToolsBlockExternalApis
  ) {
    return "";
  }

  return path.join(os.homedir(), ".tb-tools", CACHE_FILE_NAME);
}

function normalizeEntries(entries) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(entries).filter(([key, value]) => (
      key && value && typeof value === "object" && !Array.isArray(value)
    )),
  );
}

function normalizeStore(store) {
  return {
    responses: normalizeEntries(store?.responses),
    usersByPhid: normalizeEntries(store?.usersByPhid),
    version: CACHE_VERSION,
  };
}

export async function readPhabricatorCache({ cachePath } = {}) {
  const resolvedPath = getPhabricatorCachePath(cachePath);

  if (!resolvedPath) {
    return { responses: {}, usersByPhid: {}, version: CACHE_VERSION };
  }

  try {
    return normalizeStore(JSON.parse(await readFile(resolvedPath, "utf8")));
  } catch {
    return { responses: {}, usersByPhid: {}, version: CACHE_VERSION };
  }
}

export async function writePhabricatorCache({ cachePath, store } = {}) {
  const resolvedPath = getPhabricatorCachePath(cachePath);

  if (!resolvedPath) {
    return;
  }

  const normalized = normalizeStore(store);
  const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(normalized), "utf8");
    await rename(temporaryPath, resolvedPath);
  } catch {
    // Caching must never make Phabricator access less reliable.
  }
}
