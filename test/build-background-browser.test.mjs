import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
import { summarizeBackgroundJob } from "../commands/graph/background-jobs.mjs";

test("build jobs expose cancellation during the building phase", () => {
  const session = { id: "build-id", status: "running", phase: "building" };
  const job = summarizeBackgroundJob("Build", session);
  assert.equal(job.state, "running");
  assert.equal(job.cancelUrl, "/api/mach-action/build-id/cancel");
  assert.equal(summarizeBackgroundJob("Build", { ...session, cancelRequested: true }).cancelUrl, "");
});

test("a build leaves other actions enabled and stays cancelable after reload", async t => {
  let releaseBuild;
  let ownsCheckout = false;
  const implementationManager = {
    start() {}, stop() {}, list: () => [], ownsCheckout: () => ownsCheckout,
    create: async () => { ownsCheckout = true; return { id: "implementation" }; },
  };
  const graphs = [{ label: "comm", repository: "comm", path: "/test/comm", commits: [] }];
  const server = await startInteractiveGraphServer({ graphs, token: "test", tryMonitor: null,
    appConfig: { ai: { enabled: true } }, implementationManager,
    runCommand: async command => {
      if (command.cmd.endsWith("mach") && command.args[0] === "build") {
        return new Promise(resolve => { releaseBuild = resolve; });
      }
      return "";
    },
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "test" }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  t.after(async () => {
    releaseBuild?.("");
    server.server.closeAllConnections();
    await new Promise(resolve => server.server.close(resolve));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.evaluate(async () => {
    await (await import("/assets/graph-client/command-sessions.js")).startGraphMachAction("build");
  });
  await page.waitForFunction(() => globalThis.document.querySelector(".build-status-message")?.textContent.includes("Building"));
  assert.equal(await page.locator(".update-action:disabled, .graph-menu-command:disabled").count(), 0);
  assert.equal(await page.evaluate(async () => (await import("/assets/graph-client/command-sessions.js")).hasActiveCommandSession()), false);
  await page.evaluate(async () => {
    const commands = await import("/assets/graph-client/command-sessions.js");
    commands.setUpdateStatus("Another operation running", { busy: true });
    const { uiState } = await import("/assets/graph-client/config.js");
    commands.renderGraphMachSession(uiState.activeMachSession);
  });
  assert.equal(await page.locator(".update-status").textContent(), "Another operation running");
  assert.equal(await page.locator(".update-action:disabled").count(), 2);
  assert.equal(await page.getByRole("button", { name: "Cancel Build", exact: true }).isVisible(), true);
  for (const mode of ["update", "rebase"]) {
    const response = await fetch(new URL("/api/update-graphs", server.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test", mode, scope: "current", graphIndex: 0 }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    const jobs = await (await fetch(new URL("/api/background-jobs?token=test", server.url))).json();
    assert.equal(jobs.jobs.find(job => job.kind === "Build").phase, "building");
  }
  await page.evaluate(async () => {
    await (await import("/assets/graph-client/command-sessions.js")).promptForPostUpdateMachAction();
  });
  assert.equal(await page.locator("dialog[open]").count(), 0);
  const implementResponse = await fetch(new URL("/api/implement", server.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test" }),
  });
  assert.equal(implementResponse.status, 200, "A running build must not block Implement");
  assert.equal(ownsCheckout, true);
  await page.reload();
  await page.evaluate(async () => (await import("/assets/graph-client/background-jobs.js")).initializeBackgroundJobs());
  await page.evaluate(() => { globalThis.document.querySelector(".graph-options-menu").hidden = false; });
  await page.getByRole("menuitem", { name: "Background jobs", exact: true }).click();
  await page.getByRole("button", { name: "Cancel Build", exact: true }).click();
  await page.waitForFunction(() => globalThis.document.querySelector(".jobs-summary")?.textContent.startsWith("0 running"));
  const data = await (await fetch(new URL("/api/background-jobs?token=test", server.url))).json();
  assert.equal(data.jobs.find(job => job.kind === "Build").phase, "canceled");
});
