import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

async function fixture(t, { enabled = true, permission = "granted" } = {}) {
  const graph = { label: "comm", path: "/repo/comm", checkout: "working", repository: "comm", commits: [], diffs: {} };
  const info = await startInteractiveGraphServer({ graphs: [graph], token: "test", tryMonitor: null,
    runCommand: async () => "", html: buildGraphHtml({ graphs: [graph], interactive: { enabled: true, aiEnabled: enabled, token: "test" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  t.after(async () => { await browser.close(); info.server.closeAllConnections(); await new Promise(resolve => info.server.close(resolve)); });
  await page.addInitScript(permission => {
    globalThis.notices = []; globalThis.permissionRequests = 0; globalThis.focusCalls = 0;
    globalThis.window.focus = () => { globalThis.focusCalls++; };
    globalThis.Notification = class {
      static permission = permission;
      static async requestPermission() { globalThis.permissionRequests++; this.permission = "granted"; return "granted"; }
      constructor(title, options) { this.title = title; this.options = options; globalThis.notices.push(this); }
      close() { this.closed = true; }
    };
  }, permission);
  const sessions = new Map(); const posts = [];
  const make = (id, mode = "update") => ({ ok: true, id, revision: id === "r1" ? "D2" : "D1", mode, aiEnabled: true,
    status: "reviewing", currentHash: "abc123", graphIndex: 0, items: [], issues: [], chat: [], activity: [{ id: "reason", kind: "reasoning", title: "Inspecting context" }], output: "" });
  await page.route("**/api/patch-update**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON(); posts.push({ url: url.pathname, data });
      const value = make("u" + (posts.length), data.mode); sessions.set(value.id, value);
      return route.fulfill({ json: value });
    }
    const id = url.pathname.split("/")[3];
    return route.fulfill({ json: sessions.get(id) || { ok: true, html: "", text: "" } });
  });
  await page.route("**/api/review**", async route => {
    if (route.request().method() === "POST") {
      posts.push({ url: new URL(route.request().url()).pathname, data: route.request().postDataJSON() });
      const value = make("r1"); sessions.set(value.id, value); return route.fulfill({ json: value });
    }
    return route.fulfill({ json: sessions.get(new URL(route.request().url()).pathname.split("/")[3]) || { ok: true, rawPatchHtml: "", reviewDiscussion: {} } });
  });
  const initialize = () => page.evaluate(async () => {
    (await import("/assets/graph-client/patch-update-dialog.js")).initializePatchUpdateDialog();
    (await import("/assets/graph-client/patch-review-dialog.js")).initializePatchReviewDialog();
  });
  await page.goto(info.url); await initialize();
  const openUpdate = mode => page.evaluate(async mode => (await import("/assets/graph-client/patch-update-dialog.js")).openPatchUpdateDialog({ patch: { id: "D1" }, graphIndex: 0, mode }), mode);
  return { page, sessions, posts, openUpdate, initialize };
}

for (const mode of ["update", "freeform", "verify"]) test(`${mode} minimizes, keeps polling, and notifications reopen the exact task`, async t => {
  const { page, sessions, posts, openUpdate } = await fixture(t);
  await openUpdate(mode);
  const toast = page.locator('[data-task-key="update:u1"]');
  assert.equal(await toast.getAttribute("data-state"), "thinking");
  await page.locator("#patch-update-dialog .ai-task-minimize").click();
  assert.equal(await page.locator("#patch-update-dialog").getAttribute("open"), null);
  await page.waitForFunction(() => !globalThis.document.body.classList.contains("patch-update-open"));
  await page.evaluate(async () => (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
  sessions.get("u1").activity.push({ id: "cmd", kind: "command", title: "Running tests" });
  await page.waitForFunction(() => globalThis.notices.some(note => note.title.endsWith(": Working")));
  sessions.get("u1").status = "review";
  await page.waitForFunction(() => globalThis.notices.some(note => note.title.endsWith(": Waiting for input")));
  await page.evaluate(() => globalThis.notices.at(-1).onclick());
  await page.locator("#patch-update-dialog[open]").waitFor();
  assert.equal(await page.locator("#patch-review-dialog").getAttribute("open"), null);
  assert.equal(posts.length, 2, "reopening must not POST or restart a task");
  assert.equal(await page.evaluate(() => globalThis.focusCalls), 1);
  await page.locator("#patch-update-dialog .ai-task-minimize").click();
  sessions.get("u1").status = "complete";
  await page.waitForFunction(() => globalThis.notices.some(note => note.title.endsWith(": Complete")));
  assert.equal(await toast.getAttribute("data-state"), "complete");
  const count = await page.evaluate(() => globalThis.notices.length);
  await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(() => globalThis.notices.length), count);
  assert.equal(posts.some(post => /cancel/.test(post.url)), false);
  await page.screenshot({ path: `/tmp/ai-task-tray-${mode}.png`, fullPage: true });
});

test("switching two update dialogs preserves a typed draft and restores tray tasks after reload", async t => {
  const { page, sessions, openUpdate, initialize, posts } = await fixture(t, { permission: "default" });
  await openUpdate("freeform");
  sessions.get("u1").status = "review";
  await page.locator("#patch-update-steer-input").fill("Keep my unsent instruction");
  await page.locator("#patch-update-dialog .ai-task-minimize").click();
  await openUpdate("verify");
  await page.locator("#patch-update-dialog .ai-task-minimize").click();
  await page.locator('[data-task-key="update:u1"] .ai-task-open').click();
  await page.locator("#patch-update-dialog[open] .patch-update-title").filter({ hasText: "D1 Update" }).waitFor();
  assert.equal(await page.locator("#patch-update-steer-input").inputValue(), "Keep my unsent instruction");
  assert.match(await page.locator(".patch-update-title").textContent(), /Update$/);
  assert.equal(posts.length, 2);
  assert.equal(await page.evaluate(() => globalThis.permissionRequests), 1);
  await page.reload(); await initialize();
  await page.locator('[data-task-key="update:u2"] .ai-task-open').click();
  await page.locator("#patch-update-dialog[open] .patch-update-title").filter({ hasText: "D1 Verify" }).waitFor();
  assert.match(await page.locator(".patch-update-title").textContent(), /Verify$/);
  assert.equal(posts.length, 2);
});

test("denied notifications leave status toasts usable and AI-disabled consoles show no controls", async t => {
  const { page, openUpdate } = await fixture(t, { permission: "denied" });
  await openUpdate("verify"); await page.locator("#patch-update-dialog .ai-task-minimize").click();
  assert.match(await page.locator(".ai-task-notification-note").textContent(), /blocked/);
  assert.equal(await page.evaluate(() => globalThis.notices.length), 0);
  const disabled = await fixture(t, { enabled: false });
  assert.equal(await disabled.page.locator(".ai-task-minimize").count(), 0);
  assert.equal(await disabled.page.locator(".ai-task-tray").count(), 0);
});

test("Review keeps running when minimized and reopens on its own notification", async t => {
  const { page, sessions, posts } = await fixture(t);
  await page.evaluate(async () => (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
  await page.locator("#patch-review-dialog .ai-task-minimize").click();
  sessions.get("r1").status = "review";
  await page.waitForFunction(() => globalThis.notices.some(note => note.title === "D2 Review: Waiting for input"));
  await page.evaluate(() => globalThis.notices.at(-1).onclick());
  await page.locator("#patch-review-dialog[open]").waitFor();
  assert.equal(posts.length, 1);
  assert.match(await page.locator(".patch-review-title").textContent(), /D2 review/i);
});

test("a paused rebase restores its files and pending AI changes after reload", async t => {
  const { page, initialize } = await fixture(t);
  const conflict = { id: "saved-rebase", type: "conflict", graphIndex: 0, conflictCommit: "abcdef123456",
    label: "comm", files: [{ path: "source.js", absolutePath: "/task/comm/source.js" }] };
  const value = { ok: true, id: conflict.id, status: "review", rebaseConflict: conflict,
    rebaseState: { sessionId: conflict.id, graphIndex: 0, conflict, resolutionId: "saved-resolution" },
    resolution: { id: "saved-resolution", diff: "diff --git a/source.js b/source.js\n+resolved source" } };
  await page.route("**/api/rebase/saved-rebase**", route => route.fulfill({ json: value }));
  await page.evaluate(async conflict => (await import("/assets/graph-client/rebase-dialog.js"))
    .openRebaseFailureDialog(conflict), conflict);
  await page.waitForTimeout(1800);
  assert.doesNotMatch(await page.locator('[data-task-key="rebase:saved-rebase"]').textContent(), /Connection lost|not a function/);
  await page.locator("#rebase-dialog .ai-task-minimize").click();
  await page.reload(); await initialize();
  await page.locator('[data-task-key="rebase:saved-rebase"] .ai-task-open').click();
  await page.locator("#rebase-dialog[open]").waitFor();
  assert.match(await page.locator(".rebase-conflict-path").textContent(), /source.js/);
  assert.match(await page.locator(".rebase-resolution-diff").textContent(), /resolved source/);
  assert.equal(await page.locator("#rebase-dialog .rebase-close").textContent(), "Cancel");
  assert.equal(await page.evaluate(async () => (await import("/assets/graph-client/config.js")).uiState.rebaseDialogState.resolutionId), "saved-resolution");
});

for (const outcome of ["accept", "request-changes", "comment"]) test(`final ${outcome} closes only after success`, async t => {
  const { page, sessions } = await fixture(t);
  await page.evaluate(async () => (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
  sessions.get("r1").status = "review";
  const button = page.locator(`[data-review-outcome="${outcome}"]`);
  await button.waitFor({ state: "visible" });
  let fail = true;
  await page.route("**/api/review/r1/submit", route => {
    assert.equal(route.request().postDataJSON().outcome, outcome);
    return route.fulfill({ status: fail ? 500 : 200, json: fail ? { ok: false, error: "Posting failed" } : { ...sessions.get("r1"), status: "complete" } });
  });
  await button.click();
  await page.locator(".patch-review-status").filter({ hasText: "Posting failed" }).waitFor();
  assert.equal(await page.locator("#patch-review-dialog").getAttribute("open"), "");
  fail = false; sessions.get("r1").status = "complete";
  await button.click();
  await page.locator("#patch-review-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
});

test("AI-flow Submit closes on success, but stays open on failure", async t => {
  const { page } = await fixture(t);
  await page.evaluate(async () => {
    const { uiState } = await import("/assets/graph-client/config.js");
    const { renderSubmitSession } = await import("/assets/graph-client/commit-actions.js");
    uiState.submitDialogState = { sessionId: "submit-1", graphIndex: 0, patchUpdateSessionId: "u1" };
    globalThis.document.getElementById("submit-dialog").showModal();
    renderSubmitSession({ id: "submit-1", graphIndex: 0, status: "error", error: "Push failed" });
  });
  assert.equal(await page.locator("#submit-dialog").getAttribute("open"), "");
  await page.evaluate(async () => (await import("/assets/graph-client/commit-actions.js")).renderSubmitSession({ id: "submit-1", graphIndex: 0, status: "complete" }));
  assert.equal(await page.locator("#submit-dialog").getAttribute("open"), null);
});

test("two console tabs send one notification for a shared task transition", async t => {
  const { page, sessions, openUpdate } = await fixture(t);
  await openUpdate("verify");
  await page.locator("#patch-update-dialog .ai-task-minimize").click();
  const second = await page.context().newPage();
  await second.addInitScript(() => {
    globalThis.notices = [];
    globalThis.Notification = class {
      static permission = "granted";
      constructor(title) { globalThis.notices.push({ title }); }
      close() {}
    };
  });
  await second.route("**/api/patch-update/u1?*", route => route.fulfill({ json: sessions.get("u1") }));
  await second.goto(page.url());
  const saved = await page.evaluate(() => globalThis.sessionStorage.getItem("tb-ai-tasks:test"));
  await second.evaluate(async saved => {
    globalThis.sessionStorage.setItem("tb-ai-tasks:test", saved);
    await import("/assets/graph-client/patch-update-dialog.js");
  }, saved);
  sessions.get("u1").status = "review";
  await page.waitForFunction(() => globalThis.localStorage.getItem("tb-ai-tasks:test:notification:update:u1") === "waiting");
  await page.waitForTimeout(1700);
  assert.equal((await page.evaluate(() => globalThis.notices.length)) + (await second.evaluate(() => globalThis.notices.length)), 1);
});

test("confirmed Submit closes its AI dialog, then closes the Submit dialog when done", async t => {
  const { page, sessions, openUpdate } = await fixture(t);
  await openUpdate("freeform");
  sessions.get("u1").status = "review";
  await page.waitForFunction(() => !globalThis.document.querySelector(".patch-update-submit").disabled);
  let state = "running";
  await page.route("**/api/submit**", route => route.fulfill({ json: { ok: true, id: "submit-1", graphIndex: 0,
    patchUpdateSessionId: "u1", status: state, message: state === "complete" ? "Submitted" : "Submitting", links: [] } }));
  await page.locator(".patch-update-submit").click();
  await page.locator("#system-dialog .system-dialog-confirm").click();
  await page.locator("#submit-dialog[open]").waitFor();
  assert.equal(await page.locator("#patch-update-dialog").getAttribute("open"), null);
  state = "complete"; sessions.get("u1").status = "complete";
  await page.locator("#submit-dialog").waitFor({ state: "hidden" });
  await page.locator('[data-task-key="update:u1"][data-state="complete"]').waitFor();
});

for (const action of ["close", "escape"]) test(`Review ${action} cancels and dismisses instead of minimizing`, async t => {
  const { page, sessions, initialize } = await fixture(t);
  let cancellations = 0;
  let fail = true;
  await page.route("**/api/review/r1/cancel", route => {
    cancellations++;
    if (fail) return route.fulfill({ status: 500, json: { ok: false, error: "Cancellation failed" } });
    sessions.get("r1").status = "cancelled";
    return route.fulfill({ json: sessions.get("r1") });
  });
  await page.evaluate(async () => (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
  const close = () => action === "escape" ? page.keyboard.press("Escape") : page.locator(".patch-review-close").click();
  await close();
  await page.getByText("Cancellation failed", { exact: true }).first().waitFor();
  assert.equal(await page.locator("#patch-review-dialog").evaluate(node => node.open), true);
  fail = false;
  await close();
  await page.locator("#patch-review-dialog[open]").waitFor({ state: "hidden" });
  assert.equal(cancellations, 2);
  assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
  await page.waitForTimeout(1700);
  assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
  await page.reload(); await initialize();
  assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
});

test("a reopened review returns to the tray after it was dismissed", async t => {
  const { page, sessions, initialize, posts } = await fixture(t);
  const openReview = () => page.evaluate(async () =>
    (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
  await page.route("**/api/review/r1/cancel", route => {
    sessions.get("r1").status = "cancelled";
    return route.fulfill({ json: sessions.get("r1") });
  });
  await openReview();
  await page.locator(".patch-review-close").click();
  await page.locator("#patch-review-dialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
  await page.reload(); await initialize();
  await openReview();
  await page.locator("#patch-review-dialog .ai-task-minimize").click();
  const card = page.locator('[data-task-key="review:r1"]');
  await card.waitFor({ state: "visible" });
  await card.locator(".ai-task-open").click();
  await page.locator("#patch-review-dialog[open]").waitFor();
  assert.equal(posts.length, 2, "restoring from the tray must not restart the review");
  await page.locator("#patch-review-dialog .ai-task-minimize").click();
  await page.reload(); await initialize();
  await card.waitFor({ state: "visible" });
});

test("cancelled implementations disappear and missing tasks stop polling", async t => {
  const { page } = await fixture(t);
  await page.goto(page.url());
  let requests = 0;
  await page.route('**/api/implement/missing?*', route => { requests++; return route.fulfill({status:404,json:{ok:false,error:'Unknown Implement task.'}}); });
  await page.evaluate(async () => {
    const {trackAiTask} = await import('/assets/graph-client/ai-task-tray.js');
    trackAiTask({kind:'implement',session:{id:'cancelled',phase:'implementing'},title:'Cancelled implementation'});
    trackAiTask({kind:'implement',session:{id:'cancelled',phase:'cancelled',error:'old error'},title:'Cancelled implementation'});
    trackAiTask({kind:'implement',session:{id:'missing',phase:'implementing'},title:'Missing implementation',endpoint:'/api/implement/missing'});
  });
  assert.equal(await page.locator('[data-task-key="implement:cancelled"]').count(),0);
  await page.locator('[data-task-key="implement:missing"]').waitFor({state:'detached'});
  assert.equal(requests,1);
  let restoredRequests = 0;
  await page.route("**/api/implement/restored?*", route => { restoredRequests++; return route.fulfill({ json: { ok: true, id: "restored", phase: "cancelled" } }); });
  await page.evaluate(async () => {
    const { trackAiTask } = await import("/assets/graph-client/ai-task-tray.js");
    trackAiTask({ kind: "implement", session: { id: "restored", phase: "complete" }, title: "Saved implementation", endpoint: "/api/implement/restored" });
  });
  await page.reload();
  await page.evaluate(async () => { await import("/assets/graph-client/ai-task-tray.js"); });
  await page.locator('[data-task-key="implement:restored"]').waitFor({ state: "detached" });
  assert.equal(restoredRequests, 1);
  assert.equal(await page.locator('[data-task-key="implement:cancelled"]').count(), 0);
});

for (const outcome of ["accept", "request-changes", "comment"]) {
  test(`Review ${outcome} closes and dismisses only after a successful post`, async t => {
    const { page, sessions, posts, initialize } = await fixture(t);
    const review = { ok: true, id: "r1", revision: "D2", aiEnabled: true, status: "review",
      currentHash: "abc123", graphIndex: 0, issues: [], activity: [], output: "", coverage: {} };
    sessions.set("r1", review);
    await page.route("**/api/review", route => route.fulfill({ json: review }));
    let fail = true;
    let submissions = 0;
    await page.route("**/api/review/r1/submit", route => {
      submissions++;
      assert.equal(route.request().postDataJSON().outcome, outcome);
      assert.equal(route.request().postDataJSON().message, "Review summary to keep.");
      if (fail) return route.fulfill({ status: 500, json: { ok: false, error: "Posting failed" } });
      review.status = "complete";
      review.reviewOutcome = outcome;
      return route.fulfill({ json: review });
    });
    await page.evaluate(async () => (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
    await page.locator(".patch-review-final > summary").click();
    await page.locator(".patch-review-final-message").fill("Review summary to keep.");
    const submit = page.locator(`[data-review-outcome="${outcome}"]`);
    await submit.click();
    await page.getByText("Posting failed", { exact: true }).first().waitFor();
    assert.equal(await page.locator("#patch-review-dialog").evaluate(node => node.open), true);
    assert.equal(await page.locator(".patch-review-final-message").inputValue(), "Review summary to keep.");
    fail = false;
    await submit.click();
    await page.locator("#patch-review-dialog[open]").waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
    assert.equal(submissions, 2);
    assert.equal(posts.some(post => post.url.endsWith("/cancel")), false);
    await page.reload(); await initialize();
    assert.equal(await page.locator('[data-task-key="review:r1"]').count(), 0);
  });
}

for (const kind of ["update", "review"]) test(`${kind} polling preserves selected activity and output`, async t => {
  const { page, sessions, openUpdate } = await fixture(t);
  if (kind === "update") await openUpdate("verify");
  else await page.evaluate(async () => (await import("/assets/graph-client/patch-review-dialog.js")).openPatchReviewDialog({ patch: { id: "D2" } }));
  const current = sessions.get(kind === "update" ? "u1" : "r1");
  const prefix = `.patch-${kind}`;
  current.activity = [{ id: "note", kind: "note", title: "Text to copy", detail: "Keep this selected note." }];
  await page.locator(`${prefix}-activity-list`).filter({ hasText: "Keep this selected note." }).waitFor();
  const select = selector => page.evaluate(selector => {
    const element = globalThis.document.querySelector(selector);
    const walker = globalThis.document.createTreeWalker(element, globalThis.NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const selection = globalThis.window.getSelection();
    selection.setBaseAndExtent(node, 0, node, node.length);
    globalThis.selectedNode = node;
    return selection.toString();
  }, selector);
  const selected = await select(`${prefix}-activity-list li`);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => globalThis.window.getSelection().toString()), selected);
  current.activity.push({ id: "next", kind: "note", title: "New activity", detail: "Another note arrived." });
  await page.locator(`${prefix}-activity-list`).filter({ hasText: "Another note arrived." }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ text: globalThis.window.getSelection().toString(), connected: globalThis.selectedNode.isConnected })), { text: selected, connected: true });
  current.output = "First output line\n";
  await page.locator(`${prefix}-output-toggle`).click();
  await page.locator(`${prefix}-output`).filter({ hasText: "First output line" }).waitFor();
  const outputSelection = await select(`${prefix}-output`);
  current.output += "Second output line\n";
  await page.locator(`${prefix}-output`).filter({ hasText: "Second output line" }).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => globalThis.window.getSelection().toString()), outputSelection);
});

test("test output keeps selected colored text when polls repeat and append output", async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(async () => {
    const { renderAnsiOutput } = await import("/assets/graph-client/test-dialog.js");
    const container = globalThis.document.createElement("pre");
    globalThis.document.body.append(container);
    renderAnsiOutput(container, "\u001b[31mFailure text");
    const node = container.firstChild.firstChild;
    const selection = globalThis.window.getSelection();
    selection.setBaseAndExtent(node, 2, node, 9);
    const selected = selection.toString();
    renderAnsiOutput(container, "\u001b[31mFailure text");
    renderAnsiOutput(container, "\u001b[31mFailure text with more detail\u001b[0m\nNext line");
    return { selected, actual: selection.toString(), connected: node.isConnected, text: container.textContent };
  });
  assert.equal(result.actual, result.selected);
  assert.equal(result.connected, true);
  assert.equal(result.text, "Failure text with more detail\nNext line");
});

test("running reviews restore from the server after browser task storage is lost", async t => {
  const { page, sessions, initialize, posts } = await fixture(t);
  sessions.set("r1", { ok: true, id: "r1", revision: "D2", aiEnabled: true,
    status: "reviewing", issues: [], activity: [], output: "" });
  await page.route("**/api/background-jobs?*", route => route.fulfill({ json: {
    ok: true, jobs: [
      { id: "Review:r1", kind: "Review", state: "running", title: "D2" },
      { id: "Review:finished", kind: "Review", state: "finished", title: "D3" },
      { id: "Review:handled", kind: "Review", state: "waiting", title: "D4" },
      { id: "Rebase:old", kind: "Rebase", state: "waiting", title: "Old rebase" },
    ],
  } }));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await initialize();
  const card = page.locator('[data-task-key="review:r1"]');
  await card.waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-task-key="review:finished"]').count(), 0);
  assert.equal(await page.locator('[data-task-key="review:handled"]').count(), 0);
  assert.equal(await page.locator('[data-task-key="rebase:old"]').count(), 0);
  await card.locator(".ai-task-open").click();
  await page.locator("#patch-review-dialog[open]").waitFor();
  assert.equal(posts.length, 0, "restoring a review must not start another review");
});

for (const action of ["close", "escape"]) test(`conflict dialog ${action} dismisses its tray task`, async t => {
  const { page, initialize } = await fixture(t);
  const conflict = { id: "close-rebase", type: "conflict", graphIndex: 0, files: [] };
  await page.route("**/api/rebase/close-rebase?*", route => route.fulfill({ json: {
    ok: true, id: conflict.id, status: "review", rebaseConflict: conflict,
  } }));
  await page.evaluate(async conflict => (await import("/assets/graph-client/rebase-dialog.js")).openRebaseFailureDialog(conflict), conflict);
  const card = page.locator('[data-task-key="rebase:close-rebase"]');
  await card.waitFor({ state: "visible" });
  if (action === "escape") await page.keyboard.press("Escape");
  else await page.evaluate(async () => (await import("/assets/graph-client/rebase-dialog.js")).closeRebaseDialog());
  await page.locator("#rebase-dialog[open]").waitFor({ state: "hidden" });
  await card.waitFor({ state: "detached" });
  await page.route("**/api/background-jobs?*", route => route.fulfill({ json: {
    ok: true, jobs: [{ id: "Rebase:close-rebase", kind: "Rebase", state: "waiting", title: "comm" }],
  } }));
  const discovery = page.waitForResponse(response => response.url().includes("/api/background-jobs"));
  await page.reload(); await initialize();
  await discovery;
  assert.equal(await card.count(), 0);
});

test("Verify shows Submit startup errors in its dialog and opens Submit after retry", async t => {
  const { page, sessions, openUpdate } = await fixture(t);
  await openUpdate("verify");
  sessions.get("u1").status = "review";
  await page.waitForFunction(() => !globalThis.document.querySelector(".patch-update-submit").disabled);
  let fail = true;
  await page.route("**/api/submit**", route => route.fulfill({ status: fail ? 409 : 200, json: fail
    ? { ok: false, error: "Could not prepare the submission branch." }
    : { ok: true, id: "verify-submit", graphIndex: 0, patchUpdateSessionId: "u1", status: "running", links: [] } }));
  await page.locator(".patch-update-submit").click();
  await page.locator("#system-dialog .system-dialog-confirm").click();
  await page.locator("#patch-update-dialog[open]").getByText("Could not prepare the submission branch.", { exact: true }).waitFor();
  await page.waitForTimeout(1800);
  assert.equal(await page.locator("#patch-update-dialog[open]").getByText("Could not prepare the submission branch.", { exact: true }).isVisible(), true);
  assert.equal(await page.locator("#submit-dialog").getAttribute("open"), null);
  fail = false;
  await page.locator(".patch-update-submit").click();
  await page.locator("#system-dialog .system-dialog-confirm").click();
  await page.locator("#submit-dialog[open]").waitFor();
  assert.equal(await page.locator("#patch-update-dialog").getAttribute("open"), null);
});
