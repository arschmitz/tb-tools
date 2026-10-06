import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("final review actions update both queues only after publication succeeds", async t => {
  const patch = { id: "D123", title: "Review this patch", statusName: "Needs Review" };
  const graphs = [{ checkout: "review", repository: "comm", path: "/test/review/comm", commits: [], diffs: {} }];
  let failPublication = false;
  let needsReview = true;
  const published = [];
  const server = await startInteractiveGraphServer({ graphs, token: "secret", tryMonitor: null,
    appConfig: { ai: { enabled: true } },
    preparePatchReviewSession: async ({ session }) => { session.status = "review"; session.message = "Ready to submit"; },
    phabWebSession: { publishRevisionReview: async request => {
      if (failPublication) throw new Error("Publication failed");
      published.push(request.action);
      if (request.action !== "comment") needsReview = false;
    } },
    getDashboardData: async () => ({ directlyAssignedWaitingOnReview: needsReview ? [patch] : [], groupWaitingForFirstReview: needsReview ? [patch] : [] }),
    html: buildGraphHtml({ graphs, interactive: { enabled: true, aiEnabled: true, token: "secret" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  for (const outcome of ["accept", "request-changes", "comment", "failure"]) {
    await page.request.post(new URL("/api/dashboard/review-handled", server.url).href,
      { data: { token: "secret", revision: patch.id, handled: false } });
    failPublication = outcome === "failure";
    needsReview = true;
    await page.request.get(new URL("/api/dashboard?token=secret&force=1", server.url).href);
    await page.goto(server.url);
    await page.evaluate(async () => {
      const dashboard = await import("/assets/graph-client/dashboard.js");
      const review = await import("/assets/graph-client/patch-review-dialog.js");
      dashboard.initializeDashboard(); review.initializePatchReviewDialog(); dashboard.showDashboard();
    });
    const direct = page.locator('[data-dashboard-section="direct-review"]');
    await direct.getByRole("button", { name: "Review", exact: true }).click();
    await page.locator(".patch-review-final summary").click();
    await page.locator(".patch-review-final-message").fill("Reviewed.");
    const response = page.waitForResponse(r => r.url().endsWith("/submit"));
    await page.locator(`[data-review-outcome="${outcome === "failure" ? "accept" : outcome}"]`).click();
    const result = await (await response).json();
    const handled = ["accept", "request-changes"].includes(outcome);
    assert.equal(result.ok, outcome !== "failure");
    if (handled) {
      assert.equal(result.reviewStatusChange.revision, patch.id);
      await page.waitForFunction(() => !globalThis.document.querySelector('[data-dashboard-section="direct-review"] .dashboard-row'));
    }
    assert.equal(await direct.locator(".dashboard-row").count(), handled ? 0 : 1);
    assert.equal(await page.locator('[data-dashboard-section="group-first-review"] .dashboard-row').count(), handled ? 0 : 1);
    const refreshed = await (await page.request.get(new URL("/api/dashboard?token=secret&force=1", server.url).href)).json();
    assert.equal(refreshed.directlyAssignedWaitingOnReview.length, handled ? 0 : 1);
    assert.deepEqual(refreshed.handledReviews, []);
    if (handled) {
      needsReview = true;
      await page.locator(".dashboard-refresh").click();
      await direct.getByRole("button", { name: "Review", exact: true }).waitFor();
      assert.equal(await page.locator('[data-dashboard-section="group-first-review"] .dashboard-row').count(), 1);
    }
  }
  assert.deepEqual(published, ["accept", "reject", "comment"]);
});

test("mark handled removes both queues, shows a header checkmark, and can be undone", async t => {
  const patch = { id: "D123", title: "Review this patch", statusName: "Needs Review", url: "https://phabricator.services.mozilla.com/D123" };
  const server = await startInteractiveGraphServer({ graphs: [], token: "secret", tryMonitor: null,
    getDashboardData: async () => ({ directlyAssignedWaitingOnReview: [patch], groupWaitingForFirstReview: [patch] }),
    html: buildGraphHtml({ graphs: [], interactive: { enabled: true, aiEnabled: true, token: "secret" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.route("**/api/review", route => route.fulfill({ json: { ok: true, id: "review-test", revision: "D123",
    aiEnabled: true, status: "review", message: "Review complete", issues: [], activity: [] } }));
  await page.goto(server.url);
  await page.evaluate(async () => {
    const dashboard = await import("/assets/graph-client/dashboard.js");
    const review = await import("/assets/graph-client/patch-review-dialog.js");
    dashboard.initializeDashboard(); review.initializePatchReviewDialog(); dashboard.showDashboard();
  });
  const direct = page.locator('[data-dashboard-section="direct-review"]');
  const group = page.locator('[data-dashboard-section="group-first-review"]');
  const handled = page.locator('[data-dashboard-section="handled-reviews"]');
  await page.route("**/api/dashboard/review-handled", route => route.fulfill({ status: 500,
    json: { ok: false, error: "Could not save handled review." } }));
  await direct.getByRole("button", { name: "Mark handled: D123", exact: true }).click();
  await page.locator(".dashboard-status").filter({ hasText: "Could not save handled review." }).waitFor();
  assert.equal(await direct.locator(".dashboard-row").count(), 1);
  assert.equal(await group.locator(".dashboard-row").count(), 1);
  await page.unroute("**/api/dashboard/review-handled");
  await direct.getByRole("button", { name: "Mark handled: D123", exact: true }).click();
  await handled.locator(".dashboard-count").filter({ hasText: "1" }).waitFor();
  assert.equal(await direct.locator(".dashboard-row").count(), 0);
  assert.equal(await group.locator(".dashboard-row").count(), 0);
  await handled.locator("summary").click();
  assert.equal(await handled.locator(".review-handled-toggle").textContent(), "✓ Handled");
  await handled.getByRole("button", { name: "Review", exact: true }).click();
  const toggle = page.locator('#patch-review-dialog .review-handled-toggle');
  await page.locator(".patch-review-status").filter({ hasText: "Review complete" }).waitFor();
  await page.waitForFunction(() => globalThis.document.querySelector('#patch-review-dialog .review-handled-toggle')?.getAttribute("aria-pressed") === "true");
  assert.equal(await toggle.textContent(), "✓ Handled");
  await page.screenshot({ path: "/tmp/commands-handled-review-header.png", fullPage: true });
  await toggle.click();
  await page.waitForFunction(() => globalThis.document.querySelector('[data-dashboard-section="direct-review"] .dashboard-count')?.textContent === "1");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  assert.equal(await group.locator(".dashboard-row").count(), 1);
  assert.equal(await handled.locator(".dashboard-row").count(), 0);
});
