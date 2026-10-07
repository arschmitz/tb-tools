import assert from "node:assert/strict";
import { test } from "node:test";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("opening another review cannot cancel a running review, and old source actions check their commit", async t => {
  const sessions = [];
  const server = await startInteractiveGraphServer({ html: "", token: "test", tryMonitor: null,
    appConfig: { ai: { enabled: true } }, graphs: [{ label: "Review comm", repository: "comm", checkout: "review", path: "/review/comm" }],
    runCommand: async () => "changed-head",
    preparePatchReviewSession: async ({ session }) => { Object.assign(session, { status: "reviewing", currentHash: "original-head" }); sessions.push(session); },
  });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const post = (route, data) => fetch(new URL(route, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...data }) });
  const first = await (await post("/api/review", { revision: "D123" })).json();
  assert.equal((await post("/api/review", { revision: "D456" })).status, 409);
  assert.equal((await (await post("/api/review", { revision: "D123" })).json()).id, first.id);
  assert.equal(sessions[0].cancelled, false);
  sessions[0].status = "review";
  assert.equal((await post("/api/review", { revision: "D456" })).status, 200);
  assert.equal(sessions[0].cancelled, false);
  sessions[1].status = "review";
  const stale = await post(`/api/review/${first.id}/apply`, { itemId: "finding" });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /different commit/);
});
