const BLOCKED_HOSTS = new Set([
  "bugzilla.mozilla.org",
  "phabricator.services.mozilla.com",
]);

const originalFetch = globalThis.fetch;

globalThis.__tbToolsBlockExternalApis = true;
process.env.TB_TOOLS_DISABLE_PERSISTENT_PHAB_STATE = "1";

function getRequestUrl(input) {
  if (typeof input === "string" || input instanceof URL) {
    return new URL(input);
  }

  return new URL(input?.url || "");
}

globalThis.fetch = async (...args) => {
  const url = getRequestUrl(args[0]);

  if (BLOCKED_HOSTS.has(url.hostname)) {
    throw new Error(`External API access is blocked during tests: ${url.hostname}`);
  }

  return originalFetch(...args);
};
