import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  clearBugzillaBugCache,
  getAssignedOpenBugs,
  getBug,
  getBugHistoryByIds,
  getBugs,
  getBugsByIds,
  getBugsWithAttachmentsByIds,
  getNeedinfoOpenBugs,
  getUsersByMatches,
} from "../lib/bugzilla.mjs";
import config from "../lib/config.mjs";
import { readJsonResponse } from "../lib/http.mjs";
import {
  buildNotionBugFilter,
  getNotionStoriesByBugId,
  isNotionAuthenticationError,
  NOTION_VERSION,
} from "../lib/notion.mjs";
import phab, {
  clearPhabricatorRequestState,
  comment as postPhabricatorComment,
  createInlineComment,
  editRevision,
  flushPhabricatorRequestLog,
} from "../lib/phab.mjs";

const originalFetch = global.fetch;
const originalPhabricatorConfig = config.phabricator
  ? { ...config.phabricator }
  : undefined;
const originalNotionConfig = config.notion
  ? { ...config.notion }
  : undefined;

afterEach(() => {
  global.fetch = originalFetch;
  clearPhabricatorRequestState();
  clearBugzillaBugCache();

  if (originalPhabricatorConfig) {
    config.phabricator = { ...originalPhabricatorConfig };
  } else {
    delete config.phabricator;
  }

  if (originalNotionConfig) {
    config.notion = { ...originalNotionConfig };
  } else {
    delete config.notion;
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

test("dashboard Bugzilla queries limit results to open assigned bugs", async () => {
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(new URL(String(url)));
    return new Response(JSON.stringify({ bugs: [{ id: 12345 }] }), { status: 200 });
  };

  const assigned = await getAssignedOpenBugs({ assignedTo: "me@example.com" });
  const needinfo = await getNeedinfoOpenBugs({ requestee: "me@example.com" });
  const selected = await getBugsByIds([12345, 67890]);
  const withAttachments = await getBugsWithAttachmentsByIds([12345]);

  assert.deepEqual(assigned, [{ id: 12345 }]);
  assert.deepEqual(needinfo, [{ id: 12345 }]);
  assert.deepEqual(selected, [{ id: 12345 }]);
  assert.deepEqual(withAttachments, [{ id: 12345 }]);
  assert.equal(requestedUrls[0].searchParams.get("assigned_to"), "me@example.com");
  assert.equal(requestedUrls[0].searchParams.get("resolution"), "---");
  assert.deepEqual(requestedUrls[0].searchParams.getAll("bug_status"), [
    "UNCONFIRMED",
    "NEW",
    "ASSIGNED",
    "REOPENED",
    "VERIFIED",
  ]);
  assert.equal(requestedUrls[1].searchParams.get("quicksearch"), "needinfo?me@example.com");
  assert.equal(requestedUrls[1].searchParams.get("resolution"), "---");
  assert.deepEqual(requestedUrls[1].searchParams.getAll("bug_status"), [
    "UNCONFIRMED",
    "NEW",
    "ASSIGNED",
    "REOPENED",
    "VERIFIED",
  ]);
  assert.equal(
    requestedUrls[1].searchParams.get("include_fields"),
    "id,summary,status,resolution,is_open,product,component,last_change_time,flags",
  );
  assert.deepEqual(requestedUrls[2].searchParams.getAll("ids"), ["67890"]);
  assert.equal(
    requestedUrls[3].searchParams.get("include_fields"),
    "id,attachments.id,attachments.file_name,attachments.content_type,attachments.is_obsolete,attachments.last_change_time,attachments.flags",
  );
});

test("Bugzilla bug records are shared across views and coalesced in flight", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({
      bugs: [{
        id: 12345,
        is_open: true,
        status: "NEW",
        summary: "Cached patch bug",
      }],
    }), { status: 200 });
  };

  const fields = "id,summary,status,resolution,is_open,keywords,assigned_to,assigned_to_detail,product,component,last_change_time";
  const [first, second] = await Promise.all([
    getBugsByIds([12345], { includeFields: fields }),
    getBugsByIds([12345], { includeFields: fields }),
  ]);
  const fromCommitPill = await getBug(12345);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(fromCommitPill.bugs[0].summary, "Cached patch bug");
});

test("Bugzilla user lookup batches distinct match values", async () => {
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return new Response(JSON.stringify({ users: [{ name: "reviewer@example.com" }] }), {
      status: 200,
    });
  };

  const users = await getUsersByMatches([
    "Reviewer Name",
    "reviewer",
    "Reviewer Name",
  ]);

  assert.deepEqual(users, [{ name: "reviewer@example.com" }]);
  assert.equal(requestedUrl.pathname, "/rest/user");
  assert.deepEqual(requestedUrl.searchParams.getAll("match"), [
    "Reviewer Name",
    "reviewer",
  ]);
  assert.equal(requestedUrl.searchParams.get("include_fields"), "id,name,real_name,email");
});

test("Bugzilla history requests batch distinct bug IDs", async () => {
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return new Response(JSON.stringify({
      bugs: [{ id: 12345, history: [] }, { id: 67890, history: [] }],
    }), { status: 200 });
  };

  const histories = await getBugHistoryByIds([12345, 67890, 12345]);

  assert.deepEqual(histories.map((history) => history.id), [12345, 67890]);
  assert.equal(requestedUrl.pathname, "/rest/bug/12345/history");
  assert.deepEqual(requestedUrl.searchParams.getAll("ids"), ["67890"]);
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

test("Phabricator review helpers publish drafts and edit final review actions", async () => {
  useTestPhabricatorToken();
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options.body.get("params"))));
    return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
  };

  await postPhabricatorComment({
    id: "D123456",
    message: "",
    action: "comment",
    resolve: true,
  });
  await editRevision({
    id: "D123456",
    message: "Please address the focus regression.",
    action: "reject",
  });
  await editRevision({
    id: "D123456",
    message: "",
    action: "accept",
  });
  await createInlineComment({
    revision: "D123456",
    filePath: "mail/example.mjs",
    isNewFile: true,
    lineNumber: 12,
    content: "Use the shared helper.",
  });

  assert.deepEqual(requests, [
    {
      revision_id: "123456",
      message: "",
      action: "comment",
      attach_inlines: true,
      __conduit__: { token: "test-token" },
    },
    {
      objectIdentifier: "D123456",
      transactions: [
        { type: "comment", value: "Please address the focus regression." },
        { type: "reject", value: true },
      ],
      __conduit__: { token: "test-token" },
    },
    {
      objectIdentifier: "D123456",
      transactions: [{ type: "accept", value: true }],
      __conduit__: { token: "test-token" },
    },
    {
      revisionID: 123456,
      filePath: "mail/example.mjs",
      isNewFile: true,
      lineNumber: 12,
      lineLength: 1,
      content: "Use the shared helper.",
      __conduit__: { token: "test-token" },
    },
  ]);
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

test("phab serializes distinct remote requests", async () => {
  useTestPhabricatorToken();

  let activeRequests = 0;
  let maximumActiveRequests = 0;

  global.fetch = async () => {
    activeRequests++;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeRequests--;

    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  };

  await Promise.all([
    phab({ route: "differential.query", params: { ids: [123] } }),
    phab({ route: "project.search", params: { constraints: {} } }),
  ]);

  assert.equal(maximumActiveRequests, 1);
});

test("phab caches revision comment requests", async () => {
  useTestPhabricatorToken();

  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(
      String(url),
      "https://phabricator.services.mozilla.com/api/differential.getrevisioncomments",
    );
    assert.deepEqual(JSON.parse(options.body.get("params")), {
      ids: [123],
      inlines: true,
      __conduit__: { token: "test-token" },
    });

    return new Response(JSON.stringify({
      result: { 123: [] },
    }), { status: 200 });
  };

  const first = await phab({
    route: "differential.getrevisioncomments",
    params: { ids: [123], inlines: true },
  });
  const second = await phab({
    route: "differential.getrevisioncomments",
    params: { ids: [123], inlines: true },
  });

  assert.equal(calls, 1);
  assert.deepEqual(first, { result: { 123: [] } });
  assert.deepEqual(second, { result: { 123: [] } });
  assert.notEqual(first, second);
});

test("phab persists a privacy-safe request ledger", async (t) => {
  useTestPhabricatorToken();
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-phab-request-log-"));
  const logPath = path.join(directory, "requests.jsonl");
  const previousLogPath = process.env.TB_TOOLS_PHAB_REQUEST_LOG_PATH;

  process.env.TB_TOOLS_PHAB_REQUEST_LOG_PATH = logPath;
  t.after(async () => {
    if (previousLogPath === undefined) {
      delete process.env.TB_TOOLS_PHAB_REQUEST_LOG_PATH;
    } else {
      process.env.TB_TOOLS_PHAB_REQUEST_LOG_PATH = previousLogPath;
    }

    await rm(directory, { force: true, recursive: true });
  });

  global.fetch = async () => new Response(JSON.stringify({ result: [] }), {
    status: 200,
  });

  await phab({ route: "differential.query", params: { ids: [123456] } });
  await phab({ route: "differential.query", params: { ids: [123456] } });
  await flushPhabricatorRequestLog();

  const entries = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);

  assert.ok(entries.some((entry) => entry.event === "cache-miss"));
  assert.ok(entries.some((entry) => entry.event === "network-start"));
  assert.ok(entries.some((entry) => entry.event === "network-success"));
  assert.ok(entries.some((entry) => entry.event === "cache-hit"));
  assert.ok(entries.every((entry) => entry.route === "differential.query"));
  assert.ok(entries.every((entry) => entry.params.ids.size === 1));
  assert.doesNotMatch(JSON.stringify(entries), /test-token|123456/);
});

test("phab bypassCache refreshes a cached read-only response", async () => {
  useTestPhabricatorToken();

  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ result: [{ id: calls }] }), { status: 200 });
  };

  const first = await phab({ route: "differential.query", params: { ids: [123] } });
  const refreshed = await phab({
    route: "differential.query",
    params: { ids: [123] },
    bypassCache: true,
  });
  const cachedRefresh = await phab({ route: "differential.query", params: { ids: [123] } });

  assert.equal(calls, 2);
  assert.deepEqual(first, { result: [{ id: 1 }] });
  assert.deepEqual(refreshed, { result: [{ id: 2 }] });
  assert.deepEqual(cachedRefresh, { result: [{ id: 2 }] });
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

test("phab applies a rate-limit cooldown across every route", async () => {
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
    phab({ route: "project.search", params: { constraints: {} } }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /temporarily rate limited/);
      return true;
    },
  );

  assert.equal(calls, 1);
});

test("phab preserves a rate-limit cooldown across a request-state reset", async (t) => {
  useTestPhabricatorToken();
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-phab-rate-limit-"));
  const statePath = path.join(directory, "rate-limit.json");
  const previousStatePath = process.env.TB_TOOLS_PHAB_RATE_LIMIT_STATE_PATH;
  let networkRequests = 0;

  process.env.TB_TOOLS_PHAB_RATE_LIMIT_STATE_PATH = statePath;
  t.after(async () => {
    if (previousStatePath === undefined) {
      delete process.env.TB_TOOLS_PHAB_RATE_LIMIT_STATE_PATH;
    } else {
      process.env.TB_TOOLS_PHAB_RATE_LIMIT_STATE_PATH = previousStatePath;
    }

    await rm(directory, { force: true, recursive: true });
  });

  global.fetch = async () => {
    networkRequests++;
    return new Response(JSON.stringify({ message: "too many requests" }), {
      headers: { "retry-after": "30" },
      status: 429,
      statusText: "Too Many Requests",
    });
  };

  await assert.rejects(
    phab({ route: "differential.query", params: { ids: [123] } }),
    /429 Too Many Requests/,
  );

  const persistedState = await readFile(statePath, "utf8");
  const state = JSON.parse(persistedState);

  assert.ok(state.globalCooldownUntil > Date.now());
  assert.equal(state.recentRequests.length, 1);
  assert.equal(state.recentRequests[0].route, "differential.query");

  clearPhabricatorRequestState();
  global.fetch = async () => {
    networkRequests++;
    throw new Error("The persisted cooldown should prevent this request.");
  };

  await assert.rejects(
    phab({ route: "project.search", params: { constraints: {} } }),
    (error) => {
      assert.match(error.message, /temporarily rate limited/);
      assert.equal(error.isLocalPhabricatorCooldown, true);
      return true;
    },
  );
  assert.equal(networkRequests, 1);
  assert.equal(await readFile(statePath, "utf8"), persistedState);
});

test("buildNotionBugFilter matches supported bug property types", () => {
  assert.deepEqual(
    buildNotionBugFilter({
      bugId: "123456",
      property: { name: "Bug", id: "bug", type: "number" },
    }),
    {
      property: "bug",
      number: { equals: 123456 },
    },
  );
  assert.deepEqual(
    buildNotionBugFilter({
      bugId: "123456",
      property: { name: "Bug", type: "rich_text" },
    }),
    {
      property: "Bug",
      rich_text: { contains: "123456" },
    },
  );
});

test("getNotionStoriesByBugId queries the configured data source by bug id", async () => {
  const requests = [];
  const notionConfig = {
    notion: {
      token: "secret-notion-token",
      dataSourceId: "data-source-id",
      bugProperty: "Bug",
      titleProperty: "Name",
      statusProperty: "Status",
    },
  };

  const result = await getNotionStoriesByBugId({
    bugId: "123456",
    config: notionConfig,
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : undefined,
      });

      assert.equal(options.headers.Authorization, "Bearer secret-notion-token");
      assert.equal(options.headers["Notion-Version"], NOTION_VERSION);

      if (String(url).endsWith("/data_sources/data-source-id")) {
        return new Response(JSON.stringify({
          properties: {
            Bug: { id: "bug", type: "number" },
            Name: { id: "title", type: "title" },
            Status: { id: "status", type: "status" },
          },
        }), { status: 200 });
      }

      assert.equal(
        String(url),
        "https://api.notion.com/v1/data_sources/data-source-id/query",
      );
      assert.deepEqual(JSON.parse(options.body).filter, {
        property: "bug",
        number: { equals: 123456 },
      });

      return new Response(JSON.stringify({
        results: [
          {
            id: "page-id",
            url: "https://www.notion.so/story",
            last_edited_time: "2026-08-05T12:00:00.000Z",
            properties: {
              Bug: { type: "number", number: 123456 },
              Name: {
                type: "title",
                title: [{ plain_text: "Fix account setup" }],
              },
              Status: {
                type: "status",
                status: { name: "In progress" },
              },
            },
          },
        ],
      }), { status: 200 });
    },
  });

  assert.deepEqual(
    requests.map((request) => [request.method, request.url]),
    [
      ["GET", "https://api.notion.com/v1/data_sources/data-source-id"],
      ["POST", "https://api.notion.com/v1/data_sources/data-source-id/query"],
    ],
  );
  assert.deepEqual(result, {
    bugId: "123456",
    dataSourceId: "data-source-id",
    bugProperty: "Bug",
    stories: [
      {
        id: "page-id",
        url: "https://www.notion.so/story",
        title: "Fix account setup",
        bug: "123456",
        status: "In progress",
        lastEditedTime: "2026-08-05T12:00:00.000Z",
        inTrash: false,
      },
    ],
  });
});

test("getNotionStoriesByBugId is disabled when Notion is not configured", async () => {
  const result = await getNotionStoriesByBugId({
    bugId: "123456",
    config: {},
    fetchImpl: async () => {
      throw new Error("Notion should not be queried.");
    },
  });

  assert.equal(result, null);
});

test("isNotionAuthenticationError recognizes invalid or unauthorized tokens", () => {
  assert.equal(isNotionAuthenticationError({ statusCode: 401 }), true);
  assert.equal(isNotionAuthenticationError({ status: 403 }), true);
  assert.equal(isNotionAuthenticationError({ statusCode: 404 }), false);
  assert.equal(isNotionAuthenticationError(new Error("Network failure")), false);
});
