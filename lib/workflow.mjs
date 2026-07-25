import { DEFAULT_BRANCH, getCommitMessage, getCurrentBranch, getFileStatus, git } from "./git.mjs";
import { getUrls } from "./utils.mjs";

export function getBugIdFromText(text = "") {
  const match = text.match(/\bBug[-\s#]*(\d{4,8})\b/i);
  return match?.[1];
}

export function getPhabRevisionFromText(text = "") {
  const urlMatch = text.match(/phabricator\.services\.mozilla\.com\/D(\d+)/i);
  if (urlMatch) {
    return `D${urlMatch[1]}`;
  }

  const revisionMatch = text.match(/\bD(\d{4,})\b/);
  return revisionMatch ? `D${revisionMatch[1]}` : undefined;
}

export function getTryUrlFromText(text = "") {
  const urls = getUrls(text) || [];
  return urls.find((url) => /treeherder\.mozilla\.org\/jobs/.test(url) && /repo=try/.test(url));
}

export function getBugUrl(bugId) {
  return `https://bugzilla.mozilla.org/show_bug.cgi?id=${bugId}`;
}

export function getPhabUrl(revision) {
  return `https://phabricator.services.mozilla.com/${revision}`;
}

async function getAheadCount(base) {
  try {
    return (await git(["rev-list", "--count", `${base}..HEAD`], undefined, true)).trim();
  } catch {
    return "unknown";
  }
}

async function getPendingCommits(base) {
  try {
    return (await git(["log", "--oneline", `${base}..HEAD`], undefined, true)).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function getWorkspaceContext({ base = `origin/${DEFAULT_BRANCH}` } = {}) {
  const branch = await getCurrentBranch();
  const commitMessage = await getCommitMessage().catch(() => "");
  const changedFiles = await getFileStatus();
  const pendingCommits = await getPendingCommits(base);
  const haystack = `${branch}\n${commitMessage}\n${pendingCommits.join("\n")}`;
  const bugId = getBugIdFromText(haystack);
  const phabRevision = getPhabRevisionFromText(haystack);
  const tryUrl = getTryUrlFromText(haystack);

  return {
    base,
    branch: branch || "(detached)",
    ahead: await getAheadCount(base),
    changedFiles,
    pendingCommits,
    bugId,
    bugUrl: bugId ? getBugUrl(bugId) : undefined,
    phabRevision,
    phabUrl: phabRevision ? getPhabUrl(phabRevision) : undefined,
    tryUrl,
  };
}

export function formatWorkspaceStatus(context) {
  const lines = [
    `Branch: ${context.branch}`,
    `Base: ${context.base}`,
    `Commits ahead: ${context.ahead}`,
    `Working tree: ${context.changedFiles.length ? `${context.changedFiles.length} changed file(s)` : "clean"}`,
    `Bug: ${context.bugId ? `${context.bugId} (${context.bugUrl})` : "not detected"}`,
    `Phabricator: ${context.phabRevision ? `${context.phabRevision} (${context.phabUrl})` : "not detected"}`,
    `Try: ${context.tryUrl || "not detected"}`,
  ];

  if (context.pendingCommits.length) {
    lines.push("", "Pending commits:");
    lines.push(...context.pendingCommits.map((commit) => `  ${commit}`));
  }

  if (context.changedFiles.length) {
    lines.push("", "Changed files:");
    lines.push(...context.changedFiles.map(({ status, file }) => `  ${status} ${file}`));
  }

  return lines.join("\n");
}
