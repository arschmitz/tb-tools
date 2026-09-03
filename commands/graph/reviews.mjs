import defaultPhab from "../../lib/phab.mjs";
import { diffLines } from "diff";
import {
  getPhabRevisionFromText,
  getPhabUrl,
} from "../../lib/workflow.mjs";
import {
  getGraphCommitMessage,
  isWorkingTreeCommitHash,
} from "./data.mjs";

const TRANSACTION_PAGE_SIZE = 100;

function getGraphCommitReviewHaystack({ graph, hash, message }) {
  const commit = (graph.commits || []).find((item) => item.hash === hash);

  return [
    message,
    commit?.subject,
    ...(commit?.refs || []),
  ].filter(Boolean).join("\n");
}

function getReviewerNames(response) {
  const names = new Map();

  for (const user of response?.result || []) {
    if (!user?.phid) {
      continue;
    }

    names.set(user.phid, user.realName || user.userName || user.phid);
  }

  return names;
}

async function getReviewerNamesByPhid({ phids, phab }) {
  if (!phids.length) {
    return new Map();
  }

  try {
    return getReviewerNames(await phab({
      route: "user.query",
      params: { phids },
    }));
  } catch {
    return new Map();
  }
}

async function getRevisionTransactions({ revision, phab }) {
  const transactions = [];
  let after = null;

  do {
    const response = await phab({
      route: "transaction.search",
      params: {
        objectIdentifier: revision,
        limit: TRANSACTION_PAGE_SIZE,
        ...(after ? { after } : {}),
      },
    });
    const result = response?.result || {};

    transactions.push(...(result.data || []));
    after = result.cursor?.after || null;
  } while (after);

  return transactions;
}

function getTransactionCommentContent(comment) {
  return String(comment?.content?.raw ?? comment?.content ?? "").trimEnd();
}

function getTransactionComments(transaction) {
  return (transaction?.comments || []).filter((comment) => !comment?.removed);
}

function getTransactionCommentId(transaction, comment, index) {
  return String(
    comment?.phid ||
    comment?.id ||
    transaction?.phid ||
    transaction?.id ||
    index,
  );
}

function getTransactionCommentAuthorPhid(transaction, comment) {
  return String(comment?.authorPHID || transaction?.authorPHID || "");
}

function getTransactionCommentDate(transaction, comment) {
  return Number(comment?.dateCreated || transaction?.dateCreated) || 0;
}

function getTransactionAction(transaction) {
  const action = String(transaction?.type || "comment");

  return action === "inline" ? "comment" : action;
}

function getSuggestionMarkdownContent(value) {
  const match = String(value || "").match(/```suggestion\s*\r?\n([\s\S]*?)```/i);

  return match ? match[1].trimEnd() : "";
}

function getInlineSuggestionText(transaction, comment) {
  const candidates = [
    comment?.suggestionText,
    comment?.content?.suggestionText,
    transaction?.fields?.suggestionText,
    transaction?.fields?.suggestion?.text,
    getSuggestionMarkdownContent(getTransactionCommentContent(comment)),
  ];

  return String(candidates.find((value) => typeof value === "string") || "")
    .trimEnd();
}

function getInlineProseContent(comment) {
  return getTransactionCommentContent(comment)
    .replace(/```suggestion\s*\r?\n[\s\S]*?```/gi, "")
    .trimEnd();
}

function getPhabCommentUrl({ comment, revision }) {
  const commentId = Number(comment?.id);

  return Number.isInteger(commentId) && commentId > 0
    ? `${getPhabUrl(revision)}#inline-${commentId}`
    : getPhabUrl(revision);
}

function getNormalizedFilePath(filePath) {
  return String(filePath || "")
    .replace(/^(?:a|b)\//, "")
    .replace(/^comm\//, "");
}

function getDiffFileLines(diff, filePath) {
  const normalizedPath = getNormalizedFilePath(filePath);
  const change = (diff?.changes || []).find((item) => (
    [item?.currentPath, item?.oldPath]
      .map(getNormalizedFilePath)
      .includes(normalizedPath)
  ));

  if (!change?.hunks?.length) {
    return null;
  }

  const lines = [];

  for (const hunk of change.hunks) {
    let lineNumber = Number(hunk?.newOffset);

    if (!Number.isInteger(lineNumber) || lineNumber < 1) {
      return null;
    }

    for (const rawLine of String(hunk?.corpus || "").split(/\r?\n/)) {
      const prefix = rawLine[0];

      if (!prefix || ![" ", "+", "-"].includes(prefix)) {
        continue;
      }

      if (prefix === "-") {
        continue;
      }

      lines[lineNumber - 1] = rawLine.slice(1);
      lineNumber++;
    }
  }

  return lines.length && lines.every((line) => typeof line === "string")
    ? lines
    : null;
}

function getChangedLineBlocks(originalLines, revisedLines) {
  const blocks = [];
  let block = null;
  let originalLine = 1;

  function flushBlock() {
    if (block) {
      blocks.push(block);
      block = null;
    }
  }

  for (const component of diffLines(
    `${originalLines.join("\n")}\n`,
    `${revisedLines.join("\n")}\n`,
  )) {
    const lines = component.value.split(/\r?\n/).slice(0, -1);

    if (!component.added && !component.removed) {
      flushBlock();
      originalLine += lines.length;
      continue;
    }

    block ||= {
      originalEnd: originalLine,
      originalStart: originalLine,
      replacement: [],
    };

    if (component.removed) {
      originalLine += lines.length;
      block.originalEnd = originalLine;
    } else {
      block.replacement.push(...lines);
    }
  }

  flushBlock();
  return blocks;
}

function getRecoveredSuggestionContent({
  originalDiff,
  revisedDiff,
  filePath,
  lineLength,
  lineNumber,
}) {
  const originalLines = getDiffFileLines(originalDiff, filePath);
  const revisedLines = getDiffFileLines(revisedDiff, filePath);

  if (!originalLines || !revisedLines) {
    return "";
  }

  const selectionStart = lineNumber;
  const selectionEnd = lineNumber + lineLength;
  const block = getChangedLineBlocks(originalLines, revisedLines).find((item) => {
    const isInsertionInSelection = (
      item.originalStart === item.originalEnd &&
      item.originalStart >= selectionStart &&
      item.originalStart <= selectionEnd
    );
    const isReplacementInSelection = (
      item.originalStart >= selectionStart &&
      item.originalEnd <= selectionEnd
    );

    return item.replacement.length && (
      isInsertionInSelection || isReplacementInSelection
    );
  });

  return block?.replacement.join("\n") || "";
}

function getRevisionDiffs(revision) {
  return Object.values(revision?.diffs || {})
    .filter((diff) => diff?.id)
    .sort((first, second) => (
      Number(first.dateCreated) - Number(second.dateCreated)
    ));
}

async function getRecoveredSuggestionContents({
  inlineSources,
  phab,
  revision,
}) {
  const suggestionSources = inlineSources.filter(({ comment, transaction }) => (
    !getTransactionCommentContent(comment) &&
    !getInlineSuggestionText(transaction, comment)
  ));

  if (!suggestionSources.length) {
    return new Map();
  }

  const revisionId = Number(String(revision).replace(/^D/, ""));

  if (!Number.isInteger(revisionId)) {
    return new Map();
  }

  let response;

  try {
    response = await phab({
      route: "differential.getrevision",
      params: { revision_id: revisionId },
    });
  } catch {
    return new Map();
  }

  const diffs = getRevisionDiffs(response?.result);
  const diffsById = new Map(diffs.map((diff) => [Number(diff.id), diff]));
  const contents = new Map();

  for (const source of suggestionSources) {
    const originalDiff = diffsById.get(Number(source.transaction?.fields?.diff?.id));

    if (!originalDiff) {
      continue;
    }

    const lineNumber = Math.abs(Number(source.transaction?.fields?.line));
    const lineLength = Number(source.transaction?.fields?.length) || 1;
    const filePath = source.transaction?.fields?.path;
    const dateCreated = getTransactionCommentDate(
      source.transaction,
      source.comment,
    );

    if (!filePath || !Number.isInteger(lineNumber) || lineNumber < 1) {
      continue;
    }

    for (const revisedDiff of diffs) {
      if (Number(revisedDiff.dateCreated) <= dateCreated) {
        continue;
      }

      const content = getRecoveredSuggestionContent({
        filePath,
        lineLength,
        lineNumber,
        originalDiff,
        revisedDiff,
      });

      if (content) {
        contents.set(
          getTransactionCommentId(
            source.transaction,
            source.comment,
            source.index,
          ),
          content,
        );
        break;
      }
    }
  }

  return contents;
}

function getInlineCodeSuggestion({
  recoveredSuggestionContents,
  transaction,
  comment,
  index,
  revision,
  webSuggestionContents,
}) {
  const webSuggestion = webSuggestionContents?.get?.(String(comment?.id)) || null;
  const content = (
    getInlineSuggestionText(transaction, comment) ||
    webSuggestion?.content ||
    recoveredSuggestionContents.get(
      getTransactionCommentId(transaction, comment, index),
    ) ||
    ""
  );

  // Suggestion-only inlines have an empty comment body. Their saved state is
  // not exposed by Conduit, so recover a replacement only from a matching
  // later revision diff and otherwise keep the direct Phabricator anchor.
  if (!content && !webSuggestion && getTransactionCommentContent(comment)) {
    return null;
  }

  const commentId = Number(comment?.id);

  return {
    content,
    ...(webSuggestion?.isDeletion ? { isDeletion: true } : {}),
    url: Number.isInteger(commentId) && commentId > 0
      ? `${getPhabUrl(revision)}#inline-${commentId}`
      : getPhabUrl(revision),
  };
}

function normalizeReviewComment({
  transaction,
  comment,
  index,
  reviewerNames,
  revision,
}) {
  const authorPhid = getTransactionCommentAuthorPhid(transaction, comment);

  return {
    action: getTransactionAction(transaction),
    author: reviewerNames.get(authorPhid) || authorPhid || "Unknown reviewer",
    authorPhid,
    content: getTransactionCommentContent(comment),
    dateCreated: getTransactionCommentDate(transaction, comment),
    id: getTransactionCommentId(transaction, comment, index),
    url: getPhabCommentUrl({ comment, revision }),
  };
}

function normalizeInlineComment({
  transaction,
  comment,
  index,
  recoveredSuggestionContents,
  reviewerNames,
  revision,
  webSuggestionContents,
}) {
  const line = Number(transaction?.fields?.line);
  const lineNumber = Math.abs(line);
  const filePath = transaction?.fields?.path;

  if (!filePath || !Number.isInteger(lineNumber) || lineNumber < 1) {
    return null;
  }

  const normalized = normalizeReviewComment({
    transaction,
    comment,
    index,
    reviewerNames,
    revision,
  });
  normalized.content = getInlineProseContent(comment);
  const isNewFile = typeof transaction.fields.isNewFile === "boolean"
    ? transaction.fields.isNewFile
    : null;
  const codeSuggestion = getInlineCodeSuggestion({
    comment,
    index,
    recoveredSuggestionContents,
    revision,
    transaction,
    webSuggestionContents,
  });

  return {
    ...normalized,
    ...(codeSuggestion ? { codeSuggestion } : {}),
    commentId: normalized.id,
    diffId: Number(transaction.fields.diff?.id) || null,
    filePath: String(filePath),
    isNewFile,
    lineLength: Number(transaction.fields.length) || 1,
    lineNumber,
    url: getPhabCommentUrl({ comment, revision }),
  };
}

function isRegularReviewComment(comment) {
  return Boolean(comment.content || comment.codeSuggestion?.content);
}

function uniqueComments(comments) {
  const seen = new Set();

  return comments.filter((comment) => {
    if (seen.has(comment.id)) {
      return false;
    }

    seen.add(comment.id);
    return true;
  });
}

function getReviewSources(transactions, revisionAuthorPhid = "") {
  const inlineSources = [];
  const regularSources = [];

  for (const transaction of transactions) {
    const comments = getTransactionComments(transaction).filter((comment) => (
      !revisionAuthorPhid ||
      getTransactionCommentAuthorPhid(transaction, comment) !== revisionAuthorPhid
    ));

    if (transaction?.type === "inline") {
      comments.forEach((comment, index) => {
        inlineSources.push({ comment, index, transaction });
      });
      continue;
    }

    if (comments.length) {
      comments.forEach((comment, index) => {
        regularSources.push({ comment, index, transaction });
      });
      continue;
    }

  }

  return { inlineSources, regularSources };
}

async function getRevisionAuthorPhid({ revision, phab }) {
  const revisionId = Number(String(revision).replace(/^D/, ""));

  if (!Number.isInteger(revisionId)) {
    return "";
  }

  try {
    const response = await phab({
      route: "differential.query",
      params: { ids: [revisionId] },
    });

    return String(response?.result?.[0]?.authorPHID || "");
  } catch {
    return "";
  }
}

function getReviewAuthorPhids(sources) {
  return Array.from(new Set(sources
    .map(({ comment, transaction }) => (
      getTransactionCommentAuthorPhid(transaction, comment)
    ))
    .filter(Boolean)));
}

export async function getGraphCommitReview({
  graph,
  hash,
  runCommand,
  phab = defaultPhab,
  getWebSuggestions,
}) {
  if (!graph) {
    const error = new Error("Unknown graph checkout.");

    error.statusCode = 404;
    throw error;
  }

  if (isWorkingTreeCommitHash(hash)) {
    return { available: false, comments: [], inlineComments: [] };
  }

  const message = await getGraphCommitMessage({
    graph,
    hash,
    runCommand,
  });
  const revision = getPhabRevisionFromText(getGraphCommitReviewHaystack({
    graph,
    hash,
    message,
  }));

  if (!revision) {
    return { available: false, comments: [], inlineComments: [] };
  }

  const result = {
    available: true,
    comments: [],
    inlineComments: [],
    revision,
    url: getPhabUrl(revision),
  };

  try {
    const [transactions, revisionAuthorPhid] = await Promise.all([
      getRevisionTransactions({ revision, phab }),
      getRevisionAuthorPhid({ revision, phab }),
    ]);
    const { inlineSources, regularSources } = getReviewSources(
      transactions,
      revisionAuthorPhid,
    );
    const reviewerNames = await getReviewerNamesByPhid({
      phab,
      phids: getReviewAuthorPhids([...regularSources, ...inlineSources]),
    });
    const recoveredSuggestionContents = await getRecoveredSuggestionContents({
      inlineSources,
      phab,
      revision,
    });
    let webSuggestionContents = new Map();

    if (getWebSuggestions) {
      try {
        webSuggestionContents = await getWebSuggestions({
          revision,
          inlineComments: inlineSources
            .map(({ comment, transaction }) => ({
              id: String(comment?.id || ""),
              diffId: Number(transaction?.fields?.diff?.id) || null,
            }))
            .filter(({ id }) => Boolean(id)),
        }) || new Map();
      } catch {
        webSuggestionContents = new Map();
      }
    }

    result.comments = uniqueComments(regularSources
      .map((source) => normalizeReviewComment({
        ...source,
        reviewerNames,
        revision,
      }))
      .filter(isRegularReviewComment));
    result.inlineComments = uniqueComments(inlineSources
      .map((source) => normalizeInlineComment({
        ...source,
        reviewerNames,
        recoveredSuggestionContents,
        revision,
        webSuggestionContents,
      }))
      .filter(Boolean))
      .sort((first, second) => first.dateCreated - second.dateCreated);
  } catch (error) {
    result.error = String(error?.message || error);
  }

  return result;
}
