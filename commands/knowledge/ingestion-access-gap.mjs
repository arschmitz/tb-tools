import { validateRecord } from "./store.mjs";

export const INGESTION_ACCESS_GAP_STATUS = "examined-with-available-context-and-access-gap";

const publicReason = "Assigned browser contexts deny access. Unavailable discussion content was not read.";
const evidenceId = /^[a-f0-9]{64}$/;
const completedContextStatuses = new Set([
  "read-complete-visible-retained-context",
  "read-complete-retained-context",
  "restricted-readable-private",
]);
const unreadScopeFlags = [
  "contentRead", "mainContentRead", "completeAvailableContext", "completeVisibleTimeline",
  "completeHumanTimeline", "completeSubmittedInlineThreads", "timelineThroughCreation",
];

function canonicalContextUrl(url, surface) {
  return typeof url === "string" && (surface === "bugzilla"
    ? /^https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=[1-9]\d*$/.test(url)
    : /^https:\/\/phabricator\.services\.mozilla\.com\/D[1-9]\d*$/.test(url));
}

function reject(index) {
  throw new Error(`Unverified access gap: ${index}`);
}

function pageDeniesAccess(record, context, surface, index) {
  if (!record || record.kind !== "evidence" || record.visibility !== "private" ||
      record.repository !== "thunderbird" || record.source?.type !== "browser-discussion" ||
      record.source.public !== false || record.source.url !== context.url) {
    reject(index);
  }

  let page;
  try {
    validateRecord(record);
    page = JSON.parse(record.text);
  } catch {
    reject(index);
  }

  if (page.url !== context.url || typeof page.body !== "string") reject(index);

  const scope = record.source.readScope;
  if (!scope || unreadScopeFlags.some(key => scope[key] !== undefined && scope[key] !== false)) reject(index);

  const savedScope = page.readScope;
  if (savedScope !== undefined && (!savedScope || typeof savedScope !== "object" ||
      Array.isArray(savedScope) ||
      unreadScopeFlags.some(key => savedScope[key] !== undefined && savedScope[key] !== false) ||
      (savedScope.blocked !== undefined && savedScope.blocked !== "access-denied") ||
      (savedScope.accessDenied !== undefined && savedScope.accessDenied !== true))) reject(index);

  const assignments = [record.source.historyIndices, scope.appliesToIndices, savedScope?.appliesToIndices, page.indices]
    .filter(value => value !== undefined);
  if (assignments.some(value => !Array.isArray(value) || !value.includes(index))) reject(index);

  if (surface === "bugzilla") {
    const match = context.url.match(/^https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=([1-9]\d*)$/);
    if (!match || scope.blocked !== "access-denied" || scope.completeVisibleTimeline !== false ||
        page.title !== "Access Denied" ||
        !page.body.includes(`You are not authorized to access bug ${match[1]}.`)) reject(index);
  } else {
    if (!/^https:\/\/phabricator\.services\.mozilla\.com\/D[1-9]\d*$/.test(context.url) ||
        scope.accessDenied !== true || scope.contentRead !== false ||
        scope.completeAvailableContext !== false || scope.completeHumanTimeline !== false ||
        scope.completeSubmittedInlineThreads !== false ||
        page.title !== "Access Denied: Restricted Differential Revision" ||
        !page.body.includes("You do not have permission to view this object.")) reject(index);
  }
}

/** Validates each denied context against its private immutable browser capture. */
export function validateIngestionAccessGap(row, getRecord) {
  if (!row || row.status !== INGESTION_ACCESS_GAP_STATUS ||
      !Number.isSafeInteger(row.index) || row.index < 1 ||
      typeof row.reason !== "string" || !row.reason.trim() || typeof getRecord !== "function") {
    reject(row?.index);
  }

  const denied = [];
  for (const [surface, contexts] of [["bugzilla", row.bugs || []], ["phabricator", row.reviews || []]]) {
    if (!Array.isArray(contexts)) reject(row.index);

    for (const context of contexts) {
      if (!context || !canonicalContextUrl(context.url, surface)) reject(row.index);
      if (context.status !== "access-denied") {
        if (!completedContextStatuses.has(context.status)) reject(row.index);
        continue;
      }
      if (context.contentRead !== false || context.completeAvailableContext !== false ||
          !Array.isArray(context.evidence) || !context.evidence.length) reject(row.index);

      for (const id of context.evidence) {
        if (typeof id !== "string" || !evidenceId.test(id)) reject(row.index);
        const record = getRecord(id);
        if (record?.id !== id) reject(row.index);
        pageDeniesAccess(record, context, surface, row.index);
      }
      denied.push({ surface, url: context.url, evidence: [...context.evidence] });
    }
  }
  if (!denied.length) reject(row.index);

  return { index: row.index, contexts: denied };
}

function publicContext(context) {
  return {
    url: context.url,
    status: context.status,
    ...(context.status === "access-denied"
      ? { contentRead: false, completeAvailableContext: false, sharedRaw: false }
      : {}),
  };
}

/** Returns gap metadata that contains no private capture IDs or discussion prose. */
export function projectIngestionAccessGap(row, getRecord) {
  const validated = validateIngestionAccessGap(row, getRecord);
  return {
    index: row.index,
    hash: row.hash,
    status: INGESTION_ACCESS_GAP_STATUS,
    reason: publicReason,
    paths: [...(row.paths || [])],
    fullHistoricalDiffRead: row.fullHistoricalDiffRead === true,
    fullEligibleOwnedDiffRead: row.fullEligibleOwnedDiffRead === true,
    complete: false,
    externalComplete: false,
    bugs: (row.bugs || []).map(publicContext),
    reviews: (row.reviews || []).map(publicContext),
    accessGap: {
      status: "access-denied",
      contentRead: false,
      completeAvailableContext: false,
      contexts: validated.contexts.map(({ surface, url }) => ({ surface, url })),
      reason: publicReason,
    },
  };
}
