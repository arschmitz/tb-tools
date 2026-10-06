import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRemoteAccessService } from "../desktop/remote-access.mjs";

test("phone access points private HTTPS Serve at the current gateway after restart", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-access-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "remote.json");
  const calls = [];
  const runCommand = async command => {
    calls.push(command.args);
    if (command.args[0] === "status") return JSON.stringify({ BackendState: "Running",
      Self: { DNSName: "mac.example.ts.net." } });
    if (command.args[0] === "serve" && command.args[1] === "status") return "{}";
    return "";
  };
  const first = createRemoteAccessService({ gatewayUrl: "http://127.0.0.1:4311/",
    stateFile, runCommand, executable: "tailscale" });
  await first.start();
  assert.equal(first.status().enabled, false);
  assert.equal((await first.enable()).address, "https://mac.example.ts.net:8443/");
  assert.deepEqual(calls.at(-1), ["serve", "--bg", "--yes", "--https=8443",
    "http://127.0.0.1:4311/"]);
  const restarted = createRemoteAccessService({ gatewayUrl: "http://127.0.0.1:5311/",
    stateFile, runCommand, executable: "tailscale" });
  await restarted.start();
  assert.deepEqual(calls.at(-1), ["serve", "--bg", "--yes", "--https=8443",
    "http://127.0.0.1:5311/"]);
  assert.equal((await restarted.disable()).enabled, false);
  assert.deepEqual(calls.at(-1), ["serve", "--https=8443", "off"]);
});

test("phone access does not replace another Serve route or a public Funnel route", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-access-conflict-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let configuration = { Web: { "mac.example.ts.net:8443": {
    Handlers: { "/": { Proxy: "http://127.0.0.1:9999/" } },
  } }, TCP: { 8443: { HTTPS: true } } };
  const calls = [];
  const service = createRemoteAccessService({ gatewayUrl: "http://127.0.0.1:4311/",
    stateFile: path.join(root, "remote.json"), executable: "tailscale",
    runCommand: async command => {
      calls.push(command.args);
      if (command.args[0] === "status") return JSON.stringify({ BackendState: "Running",
        Self: { DNSName: "mac.example.ts.net." } });
      return JSON.stringify(configuration);
    } });
  await assert.rejects(() => service.enable(), /already used/);
  assert.equal(calls.some(args => args.includes("--bg")), false);
  configuration = { AllowFunnel: { "mac.example.ts.net:8443": true } };
  await assert.rejects(() => service.enable(), /already used/);
  assert.equal(calls.some(args => args.includes("--bg")), false);
});
