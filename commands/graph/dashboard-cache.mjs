import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CACHE_FILE_NAME = "phabricator-dashboard.json";
const CACHE_VERSION = 1;

function getCachePath(cachePath) {
  if (cachePath) {
    return cachePath;
  }

  if (process.env.TB_TOOLS_DASHBOARD_CACHE_PATH) {
    return process.env.TB_TOOLS_DASHBOARD_CACHE_PATH;
  }

  if (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis) {
    return "";
  }

  return path.join(os.homedir(), ".tb-tools", CACHE_FILE_NAME);
}

function getUserKey(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeTimestamp(value) {
  const timestamp = Number(value || 0);

  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function normalizeEntry(entry = {}) {
  if (!entry?.result || typeof entry.result !== "object" || Array.isArray(entry.result)) {
    return null;
  }

  const checkedAt = normalizeTimestamp(entry.checkedAt);

  return checkedAt ? { checkedAt, result: entry.result } : null;
}

async function readStore(cachePath) {
  try {
    const store = JSON.parse(await readFile(cachePath, "utf8"));

    return {
      entries: store?.entries && typeof store.entries === "object" ? store.entries : {},
      version: CACHE_VERSION,
    };
  } catch {
    return { entries: {}, version: CACHE_VERSION };
  }
}

export async function getDashboardCacheStatus({ cachePath } = {}) {
  const resolvedPath = getCachePath(cachePath);

  if (!resolvedPath) {
    return { enabled: false, entries: 0, path: "" };
  }

  const store = await readStore(resolvedPath);
  const entries = Object.values(store.entries)
    .map(normalizeEntry)
    .filter(Boolean);

  return { enabled: true, entries: entries.length, path: resolvedPath };
}

export async function loadDashboardCache({ cachePath, username } = {}) {
  const resolvedPath = getCachePath(cachePath);
  const userKey = getUserKey(username);

  if (!resolvedPath || !userKey) {
    return null;
  }

  return normalizeEntry((await readStore(resolvedPath)).entries[userKey]);
}

export async function saveDashboardCache({
  cachePath,
  now = Date.now(),
  result,
  username,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const userKey = getUserKey(username);
  const entry = normalizeEntry({ checkedAt: now, result });

  if (!resolvedPath || !userKey || !entry) {
    return;
  }

  try {
    const store = await readStore(resolvedPath);
    const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;

    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify({
      ...store,
      entries: { ...store.entries, [userKey]: entry },
      version: CACHE_VERSION,
    }), "utf8");
    await rename(temporaryPath, resolvedPath);
  } catch {
    // Dashboard caching must not interfere with the live dashboard.
  }
}

export async function clearDashboardCache({ cachePath, username } = {}) {
  const resolvedPath = getCachePath(cachePath);
  const userKey = getUserKey(username);

  if (!resolvedPath) {
    return getDashboardCacheStatus({ cachePath });
  }

  try {
    const store = await readStore(resolvedPath);

    if (userKey) {
      delete store.entries[userKey];
    } else {
      store.entries = {};
    }

    const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;

    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify({ ...store, version: CACHE_VERSION }), "utf8");
    await rename(temporaryPath, resolvedPath);
  } catch {
    // A cache clear must never block the user from using the console.
  }

  return getDashboardCacheStatus({ cachePath });
}
