import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function clearReviewerGroupCache({ cachePath } = {}) {
  const resolvedPath = getCachePath(cachePath);
  if (resolvedPath) await rm(resolvedPath, { force: true });
}

function getCachePath(cachePath) {
  if (cachePath) {
    return cachePath;
  }

  if (process.env.TB_TOOLS_REVIEWER_GROUP_CACHE_PATH) {
    return process.env.TB_TOOLS_REVIEWER_GROUP_CACHE_PATH;
  }

  if (process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis) {
    return "";
  }

  return path.join(os.homedir(), ".tb-tools", "phabricator-reviewer-groups.json");
}

function getUsernameKey(username) {
  return String(username || "").trim().toLowerCase();
}

function getGroupKey(reviewGroup) {
  return String(reviewGroup || "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();
}

function normalizeCurrentUser(currentUser = {}) {
  const phid = String(currentUser.phid || "").trim();

  if (!phid) {
    return null;
  }

  return {
    phid,
    realName: String(currentUser.realName || "").trim(),
    userName: String(currentUser.userName || currentUser.username || "").trim(),
  };
}

function normalizeGroups(groups = []) {
  return groups
    .map((group) => ({
      name: String(group?.name || group?.slug || group?.phid || "").trim(),
      phid: String(group?.phid || "").trim(),
      slug: String(group?.slug || "").trim(),
    }))
    .filter((group) => group.phid);
}

function normalizeAssignees(assignees = []) {
  return assignees
    .map((assignee) => ({
      email: String(assignee?.email || "").trim(),
      name: String(assignee?.name || "").trim(),
    }))
    .filter((assignee) => assignee.email);
}

function normalizeEntry(entry) {
  const currentUser = normalizeCurrentUser(entry?.currentUser);
  const checkedAt = Number(entry?.checkedAt || 0);

  if (!currentUser || !checkedAt) {
    return null;
  }

  return {
    checkedAt,
    currentUser,
    groups: normalizeGroups(entry.groups),
    fresh: true,
  };
}

function normalizeAssigneeEntry(entry) {
  const checkedAt = Number(entry?.checkedAt || 0);

  if (!checkedAt) {
    return null;
  }

  return {
    assignees: normalizeAssignees(entry.assignees),
    checkedAt,
    // Board review groups change rarely. They remain valid until the user
    // explicitly refreshes them from the Meta Board settings.
    fresh: true,
  };
}

export async function loadReviewerGroupCache({
  cachePath,
  username,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const key = getUsernameKey(username);

  if (!resolvedPath || !key) {
    return null;
  }

  try {
    const contents = await readFile(resolvedPath, "utf8");
    const store = JSON.parse(contents);

    return normalizeEntry(store?.entries?.[key]);
  } catch {
    return null;
  }
}

export async function saveReviewerGroupCache({
  cachePath,
  currentUser,
  groups,
  now = Date.now(),
  username,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const key = getUsernameKey(username);
  const normalizedUser = normalizeCurrentUser(currentUser);

  if (!resolvedPath || !key || !normalizedUser) {
    return;
  }

  let store = { version: 1, entries: {} };

  try {
    store = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch {
    // A missing or malformed cache is replaced with a valid entry below.
  }

  store = {
    ...store,
    entries: {
      ...(store?.entries || {}),
      [key]: {
        checkedAt: now,
        currentUser: normalizedUser,
        groups: normalizeGroups(groups),
      },
    },
    version: 1,
  };

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(store), "utf8");
  } catch {
    // The in-process dashboard cache remains useful when local storage fails.
  }
}

export async function loadReviewGroupAssigneeCache({
  cachePath,
  reviewGroup,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const key = getGroupKey(reviewGroup);

  if (!resolvedPath || !key) {
    return null;
  }

  try {
    const contents = await readFile(resolvedPath, "utf8");
    const store = JSON.parse(contents);

    return normalizeAssigneeEntry(store?.reviewGroupAssignees?.[key]);
  } catch {
    return null;
  }
}

export async function saveReviewGroupAssigneeCache({
  assignees,
  cachePath,
  now = Date.now(),
  reviewGroup,
} = {}) {
  const resolvedPath = getCachePath(cachePath);
  const key = getGroupKey(reviewGroup);

  if (!resolvedPath || !key) {
    return;
  }

  let store = { version: 1, entries: {}, reviewGroupAssignees: {} };

  try {
    store = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch {
    // A missing or malformed cache is replaced with a valid entry below.
  }

  store = {
    ...store,
    entries: { ...(store?.entries || {}) },
    reviewGroupAssignees: {
      ...(store?.reviewGroupAssignees || {}),
      [key]: {
        assignees: normalizeAssignees(assignees),
        checkedAt: now,
      },
    },
    version: 1,
  };

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(store), "utf8");
  } catch {
    // The in-process meta board cache remains useful when local storage fails.
  }
}
