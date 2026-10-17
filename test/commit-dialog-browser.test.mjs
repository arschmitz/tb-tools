import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("Commit includes pending reviewers and preserves selected blocking reviewers", async t => {
  const graphs = [{ label: "comm", repository: "comm", path: "/test/comm", commits: [] }];
  const server = await startInteractiveGraphServer({ graphs, token: "test", tryMonitor: null,
    runCommand: async () => "",
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "test" },
      scriptSrcs: ["/assets/graph-client/init.js"], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  t.after(async () => {
    server.server.closeAllConnections();
    await new Promise(resolve => server.server.close(resolve));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/api/commit/metadata?*", route => route.fulfill({ json: {
    metadata: { branch: "Bug-123456", prefix: "Bug 123456", bugRequired: false },
  } }));
  const requests = [];
  await page.route("**/api/commit", route => {
    requests.push(route.request().postDataJSON().options);
    return route.fulfill({ status: 400, json: { error: "Test failure for retry" } });
  });
  await page.goto(server.url);
  await page.evaluate(async () => (await import("/assets/graph-client/commit-dialog.js")).openCommitDialog());
  await page.locator(".commit-summary").fill("Keep reviewers");
  const input = page.locator(".commit-reviewer-input");
  await input.fill("aleca!");
  await input.press("Enter");
  assert.equal(requests.length, 0);
  await input.fill(" r=ALECA, #mail-reviewers!, mkmelin ");
  await page.locator(".commit-submit").click();
  await page.waitForFunction(() => globalThis.document.querySelector(".commit-status").textContent === "Test failure for retry");
  const expected = [{ value: "aleca", blocking: true },
    { value: "#mail-reviewers", blocking: true }, { value: "mkmelin", blocking: false }];
  assert.deepEqual(requests[0].reviewers, expected);
  assert.equal(await input.inputValue(), "");
  await page.locator(".commit-submit").click();
  await page.waitForFunction(() => !globalThis.document.querySelector(".commit-submit").disabled);
  assert.deepEqual(requests[1].reviewers, expected);
});
