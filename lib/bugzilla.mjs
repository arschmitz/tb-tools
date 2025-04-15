import config from "./config.mjs";

const apiRoot = "https://bugzilla.mozilla.org/rest/";

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
  const data = await request.json();
  return data.bugs;
}

export async function getAttachments(id) {
  const request = await fetch(`${apiRoot}bug/${id}/attachment`);
  const data = await request.json();

  return data.bugs[id];
}

export async function updateBug(id, updates) {
  if (!config.bugzilla.apiKey) {
    throw new Error("You must have a bugzillas api key in your configuration to update bugzilla");
  }

  updates.api_key = config.bugzilla.apiKey;

  const request = await fetch(`${apiRoot}bug/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates)
  });

  return await request.json();
}

export async function getBug(id) {
  let url = `${apiRoot}bug/?ids=${id}`;
  if (config?.bugzilla?.apiKey) {
    url += `&api_key=${config.bugzilla.apiKey}`;
  }

  const request = await fetch(url);

  return request.json();
}
