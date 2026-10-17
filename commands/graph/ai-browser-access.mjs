const connections = new Map();

export function registerConsoleBrowserAccess(server, url, token) {
  connections.set(server, { TB_CONSOLE_BROWSER_URL: url, TB_CONSOLE_BROWSER_TOKEN: token });
  server.once("close", () => connections.delete(server));
}

export function getConsoleBrowserEnvironment() {
  return [...connections.values()].at(-1) || {};
}

export async function readConsolePhabricatorReview(revision, {
  env = process.env, fetchReview = fetch,
} = {}) {
  if (!/^D\d+$/.test(String(revision))) throw new Error("Use a Phabricator revision such as D332509.");
  if (!env.TB_CONSOLE_BROWSER_URL || !env.TB_CONSOLE_BROWSER_TOKEN) {
    throw new Error("This task has no console browser connection. Restart the task from the running console.");
  }
  const url = new URL("api/ai/browser/phabricator", env.TB_CONSOLE_BROWSER_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The console browser connection must use a local HTTP server.");
  }
  url.searchParams.set("revision", revision);
  const response = await fetchReview(url, {
    headers: { "x-tb-console-token": env.TB_CONSOLE_BROWSER_TOKEN },
    signal: AbortSignal.timeout(120_000), redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Console browser read failed (${response.status}).`);
  return result.review;
}
