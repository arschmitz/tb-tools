import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES_PER_USER = 1000;

function getCachePath(cachePath) {
  if (cachePath) {
    return cachePath;
  }

  if (process.env.TB_TOOLS_DASHBOARD_TIMELINE_CACHE_PATH) {
    return process.env.TB_TOOLS_DASHBOARD_TIMELINE_CACHE_PATH;
  }

  if (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis) {
    return "";
  }

  return path.join(os.homedir(), ".tb-tools", "phabricator-dashboard-timelines.json");
}

function getUserKey(currentUserPhid) {
  return String(currentUserPhid || "").trim();
}

function normalizeTimestamp(value) {
  const timestamp = Number(value || 0);

  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function normalizeTimeline(timeline = {}) {
  return {
    currentReviewEventCount: Math.max(0, Number(timeline.currentReviewEventCount) || 0),
    latestCurrentReviewAt: normalizeTimestamp(timeline.latestCurrentReviewAt),
    latestOtherCommentAt: normalizeTimestamp(timeline.latestOtherCommentAt),
    latestPatchUpdateAt: normalizeTimestamp(timeline.latestPatchUpdateAt),
    latestReviewAt: normalizeTimestamp(timeline.latestReviewAt),
    latestReviewRequestAt: normalizeTimestamp(timeline.latestReviewRequestAt),
    latestYourAcceptanceAt: normalizeTimestamp(timeline.latestYourAcceptanceAt),
    latestYourCommentAt: normalizeTimestamp(timeline.latestYourCommentAt),
    latestYourRequestChangesAt: normalizeTimestamp(timeline.latestYourRequestChangesAt),
  };
}

function normalizeEntry(entry = {}) {
  const dateModified = normalizeTimestamp(entry.dateModified);

  if (!dateModified || !entry.timeline || typeof entry.timeline !== "object") {
    return null;
  }

  return {
    checkedAt: normalizeTimestamp(entry.checkedAt),
    dateModified,
    timeline: normalizeTimeline(entry.timeline),
  };
}

function normalizeEntries(entries = {}) {
  return Object.fromEntries(
    Object.entries(entries)
      .map(([revisionId, entry]) => [String(revisionId), normalizeEntry(entry)])
      .filter(([revisionId, entry]) => revisionId && entry),
  );
}

function limitEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, first], [, second]) => second.checkedAt - first.checkedAt)
      .slice(0, MAX_ENTRIES_PER_USER),
  );
}

async function readTimelineStore(resolvedPath) {
  try {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch {
    return { entries: {}, version: 1 };
  }
}

export async function getDashboardTimelineCacheStatus({ cachePath } = {}) {
  const resolvedPath = getCachePath(cachePath);

  if (!resolvedPath) {
    return { entries: 0, enabled: false, path: "", users: 0 };
  }

  const store = await readTimelineStore(resolvedPath);
  const entriesByUser = Object.values(store?.entries || {});

  return {
    entries: entriesByUser.reduce((total, entries) => (
      total + Object.keys(normalizeEntries(entries)).length
    ), 0),
    enabled: true,
    path: resolvedPath,
    users: entriesByUser.length,
  };
}

export async function clearDashboardTimelineCache({
  cachePath,
  currentUserPhid,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const userKey = getUserKey(currentUserPhid);

  if (!resolvedPath) {
    return getDashboardTimelineCacheStatus({ cachePath });
  }

  const store = await readTimelineStore(resolvedPath);

  if (userKey) {
    delete store.entries?.[userKey];
  } else {
    store.entries = {};
  }

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify({
      ...store,
      entries: store.entries || {},
      version: 1,
    }), "utf8");
  } catch {
    // A cache clear must not block normal dashboard operation.
  }

  return getDashboardTimelineCacheStatus({ cachePath });
}

export async function loadDashboardTimelineCache({
  cachePath,
  currentUserPhid,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const userKey = getUserKey(currentUserPhid);

  if (!resolvedPath || !userKey) {
    return {};
  }

  try {
    const store = await readTimelineStore(resolvedPath);

    return normalizeEntries(store?.entries?.[userKey]);
  } catch {
    return {};
  }
}

export async function saveDashboardTimelineCache({
  cachePath,
  currentUserPhid,
  entries,
  now = Date.now(),
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const userKey = getUserKey(currentUserPhid);

  if (!resolvedPath || !userKey) {
    return;
  }

  let store = await readTimelineStore(resolvedPath);

  const existing = normalizeEntries(store?.entries?.[userKey]);
  const updates = Object.fromEntries(
    Object.entries(entries || {})
      .map(([revisionId, entry]) => {
        const normalized = normalizeEntry(entry);

        if (!normalized) {
          return [String(revisionId), null];
        }

        return [String(revisionId), {
          ...normalized,
          checkedAt: normalizeTimestamp(now),
        }];
      })
      .filter(([revisionId, entry]) => revisionId && entry),
  );

  store = {
    ...store,
    entries: {
      ...(store?.entries || {}),
      [userKey]: limitEntries({ ...existing, ...updates }),
    },
    version: 1,
  };

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(store), "utf8");
  } catch {
    // The in-process dashboard still works if the durable cache cannot be saved.
  }
}
