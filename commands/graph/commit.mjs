import { run } from "../../lib/utils.mjs";
import defaultPhab from "../../lib/phab.mjs";
import {
  ensureTbToolsIdInCommitMessage,
  installTbToolsCommitMsgHook,
} from "../../lib/commit-message.mjs";
import { getGitAddAllArgs } from "./data.mjs";

const DEFAULT_REVIEWER_LIMIT = 30;
export const MIN_REVIEWER_QUERY_LENGTH = 3;

export function isReviewerSearchRateLimitError(error) {
  return (
    error?.status === 429 ||
    error?.statusCode === 429 ||
    /\b429\b|rate.?limit/i.test(error?.message || "")
  );
}

function createStatusError(message, statusCode = 400) {
  const error = new Error(message);

  error.statusCode = statusCode;
  return error;
}

function normalizeSearchResponseItems(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.result?.data)) {
    return response.result.data;
  }

  if (Array.isArray(response?.result)) {
    return response.result;
  }

  if (Array.isArray(response?.data)) {
    return response.data;
  }

  return [];
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

export function getBugIdFromBranch(branch = "") {
  const match = String(branch || "").match(
    /(?:^|[^A-Za-z0-9])Bug[-_ ]?(\d{4,8})(?:$|[^0-9])/i,
  );

  return match ? match[1] : "";
}

function normalizeBugId(bugId) {
  const normalized = normalizeText(bugId);

  if (!/^\d{4,8}$/.test(normalized)) {
    throw createStatusError(
      "A Bugzilla bug ID is required when the current branch is not a Bug branch.",
    );
  }

  return normalized;
}

export function getGraphCommitPrefix({ branch = "", bugId = "" } = {}) {
  const branchBugId = getBugIdFromBranch(branch);

  return `Bug ${branchBugId || normalizeBugId(bugId)}`;
}

function getReviewerCandidateValue(reviewer) {
  return typeof reviewer === "object" && reviewer
    ? reviewer.value || reviewer.name || reviewer.username || reviewer.slug
    : reviewer;
}

function getReviewerInputText(reviewer) {
  return normalizeText(getReviewerCandidateValue(reviewer)).replace(/^r=/i, "");
}

function stripReviewerBlockingMarker(reviewer) {
  return getReviewerInputText(reviewer).trim().replace(/!+$/, "").trim();
}

function normalizeReviewerValue(reviewer) {
  const normalized = stripReviewerBlockingMarker(reviewer);

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("#")) {
    return `#${normalized.replace(/^#+/, "")}`;
  }

  return normalized;
}

function isBlockingReviewer(reviewer) {
  if (typeof reviewer === "object" && reviewer?.blocking) {
    return true;
  }

  const value = getReviewerInputText(reviewer).trim();

  return value.endsWith("!");
}

function normalizeReviewerForCommit(reviewer) {
  const value =
    typeof reviewer === "object" && reviewer
      ? reviewer.value || reviewer.name || reviewer.username || reviewer.slug
      : reviewer;
  const normalized = normalizeReviewerValue(value);

  if (!normalized) {
    return null;
  }

  return {
    value: normalized,
    blocking: isBlockingReviewer(reviewer),
  };
}

function formatCommitReviewer(reviewer) {
  return `${reviewer.value}${reviewer.blocking ? "!" : ""}`;
}

export function normalizeGraphCommitReviewers(reviewers = []) {
  const values = Array.isArray(reviewers)
    ? reviewers
    : String(reviewers || "").split(",");
  const seen = new Set();
  const normalized = [];

  for (const reviewer of values) {
    const item = normalizeReviewerForCommit(reviewer);
    const key = item?.value.toLowerCase();

    if (!item) {
      continue;
    }

    if (seen.has(key)) {
      if (item.blocking) {
        normalized.find((entry) => entry.value.toLowerCase() === key).blocking =
          true;
      }
      continue;
    }

    seen.add(key);
    normalized.push(item);
  }

  return normalized.map(formatCommitReviewer);
}

export function buildGraphCommitMessage({
  branch = "",
  bugId = "",
  summary = "",
  reviewers = [],
} = {}) {
  const text = normalizeText(summary);

  if (!text) {
    throw createStatusError("A commit message is required.");
  }

  const prefix = getGraphCommitPrefix({ branch, bugId });
  const reviewerText = normalizeGraphCommitReviewers(reviewers).join(",");

  return ensureTbToolsIdInCommitMessage(
    `${prefix} - ${text}. r=${reviewerText}`,
  ).message;
}

function getUserFields(item = {}) {
  return item.fields || item;
}

function normalizeReviewerUser(item = {}) {
  const fields = getUserFields(item);
  const username = normalizeText(
    fields.username ||
      fields.userName ||
      fields.name ||
      item.userName ||
      item.username,
  );

  if (!username) {
    return null;
  }

  return {
    type: "user",
    value: username,
    label: username,
    description: normalizeText(
      fields.realName || fields.realname || fields.fullName || fields.email,
    ),
    phid: item.phid || fields.phid || "",
  };
}

function normalizeReviewerProject(item = {}) {
  const fields = item.fields || item;
  const slug = normalizeText(fields.slug || item.slug);

  if (!slug) {
    return null;
  }

  return {
    type: "group",
    value: `#${slug.replace(/^#+/, "")}`,
    label: `#${slug.replace(/^#+/, "")}`,
    description: normalizeText(fields.name || item.name),
    phid: item.phid || fields.phid || "",
  };
}

function dedupeReviewerSuggestions(suggestions = []) {
  const seen = new Set();
  const deduped = [];

  for (const suggestion of suggestions.filter(Boolean)) {
    const key = `${suggestion.type}:${suggestion.value}`.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(suggestion);
  }

  return deduped;
}

function getReviewerSearchTokens(query = "") {
  return stripReviewerBlockingMarker(query)
    .replace(/^#/, "")
    .toLowerCase()
    .split(/[\s#,_-]+/u)
    .filter(Boolean);
}

function normalizeReviewerQueryForPhabricator(query = "") {
  return getReviewerSearchTokens(query).join(" ");
}

function isReviewerGroupQuery(query = "") {
  return stripReviewerBlockingMarker(query).startsWith("#");
}

export function getReviewerSearchRoute(query = "") {
  return isReviewerGroupQuery(query) ? "project.search" : "user.search";
}

function getReviewerSuggestionHaystack(suggestion = {}) {
  return [suggestion.value, suggestion.label, suggestion.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getReviewerSuggestionRank(suggestion = {}, query = "") {
  const normalizedQuery = stripReviewerBlockingMarker(query)
    .replace(/^#/, "")
    .toLowerCase();
  const value = String(suggestion.value || "")
    .replace(/^#/, "")
    .toLowerCase();
  const label = String(suggestion.label || "")
    .replace(/^#/, "")
    .toLowerCase();

  if (value === normalizedQuery || label === normalizedQuery) {
    return 0;
  }

  if (value.startsWith(normalizedQuery) || label.startsWith(normalizedQuery)) {
    return 1;
  }

  if (value.includes(normalizedQuery) || label.includes(normalizedQuery)) {
    return 2;
  }

  return 3;
}

function filterAndRankReviewerSuggestions(
  suggestions = [],
  query = "",
  limit = DEFAULT_REVIEWER_LIMIT,
) {
  const tokens = getReviewerSearchTokens(query);
  const filtered = tokens.length
    ? suggestions.filter((suggestion) => {
        const haystack = getReviewerSuggestionHaystack(suggestion);

        return tokens.every((token) => haystack.includes(token));
      })
    : suggestions;
  const candidates = filtered.length ? filtered : suggestions;

  return candidates
    .sort(
      (first, second) =>
        getReviewerSuggestionRank(first, query) -
          getReviewerSuggestionRank(second, query) ||
        String(first.value || "").length - String(second.value || "").length ||
        String(first.value || "").localeCompare(String(second.value || "")),
    )
    .slice(0, limit);
}

export async function searchGraphCommitReviewers({
  query = "",
  limit = DEFAULT_REVIEWER_LIMIT,
  phab = defaultPhab,
} = {}) {
  const normalizedQuery = normalizeReviewerQueryForPhabricator(query);
  const normalizedLimit = Math.max(
    1,
    Math.min(100, Number(limit) || DEFAULT_REVIEWER_LIMIT),
  );

  if (normalizedQuery.length < MIN_REVIEWER_QUERY_LENGTH) {
    return [];
  }

  const params = {
    constraints: { query: normalizedQuery },
    limit: normalizedLimit,
  };
  const route = getReviewerSearchRoute(query);
  const searches = [
    {
      route,
      normalize:
        route === "project.search"
          ? normalizeReviewerProject
          : normalizeReviewerUser,
    },
  ];

  const results = await Promise.all(
    searches.map(async (search) => {
      try {
        return {
          ...search,
          response: await phab({
            route: search.route,
            params,
          }),
        };
      } catch (error) {
        return {
          ...search,
          error,
        };
      }
    }),
  );
  const failures = results.filter((result) => result.error);
  const successful = results.filter((result) => !result.error);

  if (
    !successful.length &&
    failures.some((failure) => !isReviewerSearchRateLimitError(failure.error))
  ) {
    throw failures[0].error;
  }

  return filterAndRankReviewerSuggestions(
    dedupeReviewerSuggestions(
      successful.flatMap((result) =>
        normalizeSearchResponseItems(result.response).map(result.normalize),
      ),
    ),
    query,
    normalizedLimit,
  );
}

export async function getGraphCommitMetadata({ graph, runCommand = run } = {}) {
  if (!graph) {
    throw createStatusError("Unknown graph checkout.", 404);
  }

  const branch = (
    await runCommand({
      cmd: "git",
      args: ["branch", "--show-current"],
      cwd: graph.path,
      capture: true,
      silent: true,
    })
  ).trim();
  const bugId = getBugIdFromBranch(branch);

  graph.branch = branch || "(detached)";

  return {
    label: graph.label,
    path: graph.path,
    branch: graph.branch,
    bugId,
    bugRequired: !bugId,
    prefix: bugId ? `Bug ${bugId}` : "",
  };
}

export async function createGraphCommit({
  graph,
  options = {},
  runCommand = run,
} = {}) {
  if (!graph) {
    throw createStatusError("Unknown graph checkout.", 404);
  }

  const metadata = await getGraphCommitMetadata({ graph, runCommand });
  const commitMessage = buildGraphCommitMessage({
    branch: metadata.branch,
    bugId: options.bugId,
    summary: options.summary,
    reviewers: options.reviewers,
  });

  if (runCommand === run) {
    await installTbToolsCommitMsgHook({
      cwd: graph.path,
      runCommand,
    }).catch(() => {});
  }

  await runCommand({
    cmd: "git",
    args: getGitAddAllArgs(),
    cwd: graph.path,
    silent: true,
  });

  const output = await runCommand({
    cmd: "git",
    args: ["commit", "-m", commitMessage],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const hash = (
    await runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      cwd: graph.path,
      capture: true,
      silent: true,
    })
  ).trim();

  return {
    action: "commit",
    label: graph.label,
    path: graph.path,
    branch: metadata.branch,
    hash,
    commitMessage,
    output,
    message: `${graph.label} created commit ${hash.slice(0, 12)}.`,
  };
}
