import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

for (const aiEnabled of [false, true]) {
  test(`dashboard action menus respect AI enabled=${aiEnabled}`, async t => {
    const server = await startInteractiveGraphServer({ graphs: [], token: "secret", tryMonitor: null,
      html: buildGraphHtml({ graphs: [], interactive: { enabled: true, aiEnabled, token: "secret" },
        scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close(); server.server.closeAllConnections();
      await new Promise(resolve => server.server.close(resolve));
    });
    const page = await browser.newPage();
    const patch = { id: "D123", title: "My patch", statusName: "Accepted", url: "https://phabricator.services.mozilla.com/D123" };
    await page.route("**/api/dashboard?*", route => route.fulfill({ json: { ok: true,
      ownApproved: [patch], ownNeedsReview: [patch], ownNeedsRevision: [patch], directlyAssignedWaitingOnReview: [patch] } }));
    const calls = [];
    await page.route("**/api/dashboard/patch-action", route => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, status: "complete", message: "Done", output: "", graphIndex: 0 } });
    });
    await page.goto(server.url);
    await page.evaluate(async () => {
      const { showDashboard } = await import("/assets/graph-client/dashboard.js");
      showDashboard();
    });
    await page.locator('[data-dashboard-section="own-approved"] .dashboard-patch-actions summary').waitFor();
    const menus = page.locator(".dashboard-patch-actions");
    assert.equal(await menus.count(), 3);
    for (const menu of await menus.all()) {
      await menu.locator("summary").click();
      assert.deepEqual(await menu.locator("button").allTextContents(), ["Update", "Review Update", "Verify", "Rebase", "CI Verify"]);
      for (const action of ["freeform", "update", "verify"]) {
        assert.equal(await menu.locator(`[data-patch-action="${action}"]`).isDisabled(), !aiEnabled);
      }
      assert.equal(await menu.locator('[data-patch-action="rebase"]').isEnabled(), true);
      assert.equal(await menu.locator('[data-patch-action="ci-verify"]').isEnabled(), true);
      await menu.locator("summary").press("Escape");
      assert.equal(await menu.getAttribute("open"), null);
    }
    assert.equal(await page.locator(".dashboard-patch-review").isDisabled(), !aiEnabled);
    assert.equal(await page.locator(".review-handled-toggle").isEnabled(), true);
    const approved = menus.last();
    for (const action of ["rebase", "ci-verify"]) {
      await approved.locator("summary").click();
      await Promise.all([
        page.waitForResponse(response => response.url().includes("/api/dashboard/patch-action")),
        approved.locator(`[data-patch-action="${action}"]`).click(),
      ]);
      await page.locator(".dashboard-status").filter({ hasText: "Done" }).waitFor();
    }
    assert.deepEqual(calls.map(({ action, revision }) => ({ action, revision })), [
      { action: "rebase", revision: "D123" }, { action: "ci-verify", revision: "D123" },
    ]);
    await approved.locator("summary").click();
    await page.screenshot({ path: `/tmp/dashboard-actions-ai-${aiEnabled}.png`, fullPage: true });
  });
}
