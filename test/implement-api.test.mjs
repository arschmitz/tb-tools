import assert from "node:assert/strict";
import { test } from "node:test";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

for (const enabled of [false, true]) test(`Implement API requires auth and ai.enabled=${enabled}`, async t => {
  const calls = []; let active; let stops = 0;
  const manager = { start() {}, stop() { stops++; }, list: () => active ? [active] : [], active: () => active,
    async create(body) { calls.push(body); active = { id: "impl", phase: "preparing" }; return active; },
    async feedback(id, body) { calls.push({ id, text: body.text }); return active; },
    async diff() { return { workingHtml: "styled" }; },
    async retry(id) { calls.push(id); return active; }, cancel() { active = null; return { phase: "cancelled" }; } };
  const info = await startInteractiveGraphServer({ html: "", graphs: [{ path: "/working/comm", label: "comm" }], token: "secret",
    appConfig: { ai: { enabled } }, implementationManager: manager, tryMonitor: null,
    runCommand: async () => "abc123" });
  t.after(async () => { info.server.closeAllConnections(); await new Promise(resolve => info.server.close(resolve)); assert.ok(stops); });
  const post = (route, body) => fetch(new URL(route, info.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/implement", { token: "wrong", bugId: 123, base: "main" })).status, 403);
  const response = await post("/api/implement", { token: "secret", bugId: 123, base: "main" });
  assert.equal(response.status, enabled ? 200 : 403);
  if (!enabled) { assert.equal(calls.length, 0); return; }
  assert.equal(calls[0].bugId, 123);
  const result = await (await fetch(new URL("/api/implement?token=secret", info.url))).json();
  assert.equal(result.currentHash, "abc123"); assert.equal(result.runs[0].id, "impl");
  for (const route of ["/api/commit", "/api/checkout", "/api/checkout-transfer", "/api/amend-current", "/api/try", "/api/interactive-rebase", "/api/mach-action", "/api/patch-update", "/api/dashboard/patch-action"]) {
    assert.equal((await post(route, { token: "secret" })).status, 409, route);
  }
  assert.equal((await post("/api/implement/impl/feedback", { token: "wrong", text: "test" })).status, 403);
  assert.equal((await post("/api/implement/impl/feedback", { token: "secret", text: "test" })).status, 200);
  assert.deepEqual(calls.at(-1), { id: "impl", text: "test" });
  assert.equal((await fetch(new URL("/api/implement/impl/diff?token=wrong", info.url))).status, 403);
  assert.equal((await (await fetch(new URL("/api/implement/impl/diff?token=secret", info.url))).json()).workingHtml, "styled");
  assert.equal((await post("/api/implement/impl/retry", { token: "secret" })).status, 200);
  assert.equal((await post("/api/implement/impl/cancel", { token: "secret" })).status, 200);
});


test("an inactive implementation waiting for a base update does not block main updates", async t => {
  const manager = { start() {}, stop() {}, active: () => ({ phase: "monitoring", error: "Needs current base" }), ownsCheckout: () => false };
  const info = await startInteractiveGraphServer({ html: "", graphs: [], token: "secret",
    appConfig: { ai: { enabled: true } }, implementationManager: manager, tryMonitor: null });
  t.after(async () => { info.server.closeAllConnections(); await new Promise(resolve => info.server.close(resolve)); });
  for (const route of ["/api/update-graphs", "/api/checkout", "/api/interactive-rebase"]) {
    const response = await fetch(new URL(route, info.url), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }) });
    assert.equal(response.status, 403, `${route} reaches normal auth instead of the checkout lock`);
  }
});
