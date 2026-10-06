import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
import { serializeGraphPatchUpdateSession } from "../commands/graph/patch-update.mjs";

const PATCH_DIFF = [
  "diff --git a/mail/prefix.mjs b/mail/prefix.mjs",
  "--- /dev/null",
  "+++ b/mail/prefix.mjs",
  "@@ -0,0 +1,160 @@",
  ...Array.from({ length: 160 }, (_, index) => `+const row${index} = true;`),
  "diff --git a/mail/example.mjs b/mail/example.mjs",
  "index 111111111111..222222222222 100644",
  "--- a/mail/example.mjs",
  "+++ b/mail/example.mjs",
  "@@ -1 +1 @@",
  "-const previousValue = false;",
  "+const selectedItem = true;",
  "",
].join("\n");

const WORKING_TREE_DIFF = [
  "diff --git a/mail/example.mjs b/mail/example.mjs",
  "index 222222222222..333333333333 100644",
  "--- a/mail/example.mjs",
  "+++ b/mail/example.mjs",
  "@@ -1 +1 @@",
  "-const selectedItem = true;",
  "+const updatedValue = true;",
  "",
].join("\n");

const GIT_LOG_RECORD = [
  "abc123def456",
  "",
  "HEAD -> Bug-123456",
  "Author",
  "author@example.com",
  "1",
  "Bug 123456 - Update the example. r=reviewer D123456",
].join("\u001f") + "\u001e";

test("Patch Update anchors reviewer feedback and working-tree changes in one patch diff", async (t) => {
  let currentWorkingTreeDiff = WORKING_TREE_DIFF;
  let patchUpdateSession;
  const graph = {
    branch: "Bug-123456",
    commitCount: 1,
    commits: [{
      author: { email: "author@example.com", name: "Author", timestamp: 1 },
      hash: "abc123def456",
      parents: [],
      refs: ["HEAD", "Bug-123456"],
      subject: "Bug 123456 - Update the example. r=reviewer D123456",
    }],
    diffs: {},
    label: "comm",
    path: "/repo/comm",
    repository: "comm",
  };
  const html = buildGraphHtml({
    graphs: [graph],
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
    phabWebSession: { markInlineCommentDone: async () => {} },
    persistPatchUpdateHandledComment: async () => {},
    savePatchUpdateMemory: async () => {},
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs: [graph],
    html,
    preparePatchUpdateSession: async ({ session }) => {
      patchUpdateSession = session;
      session.activity = Array.from({ length: 30 }, (_, index) => [
        { id: `note-${index}`, kind: "note", title: "Codex note", detail: `Note ${index}: ${"This is a long note about the patch. ".repeat(12)} ${"long_path_".repeat(35)}` },
        { id: `command-${index}`, kind: "command", title: "Running command", detail: `git diff -- ${"long_path_".repeat(35)}` },
      ]).flat();
      session.currentHash = "abc123def456";
      session.patchContext = {
        behaviorContract: "A selected item keeps the focused state.",
        purpose: "Keep the selected state update correct.",
      };
      session.items = [{
        assessment: "Keep the selected state update and verify the focused interaction.",
        author: "Reviewer",
        changeAccepted: false,
        changeApplied: true,
        changeReverted: false,
        changeSummary: "Codex prepared the first source change.",
        codeSuggestion: "const selectedItem = true;",
        content: "Please explain the selected state update.",
        contextLineSide: "new",
        feedbackType: "Inline review feedback",
        filePath: "mail/example.mjs",
        id: "inline:example",
        lineNumber: 1,
        parentCommentPHID: "PHID-XCMT-example",
        recommendation: "change",
        requiresChanges: true,
        state: "ready",
        suggestedReply: "I made the requested change.",
        type: "inline",
      }, {
        assessment: "Keep the final source update after the follow-up review.",
        author: "Reviewer",
        changeAccepted: false,
        changeApplied: true,
        changeReverted: false,
        changeSummary: "Codex prepared the next source change.",
        codeSuggestion: "const selectedItem = true;",
        content: "Please check the final value.",
        contextLineSide: "new",
        feedbackType: "Inline review feedback",
        filePath: "mail/example.mjs",
        id: "inline:next-example",
        lineNumber: 1,
        recommendation: "change",
        requiresChanges: true,
        state: "pending",
        suggestedReply: "I made the follow-up change.",
        type: "inline",
      }];
      session.message = "Codex prepared a working-tree change. Review the actual uncommitted diff, then keep or revert it.";
      session.status = "review";
    },
    acceptPatchUpdateChange: async ({ session }) => {
      session.items[0].changeApplied = false;
      session.items[0].changeAccepted = false;
      session.items[0].changesAmended = true;
      session.workingTreeDiffVersion = (session.workingTreeDiffVersion || 0) + 1;
      session.message = "Source change was amended into the current commit. You can now post a reply, skip, or mark this comment done.";
    },
    runCommand: async ({ args = [] }) => {
      if (args[0] === "log") {
        return GIT_LOG_RECORD;
      }

      if (args[0] === "diff") {
        return currentWorkingTreeDiff;
      }

      if (args.includes("show")) {
        return PATCH_DIFF;
      }

      if (args.includes("branch")) {
        return "Bug-123456\n";
      }

      if (args.includes("rev-parse")) {
        return "abc123def456\n";
      }

      return "";
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
    const { openPatchUpdateDialog } = await import("/assets/graph-client/patch-update-dialog.js");

    await openPatchUpdateDialog({
      graphIndex: 0,
      patch: {
        id: "D123456",
        title: "Bug 123456 - Update the example.",
        url: "https://phabricator.services.mozilla.com/D123456",
      },
    });
  });

  const waitForCurrentActions = () => page.waitForFunction(() => {
    const actions = globalThis.document.querySelector(".patch-update-inline-actions");
    const pane = globalThis.document.querySelector(".patch-update-context-diff-content");
    if (!actions || !pane) return false;
    const box = actions.getBoundingClientRect();
    const bounds = pane.getBoundingClientRect();
    return box.top >= bounds.top && box.bottom <= Math.min(bounds.bottom, globalThis.innerHeight);
  });
  const context = page.locator(".patch-update-context");
  await page.locator(".patch-update-inline-finding .patch-update-comment-author").waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-update-inline-finding .patch-update-comment-author").innerText(), "Comment from Reviewer");
  const phabLink = page.locator(".patch-update-header .patch-update-phab-link");
  const bugLink = page.locator(".patch-update-header .patch-update-bug-link");
  assert.equal(await phabLink.isVisible(), true);
  assert.equal(await phabLink.getAttribute("href"), "https://phabricator.services.mozilla.com/D123456");
  assert.equal(await bugLink.isVisible(), true);
  assert.equal(await bugLink.getAttribute("href"), "https://bugzilla.mozilla.org/show_bug.cgi?id=123456");
  const contextDetails = page.locator(".patch-update-context-details");
  const diff = page.locator(".patch-update-context-diff-content");
  const finding = diff.locator(".patch-update-inline-finding");

  try {
    await finding.waitFor({ state: "visible" });
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const content = globalThis.document.querySelector(".patch-update-context-diff-content");

      return {
        content: content?.innerText,
        html: content?.innerHTML,
        status: globalThis.document.querySelector(".patch-update-status")?.textContent,
      };
    });

    throw new Error(
      `Patch Update did not render its inline finding: ${JSON.stringify({ diagnostic, patchUpdateSession })}`,
      { cause: error },
    );
  }
  assert.equal(await contextDetails.evaluate((element) => element.hidden), true);
  await context.locator(".patch-update-context-toggle").click();
  assert.equal(await contextDetails.evaluate((element) => element.hidden), false);
  await context.locator(".patch-update-context-toggle").click();
  assert.equal(await contextDetails.evaluate((element) => element.hidden), true);
  await waitForCurrentActions();
  assert.match(await finding.innerText(), /Codex source update/);
  assert.match(await finding.innerText(), /Keep the selected state update/);
  assert.match(await diff.innerText(), /Working tree changes/);
  assert.match(await diff.innerText(), /updatedValue = true/);
  assert.doesNotMatch(await diff.innerText(), /previousValue = false/);
  assert.equal(await finding.getByText("Amend Change").isVisible(), true);
  assert.equal(await finding.getByText("Revert Change").isVisible(), true);
  const diffHeight = await page.locator(".patch-update-working-diff-content").evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    panelBottom: element.closest(".patch-update-context-diff-content").getBoundingClientRect().bottom,
    height: element.clientHeight,
  }));
  assert.ok(diffHeight.height > 200, JSON.stringify(diffHeight));
  assert.ok(Math.abs(diffHeight.bottom - diffHeight.panelBottom) < 2, JSON.stringify(diffHeight));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/tmp/tb-patch-update-working-diff.png" });

  const activityList = page.locator(".patch-update-activity-list");
  const notes = page.locator('.patch-update-activity-filter [data-activity-filter="notes"]');
  const all = page.locator('.patch-update-activity-filter [data-activity-filter="all"]');
  assert.equal(await notes.getAttribute("aria-pressed"), "true");
  assert.equal(await activityList.locator(".patch-update-activity-note").count(), 30);
  assert.equal(await activityList.locator(".patch-update-activity-command-row").count(), 0);
  for (const width of [1400, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const document = globalThis.document;
      const list = document.querySelector(".patch-update-activity-list");
      const panel = document.querySelector(".patch-update-activity");
      const filter = document.querySelector(".patch-update-activity-filter");
      const sidebar = document.querySelector(".patch-update-sidebar");
      return { height: list.clientHeight, scrollHeight: list.scrollHeight, width: list.clientWidth, scrollWidth: list.scrollWidth,
        bottom: panel.getBoundingClientRect().bottom, steerTop: document.querySelector(".patch-update-steer").getBoundingClientRect().top,
        filterRight: filter.getBoundingClientRect().right, sidebarRight: sidebar.getBoundingClientRect().right };
    });
    assert.ok(metrics.height > 100 && metrics.scrollHeight > metrics.height, JSON.stringify(metrics));
    assert.ok(metrics.scrollWidth <= metrics.width + 1, JSON.stringify(metrics));
    assert.ok(metrics.filterRight <= metrics.sidebarRight, JSON.stringify(metrics));
    assert.ok(metrics.bottom <= metrics.steerTop, JSON.stringify(metrics));
    const noteWidth = await activityList.locator(".patch-update-activity-note").first().evaluate((element) => ({
      row: element.clientWidth, text: element.querySelector("code").clientWidth,
    }));
    assert.ok(noteWidth.text >= noteWidth.row - 30, JSON.stringify(noteWidth));
    await all.click();
    assert.equal(await activityList.locator(".patch-update-activity-command-row").count(), 30);
    await notes.click();
    assert.equal(await activityList.locator(".patch-update-activity-command-row").count(), 0);
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  await activityList.evaluate((element) => { element.style.scrollBehavior = "auto"; element.scrollTop = 100; });
  const scrolledTop = await activityList.evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(scrolledTop - 100) <= 1, `Activity scrolled to ${scrolledTop}, expected 100`);

  const layout = await page.evaluate(() => {
    const getBox = (selector) => {
      const box = globalThis.document.querySelector(selector).getBoundingClientRect();

      return { bottom: box.bottom, left: box.left, top: box.top, width: box.width };
    };

    return {
      activity: getBox(".patch-update-activity"),
      activityList: getBox(".patch-update-activity-list"),
      diff: getBox(".patch-update-diff-column"),
      sidebar: getBox(".patch-update-sidebar"),
      steer: getBox(".patch-update-steer"),
    };
  });

  assert.ok(layout.sidebar.left < layout.diff.left, "the context sidebar remains left of the patch diff");
  assert.ok(
    layout.diff.width > layout.sidebar.width,
    `the patch diff receives the wider column: ${JSON.stringify(layout)}`,
  );
  assert.ok(layout.activity.bottom <= layout.steer.top, "activity stays above the fixed guidance input");
  assert.ok(
    layout.activityList.bottom >= layout.activity.bottom - 16,
    `the activity list uses the available sidebar height: ${JSON.stringify(layout)}`,
  );

  await finding.getByText("Amend Change").click();
  const restoredFinding = diff.locator('[data-item-id="inline:example"]');

  await restoredFinding.getByRole("button", { name: "Comment", exact: true }).waitFor({ state: "visible" });
  await restoredFinding.waitFor({ state: "visible" });
  await waitForCurrentActions();
  assert.match(await restoredFinding.innerText(), /Codex analysis/);
  assert.equal(await restoredFinding.getByRole("button", { name: "Comment", exact: true }).isVisible(), true);
  assert.equal(await restoredFinding.getByText("Mark Done").isVisible(), true);
  assert.equal(patchUpdateSession.items[0].state, "ready");
  assert.equal(await restoredFinding.getByRole("button", { name: "Skip", exact: true }).isVisible(), true);
  assert.equal(await restoredFinding.locator(".patch-update-comment-author").isVisible(), true);
  const beforeAssessment = serializeGraphPatchUpdateSession(patchUpdateSession);
  await page.route("**/api/patch-update/*/feedback", (route) => route.fulfill({
    json: { ok: true, ...beforeAssessment, status: "reviewing" },
  }));
  await page.locator(".patch-update-steer-input").fill("Explain the proposed change.");
  await page.locator(".patch-update-steer-submit").click();
  Object.assign(patchUpdateSession.items[0], {
    changesAmended: false,
    assessment: "The new assessment arrived after the diff.",
    rationale: "The focused test shows why the source must change.",
    changeSummary: "Move the state update before the event is sent.",
  });
  await restoredFinding.getByText("The new assessment arrived after the diff.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await restoredFinding.getByText("Reason: The focused test shows why the source must change.", { exact: true }).isVisible(), true);
  assert.equal(await restoredFinding.getByText("Move the state update before the event is sent.", { exact: true }).isVisible(), true);
  assert.equal(await restoredFinding.getByRole("button", { name: "Make Change", exact: true }).isVisible(), true);
  assert.equal(await page.locator(".patch-update-dialog .codex-run-status").innerText(), "Waiting for your input");
  await page.screenshot({ path: "/tmp/tb-patch-update-ui.png" });
  const savedSessionId = patchUpdateSession.id;
  Object.assign(patchUpdateSession.items[0], { changesAmended: true, changeApplied: true, state: "applying" });
  await page.locator(".patch-update-close").click();
  await page.evaluate(() => {
    void import("/assets/graph-client/patch-update-dialog.js").then(({ openPatchUpdateDialog }) =>
      openPatchUpdateDialog({ graphIndex: 0, patch: { id: "D123456", title: "Bug 123456 - Update the example." } }));
  });
  await page.getByRole("button", { name: "Resume saved session", exact: true }).click();
  await page.getByText("The new assessment arrived after the diff.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(patchUpdateSession.id, savedSessionId);
  assert.equal(await page.locator(".patch-update-working-tree-candidate").count(), 0);
  assert.equal(await page.locator(".patch-update-working-diff").count(), 0);
  assert.equal(await restoredFinding.getByRole("button", { name: "Comment", exact: true }).isEnabled(), true);
  assert.equal(await restoredFinding.getByRole("button", { name: "Skip", exact: true }).isEnabled(), true);
  assert.equal(await restoredFinding.getByRole("button", { name: "Mark Done", exact: true }).isEnabled(), true);
  await restoredFinding.getByRole("button", { name: "Mark Done", exact: true }).click();
  await diff.locator('[data-item-id="inline:next-example"]').waitFor({ state: "visible" });
  await waitForCurrentActions();
  assert.equal(patchUpdateSession.items[0].state, "handled");
});

test("Patch Update does not leave a stalled working-tree diff loader on screen", async (t) => {
  const graph = {
    branch: "Bug-123456",
    commitCount: 1,
    commits: [{
      author: { email: "author@example.com", name: "Author", timestamp: 1 },
      hash: "abc123def456",
      parents: [],
      refs: ["HEAD", "Bug-123456"],
      subject: "Bug 123456 - Update the example. r=reviewer D123456",
    }],
    diffs: {},
    label: "comm",
    path: "/repo/comm",
    repository: "comm",
  };
  const html = buildGraphHtml({
    graphs: [graph],
    interactive: {
      aiEnabled: true,
      enabled: true,
      token: "secret",
    },
    scriptSrcs: ["/assets/graph-client/init.js"],
    stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    appConfig: { ai: { enabled: true } },
    graphs: [graph],
    html,
    preparePatchUpdateSession: async ({ session }) => {
      session.currentHash = "abc123def456";
      session.items = [{
        assessment: "Check the selected state update.",
        author: "Reviewer",
        changeApplied: true,
        changeReverted: false,
        content: "Please explain the selected state update.",
        contextLineSide: "new",
        filePath: "mail/example.mjs",
        id: "inline:example",
        lineNumber: 1,
        recommendation: "reply",
        requiresChanges: false,
        state: "ready",
        suggestedReply: "The selected state update is required.",
        type: "inline",
      }];
      session.status = "review";
    },
    runCommand: async ({ args = [] }) => {
      if (args[0] === "log") {
        return GIT_LOG_RECORD;
      }
      if (args.includes("show")) {
        return PATCH_DIFF;
      }
      if (args.includes("branch")) {
        return "Bug-123456\n";
      }
      if (args.includes("rev-parse")) {
        return "abc123def456\n";
      }
      return "";
    },
    token: "secret",
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    globalThis.__TB_TOOLS_TEST_WORKING_TREE_DIFF_TIMEOUT_MS__ = 25;
    const nativeFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = (input, init = {}) => {
      if (!String(input).includes("/diff/uncommitted-changes")) {
        return nativeFetch(input, init);
      }

      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    };
  });
  t.after(async () => {
    await browser.close();
    if (serverInfo.server.listening) {
      await new Promise((resolve) => serverInfo.server.close(resolve));
    }
  });

  await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { openPatchUpdateDialog } = await import("/assets/graph-client/patch-update-dialog.js");

    await openPatchUpdateDialog({
      graphIndex: 0,
      patch: { id: "D123456", title: "Bug 123456 - Update the example." },
    });
  });

  const workingDiff = page.locator(".patch-update-working-diff");

  await workingDiff.getByText(/Could not load the actual uncommitted diff/).waitFor({ state: "visible" });
  assert.match(await workingDiff.innerText(), /did not finish within 0.025 seconds/);
  assert.doesNotMatch(await workingDiff.innerText(), /Loading the actual uncommitted diff/);
});

test("Patch Update keeps revision-level feedback actionable through submission", async (t) => {
  const handledComments = [];
  let completedSession;
  const graph = {
    branch: "Bug-123456",
    commitCount: 1,
    commits: [{
      author: { email: "author@example.com", name: "Author", timestamp: 1 },
      hash: "abc123def456",
      parents: [],
      refs: ["HEAD", "Bug-123456"],
      subject: "Bug 123456 - Update the example. r=reviewer D123456",
    }],
    diffs: {},
    label: "comm",
    path: "/repo/comm",
    repository: "comm",
  };
  const html = buildGraphHtml({
    graphs: [graph],
    interactive: {
      aiEnabled: true,
      enabled: true,
      token: "secret",
    },
    scriptSrcs: ["/assets/graph-client/init.js"],
    stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    appConfig: { ai: { enabled: true } },
    graphs: [graph],
    html,
    persistPatchUpdateHandledComment: async (details) => handledComments.push(details),
    preparePatchUpdateSession: async ({ session }) => {
      completedSession = session;
      session.currentHash = "abc123def456";
      session.items = [{
        assessment: "The behavior is correct. Explain why the patch keeps the current branch.",
        author: "Reviewer",
        content: "Please explain why this branch stays in the patch.",
        id: "comment:revision-feedback",
        rationale: "The changed source keeps the documented behavior contract.",
        recommendation: "reply",
        state: "ready",
        suggestedReply: "The branch preserves the existing behavior contract.",
        type: "comment",
        validation: "The focused test covers this branch.",
      }];
      session.message = "Codex reviewed the revision-level feedback.";
      session.status = "review";
    },
    runCommand: async ({ args = [] }) => {
      if (args[0] === "log") {
        return GIT_LOG_RECORD;
      }
      if (args.includes("show")) {
        return PATCH_DIFF;
      }
      if (args.includes("branch")) {
        return "Bug-123456\n";
      }
      if (args.includes("rev-parse")) {
        return "abc123def456\n";
      }
      return "";
    },
    savePatchUpdateMemory: async () => {},
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
    const { openPatchUpdateDialog } = await import("/assets/graph-client/patch-update-dialog.js");

    await openPatchUpdateDialog({
      graphIndex: 0,
      patch: { id: "D123456", title: "Bug 123456 - Update the example." },
    });
  });

  const diff = page.locator(".patch-update-context-diff-content");
  const finding = diff.locator('[data-item-id="comment:revision-feedback"]');

  await finding.waitFor({ state: "visible" });
  assert.match(await finding.innerText(), /Please explain why this branch stays in the patch/);
  assert.equal(await finding.locator(".patch-update-comment-author").isVisible(), true);
  assert.equal(await finding.locator(".patch-update-comment-author").innerText(), "Comment from Reviewer");
  assert.equal(await finding.getByRole("button", { name: "Skip", exact: true }).isVisible(), true);
  assert.match(await finding.innerText(), /The behavior is correct/);
  assert.equal(
    await finding.locator(".patch-update-inline-reply").inputValue(),
    "The branch preserves the existing behavior contract.",
  );
  await finding.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Submit Patch" }).waitFor({ state: "visible" });
  assert.deepEqual(handledComments, [{
    revision: "D123456",
    itemId: "comment:revision-feedback",
  }]);
  assert.equal(
    await diff.locator(".patch-update-unanchored-finding").count(),
    0,
    "completed feedback must not re-open as a batch of findings",
  );
  assert.equal(await page.locator(".patch-update-steer").isVisible(), true);
  assert.equal(await page.locator(".patch-update-results").isVisible(), true);
  assert.match(await page.locator(".patch-update-results").innerText(), /Validation:/);
  await page.route("**/api/patch-update/*/steer", async (route) => {
    assert.equal(route.request().postDataJSON().instruction, "Fix the remaining cleanup issue.");
    await route.fulfill({ json: { ok: true, ...serializeGraphPatchUpdateSession(completedSession),
      followUpAnswer: "Fixed cleanup and ran the focused test." } });
  });
  await page.locator(".patch-update-steer-input").fill("Fix the remaining cleanup issue.");
  await page.locator(".patch-update-steer-submit").click();
  await page.locator(".patch-update-follow-up-answer", { hasText: "Fixed cleanup" }).waitFor();

  await page.unroute("**/api/patch-update/*/steer");
  let retryRequests = 0;
  await page.route("**/api/patch-update/*/steer", async route => {
    retryRequests++;
    if (retryRequests === 1) {
      await route.fulfill({ json: { ok: true, ...serializeGraphPatchUpdateSession({
        ...completedSession, status: "error", codexSessionId: "saved-thread",
        error: "Codex did not evaluate inline:missing.", message: "Codex did not evaluate inline:missing.",
      }) } });
    } else {
      assert.match(route.request().postDataJSON().instruction, /complete assessment/);
      await route.fulfill({ json: { ok: true, ...serializeGraphPatchUpdateSession(completedSession) } });
    }
  });
  await page.locator(".patch-update-steer-input").fill("Check the assessment again.");
  await page.locator(".patch-update-steer-submit").click();
  const retry = page.getByRole("button", { name: "Retry Assessment", exact: true });
  await retry.waitFor({ state: "visible" });
  assert.equal(await page.locator(".patch-update-steer").isVisible(), true);
  assert.match(await page.locator(".patch-update-steer-label").innerText(), /retry the assessment/);
  await retry.click();
  await retry.waitFor({ state: "hidden" });
  assert.equal(retryRequests, 2);

});
