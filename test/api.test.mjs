import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getBugs } from "../lib/bugzilla.mjs";
import config from "../lib/config.mjs";
import { readJsonResponse } from "../lib/http.mjs";
import phab, { clearPhabricatorRequestState } from "../lib/phab.mjs";

const originalFetch = global.fetch;
const originalPhabricatorConfig = config.phabricator
  ? { ...config.phabricator }
  : undefined;

afterEach(() => {
  global.fetch = originalFetch;
  clearPhabricatorRequestState();

  if (originalPhabricatorConfig) {
    config.phabricator = { ...originalPhabricatorConfig };
  } else {
    delete config.phabricator;
  }
});

function useTestPhabricatorToken() {
  config.phabricator = {
    ...(config.phabricator || {}),
    token: "test-token",
  };
}

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

test("readJsonResponse includes status and retry metadata on API errors", async () => {
  const response = new Response(JSON.stringify({ message: "too many requests" }), {
    headers: {
      "retry-after": "30",
    },
    status: 429,
    statusText: "Too Many Requests",
  });

  await assert.rejects(
    readJsonResponse(response, "Phabricator differential.query"),
    (error) => {
      assert.match(
        error.message,
        /Phabricator differential\.query failed \(429 Too Many Requests\): too many requests/,
      );
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryAfterMs, 30000);
      return true;
    },
  );
});

test("phab coalesces identical read-only requests", async () => {
  useTestPhabricatorToken();

  let calls = 0;

  global.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://phabricator.services.mozilla.com/api/differential.query");
    assert.deepEqual(JSON.parse(options.body.get("params")), {
      ids: [123],
      __conduit__: { token: "test-token" },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    return new Response(JSON.stringify({
      result: [{ id: 123 }],
    }), { status: 200 });
  };

  const [first, second] = await Promise.all([
    phab({ route: "differential.query", params: { ids: [123] } }),
    phab({ route: "differential.query", params: { ids: [123] } }),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, { result: [{ id: 123 }] });
  assert.deepEqual(second, { result: [{ id: 123 }] });
  assert.notEqual(first, second);
});

test("phab caches user query reviewer names by PHID", async () => {
  useTestPhabricatorToken();

  const requestedPhids = [];

  global.fetch = async (url, options) => {
    assert.equal(String(url), "https://phabricator.services.mozilla.com/api/user.query");
    const params = JSON.parse(options.body.get("params"));

    requestedPhids.push(params.phids);

    return new Response(JSON.stringify({
      result: params.phids.map((phid) => ({
        phid,
        userName: `reviewer-${phid}`,
      })),
    }), { status: 200 });
  };

  const first = await phab({
    route: "user.query",
    params: {
      phids: ["PHID-USER-a", "PHID-USER-b"],
    },
  });
  const second = await phab({
    route: "user.query",
    params: {
      phids: ["PHID-USER-b", "PHID-USER-c"],
    },
  });

  assert.deepEqual(requestedPhids, [
    ["PHID-USER-a", "PHID-USER-b"],
    ["PHID-USER-c"],
  ]);
  assert.deepEqual(first.result.map((reviewer) => reviewer.userName), [
    "reviewer-PHID-USER-a",
    "reviewer-PHID-USER-b",
  ]);
  assert.deepEqual(second.result.map((reviewer) => reviewer.userName), [
    "reviewer-PHID-USER-b",
    "reviewer-PHID-USER-c",
  ]);
});

test("phab skips a cooled-down route after a rate limit", async () => {
  useTestPhabricatorToken();

  let calls = 0;

  global.fetch = async () => {
    calls++;

    return new Response(JSON.stringify({ message: "too many requests" }), {
      headers: {
        "retry-after": "30",
      },
      status: 429,
      statusText: "Too Many Requests",
    });
  };

  await assert.rejects(
    phab({ route: "differential.query", params: { ids: [123] } }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryAfterMs, 30000);
      return true;
    },
  );

  global.fetch = async () => {
    calls++;

    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  };

  await assert.rejects(
    phab({ route: "differential.query", params: { ids: [456] } }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /temporarily rate limited/);
      return true;
    },
  );

  assert.equal(calls, 1);
});
