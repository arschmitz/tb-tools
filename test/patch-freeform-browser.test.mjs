import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
import { serializeGraphPatchUpdateSession } from "../commands/graph/patch-update.mjs";

test("Update shows a conversation, patch and candidate diffs, amend, submit, and rollback", async t => {
  const hash = "abc123def456";
  const subject = "Bug 123456 - Update this patch D123456";
  const graph = { path: "/repo/comm", label: "comm", repository: "comm", checkout: "working",
    branch: "feature", diffs: {}, commitCount: 1,
    commits: [{ hash, parents: [], refs: ["HEAD", "feature"], subject,
      author: { name: "Author", email: "author@example.com", timestamp: 1 } }] };
  const patchDiff = "diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-old();\n+current();\n";
  const candidateDiff = patchDiff.replace("+current();", "+updated();");
  let session;
  let prompts = 0;
  let amendments = 0;
  const html = buildGraphHtml({ graphs: [graph], interactive: { aiEnabled: true, enabled: true, token: "test" },
    scriptSrcs: ["/assets/graph-client/init.js"], stylesheetHref: "/assets/graph-client/style.css" });
  const info = await startInteractiveGraphServer({ graphs: [graph], html, token: "test", appConfig: { ai: { enabled: true } },
    preparePatchUpdateSession: async options => {
      session = options.session;
      Object.assign(session, { currentHash: hash, rollbackHash: hash, status: "review", chat: [], items: [] });
    },
    acceptPatchUpdateChange: async () => {
      amendments++;
      Object.assign(session.items.at(-1), { state: "handled", changeApplied: false, changesAmended: true });
      session.currentItemIndex = session.items.length;
      session.currentHash = "def456abc123";
      session.workingTreeDiffVersion++;
    },
    runCommand: async ({ args }) => {
      if (args[0] === "log") return args.includes("-1") ? subject :
        [hash, "", "HEAD -> feature", "Author", "author@example.com", "1", subject].join("\u001f") + "\u001e";
      if (args[0] === "show") return patchDiff;
      if (args[0] === "diff") return candidateDiff;
      if (args[0] === "rev-parse") return session?.currentHash || hash;
      if (args[0] === "branch") return "feature";
      return "";
    },
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => info.server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.route("**/api/patch-update/*/steer", async route => {
    prompts++;
    const { instruction } = route.request().postDataJSON();
    session.chat.push({ role: "user", text: instruction }, { role: "assistant", text: `Answer ${prompts}` });
    const item = session.items[0] ||= { id: "change", type: "follow-up", content: instruction, assessment: instruction };
    Object.assign(item, { state: "ready", changeApplied: true, changesAmended: false, appliedSummary: "Updated the source." });
    session.currentItemIndex = 0;
    session.workingTreeDiffVersion++;
    await route.fulfill({ json: { ok: true, ...serializeGraphPatchUpdateSession(session) } });
  });
  await page.route("**/api/patch-update/*/rollback", async route => {
    session.items = [];
    session.currentHash = session.rollbackHash;
    session.chat.push({ role: "assistant", text: "Rolled back this Update." });
    await route.fulfill({ json: { ok: true, ...serializeGraphPatchUpdateSession(session) } });
  });
  await page.goto(info.url);
  await page.evaluate(async () => {
    const { showDiff } = await import("/assets/graph-client/commit-actions.js");
    const { graphStates, GRAPHS } = await import("/assets/graph-client/config.js");
    await showDiff(GRAPHS[0], 0, graphStates[0].commits[0], { loadCurrentIntegration: false });
  });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.locator(".patch-update-title", { hasText: "D123456 Update" }).waitFor();
  assert.equal(session.mode, "freeform");
  const dialog = page.locator(".patch-update-dialog");
  const prompt = dialog.locator(".patch-update-steer-input");
  const submit = dialog.getByRole("button", { name: "Submit Patch", exact: true });
  const rollback = dialog.getByRole("button", { name: "Roll Back", exact: true });
  await dialog.locator(".patch-update-context-diff-content", { hasText: "current();" }).waitFor();
  assert.equal(await submit.isVisible(), true);
  assert.equal(await rollback.isVisible(), true);
  assert.equal(await dialog.locator(".patch-update-results").isVisible(), false);
  await prompt.fill("Change this patch");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.locator(".patch-update-chat", { hasText: "Answer 1" }).waitFor();
  await dialog.locator(".patch-update-working-diff", { hasText: "updated();" }).waitFor();
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await rollback.isEnabled(), true);
  await prompt.fill("Also update the test");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.locator(".patch-update-chat", { hasText: "Answer 2" }).waitFor();
  assert.equal(prompts, 2);
  const layout = await page.evaluate(() => {
    const left = globalThis.document.querySelector(".patch-update-chat").getBoundingClientRect();
    const right = globalThis.document.querySelector(".patch-update-diff-column").getBoundingClientRect();
    return { left: left.right, right: right.left, height: left.height };
  });
  assert.ok(layout.left < layout.right && layout.height > 100, JSON.stringify(layout));
  await page.screenshot({ path: "/tmp/tb-freeform-update.png" });
  await submit.click();
  await page.getByRole("button", { name: "Amend and Continue", exact: true }).click();
  await page.locator("#system-dialog .system-dialog-title", { hasText: "Submit patch" }).waitFor();
  assert.equal(amendments, 1);
  await page.locator("#system-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await rollback.click();
  await page.locator("#system-dialog").getByRole("button", { name: "Roll Back", exact: true }).click();
  await dialog.locator(".patch-update-chat", { hasText: "Rolled back this Update." }).waitFor();
  assert.equal(await rollback.isEnabled(), false);
});
