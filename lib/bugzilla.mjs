import config from "./config.mjs";
import { readJsonResponse } from "./http.mjs";

const apiRoot = "https://bugzilla.mozilla.org/rest/";

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
} = {}) {
  const normalizedIds = Array.from(new Set(
    ids.map((id) => String(id || "").trim()).filter(Boolean),
  ));

  if (!normalizedIds.length) {
    return [];
  }

  const params = new URLSearchParams({
    include_fields: includeFields,
  });

  for (const id of normalizedIds) {
    params.append("ids", id);
  }

  addApiKey(params);
  const request = await fetch(`${apiRoot}bug/?${params.toString()}`);
  const data = await readJsonResponse(request, "Bugzilla bug search");

  return data.bugs || [];
}

export async function getBugsWithAttachmentsByIds(ids = []) {
  return getBugsByIds(ids, {
    includeFields: "id,attachments.id,attachments.file_name,attachments.content_type",
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

  return await readJsonResponse(request, `Bugzilla update for bug ${id}`);
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

  return readJsonResponse(request, "Bugzilla bug creation");
}

export async function getBug(id) {
  let url = `${apiRoot}bug/?ids=${id}`;
  if (config?.bugzilla?.apiKey) {
    url += `&api_key=${config.bugzilla.apiKey}`;
  }

  const request = await fetch(url);
  return readJsonResponse(request, `Bugzilla bug ${id}`);
}
