import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
import config from "../lib/config.mjs";
import { clearBugzillaBugCache, createBug, getBugsByIds, updateBug } from "../lib/bugzilla.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

// Use the real Bugzilla cache and sprint APIs with a local HTTP transport stub.
test("creating a sprint refreshes its parent and rolls open stories into it", async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = config.bugzilla;
  config.bugzilla = { apiKey: "test-key" };
  clearBugzillaBugCache();
  t.after(() => { globalThis.fetch = originalFetch; config.bugzilla = originalConfig; clearBugzillaBugCache(); });
  const bugs = new Map([
    ["1", { id: 1, summary: "Board", keywords: ["meta"], product: "Thunderbird", component: "General", depends_on: [2, 3] }],
    ["2", { id: 2, summary: "[SPRINT] - Old", keywords: ["meta"], whiteboard: "[tb-desktop-sprint]", depends_on: [3], is_open: true }],
    ["3", { id: 3, summary: "Open story", keywords: [], status: "NEW", is_open: true, depends_on: [], blocks: [1, 2] }],
  ]);
  let creations = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname !== "bugzilla.mozilla.org") return originalFetch(url, options);
    if (options.method === "POST") {
      creations++;
      const fields = JSON.parse(options.body);
      bugs.set("4", { ...fields, id: 4, is_open: true, depends_on: [] });
      bugs.get("1").depends_on.push(4);
      return Response.json({ id: 4 });
    }
    if (options.method === "PUT") {
      const id = parsed.pathname.split("/").pop();
      const fields = JSON.parse(options.body);
      const bug = bugs.get(id);
      if (fields.depends_on) {
        const ids = new Set(bug.depends_on.map(String));
        for (const added of fields.depends_on.add || []) ids.add(added);
        for (const removed of fields.depends_on.remove || []) ids.delete(removed);
        bug.depends_on = [...ids];
      }
      if (fields.status) { bug.status = fields.status; bug.is_open = false; }
      return Response.json({ bugs: [{ id }] });
    }
    return Response.json({ bugs: parsed.searchParams.getAll("ids").map(id => bugs.get(id)).filter(Boolean) });
  };
  const server = await startInteractiveGraphServer({
    graphs: [], html: buildGraphHtml({ graphs: [], interactive: { enabled: true, token: "secret" }, scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }), token: "secret",
    readMetaBoardStore: async () => ({ boards: [{ id: "1", metaBugId: "1" }] }),
    assignMetaBoardColors: async () => ({}),
    getBugsWithAttachmentsByIds: async () => [],
    getBugHistoryByIds: async () => [],
  });
  t.after(() => { server.server.closeAllConnections(); return new Promise(resolve => server.server.close(resolve)); });
  const endpoint = new URL("api/meta-boards/1/sprints", server.url);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  await page.goto(server.url);
  await page.evaluate(async () => {
    const { initializeSprints, openSprintCreateDialog } = await import("/assets/graph-client/sprints.js");
    initializeSprints();
    openSprintCreateDialog("1");
  });
  await page.locator(".sprint-create-name").fill("Next");
  await page.locator(".sprint-create-deadline").fill("2026-10-09");
  const createResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/sprints") && response.request().method() === "POST");
  await page.locator(".sprint-create-submit").click();
  const response = await createResponse;
  const created = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(created));
  assert.equal(created.sprint.id, "4");
  assert.equal(created.previousSprint.id, "2");
  const listed = await (await fetch(`${endpoint}?token=secret&force=1`)).json();
  assert.deepEqual(listed.sprints.map(sprint => sprint.id), ["2", "4"]);
  await page.locator("#sprint-rollover-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator(".sprint-rollover-summary").textContent(), /1 open board stories/);
  const rolloverResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/rollover"));
  await page.locator(".sprint-rollover-submit").click();
  const moved = await rolloverResponse;
  const result = await moved.json();
  assert.equal(moved.status(), 200, JSON.stringify(result));
  assert.deepEqual(result.sprint.cards.map(card => card.id), ["3"]);
  assert.deepEqual(bugs.get("2").depends_on, []);
  assert.equal(bugs.get("2").is_open, false);
  await page.locator("#sprint-rollover-dialog").waitFor({ state: "hidden" });
  await page.locator(".sprint-panel").waitFor({ state: "visible" });
  assert.match(await page.locator('.sprint-column[data-sprint-column="sprint"]').textContent(), /Open story/);
  assert.equal(creations, 1);
});

test("relationship writes invalidate linked bugs and ignore reads started before creation", async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = config.bugzilla;
  config.bugzilla = { apiKey: "test-key" };
  clearBugzillaBugCache();
  t.after(() => { globalThis.fetch = originalFetch; config.bugzilla = originalConfig; clearBugzillaBugCache(); });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reads = 0;
  let dependencies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "POST") { dependencies = [2]; return Response.json({ id: 2 }); }
    if (options.method === "PUT") { dependencies = []; return Response.json({ bugs: [{ id: 2 }] }); }
    reads++;
    const before = [...dependencies];
    if (reads === 1) await gate;
    return Response.json({ bugs: [{ id: 1, depends_on: before }] });
  };
  const pending = getBugsByIds([1], { includeFields: "id,depends_on" });
  const joined = getBugsByIds([1], { includeFields: "id,depends_on" });
  await createBug({ blocks: [1] });
  release();
  assert.deepEqual((await pending)[0].depends_on, [2]);
  assert.deepEqual((await joined)[0].depends_on, [2]);
  await updateBug(2, { blocks: { remove: [1] } });
  assert.deepEqual((await getBugsByIds([1], { includeFields: "id,depends_on" }))[0].depends_on, []);
});
