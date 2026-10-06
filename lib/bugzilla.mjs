import config from "./config.mjs";
import { readJsonResponse } from "./http.mjs";

const apiRoot = "https://bugzilla.mozilla.org/rest/";
const BUG_CACHE_TTL_MS = 5 * 60 * 1000;
const bugCache = new Map();
const bugInflightRequests = new Map();
const unavailableBugs = new Map();
let bugCacheGeneration = 0;

function getBugFieldSet(includeFields = "") {
  return new Set(String(includeFields).split(",").map((field) => field.trim()).filter(Boolean));
}

function getBugCacheKey(ids, fields) {
  return `${Array.from(fields).sort().join(",")}|${ids.join(",")}`;
}

function cloneBug(bug) {
  return JSON.parse(JSON.stringify(bug));
}

function isBugCacheEntryFresh(entry, fields) {
  if (!entry) {
    return false;
  }

  const now = Date.now();

  return Array.from(fields).every((field) => {
    const checkedAt = entry.fieldCheckedAt.get(field);

    return Number.isFinite(checkedAt) && now - checkedAt < BUG_CACHE_TTL_MS;
  });
}

function rememberBugs(bugs, fields) {
  const checkedAt = Date.now();

  for (const bug of bugs || []) {
    if (!bug?.id) {
      continue;
    }

    const id = String(bug.id);
    const existing = bugCache.get(id);
    const fieldCheckedAt = new Map(existing?.fieldCheckedAt || []);

    for (const field of fields) {
      fieldCheckedAt.set(field, checkedAt);
    }

    bugCache.set(id, {
      bug: {
        ...(existing?.bug || {}),
        ...bug,
      },
      fieldCheckedAt,
    });
  }
}

function getCachedBugs(ids, fields) {
  return ids.map((id) => {
    const entry = bugCache.get(id);

    return isBugCacheEntryFresh(entry, fields) ? cloneBug(entry.bug) : null;
  }).filter(Boolean);
}

function invalidateBugCache(ids = []) {
  for (const id of ids) {
    bugCache.delete(String(id));
    unavailableBugs.delete(String(id));
  }
}

export function clearBugzillaBugCache() {
  bugCacheGeneration++;
  bugCache.clear();
  bugInflightRequests.clear();
  unavailableBugs.clear();
}

function getOpenBugStatusParams() {
  return [
    "UNCONFIRMED",
    "NEW",
    "ASSIGNED",
    "REOPENED",
    "VERIFIED",
  ];
}

function addApiKey(params) {
  if (config?.bugzilla?.apiKey) {
    params.set("api_key", config.bugzilla.apiKey);
  }
}

function getBugSearchUrl(params) {
  return `${apiRoot}bug?${params.toString()}`;
}

export async function getBugs() {
  const params = [
    "list_id=17500573",
    "f1=keywords",
    "v1=checkin-needed-tb",
		"classification=Client%20Software",
		"classification=Developer%20Infrastructure",
		"classification=Components",
		"classification=Server%20Software",
		"classification=Other",
		"query_format=advanced",
		"bug_status=UNCONFIRMED",
		"bug_status=NEW",
		"bug_status=ASSIGNED",
		"bug_status=REOPENED",
		"bug_status=VERIFIED",
		"resolution=---",
		"o1=equals"
  ];

  if (config?.bugzilla?.apiKey) {
    params.push(`api_key=${config.bugzilla.apiKey}`);
  }

  const request = await fetch(`${apiRoot}bug?${params.join("&")}`);
  const data = await readJsonResponse(request, "Bugzilla bug search");
  return data.bugs;
}

export async function getAttachments(id) {
  const request = await fetch(`${apiRoot}bug/${id}/attachment`);
  const data = await readJsonResponse(request, `Bugzilla attachments for bug ${id}`);

  return data.bugs[id];
}

export async function getBugComments(id) {
  const params = new URLSearchParams();

  addApiKey(params);
  const suffix = params.size ? `?${params.toString()}` : "";
  const request = await fetch(`${apiRoot}bug/${id}/comment${suffix}`);
  const data = await readJsonResponse(request, `Bugzilla comments for bug ${id}`);

  return data.bugs?.[id]?.comments || [];
}

export async function getBugsByIds(ids = [], {
  includeFields = "id,summary,status,resolution,is_open,keywords,assigned_to,assigned_to_detail,product,component,last_change_time",
  permissive = true,
} = {}) {
  const normalizedIds = Array.from(new Set(
    ids.map((id) => String(id || "").trim()).filter(Boolean),
  ));

  if (!normalizedIds.length) {
    return [];
  }

  const fields = getBugFieldSet(includeFields);
  const missingIds = normalizedIds.filter((id) => (
    !isBugCacheEntryFresh(bugCache.get(id), fields) &&
    !(permissive && Date.now() - unavailableBugs.get(id) < BUG_CACHE_TTL_MS)
  ));

  if (!missingIds.length) {
    return getCachedBugs(normalizedIds, fields);
  }

  const requestKey = `${permissive}|${getBugCacheKey(missingIds, fields)}`;

  const generation = bugCacheGeneration;
  if (bugInflightRequests.has(requestKey)) {
    await bugInflightRequests.get(requestKey);
    if (generation !== bugCacheGeneration) return getBugsByIds(normalizedIds, { includeFields, permissive });
    return getCachedBugs(normalizedIds, fields);
  }

  const params = new URLSearchParams({
    include_fields: includeFields,
  });
  // A restricted bug must not fail the other records in a batch.
  if (permissive) params.set("permissive", "1");

  for (const id of missingIds) {
    params.append("ids", id);
  }

  const request = (async () => {
    addApiKey(params);
    let remainingIds = [...missingIds];
    let data = { bugs: [] };
    // Some responses reject the full batch even with permissive=1.
    // Remove only the explicitly denied bug; never retry an unchanged batch.
    while (remainingIds.length) {
      params.delete("ids");
      for (const id of remainingIds) params.append("ids", id);
      const response = await fetch(`${apiRoot}bug/?${params.toString()}`);
      try {
        data = await readJsonResponse(response, "Bugzilla bug search");
        break;
      } catch (error) {
        const deniedId = String(error.responseData?.message || "")
          .match(/^You are not authorized to access bug (\d+)\.?$/i)?.[1];
        if (!permissive || error.statusCode !== 401 || !remainingIds.includes(deniedId)) {
          throw error;
        }
        if (generation !== bugCacheGeneration) return;
        bugCache.delete(deniedId);
        unavailableBugs.set(deniedId, Date.now());
        remainingIds = remainingIds.filter((id) => id !== deniedId);
      }
    }

    if (generation !== bugCacheGeneration) return;
    rememberBugs(data.bugs || [], fields);
    for (const bug of data.bugs || []) unavailableBugs.delete(String(bug.id));
    for (const fault of data.faults || []) {
      const id = String(fault.id);
      if (!missingIds.includes(id)) continue;
      bugCache.delete(id);
      unavailableBugs.set(id, Date.now());
    }
  })();

  bugInflightRequests.set(requestKey, request);

  try {
    await request;
  } finally {
    if (bugInflightRequests.get(requestKey) === request) bugInflightRequests.delete(requestKey);
  }

  if (generation !== bugCacheGeneration) return getBugsByIds(normalizedIds, { includeFields, permissive });
  return getCachedBugs(normalizedIds, fields);
}

export async function getBugsWithAttachmentsByIds(ids = []) {
  return getBugsByIds(ids, {
    includeFields: "id,attachments.id,attachments.file_name,attachments.content_type,attachments.is_patch,attachments.is_obsolete,attachments.last_change_time,attachments.flags",
  });
}

export async function getBugHistoryByIds(ids = []) {
  const normalizedIds = Array.from(new Set(
    ids.map((id) => String(id || "").trim()).filter(Boolean),
  ));

  if (!normalizedIds.length) {
    return [];
  }

  const histories = [];

  for (let index = 0; index < normalizedIds.length; index += 200) {
    const batch = normalizedIds.slice(index, index + 200);
    const params = new URLSearchParams();

    for (const id of batch.slice(1)) {
      params.append("ids", id);
    }
    addApiKey(params);
    const suffix = params.size ? `?${params.toString()}` : "";
    const request = await fetch(`${apiRoot}bug/${batch[0]}/history${suffix}`);
    const data = await readJsonResponse(request, "Bugzilla bug history");

    histories.push(...(data.bugs || []));
  }

  return histories;
}

export async function getUsersByMatches(matches = [], {
  includeFields = "id,name,real_name,email",
} = {}) {
  const normalizedMatches = Array.from(new Set(
    matches.map((match) => String(match || "").trim()).filter(Boolean),
  ));

  if (!normalizedMatches.length) {
    return [];
  }

  const params = new URLSearchParams({
    include_fields: includeFields,
  });

  for (const match of normalizedMatches) {
    params.append("match", match);
  }

  addApiKey(params);
  const request = await fetch(`${apiRoot}user?${params.toString()}`);
  const data = await readJsonResponse(request, "Bugzilla user lookup");

  return data.users || [];
}

export async function getAssignedOpenBugs({ assignedTo = config?.bugzilla?.user } = {}) {
  const normalizedAssignee = String(assignedTo || "").trim();

  if (!normalizedAssignee) {
    throw new Error("Set bugzilla.user in ~/.tb.json to load assigned bugs.");
  }

  const params = new URLSearchParams({
    assigned_to: normalizedAssignee,
    resolution: "---",
    include_fields: "id,summary,status,resolution,is_open,keywords,assigned_to,assigned_to_detail,product,component,last_change_time",
  });

  for (const status of getOpenBugStatusParams()) {
    params.append("bug_status", status);
  }

  addApiKey(params);
  const request = await fetch(getBugSearchUrl(params));
  const data = await readJsonResponse(request, "Bugzilla assigned bug search");

  rememberBugs(
    data.bugs || [],
    getBugFieldSet(params.get("include_fields")),
  );
  return data.bugs || [];
}

export async function getNeedinfoOpenBugs({ requestee = config?.bugzilla?.user } = {}) {
  const normalizedRequestee = String(requestee || "").trim();

  if (!normalizedRequestee) {
    throw new Error("Set bugzilla.user in ~/.tb.json to load needinfo requests.");
  }

  const params = new URLSearchParams({
    quicksearch: `needinfo?${normalizedRequestee}`,
    resolution: "---",
    include_fields: "id,summary,status,resolution,is_open,product,component,last_change_time,flags",
  });

  for (const status of getOpenBugStatusParams()) {
    params.append("bug_status", status);
  }

  addApiKey(params);
  const request = await fetch(getBugSearchUrl(params));
  const data = await readJsonResponse(request, "Bugzilla needinfo search");

  rememberBugs(
    data.bugs || [],
    getBugFieldSet(params.get("include_fields")),
  );
  return data.bugs || [];
}

export async function updateBug(id, updates) {
  if (!config?.bugzilla?.apiKey) {
    throw new Error("You must have a Bugzilla API key in your configuration to update Bugzilla");
  }

  updates = {
    ...updates,
    api_key: config.bugzilla.apiKey,
  };

  const request = await fetch(`${apiRoot}bug/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(updates)
  });

  const result = await readJsonResponse(request, `Bugzilla update for bug ${id}`);

  // Relationship edits also change the linked bugs, including removed links.
  if (Object.hasOwn(updates, "blocks") || Object.hasOwn(updates, "depends_on")) {
    clearBugzillaBugCache();
  } else {
    invalidateBugCache([id]);
  }
  return result;
}

export async function createBug(fields = {}) {
  if (!config?.bugzilla?.apiKey) {
    throw new Error("You must have a Bugzilla API key in your configuration to create a Bugzilla bug");
  }

  const request = await fetch(`${apiRoot}bug`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...fields,
      api_key: config.bugzilla.apiKey,
    }),
  });

  const result = await readJsonResponse(request, "Bugzilla bug creation");

  // Creating a sprint changes the parent board's dependency list too.
  clearBugzillaBugCache();
  return result;
}

export async function getBug(id) {
  const bugs = await getBugsByIds([id], { permissive: false });

  return { bugs };
}
