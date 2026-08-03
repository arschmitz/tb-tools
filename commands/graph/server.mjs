import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import defaultConfig from "../../lib/config.mjs";
import { pushCommits as defaultPushCommits } from "../../lib/lando.mjs";
import { run } from "../../lib/utils.mjs";
import {
  getAttachments as defaultGetAttachments,
  getBug as defaultGetBug,
  getBugs as defaultGetBugs,
  updateBug as defaultUpdateBug,
} from "../../lib/bugzilla.mjs";
import defaultPhab, { comment as defaultComment } from "../../lib/phab.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import {
  DEFAULT_CLIENT_DISCONNECT_GRACE_MS,
  DEFAULT_BROWSER_SHUTDOWN_GRACE_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  GRAPH_CLIENT_SCRIPTS,
  GRAPH_CLIENT_STYLESHEETS,
} from "./constants.mjs";
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

const REVIEWER_RATE_LIMIT_COOLDOWN_MS = 60_000;
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

export async function startInteractiveGraphServer({
  html,
  graphs,
  token,
  pageSize = 80,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  port = 0,
  host = "127.0.0.1",
  heartbeatIntervalMs = 2000,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  clientDisconnectGraceMs = DEFAULT_CLIENT_DISCONNECT_GRACE_MS,
  browserShutdownGraceMs = DEFAULT_BROWSER_SHUTDOWN_GRACE_MS,
  closeBrowserTabsOnShutdown = true,
  runCommand = run,
  getBugs = defaultGetBugs,
  getAttachments = defaultGetAttachments,
  getBug = defaultGetBug,
  updateBug = defaultUpdateBug,
  phab = defaultPhab,
  postComment = defaultComment,
  pushCommits = defaultPushCommits,
  getRustUpstreamStatus = getGraphRustUpstreamStatus,
  appConfig = defaultConfig,
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
    graph.knownHashes = new Set(graph.commits.map((commit) => commit.hash));

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

  async function getServerOriginMainStatuses({ force = false } = {}) {
    const statuses = (
      await Promise.all(
        serverGraphs.map((graph) =>
          getServerOriginMainStatus(graph, { force }),
        ),
      )
    ).filter(Boolean);
    statuses.push(await getServerRustUpstreamStatus({ force }));

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

  async function getServerRustUpstreamStatus({ force = false } = {}) {
    const now = Date.now();

    if (!force && isFreshRustUpstreamStatus(now)) {
      return rustUpstreamStatus;
    }

    if (force) {
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

  const server = serverFactory(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

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

      if (
        request.method === "GET" &&
        url.pathname === "/api/origin-main-status"
      ) {
        validateToken(url.searchParams.get("token"), token);
        noteBrowserActivity();
        const statuses = await getServerOriginMainStatuses({
          force: url.searchParams.get("force") === "1",
        });

        sendJson(response, 200, { ok: true, statuses });
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
        });
        sendJson(response, 200, { ok: true, ...integration });
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
          maxDiffBytes,
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

        const session = createGraphSubmitSession({
          graph,
          graphIndex,
          snapshotLimit: getRequestLimit(body.snapshotLimit),
          getSnapshot: getServerGraphSnapshot,
          runCommand,
          postComment,
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

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, resolve);
  });

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
