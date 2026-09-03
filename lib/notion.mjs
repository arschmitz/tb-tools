import config from "./config.mjs";
import { readJsonResponse } from "./http.mjs";

export const NOTION_API_ROOT = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";

const DEFAULT_BUG_PROPERTY_NAMES = [
  "Bug",
  "Bug ID",
  "Bugzilla",
  "Bugzilla Bug",
  "Bugzilla Bug ID",
];
const DEFAULT_TITLE_PROPERTY_NAMES = ["Name", "Title", "Story"];
const DEFAULT_STATUS_PROPERTY_NAMES = ["Status", "State"];
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 10;

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizePropertyName(value = "") {
  return normalizeText(value).toLowerCase();
}

function getNotionSettings(appConfig = config) {
  return appConfig?.notion || {};
}

export function isNotionConfigured(appConfig = config) {
  const settings = getNotionSettings(appConfig);

  return Boolean(settings.token && settings.dataSourceId);
}

export function isNotionAuthenticationError(error) {
  const statusCode = Number(error?.statusCode || error?.status);

  return statusCode === 401 || statusCode === 403;
}

function getNotionRequestHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

function getRetryAfterMilliseconds(response) {
  const retryAfter = response.headers?.get?.("retry-after");

  if (!retryAfter) {
    return 0;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(retryAfter);

  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function getFallbackRetryDelay(attempt) {
  return Math.min(2 ** attempt, 30) * 1000 + Math.floor(Math.random() * 250);
}

function shouldRetryNotionResponse(response, attempt, maxAttempts) {
  return attempt < maxAttempts - 1 && [429, 529].includes(response.status);
}

async function notionRequest({
  method = "GET",
  path,
  token,
  body,
  fetchImpl = fetch,
  maxAttempts = 3,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetchImpl(`${NOTION_API_ROOT}${path}`, {
      method,
      headers: getNotionRequestHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!shouldRetryNotionResponse(response, attempt, maxAttempts)) {
      return readJsonResponse(response, "Notion request");
    }

    await new Promise((resolve) => setTimeout(
      resolve,
      getRetryAfterMilliseconds(response) || getFallbackRetryDelay(attempt),
    ));
  }

  throw new Error("Notion request failed after retrying.");
}

export async function retrieveNotionDataSource({
  dataSourceId,
  token,
  fetchImpl = fetch,
}) {
  return notionRequest({
    path: `/data_sources/${encodeURIComponent(dataSourceId)}`,
    token,
    fetchImpl,
  });
}

export async function queryNotionDataSource({
  dataSourceId,
  token,
  filter,
  pageSize = DEFAULT_PAGE_SIZE,
  fetchImpl = fetch,
}) {
  return notionRequest({
    method: "POST",
    path: `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
    token,
    fetchImpl,
    body: {
      filter,
      page_size: Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE)),
    },
  });
}

function getPropertyEntries(properties = {}) {
  return Object.entries(properties).map(([name, property]) => ({
    name,
    id: property?.id || "",
    type: property?.type || "",
    property,
  }));
}

function findPropertyByNameOrId(properties, candidates = []) {
  const entries = getPropertyEntries(properties);
  const normalizedCandidates = candidates
    .map(normalizePropertyName)
    .filter(Boolean);

  for (const candidate of candidates.map(normalizeText).filter(Boolean)) {
    const exact = entries.find((entry) => entry.id === candidate || entry.name === candidate);

    if (exact) {
      return exact;
    }
  }

  return entries.find((entry) => normalizedCandidates.includes(normalizePropertyName(entry.name)));
}

function findFirstPropertyOfType(properties, type) {
  return getPropertyEntries(properties).find((entry) => entry.type === type);
}

function findBugProperty(properties, notionSettings = {}) {
  const configuredName = normalizeText(notionSettings.bugProperty || notionSettings.bugPropertyName);
  const candidates = configuredName
    ? [configuredName]
    : DEFAULT_BUG_PROPERTY_NAMES;
  const property = findPropertyByNameOrId(properties, candidates);

  if (property) {
    return property;
  }

  const available = Object.keys(properties).sort().join(", ");
  throw new Error(
    configuredName
      ? `Notion bug property "${configuredName}" was not found in the configured data source.`
      : `No Notion bug-id property was found. Configure notion.bugProperty. Available properties: ${available || "none"}.`,
  );
}

function findTitleProperty(properties, notionSettings = {}) {
  const configuredName = normalizeText(notionSettings.titleProperty || notionSettings.titlePropertyName);

  return (
    findPropertyByNameOrId(properties, configuredName ? [configuredName] : DEFAULT_TITLE_PROPERTY_NAMES) ||
    findFirstPropertyOfType(properties, "title")
  );
}

function findStatusProperty(properties, notionSettings = {}) {
  const configuredName = normalizeText(notionSettings.statusProperty || notionSettings.statusPropertyName);

  return findPropertyByNameOrId(
    properties,
    configuredName ? [configuredName] : DEFAULT_STATUS_PROPERTY_NAMES,
  );
}

export function buildNotionBugFilter({ bugId, property }) {
  const bugNumber = Number(bugId);

  switch (property.type) {
    case "number":
      return {
        property: property.id || property.name,
        number: { equals: bugNumber },
      };
    case "unique_id":
      return {
        property: property.id || property.name,
        unique_id: { equals: bugNumber },
      };
    case "title":
      return {
        property: property.id || property.name,
        title: { contains: String(bugId) },
      };
    case "rich_text":
      return {
        property: property.id || property.name,
        rich_text: { contains: String(bugId) },
      };
    case "formula":
      return {
        property: property.id || property.name,
        formula: { string: { contains: String(bugId) } },
      };
    default:
      throw new Error(
        `Notion bug property "${property.name}" has unsupported type "${property.type}". Use a number, unique_id, title, rich_text, or formula property.`,
      );
  }
}

function getRichTextPlainText(items = []) {
  return items
    .map((item) => item?.plain_text || item?.text?.content || "")
    .join("");
}

function getNotionPropertyPlainText(property) {
  if (!property) {
    return "";
  }

  switch (property.type) {
    case "title":
      return getRichTextPlainText(property.title);
    case "rich_text":
      return getRichTextPlainText(property.rich_text);
    case "number":
      return property.number === null || property.number === undefined
        ? ""
        : String(property.number);
    case "select":
      return property.select?.name || "";
    case "status":
      return property.status?.name || "";
    case "url":
      return property.url || "";
    case "unique_id":
      return `${property.unique_id?.prefix || ""}${property.unique_id?.number ?? ""}`;
    case "formula":
      if (property.formula?.type === "string") {
        return property.formula.string || "";
      }
      if (property.formula?.type === "number") {
        return property.formula.number === null || property.formula.number === undefined
          ? ""
          : String(property.formula.number);
      }
      if (property.formula?.type === "boolean") {
        return property.formula.boolean === undefined
          ? ""
          : String(property.formula.boolean);
      }
      if (property.formula?.type === "date") {
        return property.formula.date?.start || "";
      }
      return "";
    default:
      return "";
  }
}

function normalizeNotionStoryPage(page, {
  bugProperty,
  titleProperty,
  statusProperty,
}) {
  const title = getNotionPropertyPlainText(page.properties?.[titleProperty?.name]) ||
    page.url ||
    page.id;
  const status = getNotionPropertyPlainText(page.properties?.[statusProperty?.name]);

  return {
    id: String(page.id || ""),
    url: page.url || "",
    title,
    bug: getNotionPropertyPlainText(page.properties?.[bugProperty?.name]),
    status,
    lastEditedTime: page.last_edited_time || "",
    inTrash: Boolean(page.in_trash || page.archived),
  };
}

export async function getNotionStoriesByBugId({
  bugId,
  config: appConfig = config,
  fetchImpl = fetch,
} = {}) {
  const normalizedBugId = normalizeText(bugId);

  if (!normalizedBugId) {
    return null;
  }

  const notionSettings = getNotionSettings(appConfig);

  if (!isNotionConfigured(appConfig)) {
    return null;
  }

  const dataSource = await retrieveNotionDataSource({
    dataSourceId: notionSettings.dataSourceId,
    token: notionSettings.token,
    fetchImpl,
  });
  const properties = dataSource.properties || {};
  const bugProperty = findBugProperty(properties, notionSettings);
  const titleProperty = findTitleProperty(properties, notionSettings);
  const statusProperty = findStatusProperty(properties, notionSettings);
  const query = await queryNotionDataSource({
    dataSourceId: notionSettings.dataSourceId,
    token: notionSettings.token,
    filter: buildNotionBugFilter({
      bugId: normalizedBugId,
      property: bugProperty,
    }),
    pageSize: notionSettings.pageSize,
    fetchImpl,
  });

  return {
    bugId: normalizedBugId,
    dataSourceId: notionSettings.dataSourceId,
    bugProperty: bugProperty.name,
    stories: (query.results || [])
      .filter((page) => page && !page.in_trash && !page.archived)
      .map((page) => normalizeNotionStoryPage(page, {
        bugProperty,
        titleProperty,
        statusProperty,
      })),
  };
}
