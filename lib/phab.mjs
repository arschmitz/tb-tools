import config from "./config.mjs";
import { getRevision } from "./git.mjs";
import { readJsonResponse } from "./http.mjs";

const root = "https://phabricator.services.mozilla.com/api/";
const READ_ONLY_ROUTES = new Set([
  "differential.query",
  "project.search",
  "transaction.search",
  "user.query",
  "user.search",
]);
const ROUTE_CACHE_TTLS = new Map([
  ["differential.query", 15 * 1000],
  ["project.search", 30 * 60 * 1000],
  ["transaction.search", 60 * 1000],
  ["user.query", 7 * 24 * 60 * 60 * 1000],
  ["user.search", 30 * 60 * 1000],
]);
const PHABRICATOR_STABLE_ENTITY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PHABRICATOR_ROUTE_SPACING_MS = 125;
const PHABRICATOR_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 1000;
const requestCache = new Map();
const inflightRequests = new Map();
const routeCooldowns = new Map();
const routeNextRequestAt = new Map();
const userQueryCacheByPhid = new Map();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function getRequestKey({ route, params }) {
  return JSON.stringify({
    route,
    params: getSortedObject(params || {}),
  });
}

function cloneResponse(data) {
  return typeof structuredClone === "function"
    ? structuredClone(data)
    : JSON.parse(JSON.stringify(data));
}

function getCacheTtl(route) {
  return ROUTE_CACHE_TTLS.get(route) || 0;
}

function getCachedResponse(key) {
  const cached = requestCache.get(key);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    requestCache.delete(key);
    return null;
  }

  return cloneResponse(cached.data);
}

function setCachedResponse(key, route, data) {
  const ttl = getCacheTtl(route);

  if (!ttl) {
    return;
  }

  requestCache.set(key, {
    data: cloneResponse(data),
    expiresAt: Date.now() + ttl,
  });
}

function getCachedUserQueryResult(phid) {
  const cached = userQueryCacheByPhid.get(phid);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    userQueryCacheByPhid.delete(phid);
    return null;
  }

  return cloneResponse(cached.data);
}

function setCachedUserQueryResult(phid, data) {
  userQueryCacheByPhid.set(phid, {
    data: cloneResponse(data),
    expiresAt: Date.now() + PHABRICATOR_STABLE_ENTITY_CACHE_TTL_MS,
  });
}

export function isPhabricatorRateLimitError(error) {
  return (
    error?.status === 429 ||
    error?.statusCode === 429 ||
    /\b429\b|rate.?limit/i.test(error?.message || "")
  );
}

function getRateLimitCooldown(error) {
  return Number(error?.retryAfterMs) || PHABRICATOR_DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

async function waitForRoute(route) {
  const cooldownUntil = routeCooldowns.get(route) || 0;
  const cooldownWait = cooldownUntil - Date.now();

  if (cooldownWait > 0) {
    const error = new Error(`Phabricator ${route} is temporarily rate limited.`);

    error.statusCode = 429;
    error.retryAfterMs = cooldownWait;
    throw error;
  }

  const now = Date.now();
  const nextAt = Math.max(now, routeNextRequestAt.get(route) || 0);

  routeNextRequestAt.set(route, nextAt + PHABRICATOR_ROUTE_SPACING_MS);

  if (nextAt > now) {
    await delay(nextAt - now);
  }
}

async function fetchPhabricator({ route, params }) {
  if (!config?.phabricator?.token) {
    throw new Error("You must have a Phabricator API token in your configuration.");
  }

  await waitForRoute(route);

  const requestParams = {
    ...params,
    __conduit__: { token: config.phabricator.token },
  };

  let formData = new FormData();

  formData.append("output", "json");
  formData.append("params", JSON.stringify(requestParams));

  let request;

  try {
    request = await fetch(root + route, {
      body: formData,
      method: "post"
    });

    return await readJsonResponse(request, `Phabricator ${route}`);
  } catch (error) {
    if (isPhabricatorRateLimitError(error)) {
      routeCooldowns.set(route, Date.now() + getRateLimitCooldown(error));
    }

    throw error;
  }
}

export function clearPhabricatorRequestState() {
  requestCache.clear();
  inflightRequests.clear();
  routeCooldowns.clear();
  routeNextRequestAt.clear();
  userQueryCacheByPhid.clear();
}

async function requestPhabricatorCached({ route, params }) {
  const canReuse = READ_ONLY_ROUTES.has(route);
  const requestKey = canReuse ? getRequestKey({ route, params }) : "";
  const cached = canReuse ? getCachedResponse(requestKey) : null;

  if (cached) {
    return cached;
  }

  if (canReuse && inflightRequests.has(requestKey)) {
    return cloneResponse(await inflightRequests.get(requestKey));
  }

  const request = fetchPhabricator({ route, params });

  if (canReuse) {
    inflightRequests.set(requestKey, request);
  }

  try {
    const response = await request;

    if (canReuse) {
      setCachedResponse(requestKey, route, response);
    }

    return cloneResponse(response);
  } finally {
    if (canReuse) {
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

async function queryUsersByPhid(params) {
  const phids = Array.from(new Set(params.phids.map(String).filter(Boolean)));
  const resultsByPhid = new Map();
  const missingPhids = [];

  for (const phid of phids) {
    const cached = getCachedUserQueryResult(phid);

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

export default async function phab({ route, params = {} }) {
  if (isUserQueryByPhids({ route, params })) {
    return queryUsersByPhid(params);
  }

  return requestPhabricatorCached({ route, params });
};

export async function comment({ message, resolve, id }) {
  if (!id) {
    const revision = await getRevision();
    id = revision.replace(/^D/, "");
  }
  const result = await phab({
    route: "differential.createcomment",
    params: {
      revision_id: id,
      message,
      attach_inlines: resolve,
    }
  });

  return result;
}
