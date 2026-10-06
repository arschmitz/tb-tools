import {
  appendFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import config from "./config.mjs";
import {
  getPhabricatorCachePath,
  readPhabricatorCache,
  writePhabricatorCache,
} from "./phab-cache.mjs";
import { getRevision } from "./git.mjs";
import { readJsonResponse } from "./http.mjs";

const root = "https://phabricator.services.mozilla.com/api/";
const READ_ONLY_ROUTES = new Set([
  "differential.query",
  "differential.getrevision",
  "differential.getrevisioncomments",
  "project.search",
  "transaction.search",
  "user.query",
  "user.search",
]);
const ROUTE_CACHE_TTLS = new Map([
  ["differential.query", 15 * 1000],
  ["differential.getrevision", 30 * 60 * 1000],
  ["differential.getrevisioncomments", 60 * 1000],
  ["project.search", 30 * 60 * 1000],
  ["transaction.search", 60 * 1000],
  ["user.query", 7 * 24 * 60 * 60 * 1000],
  ["user.search", 30 * 60 * 1000],
]);
const PHABRICATOR_ROUTE_SPACING_MS = 125;
const PHABRICATOR_GLOBAL_REQUEST_SPACING_MS = 250;
const PHABRICATOR_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const PHABRICATOR_MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_LIMIT_STATE_FILE_NAME = "phabricator-rate-limit.json";
const REQUEST_LOG_FILE_NAME = "phabricator-request-log.jsonl";
const MAX_RATE_LIMIT_REQUEST_TRACE_ENTRIES = 24;
const MAX_REQUEST_LOG_ENTRIES = 3000;
const MAX_REQUEST_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PERSISTENT_RESPONSE_ENTRIES = 2000;
const MAX_PERSISTENT_USER_ENTRIES = 20000;
const requestCache = new Map();
const inflightRequests = new Map();
const routeCooldowns = new Map();
const routeNextRequestAt = new Map();
const userQueryCacheByPhid = new Map();
let globalCooldownUntil = 0;
let globalNextRequestAt = 0;
let consecutiveRateLimits = 0;
let phabricatorRequestQueue = Promise.resolve();
let rateLimitStateLoaded = false;
let rateLimitStateLoadPromise = null;
let rateLimitStateWritePromise = Promise.resolve();
let requestLogWritePromise = Promise.resolve();
let phabricatorCacheLoaded = false;
let phabricatorCacheLoadPromise = null;
let phabricatorCacheWritePromise = Promise.resolve();
let recentRateLimitRequests = [];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getRateLimitStatePath() {
  return process.env.TB_TOOLS_PHAB_RATE_LIMIT_STATE_PATH || path.join(
    os.homedir(),
    ".tb-tools",
    RATE_LIMIT_STATE_FILE_NAME,
  );
}

function shouldPersistRateLimitState() {
  return Boolean(process.env.TB_TOOLS_PHAB_RATE_LIMIT_STATE_PATH) || (
    process.env.TB_TOOLS_DISABLE_PERSISTENT_PHAB_STATE !== "1" &&
    !process.env.NODE_TEST_CONTEXT && !globalThis.__tbToolsBlockExternalApis
  );
}

function getRequestLogPath() {
  return process.env.TB_TOOLS_PHAB_REQUEST_LOG_PATH || path.join(
    os.homedir(),
    ".tb-tools",
    REQUEST_LOG_FILE_NAME,
  );
}

function shouldPersistPhabricatorCache() {
  return Boolean(getPhabricatorCachePath());
}

function shouldPersistRequestLog() {
  return Boolean(process.env.TB_TOOLS_PHAB_REQUEST_LOG_PATH) || (
    process.env.TB_TOOLS_DISABLE_PERSISTENT_PHAB_STATE !== "1" &&
    !process.env.NODE_TEST_CONTEXT && !globalThis.__tbToolsBlockExternalApis
  );
}

function summarizePhabricatorParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return [key, { kind: "array", size: value.length }];
        }

        if (value && typeof value === "object") {
          return [key, {
            kind: "object",
            keys: Object.keys(value).sort().slice(0, 12),
          }];
        }

        return [key, { kind: typeof value }];
      }),
  );
}

async function compactRequestLog(logPath) {
  try {
    if ((await stat(logPath)).size <= MAX_REQUEST_LOG_BYTES) {
      return;
    }

    const entries = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_REQUEST_LOG_ENTRIES);

    await writeFile(logPath, entries.length ? `${entries.join("\n")}\n` : "", "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function writePhabricatorRequestLog({
  cacheNamespace = "",
  durationMs,
  event,
  params,
  route,
  source,
  statusCode,
  responseHeaders,
  errorDetail,
  retryAfterMs,
}) {
  if (!shouldPersistRequestLog()) {
    return;
  }

  const entry = {
    at: new Date().toISOString(),
    pid: process.pid,
    parentPid: process.ppid,
    activitySource: process.env.TB_TOOLS_PHAB_ACTIVITY_SOURCE ||
      (process.argv.some((arg) => /(?:^|\/)tb\.mjs$/.test(arg)) ? "tb-cli" : "development"),
    cacheNamespace: String(cacheNamespace || ""),
    event,
    ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
    params: summarizePhabricatorParams(params),
    route,
    source,
    ...(Number.isFinite(statusCode) ? { statusCode } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
  };
  const logPath = getRequestLogPath();

  requestLogWritePromise = requestLogWritePromise.catch(() => {}).then(
    async () => {
      try {
        await mkdir(path.dirname(logPath), { recursive: true });
        await compactRequestLog(logPath);
        await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // Request logging must never make Phabricator access less reliable.
      }
    },
  );
}

export async function flushPhabricatorRequestLog() {
  await requestLogWritePromise;
}

// Browser-backed Phabricator actions do not use Node's fetch path. Record the
// console operation here so the durable ledger covers both access methods.
export function recordPhabricatorBrowserActivity({
  durationMs,
  event = "browser-operation",
  operation,
  revision,
  statusCode,
} = {}) {
  const normalizedOperation = String(operation || "unknown").trim() || "unknown";

  writePhabricatorRequestLog({
    cacheNamespace: "browser-session",
    durationMs,
    event,
    params: revision ? { revision: String(revision) } : {},
    route: `browser.${normalizedOperation}`,
    source: "phab-auth",
    statusCode,
  });
}

function getRateLimitRequestTrace(state) {
  return Array.isArray(state?.recentRequests)
    ? state.recentRequests
      .filter((entry) => entry && typeof entry.route === "string")
      .map((entry) => ({
        at: Number(entry.at) || 0,
        route: String(entry.route).slice(0, 120),
        source: String(entry.source || "").slice(0, 240),
      }))
      .slice(-MAX_RATE_LIMIT_REQUEST_TRACE_ENTRIES)
    : [];
}

function getPhabricatorRequestSource() {
  const stack = String(new Error().stack || "").split("\n").slice(1);
  const source = stack.find((line) => (
    !line.includes("/lib/phab.mjs") &&
    (line.includes("/commands/") || line.includes("/lib/"))
  ));

  return source ? source.trim().replace(/^at\s+/, "").slice(0, 240) : "unknown";
}

function recordPhabricatorRequest({ route, source }) {
  recentRateLimitRequests = [
    ...recentRateLimitRequests,
    { at: Date.now(), route, source },
  ].slice(-MAX_RATE_LIMIT_REQUEST_TRACE_ENTRIES);
}

async function loadPersistedRateLimitState() {
  if (!shouldPersistRateLimitState() || rateLimitStateLoaded) {
    return;
  }

  if (!rateLimitStateLoadPromise) {
    rateLimitStateLoadPromise = (async () => {
      try {
        const contents = await readFile(getRateLimitStatePath(), "utf8");
        const state = JSON.parse(contents);
        const cooldownUntil = Number(state?.globalCooldownUntil || 0);

        recentRateLimitRequests = getRateLimitRequestTrace(state);

        if (cooldownUntil > Date.now()) {
          globalCooldownUntil = Math.max(globalCooldownUntil, cooldownUntil);
        }
      } catch {
        // A missing or malformed optional state file must not block normal use.
      } finally {
        rateLimitStateLoaded = true;
      }
    })();
  }

  await rateLimitStateLoadPromise;
}

async function persistRateLimitState() {
  if (!shouldPersistRateLimitState()) {
    return;
  }

  const statePath = getRateLimitStatePath();
  const state = JSON.stringify({
    globalCooldownUntil,
    recentRequests: recentRateLimitRequests,
  });

  rateLimitStateWritePromise = rateLimitStateWritePromise.catch(() => {}).then(
    async () => {
      try {
        await mkdir(path.dirname(statePath), { recursive: true });
        await writeFile(statePath, state, "utf8");
      } catch {
        // Rate-limit protection remains useful in memory when local storage fails.
      }
    },
  );
  await rateLimitStateWritePromise;
}

function getSortedObject(value) {
  if (Array.isArray(value)) {
    return value.map(getSortedObject);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, getSortedObject(value[key])]),
  );
}

function getRequestKey({ route, params, cacheNamespace = "" }) {
  return JSON.stringify({
    cacheNamespace,
    route,
    params: getSortedObject(params || {}),
  });
}

function cloneResponse(data) {
  return typeof structuredClone === "function"
    ? structuredClone(data)
    : JSON.parse(JSON.stringify(data));
}

function getCacheTtl(route, cacheTtlMs) {
  const requestedTtl = Number(cacheTtlMs) || 0;

  return requestedTtl > 0 ? requestedTtl : (ROUTE_CACHE_TTLS.get(route) || 0);
}

function getCacheExpiry(entry = {}) {
  const expiresAt = Number(entry.expiresAt) || 0;

  return expiresAt > 0 ? expiresAt : 0;
}

function isCacheEntryFresh(entry = {}, now = Date.now()) {
  const expiresAt = getCacheExpiry(entry);

  return !expiresAt || expiresAt > now;
}

function limitCacheEntries(entries, limit) {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([, first], [, second]) => (
        Number(second.checkedAt) - Number(first.checkedAt)
      ))
      .slice(0, limit),
  );
}

function isClosedRevisionStatus(value) {
  return new Set(["abandoned", "closed", "landed"]).has(
    String(value || "").trim().toLowerCase(),
  );
}

function isImmutableRevisionResponse(route, response = {}) {
  const result = response?.result;

  if (route === "differential.query" && Array.isArray(result) && result.length) {
    return result.every((revision) => isClosedRevisionStatus(
      revision?.status || revision?.statusName,
    ));
  }

  if (route !== "differential.getrevision") {
    return false;
  }

  return isClosedRevisionStatus(
    result?.revision?.status ||
    result?.revision?.statusName ||
    result?.status ||
    result?.statusName,
  );
}

async function loadPersistedPhabricatorCache() {
  if (!shouldPersistPhabricatorCache() || phabricatorCacheLoaded) {
    return;
  }

  if (!phabricatorCacheLoadPromise) {
    phabricatorCacheLoadPromise = (async () => {
      const cache = await readPhabricatorCache();
      const now = Date.now();

      for (const [key, entry] of Object.entries(cache.responses)) {
        if (!entry?.data || (!isPersistentIdentityRoute(getCachedRoute(key)) && !isCacheEntryFresh(entry, now))) {
          continue;
        }

        requestCache.set(key, {
          checkedAt: Number(entry.checkedAt) || now,
          data: cloneResponse(entry.data),
          expiresAt: isPersistentIdentityRoute(getCachedRoute(key)) ? 0 : getCacheExpiry(entry),
        });
      }

      for (const [phid, entry] of Object.entries(cache.usersByPhid)) {
        if (!entry?.data) {
          continue;
        }

        userQueryCacheByPhid.set(phid, {
          checkedAt: Number(entry.checkedAt) || now,
          data: cloneResponse(entry.data),
          expiresAt: 0,
        });
      }

      phabricatorCacheLoaded = true;
    })();
  }

  await phabricatorCacheLoadPromise;
}

function getPersistentPhabricatorCacheStore() {
  const now = Date.now();
  const responses = {};
  const usersByPhid = {};

  for (const [key, entry] of requestCache) {
    if (!entry?.data || !isCacheEntryFresh(entry, now)) {
      continue;
    }

    responses[key] = {
      checkedAt: Number(entry.checkedAt) || now,
      data: cloneResponse(entry.data),
      expiresAt: getCacheExpiry(entry),
    };
  }

  for (const [phid, entry] of userQueryCacheByPhid) {
    if (!phid || !entry?.data) {
      continue;
    }

    usersByPhid[phid] = {
      checkedAt: Number(entry.checkedAt) || now,
      data: cloneResponse(entry.data),
    };
  }

  return {
    responses: limitCacheEntries(responses, MAX_PERSISTENT_RESPONSE_ENTRIES),
    usersByPhid: limitCacheEntries(usersByPhid, MAX_PERSISTENT_USER_ENTRIES),
  };
}

function persistPhabricatorCache() {
  if (!shouldPersistPhabricatorCache()) {
    return;
  }

  phabricatorCacheWritePromise = phabricatorCacheWritePromise.catch(() => {}).then(
    () => writePhabricatorCache({ store: getPersistentPhabricatorCacheStore() }),
  );
}

export async function flushPhabricatorCache() {
  await phabricatorCacheWritePromise;
}

// This endpoint uses Bugzilla's credentials, not the user's Conduit token.
export function logBugzillaRevisionRequest(entry) {
  writePhabricatorRequestLog({ ...entry, source: "bugzilla-revision-pane", route: "bugzilla.phabbugz.bug_revisions" });
}

export async function getCachedBugzillaRevisions(bugId) {
  await loadPersistedPhabricatorCache();
  return getCachedResponse(getRequestKey({ route: "bugzilla.phabbugz.bug_revisions", params: { ids: [String(bugId)] } }));
}

export async function cacheBugzillaRevisions(bugId, data) {
  await loadPersistedPhabricatorCache();
  const route = "bugzilla.phabbugz.bug_revisions";
  setCachedResponse(getRequestKey({ route, params: { ids: [String(bugId)] } }), route, data, 15 * 60 * 1000);
  await flushPhabricatorCache();
}

export async function findCachedReviewer(name) {
  await loadPersistedPhabricatorCache();
  const key = String(name || "").replace(/^#/, "").trim().toLowerCase();
  const matches = new Map();
  const add = (phid, names, type) => {
    if (phid && names.some((value) => value && String(value).replace(/^#/, "").toLowerCase() === key)) {
      matches.set(phid, { phid, type });
    }
  };
  const addUser = (user) => add(user.phid, [user.userName, user.username], "user");
  for (const entry of userQueryCacheByPhid.values()) {
    addUser(entry.data);
  }
  for (const [requestKey, entry] of requestCache) {
    const route = getCachedRoute(requestKey);
    if (route === "user.query") {
      for (const user of entry.data.result || []) addUser(user);
    } else if (route === "project.search" || route === "user.search") {
      for (const item of entry.data.result?.data || []) {
        add(item.phid, route === "project.search" ? [item.fields?.name, item.fields?.slug] : [item.fields?.username], route === "project.search" ? "group" : "user");
      }
    }
  }
  // Do not guess when a group and a user share a name.
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function getCachedResponse(key) {
  const cached = requestCache.get(key);

  if (!cached) {
    return null;
  }

  if (!isCacheEntryFresh(cached)) {
    requestCache.delete(key);
    persistPhabricatorCache();
    return null;
  }

  return cloneResponse(cached.data);
}

function setCachedResponse(key, route, data, cacheTtlMs) {
  const ttl = getCacheTtl(route, cacheTtlMs);

  if (!ttl && !isImmutableRevisionResponse(route, data)) {
    return;
  }

  requestCache.set(key, {
    checkedAt: Date.now(),
    data: cloneResponse(data),
    expiresAt: isPersistentIdentityRoute(route) || isImmutableRevisionResponse(route, data) ? 0 : Date.now() + ttl,
  });
  persistPhabricatorCache();
}

function getCachedUserQueryResult(phid) {
  const cached = userQueryCacheByPhid.get(phid);

  if (!cached) {
    return null;
  }

  if (!isCacheEntryFresh(cached)) {
    userQueryCacheByPhid.delete(phid);
    persistPhabricatorCache();
    return null;
  }

  return cloneResponse(cached.data);
}

function setCachedUserQueryResult(phid, data) {
  userQueryCacheByPhid.set(phid, {
    checkedAt: Date.now(),
    data: cloneResponse(data),
    // PHID user identities are stable enough to retain until a user requests
    // a refresh from the cache page.
    expiresAt: 0,
  });
  persistPhabricatorCache();
}

export function isPhabricatorRateLimitError(error) {
  return (
    error?.status === 429 ||
    error?.statusCode === 429 ||
    /\b429\b|rate.?limit/i.test(error?.message || "")
  );
}

function getRateLimitCooldown(error) {
  const requestedCooldown = Number(error?.retryAfterMs) || 0;
  const backoffMultiplier = 2 ** Math.min(consecutiveRateLimits - 1, 3);
  const exponentialCooldown = Math.min(
    PHABRICATOR_DEFAULT_RATE_LIMIT_COOLDOWN_MS * backoffMultiplier,
    PHABRICATOR_MAX_RATE_LIMIT_COOLDOWN_MS,
  );

  return Math.max(requestedCooldown, exponentialCooldown);
}

function createRateLimitError({ route, retryAfterMs, global = false }) {
  const subject = global ? "requests are" : `${route} is`;
  const error = new Error(`Phabricator ${subject} temporarily rate limited.`);

  error.statusCode = 429;
  error.retryAfterMs = retryAfterMs;
  error.isLocalPhabricatorCooldown = true;
  return error;
}

async function waitForPhabricatorRequest(route) {
  await loadPersistedRateLimitState();

  const now = Date.now();
  const routeCooldownUntil = routeCooldowns.get(route) || 0;
  const cooldownUntil = Math.max(routeCooldownUntil, globalCooldownUntil);
  const cooldownWait = cooldownUntil - now;

  if (cooldownWait > 0) {
    throw createRateLimitError({
      route,
      retryAfterMs: cooldownWait,
      global: globalCooldownUntil >= routeCooldownUntil,
    });
  }

  const nextAt = Math.max(
    now,
    routeNextRequestAt.get(route) || 0,
    globalNextRequestAt,
  );

  routeNextRequestAt.set(route, nextAt + PHABRICATOR_ROUTE_SPACING_MS);
  globalNextRequestAt = nextAt + PHABRICATOR_GLOBAL_REQUEST_SPACING_MS;

  if (nextAt > now) {
    await delay(nextAt - now);
  }
}

function enqueuePhabricatorRequest(request) {
  const queuedRequest = phabricatorRequestQueue.then(request, request);

  // Keep processing later requests when an earlier network request fails.
  phabricatorRequestQueue = queuedRequest.catch(() => {});
  return queuedRequest;
}

async function fetchPhabricator({
  cacheNamespace,
  params,
  route,
  source,
}) {
  if (!config?.phabricator?.token) {
    throw new Error("You must have a Phabricator API token in your configuration.");
  }

  return enqueuePhabricatorRequest(async () => {
    const startedAt = Date.now();
    let responseHeaders;

    try {
      await waitForPhabricatorRequest(route);
      const requestParams = {
        ...params,
        __conduit__: { token: config.phabricator.token },
      };
      const formData = new FormData();

      formData.append("output", "json");
      formData.append("params", JSON.stringify(requestParams));
      recordPhabricatorRequest({ route, source });
      writePhabricatorRequestLog({
        cacheNamespace,
        event: "network-start",
        params,
        route,
        source,
      });

      const request = await fetch(root + route, {
        body: formData,
        method: "post"
      });
      responseHeaders = Object.fromEntries([
        "server", "date", "content-type", "retry-after", "cf-ray", "x-cache", "x-request-id",
      ].flatMap((name) => {
        const value = request.headers?.get?.(name);

        return value ? [[name, value.slice(0, 256)]] : [];
      }));

      const response = await readJsonResponse(request, `Phabricator ${route}`);

      consecutiveRateLimits = 0;
      writePhabricatorRequestLog({
        cacheNamespace,
        durationMs: Date.now() - startedAt,
        event: "network-success",
        params,
        route,
        source,
        statusCode: request.status,
      });
      return response;
    } catch (error) {
      if (
        isPhabricatorRateLimitError(error) &&
        !error?.isLocalPhabricatorCooldown
      ) {
        consecutiveRateLimits++;
        const cooldownUntil = Date.now() + getRateLimitCooldown(error);

        routeCooldowns.set(route, cooldownUntil);
        globalCooldownUntil = Math.max(globalCooldownUntil, cooldownUntil);
        await persistRateLimitState();
      }

      writePhabricatorRequestLog({
        cacheNamespace,
        durationMs: Date.now() - startedAt,
        event: error?.isLocalPhabricatorCooldown ? "local-cooldown" : "network-error",
        params,
        route,
        source,
        statusCode: Number(error?.statusCode || error?.status) || undefined,
        responseHeaders,
        errorDetail: String(error?.message || error)
          .replaceAll(config.phabricator.token, "[redacted]")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 2048),
        retryAfterMs: Number(error?.retryAfterMs) || 0,
      });

      throw error;
    }
  });
}

export function clearPhabricatorRequestState() {
  requestCache.clear();
  inflightRequests.clear();
  routeCooldowns.clear();
  routeNextRequestAt.clear();
  userQueryCacheByPhid.clear();
  globalCooldownUntil = 0;
  globalNextRequestAt = 0;
  consecutiveRateLimits = 0;
  phabricatorRequestQueue = Promise.resolve();
  rateLimitStateLoaded = false;
  rateLimitStateLoadPromise = null;
  rateLimitStateWritePromise = Promise.resolve();
  phabricatorCacheLoaded = false;
  phabricatorCacheLoadPromise = null;
  phabricatorCacheWritePromise = Promise.resolve();
  recentRateLimitRequests = [];
}

function getCachedRoute(key) {
  try {
    return String(JSON.parse(key)?.route || "");
  } catch {
    return "";
  }
}

function isPersistentIdentityRoute(route) {
  return ["user.query", "user.search", "project.search"].includes(route);
}

function getCacheCategoryForRoute(route) {
  if (isPersistentIdentityRoute(route)) {
    return "identities";
  }

  if (new Set([
    "differential.getrevision",
    "differential.getrevisioncomments",
    "transaction.search",
  ]).has(route)) {
    return "revision-history";
  }

  return "revision-status";
}

export async function getPhabricatorCacheStatus() {
  await loadPersistedPhabricatorCache();
  const now = Date.now();
  const categories = new Map([
    ["identities", { entries: 0, immutable: true }],
    ["revision-history", { entries: 0, immutable: false }],
    ["revision-status", { entries: 0, immutable: false }],
  ]);

  for (const [key, entry] of requestCache) {
    if (!entry?.data || !isCacheEntryFresh(entry, now)) {
      continue;
    }

    const route = getCachedRoute(key);

    if (route === "user.query") {
      continue;
    }

    const category = getCacheCategoryForRoute(route);

    categories.get(category).entries++;
  }

  categories.get("identities").entries += userQueryCacheByPhid.size;

  return {
    enabled: shouldPersistPhabricatorCache(),
    path: getPhabricatorCachePath(),
    categories: Object.fromEntries(categories),
  };
}

export async function clearPhabricatorCache({ category = "all" } = {}) {
  await loadPersistedPhabricatorCache();
  const requestedCategory = String(category || "all");
  const validCategories = new Set([
    "all",
    "identities",
    "revision-history",
    "revision-status",
  ]);

  if (!validCategories.has(requestedCategory)) {
    throw new Error("Unknown Phabricator cache category.");
  }

  for (const [key] of requestCache) {
    const entryCategory = getCacheCategoryForRoute(getCachedRoute(key));

    if (requestedCategory === "all" || entryCategory === requestedCategory) {
      requestCache.delete(key);
    }
  }

  if (requestedCategory === "all" || requestedCategory === "identities") {
    userQueryCacheByPhid.clear();
  }

  persistPhabricatorCache();
  await flushPhabricatorCache();
  return getPhabricatorCacheStatus();
}

async function requestPhabricatorCached({
  route,
  params,
  bypassCache = false,
  cacheNamespace,
  cacheTtlMs,
}) {
  const canReuse = READ_ONLY_ROUTES.has(route) && !isUserQueryByPhids({ route, params });
  await loadPersistedPhabricatorCache();
  const source = getPhabricatorRequestSource();
  const requestKey = canReuse ? getRequestKey({ route, params, cacheNamespace }) : "";
  const cached = canReuse && !bypassCache ? getCachedResponse(requestKey) : null;

  if (cached) {
    writePhabricatorRequestLog({
      cacheNamespace,
      event: "cache-hit",
      params,
      route,
      source,
    });
    return cached;
  }

  if (canReuse && !bypassCache && inflightRequests.has(requestKey)) {
    writePhabricatorRequestLog({
      cacheNamespace,
      event: "inflight-hit",
      params,
      route,
      source,
    });
    return cloneResponse(await inflightRequests.get(requestKey));
  }

  writePhabricatorRequestLog({
    cacheNamespace,
    event: bypassCache ? "cache-bypassed" : "cache-miss",
    params,
    route,
    source,
  });
  const request = fetchPhabricator({
    cacheNamespace,
    params,
    route,
    source,
  });

  if (canReuse && !bypassCache) {
    inflightRequests.set(requestKey, request);
  }

  try {
    const response = await request;

    if (canReuse) {
      setCachedResponse(requestKey, route, response, cacheTtlMs);
    }

    return cloneResponse(response);
  } finally {
    if (canReuse && !bypassCache) {
      inflightRequests.delete(requestKey);
    }
  }
}

function isUserQueryByPhids({ route, params }) {
  const keys = Object.keys(params || {});

  return (
    route === "user.query" &&
    Array.isArray(params?.phids) &&
    keys.every((key) => key === "phids")
  );
}

async function queryUsersByPhid(params, { bypassCache = false } = {}) {
  await loadPersistedPhabricatorCache();
  const phids = Array.from(new Set(params.phids.map(String).filter(Boolean)));
  const resultsByPhid = new Map();
  const missingPhids = [];

  for (const phid of phids) {
    const cached = bypassCache ? null : getCachedUserQueryResult(phid);

    if (cached) {
      resultsByPhid.set(phid, cached);
    } else {
      missingPhids.push(phid);
    }
  }

  if (missingPhids.length) {
    const response = await requestPhabricatorCached({
      route: "user.query",
      params: {
        phids: missingPhids,
      },
      bypassCache,
    });

    for (const [index, reviewer] of (response.result || []).entries()) {
      const phid = reviewer.phid || missingPhids[index];

      setCachedUserQueryResult(phid, reviewer);
      resultsByPhid.set(phid, reviewer);
    }
  }

  return {
    result: phids
      .map((phid) => resultsByPhid.get(phid))
      .filter(Boolean)
      .map(cloneResponse),
  };
}

export default async function phab({
  route,
  params = {},
  bypassCache,
  cacheNamespace,
  cacheTtlMs,
}) {
  if (isUserQueryByPhids({ route, params })) {
    return queryUsersByPhid(params, { bypassCache });
  }

  return requestPhabricatorCached({
    route,
    params,
    bypassCache,
    cacheNamespace,
    cacheTtlMs,
  });
};

export async function comment({ message, resolve, id, action = "comment" }) {
  if (!id) {
    const revision = await getRevision();
    id = revision.replace(/^D/, "");
  }

  id = String(id).replace(/^D/i, "");
  const result = await phab({
    route: "differential.createcomment",
    params: {
      revision_id: id,
      message,
      action,
      attach_inlines: resolve,
    }
  });

  return result;
}

export async function editRevision({ id, message = "", action = "comment" }) {
  const normalizedId = String(id || "").trim().replace(/^D/i, "");
  const normalizedAction = String(action || "comment").trim().toLowerCase();
  const content = String(message || "").trim();

  if (!/^\d+$/.test(normalizedId)) {
    throw new Error("A valid Phabricator revision is required.");
  }

  if (!new Set(["comment", "accept", "reject"]).has(normalizedAction)) {
    throw new Error("Choose Comment, Accept, or Request Changes for the final review.");
  }

  const transactions = [
    ...(content ? [{ type: "comment", value: content }] : []),
    ...(normalizedAction === "comment"
      ? []
      : [{ type: normalizedAction, value: true }]),
  ];

  if (!transactions.length) {
    throw new Error("A comment or final review action is required.");
  }

  return phab({
    route: "differential.revision.edit",
    params: {
      objectIdentifier: `D${normalizedId}`,
      transactions,
    },
  });
}

export async function createInlineComment({
  revision,
  diffId,
  filePath,
  isNewFile = true,
  lineNumber,
  lineLength = 1,
  content,
}) {
  const revisionId = String(revision || "").replace(/^D/i, "");
  const normalizedLine = Number(lineNumber);

  if (!/^\d+$/.test(revisionId)) {
    throw new Error("A valid Phabricator revision is required for an inline comment.");
  }

  if (!String(filePath || "").trim() || !Number.isInteger(normalizedLine) || normalizedLine < 1) {
    throw new Error("A file path and valid new-side line are required for an inline comment.");
  }

  if (!String(content || "").trim()) {
    throw new Error("Inline comment content is required.");
  }

  return phab({
    route: "differential.createinline",
    params: {
      revisionID: Number(revisionId),
      ...(Number.isInteger(Number(diffId)) && Number(diffId) > 0
        ? { diffID: Number(diffId) }
        : {}),
      filePath: String(filePath),
      isNewFile: Boolean(isNewFile),
      lineNumber: normalizedLine,
      lineLength: Math.max(1, Number(lineLength) || 1),
      content: String(content).trim(),
    },
  });
}
