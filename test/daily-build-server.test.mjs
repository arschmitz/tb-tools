import assert from "node:assert/strict";
import test from "node:test";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("daily build settings and log require the console token", async t => {
  let settings = { enabled: false, times: [] };
  let runs = 0;
  let cancels = 0;
  const dailyBuild = {
    status: () => ({ settings, status: "idle" }),
    saveSettings: async value => { settings = value; },
    runNow: async () => { runs++; },
    cancel: () => { cancels++; },
    readLog: async () => "build output\n",
  };
  const graph = { path: "/repo/comm", label: "comm", repository: "comm",
    branch: "main", commits: [], commitCount: 0, diffs: {} };
  const started = await startInteractiveGraphServer({ graphs: [graph], token: "secret",
    html: "<html></html>", dailyBuild, getRustUpstreamStatus: async () => ({ state: "current" }) });
  t.after(() => new Promise(resolve => started.server.close(resolve)));
  const request = async (action, token = "secret") => fetch(new URL("/api/daily-build", started.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ...action }),
  });
  assert.equal((await fetch(new URL("/api/daily-build?token=wrong", started.url))).status, 403);
  assert.equal((await request({ action: "save", settings: { enabled: true, times: ["03:00"] } })).status, 200);
  assert.deepEqual((await (await fetch(new URL("/api/daily-build?token=secret", started.url))).json()).settings,
    { enabled: true, times: ["03:00"] });
  assert.equal((await request({ action: "run" })).status, 200);
  assert.equal((await request({ action: "cancel" })).status, 200);
  assert.equal(runs, 1);
  assert.equal(cancels, 1);
  assert.equal((await fetch(new URL("/api/daily-build/log?token=wrong", started.url))).status, 403);
  const log = await fetch(new URL("/api/daily-build/log?token=secret", started.url));
  assert.equal((await log.json()).output, "build output\n");
});
