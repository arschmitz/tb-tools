import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMobileGateway } from "../desktop/mobile-gateway.mjs";

test("phone pairing grants a private session and proxies actions with the desktop token", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mobile-gateway-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, method: request.method,
      body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const targetUrl = `http://127.0.0.1:${upstream.address().port}/`;
  const gateway = createMobileGateway({ targetUrl, desktopToken: "desktop-secret",
    html: "<html><head></head><body><script>const token = 'desktop-secret'</script></body></html>",
    stateFile: path.join(root, "sessions.json"), secureCookie: false });
  const { url } = await gateway.start();
  t.after(() => gateway.close());
  const origin = new URL(url).origin;
  const pair = gateway.issuePairCode();
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(`${url}api/state?token=desktop-secret`)).status, 401);
  assert.equal((await fetch(`${url}pair`, { method: "POST", headers: {
    origin: "https://attacker.example", "content-type": "application/json",
  }, body: JSON.stringify({ code: pair.code }) })).status, 403);
  const paired = await fetch(`${url}pair`, { method: "POST", headers: {
    origin, "content-type": "application/json",
  }, body: JSON.stringify({ code: pair.code }) });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  const page = await (await fetch(url, { headers: { cookie } })).text();
  assert.doesNotMatch(page, /desktop-secret/);
  assert.match(page, /manifest.webmanifest/);
  const token = /const token = '([^']+)'/.exec(page)?.[1];
  assert.ok(token);
  assert.equal((await fetch(`${url}api/state?token=wrong`, { headers: { cookie } })).status, 403);
  assert.equal((await fetch(`${url}api/state?token=${token}`, { headers: { cookie } })).status, 200);
  assert.equal(received.at(-1).url, "/api/state?token=desktop-secret");
  assert.equal((await fetch(`${url}api/action`, { method: "POST", headers: {
    cookie, origin: "https://attacker.example", "content-type": "application/json",
  }, body: JSON.stringify({ token }) })).status, 403);
  assert.equal((await fetch(`${url}api/action`, { method: "POST", headers: {
    cookie, origin, "content-type": "application/json",
  }, body: JSON.stringify({ token, action: "build" }) })).status, 200);
  assert.deepEqual(JSON.parse(received.at(-1).body), { token: "desktop-secret", action: "build" });
  assert.equal((await fetch(`${url}icon.png`, { headers: { cookie } })).headers.get("content-type"), "image/png");
  assert.equal(gateway.status().pairedDevices, 1);
  await gateway.revokeAll();
  assert.match(await (await fetch(url, { headers: { cookie } })).text(), /Pair Commands/);
  assert.equal((await fetch(`${url}api/state`, { headers: { cookie } })).status, 401);
});
