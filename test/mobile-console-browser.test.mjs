/* global document */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
import { createMobileGateway } from "../desktop/mobile-gateway.mjs";

test("paired phone opens the console at phone width and can change views", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mobile-console-test-"));
  const graph = { label: "comm", path: "/repo/comm", checkout: "working",
    repository: "comm", commits: [], diffs: {} };
  const token = "desktop-test-secret";
  let savedSchedule;
  const dailyBuild = {
    status: () => ({ settings: savedSchedule || { enabled: false, times: [] }, status: "idle" }),
    saveSettings: async value => { savedSchedule = value; },
  };
  const html = buildGraphHtml({ graphs: [graph], interactive: { enabled: true,
    aiEnabled: false, token }, stylesheetHref: "/assets/graph-client/style.css",
  scriptSrcs: ["/assets/graph-client/init.js"] });
  const consoleServer = await startInteractiveGraphServer({ graphs: [graph], token,
    html, dailyBuild, tryMonitor: null, runCommand: async () => "" });
  const gateway = createMobileGateway({ targetUrl: consoleServer.url, desktopToken: token,
    html, secureCookie: false, stateFile: path.join(directory, "sessions.json") });
  const { url } = await gateway.start();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await gateway.close();
    consoleServer.server.closeAllConnections();
    await new Promise(resolve => consoleServer.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(url);
  await page.locator('input[name="code"]').fill(gateway.issuePairCode().code);
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await page.getByRole("heading", { name: "Thunderbird Desktop Console" }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.content),
    "width=device-width, initial-scale=1");
  assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 390);
  assert.equal(await page.locator(".console-view-tab").count() > 1, true);
  const nextView = page.locator(".console-view-tab").first();
  await nextView.click();
  assert.match(await nextView.getAttribute("class"), /active/);
  const action = await page.evaluate(async () => {
    const config = JSON.parse(document.querySelector("#graph-config").textContent);
    const response = await fetch("/api/daily-build", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: config.interactive.token, action: "save",
        settings: { enabled: true, times: ["03:00"] } }),
    });
    return response.status;
  });
  assert.equal(action, 200);
  assert.deepEqual(savedSchedule, { enabled: true, times: ["03:00"] });
  assert.deepEqual(pageErrors, []);
});
