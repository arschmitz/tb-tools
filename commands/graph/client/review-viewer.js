import { INTERACTIVE, graphStates } from "./config.js";
import { isWorkingTreeCommit } from "./commit-model.js";

const SUGGESTION_BLOCK_PATTERN = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;

function formatReviewDate(value) {
  const timestamp = Number(value);

  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp * 1000);

  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function getReviewActionLabel(action = "") {
  const normalized = String(action).toLowerCase();

  if (normalized === "accept") {
    return "Accepted";
  }

  if (["reject", "request", "request-changes"].includes(normalized)) {
    return "Requested changes";
  }

  if (normalized === "resign") {
    return "Resigned";
  }

  if (normalized === "comment") {
    return "Commented";
  }

  return action ? String(action) : "Commented";
}

function appendReviewText(container, text) {
  if (!text.trim()) {
    return;
  }

  const paragraph = document.createElement("p");

  paragraph.className = "review-comment-text";
  INLINE_CODE_PATTERN.lastIndex = 0;
  let lastIndex = 0;
  let match;

  while ((match = INLINE_CODE_PATTERN.exec(text))) {
    paragraph.append(document.createTextNode(text.slice(lastIndex, match.index)));

    const code = document.createElement("code");

    code.className = "review-inline-code";
    code.textContent = match[1];
    paragraph.append(code);
    lastIndex = match.index + match[0].length;
  }

  paragraph.append(document.createTextNode(text.slice(lastIndex).trim()));
  container.append(paragraph);
}

function appendReviewCodeBlock(container, { content, isSuggestion, language }) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");

  pre.className = isSuggestion ? "review-suggestion" : "review-code-block";
  if (language) {
    code.dataset.language = language;
  }
  code.textContent = content.trimEnd();
  pre.append(code);
  container.append(pre);
}

function appendReviewContent(container, content = "") {
  let lastIndex = 0;
  let match;

  SUGGESTION_BLOCK_PATTERN.lastIndex = 0;
  while ((match = SUGGESTION_BLOCK_PATTERN.exec(content))) {
    const before = content.slice(lastIndex, match.index);
    const language = match[1].trim();
    const isSuggestion = /\bsuggestion\b/i.test(language) || /(?:^|\n)\s*suggestion:\s*$/i.test(before);

    appendReviewText(container, before);

    appendReviewCodeBlock(container, {
      content: match[2],
      isSuggestion,
      language,
    });
    lastIndex = match.index + match[0].length;
  }

  appendReviewText(container, content.slice(lastIndex));
}

function appendReviewCodeSuggestion(container, suggestion) {
  const section = document.createElement("section");
  const label = document.createElement("p");

  section.className = "review-code-suggestion";
  label.className = "review-code-suggestion-label";
  label.textContent = "Code suggestion";
  section.append(label);

  if (suggestion.content) {
    appendReviewCodeBlock(section, {
      content: suggestion.content,
      isSuggestion: true,
      language: "",
    });
  } else if (suggestion.url) {
    const link = document.createElement("a");

    link.className = "review-code-suggestion-link";
    link.href = suggestion.url;
    link.rel = "noreferrer";
    link.target = "_blank";
    link.textContent = "View suggestion in Phabricator";
    section.append(link);
  }

  container.append(section);
}

function createReviewComment(comment, { inline = false, unmatched = false } = {}) {
  const article = document.createElement("article");
  const header = document.createElement("header");
  const author = document.createElement("strong");
  const action = document.createElement("span");
  const date = document.createElement("time");

  article.className = [
    "review-comment",
    inline ? "review-inline-comment" : "",
    unmatched ? "review-unmatched-comment" : "",
  ].filter(Boolean).join(" ");
  author.textContent = comment.author || "Unknown reviewer";
  action.className = "review-comment-action";
  action.textContent = getReviewActionLabel(comment.action);
  date.className = "review-comment-date";
  date.textContent = formatReviewDate(comment.dateCreated);
  header.append(author, action, date);
  article.append(header);
  appendReviewContent(article, comment.content);
  if (comment.codeSuggestion) {
    appendReviewCodeSuggestion(article, comment.codeSuggestion);
  }

  return article;
}

function getFilePathVariants(filePath = "") {
  const path = String(filePath)
    .replace(/^(?:a|b)\//, "")
    .replace(/^\.\//, "");
  const variants = new Set([path]);

  if (path.startsWith("comm/")) {
    variants.add(path.slice("comm/".length));
  } else if (path) {
    variants.add(`comm/${path}`);
  }

  return variants;
}

function reviewPathsMatch(firstPath, secondPath) {
  const firstVariants = getFilePathVariants(firstPath);
  const secondVariants = getFilePathVariants(secondPath);

  return [...firstVariants].some((path) => secondVariants.has(path));
}

function findReviewLine(body, inlineComment) {
  const lineKeys = inlineComment.isNewFile === false
    ? ["oldLine"]
    : inlineComment.isNewFile === true
      ? ["newLine"]
      : ["newLine", "oldLine"];
  const lineNumber = String(inlineComment.lineNumber);

  for (const file of body.querySelectorAll(".pretty-file")) {
    const candidatePaths = [
      file.dataset.filePath,
      file.dataset.oldFilePath,
      file.dataset.newFilePath,
    ];

    if (!candidatePaths.some((filePath) => (
      reviewPathsMatch(inlineComment.filePath, filePath)
    ))) {
      continue;
    }

    for (const row of file.querySelectorAll(".diff-line")) {
      if (lineKeys.some((lineKey) => row.dataset[lineKey] === lineNumber)) {
        return row;
      }
    }
  }

  return null;
}

function revealReviewedContextLine(row) {
  if (!row.hidden || !row.classList.contains("collapsed-context")) {
    return;
  }

  row.hidden = false;
  row.classList.remove("collapsed-context");
}

function appendInlineReviewComment(row, comment) {
  row.closest(".diff-table")?.classList.add("has-review-comments");

  let thread = row.nextElementSibling;

  if (!thread?.classList.contains("review-inline-thread")) {
    thread = document.createElement("tr");
    const cell = document.createElement("td");

    thread.className = "review-inline-thread";
    cell.colSpan = 3;
    thread.append(cell);
    row.after(thread);
  }

  thread.firstElementChild.append(createReviewComment(comment, { inline: true }));
}

function createReviewDiscussion(review, unmatchedComments) {
  if (!review.comments.length && !unmatchedComments.length && !review.error) {
    return null;
  }

  const discussion = document.createElement("details");
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  const link = document.createElement("a");
  const commentCount = review.comments.length + unmatchedComments.length;

  discussion.className = "review-discussion";
  summary.textContent = commentCount
    ? `Phabricator discussion (${commentCount})`
    : "Phabricator discussion";
  heading.className = "review-discussion-heading";
  link.href = review.url;
  link.rel = "noreferrer";
  link.target = "_blank";
  link.textContent = review.revision;
  heading.append(link);
  discussion.append(summary, heading);

  if (review.error) {
    const error = document.createElement("p");

    error.className = "review-discussion-error";
    error.textContent = review.error;
    discussion.append(error);
    return discussion;
  }

  review.comments.forEach((comment) => {
    discussion.append(createReviewComment(comment));
  });

  unmatchedComments.forEach((comment) => {
    const label = document.createElement("p");

    label.className = "review-unmatched-location";
    label.textContent = `${comment.filePath}:${comment.lineNumber}`;
    const item = createReviewComment(comment, { unmatched: true });

    item.prepend(label);
    discussion.append(item);
  });

  return discussion;
}

export async function fetchSelectedCommitReview(index, commit) {
  if (!INTERACTIVE.enabled || isWorkingTreeCommit(commit)) {
    return null;
  }

  try {
    const response = await fetch(
      "/api/graph/" + index + "/review/" + encodeURIComponent(commit.hash) +
        "?token=" + encodeURIComponent(INTERACTIVE.token),
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    return result;
  } catch (error) {
    return {
      available: true,
      comments: [],
      error: error && error.message ? error.message : String(error),
      inlineComments: [],
      revision: "Phabricator",
      url: "https://phabricator.services.mozilla.com/",
    };
  }
}

export function renderSelectedCommitReview(index, commit, body, review) {
  if (graphStates[index].selectedHash !== commit.hash || !review?.available) {
    return;
  }

  const unmatchedComments = [];

  for (const comment of review.inlineComments || []) {
    const line = findReviewLine(body, comment);

    if (!line) {
      unmatchedComments.push(comment);
      continue;
    }

    revealReviewedContextLine(line);
    appendInlineReviewComment(line, comment);
  }

  const discussion = createReviewDiscussion(review, unmatchedComments);

  if (discussion) {
    body.prepend(discussion);
  }
}
