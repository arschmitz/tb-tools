import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAttachments as defaultGetAttachments, getBugs as defaultGetBugs, updateBug as defaultUpdateBug } from "../../lib/bugzilla.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import { DEFAULT_LANDO_REPO, pushCommits as defaultPushCommits } from "../../lib/lando.mjs";
import defaultPhab, { comment as defaultComment } from "../../lib/phab.mjs";
import { run } from "../../lib/utils.mjs";
import {
  CHECKIN_NEEDED_KEYWORD,
  DEFAULT_SUBMIT_OUTPUT_LIMIT,
  GRAPH_UPDATE_MODE_UPDATE,
} from "./constants.mjs";
import {
  runGraphLint,
  runGraphMach,
  runGraphRepositoryUpdate,
  runInteractiveSubmitCommand,
} from "./actions.mjs";

const BUGZILLA_BUG_URL = "https://bugzilla.mozilla.org/show_bug.cgi?id=";
const REBASE_COMMENT = "Conflicts found while landing. Please Rebase.";
const TREEHERDER_JOBS_URL_PATTERN = /https?:\/\/treeherder\.mozilla\.org\/jobs[^\s<>"']*/gi;
const CHANGE_TRANSACTION_TYPES = new Set([
  "diff",
  "differential.diff",
  "differential.update",
  "revision.update",
  "update",
]);

function stripAnsi(value = "") {
  const escapeCharacter = String.fromCharCode(27);

  return String(value).replace(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function appendLandingOutput(session, output = "") {
  if (!output) {
    return;
  }

  session.output = `${session.output || ""}${stripAnsi(output)}`;

  if (session.output.length > DEFAULT_SUBMIT_OUTPUT_LIMIT) {
    session.output = session.output.slice(-DEFAULT_SUBMIT_OUTPUT_LIMIT);
  }
}

function formatCommandForOutput(command) {
  return [command.cmd, ...(command.args || [])].join(" ");
}

function createLandingCanceledError() {
  const error = new Error("Landing canceled.");

  error.canceled = true;
  return error;
}

function cleanTreeherderUrl(url = "") {
  return String(url).replace(/[),.;]+$/g, "");
}

export function getTreeherderUrlsFromText(value = "") {
  return Array.from(String(value || "").matchAll(TREEHERDER_JOBS_URL_PATTERN))
    .map((match) => cleanTreeherderUrl(match[0]))
    .filter(Boolean);
}

function normalizeTimestamp(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }

  return number < 100000000000 ? number * 1000 : number;
}

function getRecordTimestamp(record) {
  if (!record || typeof record !== "object") {
    return 0;
  }

  return normalizeTimestamp(
    record.dateCreated ||
    record.dateModified ||
    record.epoch ||
    record.timestamp ||
    record.date
  );
}

function getCommentText(comment) {
  if (!comment) {
    return "";
  }

  if (typeof comment === "string") {
    return comment;
  }

  return String(
    comment.text ||
    comment.body ||
    comment.message ||
    comment.content?.raw ||
    comment.content?.html ||
    comment.content ||
    comment.comment ||
    ""
  );
}

function collectCommentRecords(record, fallbackTimestamp = 0) {
  if (!record || typeof record === "string") {
    return [{
      text: getCommentText(record),
      timestamp: fallbackTimestamp,
    }];
  }

  const timestamp = getRecordTimestamp(record) || fallbackTimestamp;
  const comments = Array.isArray(record.comments)
    ? record.comments
    : [record.comment, record.content, record.text, record.body, record.message].filter(Boolean);

  return comments.map((comment) => ({
    text: getCommentText(comment),
    timestamp: getRecordTimestamp(comment) || timestamp,
  }));
}

function normalizePhabricatorTransactions(response) {
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

function getPatchCommentRecords(patch = {}, transactions = []) {
  return [
    ...(Array.isArray(patch.comments) ? patch.comments : []),
    ...(Array.isArray(patch.transactions) ? patch.transactions : []),
    ...transactions,
  ].flatMap((record) => collectCommentRecords(record));
}

function isPatchChangeTransaction(transaction = {}) {
  const type = String(transaction.type || transaction.transactionType || "").toLowerCase();
  const fields = transaction.fields || {};
  const text = [
    transaction.description,
    transaction.summary,
    transaction.title,
    transaction.oldValue,
    transaction.newValue,
  ].filter(Boolean).join("\n");

  return CHANGE_TRANSACTION_TYPES.has(type) ||
    type.includes("diff") ||
    Boolean(transaction.diff || transaction.diffID || transaction.diffId || transaction.newDiff || fields.diff) ||
    /updated .*diff|uploaded .*diff|changed .*diff|added .*diff/i.test(text);
}

function getPatchChangeTimestamps(patch = {}, transactions = []) {
  const diffRecords = [
    ...(Array.isArray(patch.diffs) ? patch.diffs : []),
    patch.diff,
    patch.activeDiff,
    patch.latestDiff,
  ].filter(Boolean);
  const diffTimestamps = diffRecords
    .map(getRecordTimestamp)
    .filter(Boolean);
  const transactionTimestamps = [
    ...(Array.isArray(patch.transactions) ? patch.transactions : []),
    ...transactions,
  ]
    .filter(isPatchChangeTransaction)
    .map(getRecordTimestamp)
    .filter(Boolean);

  return [...diffTimestamps, ...transactionTimestamps];
}

export function getLatestLandingPatchTryRun({ patch = {}, transactions = [] } = {}) {
  return getPatchCommentRecords(patch, transactions).reduce((latest, record, index) => {
    const urls = getTreeherderUrlsFromText(record.text);

    if (!urls.length) {
      return latest;
    }

    const timestamp = record.timestamp || 0;
    const candidate = {
      url: urls.at(-1),
      createdAt: timestamp ? new Date(timestamp).toISOString() : "",
      timestamp,
      index,
    };

    if (!latest || candidate.timestamp > latest.timestamp || (
      candidate.timestamp === latest.timestamp &&
      candidate.index > latest.index
    )) {
      return candidate;
    }

    return latest;
  }, null);
}

export function getLandingPatchTryStatus({ patch = {}, transactions = [] } = {}) {
  const latestTryRun = getLatestLandingPatchTryRun({ patch, transactions });
  const changeTimestamps = getPatchChangeTimestamps(patch, transactions);
  const latestChangeTimestamp = changeTimestamps.length ? Math.max(...changeTimestamps) : 0;

  if (!latestTryRun) {
    return {
      state: "missing",
      latestTryRun: null,
      warning: "No Treeherder try run was found in Phabricator comments.",
    };
  }

  if (latestTryRun.timestamp && latestChangeTimestamp > latestTryRun.timestamp) {
    return {
      state: "stale",
      latestTryRun,
      warning: "Patch changes were posted after the latest Treeherder try run.",
    };
  }

  return {
    state: "current",
    latestTryRun,
    warning: "",
  };
}

async function getLandingPatchTransactions(patch, phab = defaultPhab) {
  if (!patch?.phid && !patch?.id) {
    return [];
  }

  const response = await phab({
    route: "transaction.search",
    params: {
      objectIdentifier: patch.phid || `D${patch.id}`,
      limit: 100,
    },
  });

  return normalizePhabricatorTransactions(response);
}

async function loadLandingPatchTryStatus({
  patch,
  phab = defaultPhab,
}) {
  try {
    const transactions = await getLandingPatchTransactions(patch, phab);

    return getLandingPatchTryStatus({ patch, transactions });
  } catch (error) {
    return {
      state: "unknown",
      latestTryRun: null,
      warning: `Could not check Phabricator comments for Treeherder try runs: ${error?.message || error}`,
    };
  }
}

function throwIfLandingCanceled(session) {
  if (session.cancelRequested) {
    throw createLandingCanceledError();
  }
}

async function runLandingCommand({
  command,
  session,
  runCommand = run,
}) {
  throwIfLandingCanceled(session);
  const normalizedCommand = {
    ...command,
    capture: command.capture !== false,
  };

  if (runCommand === run) {
    const output = await runInteractiveSubmitCommand({
      command: normalizedCommand,
      session,
    });

    throwIfLandingCanceled(session);
    return output;
  }

  appendLandingOutput(session, `$ ${formatCommandForOutput(normalizedCommand)}\n`);

  try {
    const output = await runCommand(normalizedCommand);

    appendLandingOutput(session, output);
    throwIfLandingCanceled(session);
    return output;
  } catch (error) {
    appendLandingOutput(session, error.stdout || "");
    appendLandingOutput(session, error.stderr || "");
    throw error;
  }
}

async function runLandingGit({
  graph,
  args,
  session,
  runCommand = run,
  capture = true,
}) {
  return runLandingCommand({
    command: {
      cmd: "git",
      args,
      cwd: graph.path,
      capture,
      silent: true,
    },
    session,
    runCommand,
  });
}

function setLandingRunning(session, message) {
  throwIfLandingCanceled(session);
  session.status = "running";
  session.message = message;
  session.prompt = null;
}

function askLandingPrompt(session, prompt) {
  return new Promise((resolve, reject) => {
    if (session.cancelRequested) {
      reject(createLandingCanceledError());
      return;
    }

    if (session.prompt) {
      reject(new Error("Landing is already waiting on a browser prompt."));
      return;
    }

    session.status = "prompt";
    session.message = "Waiting for input.";
    session.prompt = {
      id: randomUUID(),
      ...prompt,
    };
    session.pendingPrompt = { resolve, reject };
  });
}

function getChoiceLabel(prompt, answer) {
  const choice = [
    ...(prompt.choices || []),
    ...(prompt.actions || []),
  ].find((item) => item.id === answer || item.mergeAnswer === answer);

  return choice?.label || answer;
}

function getPromptValidChoiceAnswers(prompt) {
  const validChoices = new Set();

  for (const choice of [...(prompt.choices || []), ...(prompt.actions || [])]) {
    if (!choice || choice.separator) {
      continue;
    }

    if (choice.id) {
      validChoices.add(choice.id);
    }

    if (choice.mergeAnswer) {
      validChoices.add(choice.mergeAnswer);
    }
  }

  return validChoices;
}

export function answerGraphLandSessionPrompt(session, promptId, answer) {
  if (!session.prompt || !session.pendingPrompt) {
    const error = new Error("Landing is not waiting for input.");
    error.statusCode = 409;
    throw error;
  }

  if (session.prompt.id !== promptId) {
    const error = new Error("Landing prompt is no longer active.");
    error.statusCode = 409;
    throw error;
  }

  const prompt = session.prompt;
  const pendingPrompt = session.pendingPrompt;
  let value = answer;

  if (prompt.type === "confirm") {
    value = Boolean(answer);
    appendLandingOutput(session, `\n> ${value ? "yes" : "no"}\n`);
  } else if (prompt.type === "choice") {
    value = String(answer || "");
    const validChoices = getPromptValidChoiceAnswers(prompt);

    if (!validChoices.has(value)) {
      const error = new Error("Unknown landing choice.");
      error.statusCode = 400;
      throw error;
    }

    appendLandingOutput(session, `\n> ${getChoiceLabel(prompt, value)}\n`);
  } else if (prompt.type === "input") {
    value = String(answer || "").trim() || String(prompt.defaultValue || "");
    appendLandingOutput(session, `\n> ${value}\n`);
  }

  session.prompt = null;
  session.pendingPrompt = null;
  setLandingRunning(session, "Landing running...");
  pendingPrompt.resolve(value);
}

function askLandingConfirm(session, message) {
  return askLandingPrompt(session, {
    type: "confirm",
    message,
  });
}

function askLandingChoice(session, message, choices, extra = {}) {
  return askLandingPrompt(session, {
    type: "choice",
    message,
    choices,
    ...extra,
  });
}

function askLandingInput(session, message, defaultValue = "") {
  return askLandingPrompt(session, {
    type: "input",
    message,
    defaultValue,
  });
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
  return normalizeAttachments(attachments).reduce((ids, attachment) => {
    if (attachment?.content_type !== "text/x-phabricator-request") {
      return ids;
    }

    const match = String(attachment.file_name || "").match(/D([0-9]+)/);

    if (match) {
      ids.push(match[1]);
    }

    return ids;
  }, []);
}

function getVisibleBugPatches(bug) {
  return (bug.patches || []).filter((patch) => patch.statusName !== "Closed");
}

function normalizeLandingBug(bug) {
  return {
    ...bug,
    patches: getVisibleBugPatches(bug),
    hasLandedPatch: Boolean(bug.hasLandedPatch),
  };
}

async function getLandingBugs({
  session,
  getBugs = defaultGetBugs,
  getAttachments = defaultGetAttachments,
  phab = defaultPhab,
}) {
  setLandingRunning(session, "Fetching bugs marked for checkin...");
  appendLandingOutput(session, "Fetching bugs marked for checkin...\n");

  const bugs = await getBugs();

  for (const bug of bugs) {
    const attachments = await getAttachments(bug.id);
    const phabIds = getPhabricatorIdsFromAttachments(attachments);
    const patches = phabIds.length
      ? (await phab({
        route: "differential.query",
        params: { ids: phabIds },
      })).result || []
      : [];

    bug.patches = [];

    for (const patch of patches) {
      const reviewerPhids = Object.keys(patch.reviewers || {});
      const reviewers = reviewerPhids.length
        ? (await phab({
          route: "user.query",
          params: { phids: reviewerPhids },
        })).result.map((reviewer) => reviewer.userName)
        : [];

      bug.patches.push({
        ...patch,
        bugId: bug.id,
        reviewers,
        landingTryStatus: await loadLandingPatchTryStatus({ patch, phab }),
      });
    }
  }

  return bugs.map(normalizeLandingBug).filter((bug) => bug.patches.length);
}

async function createLandingCheckpoint({
  graph,
  session,
  runCommand = run,
}) {
  const [branch, commit] = await Promise.all([
    runLandingGit({
      graph,
      args: ["branch", "--show-current"],
      session,
      runCommand,
    }),
    runLandingGit({
      graph,
      args: ["rev-parse", "HEAD"],
      session,
      runCommand,
    }),
  ]);
  const checkpoint = {
    branch: branch.trim(),
    commit: commit.trim(),
    ref: "refs/tb-tools/landing-start",
  };

  await runLandingGit({
    graph,
    args: ["update-ref", checkpoint.ref, checkpoint.commit],
    session,
    runCommand,
  });

  return checkpoint;
}

async function restoreLandingCheckpoint({
  graph,
  checkpoint,
  session,
  clean = false,
  runCommand = run,
}) {
  if (checkpoint.branch) {
    try {
      await runLandingGit({
        graph,
        args: ["switch", checkpoint.branch],
        session,
        runCommand,
      });
    } catch {
      await runLandingGit({
        graph,
        args: ["switch", "--detach", checkpoint.commit],
        session,
        runCommand,
      });
    }
  } else {
    await runLandingGit({
      graph,
      args: ["switch", "--detach", checkpoint.commit],
      session,
      runCommand,
    });
  }

  await runLandingGit({
    graph,
    args: ["reset", "--hard", checkpoint.commit],
    session,
    runCommand,
  });

  if (clean) {
    await runLandingGit({
      graph,
      args: ["clean", "-fd"],
      session,
      runCommand,
    });
  }
}

function findLandingPatch(session, answer) {
  const [, bugId, patchId] = String(answer || "").split(":");
  const bug = session.bugs.find((item) => String(item.id) === bugId);
  const patch = bug?.patches.find((item) => String(item.id) === patchId);

  return { bug, patch };
}

function removeLandingPatch(session, bug, patch, result) {
  if (result === "landed") {
    bug.hasLandedPatch = true;
  }

  bug.patches = bug.patches.filter((item) => String(item.id) !== String(patch.id));

  if (bug.patches.length) {
    return;
  }

  if (bug.hasLandedPatch) {
    session.landedBugs.push(bug);
  }

  session.bugs = session.bugs.filter((item) => String(item.id) !== String(bug.id));
}

function getPatchLinks(bug, patch) {
  return [
    {
      label: `Bug ${bug.id}`,
      url: `${BUGZILLA_BUG_URL}${bug.id}`,
    },
    {
      label: `D${patch.id}`,
      url: patch.uri,
    },
  ].filter((link) => link.url);
}

function getPatchReviewersLabel(patch) {
  return (patch.reviewers || []).join(", ") || "none";
}

function getPatchStatusKind(patch) {
  if (patch.statusName === "Accepted") {
    return "accepted";
  }

  return "warning";
}

function getPatchSelectChoices(session) {
  const choices = [];

  for (const bug of [...session.bugs].reverse()) {
    choices.push({
      separator: true,
      label: `Bug ${bug.id} - ${bug.summary || ""}`,
    });

    for (const patch of getVisibleBugPatches(bug)) {
      choices.push({
        id: `patch:${bug.id}:${patch.id}`,
        mergeAnswer: `merge:${bug.id}:${patch.id}`,
        label: `D${patch.id} [${patch.statusName || "Unknown"}] - ${patch.title || ""}`,
        kind: "patch-card",
        statusKind: getPatchStatusKind(patch),
        bugId: bug.id,
        bugSummary: bug.summary || "",
        patchId: patch.id,
        title: patch.title || "",
        statusName: patch.statusName || "",
        reviewers: patch.reviewers || [],
        links: getPatchLinks(bug, patch),
        tryStatus: patch.landingTryStatus || null,
      });
    }
  }

  return choices;
}

function getPatchActionPrompt(bug, patch) {
  return {
    type: "patch-action",
    links: getPatchLinks(bug, patch),
    detail: `${patch.title || ""}\nStatus: ${patch.statusName || "Unknown"}\nReviewers: ${getPatchReviewersLabel(patch)}`,
  };
}

async function selectLandingPatches(session) {
  while (session.bugs.length) {
    const answer = await askLandingChoice(
      session,
      "Select a patch to land or an action.",
      getPatchSelectChoices(session),
      {
        kind: "patch-select",
        actions: [
          { id: "continue", label: "Continue", kind: "accepted" },
          { id: "abort", label: "Abort", kind: "danger" },
        ],
      }
    );

    if (answer === "continue") {
      return;
    }

    if (answer === "abort") {
      throw new Error("Landing aborted.");
    }

    const patchAnswer = String(answer || "");
    const { bug, patch } = findLandingPatch(session, patchAnswer);

    if (!bug || !patch) {
      throw new Error("Selected patch is no longer available.");
    }

    const result = patchAnswer.startsWith("merge:")
      ? await mergeLandingPatch(session, patch)
      : await runLandingPatchAction(session, bug, patch);

    if (result === "landed" || result === "skipped") {
      removeLandingPatch(session, bug, patch, result);
    }
  }
}

async function runLandingPatchAction(session, bug, patch) {
  while (true) {
    const action = await askLandingChoice(
      session,
      `D${patch.id} - choose an action.`,
      [
        { id: "merge", label: "Merge Patch", kind: "accepted" },
        { id: "skip", label: "Skip Patch" },
        { id: "back", label: "Go Back" },
      ],
      getPatchActionPrompt(bug, patch)
    );

    if (action === "merge") {
      return mergeLandingPatch(session, patch);
    }

    if (action === "skip") {
      return "skipped";
    }

    if (action === "back") {
      return "";
    }
  }
}

function isPatchConflictError(error) {
  const message = `${error?.message || error}\n${error?.stdout || ""}\n${error?.stderr || ""}`;

  return /patch failed|conflict|CONFLICT|error:/i.test(message);
}

async function amendLandingCommitReviewers(session, patch) {
  const message = await runLandingGit({
    graph: session.graph,
    args: ["log", "-1", "--format=%B"],
    session,
    runCommand: session.runCommand,
  });
  const lines = message.split(/\n/);
  const messageParts = lines[0].split(".");

  messageParts.pop();
  messageParts.push(` r=${(patch.reviewers || []).join(",")}`);
  lines.shift();
  lines.unshift(messageParts.join("."));

  await runLandingGit({
    graph: session.graph,
    args: ["commit", "--amend", "--date=now", "-m", lines.join("\n")],
    session,
    runCommand: session.runCommand,
  });
}

async function mergeLandingPatch(session, patch) {
  setLandingRunning(session, `Merging D${patch.id}...`);
  appendLandingOutput(session, `Merging D${patch.id}...\n`);

  try {
    await runLandingCommand({
      command: {
        cmd: "moz-phab",
        args: ["patch", `D${patch.id}`, "--skip-dependencies", "--apply-to", "here"],
        cwd: session.graph.path,
        capture: true,
        silent: true,
      },
      session,
      runCommand: session.runCommand,
    });
  } catch (error) {
    if (/uncommitted/.test(String(error?.message || error))) {
      throw error;
    }

    if (!isPatchConflictError(error)) {
      throw error;
    }

    if (await askLandingConfirm(session, "Patch conflict found. Add a comment to Phabricator?")) {
      setLandingRunning(session, `Commenting on D${patch.id}...`);
      await session.postComment({
        message: REBASE_COMMENT,
        id: patch.id,
      });
      appendLandingOutput(session, `Commented on D${patch.id}.\n`);
    }

    if (await askLandingConfirm(session, "Patch conflict found. Add a comment to Bugzilla and remove checkin-needed-tb?")) {
      setLandingRunning(session, `Commenting on bug ${patch.bugId}...`);
      await session.updateBug(patch.bugId, {
        comment: {
          body: REBASE_COMMENT,
        },
        keywords: {
          remove: [CHECKIN_NEEDED_KEYWORD],
        },
      });
      appendLandingOutput(session, `Updated bug ${patch.bugId}.\n`);
    }

    await restoreLandingCheckpoint({
      graph: session.graph,
      checkpoint: session.checkpoint,
      session,
      clean: true,
      runCommand: session.runCommand,
    });
    return "skipped";
  }

  await amendLandingCommitReviewers(session, patch);
  appendLandingOutput(session, `Merged D${patch.id}.\n`);
  return "landed";
}

async function updateDummyFile(session) {
  const dummyPath = path.join(session.graph.path, "build", "dummy");
  const contents = await readFile(dummyPath, { encoding: "utf8" });
  const lines = contents.split(/\n/);
  let dotLine = lines[lines.length - 2] || "";
  const dots = dotLine.match(/\./g) || [];

  if (dots.length <= 1) {
    dotLine = "..";
  } else {
    dots.pop();
    dotLine = dots.join("");
  }

  lines[lines.length - 2] = dotLine;
  await writeFile(dummyPath, lines.join("\n"));
  appendLandingOutput(session, "Updated build/dummy.\n");
  await runLandingGit({
    graph: session.graph,
    args: ["add", "--", "build/dummy"],
    session,
    runCommand: session.runCommand,
  });
  await runLandingGit({
    graph: session.graph,
    args: ["commit", "-m", "No bug, trigger build."],
    session,
    runCommand: session.runCommand,
  });
}

async function runLandingSanityChecks(session) {
  if (session.bumpOnly) {
    return;
  }

  if (await askLandingConfirm(session, "Do you want to run lint?")) {
    try {
      setLandingRunning(session, "Running lint...");
      await runGraphLint({
        graph: session.graph,
        session,
        runCommand: session.runCommand,
      });
    } catch (error) {
      if (await askLandingConfirm(session, "Lint failed. Roll back landing changes?")) {
        await restoreLandingCheckpoint({
          graph: session.graph,
          checkpoint: session.checkpoint,
          session,
          clean: true,
          runCommand: session.runCommand,
        });
      }

      throw error;
    }
  }

  if (await askLandingConfirm(session, "Do you want to run build?")) {
    try {
      setLandingRunning(session, "Running build...");
      await runGraphMach({
        graph: session.graph,
        args: ["build"],
        session,
        runCommand: session.runCommand,
      });
    } catch (error) {
      if (await askLandingConfirm(session, "Build failed. Roll back landing changes?")) {
        await restoreLandingCheckpoint({
          graph: session.graph,
          checkpoint: session.checkpoint,
          session,
          clean: true,
          runCommand: session.runCommand,
        });
      }

      throw error;
    }
  }
}

async function getPendingLandingCommits(session) {
  const output = await runLandingGit({
    graph: session.graph,
    args: ["log", "--oneline", "--decorate", `origin/${DEFAULT_BRANCH}..HEAD`],
    session,
    runCommand: session.runCommand,
  });

  return output.trim();
}

function getUrlsFromText(value = "") {
  return Array.from(new Set(String(value).match(/https?:\/\/[^\s<>"']+/g) || []));
}

function addLandingLinksFromOutput(session, output = "") {
  for (const url of getUrlsFromText(output)) {
    if (session.links.some((link) => link.url === url)) {
      continue;
    }

    session.links.push({
      label: /lando/i.test(url) ? "Lando" : "Link",
      url,
    });
  }
}

async function pushLandingCommits(session) {
  setLandingRunning(session, "Submitting commits with Lando...");
  appendLandingOutput(session, "Submitting commits with Lando...\n");

  const output = await session.pushCommits({
    landoRepo: session.options.landoRepo || DEFAULT_LANDO_REPO,
    relbranch: session.options.relbranch || undefined,
    localRepo: session.graph.path,
    yes: true,
  });

  appendLandingOutput(session, output);
  addLandingLinksFromOutput(session, output);
}

async function approveLandingStack(session) {
  session.pendingCommits = await getPendingLandingCommits(session);

  const approval = await askLandingChoice(
    session,
    "Review the pending commits before submitting them through Lando.",
    [
      { id: "approve", label: "Approve and Land", kind: "accepted" },
      { id: "abort", label: "Abort", kind: "danger" },
      { id: "rollback", label: "Roll Back", kind: "danger" },
    ],
    {
      kind: "approval",
      detail: session.pendingCommits || "No pending commits.",
    }
  );

  if (approval === "approve") {
    await pushLandingCommits(session);
    return true;
  }

  if (approval === "rollback") {
    await restoreLandingCheckpoint({
      graph: session.graph,
      checkpoint: session.checkpoint,
      session,
      clean: true,
      runCommand: session.runCommand,
    });
    session.message = "Landing rolled back.";
    return false;
  }

  throw new Error("Landing aborted.");
}

async function updateLandingMilestones(session) {
  const bugsNeedingMilestone = session.landedBugs.filter((bug) => bug.target_milestone === "---");

  if (!bugsNeedingMilestone.length) {
    return;
  }

  const version = await readFile(path.join(session.graph.path, "mail", "config", "version.txt"), { encoding: "utf8" });
  const simpleVersion = version.split(".")[0];
  const defaultMilestone = `${simpleVersion} Branch`;

  for (const bug of bugsNeedingMilestone) {
    const milestone = await askLandingInput(
      session,
      `Enter target milestone for bug ${bug.id}.`,
      defaultMilestone
    );

    await session.updateBug(bug.id, {
      target_milestone: milestone,
    });
    appendLandingOutput(session, `Set bug ${bug.id} target milestone to ${milestone}.\n`);
  }
}

async function runGraphLandingFlow(session) {
  setLandingRunning(session, "Checking working trees...");
  appendLandingOutput(session, "Starting landing flow.\n");

  const updateResult = await runGraphRepositoryUpdate({
    graphs: session.graphs,
    mode: GRAPH_UPDATE_MODE_UPDATE,
    runCommand: session.runCommand,
  });

  appendLandingOutput(session, `${updateResult.message}\n`);
  session.checkpoint = await createLandingCheckpoint({
    graph: session.graph,
    session,
    runCommand: session.runCommand,
  });
  session.bugs = await getLandingBugs({
    session,
    getBugs: session.getBugs,
    getAttachments: session.getAttachments,
    phab: session.phab,
  });

  if (!session.bugs.length) {
    if (!await askLandingConfirm(session, "No bugs are marked for checkin. Bump build/dummy instead?")) {
      session.message = "No bugs marked for checkin.";
      return;
    }

    session.bumpOnly = true;
    await updateDummyFile(session);
  } else {
    await selectLandingPatches(session);
  }

  await runLandingSanityChecks(session);

  if (!await approveLandingStack(session)) {
    return;
  }

  await updateLandingMilestones(session);
  session.snapshots = await session.getSnapshots(session.snapshotLimits);
  session.message = "Landing complete.";
}

function cancelGraphLandSession(session) {
  if (["complete", "error", "canceled"].includes(session.status)) {
    return;
  }

  session.cancelRequested = true;
  session.status = "canceled";
  session.message = "Landing canceled.";
  session.error = "";
  session.prompt = null;
  appendLandingOutput(session, "\nLanding canceled.\n");

  if (typeof session.cancelCurrentCommand === "function") {
    session.cancelCurrentCommand();
    session.cancelCurrentCommand = null;
  }

  if (session.pendingPrompt) {
    const pendingPrompt = session.pendingPrompt;

    session.pendingPrompt = null;
    pendingPrompt.reject(createLandingCanceledError());
  }
}

export function createGraphLandSession({
  graphs,
  graph,
  graphIndex,
  snapshotLimits = [],
  getSnapshots,
  options = {},
  runCommand = run,
  getBugs = defaultGetBugs,
  getAttachments = defaultGetAttachments,
  updateBug = defaultUpdateBug,
  phab = defaultPhab,
  postComment = defaultComment,
  pushCommits = defaultPushCommits,
}) {
  const session = {
    id: randomUUID(),
    graphIndex,
    label: graph.label,
    path: graph.path,
    graph,
    graphs,
    snapshotLimits,
    getSnapshots,
    runCommand,
    getBugs,
    getAttachments,
    updateBug,
    phab,
    postComment,
    pushCommits,
    options: {
      landoRepo: options.landoRepo || options["lando-repo"] || DEFAULT_LANDO_REPO,
      relbranch: options.relbranch || "",
    },
    status: "running",
    message: "Starting landing...",
    output: "",
    error: "",
    prompt: null,
    pendingPrompt: null,
    bugs: [],
    landedBugs: [],
    links: [],
    pendingCommits: "",
    snapshots: null,
    checkpoint: null,
    bumpOnly: false,
    cancelRequested: false,
  };

  session.answer = (promptId, answer) => {
    answerGraphLandSessionPrompt(session, promptId, answer);
  };
  session.cancel = () => {
    cancelGraphLandSession(session);
  };

  queueMicrotask(async () => {
    try {
      await runGraphLandingFlow(session);
      throwIfLandingCanceled(session);
      session.status = "complete";
      session.prompt = null;
      session.pendingPrompt = null;
      session.message = session.message || "Landing complete.";
    } catch (error) {
      if (session.cancelRequested || error?.canceled) {
        cancelGraphLandSession(session);
        return;
      }

      session.status = "error";
      session.error = String(error?.message || error);
      session.message = session.error;
      if (session.pendingPrompt) {
        session.pendingPrompt.reject(error);
        session.pendingPrompt = null;
        session.prompt = null;
      }
    }
  });

  return session;
}

export function serializeGraphLandSession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    label: session.label,
    path: session.path,
    status: session.status,
    message: session.message,
    output: session.output || "",
    error: session.error,
    prompt: session.prompt,
    bugs: session.bugs.map(normalizeLandingBug),
    landedBugs: session.landedBugs.map((bug) => ({
      id: bug.id,
      summary: bug.summary,
      target_milestone: bug.target_milestone,
    })),
    links: session.links,
    pendingCommits: session.pendingCommits,
    snapshots: session.snapshots,
    options: session.options,
  };
}
