import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("dashboard Review is AI gated and accepts revision numbers and patch links", async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const aiEnabled of [false, true]) {
    const server = await startInteractiveGraphServer({
      graphs: [], token: "secret",
      html: buildGraphHtml({ graphs: [], interactive: { enabled: true, aiEnabled, token: "secret" },
        scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
    });
    t.after(() => { server.server.closeAllConnections(); return new Promise(resolve => server.server.close(resolve)); });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const requests = [];
    await page.route("**/api/review", async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      await route.fulfill({ json: { ok: true, id: "test-review", revision: body.revision,
        aiEnabled: true, status: "review", message: "Review complete", issues: [], activity: [] } });
    });
    await page.route("**/api/review/test-review/cancel", route => route.fulfill({ json: {
      ok: true, id: "test-review", revision: requests.at(-1)?.revision,
      aiEnabled: true, status: "cancelled", issues: [], activity: [],
    } }));
    await page.goto(server.url);
    await page.evaluate(async () => {
      const { initializeDashboard } = await import("/assets/graph-client/dashboard.js");
      const { initializePatchReviewDialog } = await import("/assets/graph-client/patch-review-dialog.js");
      initializeDashboard();
      initializePatchReviewDialog();
      globalThis.document.querySelector(".dashboard-panel").hidden = false;
    });
    assert.equal(await page.locator(".dashboard-review").count(), aiEnabled ? 1 : 0);
    if (!aiEnabled) { await page.close(); continue; }
    assert.equal(await page.locator(".dashboard-refresh + .dashboard-review").count(), 1);
    await page.locator(".dashboard-review").click();
    const input = page.getByLabel("Patch link or D number");
    assert.equal(await input.evaluate(node => node === globalThis.document.activeElement), true);
    await input.fill("not a patch");
    await page.locator('.dashboard-review-form button[type="submit"]').click();
    assert.match(await page.locator("#dashboard-review-error").textContent(), /Enter a patch link/);
    assert.equal(requests.length, 0);
    await page.locator(".dashboard-review-cancel").click();
    assert.equal(await page.locator(".dashboard-review-dialog").isVisible(), false);
    for (const value of ["D123456", " https://phabricator.services.mozilla.com/D234567?id=999#inline-1 ", "d345678"]) {
      await page.locator(".dashboard-review").click();
      await input.fill(value);
      await input.press("Enter");
      await page.locator(".patch-review-status").filter({ hasText: "Review complete" }).waitFor();
      assert.equal(await page.locator(".dashboard-review-dialog").isVisible(), false);
      assert.equal(await page.locator("#patch-review-dialog").isVisible(), true);
      await page.locator(".patch-review-close").click();
    }
    assert.deepEqual(requests.map(body => body.revision), ["D123456", "D234567", "D345678"]);
    assert.ok(requests.every(body => body.token === "secret"));
    await page.locator(".dashboard-review").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".dashboard-review-dialog").isVisible(), false);
    await page.close();
  }
});
