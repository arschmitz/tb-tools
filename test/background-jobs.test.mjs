import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { summarizeBackgroundJob } from "../commands/graph/background-jobs.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("job monitor shows actual work and excludes unresolved historical records", () => {
  assert.equal(summarizeBackgroundJob("Try repair", { phase: "waiting" }).state, "waiting");
  for (const phase of ["rust-blocked", "waiting-new-try", "paused", "needs-rebase", "error", "unknown"]) {
    assert.equal(summarizeBackgroundJob("Try repair", { phase }), null);
  }
  assert.equal(summarizeBackgroundJob("Try repair", { phase: "passed" }).state, "finished");
  const running = summarizeBackgroundJob("Try repair", { phase: "analyzing", aiPid: process.pid });
  assert.equal(running.state, "running"); assert.equal(running.aiRunning, true);
  const preparing = summarizeBackgroundJob("Try repair", { phase: "repairing", workerPid: process.pid, repairActivity: "Preparing checkout" });
  assert.equal(preparing.state, "running");
  assert.equal(preparing.aiRunning, false);
  assert.equal(preparing.detail, "Preparing checkout");
});

test("monitor authenticates, scopes saved jobs, and shows live state without starting work", async t => {
  const graphs = [{ label: "comm", path: "/test/comm", commits: [] }];
  const states = [
    { id: "blocked", path: "/test/comm", phase: "rust-blocked", subject: "Rust failure", error: "Rust update needed", attempts: [{ url: "https://example.com/try" }] },
    { id: "waiting", path: "/test/comm", phase: "waiting", subject: "Waiting for CI", attempts: [] },
    { id: "done", path: "/test/comm", phase: "passed", subject: "Finished patch", attempts: [] },
    { id: "other", path: "/other/comm", phase: "repairing", attempts: [] },
    { id: "old", path: "/test/comm", imported: true, phase: "paused", attempts: [] },
  ];
  const server = await startInteractiveGraphServer({ graphs, token: "test", tryMonitor: null,
    runCommand: async () => assert.fail("Viewing jobs must not run commands"),
    backgroundTryStore: { list: () => states, isAutomationPaused: () => true },
    appConfig: { ai: { enabled: true } },
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "test", aiEnabled: true }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  assert.equal((await fetch(new URL("/api/background-jobs?token=wrong", server.url))).status, 403);
  const data = await (await fetch(new URL("/api/background-jobs?token=test", server.url))).json();
  assert.deepEqual(data.jobs.map(job => job.id), ["Try repair:waiting", "Try repair:done"]);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.url);
  await page.evaluate(async () => (await import("/assets/graph-client/background-jobs.js")).initializeBackgroundJobs());
  await page.getByRole("button", { name: "Background jobs", exact: true }).click();
  await page.getByRole("heading", { name: "Waiting for CI", exact: true }).waitFor();
  await page.evaluate(async () => {
    const { showConnectionLost } = await import("/assets/graph-client/background-jobs.js");
    showConnectionLost(); showConnectionLost();
  });
  assert.equal(await page.locator(".background-jobs-dialog .server-connection-alert").count(), 1);
  assert.match(await page.locator(".background-jobs-dialog .server-connection-alert").textContent(), /status is out of date/);
  await page.evaluate(async () => (await import("/assets/graph-client/background-jobs.js")).clearConnectionLost());
  assert.equal(await page.locator(".server-connection-alert").count(), 0);
  assert.equal(await page.locator(".background-job").count(), 1);
  assert.match(await page.locator(".jobs-summary").textContent(), /1 waiting.*0 AI processes running.*paused/);
  await page.getByLabel("Show finished jobs").check();
  assert.equal(await page.locator(".background-job").count(), 2);
  assert.equal(await page.getByRole("heading", { name: "Rust failure", exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator(".jobs-summary").textContent(), /blocked/);
  states[1].phase = "passed";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => globalThis.document.querySelector('.jobs-summary').textContent.includes('0 waiting'));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await page.locator(".background-jobs-dialog").evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator(".background-jobs-open").evaluate(button => button === globalThis.document.activeElement), true);
});

test("completed unrelated assessment cannot leave a waiting repair card", () => {
  const job = summarizeBackgroundJob("Try repair", { id: "old", phase: "repairing",
    error: "The repair must list each source file to commit.",
    attempts: [{ statusComplete: true, failedJobCount: 1, assessment: { failures: [{ cause: "unrelated" }] } }] });
  assert.equal(job.state, "finished");
  assert.equal(job.phase, "passed");
  assert.equal(job.detail, "No patch-caused failures.");
});

test("a waiting ancestor repair identifies its target and next step", () => {
  const job = summarizeBackgroundJob("Try repair", { phase: "analyzing", subject: "Bug 2061192",
    fixupTargetSubject: "Bug 2061188", error: "Codex App Server was stopped." });
  assert.equal(job.state, "waiting");
  assert.equal(job.repairTarget, "Bug 2061188");
  assert.match(job.nextAction, /Retry/);
});

test("finished and active jobs do not show a pending retry timer", () => {
  for (const session of [
    { phase: "passed", nextCheckAt: 999999, repairActivity: "Working" },
    { phase: "analyzing", workerPid: process.pid, nextCheckAt: 999999 },
  ]) assert.equal(summarizeBackgroundJob("Try repair", session).nextCheckAt, null);
  const waiting = summarizeBackgroundJob("Try repair", { phase: "waiting", repairActivity: "Working", nextCheckAt: 999999 });
  assert.equal(waiting.detail, "Waiting for CI results.");
  assert.equal(waiting.nextCheckAt, 999999);
});
