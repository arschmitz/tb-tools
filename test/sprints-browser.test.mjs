import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("sprint tabs show exactly one view at a time", async (t) => {
  const graph = {
    branch: "main",
    commitCount: 0,
    commits: [],
    diffs: {},
    label: "comm",
    path: "/repo/comm",
    repository: "comm",
  };
  const html = buildGraphHtml({
    graphs: [graph],
    interactive: {
      enabled: true,
      pollIntervalMs: 20,
      token: "secret",
    },
    scriptSrcs: ["/assets/graph-client/init.js"],
    stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs: [graph],
    html,
    token: "secret",
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { height: 900, width: 1400 } });

  await page.emulateMedia({ colorScheme: "dark" });

  t.after(async () => {
    await browser.close();
    if (serverInfo.server.listening) {
      await new Promise((resolve) => serverInfo.server.close(resolve));
    }
  });

  await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
  assert.equal(
    await page.locator("body > header").evaluate((header) => (
      globalThis.getComputedStyle(header).backgroundColor
    )),
    "rgb(25, 29, 35)",
  );
  await page.evaluate(() => {
    globalThis.document.querySelector(".sprint-panel").hidden = false;
  });

  const overview = page.locator(".sprint-overview");
  const planning = page.locator(".sprint-planning");
  const planningColumns = page.locator(".sprint-planning-columns .sprint-column");

  await overview.waitFor({ state: "visible" });
  await planning.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Planning", exact: true }).click();
  await planning.waitFor({ state: "visible" });
  await overview.waitFor({ state: "hidden" });
  assert.equal(await planning.evaluate((element) => element.hidden), false);
  assert.equal(await overview.evaluate((element) => element.hidden), true);
  assert.deepEqual(
    await planningColumns.evaluateAll((columns) => columns.map((column) => column.dataset.sprintColumn)),
    ["backlog", "ready", "assigned", "sprint"],
  );
  assert.equal(
    await planningColumns.first().locator(":scope > header").evaluate((header) => (
      globalThis.getComputedStyle(header).position
    )),
    "static",
  );

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await overview.waitFor({ state: "visible" });
  await planning.waitFor({ state: "hidden" });
  assert.equal(await overview.evaluate((element) => element.hidden), false);
  assert.equal(await planning.evaluate((element) => element.hidden), true);
});
