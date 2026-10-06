import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

const hash = "abc123def456";
const subject = "Bug 123456 - Preserve focus D123456";
const diff = [
  "diff --git a/mail/prefix.mjs b/mail/prefix.mjs",
  "--- /dev/null",
  "+++ b/mail/prefix.mjs",
  "@@ -0,0 +1,160 @@",
  ...Array.from({ length: 160 }, (_, index) => `+const row${index} = true;`),
].join("\n") + "\n" + "diff --git a/mail/example.mjs b/mail/example.mjs\n--- a/mail/example.mjs\n+++ b/mail/example.mjs\n@@ -1 +1 @@\n-old();\n+close();\n";
const record = [hash, "", "HEAD -> Bug-123456", "Author", "author@example.com", "1", subject].join("\u001f") + "\u001e";

test("Verify buttons open findings one at a time without reply controls and end with Submit", async (t) => {
  let selectedMode;
  const graph = { path: "/repo/comm", label: "comm", repository: "comm", checkout: "working",
    branch: "Bug-123456", diffs: {}, commitCount: 1,
    commits: [{ hash, parents: [], refs: ["HEAD", "Bug-123456"], subject,
      author: { name: "Author", email: "author@example.com", timestamp: 1 } }] };
  const html = buildGraphHtml({ graphs: [graph], interactive: { aiEnabled: true, enabled: true, token: "test" },
    scriptSrcs: ["/assets/graph-client/init.js"], stylesheetHref: "/assets/graph-client/style.css" });
  const info = await startInteractiveGraphServer({ graphs: [graph], html, token: "test", appConfig: { ai: { enabled: true } },
    savePatchUpdateMemory: async () => {},
    persistPatchUpdateHandledComment: async () => assert.fail("Verify findings must stay local"),
    preparePatchUpdateSession: async ({ session }) => {
      selectedMode = session.mode;
      Object.assign(session, { currentHash: hash, status: "review", patchContext: {
        purpose: "Preserve focus", behaviorContract: "Focus returns to the trigger", validation: "Source inspected" },
      items: (session.revision === "D234567" ? [] : [1, 2]).map(number => ({ id: `finding-${number}`, type: "finding", author: "Verify",
        filePath: number === 1 ? "mail/example.mjs" : "mail/unchanged.mjs", lineNumber: 1,
        content: `Focus issue ${number}`, assessment: `Restore focus ${number}`, rationale: "Close loses focus",
        recommendation: "change", requiresChanges: true, changeSummary: "Restore focus", state: "ready" })) });
    },
    runCommand: async ({ args }) => {
      if (args[0] === "log") return args.includes("-1") ? subject : record;
      if (args[0] === "show") return diff;
      if (args[0] === "rev-parse") return hash;
      if (args[0] === "branch") return "Bug-123456\n";
      return "";
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(5000);
  t.after(async () => { await browser.close(); await new Promise(resolve => info.server.close(resolve)); });
  await page.goto(info.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { showDiff } = await import("/assets/graph-client/commit-actions.js");
    const { graphStates, GRAPHS } = await import("/assets/graph-client/config.js");
    await showDiff(GRAPHS[0], 0, graphStates[0].commits[0], { loadCurrentIntegration: false });
  });
  const verify = page.locator(".patch-verify-commit");
  await verify.waitFor({ state: "visible" });
  assert.equal(await verify.innerText(), "Verify");
  assert.equal(await page.locator(".patch-update-commit").innerText(), "Review Update");
  await verify.click();
  await page.locator('[data-item-id="finding-1"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const actions = globalThis.document.querySelector(".patch-update-inline-actions");
    const pane = globalThis.document.querySelector(".patch-update-context-diff-content");
    if (!actions || !pane) return false;
    const box = actions.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
    return box.top >= bounds.top && box.bottom <= Math.min(bounds.bottom, globalThis.innerHeight);
  });
  assert.equal(selectedMode, "verify");
  assert.equal(await page.locator(".patch-update-title").innerText(), "D123456 Verify");
  assert.equal(await page.locator('[data-item-id="finding-2"]').count(), 0);
  assert.equal(await page.locator(".patch-update-inline-reply-label:visible").count(), 0);
  assert.equal(await page.locator('[data-update-inline-action="comment"]:visible').count(), 0);
  assert.equal(await page.locator('[data-update-inline-action="apply"]').isVisible(), true);
  assert.equal(await page.locator(".patch-update-submit").isVisible(), false);
  await page.locator('[data-update-inline-action="handled"]').click();
  await page.locator('[data-item-id="finding-2"]').waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-update-inline-reply-label:visible").count(), 0);
  await page.locator('[data-update-inline-action="skip"]').click();
  await page.locator(".patch-update-submit").waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-update-submit").isEnabled(), true);
  assert.equal(await page.locator(".patch-update-results details").count(), 2);
  await page.locator(".patch-update-close").click();
  const patch = { id: "D234567", title: "Bug 234567 - No findings", statusName: "Needs Review",
    url: "https://phabricator.services.mozilla.com/D234567" };
  await page.route("**/api/dashboard?*", route => route.fulfill({ json: {
    ok: true, ownNeedsRevision: [patch], ownNeedsReview: [patch],
  } }));
  await page.evaluate(async () => {
    const { showDashboard, loadDashboard } = await import("/assets/graph-client/dashboard.js");
    showDashboard();
    await loadDashboard({ force: true });
  });
  await page.locator(".dashboard-patch-actions summary").first().click();
  assert.equal(await page.locator("[data-patch-action=verify]").count(), 2);
  assert.equal(await page.locator("[data-patch-action=freeform]").count(), 2);
  assert.equal(await page.locator("[data-patch-action=update]").count(), 2);
  await page.locator("[data-patch-action=verify]").first().click();
  await page.locator(".patch-update-submit").waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-update-title").innerText(), "D234567 Verify");
  assert.equal(await page.locator(".patch-update-submit").isEnabled(), true);
});
