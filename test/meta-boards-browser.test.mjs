import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("bug saves immediately update board points, assignees, and columns", { timeout: 15000 }, async (t) => {
  const graph = {
    branch: "main", commitCount: 0, commits: [], diffs: {},
    label: "comm", path: "/repo/comm", repository: "comm",
  };
  const card = {
    id: "100001", summary: "Test story", points: null, assignee: null,
    column: "backlog", parentMeta: { id: "900100", summary: "Stories" },
    url: "https://bugzilla.mozilla.org/show_bug.cgi?id=100001",
  };
  const board = {
    id: "900000", metaBug: { id: "900000", summary: "Work" },
    cards: [card], assignees: [], childMetas: [card.parentMeta], sprints: [],
    columns: { backlog: [card], ready: [], assigned: [], "in-progress": [], "in-review": [], complete: [] },
  };
  let detail = { ...card, description: "", dependsOn: [], blocks: [], comments: [] };
  const html = buildGraphHtml({
    graphs: [graph], interactive: { enabled: true, pollIntervalMs: 20, token: "secret" },
    scriptSrcs: ["/assets/graph-client/init.js"], stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    graphs: [graph], html, token: "secret",
    getRustUpstreamStatus: async () => ({ state: "current", message: "Current" }),
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => serverInfo.server.close(resolve));
  });
  const page = await browser.newPage();
  let boardLoads = 0;
  let releaseSave;
  let saveResponse;
  await page.route("**/api/meta-boards**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/bugs/100001")) {
      if (route.request().method() === "PUT") {
        await new Promise((resolve) => { releaseSave = resolve; });
        await route.fulfill(saveResponse);
      } else {
        await route.fulfill({ json: { ok: true, ...detail } });
      }
    } else if (path === "/api/meta-boards/900000") {
      boardLoads++;
      await route.fulfill({ json: { ok: true, ...board } });
    } else {
      await route.fulfill({ json: { ok: true, boards: [{ id: "900000", metaBugId: "900000" }] } });
    }
  });
  await page.goto(`${serverInfo.url}#meta-boards/900000`);
  await page.locator(".meta-board-card").click();
  const points = page.locator(".meta-board-detail-points");
  const assignee = page.locator(".meta-board-detail-assignee");
  const save = page.locator(".meta-board-detail-save");
  const column = (name) => page.locator(`[data-meta-board-column="${name}"]`);
  const startSave = async (expectedColumn, expectedPoints, expectedAssignees = []) => {
    releaseSave = null;
    await save.click();
    await page.waitForFunction(() => globalThis.document.querySelector(".meta-board-card-pending"));
    assert.equal(await column(expectedColumn).locator(".meta-board-card").count(), 1);
    assert.match(await column(expectedColumn).locator(".meta-board-card-meta").innerText(), expectedPoints);
    assert.deepEqual(await column(expectedColumn).locator(".meta-board-assignee").allTextContents(), expectedAssignees);
  };
  const finishSave = async (response) => {
    saveResponse = response;
    // Wait for the request handler, without allowing the response to arrive early.
    while (!releaseSave) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseSave();
    await page.waitForFunction(() => !globalThis.document.querySelector(".meta-board-detail-save").disabled);
    assert.equal(await page.locator(".meta-board-card-pending").count(), 0);
  };

  await points.fill("3");
  await startSave("ready", /3 points/);
  assert.equal(await column("ready").locator(".meta-board-column-points").innerText(), "3 points");
  detail = { ...detail, points: 3 };
  await finishSave({ json: { ok: true, ...detail } });

  await assignee.fill("person@example.com");
  await startSave("assigned", /3 points/, ["person@example.com"]);
  detail = { ...detail, assignee: { email: "person@example.com", name: "Test Person" } };
  await finishSave({ json: { ok: true, ...detail } });
  assert.equal(await column("assigned").locator(".meta-board-assignee").innerText(), "Test Person");
  assert.equal(await page.locator('.meta-board-assignee-filter option[value="person@example.com"]').innerText(), "Test Person");

  await points.fill("4");
  await startSave("assigned", /4 points/, ["Test Person"]);
  assert.equal(await column("assigned").locator(".meta-board-column-points").innerText(), "4 points");
  detail = { ...detail, points: 4 };
  await finishSave({ json: { ok: true, ...detail } });

  await points.fill("5");
  await assignee.fill("");
  await startSave("ready", /5 points/);
  await finishSave({ status: 500, json: { error: "Save failed" } });
  assert.equal(await column("assigned").locator(".meta-board-assignee").innerText(), "Test Person");
  assert.equal(await column("assigned").locator(".meta-board-column-points").innerText(), "4 points");
  assert.match(await page.locator(".meta-board-detail-error").innerText(), /Save failed/);

  await points.fill("");
  await startSave("backlog", /No points/);
  detail = { ...detail, points: null, assignee: null };
  await finishSave({ json: { ok: true, ...detail } });
  assert.equal(await column("backlog").locator(".meta-board-card").count(), 1);
  assert.equal(boardLoads, 1, "Edits must not need a board refresh");
});
