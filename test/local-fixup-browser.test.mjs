import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("ordinary fixups expose Amend without a Try monitor", async t => {
  const hash = "b".repeat(40);
  const graphs = [{ label: "comm", repository: "comm", path: "/test/comm", branch: "Bug-123",
    commits: [{ hash, parents: ["a".repeat(40)], refs: ["HEAD", "Bug-123"],
      author: { name: "Test", email: "test@example.invalid" }, subject: "fixup! Feature" }], diffs: {} }];
  const info = await startInteractiveGraphServer({ graphs, token: "secret", tryMonitor: null,
    html: buildGraphHtml({ graphs, interactive: { enabled: true, token: "secret" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/api/graph/**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ ok: true, message: "fixup! Feature", diff: "diff" }) }));
  let requestBody;
  await page.route("**/api/amend-try-fixup", route => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true,
      message: "Amended the patch with its fixup.", snapshot: { ...graphs[0], commits: [] } }) });
  });
  await page.goto(info.url);
  await page.evaluate(async () => {
    const { graphStates } = await import("/assets/graph-client/config.js");
    const { showDiff } = await import("/assets/graph-client/commit-actions.js");
    graphStates[0].commits = graphStates[0].graph.commits;
    await showDiff(graphStates[0].graph, 0, graphStates[0].commits[0]);
  });
  const amend = page.locator("#diff-0 .amend-commit");
  assert.equal(await amend.textContent(), "Amend", "An ordinary fixup should expose Amend");
  await page.evaluate(async () => {
    const { openAmendDialog } = await import("/assets/graph-client/commit-actions.js");
    await openAmendDialog(globalThis.document.querySelector("#diff-0 .amend-commit"));
  });
  assert.equal(requestBody.hash, hash, "Amend should send the selected fixup hash");
  assert.equal(requestBody.token, "secret", "Amend should use the interactive token");
  assert.equal(await page.locator("#amend-dialog[open]").count(), 0,
    "Fixup Amend should bypass message editing");
});
