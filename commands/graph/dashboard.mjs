import defaultConfig from "../../lib/config.mjs";
import {
  getAssignedOpenBugs as defaultGetAssignedOpenBugs,
  getBugsByIds as defaultGetBugsByIds,
  getBugsWithAttachmentsByIds as defaultGetBugsWithAttachmentsByIds,
  getNeedinfoOpenBugs as defaultGetNeedinfoOpenBugs,
} from "../../lib/bugzilla.mjs";
import defaultPhab from "../../lib/phab.mjs";
import { getBugIdFromText, getBugUrl, getPhabUrl } from "../../lib/workflow.mjs";
import { CHECKIN_NEEDED_KEYWORD } from "./constants.mjs";
import {
  loadReviewerGroupCache as defaultLoadReviewerGroupCache,
  saveReviewerGroupCache as defaultSaveReviewerGroupCache,
} from "./reviewer-groups-cache.mjs";

const CHANGE_TRANSACTION_TYPES = new Set([
  "diff",
  "differential.diff",
  "differential.update",
  "revision.update",
  "update",
]);
const REVIEW_TRANSACTION_TYPES = new Set([
  "accept",
  "reject",
  "request",
  "request-changes",
  "resign",
]);
const PHABRICATOR_QUERY_BATCH_SIZE = 100;

function normalizeTimestamp(value) {
  const numericTimestamp = Number(value || 0);
  const timestamp = Number.isFinite(numericTimestamp)
    ? numericTimestamp
    : Date.parse(value || 0);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 0;
  }

  return timestamp < 100000000000 ? timestamp * 1000 : timestamp;
}

function getRecordTimestamp(record = {}) {
  return normalizeTimestamp(
    record.dateCreated ||
    record.dateModified ||
    record.epoch ||
    record.timestamp,
  );
}

function getTransactionTimestamp(transaction = {}) {
  const commentTimestamps = (transaction.comments || []).map(getRecordTimestamp);

  return Math.max(getRecordTimestamp(transaction), ...commentTimestamps, 0);
}

function getTransactionType(transaction = {}) {
  return String(transaction.type || transaction.action || "")
    .trim()
    .toLowerCase();
}

function isHumanUser(phid = "") {
  return String(phid).startsWith("PHID-USER-");
}

function getTransactionAuthor(transaction = {}) {
  return String(
    transaction.authorPHID || transaction.comments?.[0]?.authorPHID || "",
  );
}

function hasComment(transaction = {}) {
  if (Object.hasOwn(transaction, "content")) {
    return String(transaction.content?.raw ?? transaction.content ?? "").trim();
  }

  return (transaction.comments || []).some((comment) => (
    String(comment?.content?.raw ?? comment?.content ?? "").trim()
  ));
}

function isReviewTransaction(transaction = {}) {
  const type = getTransactionType(transaction);

  return (
    REVIEW_TRANSACTION_TYPES.has(type) ||
    ((type === "comment" || type === "inline") && hasComment(transaction))
  );
}

function isChangeTransaction(transaction = {}) {
  return CHANGE_TRANSACTION_TYPES.has(getTransactionType(transaction));
}

function isNeedsReview(revision = {}) {
  return /needs review/i.test(revision.statusName || revision.status || "");
}

function isNeedsRevision(revision = {}) {
  return /needs revision/i.test(revision.statusName || revision.status || "");
}

function isAccepted(revision = {}) {
  return /accepted/i.test(revision.statusName || revision.status || "");
}

function isClosed(revision = {}) {
  return /closed/i.test(revision.statusName || revision.status || "");
}

function getRevisionId(revision = {}) {
  const id = String(revision.id || "").replace(/^D/i, "");

  return id ? `D${id}` : "";
}

function normalizeRevision(revision = {}) {
  const id = getRevisionId(revision);

  return {
    id,
    numericId: id.replace(/^D/, ""),
    phid: revision.phid || "",
    url: revision.uri || getPhabUrl(id),
    title: revision.title || "Untitled revision",
    status: revision.status || "",
    statusName: revision.statusName || revision.status || "Unknown",
    authorPHID: revision.authorPHID || "",
    authorName: String(revision.authorName || revision.authorRealName || "").trim(),
    bugId: getBugIdFromText(revision.title || "") || "",
    dateCreated: getRecordTimestamp(revision),
    dateModified: normalizeTimestamp(revision.dateModified),
    reviewers: revision.reviewers || {},
  };
}

function getUserDisplayName(user = {}) {
  return String(
    user.realName || user.userName || user.username || user.phid || "",
  ).trim();
}

function getRevisionTimeline({ revision, transactions = [], currentUserPhid }) {
  const patchUpdates = transactions.filter((transaction) => (
    isChangeTransaction(transaction) &&
    getTransactionAuthor(transaction) === revision.authorPHID
  ));
  const latestPatchUpdateAt = Math.max(
    ...patchUpdates.map(getTransactionTimestamp),
    revision.dateCreated,
    revision.dateModified,
    0,
  );
  const reviewEvents = transactions.filter((transaction) => {
    const author = getTransactionAuthor(transaction);

    return (
      isReviewTransaction(transaction) &&
      isHumanUser(author) &&
      author !== revision.authorPHID
    );
  });
  const currentReviewEvents = reviewEvents.filter((transaction) => (
    getTransactionTimestamp(transaction) >= latestPatchUpdateAt
  ));
  const yourReviewEvents = reviewEvents.filter((transaction) => (
    getTransactionAuthor(transaction) === currentUserPhid
  ));

  return {
    currentReviewEventCount: currentReviewEvents.length,
    latestPatchUpdateAt,
    latestReviewAt: Math.max(...reviewEvents.map(getTransactionTimestamp), 0),
    latestCurrentReviewAt: Math.max(
      ...currentReviewEvents.map(getTransactionTimestamp),
      0,
    ),
    latestYourReviewAt: Math.max(
      ...yourReviewEvents.map(getTransactionTimestamp),
      0,
    ),
  };
}

function hasReviewerFeedbackAwaitingUpdate(revision = {}, timeline = {}) {
  return isNeedsReview(revision) && Number(timeline.currentReviewEventCount || 0) > 0;
}

function getAge(timestamp, now) {
  const ageMs = Math.max(0, now - Number(timestamp || now));

  if (ageMs < 24 * 60 * 60 * 1000) {
    return { ageMs, ageState: "fresh" };
  }

  if (ageMs < 48 * 60 * 60 * 1000) {
    return { ageMs, ageState: "attention" };
  }

  return { ageMs, ageState: "overdue" };
}

function withPatchAge(revision, timestamp, now, ageLabel) {
  return {
    ...revision,
    ...getAge(timestamp || revision.dateModified || revision.dateCreated, now),
    ageLabel,
    ageTimestamp: timestamp || revision.dateModified || revision.dateCreated,
  };
}

function getReviewGroups(revision, groupsByPhid) {
  return Object.keys(revision.reviewers || {})
    .filter((phid) => groupsByPhid.has(phid))
    .map((phid) => groupsByPhid.get(phid))
    .sort((first, second) => first.localeCompare(second));
}

function getUniqueValues(values) {
  return Array.from(new Set(values.map(String).filter(Boolean)));
}

function chunkValues(values, size = PHABRICATOR_QUERY_BATCH_SIZE) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function normalizeAttachments(attachments) {
  if (Array.isArray(attachments)) {
    return attachments;
  }

  if (attachments && typeof attachments === "object") {
    return Object.values(attachments);
  }

  return [];
}

function getPhabricatorIdsFromAttachments(attachments) {
  return normalizeAttachments(attachments).flatMap((attachment) => {
    if (attachment?.content_type !== "text/x-phabricator-request") {
      return [];
    }

    const match = String(attachment.file_name || "").match(/D([0-9]+)/);

    return match ? [match[1]] : [];
  });
}

async function getRevisionTimelines({ revisions, currentUserPhid, phab }) {
  const timelines = new Map();

  for (const chunk of chunkValues(revisions)) {
    try {
      const response = await phab({
        route: "differential.getrevisioncomments",
        params: {
          ids: chunk.map((revision) => Number(revision.numericId)),
          inlines: false,
        },
      });
      const commentsByRevision = response?.result || {};

      for (const revision of chunk) {
        timelines.set(revision.id, {
          timeline: getRevisionTimeline({
            revision,
            transactions: commentsByRevision[revision.numericId] || [],
            currentUserPhid,
          }),
        });
      }
    } catch (error) {
      for (const revision of chunk) {
        timelines.set(revision.id, {
          error: String(error?.message || error),
          timeline: getRevisionTimeline({ revision, currentUserPhid }),
        });
      }
    }
  }

  return timelines;
}

async function getReviewerGroups({ currentUserPhid, phab }) {
  const response = await phab({
    route: "project.search",
    params: {
      constraints: { members: [currentUserPhid] },
      limit: 100,
    },
  });

  return (response?.result?.data || []).map((group) => ({
    name: group.fields?.name || group.fields?.slug || group.phid,
    phid: group.phid,
    slug: group.fields?.slug || "",
  })).filter((group) => group.phid);
}

async function getDashboardIdentityAndReviewerGroups({
  loadReviewerGroupCache,
  now,
  phab,
  saveReviewerGroupCache,
  username,
}) {
  const cached = await loadReviewerGroupCache({ now, username });

  if (cached?.fresh) {
    return cached;
  }

  try {
    const identityResponse = await phab({
      route: "user.query",
      params: { usernames: [username] },
    });
    const currentUser = identityResponse?.result?.[0];

    if (!currentUser?.phid) {
      throw new Error(`Could not find Phabricator user ${username}.`);
    }

    const groups = await getReviewerGroups({
      currentUserPhid: currentUser.phid,
      phab,
    });

    await saveReviewerGroupCache({ currentUser, groups, now, username });
    return { currentUser, groups };
  } catch (error) {
    if (cached) {
      return cached;
    }

    throw error;
  }
}

function partitionReviewQueueRevisions({ currentUserPhid, groups, response }) {
  const groupPhids = new Set(getUniqueValues(groups.map((group) => group.phid)));
  const directlyAssignedRevisions = new Map();
  const groupRevisions = new Map();

  for (const revision of response?.result || []) {
    const normalized = normalizeRevision(revision);

    if (!normalized.id || isClosed(normalized)) {
      continue;
    }

    const reviewerPhids = Object.keys(normalized.reviewers || {});

    if (reviewerPhids.includes(currentUserPhid)) {
      directlyAssignedRevisions.set(normalized.id, normalized);
    }

    if (reviewerPhids.some((phid) => groupPhids.has(phid))) {
      groupRevisions.set(normalized.id, normalized);
    }
  }

  return {
    directlyAssignedRevisions: Array.from(directlyAssignedRevisions.values()),
    groupRevisions: Array.from(groupRevisions.values()),
  };
}

async function getRevisionsByIds({ ids, phab }) {
  const revisions = new Map();

  for (const chunk of chunkValues(getUniqueValues(ids))) {
    const response = await phab({
      route: "differential.query",
      params: { ids: chunk.map(Number) },
    });

    for (const revision of response?.result || []) {
      const normalized = normalizeRevision(revision);

      if (normalized.id && !isClosed(normalized)) {
        revisions.set(normalized.id, normalized);
      }
    }
  }

  return revisions;
}

async function getRevisionAuthorNames({ revisions, phab }) {
  const authorsByPhid = new Map();
  const authorPhids = getUniqueValues(
    revisions
      .filter((revision) => !revision.authorName)
      .map((revision) => revision.authorPHID),
  );

  for (const phids of chunkValues(authorPhids)) {
    const response = await phab({
      route: "user.query",
      params: { phids },
    });

    for (const [index, user] of (response?.result || []).entries()) {
      const phid = String(user?.phid || phids[index] || "");
      const name = getUserDisplayName(user);

      if (phid && name) {
        authorsByPhid.set(phid, name);
      }
    }
  }

  return authorsByPhid;
}

function withAuthorNames(revisions, authorsByPhid) {
  return revisions.map((revision) => ({
    ...revision,
    authorName: revision.authorName || authorsByPhid.get(revision.authorPHID) || "",
  }));
}

async function getAssignedBugAttachments({ bugs, getBugsWithAttachmentsByIds }) {
  const attachmentBugs = await getBugsWithAttachmentsByIds(
    bugs.map((bug) => bug.id),
  );

  return new Map(attachmentBugs.map((bug) => [
    String(bug.id),
    getPhabricatorIdsFromAttachments(bug.attachments),
  ]));
}

function getBugById(bugs = []) {
  return new Map(bugs.map((bug) => [String(bug.id), bug]));
}

function hasCheckinNeeded(bug) {
  return (bug?.keywords || []).includes(CHECKIN_NEEDED_KEYWORD);
}

function buildAssignedBugRows({ bugs, attachmentsByBugId, revisionsById }) {
  return bugs.map((bug) => {
    const patches = getUniqueValues(attachmentsByBugId.get(String(bug.id)) || [])
      .map((id) => revisionsById.get(`D${id}`))
      .filter(Boolean);

    return {
      id: String(bug.id),
      url: getBugUrl(bug.id),
      summary: bug.summary || "Untitled Bugzilla bug",
      status: bug.status || "Open",
      component: [bug.product, bug.component].filter(Boolean).join(" / "),
      hasPatch: patches.length > 0,
      patches: patches.map((patch) => ({
        id: patch.id,
        statusName: patch.statusName,
        title: patch.title,
        url: patch.url,
      })),
    };
  }).sort((first, second) => Number(second.id) - Number(first.id));
}

function getNeedinfoFlag(bug = {}) {
  return (bug.flags || []).find((flag) => (
    flag?.name === "needinfo" && flag?.status === "?"
  ));
}

function buildNeedinfoRows({ bugs, now }) {
  return bugs.filter((bug) => bug.is_open !== false)
    .map((bug) => {
      const flag = getNeedinfoFlag(bug);
      const requestedAt = normalizeTimestamp(
        flag?.creation_date || flag?.modification_date || bug.last_change_time,
      );

      return {
        id: String(bug.id),
        url: getBugUrl(bug.id),
        summary: bug.summary || "Untitled Bugzilla bug",
        status: bug.status || "Open",
        component: [bug.product, bug.component].filter(Boolean).join(" / "),
        requestedAt,
        requestedBy: String(flag?.setter || "").trim(),
        ...getAge(requestedAt || normalizeTimestamp(bug.last_change_time), now),
      };
    })
    .sort((first, second) => second.ageMs - first.ageMs);
}

export function getDashboardAgeState(timestamp, now = Date.now()) {
  return getAge(timestamp, now);
}

export function classifyDashboardRevisions({
  currentUserPhid,
  directlyAssignedRevisions = [],
  groups = [],
  mine = [],
  groupRevisions = [],
  timelines = new Map(),
  bugsById = new Map(),
  now = Date.now(),
}) {
  const groupsByPhid = new Map(groups.map((group) => [group.phid, group.name]));
  const ownNeedsRevision = mine
    .filter((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return isNeedsRevision(revision) ||
        hasReviewerFeedbackAwaitingUpdate(revision, timeline);
    })
    .map((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return withPatchAge(revision, timeline.latestReviewAt, now, "Last review");
    })
    .sort((first, second) => second.ageMs - first.ageMs);
  const ownNeedsReview = mine
    .filter(isNeedsReview)
    .filter((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return !hasReviewerFeedbackAwaitingUpdate(revision, timeline);
    })
    .map((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return withPatchAge(revision, timeline.latestPatchUpdateAt, now, "Last update");
    })
    .sort((first, second) => second.ageMs - first.ageMs);
  const approvedNotMarkedForCheckin = mine
    .filter(isAccepted)
    .filter((revision) => !hasCheckinNeeded(bugsById.get(revision.bugId)))
    .sort((first, second) => second.dateModified - first.dateModified);
  const groupWaitingForFirstReview = groupRevisions
    .filter(isNeedsReview)
    .filter((revision) => revision.authorPHID !== currentUserPhid)
    .filter((revision) => {
      const history = timelines.get(revision.id);

      return !history?.error && !history?.timeline?.latestReviewAt;
    })
    .map((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return {
        ...withPatchAge(revision, timeline.latestPatchUpdateAt, now, "Last update"),
        groups: getReviewGroups(revision, groupsByPhid),
      };
    })
    .sort((first, second) => second.ageMs - first.ageMs);
  const directlyAssignedWaitingOnReview = directlyAssignedRevisions
    .filter(isNeedsReview)
    .filter((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return (
        revision.authorPHID !== currentUserPhid &&
        timeline.latestYourReviewAt < timeline.latestPatchUpdateAt
      );
    })
    .map((revision) => {
      const timeline = timelines.get(revision.id)?.timeline || {};

      return {
        ...withPatchAge(revision, timeline.latestPatchUpdateAt, now, "Last update"),
        groups: getReviewGroups(revision, groupsByPhid),
      };
    })
    .sort((first, second) => second.ageMs - first.ageMs);

  return {
    ownNeedsRevision,
    ownNeedsReview,
    approvedNotMarkedForCheckin,
    groupWaitingForFirstReview,
    directlyAssignedWaitingOnReview,
  };
}

export async function getDashboardData({
  appConfig = defaultConfig,
  loadReviewerGroupCache = defaultLoadReviewerGroupCache,
  getAssignedOpenBugs = defaultGetAssignedOpenBugs,
  getBugsByIds = defaultGetBugsByIds,
  getBugsWithAttachmentsByIds = defaultGetBugsWithAttachmentsByIds,
  getNeedinfoOpenBugs = defaultGetNeedinfoOpenBugs,
  now = Date.now(),
  phab = defaultPhab,
  saveReviewerGroupCache = defaultSaveReviewerGroupCache,
} = {}) {
  const username = String(appConfig?.phabricator?.user || "").trim();

  if (!username) {
    throw new Error("Set phabricator.user in ~/.tb.json to load the dashboard.");
  }

  const { currentUser, groups } = await getDashboardIdentityAndReviewerGroups({
    loadReviewerGroupCache,
    now,
    phab,
    saveReviewerGroupCache,
    username,
  });

  const reviewerPhids = getUniqueValues([
    currentUser.phid,
    ...groups.map((group) => group.phid),
  ]);
  const [mineResponse, assignedBugs, needinfoBugs, reviewQueueResponse] = await Promise.all([
    phab({
      route: "differential.query",
      params: { authors: [currentUser.phid], status: "status-open" },
    }),
    getAssignedOpenBugs({ assignedTo: appConfig?.bugzilla?.user }),
    getNeedinfoOpenBugs({ requestee: appConfig?.bugzilla?.user }),
    phab({
      route: "differential.query",
      // Reviewer PHIDs form an OR query, so this one request covers both the
      // directly assigned queue and every review group.
      params: { reviewers: reviewerPhids, status: "status-open" },
    }),
  ]);
  const mine = (mineResponse?.result || [])
    .map(normalizeRevision)
    .filter((revision) => revision.id && !isClosed(revision));
  const { directlyAssignedRevisions, groupRevisions } = partitionReviewQueueRevisions({
    currentUserPhid: currentUser.phid,
    groups,
    response: reviewQueueResponse,
  });
  const allDashboardRevisions = new Map([
    ...mine.map((revision) => [revision.id, revision]),
    ...groupRevisions.map((revision) => [revision.id, revision]),
    ...directlyAssignedRevisions.map((revision) => [revision.id, revision]),
  ]);
  const timelines = await getRevisionTimelines({
    revisions: Array.from(allDashboardRevisions.values()),
    currentUserPhid: currentUser.phid,
    phab,
  });
  const approvedBugIds = mine
    .filter(isAccepted)
    .map((revision) => revision.bugId)
    .filter(Boolean);
  const [approvedBugs, attachmentsByBugId] = await Promise.all([
    getBugsByIds(approvedBugIds),
    getAssignedBugAttachments({
      bugs: assignedBugs,
      getBugsWithAttachmentsByIds,
    }),
  ]);
  const assignedRevisionIds = getUniqueValues(
    Array.from(attachmentsByBugId.values()).flat(),
  );
  const attachedRevisions = await getRevisionsByIds({
    ids: assignedRevisionIds.filter(
      (id) => !allDashboardRevisions.has(`D${id}`),
    ),
    phab,
  });
  const revisionsById = new Map([
    ...allDashboardRevisions,
    ...attachedRevisions,
  ]);
  const bugsById = getBugById(approvedBugs);
  const sections = classifyDashboardRevisions({
    currentUserPhid: currentUser.phid,
    directlyAssignedRevisions,
    groups,
    mine,
    groupRevisions,
    timelines,
    bugsById,
    now,
  });
  const reviewQueueRevisions = [
    ...sections.directlyAssignedWaitingOnReview,
    ...sections.groupWaitingForFirstReview,
  ];
  const authorsByPhid = await getRevisionAuthorNames({
    revisions: reviewQueueRevisions,
    phab,
  });
  const assignedBugRows = buildAssignedBugRows({
    bugs: assignedBugs.filter((bug) => bug.is_open !== false),
    attachmentsByBugId,
    revisionsById,
  });

  return {
    generatedAt: now,
    user: {
      name: currentUser.realName || currentUser.userName || username,
      phid: currentUser.phid,
      username: currentUser.userName || username,
    },
    groups,
    errors: [],
    ...sections,
    directlyAssignedWaitingOnReview: withAuthorNames(
      sections.directlyAssignedWaitingOnReview,
      authorsByPhid,
    ),
    groupWaitingForFirstReview: withAuthorNames(
      sections.groupWaitingForFirstReview,
      authorsByPhid,
    ),
    needinfoBugs: buildNeedinfoRows({ bugs: needinfoBugs, now }),
    inProgressBugs: assignedBugRows.filter((bug) => bug.hasPatch),
    assignedBugs: assignedBugRows.filter((bug) => !bug.hasPatch),
  };
}
