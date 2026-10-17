import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { formatPrettyDiffHtml } from "../commands/graph/diff-renderer.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("Review feedback saves without posting, preserves edited inputs, and rates skipped findings", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-review-feedback-"));
  const graphs = [{ checkout: "review", repository: "comm", path: "/repo/review/comm",
    label: "Review comm", commits: [], diffs: {} }];
  let posts = 0;
  const serverInfo = await startInteractiveGraphServer({
    graphs, token: "secret", appConfig: { ai: { enabled: true } }, patchSessionDirectory: directory,
    html: buildGraphHtml({ graphs, interactive: { aiEnabled: true, enabled: true, token: "secret" },
      scriptSrcs: ["/assets/graph-client/init.js"], stylesheetHref: "/assets/graph-client/style.css" }),
    getRustUpstreamStatus: async () => ({ state: "current" }), runCommand: async () => "",
    phabWebSession: { createInlineComment: async () => { posts++; } },
    preparePatchReviewSession: async ({ session }) => {
      session.currentHash = "a".repeat(40);
      session.rawPatchHash = "raw";
      session.rawPatchHtml = formatPrettyDiffHtml("diff --git a/mail/example.mjs b/mail/example.mjs\n@@ -1 +1 @@\n-old\n+new\n");
      session.reviewContextVersion = 1;
      session.issues = [{ id: "one", title: "Keep the selected item", filePath: "mail/example.mjs", lineNumber: 1,
        state: "ready", suggestedComment: "Original comment", codeSuggestion: "return fixed;" }];
      session.status = "review";
    },
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await new Promise(resolve => serverInfo.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { openPatchReviewDialog } = await import("/assets/graph-client/patch-review-dialog.js");
    await openPatchReviewDialog({ patch: { id: "D123" } });
  });
  const up = page.getByRole("button", { name: "👍 Useful finding" });
  await up.waitFor();
  await page.locator(".patch-review-inline-comment-input").fill("Unsaved edited comment");
  await page.locator(".patch-review-feedback-reason").fill("The focused test confirmed it.");
  await up.click();
  await page.waitForFunction(() => globalThis.document.querySelector('[data-review-inline-action="feedback-up"]')?.getAttribute("aria-pressed") === "true");
  assert.equal(await page.locator(".patch-review-inline-comment-input").inputValue(), "Unsaved edited comment");
  assert.equal(posts, 0);
  await page.getByRole("button", { name: "Skip Finding" }).click();
  await page.getByText("Rate earlier findings (1)").click();
  await page.getByRole("button", { name: "👎 Poor finding" }).click();
  await page.waitForFunction(() => globalThis.document.querySelector('[data-review-inline-action="feedback-down"]')?.getAttribute("aria-pressed") === "true");
  const saved = JSON.parse(await readFile(path.join(directory, (await readdir(directory))[0]), "utf8"));
  assert.equal(saved.data.issues[0].state, "skipped");
  assert.equal(saved.data.issues[0].feedback.rating, "down");
  assert.equal(saved.data.issues[0].originalSuggestion.comment, "Original comment");
  assert.equal(saved.data.findingFeedbackHistory.length, 2);
  assert.equal(posts, 0);
});
