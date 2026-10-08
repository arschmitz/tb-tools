import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { formatPrettyDiffHtml } from "../commands/graph/diff-renderer.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

const PATCH_DIFF = [
  "diff --git a/mail/prefix.mjs b/mail/prefix.mjs",
  "--- /dev/null",
  "+++ b/mail/prefix.mjs",
  "@@ -0,0 +1,160 @@",
  ...Array.from({ length: 160 }, (_, index) => `+const row${index} = true;`),
  "diff --git a/mail/example.mjs b/mail/example.mjs",
  "@@ -7 +15 @@",
  "-return previousItem;",
  "+return selectedItem;",
  "",
].join("\n");

const REVIEW_CHECKOUT_DIFF = [
  "diff --git a/mail/example.mjs b/mail/example.mjs",
  "@@ -15 +15 @@",
  "-return selectedItem;",
  "+return selectedItem ?? null;",
  "",
].join("\n");

test("Patch Review shows the saved error before a stale command message", async (t) => {
  const error = "Selected model is at capacity. Please try a different model.";
  const graphs = [{ checkout: "review", repository: "comm", path: "/repo/review/comm",
    label: "Review comm", commits: [], diffs: {} }];
  const serverInfo = await startInteractiveGraphServer({
    appConfig: { ai: { enabled: true } }, graphs, token: "secret",
    html: buildGraphHtml({
      graphs, interactive: { aiEnabled: true, enabled: true, pollIntervalMs: 20, token: "secret" },
      scriptSrcs: ["/assets/graph-client/init.js"],
      stylesheetHref: "/assets/graph-client/style.css",
    }),
    getRustUpstreamStatus: async () => ({ state: "current" }),
    preparePatchReviewSession: async ({ session }) => {
      session.status = "error";
      session.error = error;
      session.message = "Command completed";
    },
    runCommand: async () => "",
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => serverInfo.server.close(resolve));
  });
  const page = await browser.newPage();
  await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { openPatchReviewDialog } = await import("/assets/graph-client/patch-review-dialog.js");
    await openPatchReviewDialog({ patch: { id: "D123456" } });
  });
  await page.waitForFunction(expected =>
    globalThis.document.querySelector(".patch-review-status")?.textContent === expected, error);
  assert.equal(await page.locator(".patch-review-status").evaluate(
    element => element.classList.contains("error")), true);
});

test("Patch Review anchors actions and source changes in the patch diff", async (t) => {
  const inlineDrafts = [];
  const graphs = [{
    checkout: "review",
    commits: [],
    diffs: {},
    label: "Review comm",
    path: "/repo/review/comm",
    repository: "comm",
  }, {
    checkout: "review",
    commits: [],
    diffs: {},
    label: "Review firefox",
    path: "/repo/review/firefox",
    repository: "firefox",
  }];
  const html = buildGraphHtml({
    graphs,
    interactive: {
      aiEnabled: true,
      enabled: true,
      pollIntervalMs: 20,
      token: "secret",
    },
    scriptSrcs: ["/assets/graph-client/init.js"],
    stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    appConfig: { ai: { enabled: true } },
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs,
    html,
    preparePatchReviewSession: async ({ session }) => {
      session.currentHash = "abc123def456";
      session.rawPatchHash = "raw-patch-hash";
      session.rawPatchHtml = formatPrettyDiffHtml(PATCH_DIFF);
      session.reviewContextVersion = 1;
      session.issues = [{
        codeSuggestion: "return fallbackItem;",
        filePath: "mail/example.mjs",
        id: "unanchored-finding",
        isNewFile: true,
        lineLength: 1,
        lineNumber: 99,
        rationale: "The line is deliberately absent from the raw patch.",
        severity: "P3",
        state: "ready",
        suggestedComment: "Please use the fallback item.",
        title: "Show an unanchored finding",
        validation: "The UI must not hide a finding with no new-side anchor.",
      }, {
        codeSuggestion: "return selectedItem;",
        contextLineSide: "old",
        filePath: "mail/example.mjs",
        id: "example-finding",
        isNewFile: false,
        lineLength: 1,
        lineNumber: 15,
        rationale: "The method must return the selected item.",
        severity: "P2",
        state: "ready",
        suggestedComment: "Please return the selected item.",
        title: "Return the selected item",
        validation: "The focused unit test shows the missing return value.",
      }];
      session.activity = [{
        detail: "The finding is ready for action. This note must wrap inside the activity pane instead of extending past the sidebar.",
        id: "review-note",
        kind: "note",
        title: "Codex note",
      }, {
        detail: "The next review step has its own note. It must remain content-sized instead of stretching across the available activity height.",
        id: "review-note-second",
        kind: "note",
        title: "Codex note",
      }, {
        detail: "git diff --check",
        id: "review-command",
        kind: "command",
        title: "Running command",
      }];
      session.message = "Codex completed the review.";
      session.patchContext = {
        behaviorContract: "The selected item must remain available to the caller.",
        purpose: "Keep selection state available.",
      };
      session.status = "review";
    },
    runCommand: async (command) => (
      command.args[0] === "diff" ? REVIEW_CHECKOUT_DIFF : ""
    ),
    phabWebSession: {
      createInlineComment: async (params) => { inlineDrafts.push(params); return {}; },
      publishRevisionReview: async () => ({}),
    },
    token: "secret",
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { height: 900, width: 1400 } });

  page.setDefaultTimeout(5000);

  t.after(async () => {
    await browser.close();
    if (serverInfo.server.listening) {
      await new Promise((resolve) => serverInfo.server.close(resolve));
    }
  });

  await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { openPatchReviewDialog } = await import("/assets/graph-client/patch-review-dialog.js");

    await openPatchReviewDialog({ patch: { id: "D123456", bugId: "2071710" } });
  });

  await page.waitForFunction(() => {
    const actions = globalThis.document.querySelector(".patch-review-inline-actions");
    const pane = globalThis.document.querySelector(".patch-review-context-diff-content");
    if (!actions || !pane) return false;
    const box = actions.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
    return box.top >= bounds.top && box.bottom <= Math.min(bounds.bottom, globalThis.innerHeight);
  });

  assert.equal(await page.getByRole("link", { name: "Patch D123456", exact: true }).getAttribute("href"), "https://phabricator.services.mozilla.com/D123456");
  assert.equal(await page.getByRole("link", { name: "Bug 2071710", exact: true }).getAttribute("href"), "https://bugzilla.mozilla.org/show_bug.cgi?id=2071710");
  const context = page.locator(".patch-review-patch-context");
  const contextDetails = page.locator(".patch-review-patch-context-details");
  const coverage = page.locator(".patch-review-coverage");
  const activity = page.locator(".patch-review-activity");
  const activityFilter = page.locator(".patch-review-activity-filter");
  const diff = page.locator(".patch-review-context-diff-content");
  const unanchoredFinding = diff.locator(
    ".patch-review-unanchored-finding-container .patch-review-inline-finding",
  );
  const finding = diff.locator('.patch-review-inline-finding[data-issue-id="example-finding"]');

  const layout = await page.evaluate(() => {
    const getBox = (selector) => {
      const box = globalThis.document.querySelector(selector).getBoundingClientRect();

      return { bottom: box.bottom, left: box.left, top: box.top, width: box.width };
    };

    return {
      activity: getBox(".patch-review-activity"),
      activityList: getBox(".patch-review-activity-list"),
      diff: getBox(".patch-review-diff-column"),
      progress: getBox(".patch-review-progress"),
      sidebar: getBox(".patch-review-sidebar"),
      steer: getBox(".patch-review-steer"),
    };
  });

  assert.ok(layout.sidebar.left < layout.diff.left, "context column stays left of the patch diff");
  assert.ok(layout.diff.width > layout.sidebar.width, "patch diff receives the wider column");
  assert.ok(layout.activity.bottom <= layout.steer.top, "activity stays above the fixed guidance input");
  assert.ok(
    layout.activity.bottom - layout.activity.top > (layout.steer.bottom - layout.steer.top) * 2,
    "activity receives the sidebar space that is not used by the compact guidance input",
  );
  assert.ok(
    layout.activityList.bottom >= layout.activity.bottom - 16,
    `the activity list uses the full available panel height: ${JSON.stringify(layout)}`,
  );
  await activityFilter.getByRole("button", { name: "Notes" }).waitFor({ state: "visible" });
  await activityFilter.getByRole("button", { name: "All" }).waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-review-activity-status").count(), 0);
  assert.equal(await activity.locator(".patch-review-activity-note").count(), 2);
  await activityFilter.getByRole("button", { name: "All" }).click();
  assert.equal(await activity.locator(".patch-review-activity-command-row").count(), 1);
  await activityFilter.getByRole("button", { name: "Notes" }).click();
  const noteLayout = await activity.locator(".patch-review-activity-note code").first().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(noteLayout.scrollWidth <= noteLayout.clientWidth, "Codex notes wrap in the activity pane");
  const noteWidth = await activity.locator(".patch-review-activity-note").first().evaluate((element) => ({
    row: element.clientWidth, text: element.querySelector("code").clientWidth,
  }));
  assert.ok(noteWidth.text >= noteWidth.row - 30, JSON.stringify(noteWidth));
  assert.equal(await page.locator(".patch-review-dialog .codex-run-status").innerText(), "Waiting for your input");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/tmp/tb-patch-review-ui.png" });
  const noteRows = await activity.locator(".patch-review-activity-note").evaluateAll((entries) => (
    entries.map((entry) => entry.getBoundingClientRect().height)
  ));
  const activityListHeight = layout.activityList.bottom - layout.activityList.top;
  const activityListAlignment = await activity.locator(".patch-review-activity-list").evaluate((element) => (
    element.ownerDocument.defaultView.getComputedStyle(element).alignContent
  ));
  const activityListOverflow = await activity.locator(".patch-review-activity-list").evaluate((element) => (
    element.ownerDocument.defaultView.getComputedStyle(element).overflowY
  ));
  assert.equal(activityListAlignment, "start");
  assert.equal(activityListOverflow, "auto");
  assert.ok(
    Math.max(...noteRows) < activityListHeight * 0.6,
    `Codex note rows stay content-sized instead of filling the activity pane: ${JSON.stringify(noteRows)}`,
  );
  await diff.locator(".pretty-file").first().waitFor({ state: "visible" });
  assert.match(await diff.innerText(), /return selectedItem;/);
  await unanchoredFinding.waitFor({ state: "visible" });
  await diff.getByText("Review finding needs a new-side patch anchor").waitFor({ state: "visible" });
  await unanchoredFinding.getByRole("button", { name: "New-side Anchor Required" }).waitFor({ state: "visible" });
  assert.equal(
    await unanchoredFinding.getByRole("button", { name: "New-side Anchor Required" }).isDisabled(),
    true,
  );
  await unanchoredFinding.getByRole("button", { name: "Skip Finding" }).click();
  await finding.waitFor({ state: "visible" });
  assert.equal(
    await finding.evaluate((element) => element.closest(".patch-review-context-diff-content") !== null),
    true,
  );
  assert.equal(await page.locator(".patch-review-issue").count(), 0);
  await finding.getByRole("button", { name: "Apply in Review Checkout" }).waitFor({ state: "visible" });
  await finding.getByRole("button", { name: "Save Inline Comment Draft" }).waitFor({ state: "visible" });
  await finding.getByRole("button", { name: "Save Reply + Code Suggestion Draft" }).waitFor({ state: "visible" });
  await finding.locator(".patch-review-inline-suggested-diff").waitFor({ state: "visible" });
  assert.match(await finding.innerText(), /-return selectedItem;/);
  assert.match(await finding.innerText(), /\+return selectedItem;/);
  assert.equal(await finding.evaluate((element) => (
    element.closest("tr.review-inline-thread")?.previousElementSibling?.dataset.newLine
  )), "15");
  assert.equal(await finding.evaluate((element) => (
    element.closest("tr.review-inline-thread")?.previousElementSibling?.dataset.oldLine
  )), "");
  await diff.getByText("Review checkout validation changes").waitFor({ state: "visible" });
  await diff.getByText(/These are local experiments that Codex made only to inspect or validate the patch/).waitFor({ state: "visible" });
  await diff.getByText("return selectedItem ?? null;").waitFor({ state: "visible" });
  assert.equal(await coverage.evaluate((element) => element.open), false);
  await contextDetails.waitFor({ state: "hidden" });
  await context.getByRole("button", { name: "Patch context" }).click();
  await contextDetails.waitFor({ state: "visible" });
  await context.getByRole("button", { name: "Patch context" }).click();
  await contextDetails.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".patch-review-final").evaluate((element) => element.hidden), true);
  await finding.getByRole("button", { name: "Save Reply + Code Suggestion Draft" }).click();
  await page.locator(".patch-review-final").waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-review-final").evaluate((element) => element.open), false);
  await page.getByRole("button", { name: "Accept", exact: true }).waitFor({ state: "visible" });
  await diff.locator('.pretty-file[data-file-path="mail/example.mjs"]').getByRole("button", { name: "Add comment on line 15", exact: true }).click();
  const manual = diff.locator(".patch-review-manual-comment");
  await manual.getByLabel("Comment", { exact: true }).fill("Please handle the empty selection.");
  await manual.getByLabel("Code replacement (optional)").fill("return selectedItem ?? null;");
  await manual.getByRole("button", { name: "Save Additional Inline Draft" }).click();
  await manual.waitFor({ state: "detached" });
  await diff.getByText("Please handle the empty selection.", { exact: true }).waitFor();
  assert.equal(inlineDrafts.length, 2);
  assert.equal(inlineDrafts[1].lineNumber, 15);
  assert.equal(inlineDrafts[1].filePath, "mail/example.mjs");
  assert.equal(inlineDrafts[1].suggestionText, "return selectedItem ?? null;");
  const prefix = diff.locator('.pretty-file[data-file-path="mail/prefix.mjs"]');
  await prefix.getByRole("button", { name: "Add comment on line 10", exact: true }).click();
  await prefix.getByRole("button", { name: "Add comment on line 12", exact: true }).click({ modifiers: ["Shift"] });
  await manual.getByRole("heading", { name: "Add comment on lines 10–12" }).waitFor();
  await manual.getByLabel("Comment", { exact: true }).fill("Replace these three lines.");
  await manual.getByLabel("Code replacement (optional)").fill("const replacement = true;");
  await manual.getByRole("button", { name: "Save Additional Inline Draft" }).click();
  await manual.waitFor({ state: "detached" });
  assert.equal(inlineDrafts[2].lineNumber, 10);
  assert.equal(inlineDrafts[2].lineLength, 3);
  assert.deepEqual(inlineDrafts.slice(0, 1), [{
    content: "Please return the selected item.",
    commentText: "Please return the selected item.",
    hasSuggestion: true,
    suggestionText: "return selectedItem;",
    filePath: "mail/example.mjs",
    isNewFile: true,
    lineLength: 1,
    lineNumber: 15,
    revision: "D123456",
  }]);
});
