import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
  comment as defaultComment,
  isPhabricatorRateLimitError,
} from "../../lib/phab.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import {
  DEFAULT_CLIENT_DISCONNECT_GRACE_MS,
  DEFAULT_BROWSER_SHUTDOWN_GRACE_MS,
  DEFAULT_DASHBOARD_CACHE_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_META_BOARD_CACHE_MS,
  DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  GRAPH_CLIENT_SCRIPTS,
  GRAPH_CLIENT_STYLESHEETS,
} from "./constants.mjs";
import { getDashboardData as defaultGetDashboardData } from "./dashboard.mjs";
import {
  getMetaBoardBugDetail as defaultGetMetaBoardBugDetail,
  getMetaBoardData as defaultGetMetaBoardData,
  updateMetaBoardBug as defaultUpdateMetaBoardBug,
} from "./meta-boards.mjs";
import {
  createSprint as defaultCreateSprint,
  getSprintData as defaultGetSprintData,
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
  getReviewerSearchRoute,
  isReviewerSearchRateLimitError,
  searchGraphCommitReviewers,
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
  getGraphOriginMainStatus,
  getGraphRustUpstreamStatus,
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
import { getGraphCommitReview } from "./reviews.mjs";
import {
  applyGraphPatchUpdateComment,
  createGraphPatchUpdateSession,
  followUpGraphPatchUpdateComment,
  getGraphPatchUpdateDraftBlock,
  getGraphPatchUpdateSubmitMessage,
  isGraphAiEnabled,
  markGraphPatchUpdateCommentHandled,
  prepareGraphPatchUpdateSession,
  saveGraphPatchUpdateReply,
  serializeGraphPatchUpdateSession,
} from "./patch-update.mjs";
import { saveGraphPatchUpdateMemory as defaultSavePatchUpdateMemory } from "./patch-update-memory.mjs";
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

const REVIEWER_RATE_LIMIT_COOLDOWN_MS = 60_000;
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
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  clientDisconnectGraceMs = DEFAULT_CLIENT_DISCONNECT_GRACE_MS,
  browserShutdownGraceMs = DEFAULT_BROWSER_SHUTDOWN_GRACE_MS,
  closeBrowserTabsOnShutdown = true,
  runCommand = run,
  createBug = defaultCreateBug,
  getBugs = defaultGetBugs,
  getAssignedOpenBugs = defaultGetAssignedOpenBugs,
  getAttachments = defaultGetAttachments,
  getBug = defaultGetBug,
  getBugComments = defaultGetBugComments,
  getBugHistoryByIds = defaultGetBugHistoryByIds,
  getBugsByIds = defaultGetBugsByIds,
  getBugsWithAttachmentsByIds = defaultGetBugsWithAttachmentsByIds,
  getNeedinfoOpenBugs = defaultGetNeedinfoOpenBugs,
  updateBug = defaultUpdateBug,
  getDashboardData = defaultGetDashboardData,
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
  postComment = defaultComment,
  pushCommits = defaultPushCommits,
  readMetaBoardStore = defaultReadMetaBoardStore,
  removeMetaBoard = defaultRemoveMetaBoard,
  assignMetaBoardColors = defaultAssignMetaBoardColors,
  getRustUpstreamStatus = getGraphRustUpstreamStatus,
  addMetaBoard = defaultAddMetaBoard,
  setMetaBoardReviewGroup = defaultSetMetaBoardReviewGroup,
  getReviewGroupAssignees = defaultGetReviewGroupAssignees,
  appConfig = defaultConfig,
  phabWebSession = createPhabricatorWebSession(),
  getPatchUpdateHandledCommentIds = defaultGetPatchUpdateHandledCommentIds,
  persistPatchUpdateHandledComment = defaultPersistPatchUpdateHandledComment,
  savePatchUpdateMemory = defaultSavePatchUpdateMemory,
  serverFactory = createServer,
}) {
  const serverGraphs = graphs.map((graph) => ({
    ...graph,
    commits: graph.commits || [],
    knownHashes: new Set((graph.commits || []).map((commit) => commit.hash)),
    workingTreeCount: graph.workingTreeCount || 0,
    patchIdCache: new Map(),
  }));
  const submitSessions = new Map();
  const patchUpdateSessions = new Map();
  const machSessions = new Map();
  const lintSessions = new Map();
  const newPatchSessions = new Map();
  const patchSessions = new Map();
  const trySessions = new Map();
  const landSessions = new Map();
  const testSessions = new Map();
  const rebaseSessions = new Map();
  const reviewerSearchCache = new Map();
  const reviewerSearchInflight = new Map();
  const reviewerSearchRouteCooldowns = new Map();
  const notionStoryCache = new Map();
  const notionStoryInflight = new Map();
  let notionDisabled = false;
  let dashboardCache;
  let dashboardInflight;
  let dashboardCooldownUntil = 0;
  const metaBoardCache = new Map();
  const metaBoardInflight = new Map();
  const sprintHistoryCache = new Map();
  const sprintHistoryInflight = new Map();
  let metaBoardColorAssignment = Promise.resolve();
  const sockets = new Set();
  const browserClients = new Map();
  const browserShutdownWaiters = new Set();
  let closeTimer;
  let noClientCloseTimer;
  let browserMonitorStarted = false;
  let lastBrowserActivity = 0;
  let shuttingDown = false;
  let rustUpstreamStatus;
  let rustUpstreamStatusCheckedAt = 0;
  let rustUpstreamStatusPromise = null;

  function clearNoClientCloseTimer() {
    if (!noClientCloseTimer) {
      return;
    }

    clearTimeout(noClientCloseTimer);
    noClientCloseTimer = undefined;
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

  function noteBrowserActivity(now = Date.now()) {
    browserMonitorStarted = true;
    lastBrowserActivity = now;
  }

  function registerBrowserClient(clientId, now = Date.now()) {
    noteBrowserActivity(now);

    if (!clientId) {
      return;
    }

    clearNoClientCloseTimer();
    browserClients.set(String(clientId), now);
  }

  function pruneStaleBrowserClients(now = Date.now()) {
    for (const [clientId, lastSeen] of browserClients) {
      if (now - lastSeen > heartbeatTimeoutMs) {
        browserClients.delete(clientId);
      }
    }
  }

  function scheduleNoBrowserClientsShutdown(
    delay = clientDisconnectGraceMs,
    reason = "all browser tabs closed",
  ) {
    if (shuttingDown || noClientCloseTimer) {
      return;
    }

    noClientCloseTimer = setTimeout(
      () => {
        noClientCloseTimer = undefined;
        pruneStaleBrowserClients();

        if (!browserClients.size) {
          shutdown(0, reason);
        }
      },
      Math.max(0, Number(delay) || 0),
    );
    noClientCloseTimer.unref?.();
  }

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();

    pruneStaleBrowserClients(now);

    if (browserClients.size || noClientCloseTimer) {
      return;
    }

    if (
      browserMonitorStarted &&
      lastBrowserActivity &&
      now - lastBrowserActivity > heartbeatTimeoutMs
    ) {
      shutdown(
        0,
        `browser heartbeat timed out after ${formatDurationLabel(heartbeatTimeoutMs)}`,
      );
    }
  }, heartbeatIntervalMs);

  function shutdown(delay = 0, reason = "server shutdown requested") {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
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
      clearInterval(heartbeatTimer);
      clearNoClientCloseTimer();

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
      .map((session) => session.currentHash)
      .filter(Boolean);

    // An update can rewrite a patch below the visible page. Keep that active
    // revision addressable while its review/submit flow is still open.
    graph.knownHashes = new Set([
      ...graph.commits.map((commit) => commit.hash),
      ...activePatchUpdateHashes,
    ]);

    return snapshot;
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
    rebaseSessions.set(id, error.rebaseState);
    body.rebaseConflict = {
      ...error.rebaseConflict,
      id,
    };
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
          path: graph.path,
          branch: DEFAULT_BRANCH,
          state: "error",
          upToDate: false,
          message: error && error.message ? error.message : String(error),
        };
      }
    }

    graph.originMainStatus = status;
    graph.originMainStatusCheckedAt = now;
    return status;
  }

  async function getServerOriginMainStatuses({
    force = false,
    waitForRust = false,
  } = {}) {
    const statuses = (
      await Promise.all(
        serverGraphs.map((graph) =>
          getServerOriginMainStatus(graph, { force }),
        ),
      )
    ).filter(Boolean);
    statuses.push(await getServerRustUpstreamStatus({
      force,
      wait: waitForRust,
    }));

    return statuses;
  }

  function getServerRustUpstreamCheckingStatus() {
    return {
      type: "rust-upstream",
      label: "rust",
      state: "checking",
      upToDate: null,
      message: "Checking Rust dependencies against Firefox remote main.",
    };
  }

  async function refreshServerRustUpstreamStatus() {
    if (rustUpstreamStatusPromise) {
      return rustUpstreamStatusPromise;
    }

    rustUpstreamStatus =
      rustUpstreamStatus || getServerRustUpstreamCheckingStatus();
    rustUpstreamStatusPromise = (async () => {
      try {
        rustUpstreamStatus = await getRustUpstreamStatus({
          graphs: serverGraphs,
          runCommand,
        });
      } catch (error) {
        rustUpstreamStatus = {
          type: "rust-upstream",
          label: "rust",
          state: "error",
          upToDate: false,
          message: error && error.message ? error.message : String(error),
        };
      } finally {
        rustUpstreamStatusCheckedAt = Date.now();
        rustUpstreamStatusPromise = null;
      }

      return rustUpstreamStatus;
    })();

    return rustUpstreamStatusPromise;
  }

  function isFreshRustUpstreamStatus(now) {
    return (
      rustUpstreamStatus &&
      rustUpstreamStatus.state !== "checking" &&
      rustUpstreamStatusCheckedAt &&
      now - rustUpstreamStatusCheckedAt < DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS
    );
  }

  async function getServerRustUpstreamStatus({
    force = false,
    wait = false,
  } = {}) {
    const now = Date.now();

    if (!force && isFreshRustUpstreamStatus(now)) {
      return rustUpstreamStatus;
    }

    if (force) {
      if (wait) {
        return refreshServerRustUpstreamStatus();
      }

      rustUpstreamStatus = getServerRustUpstreamCheckingStatus();
      refreshServerRustUpstreamStatus();
      return rustUpstreamStatus;
    }

    if (wait) {
      return refreshServerRustUpstreamStatus();
    }

    refreshServerRustUpstreamStatus();
    return rustUpstreamStatus || getServerRustUpstreamCheckingStatus();
  }

  async function getServerReviewerSearch({ query = "", limit = 30 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const normalizedQuery = String(query || "")
      .trim()
      .toLowerCase();
    const key = `${normalizedLimit}:${normalizedQuery}`;
    const now = Date.now();
    const cached = reviewerSearchCache.get(key);

    if (
      cached &&
      now - cached.checkedAt < DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS
    ) {
      return cached.result;
    }

    if (reviewerSearchInflight.has(key)) {
      return reviewerSearchInflight.get(key);
    }

    const limitedRoutes = new Map();
    const searchPhab = async (request) => {
      const route = request.route;
      const requestNow = Date.now();
      const cooldownUntil = reviewerSearchRouteCooldowns.get(route) || 0;

      if (cooldownUntil > requestNow) {
        const error = new Error(
          `Phabricator ${route} is temporarily rate limited.`,
        );
        error.statusCode = 429;
        error.retryAfterMs = cooldownUntil - requestNow;
        limitedRoutes.set(route, cooldownUntil);
        throw error;
      }

      try {
        return await phab(request);
      } catch (error) {
        if (isReviewerSearchRateLimitError(error)) {
          const retryAt = Date.now() + REVIEWER_RATE_LIMIT_COOLDOWN_MS;
          reviewerSearchRouteCooldowns.set(route, retryAt);
          limitedRoutes.set(route, retryAt);
        }

        throw error;
      }
    };

    const promise = searchGraphCommitReviewers({
      query,
      limit: normalizedLimit,
      phab: searchPhab,
    })
      .then((reviewers) => {
        const retryAt = Math.max(0, ...limitedRoutes.values());
        const result = {
          reviewers,
          rateLimited: Boolean(limitedRoutes.size),
          rateLimitedRoute: limitedRoutes.size
            ? getReviewerSearchRoute(query)
            : "",
          retryAfterMs: retryAt ? Math.max(0, retryAt - Date.now()) : 0,
        };

        if (!result.rateLimited) {
          reviewerSearchCache.set(key, {
            checkedAt: Date.now(),
            result,
          });
        }

        return result;
      })
      .finally(() => {
        reviewerSearchInflight.delete(key);
      });

    reviewerSearchInflight.set(key, promise);
    return promise;
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

  async function getServerDashboard({ force = false } = {}) {
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
      getAssignedOpenBugs,
      getBugsByIds,
      getBugsWithAttachmentsByIds,
      getNeedinfoOpenBugs,
      phab,
    }))
      .then((result) => {
        dashboardCache = { checkedAt: Date.now(), result };
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

  async function getServerMetaBoardReviewGroupAssignees(board) {
    if (!board.reviewGroup) {
      return { assignees: [] };
    }

    try {
      return {
        assignees: mergeMetaBoardAssignees(
          await getReviewGroupAssignees({ reviewGroup: board.reviewGroup, phab }),
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

    return getSprintData({
      board: metaBoard,
      historyByBugId,
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

      if (request.method === "GET" && url.pathname === "/launch") {
        validateToken(url.searchParams.get("token"), token);
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

      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const dashboard = await getServerDashboard({
          force: url.searchParams.get("force") === "1",
        });

        sendJson(response, 200, { ok: true, ...dashboard });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/patch-update") {
        const body = await readRequestJson(request);

        validateToken(body.token, token);
        noteBrowserActivity();
        const graphIndex = Number(body.graphIndex);
        const graph = serverGraphs[graphIndex];

        if (!graph) {
          const error = new Error("Unknown graph checkout.");

          error.statusCode = 404;
          throw error;
        }

        const session = createGraphPatchUpdateSession({
          graph,
          graphIndex,
          revision: body.revision,
          aiEnabled: isGraphAiEnabled(appConfig),
          codexCommand: appConfig?.ai?.command,
        });

        patchUpdateSessions.set(session.id, session);
        void prepareGraphPatchUpdateSession({
          session,
          graphs: serverGraphs,
          getRustUpstreamStatus: () => getServerRustUpstreamStatus({ wait: true }),
          getSnapshot: getServerGraphSnapshot,
          getHandledCommentIds: getPatchUpdateHandledCommentIds,
          phab,
          runCommand,
          saveMemory: savePatchUpdateMemory,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
        }).catch(() => {});
        sendJson(response, 200, {
          ok: true,
          ...serializeGraphPatchUpdateSession(session),
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
        /^\/api\/patch-update\/([^/]+)\/(apply|handled|comment|feedback)$/,
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

        const [, , action] = patchUpdateActionMatch;

        if (action === "apply") {
          void applyGraphPatchUpdateComment({
            session,
            itemId: body.itemId,
            persistHandledComment: persistPatchUpdateHandledComment,
            runCommand,
            saveMemory: savePatchUpdateMemory,
          }).catch(() => {});
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

          void followUpGraphPatchUpdateComment({
            session,
            itemId: body.itemId,
            instruction: body.instruction,
            runCommand,
            saveMemory: savePatchUpdateMemory,
          }).catch(() => {});
        } else if (action === "handled") {
          await persistPatchUpdateHandledComment({
            revision: session.revision,
            itemId: body.itemId,
          });
          markGraphPatchUpdateCommentHandled({ session, itemId: body.itemId });
          await savePatchUpdateMemory({
            event: "Review comment marked handled",
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

          if (typeof phabWebSession.saveRevisionDraft !== "function") {
            const error = new Error(
              "The authenticated Phabricator session cannot save reply drafts.",
            );

            error.statusCode = 501;
            throw error;
          }

          const previousDraftReply = item.draftReply;
          const previousDraftSaved = item.draftSaved;

          item.draftReply = message;
          item.draftSaved = false;
          try {
            await phabWebSession.saveRevisionDraft({
              revision: session.revision,
              draftBlock: getGraphPatchUpdateDraftBlock(session),
            });
            await persistPatchUpdateHandledComment({
              revision: session.revision,
              itemId: item.id,
            });
            saveGraphPatchUpdateReply({
              session,
              itemId: item.id,
              message,
            });
            await savePatchUpdateMemory({
              event: "Phabricator reply draft saved",
              session,
            });
          } catch (error) {
            item.draftReply = previousDraftReply;
            item.draftSaved = previousDraftSaved;
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
          const refreshedBoard = await getServerMetaBoard(board, { force: true });
          const sprint = getSprintData({ board: refreshedBoard, sprintId });
          const previousSprint = (refreshedBoard.sprints || [])
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
      if (metaBoardBugMatch) {
        let requestBody;

        if (request.method === "GET") {
          validateToken(url.searchParams.get("token"), token);
        } else if (request.method === "PUT") {
          requestBody = await readRequestJson(request);

          validateToken(requestBody.token, token);
        }

        const board = await getStoredMetaBoard(
          decodeURIComponent(metaBoardBugMatch[1]),
        );
        const bugId = decodeURIComponent(metaBoardBugMatch[2]);

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
          metaBoardCache.delete(board.id);
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
        const result = await getServerMetaBoardReviewGroupAssignees(board);

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

        if (
          !isWorkingTreeCommitHash(hash) &&
          hash !== "HEAD" &&
          !graph.knownHashes.has(hash)
        ) {
          sendJson(response, 404, {
            ok: false,
            error: "Commit has not been loaded by this graph.",
          });
          return;
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

        if (
          !isWorkingTreeCommitHash(hash) &&
          hash !== "HEAD" &&
          !graph.knownHashes.has(hash)
        ) {
          sendJson(response, 404, {
            ok: false,
            error: "Commit has not been loaded by this graph.",
          });
          return;
        }

        const integration = await getGraphCommitIntegrationStatus({
          graph,
          hash,
          runCommand,
          getBug,
          phab,
          getNotionStoriesByBugId: getServerNotionStoriesByBugId,
        });
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

        if (
          !isWorkingTreeCommitHash(hash) &&
          hash !== "HEAD" &&
          !graph.knownHashes.has(hash)
        ) {
          sendJson(response, 404, {
            ok: false,
            error: "Commit has not been loaded by this graph.",
          });
          return;
        }

        const review = await getGraphCommitReview({
          graph,
          hash,
          getWebSuggestions: phabWebSession.getSuggestions,
          runCommand,
          phab,
        });
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

        if (
          !isWorkingTreeCommitHash(hash) &&
          hash !== "HEAD" &&
          !graph.knownHashes.has(hash)
        ) {
          sendJson(response, 404, {
            ok: false,
            error: "Commit has not been loaded by this graph.",
          });
          return;
        }

        const result = await markGraphBugForCheckin({
          graph,
          hash,
          bugId: body.bugId,
          runCommand,
          getBug,
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
        const graph = serverGraphs[Number(diffMatch[1])];
        const hash = decodeURIComponent(diffMatch[2]);

        if (!graph?.knownHashes.has(hash)) {
          sendJson(response, 404, {
            ok: false,
            error: "Commit has not been loaded by this graph.",
          });
          return;
        }

        const diff = await getCommitDiff({
          cwd: graph.path,
          hash,
          fullFile: true,
          maxDiffBytes: 0,
          runCommand,
        });
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
        const result = await runGraphCommitAction({
          graphs: serverGraphs,
          graphIndex: body.graphIndex,
          hash: body.hash,
          action: body.action,
          preferredBranch: body.preferredBranch,
          rebaseMode: body.rebaseMode,
          runCommand,
        });
        const snapshot = await getServerGraphSnapshot(
          serverGraphs[Number(body.graphIndex)],
          getRequestLimit(body.snapshotLimit),
        );
        sendJson(response, 200, { ok: true, ...result, snapshot });
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
          preferredBranch: body.preferredBranch,
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

        const result = await continueRebaseCommit({
          session,
          runCommand,
        });
        rebaseSessions.delete(sessionId);

        const snapshot = await getServerGraphSnapshot(
          serverGraphs[Number(session.graphIndex)],
          getRequestLimit(body.snapshotLimit),
        );

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
        const reviewerSearch = await getServerReviewerSearch({
          query: url.searchParams.get("query") || "",
          limit: url.searchParams.get("limit") || 30,
        });

        sendJson(response, 200, { ok: true, ...reviewerSearch });
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

        const result = await runGraphRepositoryUpdate({
          graphs: serverGraphs,
          mode: body.mode,
          dirtyAction: body.dirtyAction,
          runCommand,
        });
        const snapshots = await getServerGraphSnapshots(body);

        sendJson(response, 200, { ok: true, ...result, snapshots });
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

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
        const session = createGraphMachSession({
          graph,
          graphIndex: index,
          action: body.action,
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

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
        const session = createGraphTrySession({
          graph,
          graphIndex: index,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
          getSnapshot: getServerGraphSnapshot,
          options: body.options || {},
          runCommand,
          postComment,
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

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
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

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
        const session = createGraphTestSession({
          graph,
          graphIndex: index,
          options: body.options || {},
          runCommand,
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

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
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

        const { graph, index } = chooseGraphMachCheckout(serverGraphs);
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

        if (
          !isWorkingTreeCommitHash(hash) &&
          hash !== "HEAD" &&
          !graph.knownHashes.has(hash)
        ) {
          sendJson(response, 404, {
            ok: false,
            error: "Commit has not been loaded by this graph.",
          });
          return;
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
        const graph = serverGraphs[graphIndex];

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

        const current = await getCurrentGraphBase(graph, runCommand);
        const requestedHash = String(body.hash || current.hash);

        if (requestedHash !== current.hash) {
          sendJson(response, 409, {
            ok: false,
            error:
              "Submit is only available for the currently checked out commit.",
          });
          return;
        }

        let submitMessage = "";
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

          if (patchUpdateSession.items.some((item) => item.state !== "handled")) {
            sendJson(response, 409, {
              ok: false,
              error: "Handle each review comment before submitting the patch.",
            });
            return;
          }

          submitMessage = getGraphPatchUpdateSubmitMessage(patchUpdateSession);
          afterMozPhabSubmit = async () => {
            if (submitMessage) {
              await phabWebSession.saveRevisionDraft({
                revision: patchUpdateSession.revision,
                draftBlock: "",
              });
              for (const item of patchUpdateSession.items) {
                item.draftReply = "";
                item.draftSaved = false;
              }
            }
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
          postComment,
          submitMessage,
          afterMozPhabSubmit,
        });

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
        registerBrowserClient(body.clientId);
        sendJson(response, 200, { ok: true, clientId: body.clientId || "" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/shutdown-events") {
        validateToken(url.searchParams.get("token"), token);
        registerBrowserClient(url.searchParams.get("clientId") || "");

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
          browserClients.delete(clientId);
          noteBrowserActivity();
          sendJson(response, 200, {
            ok: true,
            remainingClients: browserClients.size,
          });

          if (!browserClients.size) {
            scheduleNoBrowserClientsShutdown(
              clientDisconnectGraceMs,
              "all browser tabs closed",
            );
          }

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

      attachRebaseConflict(body, error);

      sendJson(response, error.statusCode || 500, body);
    }
  });
  server.shutdown = shutdown;
  heartbeatTimer.unref?.();

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

  try {
    await listen(port);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || fallbackPort === undefined) {
      clearInterval(heartbeatTimer);
      clearNoClientCloseTimer();
      throw error;
    }

    await listen(fallbackPort);
  }

  server.once("close", () => {
    clearInterval(heartbeatTimer);
    clearNoClientCloseTimer();

    if (closeTimer) {
      clearTimeout(closeTimer);
    }

    for (const waiter of [...browserShutdownWaiters]) {
      sendBrowserShutdownEvent(waiter);
    }
  });

  const address = server.address();

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
