import { access, chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PHABRICATOR_WEB_URL = "https://phabricator.services.mozilla.com/";
export const PHABRICATOR_LOGIN_URL = `${PHABRICATOR_WEB_URL}auth/login/`;
export const PHABRICATOR_AUTHENTICATION_CHECK_URL = `${PHABRICATOR_WEB_URL}settings/`;

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

  async function postInlineReply({ commentPHID, message: reply, revision } = {}) {
    const {
      content,
      normalizedRevision,
      parentCommentPHID,
    } = normalizeInlineReply({
      commentPHID,
      message: reply,
      revision,
    });
    const currentStatus = await getStatus();

    if (currentStatus.state !== "connected") {
      throw new Error("Sign in to Phabricator before posting an inline reply.");
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
        message = "Phabricator sign-in expired. Authenticate again to post inline replies.";
        throw new Error(message);
      }

      const result = await page.evaluate(async ({
        content: inlineContent,
        parentCommentPHID: parentPHID,
        revision: revisionId,
      }) => {
        const document = globalThis.document;
        const form = document.querySelector(
          "form[data-sigil~='transaction-append']",
        );

        if (!form) {
          throw new Error("Phabricator did not provide the revision comment form.");
        }

        const revisionNumber = String(revisionId).replace(/^D/i, "");
        const csrf = String(new FormData(form).get("__csrf__") || "");
        const endpoint = new URL(
          `/differential/comment/inline/edit/${revisionNumber}/`,
          globalThis.location.origin,
        ).toString();
        const baseFields = {
          hasContentState: "1",
          hasSuggestion: "0",
          is_new: "1",
          length: "1",
          number: "1",
          on_right: "1",
          renderer: "2up",
          suggestionText: "",
          text: inlineContent,
        };
        const parseAjaxResponse = (text) => {
          const source = String(text || "").replace(/^for\s*\(;;\);\s*/, "");
          let response;

          try {
            response = JSON.parse(source);
          } catch {
            throw new Error("Phabricator did not return an inline-reply response.");
          }

          const error = response?.error || response?.error_info || response?.error_code;

          if (error) {
            const detail = typeof error === "string"
              ? error
              : JSON.stringify(error);

            throw new Error(`Phabricator inline reply failed: ${detail}`);
          }

          // Aphront Ajax responses wrap controller content in `payload`.
          // The inline controller puts the saved draft ID inside that payload.
          return Object.prototype.hasOwnProperty.call(response || {}, "payload")
            ? response.payload
            : response;
        };
        const requestInlineEdit = async (fields) => {
          const body = new FormData();

          body.set("__csrf__", csrf);
          for (const [key, value] of Object.entries(fields)) {
            body.set(key, String(value));
          }

          const response = await fetch(endpoint, {
            body,
            credentials: "same-origin",
            headers: {
              "X-Phabricator-CSRF": csrf,
              "X-Requested-With": "XMLHttpRequest",
            },
            method: "POST",
          });

          if (!response.ok) {
            throw new Error(`Phabricator inline reply failed (${response.status}).`);
          }

          return parseAjaxResponse(await response.text());
        };
        const created = await requestInlineEdit({
          ...baseFields,
          op: "reply",
          replyToCommentPHID: parentPHID,
        });
        const inlineId = Number(created?.inline?.id);

        if (!Number.isInteger(inlineId) || inlineId < 1) {
          throw new Error("Phabricator did not create an inline reply draft.");
        }

        await requestInlineEdit({
          ...baseFields,
          id: inlineId,
          op: "save",
        });

        return { inlineId };
      }, {
        content,
        parentCommentPHID,
        revision: normalizedRevision,
      });

      return {
        ...result,
        revision: normalizedRevision,
        parentCommentPHID,
      };
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

  async function publishRevisionReview({ action = "comment", message: reviewMessage = "", revision } = {}) {
    const normalizedRevision = normalizeRevision(revision);
    const normalizedAction = String(action || "comment").trim().toLowerCase();
    const content = String(reviewMessage || "").trim();

    if (!normalizedRevision) {
      throw new Error("A valid Phabricator revision is required to publish a review.");
    }

    if (!new Set(["comment", "accept", "reject"]).has(normalizedAction)) {
      throw new Error("Choose Comment, Accept, or Request Changes for the final review.");
    }

    const currentStatus = await getStatus();

    if (currentStatus.state !== "connected") {
      throw new Error("Sign in to Phabricator before publishing a review with pending inline comments.");
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
        message = "Phabricator sign-in expired. Authenticate again to publish the review.";
        throw new Error(message);
      }

      if (normalizedAction !== "comment") {
        const actionIsAvailable = await page.evaluate((selectedAction) => {
          const document = globalThis.document;
          const form = document.querySelector(
            "form[data-sigil~='transaction-append']",
          );
          const actionInput = form?.querySelector(
            "input[name='editengine.actions']",
          );

          return Boolean(actionInput) && Array.from(form.querySelectorAll("select"))
            .some((select) => Array.from(select.options).some(
              (option) => option.value === selectedAction,
            ));
        }, normalizedAction);

        if (!actionIsAvailable) {
          const actionLabel = normalizedAction === "reject"
            ? "Request Changes"
            : "Accept";

          throw new Error(
            `Phabricator does not offer ${actionLabel} for ${normalizedRevision} in the current review state. ` +
              "No review comment was posted.",
          );
        }
      }

      const publication = await page.evaluate(async ({ action: selectedAction, content: message }) => {
        const document = globalThis.document;
        const form = document.querySelector(
          "form[data-sigil~='transaction-append']",
        );
        const actionInput = form?.querySelector(
          "input[name='editengine.actions']",
        );

        if (!form || !actionInput) {
          throw new Error("Phabricator did not provide the revision comment form.");
        }

        const submission = new FormData(form);
        const csrf = String(submission.get("__csrf__") || "");
        const actions = selectedAction === "comment"
          ? []
          : [{ type: selectedAction, value: true, initialValue: null }];

        submission.set("comment", message);
        submission.set(actionInput.name, JSON.stringify(actions));
        submission.delete("__preview__");
        const response = await fetch(form.action, {
          body: submission,
          credentials: "same-origin",
          headers: { "X-Phabricator-CSRF": csrf },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(`Phabricator review publication failed (${response.status}).`);
        }

        if (new URL(response.url).pathname.includes("/auth/login/")) {
          throw new Error("Phabricator sign-in expired while publishing the review.");
        }

        return { responseUrl: response.url };
      }, { action: normalizedAction, content });

      if (normalizedAction !== "comment") {
        await page.goto(publication.responseUrl || getRevisionUrl(normalizedRevision, webUrl), {
          waitUntil: "domcontentloaded",
        });
        if (!await pageIsAuthenticated(page)) {
          state = "disconnected";
          sessionStorageState = undefined;
          message = "Phabricator sign-in expired while confirming the review action.";
          throw new Error(message);
        }

        const actionIsStillAvailable = await page.evaluate((selectedAction) => {
          const document = globalThis.document;
          const form = document.querySelector(
            "form[data-sigil~='transaction-append']",
          );
          const actionInput = form?.querySelector(
            "input[name='editengine.actions']",
          );

          return Boolean(actionInput) && Array.from(form.querySelectorAll("select"))
            .some((select) => Array.from(select.options).some(
              (option) => option.value === selectedAction,
            ));
        }, normalizedAction);

        if (actionIsStillAvailable) {
          const actionLabel = normalizedAction === "reject"
            ? "Request Changes"
            : "Accept";

          throw new Error(
            `Phabricator accepted the review text but did not record ${actionLabel} for ${normalizedRevision}. ` +
              "Check the revision before retrying.",
          );
        }
      }

      return { action: normalizedAction, revision: normalizedRevision };
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
    postInlineReply,
    profilePath,
    publishRevisionReview,
    signOut,
    startAuthentication,
  };
}
