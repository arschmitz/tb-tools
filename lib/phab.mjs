import config from "./config.mjs";
import { getRevision } from "./git.mjs";
import { readJsonResponse } from "./http.mjs";

const root = "https://phabricator.services.mozilla.com/api/";

export default async function phab({ route, params }) {
  if (!config?.phabricator?.token) {
    throw new Error("You must have a Phabricator API token in your configuration.");
  }

  const requestParams = {
    ...params,
    __conduit__: { token: config.phabricator.token },
  };

  let formData = new FormData();

  formData.append("output", "json");
  formData.append("params", JSON.stringify(requestParams));

  const request = await fetch(root + route, {
    body: formData,
    method: "post"
  });

  const data = await readJsonResponse(request, `Phabricator ${route}`);

  return data;
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
