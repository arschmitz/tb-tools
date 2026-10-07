import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("dashboard shows approved patches with reviews left and own patches in the middle", async t => {
  const server = await startInteractiveGraphServer({
    graphs: [], token: "secret", tryMonitor: null,
    html: buildGraphHtml({ graphs: [], interactive: { enabled: true, token: "secret" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.server.closeAllConnections();
    await new Promise(resolve => server.server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  let hasApprovedPatch = true;
  let extraPatches = [];
  await page.route("**/api/dashboard?*", route => route.fulfill({ json: {
    ok: true, user: { name: "Me" }, ownNeedsReview: [{
      id: "D124", title: "Waiting patch", statusName: "Needs Review",
    }], ownApproved: hasApprovedPatch ? [{
      id: "D123", title: "Approved patch awaiting merge", statusName: "Accepted",
      url: "https://phabricator.services.mozilla.com/D123", bugId: "123456",
    }, ...extraPatches] : [],
  } }));
  await page.goto(server.url);
  await page.evaluate(async () => {
    const { showDashboard, loadDashboard } = await import("/assets/graph-client/dashboard.js");
    showDashboard();
    await loadDashboard();
  });
  const approved = page.locator('[data-dashboard-section="own-approved"]');
  await approved.getByText("Approved patch awaiting merge", { exact: true }).waitFor();
  assert.equal(await approved.locator(".dashboard-count").innerText(), "1");
  assert.equal(await approved.locator(".dashboard-patch-title").getAttribute("href"), "https://phabricator.services.mozilla.com/D123");
  assert.deepEqual(await page.locator(".dashboard-column-heading").allTextContents(), ["Needs Review", "Your Patches", "Bugzilla"]);
  const columns = await page.locator(".dashboard-column, .dashboard-bug-sidebar").evaluateAll(nodes =>
    nodes.map(node => node.getBoundingClientRect().x));
  assert.ok(columns[0] < columns[1] && columns[1] < columns[2]);
  const sections = await page.locator(".dashboard-own-patches > details").evaluateAll(nodes =>
    nodes.map(node => { const rect = node.getBoundingClientRect(); return { y: rect.y, height: rect.height }; }));
  assert.equal(sections.length, 3);
  assert.ok(sections[0].height < 100 && sections[1].height > 100);
  assert.ok(sections[2].height > 100);
  assert.ok(sections[2].y >= sections[1].y + sections[1].height);
  const emptySections = page.locator(".dashboard-section.is-empty");
  assert.equal(await emptySections.count(), 7);
  for (const section of await emptySections.all()) {
    assert.equal(await section.locator(".dashboard-rows").isVisible(), false);
    assert.equal(await section.locator(".dashboard-count").innerText(), "0");
  }
  const waiting = page.locator('[data-dashboard-section="own-needs-review"]');
  const beforeCollapse = (await approved.boundingBox()).height;
  await waiting.locator(":scope > summary").click();
  await page.waitForFunction(() => !globalThis.document.querySelector('[data-dashboard-section="own-needs-review"]').open &&
    globalThis.document.querySelector(".dashboard-own-patches").style.getPropertyValue("--dashboard-section-rows") === "auto auto minmax(0, 1fr)");
  assert.ok((await approved.boundingBox()).height > beforeCollapse);
  assert.equal(await waiting.locator(".dashboard-rows").isVisible(), false);
  await page.evaluate(async () => (await import("/assets/graph-client/dashboard.js")).loadDashboard({ force: true }));
  assert.equal(await waiting.getAttribute("open"), null, "refresh preserves a manual collapse");
  await waiting.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await waiting.getByText("Waiting patch", { exact: true }).waitFor();
  assert.equal(await waiting.locator(".dashboard-rows").isVisible(), true);
  hasApprovedPatch = false;
  await page.evaluate(async () => (await import("/assets/graph-client/dashboard.js")).loadDashboard({ force: true }));
  assert.equal(await approved.locator(".dashboard-rows").isVisible(), false);
  assert.ok((await approved.boundingBox()).height < 100);
  hasApprovedPatch = true;
  await page.evaluate(async () => (await import("/assets/graph-client/dashboard.js")).loadDashboard({ force: true }));
  await approved.getByText("Approved patch awaiting merge", { exact: true }).waitFor();
  assert.equal(await approved.locator(".dashboard-rows").isVisible(), true);
  await page.screenshot({ path: "/tmp/dashboard-approved.png", fullPage: true });
  extraPatches = Array.from({ length: 20 }, (_, index) => ({ id: `D${200 + index}`, title: `Extra patch ${index}` }));
  await page.evaluate(async () => (await import("/assets/graph-client/dashboard.js")).loadDashboard({ force: true }));
  const rows = approved.locator(".dashboard-rows");
  assert.ok(await rows.evaluate(node => node.scrollHeight > node.clientHeight), "long queues scroll inside the section");
  await rows.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const lastRow = await approved.getByText("Extra patch 19", { exact: true }).boundingBox();
  const rowBox = await rows.boundingBox();
  assert.ok(lastRow.y >= rowBox.y && lastRow.y + lastRow.height <= rowBox.y + rowBox.height);
  await page.setViewportSize({ width: 390, height: 844 });
  await approved.locator(":scope > summary").click();
  assert.ok((await approved.boundingBox()).height < 100, "collapsed mobile sections have no minimum body height");
  await approved.locator(":scope > summary").press("Space");
  await approved.getByText("Approved patch awaiting merge", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/dashboard-collapsible-mobile.png", fullPage: true });
});
