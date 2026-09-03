import { getUsersByMatches as defaultGetUsersByMatches } from "../../lib/bugzilla.mjs";
import defaultPhab from "../../lib/phab.mjs";

export const REVIEW_GROUP_ASSIGNEE_CACHE_MS = 24 * 60 * 60 * 1000;

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
  reviewGroup,
  phab,
  getUsersByMatches,
}) {
  const groupResponse = await phab({
    route: "project.search",
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
  reviewGroup,
  phab = defaultPhab,
  getUsersByMatches = defaultGetUsersByMatches,
} = {}) {
  const slug = normalizeGroupSlug(reviewGroup);

  if (!slug) {
    return [];
  }

  const cached = cache.get(slug);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.assignees;
  }

  if (inflight.has(slug)) {
    return inflight.get(slug);
  }

  const request = loadReviewGroupAssignees({
    reviewGroup: slug,
    phab,
    getUsersByMatches,
  })
    .then((assignees) => {
      cache.set(slug, {
        assignees,
        expiresAt: Date.now() + REVIEW_GROUP_ASSIGNEE_CACHE_MS,
      });
      return assignees;
    })
    .finally(() => {
      inflight.delete(slug);
    });

  inflight.set(slug, request);
  return request;
}
