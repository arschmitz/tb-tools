import config from "./config.mjs";
import { getRevision } from "./hg.mjs";

const root = "https://phabricator.services.mozilla.com/api/";

export default async function phab({ route, params }) {
  params.__conduit__ = { token: config.phabricator.token };

  let formData = new FormData();

  formData.append("output", "json");
  formData.append("params", JSON.stringify(params));

  const request = await fetch(root + route, {
    body: formData,
    method: "post"
  });

  const data = await request.json();

  return data;
};

export async function comment(message, resolve) {
  const revision = await getRevision();
  const result = await phab({
    route: "differential.createcomment",
    params: {
      revision_id: revision.replace(/^D/, ""),
      message,
      attach_inlines: resolve,
    }
  });

  return result;
}
