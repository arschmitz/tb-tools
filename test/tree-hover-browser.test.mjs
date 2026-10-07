import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("Treeherder tooltips do not make the entire tree a hovered commit row", async t => {
  const author = { name: "Test", email: "test@example.com", timestamp: 1 };
  const graphs = [{ label: "comm", path: "/repo/comm", branch: "patch", diffs: {}, commitCount: 3,
    commits: ["a", "b", "c"].map((letter, index) => ({ hash: letter.repeat(40),
      parents: index < 2 ? [String.fromCharCode(letter.charCodeAt(0) + 1).repeat(40)] : [],
      refs: index === 0 ? ["HEAD", "patch"] : [], author, subject: `Patch ${letter}`,
      tryMonitor: { status: "waiting", error: "" } })) }];
  const server = await startInteractiveGraphServer({ graphs, token: "secret", tryMonitor: null,
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "secret" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.server.closeAllConnections();
    await new Promise(resolve => server.server.close(resolve));
  });
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.evaluate(async () => {
    const { graphStates } = await import("/assets/graph-client/config.js");
    const { renderLaneGraph, enhanceGraphRows } = await import("/assets/graph-client/lane-renderer.js");
    graphStates[0].commits = graphStates[0].graph.commits;
    renderLaneGraph(0, graphStates[0].commits);
    enhanceGraphRows(0);
    enhanceGraphRows(0);
  });
  assert.equal(await page.locator(".commit-row").count(), 3);
  assert.equal(await page.locator("div.commit-row, svg.commit-row").count(), 0);
  const rows = page.locator("g.commit-row");
  for (let index = 0; index < 3; index++) {
    await rows.nth(index).locator(".commit-row-hitbox").hover({ position: { x: 10, y: 10 } });
    assert.equal(await page.locator(".commit-row.hover").count(), 1);
    assert.equal(await page.locator(".commit-row.hover").getAttribute("data-hash"), ["a", "b", "c"][index].repeat(40));
  }
  await page.mouse.move(0, 0);
  assert.equal(await page.locator(".commit-row.hover").count(), 0);
});
