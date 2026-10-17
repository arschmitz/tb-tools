import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { getConsoleBrowserEnvironment, readConsolePhabricatorReview, registerConsoleBrowserAccess } from "../commands/graph/ai-browser-access.mjs";
import { createGraphCodexAppServer } from "../commands/graph/codex-app-server.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("console tasks read fresh Phabricator data through the authenticated console reader", async t => {
  const calls = [];
  const review = { revision: "D332509", comments: [{ content: "Fresh discussion" }], inlineComments: [{ suggestion: { content: "replacement" } }] };
  const info = await startInteractiveGraphServer({ html: "<p>test</p>", graphs: [], token: "browser-test",
    runCommand: async () => "", tryMonitor: null, implementationManager: null,
    phabWebSession: { getReview: async options => { calls.push(options); return review; } },
  });
  t.after(() => info.server.close());
  const env = getConsoleBrowserEnvironment();
  assert.deepEqual(await readConsolePhabricatorReview("D332509", { env }), review,
    "The reader should return fresh discussion and suggestions.");
  assert.equal(calls[0].includeRawPatch, false, "The reader should avoid downloading the supplied patch again.");
  assert.ok(calls[0].signal instanceof AbortSignal, "The reader should cancel browser work when the request closes.");
  await assert.rejects(readConsolePhabricatorReview("D332509", { env: { ...env, TB_CONSOLE_BROWSER_TOKEN: "wrong" } }),
    /Invalid interactive graph token/, "The server should reject an invalid token.");
  assert.equal(calls.length, 1, "An invalid token should not launch browser work.");
});

test("reader rejects missing connections, arbitrary URLs, and invalid revisions", async () => {
  await assert.rejects(readConsolePhabricatorReview("D1", { env: {} }), /no console browser connection/,
    "The reader should explain a missing console connection.");
  await assert.rejects(readConsolePhabricatorReview("https://example.com", { env: {} }), /Use a Phabricator revision/,
    "The reader should accept revision identifiers only.");
  await assert.rejects(readConsolePhabricatorReview("D1", { env: { TB_CONSOLE_BROWSER_URL: "https://example.com", TB_CONSOLE_BROWSER_TOKEN: "secret" } }),
    /local HTTP server/, "The reader should keep the connection token on the local server.");
});

test("new and resumed task processes inherit the console connection and remove it on close", () => {
  const previous = getConsoleBrowserEnvironment();
  const server = new EventEmitter();
  registerConsoleBrowserAccess(server, "http://127.0.0.1:1234/", "task-token");
  try {
    for (const threadId of ["", "saved-thread"]) {
      let environment;
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
      child.stdin = { writable: true }; child.kill = () => {};
      const client = createGraphCodexAppServer({ command: "codex", cwd: "/review/comm", threadId,
        spawnProcess: (_command, _args, options) => { environment = options.env; return child; } });
      assert.equal(environment.TB_CONSOLE_BROWSER_TOKEN, "task-token", "Each task process should receive its console connection.");
      client.close();
    }
  } finally { server.emit("close"); }
  assert.deepEqual(getConsoleBrowserEnvironment(), previous, "A closed console should remove only its own browser connection.");
});
