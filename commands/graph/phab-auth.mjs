import { access, chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordPhabricatorBrowserActivity } from "../../lib/phab.mjs";
import { markWebInlineDone, publishWebReview, readWebReview, saveWebInline } from "./phab-web-review.mjs";

export const PHABRICATOR_WEB_URL = "https://phabricator.services.mozilla.com/";
export const PHABRICATOR_LOGIN_URL = `${PHABRICATOR_WEB_URL}auth/login/`;
export const PHABRICATOR_AUTHENTICATION_CHECK_URL = `${PHABRICATOR_WEB_URL}settings/`;

function getBrowserErrorStatusCode(error) {
  const directStatus = Number(error?.statusCode || error?.status);

  if (Number.isFinite(directStatus) && directStatus >= 100 && directStatus <= 599) {
    return directStatus;
  }

  const match = String(error?.message || "").match(/\b([1-5]\d\d)\b/);
  const parsedStatus = Number(match?.[1] || 0);

  return parsedStatus >= 100 && parsedStatus <= 599 ? parsedStatus : undefined;
}

async function navigatePhabricatorPage(page, {
  operation,
  revision,
  url,
  waitUntil = "domcontentloaded",
} = {}) {
  const startedAt = Date.now();

  recordPhabricatorBrowserActivity({
    event: "browser-navigation-start",
    operation,
    revision,
  });

  try {
    const response = await page.goto(url, { waitUntil });
    const statusCode = Number(response?.status?.());
    const hasErrorStatus = Number.isFinite(statusCode) && statusCode >= 400;

    recordPhabricatorBrowserActivity({
      durationMs: Date.now() - startedAt,
      event: hasErrorStatus ? "browser-navigation-error" : "browser-navigation-success",
      operation,
      revision,
      statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
    });
    return response;
  } catch (error) {
    recordPhabricatorBrowserActivity({
      durationMs: Date.now() - startedAt,
      event: "browser-navigation-error",
      operation,
      revision,
      statusCode: getBrowserErrorStatusCode(error),
    });
    throw error;
  }
}

const DEFAULT_SUGGESTION_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_STATUS_CACHE_MS = 60 * 1000;

function getPhabricatorProfilePath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".tb-tools", "phabricator-browser");
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRevision(revision) {
  const value = String(revision || "").trim().toUpperCase();

  return /^D\d+$/.test(value) ? value : "";
}

function normalizeInlineComments(inlineComments = []) {
  const commentsById = new Map();

  for (const comment of inlineComments) {
    const id = String(comment?.id || "").trim();
    const diffId = Number(comment?.diffId);

    if (!id || commentsById.has(id)) {
      continue;
    }

    commentsById.set(id, {
      id,
      diffId: Number.isInteger(diffId) && diffId > 0 ? diffId : null,
    });
  }

  return [...commentsById.values()];
}

function getRevisionUrl(revision, webUrl, diffId = null) {
  const url = new URL(revision, webUrl);

  if (diffId) {
    url.searchParams.set("id", String(diffId));
  }

  return url.toString();
}

function createBrowserUnavailableError(error) {
  const unavailable = new Error(
    "Phabricator authentication needs Playwright and a Chromium-based browser. " +
      "Install the dependency, then run `npx playwright install chromium` if Chrome or Edge is not available.",
  );

  unavailable.cause = error;
  return unavailable;
}

function normalizeInlineReply({
  commentPHID,
  message,
  revision,
} = {}) {
  const normalizedRevision = normalizeRevision(revision);
  const parentCommentPHID = String(commentPHID || "").trim();
  const content = String(message || "").trim();

  if (!normalizedRevision) {
    throw new Error("A valid Phabricator revision is required to post an inline reply.");
  }

  if (!/^PHID-XCMT-/i.test(parentCommentPHID)) {
    throw new Error(
      "Phabricator did not provide an inline parent comment for this feedback. " +
        "TB Tools will not post a detached reply.",
    );
  }

  if (!content) {
    throw new Error("An inline reply cannot be empty.");
  }

  return { content, normalizedRevision, parentCommentPHID };
}

function normalizeInlineCommentReference({ commentPHID, revision } = {}) {
  const normalizedRevision = normalizeRevision(revision);
  const parentCommentPHID = String(commentPHID || "").trim();

  if (!normalizedRevision) {
    throw new Error("A valid Phabricator revision is required to mark an inline comment done.");
  }

  if (!/^PHID-XCMT-/i.test(parentCommentPHID)) {
    throw new Error("Phabricator did not provide an inline parent comment for this feedback.");
  }

  return { normalizedRevision, parentCommentPHID };
}

async function loadPlaywrightChromium() {
  if (globalThis.__tbToolsBlockExternalApis || process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      "Phabricator browser access is blocked during tests. Inject a test browser instead.",
    );
  }

  try {
    const playwright = await import("playwright");

    return playwright.chromium;
  } catch (error) {
    throw createBrowserUnavailableError(error);
  }
}

export async function getPhabricatorPageAuthenticationState(page) {
  return page.evaluate((phabricatorOrigin) => {
    const document = globalThis.document;

    return globalThis.location.origin === phabricatorOrigin &&
      !document.querySelector("form[action*='/auth/login/']") &&
      document.title !== "Login";
  }, new URL(PHABRICATOR_WEB_URL).origin);
}

export async function getPhabricatorPageSuggestions(page) {
  return page.evaluate(() => {
    const document = globalThis.document;
    const suggestions = {};

    function getCellText(cell) {
      const copy = cell.cloneNode(true);

      copy.querySelectorAll("[data-aural]").forEach((node) => node.remove());
      return String(copy.textContent || "").replace(/\r?\n$/, "");
    }

    for (const anchor of document.querySelectorAll(
      ".differential-inline-comment-anchor[id^='inline-']",
    )) {
      const inlineId = String(anchor.id || "").replace(/^inline-/, "");
      const inline = anchor.nextElementSibling?.matches(
        ".differential-inline-comment",
      )
        ? anchor.nextElementSibling
        : anchor.parentElement?.querySelector(
          ".differential-inline-comment",
        );
      const suggestion = inline?.querySelector(".inline-suggestion-view");

      if (!inlineId || !suggestion) {
        continue;
      }

      const newLines = Array.from(suggestion.querySelectorAll("td.new"))
        .map(getCellText);
      const isDeletion = !newLines.length && Boolean(
        suggestion.querySelector("td.old"),
      );

      if (!newLines.length && !isDeletion) {
        continue;
      }

      suggestions[inlineId] = {
        content: newLines.join("\n"),
        isDeletion,
      };
    }

    return suggestions;
  });
}

function toSuggestionMap(suggestions) {
  return new Map(Object.entries(suggestions || {}));
}

export function createPhabricatorWebSession({
  browserLoader = loadPlaywrightChromium,
  getPageAuthenticationState = getPhabricatorPageAuthenticationState,
  getPageSuggestions = getPhabricatorPageSuggestions,
  homeDirectory = os.homedir(),
  webUrl = PHABRICATOR_WEB_URL,
  authenticationCheckUrl = new URL("settings/", webUrl).toString(),
  loginUrl = PHABRICATOR_LOGIN_URL,
  profilePath = getPhabricatorProfilePath(homeDirectory),
  suggestionCacheMs = DEFAULT_SUGGESTION_CACHE_MS,
  statusCacheMs = DEFAULT_STATUS_CACHE_MS,
} = {}) {
  let authContext;
  let authPage;
  let sessionStorageState;
  let state = "disconnected";
  let message = "Not connected to Phabricator.";
  let statusPromise;
  let statusCheckedAt = 0;
  const suggestionCache = new Map();
  const suggestionInflight = new Map();

  async function ensureProfileDirectory() {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
  }

  async function launchContext({ headless }) {
    await ensureProfileDirectory();
    const chromium = await browserLoader();
    const variants = [
      { channel: "chrome" },
      { channel: "msedge" },
      {},
    ];
    let lastError;

    for (const variant of variants) {
      try {
        return await chromium.launchPersistentContext(profilePath, {
          ...variant,
          headless,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw createBrowserUnavailableError(lastError);
  }

  async function getContextPage(context) {
    return context.pages()[0] || context.newPage();
  }

  async function closeAuthenticationWindow() {
    const context = authContext;

    authContext = undefined;
    authPage = undefined;
    await context?.close();
  }

  async function pageIsAuthenticated(page) {
    try {
      return Boolean(await getPageAuthenticationState(page));
    } catch {
      return false;
    }
  }

  async function getAuthenticatedAuthenticationPage() {
    if (!authContext) {
      return null;
    }

    for (const page of authContext.pages()) {
      if (await pageIsAuthenticated(page)) {
        return page;
      }
    }

    return null;
  }

  async function verifyInteractiveAuthentication() {
    const page = await getAuthenticatedAuthenticationPage();

    if (!page) {
      return false;
    }

    try {
      authPage = page;
      await navigatePhabricatorPage(page, {
        operation: "verify-interactive-session",
        url: authenticationCheckUrl,
      });
      if (!await pageIsAuthenticated(page)) {
        return false;
      }

      sessionStorageState = await authContext.storageState();
      return true;
    } catch {
      return false;
    }
  }

  function getCurrentStatus() {
    return { state, message };
  }

  async function verifyStoredSession() {
    if (statusPromise) {
      return statusPromise;
    }

    statusPromise = (async () => {
      if (!await pathExists(profilePath)) {
        state = "disconnected";
        message = "Not connected to Phabricator.";
        statusCheckedAt = Date.now();
        return getCurrentStatus();
      }

      let context;

      try {
        context = await launchContext({ headless: true });
        const page = await getContextPage(context);

        await navigatePhabricatorPage(page, {
          operation: "verify-stored-session",
          url: authenticationCheckUrl,
        });
        if (await pageIsAuthenticated(page)) {
          sessionStorageState = await context.storageState();
          state = "connected";
          message = "Connected to Phabricator for this console session.";
        } else {
          state = "disconnected";
          message = "Sign in to Phabricator to show inline code suggestions.";
        }
      } catch (error) {
        state = "error";
        message = String(error?.message || error);
      } finally {
        await context?.close();
        statusCheckedAt = Date.now();
      }

      return getCurrentStatus();
    })().finally(() => {
      statusPromise = undefined;
    });

    return statusPromise;
  }

  async function getStatus({ force = false } = {}) {
    if (authContext && authPage) {
      if (
        state === "connected" &&
        !force &&
        statusCheckedAt &&
        Date.now() - statusCheckedAt < statusCacheMs
      ) {
        return getCurrentStatus();
      }

      if (await verifyInteractiveAuthentication()) {
        await closeAuthenticationWindow();
        state = "connected";
        message = "Connected to Phabricator for this console session.";
        statusCheckedAt = Date.now();
      } else if (state === "connected") {
        await closeAuthenticationWindow();
        state = "disconnected";
        message = "The Phabricator browser session ended. Authenticate again to show inline code suggestions.";
      } else {
        state = "pending";
        message = "Finish signing in to Phabricator in the browser window.";
      }

      return getCurrentStatus();
    }

    if (sessionStorageState && state === "connected") {
      return getCurrentStatus();
    }

    if (
      !force &&
      statusCheckedAt &&
      Date.now() - statusCheckedAt < statusCacheMs
    ) {
      return getCurrentStatus();
    }

    return verifyStoredSession();
  }

  async function startAuthentication() {
    if (statusPromise) {
      await statusPromise.catch(() => {});
    }

    await closeAuthenticationWindow();
    sessionStorageState = undefined;
    const context = await launchContext({ headless: false });

    authContext = context;
    authPage = await getContextPage(context);

    try {
      await navigatePhabricatorPage(authPage, {
        operation: "start-authentication",
        url: loginUrl,
      });
      state = "pending";
      message = "Finish signing in to Phabricator in the browser window.";
      statusCheckedAt = 0;
      return getCurrentStatus();
    } catch (error) {
      await closeAuthenticationWindow();
      state = "error";
      message = String(error?.message || error);
      return getCurrentStatus();
    }
  }

  async function cancelAuthentication() {
    await closeAuthenticationWindow();
    return getStatus({ force: true });
  }

  async function signOut() {
    await closeAuthenticationWindow();
    await rm(profilePath, { force: true, recursive: true });
    suggestionCache.clear();
    suggestionInflight.clear();
    sessionStorageState = undefined;
    state = "disconnected";
    message = "Signed out of Phabricator.";
    statusCheckedAt = Date.now();
    return getCurrentStatus();
  }

  async function fetchSuggestions(revision, inlineComments, cached) {
    const context = await launchContext({ headless: true });

    try {
      if (sessionStorageState?.cookies?.length) {
        await context.addCookies(sessionStorageState.cookies);
      }

      const page = await getContextPage(context);

      async function fetchSuggestionPage(pageToUse, url) {
        await navigatePhabricatorPage(pageToUse, {
          operation: "load-suggestions",
          revision,
          url,
          waitUntil: "networkidle",
        });
        if (!await pageIsAuthenticated(pageToUse)) {
          state = "disconnected";
          sessionStorageState = undefined;
          message = "Phabricator sign-in expired. Authenticate again to show inline code suggestions.";
          return false;
        }

        for (const [id, suggestion] of toSuggestionMap(
          await getPageSuggestions(pageToUse),
        )) {
          cached.suggestions.set(id, suggestion);
        }

        return true;
      }

      if (!cached.fetchedDefault) {
        const fetched = await fetchSuggestionPage(
          page,
          getRevisionUrl(revision, webUrl),
        );

        if (!fetched) {
          return cached.suggestions;
        }

        cached.fetchedDefault = true;
      }

      const missingCommentsByDiff = new Map();

      for (const { id, diffId } of inlineComments) {
        if (
          diffId &&
          !cached.suggestions.has(id) &&
          !cached.fetchedDiffIds.has(diffId)
        ) {
          const comments = missingCommentsByDiff.get(diffId) || [];

          comments.push(id);
          missingCommentsByDiff.set(diffId, comments);
        }
      }

      const missingDiffs = [...missingCommentsByDiff];
      for (const [diffId] of missingDiffs) {
        const diffPage = await context.newPage();

        try {
          const fetched = await fetchSuggestionPage(
            diffPage,
            getRevisionUrl(revision, webUrl, diffId),
          );

          if (!fetched) {
            return cached.suggestions;
          }

          cached.fetchedDiffIds.add(diffId);
        } finally {
          await diffPage.close();
        }
      }

      return cached.suggestions;
    } finally {
      await context.close();
    }
  }

  let reviewOperation = Promise.resolve();
  const reviewInflight = new Map();

  function queueBrowserOperation(callback) {
    const request = reviewOperation.catch(() => {}).then(callback);
    reviewOperation = request;
    return request;
  }

  function withRevisionPage(revision, operation, callback) {
    const normalizedRevision = normalizeRevision(revision);
    if (!normalizedRevision) {
      return Promise.reject(new Error("A valid Phabricator revision is required."));
    }
    const run = reviewOperation.catch(() => {}).then(async () => {
      if ((await getStatus()).state !== "connected") {
        throw new Error("Sign in to Phabricator before opening this review.");
      }
      const context = await launchContext({ headless: true });
      try {
        if (sessionStorageState?.cookies?.length) {
          await context.addCookies(sessionStorageState.cookies);
        }
        const page = await getContextPage(context);
        // Include lazy diff and save requests in the durable request log.
        page.on("response", (response) => {
          const request = response.request();
          if (["xhr", "fetch"].includes(request.resourceType()) &&
              new URL(response.url()).origin === new URL(webUrl).origin) {
            recordPhabricatorBrowserActivity({
              event: "browser-request-response",
              operation: `${operation}:${request.method()}:${new URL(response.url()).pathname}`,
              revision: normalizedRevision,
              statusCode: response.status(),
            });
          }
        });
        page.on("requestfailed", (request) => {
          if (["xhr", "fetch"].includes(request.resourceType())) {
            recordPhabricatorBrowserActivity({
              event: "browser-request-error", operation, revision: normalizedRevision,
            });
          }
        });
        await navigatePhabricatorPage(page, {
          operation, revision: normalizedRevision,
          url: getRevisionUrl(normalizedRevision, webUrl),
        });
        if (!await pageIsAuthenticated(page)) {
          state = "disconnected";
          sessionStorageState = undefined;
          throw new Error("Phabricator sign-in expired. Sign in again.");
        }
        return await callback(page, normalizedRevision);
      } catch (error) {
        recordPhabricatorBrowserActivity({
          event: "browser-operation-error", operation, revision: normalizedRevision,
          statusCode: getBrowserErrorStatusCode(error),
        });
        throw error;
      } finally {
        await context.close();
      }
    });
    reviewOperation = run;
    return run;
  }

  function getReview({ revision }) {
    const key = normalizeRevision(revision);
    if (!reviewInflight.has(key)) {
      const request = withRevisionPage(key, "read-review", async (page, id) => {
        const review = await readWebReview(page, id);
        recordPhabricatorBrowserActivity({ event: "browser-download-start", operation: "raw-patch", revision: id });
        review.rawPatch = await downloadWebPatch(page, review.rawUrl);
        recordPhabricatorBrowserActivity({ event: "browser-download-success", operation: "raw-patch", revision: id });
        for (const comment of review.inlineComments) {
          comment.contextDiff = review.rawPatch;
        }
        return review;
      }).finally(() => reviewInflight.delete(key));
      reviewInflight.set(key, request);
    }
    return reviewInflight.get(key);
  }

  async function downloadWebPatch(page, rawUrl) {
    if (!rawUrl || new URL(rawUrl).origin !== new URL(webUrl).origin) {
      throw new Error("Phabricator did not provide a same-site raw patch link.");
    }
    const patch = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        page.off("download", onDownload);
        page.off("response", onResponse);
        error ? reject(error) : resolve(value);
      };
      const onResponse = (response) => {
        if (response.request().isNavigationRequest() && response.status() === 200 &&
            !response.headers()["content-disposition"]?.includes("attachment") &&
            response.headers()["content-type"]?.startsWith("text/plain")) {
          response.text().then((text) => finish(null, text), (error) => finish(error));
        }
      };
      const onDownload = async (download) => {
        try {
          const stream = await download.createReadStream();
          const chunks = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) {
              await download.cancel();
              throw new Error("The raw patch exceeds the 64 MiB review limit.");
            }
            chunks.push(chunk);
          }
          const failure = await download.failure();
          if (failure) {
            throw new Error(`Phabricator raw patch download failed: ${failure}`);
          }
          finish(null, Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          finish(error);
        }
      };
      const timer = setTimeout(() => finish(new Error("Phabricator did not return the raw patch within 30 seconds.")), 30000);
      page.on("response", onResponse);
      page.on("download", onDownload);
      page.locator("a[href]").evaluateAll((links, url) => {
        const link = links.find((candidate) => candidate.href === url);
        if (!link) {
          throw new Error("The raw patch download link disappeared.");
        }
        link.click();
      }, rawUrl).catch((error) => finish(error));
    });
    if (Buffer.byteLength(patch) > 64 * 1024 * 1024 || !patch.includes("diff --git ")) {
      throw new Error("Phabricator did not return a supported raw Git patch.");
    }
    return patch;
  }

  function createInlineComment(options) {
    return withRevisionPage(options.revision, "save-inline-draft", (page, revision) =>
      saveWebInline(page, { ...options, revision }));
  }

  function postInlineReply(options) {
    const normalized = normalizeInlineReply(options);
    return createInlineComment({
      revision: normalized.normalizedRevision,
      content: normalized.content,
      commentPHID: normalized.parentCommentPHID,
    });
  }

  function markInlineCommentDone(options) {
    const { normalizedRevision, parentCommentPHID } = normalizeInlineCommentReference(options);
    return withRevisionPage(normalizedRevision, "mark-inline-comment-done", async (page, revision) => {
      await markWebInlineDone(page, { revision, commentPHID: parentCommentPHID });
      return { parentCommentPHID, revision };
    });
  }

  function publishRevisionReview({ action = "comment", message = "", revision } = {}) {
    if (!["comment", "accept", "reject"].includes(action)) {
      return Promise.reject(new Error("Choose Comment, Accept, or Request Changes."));
    }
    return withRevisionPage(revision, "publish-review", async (page, id) => {
      await publishWebReview(page, { action, message: String(message) });
      return { action, revision: id };
    });
  }

  async function getSuggestions({ revision, inlineComments } = {}) {
    const normalizedRevision = normalizeRevision(revision);
    const normalizedInlineComments = normalizeInlineComments(inlineComments);

    if (!normalizedRevision) {
      return new Map();
    }

    let cached = suggestionCache.get(normalizedRevision);

    if (cached?.expiresAt <= Date.now()) {
      suggestionCache.delete(normalizedRevision);
      cached = undefined;
    }

    const needsDefaultFetch = !cached?.fetchedDefault;
    const needsDiffFetch = normalizedInlineComments.some(({ id, diffId }) => (
      diffId &&
      !cached?.suggestions.has(id) &&
      !cached?.fetchedDiffIds.has(diffId)
    ));

    if (cached && !needsDefaultFetch && !needsDiffFetch) {
      return cached.suggestions;
    }

    if (suggestionInflight.has(normalizedRevision)) {
      await suggestionInflight.get(normalizedRevision);
      return getSuggestions({
        revision: normalizedRevision,
        inlineComments: normalizedInlineComments,
      });
    }

    const request = (async () => {
      const status = await getStatus();

      if (status.state !== "connected") {
        return new Map();
      }

      try {
        cached ||= {
          expiresAt: 0,
          fetchedDefault: false,
          fetchedDiffIds: new Set(),
          suggestions: new Map(),
        };
        const suggestions = await fetchSuggestions(
          normalizedRevision,
          normalizedInlineComments,
          cached,
        );

        suggestionCache.set(normalizedRevision, {
          ...cached,
          expiresAt: Date.now() + suggestionCacheMs,
          suggestions,
        });
        return suggestions;
      } catch (error) {
        state = "error";
        message = String(error?.message || error);
        return new Map();
      }
    })().finally(() => {
      suggestionInflight.delete(normalizedRevision);
    });

    suggestionInflight.set(normalizedRevision, request);
    return request;
  }

  async function getDashboardRevisions({ currentUser, groups = [] }) {
    if ((await getStatus()).state !== "connected") {
      throw new Error("Sign in to Phabricator in the console to load the dashboard.");
    }
    const context = await launchContext({ headless: true });
    try {
      if (sessionStorageState?.cookies?.length) await context.addCookies(sessionStorageState.cookies);
      const page = await getContextPage(context);
      const read = async (key, phids) => {
        let url = new URL("/differential/", webUrl);
        url.searchParams.append("statuses[]", "open()");
        for (const phid of phids) url.searchParams.append(`${key}[]`, phid);
        const rows = new Map();
        const visited = new Set();
        while (url) {
          if (visited.has(url.href) || visited.size >= 20) throw new Error("Dashboard search pagination did not finish. No partial result was saved.");
          visited.add(url.href);
          await navigatePhabricatorPage(page, { operation: "dashboard-search", url: url.href });
          if (!await pageIsAuthenticated(page)) throw new Error("Phabricator sign-in expired.");
          const data = await page.evaluate(() => {
            const document = globalThis.document;
            const items = Array.from(document.querySelectorAll(".phui-oi")).flatMap((item) => {
              const link = item.querySelector("a.phui-oi-link");
              const id = link?.getAttribute("href")?.match(/^\/(D\d+)$/)?.[1];

              if (!id) return [];

              const statusIcon = item.querySelector(".phui-oi-status-icon");
              const statusName = String(
                globalThis.JX?.Stratcom?.getData?.(statusIcon)?.tip || "",
              ).trim();
              const author = item.querySelector(".phui-oi-byline a[href^='/p/']");
              const reviewers = Array.from(item.querySelectorAll(".phui-oi-attributes a.phui-handle")).map((node) => ({
                name: node.textContent.trim(),
                type: node.getAttribute("href").startsWith("/tag/") ? "group" : "user",
              }));
              return [{ id, title: link.textContent.trim(), authorName: author?.textContent.trim() || "", reviewers,
                modifiedText: item.querySelector(".phui-oi-icon-label .print-only")?.textContent || "",
                statusName }];
            });
            const next = Array.from(document.querySelectorAll("a")).find((node) => node.textContent.trim() === "Next" && node.getAttribute("href")?.includes("after="));
            return { items, next: next?.getAttribute("href") || "", valid: Boolean(document.querySelector(".phui-oi-list-view")) };
          });
          if (!data.valid) throw new Error("Phabricator did not return a revision list.");
          for (const row of data.items) rows.set(row.id, row);
          const next = data.next ? new URL(data.next, url) : null;
          if (next && (next.origin !== new URL(webUrl).origin || !next.pathname.startsWith("/differential/"))) throw new Error("Unexpected dashboard pagination URL.");
          url = next;
        }
        return [...rows.values()];
      };
      const mine = await read("authorPHIDs", [currentUser.phid]);
      const reviewQueue = await read("reviewerPHIDs", [currentUser.phid, ...groups.map((group) => group.phid)]);
      return { mine, reviewQueue };
    } finally {
      await context.close();
    }
  }

  return {
    cancelAuthentication,
    createInlineComment,
    getReview,
    getDashboardRevisions: (options) => queueBrowserOperation(() => getDashboardRevisions(options)),
    close: closeAuthenticationWindow,
    getStatus,
    getSuggestions: (options) => queueBrowserOperation(() => getSuggestions(options)),
    markInlineCommentDone,
    postInlineReply,
    profilePath,
    publishRevisionReview,
    signOut,
    startAuthentication,
  };
}
