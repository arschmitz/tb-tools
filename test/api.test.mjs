import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getBugs } from "../lib/bugzilla.mjs";
import { readJsonResponse } from "../lib/http.mjs";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test("getBugs reads Bugzilla search results through fetch", async () => {
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ bugs: [{ id: 12345 }] }), { status: 200 });
  };

  const bugs = await getBugs();

  assert.deepEqual(bugs, [{ id: 12345 }]);
  assert.match(requestedUrl, /bugzilla\.mozilla\.org\/rest\/bug\?/);
  assert.match(requestedUrl, /v1=checkin-needed-tb/);
});

test("readJsonResponse reports HTTP API failures with response detail", async () => {
  const response = new Response(JSON.stringify({ message: "invalid api key" }), {
    status: 401,
    statusText: "Unauthorized",
  });

  await assert.rejects(
    readJsonResponse(response, "Bugzilla update for bug 12345"),
    /Bugzilla update for bug 12345 failed \(401 Unauthorized\): invalid api key/
  );
});

test("readJsonResponse reports non-JSON HTTP failures", async () => {
  const response = new Response("Service unavailable", {
    status: 503,
    statusText: "Service Unavailable",
  });

  await assert.rejects(
    readJsonResponse(response, "Bugzilla bug search"),
    /Bugzilla bug search failed \(503 Service Unavailable\): Service unavailable/
  );
});

test("readJsonResponse reports Phabricator conduit errors", async () => {
  const response = new Response(JSON.stringify({
    error_code: "ERR-INVALID-AUTH",
    error_info: "Authentication failed",
  }), { status: 200 });

  await assert.rejects(
    readJsonResponse(response, "Phabricator differential.query"),
    /Phabricator differential\.query failed: Authentication failed/
  );
});
