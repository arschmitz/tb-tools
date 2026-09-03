import { access, chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PHABRICATOR_WEB_URL = "https://phabricator.services.mozilla.com/";
export const PHABRICATOR_LOGIN_URL = `${PHABRICATOR_WEB_URL}auth/login/`;
export const PHABRICATOR_AUTHENTICATION_CHECK_URL = `${PHABRICATOR_WEB_URL}settings/`;

const DEFAULT_SUGGESTION_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_STATUS_CACHE_MS = 60 * 1000;
const PATCH_UPDATE_DRAFT_START = "<!-- tb-tools-patch-update-responses:start -->";
const PATCH_UPDATE_DRAFT_END = "<!-- tb-tools-patch-update-responses:end -->";

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

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mergePhabricatorPatchUpdateDraft(existingDraft = "", draftBlock = "") {
  const marker = new RegExp(
    `${escapeRegularExpression(PATCH_UPDATE_DRAFT_START)}[\\s\\S]*?${escapeRegularExpression(PATCH_UPDATE_DRAFT_END)}\\s*`,
    "g",
  );
  const existing = String(existingDraft || "").trim();
  const block = String(draftBlock || "").trim();

  return [existing.replace(marker, "").trim(), block].filter(Boolean).join("\n\n");
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

async function loadPlaywrightChromium() {
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
      await page.goto(authenticationCheckUrl, { waitUntil: "domcontentloaded" });
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

        await page.goto(authenticationCheckUrl, { waitUntil: "domcontentloaded" });
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
      await authPage.goto(loginUrl, { waitUntil: "domcontentloaded" });
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
        await pageToUse.goto(url, { waitUntil: "networkidle" });
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

  async function saveRevisionDraft({ revision, draftBlock = "" } = {}) {
    const normalizedRevision = normalizeRevision(revision);

    if (!normalizedRevision) {
      throw new Error("A valid Phabricator revision is required to save a draft.");
    }

    const currentStatus = await getStatus();

    if (currentStatus.state !== "connected") {
      throw new Error("Sign in to Phabricator before saving a reply draft.");
    }

    const context = await launchContext({ headless: true });

    try {
      if (sessionStorageState?.cookies?.length) {
        await context.addCookies(sessionStorageState.cookies);
      }

      const page = await getContextPage(context);

      await page.goto(getRevisionUrl(normalizedRevision, webUrl), {
        waitUntil: "domcontentloaded",
      });
      if (!await pageIsAuthenticated(page)) {
        state = "disconnected";
        sessionStorageState = undefined;
        message = "Phabricator sign-in expired. Authenticate again to save reply drafts.";
        throw new Error(message);
      }

      const getDraftComment = () => page.evaluate(() => {
        const document = globalThis.document;
        const comment = document.querySelector(
          "form[data-sigil~='transaction-append'] textarea[name='comment']",
        );

        if (!comment) {
          throw new Error("Phabricator did not provide the revision comment form.");
        }

        return String(comment.value || "");
      });
      const existingDraft = await getDraftComment();
      const comment = mergePhabricatorPatchUpdateDraft(existingDraft, draftBlock);

      await page.evaluate(async (nextComment) => {
        const document = globalThis.document;
        const form = document.querySelector(
          "form[data-sigil~='transaction-append']",
        );

        if (!form) {
          throw new Error("Phabricator did not provide the revision comment form.");
        }

        const formData = new FormData(form);
        const csrf = String(formData.get("__csrf__") || "");

        formData.set("comment", nextComment);
        formData.set("__preview__", "1");
        const response = await fetch(form.action, {
          body: formData,
          credentials: "same-origin",
          headers: {
            "X-Phabricator-CSRF": csrf,
            "X-Requested-With": "XMLHttpRequest",
          },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(`Phabricator draft save failed (${response.status}).`);
        }
      }, comment);

      return { comment };
    } catch (error) {
      if (state !== "disconnected") {
        state = "error";
        message = String(error?.message || error);
      }
      throw error;
    } finally {
      await context.close();
    }
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

  return {
    cancelAuthentication,
    close: closeAuthenticationWindow,
    getStatus,
    getSuggestions,
    profilePath,
    saveRevisionDraft,
    signOut,
    startAuthentication,
  };
}
