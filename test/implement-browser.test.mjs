import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { formatPrettyDiffHtml } from "../commands/graph/diff-renderer.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

for (const aiEnabled of [false, true]) test(`Implement cards and base choices respect AI enabled=${aiEnabled}`, async t => {
  const server = await startInteractiveGraphServer({ graphs: [], token: "secret", tryMonitor: null,
    html: buildGraphHtml({ graphs: [], interactive: { enabled: true, aiEnabled, token: "secret" }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const page = await browser.newPage();
  const calls = []; let runs = [];
  await page.route("**/api/dashboard?*", route => route.fulfill({ json: { ok: true,
    assignedBugs: [{ id: 123, summary: "Implement keyboard navigation", status: "NEW", hasPatch: false }],
    inProgressBugs: [{ id: 456, summary: "Existing patch", hasPatch: true, patches: [] }] } }));
  await page.route("**/api/implement**", route => {
    if (route.request().method() === "GET") {
      if (route.request().url().includes("/diff?")) return route.fulfill({ json: { ok: true, workingHtml: formatPrettyDiffHtml("diff --git a/feature.js b/feature.js\n--- a/feature.js\n+++ b/feature.js\n@@ -1 +1 @@\n-oldSource();\n+newSource();\n"), committedHtml: "" } });
      if (route.request().url().includes("/impl-1?")) return route.fulfill({ json: { ok: true, ...runs[0] } });
      return route.fulfill({ json: { ok: true, currentHash: "abcdef1234567890", runs } });
    }
    const data = route.request().postDataJSON(); calls.push(data);
    if (route.request().url().endsWith("/cancel")) {
      runs[0].phase = "cancelled"; runs[0].error = "";
      return route.fulfill({ json: { ok: true, run: runs[0] } });
    }
    if (route.request().url().endsWith("/feedback")) {
      runs[0].instructions.push({ text: data.text });
      return route.fulfill({ json: { ok: true, run: runs[0] } });
    }
    runs = [{ id: "impl-1", bugId: 123, branch: "Bug-123", phase: "implementing", createdAt: 1, reports: [], instructions: [{ text: data.instructions }], model: "gpt-6-astra" }];
    return route.fulfill({ json: { ok: true, run: runs[0] } });
  });
  await page.goto(server.url);
  await page.evaluate(async () => (await import("/assets/graph-client/dashboard.js")).showDashboard());
  await page.locator(".dashboard-bug-title").first().waitFor();
  assert.equal(await page.locator(".dashboard-implement").count(), aiEnabled ? 1 : 0);
  if (!aiEnabled) { assert.equal(await page.locator(".dashboard-implement-runs").count(), 0); return; }
  await page.locator(".dashboard-implement").press("Enter");
  const modal = page.locator("#implement-dialog[open]");
  await modal.waitFor();
  assert.match(await modal.locator('[data-implement="base"]').textContent(), /abcdef123456/);
  await modal.locator('[data-implement="base"]').selectOption("current");
  await modal.locator('[data-implement="instructions"]').fill("Keep keyboard support.");
  await modal.getByRole("button", { name: "Start Implement", exact: true }).click();
  await modal.locator('[data-implement="phase"]').filter({ hasText: "implementing" }).waitFor();
  assert.equal(await modal.getByRole("button", { name: "Cancel implementation", exact: true }).isVisible(), true);
  assert.equal(calls[0].base, "current"); assert.equal(calls[0].expectedHead, "abcdef1234567890");
  assert.equal(calls[0].instructions, "Keep keyboard support.");
  await modal.locator('[data-implement="working"] .pretty-file').waitFor();
  await modal.locator('[data-implement="message"]').fill("Test Escape too.");
  await modal.getByRole("button", { name: "Send", exact: true }).click();
  await modal.locator('[data-implement="history"]').filter({ hasText: "Test Escape too." }).waitFor();
  assert.equal(calls[1].text, "Test Escape too.");
  await modal.locator('[data-implement="message"]').fill("Unsent draft");
  await modal.getByRole("button", { name: "Minimize task and keep it running" }).click();
  await page.locator('.ai-task-toast[data-task-key="implement:impl-1"] .ai-task-open').click();
  await modal.waitFor();
  assert.equal(await modal.locator('[data-implement="message"]').inputValue(), "Unsent draft");
  await page.evaluate(() => { globalThis.document.querySelector(".dashboard-panel").hidden = true; });
  runs[0].activity = "Running keyboard tests";
  await modal.locator('[data-implement="activity"]').filter({ hasText: "Running keyboard tests" }).waitFor();
  await page.evaluate(() => { globalThis.document.querySelector(".dashboard-panel").hidden = false; });
  runs[0].activities = [
    { id: "note-1", kind: "note", title: "Codex note", detail: "Checking keyboard navigation" },
    { id: "command-1", kind: "command", title: "Running command", detail: "mach test\nTest output" },
  ];
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.equal(await modal.locator(".patch-update-activity-note").count(), 1);
  assert.equal(await modal.locator(".patch-update-activity-command-row").count(), 0);
  await modal.getByRole("button", { name: "All", exact: true }).click();
  const command = modal.locator(".patch-update-activity-command-disclosure");
  await command.locator("summary").click();
  assert.equal(await command.getAttribute("open"), "");
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.equal(await command.getAttribute("open"), "");
  assert.equal(await modal.locator(".patch-update-steer-label").textContent(), "Guide Codex");
  runs[0].reports = [{ role: "implement", report: { complete: true, summary: "Implemented **calendar selection**.",
    tests: [{ command: "mach test calendar", status: "passed", evidence: "Verified `calendarId` with **197 assertions**." }],
    acceptanceCriteria: [{ criterion: "Use the **selected calendar**", status: "passed", evidence: "See [test evidence](https://example.org/test)." }],
    testHistory: [{ command: "mach test calendar", status: "failed", evidence: "Earlier fixture failure", resolution: "Fixed in the final run." }],
  } }];
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  const reports = modal.locator(".implement-reports");
  assert.equal(await reports.getAttribute("open"), null);
  assert.equal(await reports.getByText("Earlier fixture failure", { exact: true }).isVisible(), false);
  assert.equal(await modal.locator('[data-implement="reports"]').evaluate(node =>
    Boolean(node.previousElementSibling.matches(".patch-update-activity"))), true);
  await reports.locator(":scope > summary").click();
  await reports.locator("details > summary").click();
  assert.equal(await reports.locator("strong").filter({ hasText: "197 assertions" }).isVisible(), true);
  assert.equal(await reports.locator("code").filter({ hasText: "calendarId" }).isVisible(), true);
  assert.equal(await reports.getByRole("link", { name: "test evidence" }).isVisible(), true);
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.equal(await reports.getAttribute("open"), "");
  runs[0].reports.push({ role: "verify", report: { complete: true, summary: "Verified." } });
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.equal(await reports.getAttribute("open"), "");
  assert.equal(await reports.locator("details").nth(0).getAttribute("open"), null);
  assert.equal(await reports.locator("details").nth(1).getAttribute("open"), "");
  await reports.locator(":scope > summary").click();
  await page.screenshot({ path: "/tmp/implement-compact-reports.png", fullPage: true });
  runs[0].tryStatus = "analyzing";
  runs[0].tryResultStatus = "failed";
  runs[0].tryFailedJobCount = 10;
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.match(await modal.locator('[data-implement="meta"]').textContent(), /Try complete — 10 failed jobs; Evaluating failures/);
  assert.doesNotMatch(await modal.locator('[data-implement="meta"]').textContent(), /Pending/);
  runs[0].error = "Implementation needs attention: Implemented and tested. Product/design confirmation remains open.";
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.match(await modal.locator(".codex-run-status").textContent(), /Paused/);
  assert.doesNotMatch(await modal.locator(".codex-run-status").textContent(), /Failed/);
  assert.match(await modal.locator('[data-implement="error"]').textContent(), /Select Resume/);
  runs[0].error = "The agent has not confirmed all applicable tests.";
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.match(await modal.locator('[data-implement="error"]').textContent(), /not a decision from you/);
  assert.match(await modal.locator('[data-implement="error"]').textContent(), /automatically/);
  runs[0].error = "Which label should I use? Reply in Guide Codex to continue.";
  runs[0].errorKind = "input-required";
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.equal(await modal.locator(".codex-run-status").textContent(), "Waiting for your answer");
  assert.equal(await modal.locator('[data-implement="feedback"]').isVisible(), true);
  runs[0].errorKind = "paused";
  runs[0].error = "A required build is unavailable.";
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  await modal.locator('[data-action="retry"]').waitFor();
  assert.match(await modal.locator('[data-implement="error"]').textContent(), /required build/);
  assert.equal(await page.locator(".dashboard-implement-runs, .implementation-run").count(), 0);
  const cancel = modal.getByRole("button", { name: "Cancel implementation", exact: true });
  assert.equal(await cancel.isVisible(), true);
  assert.equal(await cancel.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= globalThis.innerHeight;
  }), true);
  await modal.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.waitForFunction(() => !globalThis.document.querySelector("#implement-dialog").open);
  assert.equal(runs[0].phase, "cancelled");
  assert.equal(await page.locator('.ai-task-toast[data-task-key="implement:impl-1"]').count(), 0);
  await page.evaluate(async () => (await import("/assets/graph-client/implement.js")).refreshImplementations());
  assert.equal(await page.locator('.ai-task-toast[data-task-key="implement:impl-1"]').count(), 0);
  await page.screenshot({ path: "/tmp/implement-dialog.png", fullPage: true });
});
