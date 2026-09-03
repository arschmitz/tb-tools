import { randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import { getPhabRevisionFromText } from "../../lib/workflow.mjs";
import { getGraphCommitMessage } from "./data.mjs";
import { formatPrettyDiffHtml } from "./diff-renderer.mjs";
import {
  checkoutCommit,
  rebaseCommit,
  runGraphRepositoryUpdate,
} from "./actions.mjs";
import { getGraphCodexMemoryDirectory as getDefaultCodexMemoryDirectory } from "./patch-update-memory.mjs";
import {
  getGraphPatchUpdateHandledCommentIds as defaultGetHandledCommentIds,
  markGraphPatchUpdateCommentHandled as defaultPersistHandledComment,
} from "./patch-update-state.mjs";
import { getGraphCommitReview } from "./reviews.mjs";

const CODEX_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_COMMAND_ENV = "TB_TOOLS_CODEX_COMMAND";
const MACOS_CODEX_COMMAND = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_ACTIVITY_LIMIT = 200;
const CODEX_ACTIVITY_DETAIL_LIMIT = 480;

function getCodexExecutableNames(command, platform) {
  if (platform !== "win32") {
    return [command];
  }

  return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
}

function getCodexCommandCandidates({ command, env, platform }) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return [command];
  }

  const candidates = String(env.PATH || "").split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => getCodexExecutableNames(command, platform).map(
      (name) => path.join(directory, name),
    ));

  if (platform === "darwin" && command === "codex") {
    candidates.push(MACOS_CODEX_COMMAND);
  }

  return Array.from(new Set(candidates));
}

export async function resolveGraphCodexCommand({
  configuredCommand = "",
  env = process.env,
  platform = process.platform,
  accessFile = access,
} = {}) {
  const command = String(
    env[CODEX_COMMAND_ENV] || configuredCommand || "codex",
  ).trim();

  for (const candidate of getCodexCommandCandidates({ command, env, platform })) {
    try {
      await accessFile(candidate, fileSystemConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching user PATH and the platform-specific fallback.
    }
  }

  const error = new Error(
    `Could not find the Codex CLI. Install it, set ai.command in ~/.tb.json, or set ${CODEX_COMMAND_ENV}.`,
  );

  error.code = "ENOENT";
  throw error;
}

async function getAvailableGraphCodexMemoryDirectory({
  accessFile = access,
  memoryDirectory = getDefaultCodexMemoryDirectory(),
} = {}) {
  try {
    await accessFile(memoryDirectory, fileSystemConstants.R_OK);
    return memoryDirectory;
  } catch {
    return "";
  }
}

function appendOutput(session, value = "") {
  const text = String(value || "");

  if (!text) {
    return;
  }

  session.output = `${session.output || ""}${text.endsWith("\n") ? text : `${text}\n`}`;
}

function truncateCodexActivityDetail(value = "") {
  const text = String(value || "").trim();

  if (text.length <= CODEX_ACTIVITY_DETAIL_LIMIT) {
    return text;
  }

  return `${text.slice(0, CODEX_ACTIVITY_DETAIL_LIMIT - 3)}...`;
}

function appendCodexActivity(session, { kind, title, detail = "" }) {
  if (!title) {
    return;
  }

  session.activity ||= [];
  const entry = {
    id: `${Date.now()}-${session.activity.length}`,
    kind: String(kind || "status"),
    title: String(title),
    detail: truncateCodexActivityDetail(detail),
  };
  const previous = session.activity.at(-1);

  if (previous?.kind === entry.kind && previous.title === entry.title &&
      previous.detail === entry.detail) {
    return;
  }

  session.activity.push(entry);
  session.activity.splice(0, Math.max(0, session.activity.length - CODEX_ACTIVITY_LIMIT));
}

async function recordPatchUpdateMemory({ event, saveMemory, session }) {
  if (typeof saveMemory !== "function") {
    return;
  }

  try {
    await saveMemory({ event, session });
  } catch {
    // Memory persistence is supplementary and must not block patch work.
  }
}

function getPatchRevisionId(value = "") {
  const match = String(value).trim().match(/^D?(\d+)$/i);

  return match ? `D${match[1]}` : "";
}

function normalizeComment(comment, type) {
  const id = String(comment.id || comment.commentId || "");

  return {
    id: `${type}:${id}`,
    sourceId: id,
    type,
    feedbackType: type === "inline" ? "Inline review feedback" : "Review feedback",
    author: comment.author || "Unknown reviewer",
    content: comment.content || "",
    codeSuggestion: comment.codeSuggestion?.content || "",
    filePath: comment.filePath || "",
    lineNumber: comment.lineNumber || null,
    url: comment.url || "",
    state: "pending",
    assessment: "",
    rationale: "",
    recommendation: "",
    suggestedReply: "",
    changeSummary: "",
    proposedDiff: "",
    proposedDiffHtml: "",
    requiresChanges: false,
    draftReply: "",
    draftSaved: false,
    instruction: "",
    error: "",
  };
}

function getReviewItems(review) {
  return [
    ...(review.comments || []).map((comment) => normalizeComment(comment, "comment")),
    ...(review.inlineComments || []).map((comment) => normalizeComment(comment, "inline")),
  ].filter((item) => item.content || item.codeSuggestion).sort((first, second) => {
    const firstLine = first.lineNumber || 0;
    const secondLine = second.lineNumber || 0;

    return firstLine - secondLine || first.id.localeCompare(second.id);
  });
}

export function filterGraphPatchUpdateHandledComments(items, handledCommentIds) {
  const handled = handledCommentIds instanceof Set
    ? handledCommentIds
    : new Set(handledCommentIds || []);

  return items.filter((item) => !handled.has(item.id));
}

function getPatchUpdateResponseLocation(item) {
  if (!item.filePath) {
    return "";
  }

  return item.lineNumber ? ` (${item.filePath}:${item.lineNumber})` : ` (${item.filePath})`;
}

export function getGraphPatchUpdateDraftBlock(session) {
  const responses = (session?.items || []).filter((item) => item.draftReply);

  if (!responses.length) {
    return "";
  }

  const body = responses.map((item) => (
    `**Response to ${item.author}${getPatchUpdateResponseLocation(item)}**\n\n${item.draftReply}`
  )).join("\n\n");

  return `<!-- tb-tools-patch-update-responses:start -->\n### Responses to review comments\n\n${body}\n<!-- tb-tools-patch-update-responses:end -->`;
}

export function getGraphPatchUpdateSubmitMessage(session) {
  return getGraphPatchUpdateDraftBlock(session)
    .replace(/<!-- tb-tools-patch-update-responses:(?:start|end) -->\n?/g, "")
    .trim();
}

export function saveGraphPatchUpdateReply({ session, itemId, message }) {
  const item = getCurrentItem(session, itemId);

  item.draftReply = String(message || "").trim();
  item.draftSaved = true;
  markGraphPatchUpdateCommentHandled({ session, itemId });
  session.message = "Reply saved in your Phabricator draft. Moving to the next comment.";
  return item;
}

function parseWorktreeRecords(output = "") {
  return String(output).trim().split(/\n\n+/).map((block) => {
    const record = {};

    for (const line of block.split(/\r?\n/)) {
      const [key, ...value] = line.split(" ");

      if (key && value.length) {
        record[key] = value.join(" ");
      }
    }

    return record;
  }).filter((record) => record.worktree);
}

async function isAncestor({ graph, ancestor, descendant, runCommand }) {
  try {
    await runCommand({
      cmd: "git",
      args: ["merge-base", "--is-ancestor", ancestor, descendant],
      cwd: graph.path,
      capture: true,
      silent: true,
    });
    return true;
  } catch (error) {
    if (error?.code === 1) {
      return false;
    }

    throw error;
  }
}

async function assertNoAffectedWorktree({ graph, hash = "", runCommand }) {
  const output = await runCommand({
    cmd: "git",
    args: ["worktree", "list", "--porcelain"],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const currentPath = path.resolve(graph.path);

  for (const worktree of parseWorktreeRecords(output)) {
    if (path.resolve(worktree.worktree) === currentPath || !worktree.branch) {
      continue;
    }

    const branch = worktree.branch.replace(/^refs\/heads\//, "");
    const affectsMain = branch === DEFAULT_BRANCH;
    const containsPatch = hash && await isAncestor({
      graph,
      ancestor: hash,
      descendant: branch,
      runCommand,
    });

    if (affectsMain || containsPatch) {
      const error = new Error(
        `Refusing to update because ${branch} is checked out by ${worktree.worktree}.`,
      );

      error.statusCode = 409;
      throw error;
    }
  }
}

async function assertSafeWorktreeOwnership({ graphs, graph, hash, runCommand }) {
  for (const checkout of graphs) {
    await assertNoAffectedWorktree({
      graph: checkout,
      ...(checkout === graph ? { hash } : {}),
      runCommand,
    });
  }
}

export function isGraphAiEnabled(appConfig = {}) {
  return appConfig?.ai?.enabled === true;
}

export async function findGraphPatchCommit({ graph, revision, runCommand }) {
  const normalizedRevision = getPatchRevisionId(revision);

  if (!normalizedRevision) {
    const error = new Error("A valid Phabricator revision is required.");

    error.statusCode = 400;
    throw error;
  }

  const output = await runCommand({
    cmd: "git",
    args: [
      "log",
      "--all",
      "--topo-order",
      "--format=%H",
      "--fixed-strings",
      `--grep=${normalizedRevision}`,
    ],
    cwd: graph.path,
    capture: true,
    silent: true,
  });
  const hashes = output.split(/\r?\n/).map((hash) => hash.trim()).filter(Boolean);

  for (const hash of hashes) {
    const message = await getGraphCommitMessage({ graph, hash, runCommand });

    if (getPhabRevisionFromText(message) === normalizedRevision) {
      return { hash, message, revision: normalizedRevision };
    }
  }

  const error = new Error(
    `${normalizedRevision} was not found in any local comm branch. Pull the patch before updating it.`,
  );

  error.statusCode = 404;
  throw error;
}

export function createGraphPatchUpdateSession({
  graph,
  graphIndex,
  revision,
  aiEnabled,
  codexCommand,
}) {
  return {
    id: randomUUID(),
    graph,
    graphIndex,
    revision: getPatchRevisionId(revision),
    aiEnabled: Boolean(aiEnabled),
    codexCommand: String(codexCommand || "").trim(),
    status: "preparing",
    message: "Preparing the local patch stack...",
    output: "",
    activity: [],
    originalHash: "",
    currentHash: "",
    branch: "",
    commitMessage: "",
    codexSessionId: "",
    items: [],
    currentItemIndex: 0,
    handledItemCount: 0,
    snapshot: null,
    error: "",
  };
}

export function serializeGraphPatchUpdateSession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    revision: session.revision,
    aiEnabled: session.aiEnabled,
    status: session.status,
    message: session.message,
    output: session.output || "",
    activity: session.activity || [],
    originalHash: session.originalHash,
    currentHash: session.currentHash,
    branch: session.branch,
    codexSessionId: session.codexSessionId || "",
    items: session.items,
    currentItemIndex: session.currentItemIndex,
    handledItemCount: session.handledItemCount || 0,
    snapshot: session.snapshot,
    error: session.error || "",
  };
}

export async function prepareGraphPatchUpdateSession({
  session,
  graphs,
  getRustUpstreamStatus,
  getSnapshot,
  findPatchCommit = findGraphPatchCommit,
  assertSafeWorktree = assertSafeWorktreeOwnership,
  updateCheckout = runGraphRepositoryUpdate,
  rebasePatch = rebaseCommit,
  checkoutPatch = checkoutCommit,
  getReview = getGraphCommitReview,
  getHandledCommentIds = defaultGetHandledCommentIds,
  phab,
  runCommand,
  saveMemory,
  snapshotLimit,
}) {
  try {
    const found = await findPatchCommit({
      graph: session.graph,
      revision: session.revision,
      runCommand,
    });

    session.originalHash = found.hash;
    session.commitMessage = found.message;
    session.graph.knownHashes.add(found.hash);
    session.message = "Checking checkout safety and Rust dependencies...";
    await assertSafeWorktree({
      graphs,
      graph: session.graph,
      hash: found.hash,
      runCommand,
    });
    const rustStatus = await getRustUpstreamStatus();

    if (rustStatus?.state === "warning" || rustStatus?.upToDate === false) {
      appendOutput(session, "Rust dependencies are out of date; updating both checkouts before rebasing.");
    }

    session.message = "Updating origin/main in the comm and Firefox checkouts...";
    const update = await updateCheckout({
      graphs,
      mode: "update",
      runCommand,
    });

    appendOutput(session, update.output);
    session.message = "Rebasing the selected patch stack onto main...";
    await runCommand({
      cmd: "git",
      args: ["switch", DEFAULT_BRANCH],
      cwd: session.graph.path,
      capture: true,
      silent: true,
    });
    const rebase = await rebasePatch({
      graph: session.graph,
      graphIndex: session.graphIndex,
      hash: found.hash,
      rebaseMode: "descendants",
      runCommand,
    });

    session.currentHash = rebase.rewrittenCommits.find(
      (commit) => commit.originalHash === found.hash,
    )?.hash || rebase.currentHash;
    session.graph.knownHashes.add(session.currentHash);
    const checkout = await checkoutPatch({
      graph: session.graph,
      hash: session.currentHash,
      runCommand,
    });

    session.branch = checkout.branch || "";
    session.snapshot = await getSnapshot(session.graph, snapshotLimit);
    session.graph.knownHashes.add(session.currentHash);

    if (!session.aiEnabled) {
      session.status = "complete";
      session.message = `${session.revision} is rebased and checked out.`;
      await recordPatchUpdateMemory({
        event: "Patch rebased and checked out",
        saveMemory,
        session,
      });
      return session;
    }

    session.message = "Loading the latest Phabricator comments...";
    const review = await getReview({
      graph: session.graph,
      hash: session.currentHash,
      phab,
      runCommand,
    });

    if (review.error) {
      throw new Error(`Could not load Phabricator review comments: ${review.error}`);
    }

    const reviewItems = review.available ? getReviewItems(review) : [];
    const handledCommentIds = await getHandledCommentIds({ revision: session.revision });

    session.items = filterGraphPatchUpdateHandledComments(reviewItems, handledCommentIds);
    session.handledItemCount = reviewItems.length - session.items.length;

    if (!session.items.length) {
      session.status = "review";
      session.message = session.handledItemCount
        ? `No new review comments were found. ${session.handledItemCount} handled comment${session.handledItemCount === 1 ? " was" : "s were"} skipped.`
        : "No review comments were found. The patch is rebased and checked out.";
      await recordPatchUpdateMemory({
        event: "Patch rebased with no actionable review feedback",
        saveMemory,
        session,
      });
      return session;
    }

    session.status = "reviewing";
    session.message = "Codex is reviewing the full patch and every review comment...";
    const codexResult = await runCodex({
      session,
      prompt: getGraphPatchUpdateReviewPrompt(session),
      runCommand,
    });

    session.codexSessionId = codexResult.sessionId || "";
    applyCodexReview({ session, output: codexResult.message });
    session.status = "review";
    session.message = `Codex reviewed all ${session.items.length} new comment${session.items.length === 1 ? "" : "s"}.${session.handledItemCount ? ` ${session.handledItemCount} handled comment${session.handledItemCount === 1 ? " was" : "s were"} skipped.` : ""}`;
    appendCodexActivity(session, {
      kind: "review",
      title: "Prepared recommendations for every review comment",
    });
    await recordPatchUpdateMemory({
      event: "Codex review completed",
      saveMemory,
      session,
    });
    return session;
  } catch (error) {
    appendOutput(session, error?.stdout || "");
    appendOutput(session, error?.stderr || "");
    session.status = "error";
    session.error = String(error?.message || error);
    session.message = session.error;
    await recordPatchUpdateMemory({
      event: "Patch update failed",
      saveMemory,
      session,
    });
    throw error;
  }
}

function getCurrentItem(session, itemId) {
  const item = session.items.find((candidate) => candidate.id === String(itemId));

  if (!item) {
    const error = new Error("Unknown review comment.");

    error.statusCode = 404;
    throw error;
  }

  return item;
}

function parseCodexJson(output) {
  const text = String(output || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end <= start) {
    throw new Error("Codex did not return the requested patch review.");
  }

  const result = JSON.parse(text.slice(start, end + 1));

  return result;
}

function getCodexMessage(event) {
  const item = event?.item;

  if (item?.type !== "agent_message") {
    return "";
  }

  if (typeof item.text === "string") {
    return item.text;
  }

  return (item.content || []).map((part) => (
    part.text || part.content || ""
  )).filter(Boolean).join("\n");
}

function parseCodexRunOutput(output) {
  let sessionId = "";
  let message = "";

  for (const line of String(output || "").split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);

      if (event.type === "thread.started") {
        sessionId = event.thread_id || sessionId;
      }

      message = getCodexMessage(event) || message;
    } catch {
      // Codex normally emits JSONL, but retain a plain final response if it does not.
      message = line;
    }
  }

  return { message, sessionId };
}

function getCodexCommandDetail(item = {}) {
  const command = item.command || item.commandLine || item.input?.command;

  if (Array.isArray(command)) {
    return command.join(" ");
  }

  return String(command || "");
}

function isExpectedCodexCommandMiss(item = {}) {
  return Number(item.exit_code) === 1 && /\brg(?:\s|$)/.test(getCodexCommandDetail(item));
}

function getCodexFileChangeDetail(item = {}) {
  const changes = item.changes || item.files || [];
  const paths = (Array.isArray(changes) ? changes : [changes]).map((change) => {
    if (typeof change === "string") {
      return change;
    }

    return change?.path || change?.file || change?.filename || "";
  }).filter(Boolean);

  return paths.join(", ");
}

function isCodexStructuredResponse(message = "") {
  const text = String(message || "").trim();

  return text.startsWith("{") || text.startsWith("[");
}

export function getGraphCodexActivity(event) {
  if (event?.type === "thread.started") {
    return { kind: "session", title: "Started Codex session" };
  }

  if (event?.type === "turn.started") {
    return { kind: "review", title: "Started reviewing the patch and comments" };
  }

  if (event?.type === "turn.completed") {
    return { kind: "review", title: "Finished the review pass" };
  }

  const item = event?.item || {};
  const started = event?.type === "item.started";
  const completed = event?.type === "item.completed";

  if (!started && !completed) {
    return null;
  }

  if (item.type === "reasoning") {
    return {
      kind: "reasoning",
      title: started ? "Reviewing project context" : "Completed a review step",
    };
  }

  if (item.type === "command_execution") {
    const noMatches = completed && isExpectedCodexCommandMiss(item);
    const failed = completed && item.exit_code !== undefined &&
      Number(item.exit_code) !== 0 && !noMatches;

    return {
      kind: failed ? "error" : "command",
      title: started
        ? "Running command"
        : noMatches
          ? "Command completed with no matches"
          : failed
            ? "Command failed"
            : "Command completed",
      detail: getCodexCommandDetail(item),
    };
  }

  if (item.type === "file_change") {
    return {
      kind: "edit",
      title: started ? "Preparing source edits" : "Completed source edits",
      detail: getCodexFileChangeDetail(item),
    };
  }

  if (item.type === "web_search") {
    return {
      kind: "research",
      title: started ? "Researching relevant context" : "Completed research step",
      detail: item.query || "",
    };
  }

  if (item.type === "mcp_tool_call") {
    return {
      kind: "tool",
      title: started ? "Using project tool" : "Completed project tool step",
      detail: item.server || item.name || "",
    };
  }

  if (item.type === "agent_message") {
    const message = getCodexMessage(event);

    if (!message || isCodexStructuredResponse(message)) {
      return null;
    }

    return { kind: "note", title: "Codex note", detail: message };
  }

  return null;
}

function createCodexOutputHandler(session) {
  let pending = "";

  return (chunk) => {
    pending += String(chunk || "");
    const lines = pending.split(/\r?\n/);

    pending = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      try {
        const event = JSON.parse(line);

        if (event.type === "thread.started") {
          session.codexSessionId = event.thread_id || session.codexSessionId;
        }

        const activity = getGraphCodexActivity(event);

        if (activity) {
          appendCodexActivity(session, activity);
          session.message = activity.title;
        }
      } catch {
        appendOutput(session, line);
      }
    }
  };
}

export function getGraphPatchUpdateReviewPrompt(session) {
  const comments = session.items.map((item) => {
    const location = item.filePath
      ? `\nLocation: ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
      : "";
    const suggestion = item.codeSuggestion
      ? `\nReviewer code suggestion:\n${item.codeSuggestion}`
      : "";

    return `Comment ID: ${item.id}\nReviewer: ${item.author}${location}\nComment:\n${item.content || "(no prose comment)"}${suggestion}`;
  }).join("\n\n---\n\n");

  return `You are updating Phabricator ${session.revision} in the Thunderbird comm repository. The selected patch stack has already been rebased onto main and checked out for you.

This is a fresh Codex exec task, not the desktop conversation. Before evaluating the review:
1. Read ~/.codex/memories/memory_summary.md in full. Then read every shared-memory task group in ~/.codex/memories/MEMORY.md for the Thunderbird comm project at ${session.graph.path}, including the linked rollout summaries and ad-hoc notes. Also read the accumulated tb-tools patch-update notes in ~/.codex/memories/extensions/ad_hoc/notes. This is the shared project history and context, not optional patch-specific background.
2. Inspect the current commit, its stack, the local diff, and relevant recent Git history. Use the full repository history and shared Codex memory as the implementation context, especially for changes that a prior Codex task may have made anywhere in the project.
3. If the available history does not establish why a choice was made, say what is unknown. Do not invent missing project context. Do not edit memory files yourself; tb-tools stores the completed update record.

Current patch commit: ${session.currentHash}
Current patch message:
${session.commitMessage || "(not available)"}

Review the entire current patch, related stack, and every review comment below as one coherent change. Inspect source and tests as necessary. Do not change files, git state, branches, commits, worktrees, or Phabricator in this pass. Do not start work comment by comment. Consider interactions between comments and the patch as a whole before reaching conclusions.

${comments}

Return only one JSON object with a comments array. Include every supplied Comment ID exactly once. Each array item must have id, recommendation, assessment, rationale, suggestedReply, requiresChanges, changeSummary, and proposedDiff. recommendation must be one of "change", "reply", "no-action", or "discussion". assessment must directly state what the reviewer is asking and the recommended outcome. rationale must give the concise source, test, behavior, or accessibility evidence that supports that outcome; do not expose private reasoning or give generic feedback. suggestedReply must be a concise Phabricator response. requiresChanges must be true only when source changes are warranted. changeSummary must describe the exact local change Codex would make and be empty when no code change is needed. When source changes are warranted, proposedDiff must be a complete, exact unified Git diff against the current checkout: include diff --git, ---, +++, and @@ lines, use a/ and b/ paths, omit Markdown fences and ellipses, and include only the narrowly necessary edit. proposedDiff must be an empty string when no source change is needed or an exact diff cannot be established. Do not wrap JSON in Markdown fences.`;
}

function getRecommendation(finding) {
  const recommendation = String(finding.recommendation || "");

  if (["change", "reply", "no-action", "discussion"].includes(recommendation)) {
    return recommendation;
  }

  if (finding.requiresChanges === true) {
    return "change";
  }

  return finding.suggestedReply ? "reply" : "no-action";
}

function applyCodexFinding({ item, finding }) {
  const proposedDiff = String(finding.proposedDiff || "").trim();

  Object.assign(item, {
    assessment: String(finding.assessment || ""),
    rationale: String(finding.rationale || ""),
    recommendation: getRecommendation(finding),
    suggestedReply: String(finding.suggestedReply || ""),
    requiresChanges: finding.requiresChanges === true,
    changeSummary: String(finding.changeSummary || ""),
    proposedDiff,
    proposedDiffHtml: proposedDiff ? formatPrettyDiffHtml(proposedDiff) : "",
    state: "ready",
    error: "",
  });
}

function applyCodexReview({ session, output }) {
  const result = parseCodexJson(output);
  const findings = new Map((result.comments || []).map((finding) => [
    String(finding.id || ""),
    finding,
  ]));

  for (const item of session.items) {
    const finding = findings.get(item.id);

    if (!finding) {
      throw new Error(`Codex did not evaluate ${item.id}.`);
    }

    applyCodexFinding({ item, finding });
  }
}

export function getGraphCodexExecArgs({
  session,
  prompt,
  memoryDirectory = "",
}) {
  const memoryArgs = memoryDirectory
    ? ["--add-dir", memoryDirectory]
    : [];

  return session.codexSessionId
    ? ["exec", "resume", "--json", session.codexSessionId, prompt]
    : [
        "exec",
        "--json",
        "--approve-for-me",
        "--color",
        "never",
        "-C",
        session.graph.path,
        ...memoryArgs,
        prompt,
      ];
}

async function runCodex({ session, prompt, runCommand }) {
  const memoryDirectory = await getAvailableGraphCodexMemoryDirectory();
  const args = getGraphCodexExecArgs({ session, prompt, memoryDirectory });
  const onStdout = createCodexOutputHandler(session);
  const output = await runCommand({
    cmd: await resolveGraphCodexCommand({
      configuredCommand: session.codexCommand,
    }),
    args,
    cwd: session.graph.path,
    capture: true,
    silent: true,
    timeoutMs: CODEX_TIMEOUT_MS,
    onStdout,
    onStderr: (chunk) => appendOutput(session, chunk),
  });

  return parseCodexRunOutput(output);
}

function getApplyPrompt(session, item) {
  const location = item.filePath
    ? `\nThe comment is anchored at ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}.`
    : "";
  const suggestion = item.codeSuggestion
    ? `\nReviewer code suggestion:\n${item.codeSuggestion}`
    : "";

  return `Update the current Thunderbird comm checkout for one approved review comment on ${session.revision}.${location}

Reviewer comment:\n${item.content || "(no prose comment)"}${suggestion}

The user approved this exact source preview:
${item.proposedDiff}

Apply exactly this preview and do not substitute a different implementation. If the current checkout no longer matches the preview or the preview cannot be applied safely, stop and explain why without editing source. Do not create or modify branches or worktrees. Do not commit, amend, rebase, checkout, reset, stash, submit, post a Phabricator comment, or change unrelated files. Do not use git commands that modify state. Verify the edited code with the most focused practical check, if one is available. End with a concise summary of the files changed and the verification performed.`;
}

export function getGraphPatchUpdateFollowUpPrompt({ session, item, instruction }) {
  const location = item.filePath
    ? `\nThe comment is anchored at ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}.`
    : "";
  const suggestion = item.codeSuggestion
    ? `\nReviewer code suggestion:\n${item.codeSuggestion}`
    : "";

  return `Continue the existing Patch Update review for ${session.revision}. The user has given feedback about one reviewed comment. Keep the full patch, stack, all review feedback, and shared project context from this Codex session in mind.${location}

Reviewer comment:\n${item.content || "(no prose comment)"}${suggestion}

Your current recommendation:
${item.assessment || "(not available)"}

Current rationale:
${item.rationale || "(not available)"}

Current proposed reply:
${item.suggestedReply || "(not available)"}

Current proposed source diff:
${item.proposedDiff || "(not available)"}

User feedback or instruction:
${instruction}

Re-evaluate this comment using the current source and relevant tests as needed. Do not modify files, Git state, branches, commits, worktrees, or Phabricator during this step. If source edits are warranted, describe the precise proposed work in changeSummary and return the complete exact unified Git diff in proposedDiff so the user can inspect it before choosing Apply Change. proposedDiff must include diff --git, ---, +++, and @@ lines, use a/ and b/ paths, contain no Markdown fences or ellipses, and be empty only when no source change is recommended or an exact diff cannot be established. Return only one JSON object with a comment object containing id, recommendation, assessment, rationale, suggestedReply, requiresChanges, changeSummary, and proposedDiff. recommendation must be one of "change", "reply", "no-action", or "discussion". Do not wrap JSON in Markdown fences.`;
}

export async function followUpGraphPatchUpdateComment({
  session,
  itemId,
  instruction,
  runCommand,
  runCodexTask = runCodex,
  saveMemory,
}) {
  if (!session.aiEnabled) {
    const error = new Error("AI patch review is not enabled for this console.");

    error.statusCode = 403;
    throw error;
  }

  if (!session.codexSessionId) {
    const error = new Error("The Codex patch review session is unavailable. Start the update again.");

    error.statusCode = 409;
    throw error;
  }

  const item = getCurrentItem(session, itemId);
  const feedback = String(instruction || "").trim();

  if (!feedback) {
    const error = new Error("Enter feedback or an instruction for Codex.");

    error.statusCode = 400;
    throw error;
  }

  try {
    item.state = "reviewing";
    item.error = "";
    item.instruction = feedback;
    session.status = "reviewing";
    session.message = "Codex is considering your feedback...";
    appendCodexActivity(session, {
      kind: "instruction",
      title: "Sent feedback to Codex",
      detail: feedback,
    });
    const result = await runCodexTask({
      session,
      prompt: getGraphPatchUpdateFollowUpPrompt({
        session,
        item,
        instruction: feedback,
      }),
      runCommand,
    });
    const finding = parseCodexJson(result.message).comment;

    if (!finding || String(finding.id || "") !== item.id) {
      throw new Error("Codex did not return an updated assessment for this review comment.");
    }

    applyCodexFinding({ item, finding });
    session.codexSessionId = result.sessionId || session.codexSessionId;
    item.instruction = "";
    session.status = "review";
    session.message = "Codex updated its recommendation for this comment.";
    appendCodexActivity(session, {
      kind: "review",
      title: "Updated the recommendation from your feedback",
    });
    await recordPatchUpdateMemory({
      event: "Codex reviewed user feedback on a review comment",
      saveMemory,
      session,
    });
    return item;
  } catch (error) {
    item.state = "ready";
    item.error = String(error?.message || error);
    session.status = "review";
    session.message = item.error;
    appendCodexActivity(session, {
      kind: "error",
      title: "Codex could not process the feedback",
      detail: item.error,
    });
    await recordPatchUpdateMemory({
      event: "Codex could not process user feedback",
      saveMemory,
      session,
    });
    throw error;
  }
}

export async function applyGraphPatchUpdateComment({
  session,
  itemId,
  persistHandledComment = defaultPersistHandledComment,
  runCommand,
  saveMemory,
}) {
  if (!session.aiEnabled) {
    const error = new Error("AI patch review is not enabled for this console.");

    error.statusCode = 403;
    throw error;
  }

  if (!session.codexSessionId) {
    const error = new Error("The Codex patch review session is unavailable. Start the update again.");

    error.statusCode = 409;
    throw error;
  }

  const item = getCurrentItem(session, itemId);

  if (!item.proposedDiffHtml) {
    const error = new Error(
      "Codex did not provide an exact source diff to approve. Ask for a revised recommendation before applying changes.",
    );

    error.statusCode = 409;
    throw error;
  }

  try {
    item.state = "applying";
    item.error = "";
    session.status = "applying";
    session.message = "Codex is applying the selected review change...";
    const output = await runCodex({
      session,
      prompt: getApplyPrompt(session, item),
      runCommand,
    });

    item.appliedSummary = output.message;
    await persistHandledComment({ revision: session.revision, itemId: item.id });
    item.state = "handled";
    session.status = "review";
    session.message = "The selected review change has been applied locally.";
    appendCodexActivity(session, {
      kind: "edit",
      title: "Applied the selected review change",
      detail: output.message,
    });
    await recordPatchUpdateMemory({
      event: "Codex applied a review change",
      saveMemory,
      session,
    });
    return item;
  } catch (error) {
    item.state = "error";
    item.error = String(error?.message || error);
    session.status = "review";
    session.message = item.error;
    await recordPatchUpdateMemory({
      event: "Codex could not apply a review change",
      saveMemory,
      session,
    });
    throw error;
  }
}

export function markGraphPatchUpdateCommentHandled({ session, itemId }) {
  const item = getCurrentItem(session, itemId);

  item.state = "handled";
  session.currentItemIndex = Math.max(
    session.currentItemIndex,
    session.items.findIndex((candidate) => candidate.id === item.id) + 1,
  );
  session.message = "Comment marked as handled.";
  return item;
}
