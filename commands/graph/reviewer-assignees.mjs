import { getUsersByMatches as defaultGetUsersByMatches } from "../../lib/bugzilla.mjs";
import defaultPhab from "../../lib/phab.mjs";
import {
  loadReviewGroupAssigneeCache as defaultLoadReviewGroupAssigneeCache,
  saveReviewGroupAssigneeCache as defaultSaveReviewGroupAssigneeCache,
} from "./reviewer-groups-cache.mjs";

export const REVIEW_GROUP_ASSIGNEE_CACHE_MS = Number.POSITIVE_INFINITY;

const cache = new Map();
const inflight = new Map();

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeName(value) {
  return normalizeText(value)
    .replace(/\s*\[[^\]]*\]\s*$/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function normalizeGroupSlug(value) {
  return normalizeText(value).replace(/^#+/, "").toLowerCase();
}

function getSearchResults(response) {
  const result = response?.result;

  if (Array.isArray(result)) {
    return result;
  }

  return Array.isArray(result?.data) ? result.data : [];
}

function getProjectMemberPhids(project) {
  return Array.from(new Set(
    (project?.attachments?.members?.members || [])
      .map((member) => normalizeText(member?.phid))
      .filter(Boolean),
  ));
}

function normalizePhabricatorUser(user = {}) {
  const fields = user.fields || user;
  const username = normalizeText(
    fields.username || fields.userName || user.username || user.userName,
  );
  const realName = normalizeText(fields.realName || fields.realname || user.realName);

  return username || realName ? { username, realName } : null;
}

function normalizeBugzillaUser(user = {}) {
  const email = normalizeText(user.email || user.name);

  return email
    ? {
        email,
        name: normalizeText(user.real_name || user.realName) || email,
      }
    : null;
}

function getBugzillaUserScore(phabricatorUser, bugzillaUser) {
  const phabricatorName = normalizeName(phabricatorUser.realName);
  const bugzillaName = normalizeName(bugzillaUser.real_name || bugzillaUser.realName);
  const username = normalizeText(phabricatorUser.username).toLowerCase();
  const email = normalizeText(bugzillaUser.email || bugzillaUser.name).toLowerCase();
  const localPart = email.split("@", 1)[0];

  if (phabricatorName && phabricatorName === bugzillaName) {
    return 0;
  }

  if (username && username === localPart) {
    return 1;
  }

  if (phabricatorName && bugzillaName.startsWith(`${phabricatorName} `)) {
    return 2;
  }

  return Number.POSITIVE_INFINITY;
}

function findBugzillaUser(phabricatorUser, bugzillaUsers) {
  const matches = bugzillaUsers
    .map((bugzillaUser) => ({
      bugzillaUser,
      score: getBugzillaUserScore(phabricatorUser, bugzillaUser),
    }))
    .filter((match) => Number.isFinite(match.score))
    .sort((first, second) => first.score - second.score);

  if (
    !matches.length ||
    (matches.length > 1 && matches[0].score === matches[1].score)
  ) {
    return null;
  }

  return normalizeBugzillaUser(matches[0].bugzillaUser);
}

function mergeAssignees(assignees = []) {
  return Array.from(new Map(assignees
    .filter(Boolean)
    .map((assignee) => [assignee.email.toLowerCase(), assignee])).values())
    .sort((first, second) => first.name.localeCompare(second.name));
}

async function loadReviewGroupAssignees({
  force = false,
  reviewGroup,
  phab,
  getUsersByMatches,
}) {
  const groupResponse = await phab({
    route: "project.search",
    ...(force ? { bypassCache: true } : {}),
    params: {
      attachments: { members: true },
      constraints: { slugs: [reviewGroup] },
    },
  });
  const project = getSearchResults(groupResponse)[0];
  const memberPhids = getProjectMemberPhids(project);

  if (!memberPhids.length) {
    return [];
  }

  const usersResponse = await phab({
    route: "user.query",
    ...(force ? { bypassCache: true } : {}),
    params: { phids: memberPhids },
  });
  const phabricatorUsers = (usersResponse?.result || [])
    .map(normalizePhabricatorUser)
    .filter(Boolean);
  const matches = phabricatorUsers.flatMap(({ username, realName }) => [
    realName,
    username,
  ]).filter(Boolean);
  const bugzillaUsers = await getUsersByMatches(matches);

  return mergeAssignees(phabricatorUsers.map((user) => findBugzillaUser(user, bugzillaUsers)));
}

export function clearReviewGroupAssigneeCache() {
  cache.clear();
  inflight.clear();
}

export async function getReviewGroupAssignees({
  force = false,
  reviewGroup,
  phab = defaultPhab,
  getUsersByMatches = defaultGetUsersByMatches,
  loadReviewGroupAssigneeCache = defaultLoadReviewGroupAssigneeCache,
  saveReviewGroupAssigneeCache = defaultSaveReviewGroupAssigneeCache,
} = {}) {
  const slug = normalizeGroupSlug(reviewGroup);

  if (!slug) {
    return [];
  }

  const cached = cache.get(slug);

  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.assignees;
  }

  if (inflight.has(slug)) {
    return inflight.get(slug);
  }

  const request = (async () => {
    const persisted = await loadReviewGroupAssigneeCache({ reviewGroup: slug });

    if (!force && persisted?.fresh) {
      cache.set(slug, {
        assignees: persisted.assignees,
        expiresAt: Number.POSITIVE_INFINITY,
      });
      return persisted.assignees;
    }

    try {
      const assignees = await loadReviewGroupAssignees({
        force,
        reviewGroup: slug,
        phab,
        getUsersByMatches,
      });
      cache.set(slug, {
        assignees,
        expiresAt: Number.POSITIVE_INFINITY,
      });
      await saveReviewGroupAssigneeCache({ assignees, reviewGroup: slug });
      return assignees;
    } catch (error) {
      if (!persisted) {
        throw error;
      }

      cache.set(slug, {
        assignees: persisted.assignees,
        expiresAt: Number.POSITIVE_INFINITY,
      });
      return persisted.assignees;
    }
  })().finally(() => {
      inflight.delete(slug);
    });

  inflight.set(slug, request);
  return request;
}
