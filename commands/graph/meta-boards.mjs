import defaultConfig from "../../lib/config.mjs";
import {
  getBugComments as defaultGetBugComments,
  getBugsByIds as defaultGetBugsByIds,
  getBugsWithAttachmentsByIds as defaultGetBugsWithAttachmentsByIds,
  updateBug as defaultUpdateBug,
} from "../../lib/bugzilla.mjs";
import defaultPhab from "../../lib/phab.mjs";
import { getBugUrl, getPhabUrl } from "../../lib/workflow.mjs";
import { CHECKIN_NEEDED_KEYWORD } from "./constants.mjs";
import { isSprintMetaBug, normalizeSprintMeta } from "./sprints.mjs";

export const META_BOARD_COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "assigned", label: "Assigned" },
  { id: "in-progress", label: "In Progress" },
  { id: "in-review", label: "In Review" },
  { id: "complete", label: "Complete" },
];

const BOARD_BUG_FIELDS = [
  "id",
  "summary",
  "status",
  "resolution",
  "is_open",
  "keywords",
  "assigned_to",
  "assigned_to_detail",
  "depends_on",
  "blocks",
  "cf_fx_points",
  "cf_story_points",
  "creation_time",
  "last_change_time",
  "whiteboard",
  "deadline",
  "product",
  "component",
  "version",
  "op_sys",
  "platform",
].join(",");
const PHABRICATOR_BATCH_SIZE = 100;
const MAX_META_BOARD_BUGS = 1500;
const REVIEW_ACTIONS = new Set([
  "accept",
  "reject",
  "request",
  "request-changes",
  "resign",
]);
const DESCRIPTION_COMMENT_PREFIX = "TB-Tools story description:";

function uniqueIds(values = []) {
  return Array.from(new Set(values
    .map((value) => String(value || "").trim())
    .filter((value) => /^\d+$/.test(value))));
}

function isMetaBug(bug) {
  const keywords = Array.isArray(bug?.keywords) ? bug.keywords : [];

  return keywords.some((keyword) => String(keyword).trim().toLowerCase() === "meta");
}

function chunk(values = [], size = PHABRICATOR_BATCH_SIZE) {
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

  return attachments && typeof attachments === "object"
    ? Object.values(attachments)
    : [];
}

function getRevisionIds(attachments) {
  return normalizeAttachments(attachments).flatMap((attachment) => {
    if (attachment?.content_type !== "text/x-phabricator-request") {
      return [];
    }

    const match = String(attachment.file_name || "").match(/D(\d+)/i);

    return match ? [match[1]] : [];
  });
}

function getStoryPointsField(appConfig = defaultConfig) {
  return String(appConfig?.bugzilla?.storyPointsField || "cf_fx_points").trim();
}

function getBoardBugFields(appConfig = defaultConfig) {
  return Array.from(new Set([
    ...BOARD_BUG_FIELDS.split(","),
    getStoryPointsField(appConfig),
  ])).join(",");
}

function getStoryPoints(bug, storyPointsField) {
  const raw = bug?.[storyPointsField] ?? bug?.cf_fx_points ?? bug?.cf_story_points ??
    bug?.story_points ?? bug?.points;
  const value = String(raw ?? "").trim();

  if (!value || value === "---") {
    return null;
  }

  const points = Number(value);

  return Number.isFinite(points) ? points : value;
}

function getAssignee(bug) {
  const detail = bug?.assigned_to_detail || {};
  const email = String(detail.email || detail.name || bug?.assigned_to || "").trim();
  const name = String(detail.real_name || detail.realName || email).trim();

  if (!email || /^(nobody|defaultassignee)@/i.test(email)) {
    return null;
  }

  return { email, name: name || email };
}

function isComplete(bug) {
  const resolution = String(bug?.resolution || "").trim();

  return Boolean(
    bug?.is_open === false ||
    (resolution && resolution !== "---") ||
    /closed/i.test(String(bug?.status || "")) ||
    (bug?.keywords || []).includes(CHECKIN_NEEDED_KEYWORD),
  );
}

function hasReview(transactions = []) {
  return transactions.some((transaction) => {
    const action = String(transaction?.action || transaction?.type || "")
      .trim()
      .toLowerCase();
    const content = String(
      transaction?.content?.raw ??
      transaction?.content ??
      transaction?.comments?.[0]?.content?.raw ??
      transaction?.comments?.[0]?.content ??
      "",
    ).trim();

    return REVIEW_ACTIONS.has(action) ||
      ((action === "comment" || action === "inline") && Boolean(content));
  });
}

function getBoardColumn({ bug, patches, points, assignee }) {
  if (isComplete(bug)) {
    return "complete";
  }

  if (patches.some((patch) => patch.hasReview)) {
    return "in-review";
  }

  if (patches.length) {
    return "in-progress";
  }

  if (assignee) {
    return "assigned";
  }

  return points === null ? "backlog" : "ready";
}

function normalizeRevision(revision, transactions = []) {
  const numericId = String(revision?.id || "").replace(/^D/i, "");

  return {
    id: numericId ? `D${numericId}` : "",
    numericId,
    status: revision?.status || "",
    statusName: revision?.statusName || revision?.status || "Unknown",
    title: revision?.title || "",
    url: revision?.uri || getPhabUrl(`D${numericId}`),
    hasReview: hasReview(transactions),
  };
}

function normalizeBoardBug(bug, {
  parentMeta,
  patches = [],
  storyPointsField,
}) {
  const points = getStoryPoints(bug, storyPointsField);
  const assignee = getAssignee(bug);

  return {
    id: String(bug.id),
    url: getBugUrl(bug.id),
    summary: bug.summary || "Untitled Bugzilla bug",
    points,
    assignee,
    parentMeta: {
      id: String(parentMeta.id),
      url: getBugUrl(parentMeta.id),
      summary: parentMeta.summary || `Bug ${parentMeta.id}`,
    },
    patches,
    column: getBoardColumn({ bug, patches, points, assignee }),
    status: bug.status || "",
    resolution: bug.resolution || "---",
    isOpen: bug.is_open !== false,
    checkinNeeded: (bug.keywords || []).includes(CHECKIN_NEEDED_KEYWORD),
    createdAt: bug.creation_time || "",
  };
}

async function getBugsMap(ids, { getBugsByIds, includeFields }) {
  const bugsById = new Map();

  for (const idsChunk of chunk(uniqueIds(ids), 200)) {
    const bugs = await getBugsByIds(idsChunk, { includeFields });

    for (const bug of bugs || []) {
      if (bug?.id) {
        bugsById.set(String(bug.id), bug);
      }
    }
  }

  return bugsById;
}

async function getMetaBoardTree({ metaBugId, getBugsByIds, includeFields }) {
  const initial = await getBugsMap([metaBugId], { getBugsByIds, includeFields });
  const root = initial.get(String(metaBugId));

  if (!root) {
    const error = new Error(`Bug ${metaBugId} was not found.`);

    error.statusCode = 404;
    throw error;
  }

  const bugsById = initial;
  const directIds = uniqueIds(root.depends_on);
  const directBugs = await getBugsMap(directIds, { getBugsByIds, includeFields });

  for (const [id, bug] of directBugs) {
    bugsById.set(id, bug);
  }

  const childMetas = [];
  const stories = new Map();
  const queued = [];
  const seen = new Set([String(root.id)]);

  for (const id of directIds) {
    const child = bugsById.get(id);

    if (!child || seen.has(id)) {
      continue;
    }

    seen.add(id);

    const childIsMeta = isMetaBug(child);
    const childIsSprint = isSprintMetaBug(child);
    const parentMeta = childIsMeta ? child : root;

    if (childIsMeta) {
      childMetas.push(child);
    } else {
      stories.set(id, { bug: child, parentMeta: root });
    }

    if (!childIsSprint) {
      queued.push(...uniqueIds(child.depends_on).map((childId) => ({
        id: childId,
        parentMeta,
      })));
    }
  }

  while (queued.length && bugsById.size < MAX_META_BOARD_BUGS) {
    const batch = queued.splice(0, 200);
    const nextIds = batch.map((entry) => entry.id).filter((id) => !bugsById.has(id));
    const nextBugs = await getBugsMap(nextIds, { getBugsByIds, includeFields });

    for (const [id, bug] of nextBugs) {
      bugsById.set(id, bug);
    }

    for (const entry of batch) {
      const bug = bugsById.get(entry.id);

      if (!bug || seen.has(entry.id)) {
        continue;
      }

      seen.add(entry.id);

      const bugIsSprint = isSprintMetaBug(bug);

      if (!isMetaBug(bug)) {
        stories.set(entry.id, { bug, parentMeta: entry.parentMeta });
      }

      if (!bugIsSprint) {
        queued.push(...uniqueIds(bug.depends_on)
          .filter((id) => !seen.has(id))
          .map((id) => ({ id, parentMeta: entry.parentMeta })));
      }
    }
  }

  return {
    root,
    childMetas: childMetas.length ? childMetas : [root],
    stories: Array.from(stories.values()),
  };
}

async function getStoryPatches({ stories, getBugsWithAttachmentsByIds, phab }) {
  const errors = [];
  const storyIds = stories.map(({ bug }) => String(bug.id));
  const attachmentBugs = await getBugsWithAttachmentsByIds(storyIds);
  const revisionIdsByStoryId = new Map((attachmentBugs || []).map((bug) => [
    String(bug.id),
    uniqueIds(getRevisionIds(bug.attachments)),
  ]));
  const revisionIds = uniqueIds(Array.from(revisionIdsByStoryId.values()).flat());
  const revisionsById = new Map();
  const transactionsByRevisionId = new Map();

  for (const ids of chunk(revisionIds)) {
    try {
      const response = await phab({
        route: "differential.query",
        params: { ids: ids.map(Number) },
      });

      for (const revision of response?.result || []) {
        const numericId = String(revision?.id || "").replace(/^D/i, "");

        if (numericId) {
          revisionsById.set(numericId, revision);
        }
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }

  for (const ids of chunk(Array.from(revisionsById.keys()))) {
    try {
      const response = await phab({
        route: "differential.getrevisioncomments",
        params: { ids: ids.map(Number), inlines: false },
      });

      for (const id of ids) {
        transactionsByRevisionId.set(id, response?.result?.[id] || []);
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }

  return {
    errors,
    patchesByStoryId: new Map(storyIds.map((storyId) => [
      storyId,
      (revisionIdsByStoryId.get(storyId) || [])
        .map((id) => revisionsById.get(id))
        .filter(Boolean)
        .map((revision) => normalizeRevision(
          revision,
          transactionsByRevisionId.get(String(revision.id)) || [],
        )),
    ])),
  };
}

function sortCards(first, second) {
  const firstCreatedAt = Date.parse(first.createdAt);
  const secondCreatedAt = Date.parse(second.createdAt);
  const firstOrder = Number.isFinite(firstCreatedAt) ? firstCreatedAt : Number(first.id);
  const secondOrder = Number.isFinite(secondCreatedAt) ? secondCreatedAt : Number(second.id);

  return firstOrder - secondOrder || Number(first.id) - Number(second.id);
}

export async function getMetaBoardData({
  metaBugId,
  appConfig = defaultConfig,
  getBugsByIds = defaultGetBugsByIds,
  getBugsWithAttachmentsByIds = defaultGetBugsWithAttachmentsByIds,
  phab = defaultPhab,
} = {}) {
  const storyPointsField = getStoryPointsField(appConfig);
  const includeFields = getBoardBugFields(appConfig);
  const tree = await getMetaBoardTree({ metaBugId, getBugsByIds, includeFields });
  const patches = await getStoryPatches({
    stories: tree.stories,
    getBugsWithAttachmentsByIds,
    phab,
  });
  const columns = Object.fromEntries(META_BOARD_COLUMNS.map(({ id }) => [id, []]));
  const cards = tree.stories
    .map(({ bug, parentMeta }) => normalizeBoardBug(bug, {
      parentMeta,
      patches: patches.patchesByStoryId.get(String(bug.id)) || [],
      storyPointsField,
    }))
    .sort(sortCards);

  for (const card of cards) {
    columns[card.column].push(card);
  }

  return {
    id: String(tree.root.id),
    metaBug: {
      id: String(tree.root.id),
      summary: tree.root.summary || `Bug ${tree.root.id}`,
      url: getBugUrl(tree.root.id),
      product: tree.root.product || "",
      component: tree.root.component || "",
      version: tree.root.version || "",
      opSys: tree.root.op_sys || "",
      platform: tree.root.platform || "",
    },
    childMetas: tree.childMetas.filter((meta) => !isSprintMetaBug(meta)).map((meta) => ({
      id: String(meta.id),
      summary: meta.summary || `Bug ${meta.id}`,
      url: getBugUrl(meta.id),
    })),
    sprints: tree.childMetas
      .filter(isSprintMetaBug)
      .map(normalizeSprintMeta),
    assignees: Array.from(new Map(cards
      .filter((card) => card.assignee)
      .map((card) => [card.assignee.email, card.assignee])).values())
      .sort((first, second) => first.name.localeCompare(second.name)),
    cards,
    columns,
    errors: errorsFromUnique(patches.errors),
  };
}

function errorsFromUnique(errors = []) {
  return Array.from(new Set(errors.filter(Boolean)));
}

function getDescription(comments = []) {
  const descriptions = comments
    .map((comment) => String(comment?.text || comment?.body || "").trim())
    .filter(Boolean);
  const override = descriptions.findLast((text) => text.startsWith(DESCRIPTION_COMMENT_PREFIX));

  if (override) {
    return override.slice(DESCRIPTION_COMMENT_PREFIX.length).trim();
  }

  return descriptions[0] || "";
}

function normalizeRelationBugs(bugs = []) {
  return bugs.map((bug) => ({
    id: String(bug.id),
    summary: bug.summary || `Bug ${bug.id}`,
    status: bug.status || "",
    url: getBugUrl(bug.id),
  }));
}

export async function getMetaBoardBugDetail({
  bugId,
  appConfig = defaultConfig,
  getBugComments = defaultGetBugComments,
  getBugsByIds = defaultGetBugsByIds,
  getNotionStoriesByBugId,
} = {}) {
  const storyPointsField = getStoryPointsField(appConfig);
  const includeFields = getBoardBugFields(appConfig);
  const bugsById = await getBugsMap([bugId], { getBugsByIds, includeFields });
  const bug = bugsById.get(String(bugId));

  if (!bug) {
    const error = new Error(`Bug ${bugId} was not found.`);

    error.statusCode = 404;
    throw error;
  }

  const relationIds = uniqueIds([...(bug.depends_on || []), ...(bug.blocks || [])]);
  const [relationBugs, comments, notion] = await Promise.all([
    getBugsByIds(relationIds, { includeFields: "id,summary,status,resolution,is_open" }),
    getBugComments(String(bug.id)),
    getNotionStoriesByBugId ? getNotionStoriesByBugId({ bugId: String(bug.id) }) : null,
  ]);
  const relationById = new Map((relationBugs || []).map((relation) => [
    String(relation.id),
    relation,
  ]));

  return {
    id: String(bug.id),
    url: getBugUrl(bug.id),
    summary: bug.summary || `Bug ${bug.id}`,
    status: bug.status || "",
    resolution: bug.resolution || "---",
    points: getStoryPoints(bug, storyPointsField),
    assignee: getAssignee(bug),
    dependsOn: normalizeRelationBugs(uniqueIds(bug.depends_on)
      .map((id) => relationById.get(id))
      .filter(Boolean)),
    blocks: normalizeRelationBugs(uniqueIds(bug.blocks)
      .map((id) => relationById.get(id))
      .filter(Boolean)),
    description: getDescription(comments),
    notion: notion || null,
  };
}

export function parseMetaBoardBugIds(value) {
  return uniqueIds(String(value || "").split(/[\s,]+/));
}

export async function updateMetaBoardBug({
  bugId,
  changes = {},
  appConfig = defaultConfig,
  updateBug = defaultUpdateBug,
} = {}) {
  const id = uniqueIds([bugId])[0];

  if (!id) {
    const error = new Error("A valid Bugzilla bug ID is required.");

    error.statusCode = 400;
    throw error;
  }

  const updates = {};

  if (Object.hasOwn(changes, "summary")) {
    updates.summary = String(changes.summary || "").trim();
  }

  if (Object.hasOwn(changes, "points")) {
    const value = String(changes.points ?? "").trim();
    const points = value ? Number(value) : null;

    if (value && !Number.isFinite(points)) {
      const error = new Error("Story points must be a number.");

      error.statusCode = 400;
      throw error;
    }

    updates[getStoryPointsField(appConfig)] = points;
  }

  if (Object.hasOwn(changes, "assignee")) {
    updates.assigned_to = String(changes.assignee || "").trim();
  }

  if (Object.hasOwn(changes, "dependsOn")) {
    updates.depends_on = { set: parseMetaBoardBugIds(changes.dependsOn) };
  }

  if (Object.hasOwn(changes, "blocks")) {
    updates.blocks = { set: parseMetaBoardBugIds(changes.blocks) };
  }

  if (Object.hasOwn(changes, "description")) {
    const description = String(changes.description || "").trim();

    updates.comment = {
      body: `${DESCRIPTION_COMMENT_PREFIX}\n\n${description}`,
    };
  }

  if (!Object.keys(updates).length) {
    return null;
  }

  return updateBug(id, updates);
}
