import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("dashboard bugs open the shared dialog without a board and have separate Bugzilla icons", async t => {
  let summary = "Keyboard navigation";
  const writes = [];
  const server = await startInteractiveGraphServer({ graphs: [], token: "secret", tryMonitor: null,
    html: buildGraphHtml({ graphs: [], interactive: { enabled: true, token: "secret" }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
    getMetaBoardBugDetail: async ({ bugId }) => ({ id: bugId, summary, description: "Bug description", comments: [], dependsOn: [], blocks: [], url: `https://bugzilla.mozilla.org/show_bug.cgi?id=${bugId}` }),
    updateMetaBoardBug: async ({ bugId, changes }) => { writes.push({ bugId, changes }); summary = changes.summary; },
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  assert.equal((await fetch(new URL("/api/bugs/123?token=wrong", server.url))).status, 403);
  assert.equal((await fetch(new URL("/api/bugs/123", server.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong", changes: { summary: "Denied" } }) })).status, 403);
  const page = await browser.newPage();
  const bug = { id: "123", summary, status: "NEW", hasPatch: false };
  await page.route("**/api/dashboard?*", route => route.fulfill({ json: { ok: true, assignedBugs: [bug], inProgressBugs: [bug], needinfoBugs: [bug], ownNeedsReview: [{ id: "D123", title: "Patch", bugId: "123", url: "https://phabricator.services.mozilla.com/D123" }] } }));
  await page.goto(server.url);
  await page.evaluate(async () => (await import("/assets/graph-client/dashboard.js")).showDashboard());
  const titles = page.locator(".dashboard-bug-title");
  await titles.first().waitFor();
  assert.equal(await titles.count(), 4);
  for (const button of await titles.all()) {
    await button.focus(); await button.press("Enter");
    await page.locator("#meta-board-dialog[open]").waitFor();
    await page.waitForFunction(value => globalThis.document.querySelector(".meta-board-detail-summary").value === value, summary);
    assert.equal(await page.locator(".meta-board-detail-summary").inputValue(), summary);
    await page.locator(".meta-board-detail-close").click();
  }
  const icons = page.locator(".dashboard-panel .meta-board-bugzilla-icon");
  assert.equal(await icons.count(), 4);
  assert.equal(await icons.first().getAttribute("href"), "https://bugzilla.mozilla.org/show_bug.cgi?id=123");
  assert.equal(await icons.first().getAttribute("target"), "_blank");
  assert.equal(await icons.first().getAttribute("aria-label"), "Open Bug 123 in Bugzilla");
  assert.equal(await icons.first().evaluate(node => globalThis.getComputedStyle(node).borderRadius), "50%");
  await titles.first().click();
  await page.waitForFunction(() => !globalThis.document.querySelector(".meta-board-detail-save").disabled);
  await page.locator(".meta-board-detail-summary").fill("Updated summary");
  await Promise.all([page.waitForResponse(response => response.url().includes("/api/bugs/123") && response.request().method() === "PUT"), page.locator(".meta-board-detail-save").click()]);
  assert.deepEqual(writes, [{ bugId: "123", changes: { summary: "Updated summary" } }]);
});
