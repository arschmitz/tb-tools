import { pruneTryStorage, isActiveTryTask } from "./try-storage.mjs";
import { pruneStorage, STORAGE_LIMITS } from "./storage-retention.mjs";
import { getSharedBuildCacheDirectory } from "./build.mjs";
import { createRebaseSessionStore, hasActiveRebaseSession } from "./rebase-session-store.mjs";
import { ensureGraphCommit } from "./commit-access.mjs";
import { AI_SETTINGS_PATH, AI_TASK_TYPES, readAiProfiles, saveAiProfiles } from "./ai-models.mjs";
import { createGraphCodexAppServer } from "./codex-app-server.mjs";
import { registerConsoleBrowserAccess } from "./ai-browser-access.mjs";
import { createReviewHandledStore, applyHandledReviews } from "./review-handled.mjs";
import { summarizeBackgroundJob } from "./background-jobs.mjs";
import { createTaskDismissalStore } from "./task-dismissals.mjs";
import { createTryMonitorStore } from "./try-monitor-store.mjs";
import { createImplementationManager } from "./implement.mjs";
import { prepareDashboardPatchAction } from "./dashboard-actions.mjs";
import { squashTryFixup } from "./try-fixup.mjs";
import { createTryMonitor } from "./try-monitor.mjs";
import { proposeRebaseResolution, applyRebaseResolution } from "./rebase-resolution.mjs";
import { continueReviewImport } from "./review-import.mjs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import serviceCredentials from "../../desktop/setup-credentials.cjs";
import defaultConfig from "../../lib/config.mjs";
import { pushCommits as defaultPushCommits } from "../../lib/lando.mjs";
import { run } from "../../lib/utils.mjs";
import {
  createBug as defaultCreateBug,
  getAssignedOpenBugs as defaultGetAssignedOpenBugs,
  getAttachments as defaultGetAttachments,
  getBug as defaultGetBug,
  getBugComments as defaultGetBugComments,
  getBugHistoryByIds as defaultGetBugHistoryByIds,
  getBugsByIds as defaultGetBugsByIds,
  getBugsWithAttachmentsByIds as defaultGetBugsWithAttachmentsByIds,
  getNeedinfoOpenBugs as defaultGetNeedinfoOpenBugs,
  getBugs as defaultGetBugs,
  updateBug as defaultUpdateBug,
} from "../../lib/bugzilla.mjs";
import {
  getNotionStoriesByBugId as defaultGetNotionStoriesByBugId,
  isNotionAuthenticationError,
} from "../../lib/notion.mjs";
import defaultPhab, {
  clearPhabricatorCache as defaultClearPhabricatorCache,
  comment as defaultComment,
  getPhabricatorCacheStatus as defaultGetPhabricatorCacheStatus,
  isPhabricatorRateLimitError,
} from "../../lib/phab.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import {
  DEFAULT_BROWSER_SHUTDOWN_GRACE_MS,
  DEFAULT_DASHBOARD_CACHE_MS,
  DEFAULT_GRAPH_INTEGRATION_CACHE_MS,
  DEFAULT_GRAPH_REVIEW_CACHE_MS,
  DEFAULT_META_BOARD_CACHE_MS,
  DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  GRAPH_CLIENT_SCRIPTS,
  GRAPH_CLIENT_STYLESHEETS,
} from "./constants.mjs";
import { getDashboardData as defaultGetDashboardData } from "./dashboard.mjs";
import { clearReviewerGroupCache } from "./reviewer-groups-cache.mjs";
import { getBugzillaRevisions as defaultGetBugzillaRevisions } from "../../lib/bugzilla-revisions.mjs";
import {
  clearDashboardTimelineCache as defaultClearDashboardTimelineCache,
  getDashboardTimelineCacheStatus as defaultGetDashboardTimelineCacheStatus,
} from "./dashboard-timeline-cache.mjs";
import {
  clearDashboardCache as defaultClearDashboardCache,
  getDashboardCacheStatus as defaultGetDashboardCacheStatus,
  loadDashboardCache as defaultLoadDashboardCache,
  saveDashboardCache as defaultSaveDashboardCache,
} from "./dashboard-cache.mjs";
import {
  getMetaBoardBugDetail as defaultGetMetaBoardBugDetail,
  getMetaBoardData as defaultGetMetaBoardData,
  updateMetaBoardBug as defaultUpdateMetaBoardBug,
} from "./meta-boards.mjs";
import {
  normalizeSprintMeta,
  formatSprintSummary,
  createSprint as defaultCreateSprint,
  getSprintData as defaultGetSprintData,
  getSprintPatchCompletionDates,
  rolloverSprint as defaultRolloverSprint,
  setSprintStoryMembership as defaultSetSprintStoryMembership,
  updateSprint as defaultUpdateSprint,
} from "./sprints.mjs";
import {
  addMetaBoard as defaultAddMetaBoard,
  assignMetaBoardColors as defaultAssignMetaBoardColors,
  readMetaBoardStore as defaultReadMetaBoardStore,
  removeMetaBoard as defaultRemoveMetaBoard,
  setMetaBoardReviewGroup as defaultSetMetaBoardReviewGroup,
} from "./meta-board-store.mjs";
import { getReviewGroupAssignees as defaultGetReviewGroupAssignees } from "./reviewer-assignees.mjs";
import {
  getGraphClientScriptPath,
  getGraphClientStylesheetPath,
} from "./assets.mjs";
import {
  getCheckoutCommitPage,
  getCommitDiff,
  getGraphCommitMessage,
  getGraphCurrentCommitMessage,
  isWorkingTreeCommitHash,
} from "./data.mjs";
import {
  createGraphCommit,
  getGraphCommitMetadata,
} from "./commit.mjs";
import {
  amendCommitMessage,
  checkoutGraphCommit,
  chooseGraphMachCheckout,
  continueRebaseCommit,
  createGraphLintSession,
  createGraphMachSession,
  createGraphSubmitSession,
  createGraphTrySession,
  getCheckoutGraphSnapshot,
  getCurrentGraphBase,
  getGraphCommitIntegrationStatus,
  isGraphCommitOnOriginMain,
  getGraphOriginMainStatus,
  getGraphRustUpstreamStatus,
  rebaseCommit,
  getInteractiveRebasePlan,
  markGraphBugForCheckin,
  runGraphCommitAction,
  runGraphRepositoryUpdate,
  serializeGraphLintSession,
  serializeGraphMachSession,
  serializeGraphTrySession,
  serializeSubmitSession,
  startInteractiveRebase,
  unshelfGraphShelves,
} from "./actions.mjs";
import { copyGraphCommitsBetweenCheckouts } from "./checkout-transfer.mjs";
import { syncReviewCheckoutFromWorking } from "./review-sync.mjs";
import { createTaskWorktreeManager } from "./task-worktrees.mjs";
import { ensurePairedWorktrees, getWorktreeDirectory, writeWorktreeBuildConfig } from "./worktrees.mjs";
import { getGraphCommitReview } from "./reviews.mjs";
import {
  applyGraphPatchUpdateComment,
  acceptGraphPatchUpdateChange,
  amendGraphPatchUpdateChanges,
  createGraphPatchUpdateSession,
  cancelGraphPatchUpdateSession,
  findGraphPatchCommit,
  followUpGraphPatchUpdateComment,
  isGraphAiEnabled,
  resolveGraphCodexCommand,
  markGraphPatchUpdateCommentHandled,
  prepareGraphPatchUpdateSession,
  resumeGraphPatchUpdateAssessment,
  recoverGraphPatchUpdateChange,
  reviseGraphPatchUpdateChange,
  revertGraphPatchUpdateChange,
  resolveGraphPatchUpdateWorkingCheckout,
  saveGraphPatchUpdateReply,
  serializeGraphPatchUpdateSession,
  steerGraphPatchUpdateSession,
  runGraphPatchFreeformUpdate,
  rollbackGraphPatchFreeformUpdate,
} from "./patch-update.mjs";
import {
  addGraphPatchReviewInline,
  applyGraphPatchReviewSuggestion,
  cancelGraphPatchReviewSession,
  createGraphPatchReviewSession,
  getGraphPatchReviewContext,
  importGraphPatchReviewConflictStack,
  importGraphPatchReviewSinglePatch,
  refreshGraphPatchReviewContext,
  prepareGraphPatchReviewSession,
  retryGraphPatchReviewSession,
  serializeGraphPatchReviewSession,
  skipGraphPatchReviewIssue,
  steerGraphPatchReviewSession,
  submitGraphPatchReview,
} from "./patch-review.mjs";
import { rateGraphPatchReviewFinding } from "./patch-review-feedback.mjs";
import {
  createPatchSessionStore,
  assertPatchSessionCheckout,
  canResumePatchSession,
  getPatchSessionCheckoutHash,
} from "./patch-session-store.mjs";
import { saveGraphPatchUpdateMemory as defaultSavePatchUpdateMemory } from "./patch-update-memory.mjs";
import { getDefaultKnowledgeService, getDefaultKnowledgeSnapshot, stopDefaultKnowledgeService } from "../knowledge-service.mjs";
import {
  getGraphPatchUpdateHandledCommentIds as defaultGetPatchUpdateHandledCommentIds,
  markGraphPatchUpdateCommentHandled as defaultPersistPatchUpdateHandledComment,
} from "./patch-update-state.mjs";
import {
  createGraphLandSession,
  loadGraphLandingPatchTryStatus,
  serializeGraphLandSession,
} from "./landing.mjs";
import {
  createGraphNewPatchSession,
  serializeGraphNewPatchSession,
} from "./new-patch.mjs";
import {
  createGraphPatchSession,
  serializeGraphPatchSession,
} from "./patching.mjs";
import {
  createGraphTestSession,
  serializeGraphTestSession,
} from "./testing.mjs";
import { createPhabricatorWebSession } from "./phab-auth.mjs";

const DASHBOARD_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_NOTION_STORY_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_SPRINT_HISTORY_CACHE_MS = 5 * 60 * 1000;
const INTERACTIVE_SERVER_CLOSE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

async function readRequestJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendText(
  response,
  statusCode,
  body,
  contentType = "text/plain; charset=utf-8",
) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function validateToken(token, expectedToken) {
  if (token !== expectedToken) {
    const error = new Error("Invalid interactive graph token.");
    error.statusCode = 403;
    throw error;
  }
}

function mergeGraphCommits(existingCommits = [], nextCommits = []) {
  const commits = new Map(
    existingCommits.map((commit) => [commit.hash, commit]),
  );

  for (const commit of nextCommits) {
    commits.set(commit.hash, commit);
  }

  return Array.from(commits.values());
}

function formatDurationLabel(milliseconds) {
  const seconds = Math.ceil(Number(milliseconds || 0) / 1000);
  const unit = seconds === 1 ? "second" : "seconds";

  return `${seconds} ${unit}`;
}

function mergeMetaBoardAssignees(...lists) {
  return Array.from(new Map(lists.flat()
    .filter((assignee) => assignee?.email)
    .map((assignee) => [assignee.email.toLowerCase(), assignee])).values())
    .sort((first, second) => first.name.localeCompare(second.name));
}

export async function startInteractiveGraphServer({
  html,
  launcherHtml,
  graphs,
  token,
  pageSize = 80,
  port = 0,
  fallbackPort,
  host = "127.0.0.1",
  heartbeatIntervalMs = 2000,
  browserShutdownGraceMs = DEFAULT_BROWSER_SHUTDOWN_GRACE_MS,
  closeBrowserTabsOnShutdown = true,
  runCommand = run,
  generateRebaseResolution,
  createBug = defaultCreateBug,
  getBugs = defaultGetBugs,
  getAssignedOpenBugs = defaultGetAssignedOpenBugs,
  getAttachments = defaultGetAttachments,
  getBug = defaultGetBug,
  getBugzillaRevisions = defaultGetBugzillaRevisions,
  getBugComments = defaultGetBugComments,
  getBugHistoryByIds = defaultGetBugHistoryByIds,
  getBugsByIds = defaultGetBugsByIds,
  getBugsWithAttachmentsByIds = defaultGetBugsWithAttachmentsByIds,
  getNeedinfoOpenBugs = defaultGetNeedinfoOpenBugs,
  updateBug = defaultUpdateBug,
  getDashboardData = defaultGetDashboardData,
  clearDashboardTimelineCache = defaultClearDashboardTimelineCache,
  clearDashboardCache = defaultClearDashboardCache,
  getDashboardCacheStatus = defaultGetDashboardCacheStatus,
  getDashboardTimelineCacheStatus = defaultGetDashboardTimelineCacheStatus,
  loadDashboardCache = defaultLoadDashboardCache,
  getMetaBoardBugDetail = defaultGetMetaBoardBugDetail,
  getMetaBoardData = defaultGetMetaBoardData,
  updateMetaBoardBug = defaultUpdateMetaBoardBug,
  createSprint = defaultCreateSprint,
  getSprintData = defaultGetSprintData,
  rolloverSprint = defaultRolloverSprint,
  setSprintStoryMembership = defaultSetSprintStoryMembership,
  updateSprint = defaultUpdateSprint,
  getNotionStoriesByBugId = defaultGetNotionStoriesByBugId,
  phab = defaultPhab,
  clearPhabricatorCache = defaultClearPhabricatorCache,
  getPhabricatorCacheStatus = defaultGetPhabricatorCacheStatus,
  postComment = defaultComment,
  pushCommits = defaultPushCommits,
  readMetaBoardStore = defaultReadMetaBoardStore,
  removeMetaBoard = defaultRemoveMetaBoard,
  assignMetaBoardColors = defaultAssignMetaBoardColors,
  getRustUpstreamStatus = getGraphRustUpstreamStatus,
  addMetaBoard = defaultAddMetaBoard,
  setMetaBoardReviewGroup = defaultSetMetaBoardReviewGroup,
  getReviewGroupAssignees = defaultGetReviewGroupAssignees,
  aiSettingsPath = AI_SETTINGS_PATH,
  serviceCredentialsPath = path.join(os.homedir(), ".tb.json"),
  dailyBuild = null,
  dependencyUpdate = null,
  getAiModels,
  appConfig = defaultConfig,
  getKnowledgeService = getDefaultKnowledgeService,
  getKnowledgeStatus = getKnowledgeService === getDefaultKnowledgeService ? getDefaultKnowledgeSnapshot : async () => (await getKnowledgeService())?.queryGapStatus?.(),
  phabWebSession = createPhabricatorWebSession(),
  getPatchUpdateHandledCommentIds = defaultGetPatchUpdateHandledCommentIds,
  persistPatchUpdateHandledComment = defaultPersistPatchUpdateHandledComment,
  savePatchUpdateMemory = defaultSavePatchUpdateMemory,
  saveDashboardCache = defaultSaveDashboardCache,
  acceptPatchUpdateChange = acceptGraphPatchUpdateChange,
  preparePatchUpdateSession = prepareGraphPatchUpdateSession,
  preparePatchReviewSession = prepareGraphPatchReviewSession,
  retryPatchReviewSession = retryGraphPatchReviewSession,
  syncReviewCheckout = syncReviewCheckoutFromWorking,
  serverFactory = createServer,
  patchSessionDirectory,
  taskDismissalDirectory,
  taskWorktreeDirectory,
  prepareTaskBuild = runCommand === run,
  reviewHandledPath,
  implementationManager,
  backgroundTryStore = createTryMonitorStore(),
  tryMonitor = runCommand === run && !process.env.NODE_TEST_CONTEXT && !globalThis.__tbToolsBlockExternalApis ? createTryMonitor({ graphs, taskWorktrees: appConfig?.taskWorktrees === true, aiEnabled: isGraphAiEnabled(appConfig), codexCommand: appConfig?.ai?.command }) : null,
}) {
  const serverGraphs = graphs.map((graph) => ({
    ...graph,
    commits: graph.commits || [],
    knownHashes: new Set((graph.commits || []).map((commit) => commit.hash)),
    workingTreeCount: graph.workingTreeCount || 0,
    patchIdCache: new Map(),
  }));
  const taskWorktrees = appConfig?.taskWorktrees === true;
  const taskManager = taskWorktrees ? createTaskWorktreeManager({ graphs: serverGraphs,
    runCommand, directory: taskWorktreeDirectory }) : null;
  let updateTaskManager = taskManager;
  function getUpdateTaskManager() {
    return updateTaskManager ||= createTaskWorktreeManager({ graphs: serverGraphs,
      runCommand, directory: taskWorktreeDirectory });
  }
  const managedReviewId = /^[a-f0-9]{8}$/.test(appConfig?.managedReviewWorktrees || "")
    ? appConfig.managedReviewWorktrees : "";
  const workingComm = serverGraphs.find(graph => graph.checkout === "working" && graph.repository === "comm");
  const workingFirefox = serverGraphs.find(graph => graph.checkout === "working" && graph.repository === "firefox");
  function configureManagedReviewSession(session) {
    if (taskManager) { taskManager.configure(session, "review"); return; }
    if (!managedReviewId) return;
    if (!workingComm || !workingFirefox) throw new Error("Managed Review needs Working Firefox and comm checkouts.");
    const name = `review-${managedReviewId}-${session.revision.toLowerCase()}`;
    const directory = getWorktreeDirectory(name);
    session.graph = { ...session.graph, path: path.join(directory, "comm") };
    session.reviewFirefoxPath = directory;
    session.managedWorktree = true;
  }
  async function prepareManagedReviewCheckout(session) {
    if (session.graph.taskWorktree) { await taskManager.prepareReview(session); return; }
    if (!session.managedWorktree) return;
    const gecko = session.reviewFirefoxPath;
    const revisions = [];
    for (const source of [workingFirefox.path, workingComm.path]) {
      const options = { cmd: "git", cwd: source, capture: true, silent: true, signal: session.abortController?.signal };
      await runCommand({ ...options, args: ["fetch", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"] });
      revisions.push(String(await runCommand({ ...options, args: ["rev-parse", "origin/main"] })).trim());
    }
    session.reviewMainHash = revisions[1];
    await ensurePairedWorktrees({ geckoSource: workingFirefox.path,
      commSource: workingComm.path, directory: gecko, geckoRevision: revisions[0], commRevision: revisions[1] });
    await writeWorktreeBuildConfig({ gecko, name: `review-${session.revision.toLowerCase()}` });
  }
  async function getCommandCheckout(graphIndex, kind) {
    const selected = chooseGraphMachCheckout(serverGraphs, graphIndex);
    if (!taskManager) return selected;
    const workspace = await taskManager.prepareCurrent(kind);
    return { ...selected, graph: workspace.graph };
  }
  const implementation = implementationManager === undefined && !process.env.NODE_TEST_CONTEXT && !globalThis.__tbToolsBlockExternalApis
    ? createImplementationManager({ graphs: serverGraphs, aiEnabled: isGraphAiEnabled(appConfig),
      username: appConfig?.bugzilla?.user, codexCommand: appConfig?.ai?.command, runCommand, taskManager, prepareTaskBuild })
    : implementationManager;
  async function getSettingsModels() {
    if (getAiModels) return getAiModels();
    const command = await resolveGraphCodexCommand({ configuredCommand: appConfig?.ai?.command });
    const client = createGraphCodexAppServer({ command, cwd: serverGraphs[0]?.path || process.cwd(), knowledge: false });
    try { return await client.listModels(); }
    finally { client.close(); }
  }
  const submitSessions = new Map();
  const patchUpdateSessions = new Map();
  const patchReviewSessions = new Map();
  const preparingReviews = new Set();
  async function prepareTrackedReview(options) {
    preparingReviews.add(options.session.id);
    try { return await preparePatchReviewSession(options); }
    finally { preparingReviews.delete(options.session.id); }
  }
  function continuePreparedReview(session) {
    session.status = "pulling";
    session.error = "";
    session.restored = false;
    session.interrupted = false;
    session.rebaseConflict = null;
    void prepareTrackedReview({ session, useAppliedCheckout: true,
      ...(prepareTaskBuild ? { prepareBuild: taskManager?.prepareBuild } : {}),
      getSnapshot: getServerGraphSnapshot,
      getReview: ({ graph, hash }) => getServerCommitReview(graph, hash, { force: true }),
      getRevisionReview: phabWebSession.getReview?.bind(phabWebSession), runCommand }).catch(() => {});
  }
  const patchSessionStore = createPatchSessionStore({ directory: patchSessionDirectory });
  const taskDismissals = createTaskDismissalStore({ directory: taskDismissalDirectory ??
    (patchSessionDirectory ? path.join(patchSessionDirectory, "dismissed-tasks") : undefined) });
  let patchSessionsFrozen = false;
  if (taskWorktrees) for (const { kind, session } of patchSessionStore.list(serverGraphs, { includeFinished: true })) {
    if (taskDismissals.has(kind, session.id)) session.dismissed = true;
    session.aiEnabled = isGraphAiEnabled(appConfig);
    session.codexCommand = String(appConfig?.ai?.command || "");
    if (kind === "update") session.persistPatchState = () => patchSessionStore.save("update", session);
    (kind === "review" ? patchReviewSessions : patchUpdateSessions).set(session.id, session);
  }
  function savePatchSessions() {
    if (patchSessionsFrozen) return;
    for (const [kind, sessions] of [["update", patchUpdateSessions], ["review", patchReviewSessions]]) {
      for (const session of sessions.values()) {
        try {
          if (session.cancelled) session.status = "cancelled";
          patchSessionStore.save(kind, session);
        } catch (error) {
          session.error = `Could not save this session for resume: ${error.message}`;
        }
      }
    }
  }
  const patchSessionTimer = setInterval(savePatchSessions, 2000);
  patchSessionTimer.unref();

  function startPatchUpdatePreparation(
    session,
    snapshotLimit,
    { afterCheckoutUpdate = false } = {},
  ) {
    session.persistPatchState = () => patchSessionStore.save("update", session);
    session.status = "preparing";
    session.error = "";
    session.restored = false;
    session.interrupted = false;
    if (afterCheckoutUpdate) {
      session.previousHash = session.currentHash;
      session.refreshAfterCheckoutUpdate = true;
      session.restored = false;
      session.interrupted = false;
      session.status = "preparing";
      session.error = "";
      session.message = "Refreshing the local patch and latest Phabricator comments...";
      session.items = [];
      session.currentItemIndex = 0;
      session.handledItemCount = 0;
      session.patchContext = null;
      session.memoryContext = "";
      session.pendingChange = null;
      session.changeSnapshots = new Map();
      session.workingTreeDiffVersion = (session.workingTreeDiffVersion || 0) + 1;
      session.workingDiff = "";
      session.workingDiffHtml = "";
    } else {
      session.refreshAfterCheckoutUpdate = false;
    }
    const workingCheckout = resolveGraphPatchUpdateWorkingCheckout({
      graphs: session.graph.taskWorktree ? getUpdateTaskManager().taskGraphs(session) : serverGraphs,
    });

    session.updateOperationRunning = true;
    void (async () => {
      let found;
      if (session.graph.taskWorktree && !session.workspacePrepared) {
        found = await findGraphPatchCommit({ graph: getUpdateTaskManager().sourceGraph,
          revision: session.revision, newest: ["verify", "freeform"].includes(session.mode), runCommand });
        session.originalHash = found.hash; session.currentHash = found.hash;
        await getUpdateTaskManager().prepare(session, { commRevision: found.hash, signal: session.abortController?.signal });
        session.workspacePrepared = true;
      }
      if (session.cancelled) throw new Error("Update cancelled.");
      return preparePatchUpdateSession({
      session,
      graphs: workingCheckout.graphs,
      getRustUpstreamStatus: () => getServerRustUpstreamStatus({
        checkout: "working",
        wait: true,
      }),
      getSnapshot: getServerGraphSnapshot,
      getHandledCommentIds: getPatchUpdateHandledCommentIds,
      getReview: ({ graph, hash, force }) => getServerCommitReview(graph, hash, { force }),
      phab,
      runCommand: options => runCommand({ ...options, signal: session.abortController?.signal, killProcessGroup: true }),
      saveMemory: savePatchUpdateMemory,
      snapshotLimit,
      ...(session.managedWorktree && prepareTaskBuild ? { prepareBuild: getUpdateTaskManager().prepareBuild } : {}),
      ...(found ? { findPatchCommit: async () => found } : {}),
    });
    })().catch(error => {
      if (error.rebaseState) {
        error.rebaseState.patchUpdateSessionId = session.id;
        const payload = {};
        attachRebaseConflict(payload, error);
        session.rebaseConflict = payload.rebaseConflict;
      }
      session.status = "error"; session.error = error.message; session.message = error.message;
    }).finally(() => { session.updateOperationRunning = false; savePatchSessions(); });
  }

  async function getPatchSessionBaseHash(session) {
    return String(await runCommand({
      cmd: "git",
      args: ["rev-parse", `origin/${DEFAULT_BRANCH}`],
      cwd: session.graph.path,
      capture: true,
      silent: true,
    })).trim();
  }

  async function restorePatchSession(kind, fresh, body, response) {
    const reply = body => { if (response) sendJson(response, 200, body); };
    const sessions = kind === "update" ? patchUpdateSessions : patchReviewSessions;
    const runningReview = kind === "review" && [...sessions.values()].find((entry) =>
      entry.revision === fresh.revision && (entry.graph.path === fresh.graph.path ||
        fresh.managedWorktree && entry.repositoryPath === fresh.repositoryPath) &&
      !entry.cancelled && ["pulling", "reviewing"].includes(entry.status));
    if (runningReview && !runningReview.restored && body.resume !== false) {
      reply( { ok: true, ...serializeGraphPatchReviewSession(runningReview) });
      return true;
    }
    const saved = [...sessions.values()].find((entry) =>
      entry.revision === fresh.revision && (entry.graph.path === fresh.graph.path ||
        fresh.managedWorktree && entry.repositoryPath === fresh.repositoryPath) &&
      (entry.mode || "update") === (fresh.mode || "update") && canResumePatchSession(entry))
      || patchSessionStore.load(kind, fresh);
    if (!fresh.aiEnabled || !canResumePatchSession(saved)) return false;
    if (kind === "update") saved.persistPatchState = () => patchSessionStore.save("update", saved);
    if (kind === "update" && Boolean(saved.managedWorktree) !== Boolean(fresh.managedWorktree)) return false;
    if (body.resume === false) {
      saved.codexAgent?.client.close();
      sessions.delete(saved.id);
      return false;
    }
    if (body.resume !== true) {
      reply( { ok: true, resumeAvailable: true, revision: saved.revision });
      return true;
    }
    saved.dismissed = false;
    saved.recoveryFailed = false;
    patchSessionStore.save(kind, saved);
    const restartReview = () => {
      // Reconnect the saved conversation so callbacks use the refreshed session.
      saved.codexAgent?.client.close();
      const resumed = {
        ...fresh,
        id: saved.id,
        graph: saved.graph,
        reviewFirefoxPath: saved.reviewFirefoxPath,
        repositoryPath: saved.repositoryPath,
        codexSessionId: saved.codexSessionId,
        codexThreadName: saved.codexThreadName,
        codexAgent: null,
        output: saved.output,
        commitMessage: saved.commitMessage,
        activity: saved.activity || [],
        resumeReviewContext: {
          currentHash: saved.currentHash,
          rawPatchHash: saved.rawPatchHash,
          issues: saved.issues || [],
          patchContext: saved.patchContext,
          coverage: saved.coverage,
        },
        reviewContextVersion: (saved.reviewContextVersion || 0) + 1,
        workingTreeDiffVersion: (saved.workingTreeDiffVersion || 0) + 1,
      };
      sessions.set(resumed.id, resumed);
      void prepareTrackedReview({
        session: resumed,
        prepareCheckout: prepareManagedReviewCheckout,
      ...(taskWorktrees && prepareTaskBuild ? { prepareBuild: taskManager.prepareBuild } : {}),
        getSnapshot: getServerGraphSnapshot,
        getReview: ({ graph, hash }) => getServerCommitReview(graph, hash, { force: true }),
        getRevisionReview: phabWebSession.getReview?.bind(phabWebSession),
        runCommand,
      }).catch(() => {}).finally(savePatchSessions);
      reply( { ok: true, ...serializeGraphPatchReviewSession(resumed) });
      return true;
    };
    if (kind === "review" && saved.applyConflict) {
      saved.restored = false;
      saved.interrupted = false;
      saved.status = "paused";
      sessions.set(saved.id, saved);
      reply({ ok: true, ...serializeGraphPatchReviewSession(saved) });
      return true;
    }
    if (kind === "update" && saved.rebaseConflict) {
      sessions.set(saved.id, saved);
      reply( { ok: true, ...serializeGraphPatchUpdateSession(saved) });
      return true;
    }
    if (saved.managedWorktree && saved.interrupted && !saved.codexSessionId) {
      if (kind === "review") return restartReview();
      startPatchUpdatePreparation(saved, getRequestLimit(body.snapshotLimit));
      sessions.set(saved.id, saved);
      reply( { ok: true, ...serializeGraphPatchUpdateSession(saved) });
      return true;
    }
    const head = await getPatchSessionCheckoutHash(saved, runCommand);
    if (kind === "review" && head !== saved.currentHash) return restartReview();
    const baseChanged = kind === "update" && saved.baseHash &&
      await getPatchSessionBaseHash(saved) !== saved.baseHash;
    const newerVerifyCopy = kind === "update" && saved.mode === "verify" && /^D\d+$/.test(saved.revision) &&
      (await findGraphPatchCommit({ graph: saved.graph, revision: saved.revision,
        newest: true, runCommand })).hash !== saved.currentHash;
    if (kind === "update" && saved.mode === "freeform" && head !== saved.currentHash) {
      await assertPatchSessionCheckout(saved, runCommand);
    }
    if (kind === "update" && saved.mode !== "freeform" && (head !== saved.currentHash || baseChanged || newerVerifyCopy)) {
      if (saved.mode === "verify") {
        const dirty = await runCommand({ cmd: "git", args: ["status", "--porcelain"],
          cwd: saved.graph.path, capture: true, silent: true });
        if (String(dirty).trim()) {
          const error = new Error("Keep or revert the working checkout changes before refreshing Verify. Saved findings are unchanged.");
          error.statusCode = 409;
          throw error;
        }
      }
      startPatchUpdatePreparation(saved, getRequestLimit(body.snapshotLimit), {
        afterCheckoutUpdate: true,
      });
      sessions.set(saved.id, saved);
      savePatchSessions();
      reply( {
        ok: true,
        ...serializeGraphPatchUpdateSession(saved),
      });
      return true;
    }
    await assertPatchSessionCheckout(saved, runCommand);
    let discussionChanged = false;
    if (kind === "review" && saved.rawPatchHash) {
      try {
        discussionChanged = await refreshGraphPatchReviewContext({
          session: saved, getRevisionReview: phabWebSession.getReview.bind(phabWebSession),
        });
      } catch (error) {
        if (error.code === "REVIEW_PATCH_CHANGED") return restartReview();
        throw error;
      }
    }
    if (kind === "review" && saved.status === "error" && saved.codexSessionId) {
      saved.restored = false;
      saved.interrupted = false;
      retryPatchReviewSession({ session: saved, runCommand });
      sessions.set(saved.id, saved);
      savePatchSessions();
      reply( { ok: true, ...serializeGraphPatchReviewSession(saved) });
      return true;
    }
    if (saved.restored) {
      saved.restored = false;
      saved.graph.knownHashes.add(saved.currentHash);
      // Cached diff HTML is restored, but local edits must be read again.
      saved.workingTreeDiffVersion = (saved.workingTreeDiffVersion || 0) + 1;
      saved.workingDiff = "";
      saved.workingDiffHtml = "";
      saved.error = "";
      const recoveredChange = kind === "update" && !saved.pendingPublication && await recoverGraphPatchUpdateChange({ session: saved, runCommand });
      if (kind === "update" && saved.mode === "freeform" && !recoveredChange) {
        saved.status = "review";
        saved.message = "Resumed Update. Continue in the saved conversation.";
      } else if (!recoveredChange && saved.interrupted && saved.codexSessionId) {
        saved.interrupted = false;
        if (kind === "update") {
          void resumeGraphPatchUpdateAssessment({ session: saved }).finally(savePatchSessions);
        } else {
          saved.status = "review";
          await steerGraphPatchReviewSession({ session: saved, runCommand, instruction: "Continue the interrupted review from this saved conversation. Use the existing research and test results. Check local edits left by the interrupted turn. Do not repeat completed research unless the current source makes it necessary. Return the complete review findings." });
        }
      } else if (!recoveredChange) {
        saved.message = kind === "review" && saved.remoteCheckedAt
          ? "Resumed saved review. Checked Phabricator for patch and discussion updates."
          : "Resumed saved results. Continue where you left off. New remote comments have not been fetched.";
      }
    }
    if (discussionChanged && saved.status === "review") {
      await steerGraphPatchReviewSession({ session: saved, runCommand, instruction: `The patch is unchanged, but Phabricator discussion changed. Continue the existing review. Reuse prior research and validation. Re-evaluate only conclusions affected by this discussion; do not repeat full context establishment. Current discussion: ${JSON.stringify(saved.reviewDiscussion)}` });
    }
    sessions.set(saved.id, saved);
    savePatchSessions();
    reply( { ok: true, ...(kind === "update"
      ? serializeGraphPatchUpdateSession(saved) : serializeGraphPatchReviewSession(saved)) });
    return true;
  }
  const machSessions = new Map();
  const lintSessions = new Map();
  const newPatchSessions = new Map();
  const patchSessions = new Map();
  const trySessions = new Map();
  let dashboardPatchActionRunning = false;
  let dashboardTrySessionId = "";
  const landSessions = new Map();
  const testSessions = new Map();
  const rebaseStore = createRebaseSessionStore({ directory: patchSessionDirectory ? path.join(patchSessionDirectory, "rebases") : undefined });
  const rebaseSessions = new Map(rebaseStore.load(serverGraphs).map(session => [session.id, session]));
  async function reconcileSavedRebases() {
    for (const session of rebaseSessions.values()) {
      if (rebaseStore.isDismissed(session.id) || !await hasActiveRebaseSession(session, runCommand)) {
        rebaseSessions.delete(session.id);
        rebaseStore.remove(session.id);
      }
    }
  }
  function saveRebaseSessions() {
    for (const session of rebaseSessions.values()) {
      try { rebaseStore.save(session); }
      catch (error) { session.error = `Could not save this rebase for resume: ${error.message}`; }
    }
  }
  const rebaseSessionTimer = setInterval(saveRebaseSessions, 2000);
  rebaseSessionTimer.unref();
  let cleaningWorktrees = false;
  async function cleanupFinishedWorktrees() {
    if (!taskManager || cleaningWorktrees) return;
    cleaningWorktrees = true;
    try {
      const handled = new Set((await reviewHandled.list()).map(patch => patch.id));
      const tryWorkflows = backgroundTryStore.list();
      for (const session of patchReviewSessions.values()) {
        if (session.restored && handled.has(session.revision)) {
          session.activity ||= [];
          cancelGraphPatchReviewSession({ session });
          session.status = "complete";
        }
      }
      for (const [kind, sessions] of [["review", patchReviewSessions], ["update", patchUpdateSessions],
        ["rebase", rebaseSessions], ["command", machSessions], ["command", lintSessions],
        ["command", testSessions], ["command", trySessions], ["command", submitSessions]]) {
        for (const session of sessions.values()) {
          const ended = ["complete", "cancelled", "canceled"].includes(session.status) || kind === "command" && session.status === "error";
          if (!ended || session.preparationRunning || preparingReviews.has(session.id) || session.freeformOperationRunning || session.updateOperationRunning || session.pendingChange || session.continueBusy || session.patchUpdateSessionId || session.patchReviewSessionId) continue;
          if (kind === "update" && [...submitSessions.values()].some(submission =>
            submission.patchUpdateSessionId === session.id && !["complete", "error", "cancelled"].includes(submission.status))) continue;
          if (kind !== "review" && tryWorkflows.some(state => state.path === session.graph?.path &&
              (state.aiPid || state.workerPid || !["passed", "squashed", "cancelled", "superseded"].includes(state.phase)))) continue;
          session.codexAgent?.client.close();
          try { await taskManager.cleanup(session, { review: kind === "review" }); }
          catch (error) { session.cleanupError = `Could not remove the task worktree: ${error.message}`; }
        }
      }
      for (const state of implementation?.list() || []) {
        if (!["complete", "cancelled"].includes(state.phase) || !state.repositoryPath) continue;
        const workspace = taskManager.configure({ id: state.id }, "implement");
        if (workspace.graph.path !== state.path) continue;
        try { await taskManager.cleanup(workspace); }
        catch (error) { state.cleanupError = `Could not remove the task worktree: ${error.message}`; }
      }
      for (const state of tryWorkflows) {
        if (isActiveTryTask(state)) continue;
        if (state.repositoryPath !== taskManager.sourceGraph.path && state.path !== taskManager.sourceGraph.path) continue;
        try {
          await taskManager.cleanupTryWorkspace(state, backgroundTryStore.directory);
          const taskName = path.basename(path.dirname(state.path));
          const taskId = taskName.startsWith("task-") ? taskName.slice(5) : "";
          const ownerActive = [...patchUpdateSessions.values(), ...patchReviewSessions.values(), ...rebaseSessions.values()]
            .some(session => session.graph?.path === state.path && !["complete", "cancelled"].includes(session.status)) ||
            (implementation?.list() || []).some(task => task.path === state.path && !["complete", "cancelled"].includes(task.phase));
          if (taskId && state.repositoryPath === taskManager.sourceGraph.path && !ownerActive) {
            const workspace = taskManager.configure({ id: taskId }, "try");
            if (workspace.graph.path === state.path) await taskManager.cleanup(workspace);
          }
          backgroundTryStore.save(state);
        } catch (error) { state.cleanupError = `Could not remove the Try worktree: ${error.message}`; }
      }
      const activeIds = new Set([...patchReviewSessions.values(), ...patchUpdateSessions.values(), ...rebaseSessions.values(),
        ...machSessions.values(), ...lintSessions.values(), ...testSessions.values(), ...trySessions.values(), ...submitSessions.values()]
        .filter(session => !session.worktreeRemoved && (!["complete", "error", "cancelled", "canceled"].includes(session.status) || session.preparationRunning || session.freeformOperationRunning || session.updateOperationRunning || session.pendingChange)).map(session => session.graph?.taskId).filter(Boolean));
      for (const session of patchReviewSessions.values()) {
        if (!session.worktreeRemoved && !["complete", "cancelled", "canceled"].includes(session.status) && session.graph?.taskId) activeIds.add(session.graph.taskId);
      }
      for (const state of implementation?.list() || []) {
        if (!["complete", "cancelled", "error"].includes(state.phase)) activeIds.add(state.id);
      }
      for (const state of tryWorkflows) {
        const task = path.basename(path.dirname(state.path || ""));
        if (task.startsWith("task-") && isActiveTryTask(state)) activeIds.add(task.slice(5));
      }
      const activePaths = new Set([...patchReviewSessions.values(), ...patchUpdateSessions.values(), ...rebaseSessions.values()]
        .filter(session => session.graph && !["complete", "error", "cancelled", "canceled"].includes(session.status)).map(session => session.reviewFirefoxPath || path.dirname(session.graph.path)));
      await taskManager.cleanupInactiveTryWorkspaces(tryWorkflows, backgroundTryStore.directory, isActiveTryTask);
      await taskManager.cleanupInactiveWorktrees(activeIds, activePaths);
      if (!process.env.NODE_TEST_CONTEXT && !globalThis.__tbToolsBlockExternalApis && Date.now() - lastStorageCleanup > 600000) {
        await pruneTryStorage({ store: backgroundTryStore });
        await pruneStorage({ directory: getSharedBuildCacheDirectory(), ...STORAGE_LIMITS.buildSnapshots,
          select: name => /^(?:compiled|binaries)-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/.test(name) });
        lastStorageCleanup = Date.now();
      }
      await taskManager.archiveRetiredBranches(id => activeIds.has(id) ||
        [...patchReviewSessions.values(), ...patchUpdateSessions.values(), ...rebaseSessions.values(),
          ...machSessions.values(), ...lintSessions.values(), ...testSessions.values(), ...trySessions.values(), ...submitSessions.values()]
          .some(session => !session.worktreeRemoved && session.graph?.taskId === id));
    } finally { cleaningWorktrees = false; }
  }
  let lastStorageCleanup = 0;
  const worktreeCleanupTimer = setInterval(() => { void cleanupFinishedWorktrees().catch(error => { if (server.listening) console.error("Task cleanup failed:", error.message); }); },
    process.env.NODE_TEST_CONTEXT || globalThis.__tbToolsBlockExternalApis ? 2000 : 60000);
  worktreeCleanupTimer.unref();
  const commitIntegrationCache = new Map();
  const commitIntegrationInflight = new Map();
  const commitReviewCache = new Map();
  const commitReviewInflight = new Map();
  const commitDiffCache = new Map();
  const commitDiffInflight = new Map();
  const notionStoryCache = new Map();
  const notionStoryInflight = new Map();
  let notionDisabled = false;
  const reviewHandled = createReviewHandledStore({ filePath: reviewHandledPath, username: appConfig?.phabricator?.user });
  let dashboardCache;
  let dashboardCacheLoaded = false;
  let dashboardCacheLoadPromise;
  let dashboardInflight;
  let dashboardCooldownUntil = 0;
  const metaBoardCache = new Map();
  const metaBoardInflight = new Map();
  const sprintHistoryCache = new Map();
  const sprintHistoryInflight = new Map();
  let metaBoardColorAssignment = Promise.resolve();
  const sockets = new Set();
  const browserShutdownWaiters = new Set();
  let closeTimer;
  let shuttingDown = false;
  const rustUpstreamStatuses = new Map();
  const rustUpstreamStatusCheckedAt = new Map();
  const rustUpstreamStatusPromises = new Map();

  async function completePatchUpdateComment({
    event = "Review comment marked done",
    itemId,
    state = "handled",
    session,
  }) {
    const item = session.items.find((candidate) => candidate.id === String(itemId));

    if (!item) {
      const error = new Error("Unknown review comment.");

      error.statusCode = 404;
      throw error;
    }

    if (item.changeApplied && !item.changeAccepted && !item.changesAmended) {
      const error = new Error(
        "Keep or revert the prepared working-tree change before marking this comment handled.",
      );

      error.statusCode = 409;
      throw error;
    }

    if (session.mode !== "verify" && session.mode !== "freeform" && item.type === "inline" && item.parentCommentPHID) {
      await phabWebSession.markInlineCommentDone({
        commentPHID: item.parentCommentPHID,
        revision: session.revision,
      });
    }

    if (!["verify", "freeform"].includes(session.mode)) {
      await persistPatchUpdateHandledComment({ revision: session.revision, itemId: item.id });
    }
    markGraphPatchUpdateCommentHandled({ session, itemId: item.id, state });
    await savePatchUpdateMemory({ event, session });
    return item;
  }

  function sendBrowserShutdownEvent(
    waiter,
    {
      closing = false,
      closeTabs = false,
      reason = "",
    } = {},
  ) {
    clearTimeout(waiter.timer);
    browserShutdownWaiters.delete(waiter);

    if (waiter.response.writableEnded) {
      return;
    }

    sendJson(waiter.response, 200, {
      ok: true,
      closing,
      closeTabs,
      reason,
    });
  }

  function notifyBrowserShutdown({
    closeTabs = false,
    reason = "",
  } = {}) {
    for (const waiter of [...browserShutdownWaiters]) {
      sendBrowserShutdownEvent(waiter, {
        closing: true,
        closeTabs,
        reason,
      });
    }
  }

  function noteBrowserActivity() {
    // Browser activity deliberately does not control the server lifetime.
  }

  function shutdown(delay = 0, reason = "server shutdown requested") {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    tryMonitor?.stop();
    implementation?.stop();
    savePatchSessions();
    patchSessionsFrozen = true;
    for (const session of [...patchReviewSessions.values(), ...patchUpdateSessions.values()]) {
      session.abortController?.abort();
      session.codexAgent?.client.close();
    }
    clearInterval(patchSessionTimer);
    clearInterval(rebaseSessionTimer);
    clearInterval(worktreeCleanupTimer);
    saveRebaseSessions();
    const shouldCloseBrowserTabs = Boolean(closeBrowserTabsOnShutdown);
    const shutdownDelay = shouldCloseBrowserTabs
      ? Math.max(Number(delay) || 0, Number(browserShutdownGraceMs) || 0)
      : Number(delay) || 0;

    machSessions.forEach((session) => session.cancel?.());
    newPatchSessions.forEach((session) => session.cancel?.());
    patchSessions.forEach((session) => session.cancel?.());
    testSessions.forEach((session) => session.cancel?.());
    const closePhabricatorSession = phabWebSession.close?.();

    void closePhabricatorSession?.catch(() => {});
    server.closeReason = reason;
    notifyBrowserShutdown({
      closeTabs: shouldCloseBrowserTabs,
      reason,
    });
    closeTimer = setTimeout(() => {
      if (server.listening) {
        server.close();
      }

      setTimeout(() => {
        sockets.forEach((socket) => socket.destroy());
      }, 250);
    }, shutdownDelay);
  }

  async function getServerGraphSnapshot(graph, limit) {
    const snapshot = await getCheckoutGraphSnapshot({
      graph,
      limit,
      runCommand,
    });

    graph.branch = snapshot.branch;
    graph.workingTreeCount = snapshot.workingTreeCount || 0;
    graph.commitCount = snapshot.commitCount || 0;
    graph.commits = snapshot.commits || [];
    const activePatchUpdateHashes = Array.from(patchUpdateSessions.values())
      .filter((session) => session.graph === graph)
      .flatMap((session) => [session.originalHash, session.currentHash])
      .filter(Boolean);

    // An update can resolve or rewrite a patch below the visible page. Keep
    // both revisions addressable while its review/submit flow is still open.
    graph.knownHashes = new Set([
      ...graph.commits.map((commit) => commit.hash),
      ...activePatchUpdateHashes,
    ]);

    return { ...snapshot, taskWorktree: graph.taskWorktree === true };
  }

  function getCommitCacheKey(graph, hash) {
    return `${graph.path}\u0000${hash}`;
  }

  async function getCachedCommitData({
    bypassCache = false,
    cache,
    cacheMs,
    getValue,
    inflight,
    key,
    shouldCache = () => true,
  }) {
    const now = Date.now();
    const cached = cache.get(key);

    if (!bypassCache && cached && now - cached.checkedAt < cacheMs) {
      return cached.value;
    }

    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const request = Promise.resolve(getValue())
      .then((value) => {
        if (shouldCache(value)) {
          cache.set(key, { checkedAt: Date.now(), value });
        }

        return value;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, request);
    return request;
  }

  async function getServerCommitIntegration(graph, hash) {
    return getCachedCommitData({
      cache: commitIntegrationCache,
      cacheMs: DEFAULT_GRAPH_INTEGRATION_CACHE_MS,
      getValue: () => getGraphCommitIntegrationStatus({
        graph,
        hash,
        runCommand,
        getBug,
        getBugzillaRevisions,
        phab,
        getNotionStoriesByBugId: getServerNotionStoriesByBugId,
      }),
      inflight: commitIntegrationInflight,
      key: getCommitCacheKey(graph, hash),
      shouldCache: (value) => !value?.phabricator?.error,
    });
  }

  async function getServerCommitReview(graph, hash, { force = false } = {}) {
    return getCachedCommitData({
      bypassCache: force,
      cache: commitReviewCache,
      cacheMs: DEFAULT_GRAPH_REVIEW_CACHE_MS,
      getValue: () => getGraphCommitReview({
        graph,
        hash,
        getWebSuggestions: phabWebSession.getSuggestions,
        getWebReview: phabWebSession.getReview?.bind(phabWebSession),
        runCommand,
        phab,
      }),
      inflight: commitReviewInflight,
      key: getCommitCacheKey(graph, hash),
    });
  }

  function getRequestLimit(value) {
    return Math.max(1, Number(value || pageSize) || pageSize);
  }

  function getRequestSnapshotLimit(body, index) {
    if (Array.isArray(body.snapshotLimits)) {
      return getRequestLimit(body.snapshotLimits[index]);
    }

    return getRequestLimit(body.snapshotLimit);
  }

  async function getServerGraphSnapshots(body) {
    return Promise.all(
      serverGraphs.map((graph, index) =>
        getServerGraphSnapshot(graph, getRequestSnapshotLimit(body, index)),
      ),
    );
  }

  function attachRebaseConflict(body, error) {
    if (!error?.rebaseConflict || !error?.rebaseState) {
      return;
    }

    const id = error.rebaseState.id || randomUUID();

    error.rebaseState.id = id;
    error.rebaseState.status = "review";
    error.rebaseState.savedConflict = { ...error.rebaseConflict, id };
    rebaseSessions.set(id, error.rebaseState);
    rebaseStore.save(error.rebaseState);
    body.rebaseConflict = error.rebaseState.savedConflict;
  }

  async function getServerOriginMainStatus(graph, { force = false } = {}) {
    if (!graph) {
      return null;
    }

    const now = Date.now();
    if (
      !force &&
      graph.originMainStatus &&
      graph.originMainStatusCheckedAt &&
      now - graph.originMainStatusCheckedAt <
        DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS
    ) {
      return graph.originMainStatus;
    }

    let status;

    if (graph.error) {
      status = {
        label: graph.label,
        checkout: graph.checkout || "working",
        repository: graph.repository || graph.label,
        path: graph.path,
        branch: DEFAULT_BRANCH,
        state: "error",
        upToDate: false,
        message: graph.error,
      };
    } else {
      try {
        status = await getGraphOriginMainStatus({
          graph,
          runCommand,
        });
      } catch (error) {
        status = {
          label: graph.label,
          checkout: graph.checkout || "working",
          repository: graph.repository || graph.label,
          path: graph.path,
          branch: DEFAULT_BRANCH,
          state: "error",
          upToDate: false,
          message: error && error.message ? error.message : String(error),
        };
      }
    }

    status = {
      ...status,
      checkout: status.checkout || getGraphCheckoutMode(graph),
      repository: status.repository || graph.repository || graph.label,
    };

    graph.originMainStatus = status;
    graph.originMainStatusCheckedAt = now;
    return status;
  }

  async function getServerOriginMainStatuses({
    force = false,
    waitForRust = false,
    checkout = "working",
  } = {}) {
    const selectedGraphs = getServerGraphsForCheckout(checkout);
    const statuses = (
      await Promise.all(
        selectedGraphs.map((graph) =>
          getServerOriginMainStatus(graph, { force }),
        ),
      )
    ).filter(Boolean);
    statuses.push(await getServerRustUpstreamStatus({
      force,
      wait: waitForRust,
      checkout,
    }));

    return statuses;
  }

  function getGraphCheckoutMode(graph = {}) {
    return graph.checkout === "review" ? "review" : "working";
  }

  function getGraphRepository(graph = {}) {
    return String(graph.repository || graph.label || "").trim().toLowerCase();
  }

  function getServerGraphsForCheckout(checkout = "working") {
    const selectedCheckout = checkout === "review" ? "review" : "working";
    const matchingGraphs = serverGraphs.filter(
      (graph) => getGraphCheckoutMode(graph) === selectedCheckout,
    );

    return matchingGraphs.length || selectedCheckout !== "working"
      ? matchingGraphs
      : serverGraphs;
  }

  function getServerRustUpstreamCheckingStatus(checkout = "working") {
    return {
      type: "rust-upstream",
      label: "rust",
      checkout,
      state: "checking",
      upToDate: null,
      message: "Checking Rust dependencies against fetched Firefox main.",
    };
  }

  async function refreshServerRustUpstreamStatus(checkout = "working") {
    if (rustUpstreamStatusPromises.has(checkout)) {
      return rustUpstreamStatusPromises.get(checkout);
    }

    const graphs = getServerGraphsForCheckout(checkout);
    const commGraph = graphs.find((graph) => getGraphRepository(graph) === "comm");
    const firefoxGraph = graphs.find((graph) => getGraphRepository(graph) === "firefox");
    rustUpstreamStatuses.set(
      checkout,
      rustUpstreamStatuses.get(checkout) || getServerRustUpstreamCheckingStatus(checkout),
    );
    const promise = (async () => {
      try {
        const status = await getRustUpstreamStatus({
          graphs,
          commGraph,
          firefoxGraph,
          runCommand,
        });
        rustUpstreamStatuses.set(checkout, { ...status, checkout });
      } catch (error) {
        rustUpstreamStatuses.set(checkout, {
          type: "rust-upstream",
          label: "rust",
          checkout,
          state: "error",
          upToDate: false,
          message: error && error.message ? error.message : String(error),
        });
      } finally {
        rustUpstreamStatusCheckedAt.set(checkout, Date.now());
        rustUpstreamStatusPromises.delete(checkout);
      }

      return rustUpstreamStatuses.get(checkout);
    })();
    rustUpstreamStatusPromises.set(checkout, promise);

    return promise;
  }

  function isFreshRustUpstreamStatus(checkout, now) {
    const status = rustUpstreamStatuses.get(checkout);

    return (
      status &&
      status.state !== "checking" &&
      rustUpstreamStatusCheckedAt.get(checkout) &&
      now - rustUpstreamStatusCheckedAt.get(checkout) < DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS
    );
  }

  function withDependencyUpdate(status, checkout) {
    const update = checkout === "working" ? dependencyUpdate?.status() : null;
    return update?.message ? { ...status, dependencyUpdate: update,
      message: `${status.message || ""} Automatic update: ${update.message}` } : status;
  }

  async function getServerRustUpstreamStatus({
    force = false,
    wait = false,
    checkout = "working",
  } = {}) {
    const now = Date.now();

    if (!force && isFreshRustUpstreamStatus(checkout, now)) {
      return withDependencyUpdate(rustUpstreamStatuses.get(checkout), checkout);
    }

    if (force) {
      if (wait) {
        return withDependencyUpdate(await refreshServerRustUpstreamStatus(checkout), checkout);
      }

      rustUpstreamStatuses.set(checkout, getServerRustUpstreamCheckingStatus(checkout));
      refreshServerRustUpstreamStatus(checkout);
      return withDependencyUpdate(rustUpstreamStatuses.get(checkout), checkout);
    }

    if (wait) {
      return withDependencyUpdate(await refreshServerRustUpstreamStatus(checkout), checkout);
    }

    refreshServerRustUpstreamStatus(checkout);
    return withDependencyUpdate(rustUpstreamStatuses.get(checkout) ||
      getServerRustUpstreamCheckingStatus(checkout), checkout);
  }

  function getNotionStoryCacheMs() {
    const cacheMs = Number(appConfig?.notion?.cacheMs);

    return Number.isFinite(cacheMs) ? Math.max(0, cacheMs) : DEFAULT_NOTION_STORY_CACHE_MS;
  }

  async function getServerNotionStoriesByBugId({ bugId }) {
    const normalizedBugId = String(bugId || "").trim();

    if (!normalizedBugId || notionDisabled) {
      return null;
    }

    const now = Date.now();
    const cached = notionStoryCache.get(normalizedBugId);

    if (cached && now - cached.checkedAt < getNotionStoryCacheMs()) {
      return cached.result;
    }

    if (notionStoryInflight.has(normalizedBugId)) {
      return notionStoryInflight.get(normalizedBugId);
    }

    const promise = Promise.resolve(
      getNotionStoriesByBugId({
        bugId: normalizedBugId,
        config: appConfig,
      }),
    )
      .then((result) => result || null)
      .catch((error) => {
        if (isNotionAuthenticationError(error)) {
          notionDisabled = true;
          return null;
        }

        return {
          bugId: normalizedBugId,
          error: String(error?.message || error),
        };
      })
      .then((result) => {
        notionStoryCache.set(normalizedBugId, {
          checkedAt: Date.now(),
          result,
        });

        return result;
      })
      .finally(() => {
        notionStoryInflight.delete(normalizedBugId);
      });

    notionStoryInflight.set(normalizedBugId, promise);
    return promise;
  }

  async function loadStoredDashboardCache() {
    if (dashboardCacheLoaded) {
      return;
    }

    if (!dashboardCacheLoadPromise) {
      dashboardCacheLoadPromise = Promise.resolve(loadDashboardCache({
        username: appConfig?.phabricator?.user,
      })).then((cached) => {
        if (cached) {
          dashboardCache = cached;
        }
      }).finally(() => {
        dashboardCacheLoaded = true;
      });
    }

    await dashboardCacheLoadPromise;
  }

  async function getServerDashboard({ force = false } = {}) {
    await loadStoredDashboardCache();
    const now = Date.now();

    if (dashboardInflight) {
      return dashboardInflight;
    }

    if (dashboardCooldownUntil > now) {
      const retryAfterMs = dashboardCooldownUntil - now;

      if (dashboardCache) {
        return {
          ...dashboardCache.result,
          warning: `Phabricator is rate limited; showing cached dashboard data. Try again in ${formatDurationLabel(retryAfterMs)}.`,
        };
      }

      const error = new Error(
        `Phabricator is temporarily rate limited. Try again in ${formatDurationLabel(retryAfterMs)}.`,
      );

      error.statusCode = 429;
      error.retryAfterMs = retryAfterMs;
      throw error;
    }

    if (
      !force &&
      dashboardCache &&
      now - dashboardCache.checkedAt < DEFAULT_DASHBOARD_CACHE_MS
    ) {
      return dashboardCache.result;
    }

    const request = Promise.resolve(getDashboardData({
      appConfig,
      getDashboardRevisions: phabWebSession.getDashboardRevisions?.bind(phabWebSession),
      getBugzillaRevisions,
      getAssignedOpenBugs,
      getBugsByIds,
      getBugsWithAttachmentsByIds,
      getNeedinfoOpenBugs,
      phab,
      bypassCache: force,
    }))
      .then(async (result) => {
        dashboardCache = { checkedAt: Date.now(), result };
        await saveDashboardCache({
          result,
          username: appConfig?.phabricator?.user,
        });
        dashboardCooldownUntil = 0;

        return result;
      })
      .catch((error) => {
        if (!isPhabricatorRateLimitError(error)) {
          throw error;
        }

        const cooldownMs = Math.max(
          Number(error.retryAfterMs) || 0,
          DASHBOARD_RATE_LIMIT_COOLDOWN_MS,
        );

        dashboardCooldownUntil = Date.now() + cooldownMs;

        if (dashboardCache) {
          return {
            ...dashboardCache.result,
            warning: `Phabricator is rate limited; showing cached dashboard data. Try again in ${formatDurationLabel(cooldownMs)}.`,
          };
        }

        throw error;
      })
      .finally(() => {
        if (dashboardInflight === request) {
          dashboardInflight = undefined;
        }
      });

    dashboardInflight = request;
    return request;
  }

  async function getStoredMetaBoard(boardId) {
    const store = await readMetaBoardStore();
    const board = store.boards.find((item) => item.id === String(boardId));

    if (!board) {
      const error = new Error("Unknown meta bug board.");

      error.statusCode = 404;
      throw error;
    }

    return board;
  }

  async function getStoredMetaBoards(store) {
    const savedBoards = store?.boards || (await readMetaBoardStore()).boards;

    if (!savedBoards.length) {
      return savedBoards;
    }

    try {
      const bugs = await getBugsByIds(
        savedBoards.map((board) => board.metaBugId),
        { includeFields: "id,summary" },
      );
      const summariesById = new Map((bugs || []).map((bug) => [
        String(bug.id),
        bug.summary || "",
      ]));

      return savedBoards.map((board) => ({
        ...board,
        summary: summariesById.get(board.metaBugId) || "",
      }));
    } catch {
      return savedBoards;
    }
  }

  function getAssignedMetaBoardColors(metaBugIds) {
    const assignment = metaBoardColorAssignment.then(() => (
      assignMetaBoardColors({ metaBugIds })
    ));

    metaBoardColorAssignment = assignment.catch(() => undefined);
    return assignment;
  }

  async function getServerMetaBoard(board, { force = false } = {}) {
    const cached = metaBoardCache.get(board.id);

    if (
      !force &&
      cached &&
      Date.now() - cached.checkedAt < DEFAULT_META_BOARD_CACHE_MS
    ) {
      return cached.result;
    }

    if (metaBoardInflight.has(board.id)) {
      return metaBoardInflight.get(board.id);
    }

    const request = Promise.resolve(getMetaBoardData({
      appConfig,
      getBugsByIds,
      getBugsWithAttachmentsByIds,
      metaBugId: board.metaBugId,
      phab,
    }))
      .then(async (result) => {
        const metaBugIds = (result.cards || []).map((card) => card.parentMeta?.id);
        const metaColors = metaBugIds.length
          ? await getAssignedMetaBoardColors(metaBugIds)
          : {};
        const decoratedResult = {
          ...result,
          metaColors,
          reviewGroup: board.reviewGroup ? { slug: board.reviewGroup } : null,
        };

        metaBoardCache.set(board.id, {
          checkedAt: Date.now(),
          result: decoratedResult,
        });
        return decoratedResult;
      })
      .finally(() => {
        metaBoardInflight.delete(board.id);
      });

    metaBoardInflight.set(board.id, request);
    return request;
  }

  async function getServerMetaBoardReviewGroupAssignees(board, { force = false } = {}) {
    if (!board.reviewGroup) {
      return { assignees: [] };
    }

    try {
      return {
        assignees: mergeMetaBoardAssignees(
          await getReviewGroupAssignees({ force, reviewGroup: board.reviewGroup, phab }),
        ),
      };
    } catch (error) {
      return {
        assignees: [],
        error: `Could not map #${board.reviewGroup} members to Bugzilla users: ${
          error.message || error
        }`,
      };
    }
  }

  async function getServerMetaBoardBugDetail(bugId) {
    return getMetaBoardBugDetail({
      appConfig,
      bugId,
      getBugComments,
      getBugsByIds,
      getNotionStoriesByBugId: getServerNotionStoriesByBugId,
    });
  }

  async function getServerSprintHistories(ids, { force = false } = {}) {
    const uniqueIds = Array.from(new Set(ids.map((id) => String(id || "").trim())
      .filter(Boolean))).sort();

    if (!uniqueIds.length) {
      return new Map();
    }

    const cacheKey = uniqueIds.join(",");

    if (sprintHistoryInflight.has(cacheKey)) {
      return sprintHistoryInflight.get(cacheKey);
    }

    const request = (async () => {
      const now = Date.now();
      const histories = new Map();
      const missingIds = [];

      for (const id of uniqueIds) {
        const cached = sprintHistoryCache.get(id);

        if (!force && cached && now - cached.checkedAt < DEFAULT_SPRINT_HISTORY_CACHE_MS) {
          histories.set(id, cached.history);
        } else {
          missingIds.push(id);
        }
      }

      if (missingIds.length) {
        const fetchedHistories = await getBugHistoryByIds(missingIds);
        const fetchedById = new Map();

        for (const history of fetchedHistories || []) {
          const id = String(history?.id || "").trim();

          if (!id) {
            continue;
          }

          fetchedById.set(id, history);
        }

        for (const id of missingIds) {
          const history = fetchedById.get(id) || { history: [], id };

          sprintHistoryCache.set(id, {
            checkedAt: now,
            history,
          });
          histories.set(id, history);
        }
      }

      return histories;
    })().finally(() => {
      sprintHistoryInflight.delete(cacheKey);
    });

    sprintHistoryInflight.set(cacheKey, request);
    return request;
  }

  async function getServerSprint(board, sprintId, { force = false } = {}) {
    const metaBoard = await getServerMetaBoard(board, { force });
    const baseSprint = getSprintData({
      board: metaBoard,
      sprintId,
    });

    if (!baseSprint.cards.length) {
      return baseSprint;
    }

    let historyByBugId = new Map();

    try {
      historyByBugId = await getServerSprintHistories([
        baseSprint.id,
        ...baseSprint.cards.map((card) => card.id),
      ], { force });
    } catch {
      // The planning view remains useful while Bugzilla history is unavailable.
    }

    const patchProgressDates = new Map();
    const patchCompletionDates = await getSprintPatchCompletionDates({ cards: baseSprint.cards, phab, patchProgressDates });
    return getSprintData({
      board: metaBoard,
      historyByBugId,
      patchCompletionDates,
      patchProgressDates,
      sprintId,
    });
  }

  function clearMetaBoardCache(boardId) {
    metaBoardCache.delete(boardId);
    sprintHistoryCache.clear();
  }

  const server = serverFactory(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/api/ai/browser/phabricator") {
        validateToken(request.headers["x-tb-console-token"], token);
        const revision = url.searchParams.get("revision");
        if (!/^D\d+$/.test(revision || "")) throw Object.assign(new Error("A valid Phabricator revision is required."), { statusCode: 400 });
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        const review = await phabWebSession.getReview({ revision, signal: controller.signal, includeRawPatch: false });
        sendJson(response, 200, { review });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/background-jobs/dismiss") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        // Save the dismissal even if only a stale browser still knows this task.
        taskDismissals.dismiss(body.kind, body.id);
        const sessions = body.kind === "review" ? patchReviewSessions : body.kind === "update" ? patchUpdateSessions : null;
        const session = sessions?.get(body.id);
        if (session) {
          session.dismissed = true;
          patchSessionStore.save(body.kind, session);
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      const trayTaskMatch = url.pathname.match(/^\/api\/(review|patch-update|implement|submit|rebase)\/([^/]+)$/);
      if (request.method === "GET" && trayTaskMatch) {
        const kind = trayTaskMatch[1] === "patch-update" ? "update" : trayTaskMatch[1];
        const id = decodeURIComponent(trayTaskMatch[2]);
        if (taskDismissals.has(kind, id)) {
          validateToken(url.searchParams.get("token"), token);
          sendJson(response, 200, { ok: true, id, dismissed: true });
          return;
        }
      }
      const cancelMach = /^\/api\/mach-action\/[^/]+\/cancel$/.test(url.pathname);
      if (request.method === "POST" &&
          (dashboardPatchActionRunning || trySessions.get(dashboardTrySessionId)?.status === "running") &&
          /^\/api\/(?:patch-update|checkout|commit-action|try|submit|update-graphs|mach|lint|test)(?:\/|$)/.test(url.pathname)) {
        throw Object.assign(new Error("Wait for the dashboard patch action to finish."), { statusCode: 409 });
      }


      if (!taskWorktrees && request.method === "POST" && !cancelMach && isGraphAiEnabled(appConfig) && (implementation?.ownsCheckout ? implementation.ownsCheckout() : implementation?.active()) &&
          !url.pathname.startsWith("/api/implement/") &&
          /^\/api\/(?:patch-update|checkout|commit-action|try|submit|update-graphs|mach|lint|test|dashboard\/patch-action|new-patch|checkout-transfer|interactive-rebase|rebase|commit|unshelf-graphs|mach-action|patch|land|amend-current|amend-message|amend-try-fixup)(?:\/|$)/.test(url.pathname)) {
        throw Object.assign(new Error("Implement owns the working checkout. Finish or cancel it before starting another action."), { statusCode: 409 });
      }
      if (request.method === "POST" && !cancelMach && [...submitSessions.values()].some(session => !session.managedWorktree && ["running", "prompt"].includes(session.status)) &&
          (/^\/api\/submit$/.test(url.pathname) || /^\/api\/(?:patch-update|checkout|checkout-transfer|commit-action|try|update-graphs|mach-action|lint|test|new-patch|interactive-rebase|rebase|commit|unshelf-graphs|patch|land|amend-current|amend-message|amend-try-fixup|dashboard\/patch-action)(?:\/|$)/.test(url.pathname))) {
        throw Object.assign(new Error("Submit is still using the working checkout. Wait for it to finish before changing that checkout."), { statusCode: 409 });
      }
      const workingAi = [...patchUpdateSessions.values()].filter(session => !session.managedWorktree).find(session => session.freeformOperationRunning ||
        ["preparing", "reviewing", "applying", "amending"].includes(session.status));
      if (workingAi && request.method === "POST" && !cancelMach &&
          /^\/api\/(?:checkout|checkout-transfer|commit-action|try|submit|update-graphs|mach-action|lint|test|new-patch|interactive-rebase|rebase|commit|unshelf-graphs|patch|land|amend-current|amend-message|amend-try-fixup)(?:\/|$)/.test(url.pathname)) {
        throw Object.assign(new Error("An AI task owns the working checkout. Wait for it to finish."), { statusCode: 409 });
      }
      const implementDiffMatch = url.pathname.match(/^\/api\/implement\/([^/]+)\/diff$/);
      if (implementDiffMatch && request.method === "GET") {
        validateToken(url.searchParams.get("token"), token);
        if (!implementation) throw Object.assign(new Error("Implement is unavailable."), { statusCode: 404 });
        sendJson(response, 200, { ok: true, ...await implementation.diff(decodeURIComponent(implementDiffMatch[1])) });
        return;
      }
      if (url.pathname === "/api/knowledge/gap-answer-review" && request.method === "POST") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const knowledge = await getKnowledgeService();
        if (!knowledge?.reviewGapAnswer) throw Object.assign(new Error("Knowledge review is unavailable."), { statusCode: 503 });
        const result = knowledge.reviewGapAnswer(body.key, body.review);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (url.pathname === "/api/background-jobs" && request.method === "GET") {
        validateToken(url.searchParams.get("token"), token);
        await reconcileSavedRebases();
        const jobs = [];
        for (const [kind, sessions] of [["Update", patchUpdateSessions], ["Review", patchReviewSessions],
          ["Submit", submitSessions], ["Build", machSessions], ["Lint", lintSessions], ["Test", testSessions],
          ["Try submission", trySessions], ["Rebase", rebaseSessions], ["Landing", landSessions],
          ["New patch", newPatchSessions], ["Patch", patchSessions]]) {
          for (const session of sessions.values()) jobs.push(summarizeBackgroundJob(kind, session));
        }
        for (const session of implementation?.list() || []) jobs.push(summarizeBackgroundJob("Implement", session));
        const paths = new Set(serverGraphs.map(graph => graph.path));
        for (const session of backgroundTryStore.list()) {
          if (paths.has(session.path) || taskWorktrees && paths.has(session.repositoryPath)) jobs.push(summarizeBackgroundJob("Try repair", session));
        }
        const knowledgeStatus = await getKnowledgeStatus();
        if (knowledgeStatus?.enabled) {
          const latest = knowledgeStatus.latest;
          const evaluation = knowledgeStatus.evaluations;
          const knowledgeRunning = knowledgeStatus.initializing || knowledgeStatus.running || evaluation?.running;
          jobs.push({ id: "Knowledge:query-gaps", kind: "Knowledge", title: "Knowledge gap checks",
            state: knowledgeRunning ? "running" : "waiting",
            phase: knowledgeStatus.initializing ? "loading" : knowledgeStatus.error ? "unavailable" : evaluation?.running ? "evaluating" : knowledgeStatus.running ? "checking" : knowledgeStatus.budgetReached ? "waiting-for-budget" : "scheduled",
            aiRunning: Boolean(knowledgeStatus.running || evaluation?.aiRunning),
            detail: knowledgeStatus.initializing ? "Loading the knowledge index. Saved jobs remain available." : knowledgeStatus.error || `${knowledgeStatus.pending} queries awaiting checks. ${knowledgeStatus.work.length} confirmed gaps awaiting evaluation. ${evaluation?.answerReviews || 0} answers awaiting review.`
              + (latest ? ` Latest result: ${latest.state}. ${latest.explanation}` : ""),
            nextCheckAt: knowledgeStatus.nextAt, updatedAt: latest?.at,
            knowledgeChecks: knowledgeStatus.checks, knowledgeWork: knowledgeStatus.work, knowledgeEvaluations: evaluation?.reports || [],
          });
        }
        sendJson(response, 200, { ok: true, aiEnabled: isGraphAiEnabled(appConfig),
          tryAiPaused: backgroundTryStore.isAutomationPaused(),
          dismissedTasks: taskDismissals.list(),
          jobs: jobs.filter(job => job && !taskDismissals.has(job.kind.toLowerCase(), job.id.slice(job.kind.length + 1))) });
        return;
      }
      const implementTaskMatch = url.pathname.match(/^\/api\/implement\/([^/]+)$/);
      if (implementTaskMatch && request.method === "GET") {
        validateToken(url.searchParams.get("token"), token);
        const task = implementation?.list().find(item => item.id === decodeURIComponent(implementTaskMatch[1]));
        if (!task) throw Object.assign(new Error("Unknown Implement task."), { statusCode: 404 });
        sendJson(response, 200, { ok: true, ...task });
        return;
      }
      if (url.pathname === "/api/implement" && request.method === "GET") {
        validateToken(url.searchParams.get("token"), token);
        const working = resolveGraphPatchUpdateWorkingCheckout({ graphs: serverGraphs });
        const head = await runCommand({ cmd: "git", args: ["rev-parse", "HEAD"], cwd: working.graph.path, capture: true, silent: true });
        sendJson(response, 200, { ok: true, currentHash: String(head).trim(), runs: implementation?.list() || [] });
        return;
      }
      if (request.method === "POST" && /^\/api\/implement(?:\/[^/]+\/(?:retry|cancel|feedback))?$/.test(url.pathname)) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        if (!isGraphAiEnabled(appConfig) || !implementation) throw Object.assign(new Error("Enable AI to use Implement."), { statusCode: 403 });
        const action = url.pathname.match(/^\/api\/implement\/([^/]+)\/(retry|cancel|feedback)$/);
        if (!action && (dashboardPatchActionRunning ||
            [trySessions, submitSessions, lintSessions, testSessions, newPatchSessions, patchSessions, landSessions].some(sessions => [...sessions.values()].some(session => !["complete", "error", "cancelled"].includes(session.status))) ||
            [...patchUpdateSessions.values()].some(session => session.freeformOperationRunning || ["preparing", "reviewing", "applying", "amending"].includes(session.status)))) {
          throw Object.assign(new Error("Wait for the active checkout operation to finish."), { statusCode: 409 });
        }
        const state = action ? await implementation[action[2]](decodeURIComponent(action[1]), body) : await implementation.create(body);
        sendJson(response, 200, { ok: true, run: state });
        return;
      }

      if (request.method === "GET" && url.pathname === "/launch") {
        // Like the main page, the launcher only opens the console. A URL from
        // an earlier process must still work after the server restarts.
        // API requests continue to require the current process token.
        noteBrowserActivity();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(launcherHtml || html);
        return;
      }

      if (
        request.method === "GET" &&
        ["/", "/index.html"].includes(url.pathname)
      ) {
        noteBrowserActivity();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }

      const brandingAssets = {
        "/favicon.ico": ["favicon-v3.ico", "image/x-icon"],
        "/assets/branding/app-icon.png": ["thunderbird-development-dashboard-app-icon-v2.png", "image/png"],
        "/assets/branding/logo-light.png": ["thunderbird-development-dashboard-horizontal-mono-light-v7.png", "image/png"],
        "/assets/branding/logo-dark.png": ["thunderbird-development-dashboard-horizontal-mono-dark-v7.png", "image/png"],
      };
      const brandingAsset = brandingAssets[url.pathname];
      if (request.method === "GET" && brandingAsset) {
        const [filename, contentType] = brandingAsset;
        const content = await readFile(new URL(`../../assets/branding/${filename}`, import.meta.url));
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        response.end(content);
        return;
      }

      const clientScript = GRAPH_CLIENT_SCRIPTS.find(
        (script) => url.pathname === `/assets/${script.output}`,
      );
      if (request.method === "GET" && clientScript) {
        noteBrowserActivity();
        sendText(
          response,
          200,
          await readFile(getGraphClientScriptPath(clientScript), "utf8"),
          "application/javascript; charset=utf-8",
        );
        return;
      }

      const clientStylesheet = GRAPH_CLIENT_STYLESHEETS.find(
        (stylesheet) => url.pathname === `/assets/${stylesheet.output}`,
      );
      if (request.method === "GET" && clientStylesheet) {
        noteBrowserActivity();
        sendText(
          response,
          200,
          await readFile(
            getGraphClientStylesheetPath(clientStylesheet),
            "utf8",
          ),
          "text/css; charset=utf-8",
        );
        return;
      }

      if (url.pathname === "/api/dashboard/review-handled" && ["GET", "POST"].includes(request.method)) {
        const body = request.method === "POST" ? await readRequestJson(request) : null;
        validateToken(body ? body.token : url.searchParams.get("token"), token);
        noteBrowserActivity();
        const handledReviews = body
          ? await reviewHandled.set(body.revision, body.handled, { title: body.title })
          : await reviewHandled.list();
        if (body?.handled) {
          for (const session of patchReviewSessions.values()) {
            if (session.revision !== String(body.revision).toUpperCase()) continue;
            cancelGraphPatchReviewSession({ session });
            session.status = "complete";
          }
          await cleanupFinishedWorktrees();
        }
        sendJson(response, 200, { ok: true, handledReviews });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const dashboard = await getServerDashboard({
          force: url.searchParams.get("force") === "1",
        });

        sendJson(response, 200, { ok: true, ...applyHandledReviews(dashboard, await reviewHandled.list()) });
        return;
      }

      if (["GET", "POST"].includes(request.method) && url.pathname === "/api/service-credentials") {
        const body = request.method === "POST" ? await readRequestJson(request) : null;
        validateToken(body ? body.token : url.searchParams.get("token"), token);
        noteBrowserActivity();
        if (body) serviceCredentials.saveCredentials(serviceCredentialsPath, body.credentials);
        sendJson(response, 200, { ok: true, credentials: serviceCredentials.credentialStatus(serviceCredentialsPath),
          restartRequired: Boolean(body) });
        return;
      }

      if (["GET", "POST"].includes(request.method) && url.pathname === "/api/ai-settings") {
        const body = request.method === "POST" ? await readRequestJson(request) : null;
        validateToken(body ? body.token : url.searchParams.get("token"), token);
        noteBrowserActivity();
        const models = (await getSettingsModels()).filter(model => !model.hidden);
        const profiles = body ? saveAiProfiles(body.profiles, models, aiSettingsPath) : readAiProfiles(aiSettingsPath);
        sendJson(response, 200, { ok: true, tasks: AI_TASK_TYPES, profiles, models });
        return;
      }

      if (["GET", "POST"].includes(request.method) && url.pathname === "/api/daily-build") {
        const body = request.method === "POST" ? await readRequestJson(request) : null;
        validateToken(body ? body.token : url.searchParams.get("token"), token);
        if (!dailyBuild) throw Object.assign(new Error("Daily build needs the desktop app."), { statusCode: 404 });
        if (body?.action === "save") await dailyBuild.saveSettings(body.settings);
        else if (body?.action === "run") await dailyBuild.runNow();
        else if (body?.action === "cancel") dailyBuild.cancel();
        else if (body && body.action) throw Object.assign(new Error("Unknown daily build action."), { statusCode: 400 });
        sendJson(response, 200, { ok: true, ...dailyBuild.status() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/daily-build/log") {
        validateToken(url.searchParams.get("token"), token);
        if (!dailyBuild) throw Object.assign(new Error("Daily build needs the desktop app."), { statusCode: 404 });
        sendJson(response, 200, { ok: true, output: await dailyBuild.readLog() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/phabricator-cache") {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const [cache, dashboard, dashboardTimelines] = await Promise.all([
          getPhabricatorCacheStatus(),
          getDashboardCacheStatus(),
          getDashboardTimelineCacheStatus(),
        ]);

        sendJson(response, 200, { ok: true, cache, dashboard, dashboardTimelines });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/phabricator-cache") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const category = String(body.category || "all");
        if (category === "all" || category === "identities") {
          await clearReviewerGroupCache();
        }
        const clearsDashboardTimelines = new Set([
          "all",
          "dashboard-timelines",
        ]).has(category);
        const clearsDashboard = new Set([
          "all",
          "identities",
          "dashboard",
          "dashboard-timelines",
          "revision-history",
          "revision-status",
        ]).has(category);
        const clearsPhabricatorCache = !new Set([
          "dashboard",
          "dashboard-timelines",
        ]).has(category);
        const [cache, dashboard, dashboardTimelines] = await Promise.all([
          clearsPhabricatorCache
            ? clearPhabricatorCache({ category })
            : getPhabricatorCacheStatus(),
          clearsDashboard
            ? clearDashboardCache({ username: appConfig?.phabricator?.user })
            : getDashboardCacheStatus(),
          clearsDashboardTimelines
            ? clearDashboardTimelineCache()
            : getDashboardTimelineCacheStatus(),
        ]);

        if (clearsDashboard) {
          commitIntegrationCache.clear();
          dashboardCache = undefined;
          dashboardCacheLoaded = true;
          metaBoardCache.clear();
        }

        sendJson(response, 200, { ok: true, cache, dashboard, dashboardTimelines });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/dashboard/patch-action") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const activeCommand = [trySessions, submitSessions, lintSessions].some(sessions =>
          [...sessions.values()].some(session => session.status === "running"));
        const activePatch = [...patchUpdateSessions.values()].some(session =>
          session.freeformOperationRunning || ["preparing", "reviewing", "applying", "amending"].includes(session.status));
        if (!taskManager && (dashboardPatchActionRunning || activeCommand || activePatch)) {
          throw Object.assign(new Error("Wait for the active checkout operation to finish."), { statusCode: 409 });
        }
        dashboardPatchActionRunning = true;
        let actionWorkspace;
        try {
          let actionGraphs = serverGraphs;
          if (taskManager) {
            const found = await findGraphPatchCommit({ graph: taskManager.sourceGraph, revision: body.revision, runCommand });
            const workspace = taskManager.configure({ id: randomUUID() }, body.action);
            actionWorkspace = workspace;
            await taskManager.prepare(workspace, { commRevision: found.hash, cloneBranches: true });
            actionGraphs = taskManager.taskGraphs(workspace);
          }
          const { graph, graphIndex: actionGraphIndex, result } = await prepareDashboardPatchAction({
            graphs: actionGraphs, revision: body.revision, action: body.action, runCommand,
          });
          const graphIndex = taskManager ? serverGraphs.indexOf(taskManager.sourceGraph) : actionGraphIndex;
          if (body.action === "ci-verify") {
            const session = createGraphTrySession({ graph, graphIndex,
              snapshotLimit: getRequestLimit(body.snapshotLimit), getSnapshot: getServerGraphSnapshot,
              options: { selector: "auto", artifact: true, comment: false }, runCommand, postComment });
            trySessions.set(session.id, session);
            dashboardTrySessionId = session.id;
            sendJson(response, 200, { ok: true, ...serializeGraphTrySession(session) });
          } else {
            const snapshot = await getServerGraphSnapshot(graph, getRequestLimit(body.snapshotLimit));
            sendJson(response, 200, { ok: true, ...result, graphIndex, snapshot });
          }
        } finally {
          dashboardPatchActionRunning = false;
          if (actionWorkspace && body.action !== "ci-verify") await taskManager.cleanup(actionWorkspace);
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch-update") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        if (body.checkoutMode !== undefined && !["main", "worktree"].includes(body.checkoutMode)) {
          throw Object.assign(new Error("Choose Main checkout or New worktree."), { statusCode: 400 });
        }
        const useWorktree = body.checkoutMode === "worktree" || body.checkoutMode !== "main" && taskWorktrees;
        const requestedGraphIndex = Number(body.graphIndex);
        const requestedGraph = serverGraphs[requestedGraphIndex];

        if (!requestedGraph) {
          const error = new Error("Unknown graph checkout.");

          error.statusCode = 404;
          throw error;
        }

        // The repository graph stays fixed. A managed task gets its own checkout.
        const workingCheckout = resolveGraphPatchUpdateWorkingCheckout({
          graphs: serverGraphs,
        });

        const active = [...patchUpdateSessions.values()].find((entry) =>
          (!useWorktree ? !entry.restored && entry.graph.path === workingCheckout.graph.path :
            !entry.restored && body.resume !== false && entry.revision.toUpperCase() === String(body.revision || "").trim().toUpperCase().replace(/^(\d+)$/, "D$1") &&
            (entry.mode || "update") === (["verify", "freeform"].includes(body.mode) ? body.mode : "update")) &&
          Boolean(entry.managedWorktree) === useWorktree &&
          (entry.freeformOperationRunning || ["preparing", "reviewing", "applying", "amending"].includes(entry.status)));
        if (active) {
          if (active.revision.toUpperCase() === String(body.revision || "").trim().toUpperCase().replace(/^(\d+)$/, "D$1") &&
              (active.mode || "update") === (["verify", "freeform"].includes(body.mode) ? body.mode : "update") && body.resume !== false) {
            sendJson(response, 200, { ok: true, ...serializeGraphPatchUpdateSession(active) });
            return;
          }
          const error = new Error("Wait for the active patch operation in the working checkout to finish.");
          error.statusCode = 409;
          throw error;
        }

        const session = createGraphPatchUpdateSession({
          graph: workingCheckout.graph,
          graphIndex: workingCheckout.graphIndex,
          revision: body.revision,
          mode: ["verify", "freeform"].includes(body.mode) ? body.mode : "update",
          aiEnabled: isGraphAiEnabled(appConfig),
          codexCommand: appConfig?.ai?.command,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
        });

        if (useWorktree) getUpdateTaskManager().configure(session, session.mode);
        if (await restorePatchSession("update", session, body, response)) return;

        patchUpdateSessions.set(session.id, session);
        startPatchUpdatePreparation(session, getRequestLimit(body.snapshotLimit));
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchUpdateSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/review") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const session = createGraphPatchReviewSession({
          graphs: taskWorktrees ? serverGraphs.map(graph => ({ ...graph, taskWorktree: true })) : serverGraphs,
          revision: body.revision,
          aiEnabled: isGraphAiEnabled(appConfig),
          codexCommand: appConfig?.ai?.command,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
        });
        configureManagedReviewSession(session);

        const activeReview = [...patchReviewSessions.values()].find(entry =>
          (!entry.restored && (entry.graph.path === session.graph.path || taskWorktrees && body.resume !== false && entry.revision === session.revision)) && ["pulling", "reviewing", "posting"].includes(entry.status));
        if (activeReview) {
          if (activeReview.revision === session.revision && body.resume !== false) {
            sendJson(response, 200, { ok: true, ...serializeGraphPatchReviewSession(activeReview) });
            return;
          }
          throw Object.assign(new Error("A review is still using this checkout. Minimize it to use the console while it finishes."), { statusCode: 409 });
        }

        if (await restorePatchSession("review", session, body, response)) return;

        patchReviewSessions.set(session.id, session);
        void prepareTrackedReview({
          session,
          prepareCheckout: prepareManagedReviewCheckout,
          ...(taskWorktrees && prepareTaskBuild ? { prepareBuild: taskManager.prepareBuild } : {}),
          getSnapshot: getServerGraphSnapshot,
          getReview: ({ graph, hash }) => getServerCommitReview(graph, hash),
          getRevisionReview: phabWebSession.getReview?.bind(phabWebSession),
          runCommand,
        }).catch(() => {}).finally(savePatchSessions);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchReviewSession(session),
        });
        return;
      }

      const patchReviewContextMatch = url.pathname.match(/^\/api\/review\/([^/]+)\/context$/);
      if (request.method === "GET" && patchReviewContextMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = patchReviewSessions.get(
          decodeURIComponent(patchReviewContextMatch[1]),
        );

        if (!session) {
          const error = new Error("Unknown patch review session.");

          error.statusCode = 404;
          throw error;
        }

        sendJson(response, 200, {
          ok: true,
          ...getGraphPatchReviewContext(session),
        });
        return;
      }

      const patchReviewStatusMatch = url.pathname.match(/^\/api\/review\/([^/]+)$/);
      if (request.method === "GET" && patchReviewStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = patchReviewSessions.get(
          decodeURIComponent(patchReviewStatusMatch[1]),
        );

        if (!session) {
          const error = new Error("Unknown patch review session.");

          error.statusCode = 404;
          throw error;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchReviewSession(session),
        });
        return;
      }

      const patchReviewActionMatch = url.pathname.match(
        /^\/api\/review\/([^/]+)\/(apply|inline|skip|submit|steer|cancel|feedback|resolve-conflicts|apply-single|request-rebase)$/,
      );
      if (request.method === "POST" && patchReviewActionMatch) {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const session = patchReviewSessions.get(
          decodeURIComponent(patchReviewActionMatch[1]),
        );

        if (!session) {
          const error = new Error("Unknown patch review session.");

          error.statusCode = 404;
          throw error;
        }

        const [, , action] = patchReviewActionMatch;
        let reviewStatusChange;

        if (action === "apply" && ["pulling", "reviewing", "posting"].includes(session.status)) {
          throw Object.assign(new Error("Wait for the review agent before applying a source suggestion."), { statusCode: 409 });
        }
        if (["apply", "steer"].includes(action)) {
          const other = [...patchReviewSessions.values()].find(entry => entry.id !== session.id &&
            entry.graph.path === session.graph.path && ["pulling", "reviewing", "posting"].includes(entry.status));
          if (other) throw Object.assign(new Error("Wait for the other review in this checkout to finish."), { statusCode: 409 });
          await assertPatchSessionCheckout(session, runCommand);
        }

        if (["resolve-conflicts", "apply-single", "request-rebase"].includes(action)) {
          if (!session.applyConflict || session.status !== "paused" || preparingReviews.has(session.id)) {
            throw Object.assign(new Error("No patch apply conflict is waiting for a choice."), { statusCode: 409 });
          }
          if (action === "request-rebase") {
            if ([...rebaseSessions.values()].some(entry => entry.patchReviewSessionId === session.id && (entry.resolutionBusy || entry.continueBusy))) {
              throw Object.assign(new Error("Wait for conflict resolution to finish before posting the rebase request."), { statusCode: 409 });
            }
            await submitGraphPatchReview({ session, outcome: "comment", message: body.message,
              publishReview: phabWebSession.publishRevisionReview?.bind(phabWebSession) });
            for (const entry of rebaseSessions.values()) {
              if (entry.patchReviewSessionId === session.id) {
                rebaseStore.remove(entry.id);
                rebaseSessions.delete(entry.id);
              }
            }
          } else if (action === "apply-single") {
            if (session.rebaseConflict) {
              throw Object.assign(new Error("Finish the current conflict resolution before trying only this patch."), { statusCode: 409 });
            }
            let imported = false;
            preparingReviews.add(session.id);
            try {
              await importGraphPatchReviewSinglePatch({ session, runCommand });
              imported = true;
            } catch (error) {
              if (!error.rebaseState) throw error;
              const payload = {};
              attachRebaseConflict(payload, error);
              session.rebaseConflict = payload.rebaseConflict;
              session.error = "Resolve this patch's conflicts, then continue the review.";
            } finally {
              preparingReviews.delete(session.id);
            }
            if (imported) continuePreparedReview(session);
          } else {
            if (session.rebaseConflict) {
              sendJson(response, 200, { ok: true, ...serializeGraphPatchReviewSession(session) });
              return;
            }
            const command = args => runCommand({ cmd: "git", args, cwd: session.graph.path, capture: true, silent: true });
            const findImportedHash = async () => {
              const records = String(await command(["log", "--format=%H%x00%B%x00", "origin/main..HEAD"])).split("\0");
              for (let index = 0; index + 1 < records.length; index += 2) {
                if (records[index + 1].match(/Differential Revision:\s*https?:\/\/[^/\s]+\/(D\d+)\b/)?.[1] === session.revision) return records[index].trim();
              }
            };
            let hash = await findImportedHash();
            try {
              if (!hash) {
                if (phabWebSession.getReview) await refreshGraphPatchReviewContext({ session,
                  getRevisionReview: phabWebSession.getReview.bind(phabWebSession) });
                await importGraphPatchReviewConflictStack({ session, runCommand });
                hash = await findImportedHash();
              }
              if (!hash) throw Object.assign(new Error("Could not import the requested patch stack for conflict resolution. Ask the author to rebase."), { statusCode: 409 });
              const branch = `${session.graph.branchNamespace || "tb-review/"}conflict`;
              await command(["branch", "-f", branch, hash]);
              await command(["switch", "--detach", session.reviewMainHash]);
              await rebaseCommit({ graph: session.graph, graphIndex: session.graphIndex, hash,
                preferredBranch: branch, rebaseMode: "stack", includeSelectedAncestors: true,
                requireLoaded: false, runCommand });
              continuePreparedReview(session);
            } catch (error) {
              if (!error.rebaseState) throw error;
              error.rebaseState.patchReviewSessionId = session.id;
              const payload = {};
              attachRebaseConflict(payload, error);
              session.rebaseConflict = payload.rebaseConflict;
              session.error = "Resolve the patch conflicts, then continue the review.";
            }
          }
        } else if (action === "feedback") {
          rateGraphPatchReviewFinding({ session, itemId: body.itemId, rating: body.rating, reason: body.reason });
        } else if (action === "cancel") {
          cancelGraphPatchReviewSession({ session });
        } else if (action === "apply") {
          await applyGraphPatchReviewSuggestion({
            session,
            itemId: body.itemId,
          });
        } else if (action === "inline") {
          await addGraphPatchReviewInline({
            session,
            itemId: body.itemId,
            anchor: body.anchor,
            kind: body.kind,
            message: body.message,
            codeSuggestion: body.codeSuggestion,
            createInlineComment: (options) => phabWebSession.createInlineComment({
              ...options,
              content: options.commentText,
              isNewFile: true,
            }),
          });
        } else if (action === "skip") {
          skipGraphPatchReviewIssue({ session, itemId: body.itemId });
        } else if (action === "steer") {
          await steerGraphPatchReviewSession({
            session,
            runCommand,
            instruction: body.instruction,
          });
        } else {
          await submitGraphPatchReview({
            session,
            outcome: body.outcome,
            message: body.message,
            postComment,
            publishReview: phabWebSession.publishRevisionReview?.bind(phabWebSession),
          });
          if (["accept", "request-changes"].includes(session.reviewOutcome)) {
            reviewStatusChange = { revision: session.revision,
              statusName: session.reviewOutcome === "accept" ? "Accepted" : "Needs Revision" };
            await loadStoredDashboardCache();
            await dashboardInflight?.catch(() => {});
            if (dashboardCache) {
              const result = { ...dashboardCache.result };
              for (const key of ["directlyAssignedWaitingOnReview", "groupWaitingForFirstReview"]) {
                result[key] = (result[key] || []).filter(patch => patch.id !== session.revision);
              }
              dashboardCache = { ...dashboardCache, result };
              await saveDashboardCache({ result, now: dashboardCache.checkedAt,
                username: appConfig?.phabricator?.user });
            }
          }
        }

        patchSessionStore.save("review", session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchReviewSession(session),
          ...(reviewStatusChange ? { reviewStatusChange } : {}),
        });
        return;
      }

      const patchUpdateStatusMatch = url.pathname.match(/^\/api\/patch-update\/([^/]+)$/);
      if (request.method === "GET" && patchUpdateStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = patchUpdateSessions.get(
          decodeURIComponent(patchUpdateStatusMatch[1]),
        );

        if (!session) {
          const error = new Error("Unknown patch update session.");

          error.statusCode = 404;
          throw error;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchUpdateSession(session),
        });
        return;
      }

      const patchUpdateActionMatch = url.pathname.match(
        /^\/api\/patch-update\/([^/]+)\/(cancel|amend|apply|keep|revert|handled|skip|comment|feedback|revise|steer|rollback)$/,
      );
      if (request.method === "POST" && patchUpdateActionMatch) {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const session = patchUpdateSessions.get(
          decodeURIComponent(patchUpdateActionMatch[1]),
        );

        if (!session) {
          const error = new Error("Unknown patch update session.");

          error.statusCode = 404;
          throw error;
        }

        if (patchUpdateActionMatch[2] === "cancel") {
          await cancelGraphPatchUpdateSession({ session });
          savePatchSessions();
          sendJson(response, 200, { ok: true, ...serializeGraphPatchUpdateSession(session) });
          return;
        }
        if (session.cancelled) throw Object.assign(new Error("This update was cancelled. Start a new update to continue."), { statusCode: 409 });

        const updateRunCommand = options => runCommand({ ...options,
          signal: session.abortController?.signal, killProcessGroup: true });
        const otherWriter = [...patchUpdateSessions.values()].find(entry => entry.id !== session.id &&
          entry.graph.path === session.graph.path && (entry.freeformOperationRunning ||
            ["preparing", "reviewing", "applying", "amending"].includes(entry.status)));
        if (otherWriter) throw Object.assign(new Error("Another AI task owns this checkout. Wait for it to finish."), { statusCode: 409 });
        const [, , action] = patchUpdateActionMatch;

        if (["verify", "freeform"].includes(session.mode) && action === "comment") {
          const error = new Error("This update does not post review comments.");
          error.statusCode = 409;
          throw error;
        }
        if (session.mode === "freeform" && (session.freeformOperationRunning || !["review", "complete"].includes(session.status))) {
          const error = new Error("Wait for the current Update operation to finish.");
          error.statusCode = 409;
          throw error;
        }
        if (action === "rollback") {
          await rollbackGraphPatchFreeformUpdate({ session, runCommand: updateRunCommand, saveMemory: savePatchUpdateMemory });
          session.snapshot = await getServerGraphSnapshot(session.graph, getRequestLimit(body.snapshotLimit));
        } else if (session.mode === "freeform" && action === "steer") {
          if (!String(body.instruction || "").trim()) throw new Error("Enter a question or update request.");
          void runGraphPatchFreeformUpdate({ session, instruction: body.instruction, runCommand,
            saveMemory: savePatchUpdateMemory }).catch(() => {}).finally(savePatchSessions);
        } else if (action === "amend") {
          await amendGraphPatchUpdateChanges({
            session,
            runCommand: updateRunCommand,
            saveMemory: savePatchUpdateMemory,
          });
          session.snapshot = await getServerGraphSnapshot(
            session.graph,
            getRequestLimit(body.snapshotLimit),
          );
        } else if (action === "steer") {
          await steerGraphPatchUpdateSession({
            session,
            runCommand: updateRunCommand,
            instruction: body.instruction,
          });
        } else if (action === "apply") {
          void applyGraphPatchUpdateComment({
            session,
            itemId: body.itemId,
            runCommand: updateRunCommand,
            saveMemory: savePatchUpdateMemory,
          }).catch(() => {});
        } else if (action === "keep") {
          await acceptPatchUpdateChange({
            session,
            itemId: body.itemId,
            runCommand: updateRunCommand,
            saveMemory: savePatchUpdateMemory,
          });
        } else if (action === "revert") {
          await revertGraphPatchUpdateChange({
            session,
            itemId: body.itemId,
            runCommand: updateRunCommand,
            saveMemory: savePatchUpdateMemory,
          });
        } else if (action === "feedback") {
          if (!session.aiEnabled) {
            const error = new Error("AI patch review is not enabled for this console.");

            error.statusCode = 403;
            throw error;
          }

          if (!String(body.instruction || "").trim()) {
            const error = new Error("Enter feedback or an instruction for Codex.");

            error.statusCode = 400;
            throw error;
          }

          void (async () => {
            await followUpGraphPatchUpdateComment({
              session,
              itemId: body.itemId,
              instruction: body.instruction,
              runCommand: updateRunCommand,
              saveMemory: savePatchUpdateMemory,
            });
          })().catch(() => {});
        } else if (action === "revise") {
          if (!String(body.instruction || "").trim()) {
            const error = new Error("Enter feedback or an instruction for Codex.");

            error.statusCode = 400;
            throw error;
          }

          void reviseGraphPatchUpdateChange({
            session,
            itemId: body.itemId,
            instruction: body.instruction,
            runCommand: updateRunCommand,
            saveMemory: savePatchUpdateMemory,
          }).catch(() => {});
        } else if (action === "handled") {
          await completePatchUpdateComment({
            itemId: body.itemId,
            session,
          });
        } else if (action === "skip") {
          await completePatchUpdateComment({
            event: "Review comment skipped",
            itemId: body.itemId,
            state: "skipped",
            session,
          });
        } else {
          if (!session.aiEnabled) {
            const error = new Error("AI patch review is not enabled for this console.");

            error.statusCode = 403;
            throw error;
          }

          const item = session.items.find((candidate) => (
            candidate.id === String(body.itemId)
          ));
          const message = String(body.message || "").trim();

          if (!item || !message) {
            const error = new Error("A review comment and reply are required.");

            error.statusCode = 400;
            throw error;
          }

          if (item.changeApplied && !item.changeAccepted && !item.changesAmended) {
            const error = new Error(
              "Keep or revert the prepared working-tree change before posting a reply.",
            );

            error.statusCode = 409;
            throw error;
          }

          if (item.type !== "inline" || !item.parentCommentPHID) {
            const error = new Error(
              "This is revision-level feedback, not an inline thread. " +
                "TB Tools will not post it as a detached reply.",
            );

            error.statusCode = 409;
            throw error;
          }

          const previousDraftReply = item.draftReply;
          const previousDraftSaved = item.draftSaved;
          let replyPosted = false;

          try {
            const receipt = await phabWebSession.postInlineReply({
              commentPHID: item.parentCommentPHID,
              message,
              revision: session.revision,
            });
            replyPosted = true;
            saveGraphPatchUpdateReply({
              session,
              itemId: item.id,
              message,
              receipt,
            });
            session.message = "Reply draft saved in Phabricator. Mark the reviewer comment done when you are ready.";
          } catch (error) {
            if (!replyPosted) {
              item.draftReply = previousDraftReply;
              item.draftSaved = previousDraftSaved;
            }
            throw error;
          }
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchUpdateSession(session),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/meta-boards") {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const boards = await getStoredMetaBoards();

        sendJson(response, 200, { ok: true, boards });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/meta-boards") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const metaBugId = String(body.metaBugId || "").trim();

        if (!/^\d{4,10}$/.test(metaBugId)) {
          const error = new Error("Enter a valid Bugzilla meta bug ID.");

          error.statusCode = 400;
          throw error;
        }

        const board = {
          id: metaBugId,
          metaBugId,
        };
        const data = await getServerMetaBoard(board, { force: true });
        const store = await addMetaBoard({ metaBugId: board.metaBugId });
        const boards = await getStoredMetaBoards(store);

        sendJson(response, 200, {
          ok: true,
          boards,
          board: data,
        });
        return;
      }

      const metaBoardSprintsMatch = url.pathname.match(
        /^\/api\/meta-boards\/([^/]+)\/sprints$/,
      );
      if (metaBoardSprintsMatch) {
        const board = await getStoredMetaBoard(
          decodeURIComponent(metaBoardSprintsMatch[1]),
        );

        if (request.method === "GET") {
          validateToken(url.searchParams.get("token"), token);
          noteBrowserActivity();
          const metaBoard = await getServerMetaBoard(board, {
            force: url.searchParams.get("force") === "1",
          });

          sendJson(response, 200, {
            ok: true,
            sprints: metaBoard.sprints || [],
          });
          return;
        }

        if (request.method === "POST") {
          const body = await readRequestJson(request);

          validateToken(body.token, token);
          noteBrowserActivity();
          const metaBoard = await getServerMetaBoard(board, { force: true });
          const sprintId = await createSprint({
            board: metaBoard,
            createBug,
            deadline: body.deadline,
            name: body.name,
          });

          clearMetaBoardCache(board.id);
          // Creation has succeeded. A follow-up read must not report it as failed.
          const createdSprint = normalizeSprintMeta({
            id: sprintId,
            summary: formatSprintSummary(body.name),
            deadline: body.deadline,
            creation_time: new Date().toISOString(),
            is_open: true,
            depends_on: [],
          });
          const sprint = getSprintData({
            board: { ...metaBoard, sprints: [...(metaBoard.sprints || []), createdSprint] },
            sprintId,
          });
          const previousSprint = (metaBoard.sprints || [])
            .filter((item) => item.id !== sprintId && item.isOpen)
            .sort((first, second) => (
              String(second.createdAt).localeCompare(String(first.createdAt)) ||
              Number(second.id) - Number(first.id)
            ))[0] || null;

          sendJson(response, 201, {
            ok: true,
            previousSprint,
            sprint,
          });
          return;
        }
      }

      const metaBoardSprintRolloverMatch = url.pathname.match(
        /^\/api\/meta-boards\/([^/]+)\/sprints\/(\d+)\/rollover$/,
      );
      if (metaBoardSprintRolloverMatch && request.method === "POST") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const board = await getStoredMetaBoard(
          decodeURIComponent(metaBoardSprintRolloverMatch[1]),
        );
        const nextSprintId = decodeURIComponent(metaBoardSprintRolloverMatch[2]);
        const metaBoard = await getServerMetaBoard(board, { force: true });
        await rolloverSprint({
          board: metaBoard,
          nextSprintId,
          previousSprintId: body.previousSprintId,
          removeStoryIds: body.removeStoryIds || [],
          storyIds: body.storyIds || [],
          updateBug,
        });
        clearMetaBoardCache(board.id);
        const sprint = await getServerSprint(board, nextSprintId, { force: true });

        sendJson(response, 200, { ok: true, sprint });
        return;
      }

      const metaBoardSprintStoryMatch = url.pathname.match(
        /^\/api\/meta-boards\/([^/]+)\/sprints\/(\d+)\/stories\/(\d+)$/,
      );
      if (metaBoardSprintStoryMatch && request.method === "PUT") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const board = await getStoredMetaBoard(
          decodeURIComponent(metaBoardSprintStoryMatch[1]),
        );
        const sprintId = decodeURIComponent(metaBoardSprintStoryMatch[2]);
        const storyId = decodeURIComponent(metaBoardSprintStoryMatch[3]);
        const metaBoard = await getServerMetaBoard(board, { force: true });
        await setSprintStoryMembership({
          board: metaBoard,
          member: Boolean(body.member),
          sprintId,
          storyId,
          updateBug,
        });
        clearMetaBoardCache(board.id);
        const sprint = await getServerSprint(board, sprintId, { force: true });

        sendJson(response, 200, { ok: true, sprint });
        return;
      }

      const metaBoardSprintMatch = url.pathname.match(
        /^\/api\/meta-boards\/([^/]+)\/sprints\/(\d+)$/,
      );
      if (metaBoardSprintMatch) {
        const board = await getStoredMetaBoard(
          decodeURIComponent(metaBoardSprintMatch[1]),
        );
        const sprintId = decodeURIComponent(metaBoardSprintMatch[2]);

        if (request.method === "GET") {
          validateToken(url.searchParams.get("token"), token);
          noteBrowserActivity();
          const sprint = await getServerSprint(board, sprintId, {
            force: url.searchParams.get("force") === "1",
          });

          sendJson(response, 200, { ok: true, sprint });
          return;
        }

        if (request.method === "PUT") {
          const body = await readRequestJson(request);

          validateToken(body.token, token);
          noteBrowserActivity();
          const metaBoard = await getServerMetaBoard(board, { force: true });
          const currentSprint = getSprintData({ board: metaBoard, sprintId });
          await updateSprint({
            changes: body.changes || {},
            sprint: currentSprint,
            updateBug,
          });
          clearMetaBoardCache(board.id);
          const sprint = await getServerSprint(board, sprintId, { force: true });

          sendJson(response, 200, { ok: true, sprint });
          return;
        }
      }

      const metaBoardBugMatch = url.pathname.match(
        /^\/api\/meta-boards\/([^/]+)\/bugs\/(\d+)$/,
      );
      const standaloneBugMatch = url.pathname.match(/^\/api\/bugs\/(\d+)$/);
      if (metaBoardBugMatch || standaloneBugMatch) {
        let requestBody;

        if (request.method === "GET") {
          validateToken(url.searchParams.get("token"), token);
        } else if (request.method === "PUT") {
          requestBody = await readRequestJson(request);

          validateToken(requestBody.token, token);
        }

        const board = metaBoardBugMatch ? await getStoredMetaBoard(decodeURIComponent(metaBoardBugMatch[1])) : null;
        const bugId = decodeURIComponent(metaBoardBugMatch?.[2] || standaloneBugMatch[1]);

        if (request.method === "GET") {
          noteBrowserActivity();
          const detail = await getServerMetaBoardBugDetail(bugId);

          sendJson(response, 200, { ok: true, ...detail });
          return;
        }

        if (request.method === "PUT") {
          noteBrowserActivity();
          await updateMetaBoardBug({
            appConfig,
            bugId,
            changes: requestBody.changes || {},
            updateBug,
          });
          if (board) metaBoardCache.delete(board.id);
          else metaBoardCache.clear();
          dashboardCache = undefined;
          const detail = await getServerMetaBoardBugDetail(bugId);

          sendJson(response, 200, { ok: true, ...detail });
          return;
        }
      }

      const metaBoardAssigneesMatch = url.pathname.match(
        /^\/api\/meta-boards\/([^/]+)\/review-group-assignees$/,
      );
      if (metaBoardAssigneesMatch && request.method === "GET") {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const board = await getStoredMetaBoard(
          decodeURIComponent(metaBoardAssigneesMatch[1]),
        );
        const result = await getServerMetaBoardReviewGroupAssignees(board, {
          force: url.searchParams.get("force") === "1",
        });

        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      const metaBoardMatch = url.pathname.match(/^\/api\/meta-boards\/([^/]+)$/);
      if (metaBoardMatch) {
        const boardId = decodeURIComponent(metaBoardMatch[1]);

        if (request.method === "DELETE") {
          const body = await readRequestJson(request);

          validateToken(body.token, token);
          noteBrowserActivity();
          const store = await removeMetaBoard({ boardId });
          const boards = await getStoredMetaBoards(store);

          metaBoardCache.delete(boardId);
          sendJson(response, 200, { ok: true, boards });
          return;
        }

        if (request.method === "PUT") {
          const body = await readRequestJson(request);

          validateToken(body.token, token);
          noteBrowserActivity();
          const store = await setMetaBoardReviewGroup({
            boardId,
            reviewGroup: body.reviewGroup,
          });
          const board = store.boards.find((item) => item.id === boardId);

          metaBoardCache.delete(boardId);
          const data = await getServerMetaBoard(board, { force: true });
          const boards = await getStoredMetaBoards(store);
          sendJson(response, 200, {
            ok: true,
            boards,
            board: data,
          });
          return;
        }

        if (request.method === "GET") {
          validateToken(url.searchParams.get("token"), token);
          noteBrowserActivity();
          const board = await getStoredMetaBoard(boardId);
          const data = await getServerMetaBoard(board, {
            force: url.searchParams.get("force") === "1",
          });

          sendJson(response, 200, { ok: true, ...data });
          return;
        }
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/origin-main-status"
      ) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const statuses = await getServerOriginMainStatuses({
          force: url.searchParams.get("force") === "1",
          waitForRust: url.searchParams.get("wait") === "1",
          checkout: url.searchParams.get("checkout") || "working",
        });

        sendJson(response, 200, { ok: true, statuses });
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/phabricator/auth"
      ) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        sendJson(response, 200, {
          ok: true,
          ...(await phabWebSession.getStatus()),
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/phabricator/auth/start"
      ) {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        sendJson(response, 200, {
          ok: true,
          ...(await phabWebSession.startAuthentication()),
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/phabricator/auth/cancel"
      ) {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        sendJson(response, 200, {
          ok: true,
          ...(await phabWebSession.cancelAuthentication()),
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/phabricator/auth/sign-out"
      ) {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        sendJson(response, 200, {
          ok: true,
          ...(await phabWebSession.signOut()),
        });
        return;
      }

      const commitPageMatch = url.pathname.match(
        /^\/api\/graph\/(\d+)\/commits$/,
      );
      if (request.method === "GET" && commitPageMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(commitPageMatch[1])];

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const limit = Math.max(
          1,
          Number(url.searchParams.get("limit") || pageSize) || pageSize,
        );
        const page = await getCheckoutCommitPage({
          graph,
          cwd: graph.path,
          offset,
          limit,
          includeWorkingTree: true,
          workingTreeCount: graph.workingTreeCount,
          runCommand,
        });

        graph.workingTreeCount =
          page.workingTreeCount || graph.workingTreeCount || 0;
        graph.commits = mergeGraphCommits(graph.commits, page.commits);
        page.commits.forEach((commit) => graph.knownHashes.add(commit.hash));
        sendJson(response, 200, { ok: true, ...page });
        return;
      }

      const snapshotMatch = url.pathname.match(
        /^\/api\/graph\/(\d+)\/snapshot$/,
      );
      if (request.method === "GET" && snapshotMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const graph = serverGraphs[Number(snapshotMatch[1])];

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        const limit = getRequestLimit(url.searchParams.get("limit"));
        const snapshot = await getServerGraphSnapshot(graph, limit);

        sendJson(response, 200, { ok: true, ...snapshot });
        return;
      }

      const commitMessageMatch = url.pathname.match(
        /^\/api\/graph\/(\d+)\/current-message$/,
      );
      if (request.method === "GET" && commitMessageMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(commitMessageMatch[1])];

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        const message = await getGraphCurrentCommitMessage({
          graph,
          runCommand,
        });
        sendJson(response, 200, { ok: true, message });
        return;
      }

      const selectedCommitMessageMatch = url.pathname.match(
        /^\/api\/graph\/(\d+)\/message\/(.+)$/,
      );
      if (request.method === "GET" && selectedCommitMessageMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(selectedCommitMessageMatch[1])];
        const hash = decodeURIComponent(selectedCommitMessageMatch[2]);

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD") {
          await ensureGraphCommit(graph, hash, runCommand);
        }

        const message = await getGraphCommitMessage({
          graph,
          hash,
          runCommand,
        });
        sendJson(response, 200, { ok: true, message });
        return;
      }

      const integrationMatch = url.pathname.match(
        /^\/api\/graph\/(\d+)\/integration\/(.+)$/,
      );
      if (request.method === "GET" && integrationMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(integrationMatch[1])];
        const hash = decodeURIComponent(integrationMatch[2]);

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD") {
          await ensureGraphCommit(graph, hash, runCommand);
        }

        const integration = await getServerCommitIntegration(graph, hash);
        sendJson(response, 200, { ok: true, ...integration });
        return;
      }

      const reviewMatch = url.pathname.match(
        /^\/api\/graph\/(\d+)\/review\/(.+)$/,
      );
      if (request.method === "GET" && reviewMatch) {
        validateToken(url.searchParams.get("token"), token);
        const graph = serverGraphs[Number(reviewMatch[1])];
        const hash = decodeURIComponent(reviewMatch[2]);

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD") {
          await ensureGraphCommit(graph, hash, runCommand);
        }

        const review = await getServerCommitReview(graph, hash);
        sendJson(response, 200, { ok: true, ...review });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/bugzilla/checkin"
      ) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const graph = serverGraphs[Number(body.graphIndex)];
        const hash = String(body.hash || "");

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD") {
          await ensureGraphCommit(graph, hash, runCommand);
        }

        const result = await markGraphBugForCheckin({
          graph,
          hash,
          bugId: body.bugId,
          runCommand,
          getBug,
          getBugzillaRevisions,
          updateBug,
          phab,
          getNotionStoriesByBugId: getServerNotionStoriesByBugId,
        });
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      const diffMatch = url.pathname.match(/^\/api\/graph\/(\d+)\/diff\/(.+)$/);
      if (request.method === "GET" && diffMatch) {
        validateToken(url.searchParams.get("token"), token);
        const sessionId = url.searchParams.get("patchUpdateSession");
        const updateSession = sessionId ? patchUpdateSessions.get(sessionId) : null;
        if (sessionId && !updateSession) {
          sendJson(response, 404, { ok: false, error: "Unknown patch update session." });
          return;
        }
        let hash = decodeURIComponent(diffMatch[2]);
        // Committed patches share Git objects with the source repository. Read
        // them there so task cleanup cannot remove the diff's working directory.
        const sourceGraph = updateSession?.managedWorktree && !isWorkingTreeCommitHash(hash)
          ? serverGraphs.find(graph => graph.path === updateSession.repositoryPath) : null;
        const graph = sourceGraph || updateSession?.graph || serverGraphs[Number(diffMatch[1])];

        if (!graph) {
          sendJson(response, 404, { ok: false, error: "Unknown graph checkout." });
          return;
        }
        if (/^D\d+$/i.test(hash)) {
          hash = (await findGraphPatchCommit({ graph, revision: hash, newest: true, runCommand })).hash;
        }
        if (!isWorkingTreeCommitHash(hash)) {
          await ensureGraphCommit(graph, hash, runCommand);
        }

        const getDiff = () => getCommitDiff({
          cwd: graph.path,
          hash,
          fullFile: !(updateSession && isWorkingTreeCommitHash(hash)),
          maxDiffBytes: 0,
          runCommand,
        });
        const diff = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)
          ? await getCachedCommitData({
            cache: commitDiffCache,
            cacheMs: 15_000,
            inflight: commitDiffInflight,
            key: getCommitCacheKey(graph, hash),
            getValue: getDiff,
            shouldCache: value => {
              if (value.error || Buffer.byteLength(value.text || "") + Buffer.byteLength(value.html || "") > 2_000_000) return false;
              if (commitDiffCache.size >= 8) commitDiffCache.delete(commitDiffCache.keys().next().value);
              return true;
            },
          })
          : await getDiff();
        sendJson(response, 200, { ok: true, ...diff });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/checkout") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const result = await checkoutGraphCommit({
          graphs: serverGraphs,
          graphIndex: body.graphIndex,
          hash: body.hash,
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          serverGraphs[Number(body.graphIndex)],
          getRequestLimit(body.snapshotLimit),
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/commit-action") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const actionGraphs = [...serverGraphs];
        const result = await runGraphCommitAction({
          graphs: actionGraphs,
          graphIndex: body.graphIndex,
          hash: body.hash,
          action: body.action,
          preferredBranch: actionGraphs[Number(body.graphIndex)]?.branchNamespace && body.preferredBranch &&
            !body.preferredBranch.startsWith(actionGraphs[Number(body.graphIndex)].branchNamespace)
            ? actionGraphs[Number(body.graphIndex)].branchNamespace + body.preferredBranch : body.preferredBranch,
          rebaseMode: body.rebaseMode,
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          actionGraphs[Number(body.graphIndex)],
          getRequestLimit(body.snapshotLimit),
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (taskWorktrees && request.method === "POST" && ["/api/checkout-transfer", "/api/review-sync"].includes(url.pathname)) {
        throw Object.assign(new Error("Task worktrees share one Git repository. Checkout transfer and Review sync are no longer used."), { statusCode: 410 });
      }
      if (request.method === "POST" && url.pathname === "/api/checkout-transfer") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const sourceIndex = Number(body.sourceGraphIndex);
        const destinationIndex = Number(body.destinationGraphIndex);
        const source = serverGraphs[sourceIndex];
        const destination = serverGraphs[destinationIndex];
        const hash = String(body.hash || "");

        if (!source || !destination) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        await ensureGraphCommit(source, hash, runCommand);

        const result = await copyGraphCommitsBetweenCheckouts({
          source,
          destination,
          hash,
          mode: body.mode,
          branch: body.branch,
          discardDirty: body.discardDirty === true,
          runCommand,
        });
        const snapshots = await getServerGraphSnapshots(body);

        sendJson(response, 200, { ok: true, ...result, snapshots });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/review-sync") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const result = await syncReviewCheckout({
          graphs: serverGraphs,
          confirmation: body.confirmation,
          runCommand,
        });
        const snapshots = await getServerGraphSnapshots(body);

        sendJson(response, 200, { ok: true, ...result, snapshots });
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/interactive-rebase/plan"
      ) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const graphIndex = Number(url.searchParams.get("graphIndex"));
        const graph = serverGraphs[graphIndex];

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        const plan = await getInteractiveRebasePlan({
          graph,
          hash: url.searchParams.get("hash") || "",
          preferredBranch: url.searchParams.get("preferredBranch") || "",
          runCommand,
        });

        sendJson(response, 200, { ok: true, graphIndex, plan });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/interactive-rebase") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const graphIndex = Number(body.graphIndex);
        const graph = serverGraphs[graphIndex];

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        const result = await startInteractiveRebase({
          graph,
          graphIndex,
          hash: body.hash,
          preferredBranch: graph.branchNamespace && body.preferredBranch && !body.preferredBranch.startsWith(graph.branchNamespace)
            ? graph.branchNamespace + body.preferredBranch : body.preferredBranch,
          items: body.items || [],
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          graph,
          getRequestLimit(body.snapshotLimit),
        );

        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      const savedRebaseMatch = url.pathname.match(/^\/api\/rebase\/([a-f0-9-]+)$/);
      if (request.method === "GET" && savedRebaseMatch) {
        validateToken(url.searchParams.get("token"), token);
        await reconcileSavedRebases();
        const session = rebaseSessions.get(savedRebaseMatch[1]);
        if (!session) throw Object.assign(new Error("Unknown rebase session."), { statusCode: 404 });
        sendJson(response, 200, { ok: true, id: session.id, status: session.resolutionBusy || session.continueBusy ? "applying" : session.status || "review",
          rebaseState: { sessionId: session.id, graphIndex: session.graphIndex,
            conflict: session.savedConflict, resolutionId: session.resolution?.id },
          resolution: session.resolution ? { id: session.resolution.id, diff: session.resolution.diff } : null,
          rebaseConflict: session.savedConflict });
        return;
      }
      const resolutionMatch = url.pathname.match(/^\/api\/rebase\/([^/]+)\/resolution(?:\/(cancel))?$/);
      if (request.method === "POST" && resolutionMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = rebaseSessions.get(decodeURIComponent(resolutionMatch[1]));
        if (!session) {
          sendJson(response, 404, { ok: false, error: "Unknown rebase session." });
          return;
        }
        if (resolutionMatch[2]) {
          if (session.resolutionBusy || session.continueBusy) {
            sendJson(response, 409, { ok: false, error: "AI conflict resolution is still running." });
            return;
          }
          await applyRebaseResolution({ session, id: body.resolutionId, runCommand, cancel: true });
          rebaseStore.save(session);
          sendJson(response, 200, { ok: true });
        } else {
          if (!isGraphAiEnabled(appConfig)) {
            throw Object.assign(new Error("Enable AI in the console to resolve conflicts with AI."), { statusCode: 403 });
          }
          const streaming = body.stream === true;
          const sendEvent = event => {
            if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
          };
          if (streaming) {
            response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
            response.flushHeaders();
          }
          try {
            const resolution = await proposeRebaseResolution({ session, runCommand,
              codexCommand: appConfig?.ai?.command, generate: generateRebaseResolution,
              onProgress: streaming ? progress => sendEvent({ type: "progress", ...progress }) : undefined });
            rebaseStore.save(session);
            if (streaming) sendEvent({ type: "result", ok: true, resolution });
            else sendJson(response, 200, { ok: true, resolution });
          } catch (error) {
            if (!streaming) throw error;
            sendEvent({ type: "result", ok: false, error: String(error?.message || error) });
          } finally {
            if (streaming) response.end();
          }
        }
        return;
      }

      const rebaseContinueMatch = url.pathname.match(/^\/api\/rebase\/([^/]+)\/continue$/);

      if (request.method === "POST" && rebaseContinueMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const sessionId = decodeURIComponent(rebaseContinueMatch[1]);
        const session = rebaseSessions.get(sessionId);

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown rebase session.",
          });
          return;
        }

        if (session.continueBusy) {
          sendJson(response, 409, { ok: false, error: "The rebase is already continuing." });
          return;
        }
        session.continueBusy = true;
        let result;
        try {
          if (session.kind === "review-import") {
            const review = patchReviewSessions.get(session.patchReviewSessionId);
            if (!review || review.cancelled) throw new Error("The owning review is no longer active.");
            session.abortController = review.abortController;
          }
          await applyRebaseResolution({ session, id: body.resolutionId, runCommand });
          result = session.kind === "review-import"
            ? await continueReviewImport({ session, runCommand })
            : await continueRebaseCommit({ session, runCommand });
          rebaseSessions.delete(sessionId);
        } catch (error) {
          if (!error.rebaseState) throw error;
          const payload = {};
          attachRebaseConflict(payload, error);
          const review = patchReviewSessions.get(session.patchReviewSessionId);
          if (review) review.rebaseConflict = payload.rebaseConflict;
          sendJson(response, 409, { ok: false, error: error.message, ...payload });
          return;
        } finally {
          session.continueBusy = false;
        }

        const snapshot = await getServerGraphSnapshot(
          session.graph,
          getRequestLimit(body.snapshotLimit),
        );

        const update = patchUpdateSessions.get(session.patchUpdateSessionId);
        if (update?.pendingPublication) {
          update.pendingPublication.replay = result;
          delete update.pendingPublication.rebaseSession;
          update.rebaseConflict = null;
          if (update.preparation) startPatchUpdatePreparation(update, getRequestLimit(body.snapshotLimit));
          else await amendGraphPatchUpdateChanges({ session: update, requireAllHandled: false, runCommand,
            saveMemory: savePatchUpdateMemory });
          savePatchSessions();
        } else if (update?.preparation) {
          const rewritten = result.rewrittenCommits?.find(commit => commit.originalHash === session.hash)?.hash || result.currentHash;
          update.preparation.rewrittenHashes.set(session.hash, rewritten);
          update.preparation.baseHash ||= result.base;
          update.currentHash = rewritten;
          update.rebaseConflict = null;
          startPatchUpdatePreparation(update, getRequestLimit(body.snapshotLimit));
        }
        const review = patchReviewSessions.get(session.patchReviewSessionId);
        if (review) continuePreparedReview(review);
        session.status = "complete";
        rebaseStore.remove(session.id);
        rebaseSessions.delete(session.id);
        if (!session.patchUpdateSessionId && !session.patchReviewSessionId) await taskManager?.cleanup(session);
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/commit/metadata") {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
        const metadata = await getGraphCommitMetadata({
          graph,
          runCommand,
        });

        sendJson(response, 200, {
          ok: true,
          graphIndex: index,
          metadata: { ...metadata, graphIndex: index },
        });
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/commit/reviewers"
      ) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        sendJson(response, 200, {
          ok: true,
          disabled: true,
          reviewers: [],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/commit") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const { graph } = chooseGraphMachCheckout(serverGraphs);
        const result = await createGraphCommit({
          graph,
          options: body.options || {},
          runCommand,
        });
        const snapshots = await getServerGraphSnapshots(body);

        sendJson(response, 200, { ok: true, ...result, snapshots });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/update-graphs") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const streaming = body.stream === true;
        const sendEvent = (event) => {
          if (!response.destroyed) {
            response.write(`${JSON.stringify(event)}\n`);
          }
        };
        if (streaming) {
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          });
          response.flushHeaders();
        }
        try {
          const result = await runGraphRepositoryUpdate({
            graphs: serverGraphs,
            mode: body.mode,
            dirtyAction: body.dirtyAction,
            scope: body.scope,
            graphIndex: body.graphIndex,
            runCommand,
            onOutput: streaming ? (output) => sendEvent({ type: "output", output }) : undefined,
          });
          if (streaming) {
            sendEvent({ type: "status", message: "Git update complete. Refreshing tree..." });
          }
          const snapshots = await getServerGraphSnapshots(body);
          const payload = { ok: true, ...result, snapshots };
          if (streaming) {
            sendEvent({ type: "result", ...payload });
            response.end();
          } else {
            sendJson(response, 200, payload);
          }
        } catch (error) {
          if (!streaming) {
            throw error;
          }
          const payload = {
            type: "result",
            ok: false,
            error: String(error?.message || error),
            output: error.output || "",
            dirty: error.dirty,
          };
          attachRebaseConflict(payload, error);
          sendEvent(payload);
          response.end();
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/unshelf-graphs") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const result = await unshelfGraphShelves({
          graphs: serverGraphs,
          shelves: Array.isArray(body.shelves) ? body.shelves : [],
          runCommand,
        });
        const snapshots = await getServerGraphSnapshots(body);

        sendJson(response, 200, { ok: true, ...result, snapshots });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mach-action") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = chooseGraphMachCheckout(serverGraphs, body.graphIndex);
        const session = createGraphMachSession({
          graph,
          graphs: serverGraphs,
          graphIndex: index,
          action: body.action,
          prepareCheckout: taskManager ? async ({ signal, session }) => {
            const workspace = await taskManager.prepareCurrent("build", undefined, { signal, session });
            return { graph: workspace.graph, graphs: taskManager.taskGraphs(workspace) };
          } : undefined,
          runCommand,
        });

        machSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphMachSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/try") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = chooseGraphMachCheckout(serverGraphs, body.graphIndex);
        const session = createGraphTrySession({
          graph,
          graphIndex: index,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
          getSnapshot: getServerGraphSnapshot,
          options: body.options || {},
          runCommand,
          postComment,
          prepareCheckout: taskManager ? ({ session }) => taskManager.prepareCurrent("try", undefined, { session }) : undefined,
        });

        trySessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphTrySession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/lint") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = await getCommandCheckout(body.graphIndex, "lint");
        const session = createGraphLintSession({
          graph,
          graphIndex: index,
          mode: body.mode,
          runCommand,
        });

        lintSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphLintSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/test") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = await getCommandCheckout(body.graphIndex, "test");
        const session = createGraphTestSession({
          graph,
          graphIndex: index,
          options: body.options || {},
          runCommand,
          ...(taskWorktrees && prepareTaskBuild ? { prepareBuild: taskManager.prepareBuild } : {}),
        });

        testSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphTestSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/new-patch") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = chooseGraphMachCheckout(
          serverGraphs,
          body.graphIndex,
        );
        const snapshotLimits = Array.isArray(body.snapshotLimits)
          ? body.snapshotLimits.map(getRequestLimit)
          : [];
        const session = createGraphNewPatchSession({
          graphs: serverGraphs,
          graph,
          graphIndex: index,
          snapshotLimits,
          getSnapshots: (limits) =>
            getServerGraphSnapshots({ snapshotLimits: limits }),
          options: body.options || {},
          runCommand,
          updateBug,
          config: appConfig,
        });

        newPatchSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphNewPatchSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = chooseGraphMachCheckout(
          serverGraphs,
          body.graphIndex,
        );
        const session = createGraphPatchSession({
          graph,
          graphIndex: index,
          snapshotLimit: getRequestSnapshotLimit(body, index),
          getSnapshot: getServerGraphSnapshot,
          options: body.options || {},
          runCommand,
        });

        patchSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/land") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        const session = createGraphLandSession({
          graphs: serverGraphs,
          graph,
          graphIndex: index,
          snapshotLimits: Array.isArray(body.snapshotLimits)
            ? body.snapshotLimits.map(getRequestLimit)
            : [],
          getSnapshots: (snapshotLimits) =>
            getServerGraphSnapshots({ snapshotLimits }),
          options: body.options || {},
          runCommand,
          getBugs,
          getAttachments,
          updateBug,
          phab,
          postComment,
          pushCommits,
        });

        landSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphLandSession(session),
        });
        return;
      }

      const landStatusMatch = url.pathname.match(/^\/api\/land\/([^/]+)$/);
      if (request.method === "GET" && landStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = landSessions.get(
          decodeURIComponent(landStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown landing session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphLandSession(session),
        });
        return;
      }

      const landPatchTryStatusMatch = url.pathname.match(
        /^\/api\/land\/([^/]+)\/patch\/([^/]+)\/([^/]+)\/try-status$/,
      );
      if (request.method === "GET" && landPatchTryStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = landSessions.get(
          decodeURIComponent(landPatchTryStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown landing session.",
          });
          return;
        }

        try {
          const tryStatus = await loadGraphLandingPatchTryStatus(session, {
            bugId: decodeURIComponent(landPatchTryStatusMatch[2]),
            patchId: decodeURIComponent(landPatchTryStatusMatch[3]),
          });

          sendJson(response, 200, {
            ok: true,
            tryStatus,
          });
        } catch (error) {
          sendJson(response, error?.statusCode || 500, {
            ok: false,
            error: error?.message || String(error),
          });
        }
        return;
      }

      const landAnswerMatch = url.pathname.match(
        /^\/api\/land\/([^/]+)\/answer$/,
      );
      if (request.method === "POST" && landAnswerMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = landSessions.get(
          decodeURIComponent(landAnswerMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown landing session.",
          });
          return;
        }

        session.answer(body.promptId, body.answer);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphLandSession(session),
        });
        return;
      }

      const landCancelMatch = url.pathname.match(
        /^\/api\/land\/([^/]+)\/cancel$/,
      );
      if (request.method === "POST" && landCancelMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = landSessions.get(
          decodeURIComponent(landCancelMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown landing session.",
          });
          return;
        }

        session.cancel();
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphLandSession(session),
        });
        return;
      }

      const tryStatusMatch = url.pathname.match(/^\/api\/try\/([^/]+)$/);
      if (request.method === "GET" && tryStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = trySessions.get(decodeURIComponent(tryStatusMatch[1]));

        if (!session) {
          sendJson(response, 404, { ok: false, error: "Unknown try session." });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphTrySession(session),
        });
        return;
      }

      const lintStatusMatch = url.pathname.match(/^\/api\/lint\/([^/]+)$/);
      if (request.method === "GET" && lintStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = lintSessions.get(
          decodeURIComponent(lintStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown lint session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphLintSession(session),
        });
        return;
      }

      const testStatusMatch = url.pathname.match(/^\/api\/test\/([^/]+)$/);
      if (request.method === "GET" && testStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = testSessions.get(
          decodeURIComponent(testStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown test session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphTestSession(session),
        });
        return;
      }

      const testCancelMatch = url.pathname.match(
        /^\/api\/test\/([^/]+)\/cancel$/,
      );
      if (request.method === "POST" && testCancelMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = testSessions.get(
          decodeURIComponent(testCancelMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown test session.",
          });
          return;
        }

        session.cancel();
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphTestSession(session),
        });
        return;
      }

      const newPatchStatusMatch = url.pathname.match(
        /^\/api\/new-patch\/([^/]+)$/,
      );
      if (request.method === "GET" && newPatchStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = newPatchSessions.get(
          decodeURIComponent(newPatchStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown new patch session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphNewPatchSession(session),
        });
        return;
      }

      const newPatchCancelMatch = url.pathname.match(
        /^\/api\/new-patch\/([^/]+)\/cancel$/,
      );
      if (request.method === "POST" && newPatchCancelMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = newPatchSessions.get(
          decodeURIComponent(newPatchCancelMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown new patch session.",
          });
          return;
        }

        session.cancel();
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphNewPatchSession(session),
        });
        return;
      }

      const patchStatusMatch = url.pathname.match(/^\/api\/patch\/([^/]+)$/);
      if (request.method === "GET" && patchStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = patchSessions.get(
          decodeURIComponent(patchStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown patch pull session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchSession(session),
        });
        return;
      }

      const patchAnswerMatch = url.pathname.match(
        /^\/api\/patch\/([^/]+)\/answer$/,
      );
      if (request.method === "POST" && patchAnswerMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = patchSessions.get(
          decodeURIComponent(patchAnswerMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown patch pull session.",
          });
          return;
        }

        session.answer(body.promptId, body.answer);
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchSession(session),
        });
        return;
      }

      const patchCancelMatch = url.pathname.match(
        /^\/api\/patch\/([^/]+)\/cancel$/,
      );
      if (request.method === "POST" && patchCancelMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = patchSessions.get(
          decodeURIComponent(patchCancelMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown patch pull session.",
          });
          return;
        }

        session.cancel();
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchSession(session),
        });
        return;
      }

      const machStatusMatch = url.pathname.match(
        /^\/api\/mach-action\/([^/]+)$/,
      );
      if (request.method === "GET" && machStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = machSessions.get(
          decodeURIComponent(machStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown build/run session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeGraphMachSession(session),
        });
        return;
      }

      const machCancelMatch = url.pathname.match(
        /^\/api\/mach-action\/([^/]+)\/cancel$/,
      );
      if (request.method === "POST" && machCancelMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = machSessions.get(
          decodeURIComponent(machCancelMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown build/run session.",
          });
          return;
        }

        await session.cancel();
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphMachSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/amend-try-fixup") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const sourceGraph = serverGraphs[Number(body.graphIndex)];
        const workflow = taskWorktrees && backgroundTryStore.list().find(state =>
          state.repositoryPath === sourceGraph?.path && state.fixupHash === String(body.hash) && state.phase !== "squashed");
        const graph = workflow ? { ...sourceGraph, path: workflow.path, taskWorktree: true,
          repositoryPath: sourceGraph.path, branchNamespace: workflow.branchNamespace } : sourceGraph;
        await ensureGraphCommit(graph, body.hash, runCommand);
        const result = await squashTryFixup({ graph, hash: String(body.hash), store: backgroundTryStore, runCommand });
        const snapshot = await getServerGraphSnapshot(graph, getRequestLimit(body.snapshotLimit));
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/api/amend-current" ||
          url.pathname === "/api/amend-message")
      ) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const graph = serverGraphs[Number(body.graphIndex)];
        const hash = String(body.hash || "HEAD");

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (!isWorkingTreeCommitHash(hash) && hash !== "HEAD") {
          await ensureGraphCommit(graph, hash, runCommand);
        }

        const result = await amendCommitMessage({
          graph,
          hash,
          message: body.message,
          expectedChangeId: body.expectedChangeId,
          includeChanges: Boolean(body.includeChanges),
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          graph,
          getRequestLimit(body.snapshotLimit),
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/submit") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const graphIndex = Number(body.graphIndex);
        let graph = serverGraphs[graphIndex];
        const taskUpdate = patchUpdateSessions.get(String(body.patchUpdateSessionId || ""));
        if (taskUpdate?.managedWorktree && taskUpdate.graphIndex === graphIndex) {
          if (taskUpdate.pendingPublication) throw Object.assign(new Error("Keep the patch changes on its source branch before submitting."), { statusCode: 409 });
          const refs = String(await runCommand({ cmd: "git", args: ["for-each-ref", "--format=%(refname:short)",
            "--points-at", String(body.hash || taskUpdate.currentHash), "refs/heads"], cwd: graph.path, capture: true, silent: true }))
            .split(/\r?\n/).filter(branch => branch && !/^(?:tb-task|tb-try-workspace)\//.test(branch));
          if (!refs.length) throw Object.assign(new Error("This task result is not saved on the patch's existing branch. Keep the changes before submitting."), { statusCode: 409 });
        }

        if (!graph) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown graph checkout.",
          });
          return;
        }

        if (graph.error) {
          sendJson(response, 500, { ok: false, error: graph.error });
          return;
        }

        let current = await getCurrentGraphBase(graph, runCommand);
        const requestedHash = String(body.hash || current.hash);

        if (isWorkingTreeCommitHash(requestedHash)) {
          sendJson(response, 409, {
            ok: false,
            error: "Commit uncommitted changes before submitting a patch.",
          });
          return;
        }

        if (requestedHash !== current.hash) {
          await ensureGraphCommit(graph, requestedHash, runCommand);
        }

        if (await isGraphCommitOnOriginMain({
          graph,
          hash: requestedHash,
          runCommand,
        })) {
          sendJson(response, 409, {
            ok: false,
            error: "Submit is only available for commits not already on origin/main.",
          });
          return;
        }

        // moz-phab requires a named branch. Submit uses the selected checkout;
        // it must not clone author branches into a new task workspace.
        if (requestedHash !== current.hash || !current.branch || current.branch === "(detached)") {
          await checkoutGraphCommit({
            graphs: graph.taskWorktree ? [graph] : serverGraphs,
            graphIndex: graph.taskWorktree ? 0 : graphIndex,
            hash: requestedHash,
            runCommand,
          });
          current = await getCurrentGraphBase(graph, runCommand);

          if (current.hash !== requestedHash) {
            sendJson(response, 409, {
              ok: false,
              error: "Could not check out the selected commit before submitting.",
            });
            return;
          }
        }

        if (!current.branch || current.branch === "(detached)") {
          await runGraphCommitAction({ graphs: [graph], graphIndex: 0,
            hash: requestedHash, action: "branch", runCommand });
          await checkoutGraphCommit({ graphs: [graph], graphIndex: 0, hash: requestedHash, runCommand });
          current = await getCurrentGraphBase(graph, runCommand);
        }

        if (!current.branch || current.branch === "(detached)") {
          sendJson(response, 409, {
            ok: false,
            error: "moz-phab requires a local branch at the selected commit. Check out that branch before submitting.",
          });
          return;
        }

        let afterMozPhabSubmit;
        const patchUpdateSessionId = String(body.patchUpdateSessionId || "");

        if (patchUpdateSessionId) {
          const patchUpdateSession = patchUpdateSessions.get(patchUpdateSessionId);

          if (!patchUpdateSession) {
            sendJson(response, 404, {
              ok: false,
              error: "Unknown patch update session.",
            });
            return;
          }

          if (patchUpdateSession.graphIndex !== graphIndex) {
            sendJson(response, 409, {
              ok: false,
              error: "The patch update session belongs to another checkout.",
            });
            return;
          }

          if (patchUpdateSession.mode === "freeform" && (
            patchUpdateSession.freeformOperationRunning ||
            !["review", "complete"].includes(patchUpdateSession.status) ||
            patchUpdateSession.items.some(item => item.changeApplied && !item.changesAmended)
          )) {
            sendJson(response, 409, { ok: false, error: "Finish and amend the Update changes before submitting." });
            return;
          }
          if (patchUpdateSession.mode !== "freeform" && patchUpdateSession.items.some((item) => (
            item.state !== "handled" && item.state !== "skipped"
          ))) {
            sendJson(response, 409, {
              ok: false,
              error: "Mark or skip each review comment before submitting the patch.",
            });
            return;
          }

          afterMozPhabSubmit = async () => {
            patchUpdateSession.status = "complete";
            patchUpdateSession.message = "Patch submitted to Phabricator.";
            savePatchSessions();
            await savePatchUpdateMemory({
              event: "Patch submitted to Phabricator",
              session: patchUpdateSession,
            });
          };
        }

        const session = createGraphSubmitSession({
          graph,
          graphIndex,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
          getSnapshot: getServerGraphSnapshot,
          runCommand,
          postComment: patchUpdateSessionId
            ? ({ id, message }) => phabWebSession.publishRevisionReview({
              revision: `D${String(id).replace(/^D/i, "")}`,
              action: "comment",
              message,
            })
            : postComment,
          afterMozPhabSubmit,
        });

        session.patchUpdateSessionId = patchUpdateSessionId;
        session.managedWorktree = Boolean(graph.taskWorktree);
        submitSessions.set(session.id, session);
        sendJson(response, 200, {
          ok: true,
          ...serializeSubmitSession(session),
        });
        return;
      }

      const submitStatusMatch = url.pathname.match(/^\/api\/submit\/([^/]+)$/);
      if (request.method === "GET" && submitStatusMatch) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const session = submitSessions.get(
          decodeURIComponent(submitStatusMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown submit session.",
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          ...serializeSubmitSession(session),
        });
        return;
      }

      const submitAnswerMatch = url.pathname.match(
        /^\/api\/submit\/([^/]+)\/answer$/,
      );
      if (request.method === "POST" && submitAnswerMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = submitSessions.get(
          decodeURIComponent(submitAnswerMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown submit session.",
          });
          return;
        }

        session.answer(body.promptId, body.answer);
        sendJson(response, 200, {
          ok: true,
          ...serializeSubmitSession(session),
        });
        return;
      }

      const submitCancelMatch = url.pathname.match(
        /^\/api\/submit\/([^/]+)\/cancel$/,
      );
      if (request.method === "POST" && submitCancelMatch) {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        noteBrowserActivity();
        const session = submitSessions.get(
          decodeURIComponent(submitCancelMatch[1]),
        );

        if (!session) {
          sendJson(response, 404, {
            ok: false,
            error: "Unknown submit session.",
          });
          return;
        }

        session.cancel();
        sendJson(response, 200, {
          ok: true,
          ...serializeSubmitSession(session),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ping") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        sendJson(response, 200, { ok: true, clientId: body.clientId || "" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/shutdown-events") {
        validateToken(url.searchParams.get("token"), token);

        if (shuttingDown) {
          sendJson(response, 200, {
            ok: true,
            closing: true,
            closeTabs: Boolean(closeBrowserTabsOnShutdown),
            reason: server.closeReason || "server shutdown requested",
          });
          return;
        }

        const waiter = {
          response,
          timer: setTimeout(() => {
            sendBrowserShutdownEvent(waiter);
          }, heartbeatIntervalMs * 15),
        };

        waiter.timer.unref?.();
        browserShutdownWaiters.add(waiter);
        request.once("close", () => {
          clearTimeout(waiter.timer);
          browserShutdownWaiters.delete(waiter);
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/close") {
        const body = await readRequestJson(request);
        validateToken(body.token, token);
        const clientId = body.clientId ? String(body.clientId) : "";

        if (clientId) {
          sendJson(response, 200, {
            ok: true,
            remainingClients: 0,
          });
          return;
        }

        sendJson(response, 200, { ok: true });
        shutdown(50, "browser tab closed");
        return;
      }

      sendJson(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      const body = {
        ok: false,
        error: String(error?.message || error),
      };

      if (error?.dirty) {
        body.dirty = error.dirty;
      }

      if (error?.output) {
        body.output = error.output;
      }

      if (error?.transfer) {
        body.transfer = error.transfer;
      }

      if (error?.reviewSync) {
        body.reviewSync = error.reviewSync;
      }

      attachRebaseConflict(body, error);
      const update = patchUpdateSessions.get(error.rebaseState?.patchUpdateSessionId);
      if (update && body.rebaseConflict) {
        update.rebaseConflict = body.rebaseConflict;
        savePatchSessions();
      }

      sendJson(response, error.statusCode || 500, body);
    }
  });
  server.shutdown = shutdown;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  function listen(requestedPort) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(Number(requestedPort), host);
    });
  }

  async function closePreviousConsole() {
    if (host !== "127.0.0.1" && host !== "localhost") {
      return false;
    }

    try {
      const origin = `http://${host}:${Number(port)}`;
      const page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) });
      if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) {
        return false;
      }
      const html = await page.text();
      if (!html.includes("<title>Thunderbird Development Dashboard</title>") ||
          !html.includes("/assets/graph-client/init.js")) {
        return false;
      }
      const configText = html.match(/<script type="application\/json" id="graph-config">([^<]+)<\/script>/)?.[1];
      const previous = configText && JSON.parse(configText);
      if (previous?.interactive?.enabled !== true || !previous.interactive.token) {
        return false;
      }
      const response = await fetch(`${origin}/api/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: previous.interactive.token }),
        signal: AbortSignal.timeout(3000),
      });
      return response.ok && (await response.json()).ok === true;
    } catch {
      return false;
    }
  }

  try {
    await listen(port);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || fallbackPort === undefined) {
      throw error;
    }
    let reclaimed = false;
    if (await closePreviousConsole()) {
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await listen(port);
          reclaimed = true;
          break;
        } catch (retryError) {
          if (retryError?.code !== "EADDRINUSE") {
            throw retryError;
          }
        }
      }
    }
    if (!reclaimed) {
      await listen(fallbackPort);
    }
  }

  const address = server.address();
  registerConsoleBrowserAccess(server, `http://127.0.0.1:${address.port}/`, token);
  tryMonitor?.start();
  implementation?.start();
  // Resume only work that was active in the previous process. Saved results
  // and dismissed history do not start new work or repost review comments.
  void (async () => {
    for (const saved of [...patchReviewSessions.values()]) {
      if (!saved.resumeOnRestart || saved.dismissed || !saved.aiEnabled || shuttingDown) continue;
      saved.resumeOnRestart = false;
      try {
        const fresh = createGraphPatchReviewSession({
          graphs: serverGraphs.map(graph => ({ ...graph, taskWorktree: true })),
          revision: saved.revision, aiEnabled: saved.aiEnabled, codexCommand: saved.codexCommand,
        });
        configureManagedReviewSession(fresh);
        await restorePatchSession("review", fresh, { resume: true }, null);
      } catch (error) {
        saved.error = `Could not recover this review after restart: ${error.message}`;
        saved.recoveryFailed = true;
        saved.interrupted = true;
        saved.restored = true;
        savePatchSessions();
      }
    }
  })();
  void getDefaultKnowledgeService();
  server.once("close", () => {
    void stopDefaultKnowledgeService().catch(() => {});
    tryMonitor?.stop();
    implementation?.stop();
    savePatchSessions();
    patchSessionsFrozen = true;
    clearInterval(patchSessionTimer);
    clearInterval(rebaseSessionTimer);
    clearInterval(worktreeCleanupTimer);
    saveRebaseSessions();
    for (const session of [...patchUpdateSessions.values(), ...patchReviewSessions.values()]) {
      session.abortController?.abort();
      session.codexAgent?.client.close();
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
    }

    for (const waiter of [...browserShutdownWaiters]) {
      sendBrowserShutdownEvent(waiter);
    }
  });

  return {
    server,
    graphs: serverGraphs,
    url: `http://${host}:${address.port}/`,
  };
}

export function waitForInteractiveServerClose(server, signalSource = process) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    const close = () => {
      if (typeof server.shutdown === "function") {
        server.shutdown(0, "terminal signal received");
        return;
      }

      if (server.listening) {
        server.close();
      }
    };
    const cleanup = () => {
      for (const signal of INTERACTIVE_SERVER_CLOSE_SIGNALS) {
        signalSource.off(signal, close);
      }
      resolve(server.closeReason || "server closed");
    };

    server.once("close", cleanup);
    for (const signal of INTERACTIVE_SERVER_CLOSE_SIGNALS) {
      signalSource.once(signal, close);
    }
  });
}
