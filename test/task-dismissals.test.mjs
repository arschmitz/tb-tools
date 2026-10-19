import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createTaskDismissalStore } from "../commands/graph/task-dismissals.mjs";
import { createPatchSessionStore } from "../commands/graph/patch-session-store.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("dismissals survive a new store and preserve other task IDs", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-dismissals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createTaskDismissalStore({ directory });
  for (const kind of ["review", "update", "implement", "submit", "rebase"]) {
    store.dismiss(kind, "same-id");
    store.dismiss(kind, "same-id");
    assert.equal(createTaskDismissalStore({ directory }).has(kind, "same-id"), true,
      `${kind} should remain dismissed after reopening its store.`);
    assert.equal(store.has(kind, "new-id"), false,
      `A new ${kind} run should remain available.`);
  }
  assert.equal(store.list().length, 5, "Repeated dismissals should preserve one marker per task.");
  for (const [kind, id] of [["unknown", "id"], ["review", ""], ["review", {}]]) {
    assert.throws(() => store.dismiss(kind, id), /valid task kind and ID/,
      "Invalid task identities should be rejected.");
  }
});

test("task dismissal failures do not record an in-memory success", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-dismissal-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "file");
  await writeFile(file, "occupied");
  const store = createTaskDismissalStore({ directory: file });
  assert.throws(() => store.dismiss("implement", "task"),
    "A failed disk write should report an error.");
  assert.equal(store.has("implement", "task"), false,
    "A failed disk write should leave the task undismissed.");
});

test("a permanent dismissal stops a restored Review from resuming", async t => {
  let info;
  const directory = await mkdtemp(path.join(os.tmpdir(), "dismissed-review-resume-"));
  t.after(async () => {
    if (info?.server.listening) {
      info.server.closeAllConnections();
      await new Promise(resolve => info.server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const graphs = [{ path: "/repo/comm", checkout: "working", repository: "comm" },
    { path: "/repo", checkout: "working", repository: "firefox" }];
  const sessionDirectory = path.join(directory, "sessions");
  const dismissalDirectory = path.join(directory, "dismissals");
  createPatchSessionStore({ directory: sessionDirectory }).save("review", {
    id: "old-review", revision: "D123", status: "pulling", managedWorktree: true,
    graph: { ...graphs[0], path: "/tasks/review/comm", taskWorktree: true }, repositoryPath: "/repo/comm",
  });
  createTaskDismissalStore({ directory: dismissalDirectory }).dismiss("review", "old-review");
  let resumed = 0;
  info = await startInteractiveGraphServer({ graphs, html: "", token: "test", tryMonitor: null,
    patchSessionDirectory: sessionDirectory, taskDismissalDirectory: dismissalDirectory,
    appConfig: { taskWorktrees: true, ai: { enabled: true } },
    runCommand: async () => "", prepareTaskBuild: false,
    preparePatchReviewSession: async () => { resumed++; } });
  const result = await (await fetch(new URL("/api/background-jobs?token=test", info.url))).json();
  assert.equal(resumed, 0, "A permanently dismissed Review should not resume on backend startup.");
  assert.equal(result.jobs.some(job => job.id === "Review:old-review"), false,
    "A permanently dismissed Review should stay out of server discovery.");
});

test("tray dismissal survives a server restart and a fresh browser", async t => {
  let info, browser;
  const directory = await mkdtemp(path.join(os.tmpdir(), "tray-server-dismissal-"));
  t.after(async () => {
    await browser?.close();
    if (info?.server.listening) {
      info.server.closeAllConnections();
      await new Promise(resolve => info.server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const graphs = [{ path: "/repo/comm", label: "comm", commits: [] }];
  const implementation = { id: "saved-task", phase: "needs-evidence", title: "Saved implementation" };
  const start = () => startInteractiveGraphServer({ graphs, token: "test", tryMonitor: null,
    taskDismissalDirectory: directory, runCommand: async () => "",
    implementationManager: { list: () => [implementation], start() {}, stop() {} },
    html: buildGraphHtml({ graphs, interactive: { enabled: true, aiEnabled: true, token: "test" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }) });
  info = await start();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(info.url);
  const kinds = ["review", "update", "implement", "submit", "rebase"];
  let releasePoll, startPoll, finishPoll;
  const pollStarted = new Promise(resolve => { startPoll = resolve; });
  const pollFinished = new Promise(resolve => { finishPoll = resolve; });
  await page.route("**/api/review/saved-task?*", async route => {
    startPoll();
    await new Promise(resolve => { releasePoll = resolve; });
    await route.fulfill({ json: { ok: true, id: "saved-task", status: "review" } });
    finishPoll();
  });
  await page.evaluate(async kinds => {
    const { trackAiTask } = await import("/assets/graph-client/ai-task-tray.js");
    for (const kind of kinds) {
      trackAiTask({ kind, session: { id: "saved-task", status: "review" }, title: `${kind} task`,
        endpoint: kind === "review" ? "/api/review/saved-task" : undefined });
    }
  }, kinds);
  assert.equal(await page.getByRole("complementary", { name: "Tasks", exact: true }).count(), 1,
    "The tray should use Tasks as its accessible label.");
  assert.equal(await page.locator(".ai-task-tray-header strong").textContent(), "Tasks",
    "The tray heading should say Tasks.");
  await page.screenshot({ path: "/tmp/task-tray-fix/tasks.png", fullPage: true });
  await pollStarted;
  for (const kind of kinds) {
    const card = page.locator(`[data-task-key="${kind}:saved-task"]`);
    await card.locator(".ai-task-dismiss").click();
    await card.waitFor({ state: "detached" });
  }

  releasePoll();
  await pollFinished;
  assert.equal(await page.locator(".ai-task-toast").count(), 0,
    "A stale poll response should not restore a dismissed card.");
  await page.evaluate(async () => {
    const { registerAiTaskDialog } = await import("/assets/graph-client/ai-task-tray.js");
    const dialog = globalThis.document.createElement("dialog");
    globalThis.document.body.append(dialog);
    const adapter = registerAiTaskDialog({ kind: "review", dialog, title: () => "Reopened review" });
    dialog.showModal();
    adapter.update({ id: "saved-task", status: "review" });
    dialog.close();
  });
  assert.equal(await page.locator(".ai-task-toast").count(), 0,
    "Reopening the same session should not undo a permanent server dismissal.");

  // Recreate both the backend and browser to exclude client-only dismissal state.
  await page.close();
  info.server.closeAllConnections();
  await new Promise(resolve => info.server.close(resolve));
  info = await start();
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(info.url);
  const result = await (await fetch(new URL("/api/background-jobs?token=test", info.url))).json();
  assert.deepEqual(new Set(result.dismissedTasks), new Set(kinds.map(kind => `${kind}:saved-task`)),
    "All five task dismissals should survive a backend restart.");
  assert.equal(result.jobs.some(job => job.id === "Implement:saved-task"), false,
    "A dismissed implementation should stay out of server job discovery.");

  for (const kind of kinds) {
    const route = kind === "update" ? "patch-update" : kind;
    const response = await fetch(new URL(`/api/${route}/saved-task?token=test`, info.url));
    assert.equal((await response.json()).dismissed, true,
      `The ${kind} status endpoint should recognize its permanent dismissal.`);
  }
  await fresh.evaluate(async kinds => {
    // Restore stale cards from a browser that was closed before the dismissal.
    globalThis.sessionStorage.setItem("tb-ai-tasks:test", JSON.stringify(kinds.map(kind => ({
      kind, id: "saved-task", state: "waiting", title: `${kind} task`,
    }))));
    await import("/assets/graph-client/ai-task-tray.js");
  }, kinds);
  await fresh.waitForFunction(() => !globalThis.document.querySelector(".ai-task-toast"));
  assert.deepEqual(await fresh.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem("tb-ai-tasks:test"))), [],
    "Server dismissals should remove stale cards from fresh browser storage.");
  assert.equal(implementation.phase, "needs-evidence",
    "Dismissing a card should preserve the underlying task's execution state.");
});
