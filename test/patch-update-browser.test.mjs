import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

const WORKING_TREE_DIFF = [
  "diff --git a/mail/example.mjs b/mail/example.mjs",
  "index 111111111111..222222222222 100644",
  "--- a/mail/example.mjs",
  "+++ b/mail/example.mjs",
  "@@ -1 +1 @@",
  "-const previousValue = false;",
  "+const updatedValue = true;",
  "",
].join("\n");

const NEXT_WORKING_TREE_DIFF = [
  "diff --git a/mail/example.mjs b/mail/example.mjs",
  "index 222222222222..333333333333 100644",
  "--- a/mail/example.mjs",
  "+++ b/mail/example.mjs",
  "@@ -1 +1 @@",
  "-const updatedValue = true;",
  "+const finalValue = true;",
  "",
].join("\n");

test("Patch Update renders the working-tree diff for prepared changes and each comment", async (t) => {
  let currentWorkingTreeDiff = WORKING_TREE_DIFF;
  let patchUpdateSession;
  let workingTreeDiffReads = 0;
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
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs: [graph],
    html,
    preparePatchUpdateSession: async ({ session }) => {
      patchUpdateSession = session;
      session.currentHash = "abc123def456";
      session.items = [{
        assessment: "The source change is ready for review.",
        author: "Reviewer",
        changeAccepted: false,
        changeApplied: true,
        changeReverted: false,
        changeSummary: "Codex prepared the first source change.",
        feedbackType: "Inline review feedback",
        id: "inline:example",
        recommendation: "change",
        requiresChanges: true,
        state: "ready",
        suggestedReply: "I made the requested change.",
      }, {
        assessment: "The follow-up source change is ready for review.",
        author: "Reviewer",
        changeAccepted: false,
        changeApplied: true,
        changeReverted: false,
        changeSummary: "Codex prepared the next source change.",
        feedbackType: "Inline review feedback",
        id: "inline:next-example",
        recommendation: "change",
        requiresChanges: true,
        state: "pending",
        suggestedReply: "I made the follow-up change.",
      }];
      session.message = "Codex prepared a working-tree change. Review the actual uncommitted diff, then keep or revert it.";
      session.status = "review";
      setTimeout(() => {
        currentWorkingTreeDiff = NEXT_WORKING_TREE_DIFF;
        session.currentItemIndex = 1;
        session.items[0].state = "handled";
        session.items[1].state = "ready";
        session.workingTreeDiffVersion = (session.workingTreeDiffVersion || 0) + 1;
      }, 250);
    },
    runCommand: async ({ args = [] }) => {
      if (args[0] === "diff") {
        workingTreeDiffReads++;
        return currentWorkingTreeDiff;
      }

      if (args.includes("show")) {
        return currentWorkingTreeDiff;
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
  const diff = page.locator(".patch-update-proposed-diff");

  await diff.waitFor({ state: "visible" });
  assert.equal(await diff.evaluate((element) => element.hidden), false);
  assert.notEqual(await diff.evaluate((element) => (
    element.ownerDocument.defaultView.getComputedStyle(element).display
  )), "none");
  await diff.getByText("Working tree changes").waitFor({ state: "visible" });
  await page.locator(".patch-update-proposed-diff-content .pretty-file").waitFor({
    state: "visible",
  });
  const firstDiffMetrics = await diff.evaluate((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return {
      display: style.display,
      height: rect.height,
      hidden: element.hidden,
      innerText: element.innerText,
      overflow: style.overflow,
    };
  });

  assert.ok(
    firstDiffMetrics.height > 60,
    `the visible diff has usable height: ${JSON.stringify(firstDiffMetrics)}`,
  );
  assert.match(await diff.innerText(), /WORKING TREE CHANGES/);
  assert.match(await diff.innerText(), /mail\/example\.mjs/);
  assert.match(await diff.innerText(), /updatedValue = true/);
  await page.locator(".patch-update-proposed-diff-content").getByText(
    "finalValue = true",
  ).waitFor({ state: "visible" });
  assert.doesNotMatch(await diff.innerText(), /previousValue = false/);
  assert.ok(workingTreeDiffReads >= 2, "loads a fresh diff for the next comment");

  // The active session already passed through the prepared-change state twice.
  // Keep this binding alive so the server's poll observes the state transition.
  assert.equal(patchUpdateSession.items[1].changeApplied, true);
});

test("Patch Update keeps the actual checkout diff visible after every comment is handled", async (t) => {
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
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs: [graph],
    html,
    preparePatchUpdateSession: async ({ session }) => {
      session.currentHash = "abc123def456";
      session.currentItemIndex = 1;
      session.items = [{
        author: "Reviewer",
        changeAccepted: true,
        changeApplied: true,
        changeReverted: false,
        id: "inline:handled-example",
        state: "handled",
      }];
      session.message = "Comment marked as handled.";
      session.status = "review";
      session.workingTreeDiffVersion = 1;
    },
    runCommand: async ({ args = [] }) => {
      if (args[0] === "diff" || args.includes("show")) {
        return NEXT_WORKING_TREE_DIFF;
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
        id: "D123457",
        title: "Bug 123457 - Completed example.",
        url: "https://phabricator.services.mozilla.com/D123457",
      },
    });
  });

  const diff = page.locator(".patch-update-proposed-diff");

  await diff.waitFor({ state: "visible" });
  assert.equal(await diff.evaluate((element) => element.hidden), false);
  assert.notEqual(await diff.evaluate((element) => (
    element.ownerDocument.defaultView.getComputedStyle(element).display
  )), "none");
  await page.locator(".patch-update-proposed-diff-content .pretty-file").waitFor({
    state: "visible",
  });
  const finalDiffMetrics = await diff.evaluate((element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return {
      display: style.display,
      height: rect.height,
      hidden: element.hidden,
      innerText: element.innerText,
      overflow: style.overflow,
    };
  });

  assert.ok(
    finalDiffMetrics.height > 60,
    `the completed review keeps a visible diff: ${JSON.stringify(finalDiffMetrics)}`,
  );
  assert.match(await diff.innerText(), /finalValue = true/);
  assert.equal(await page.locator(".patch-update-reply-label").evaluate((element) => element.hidden), true);
});
