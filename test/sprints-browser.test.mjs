import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

test("sprint tabs show exactly one view at a time", async (t) => {
  const graph = {
    branch: "main",
    commitCount: 0,
    commits: [],
    diffs: {},
    label: "comm",
    path: "/repo/comm",
    repository: "comm",
  };
  const html = buildGraphHtml({
    graphs: [graph],
    interactive: {
      enabled: true,
      pollIntervalMs: 20,
      token: "secret",
    },
    scriptSrcs: ["/assets/graph-client/init.js"],
    stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    tryMonitor: null,
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs: [graph],
    html,
    token: "secret",
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { height: 900, width: 1400 } });

  await page.emulateMedia({ colorScheme: "dark" });

  t.after(async () => {
    await browser.close();
    if (serverInfo.server.listening) {
      await new Promise((resolve) => serverInfo.server.close(resolve));
    }
  });

  await page.goto(serverInfo.url, { waitUntil: "domcontentloaded" });
  assert.equal(
    await page.locator("body > header").evaluate((header) => (
      globalThis.getComputedStyle(header).backgroundColor
    )),
    "rgb(25, 29, 35)",
  );
  await page.evaluate(() => {
    globalThis.document.querySelector(".sprint-panel").hidden = false;
  });

  const overview = page.locator(".sprint-overview");
  const planning = page.locator(".sprint-planning");
  const planningColumns = page.locator(".sprint-planning-columns .sprint-column");

  await overview.waitFor({ state: "visible" });
  await planning.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Planning", exact: true }).click();
  await planning.waitFor({ state: "visible" });
  await overview.waitFor({ state: "hidden" });
  assert.equal(await planning.evaluate((element) => element.hidden), false);
  assert.equal(await overview.evaluate((element) => element.hidden), true);
  assert.deepEqual(
    await planningColumns.evaluateAll((columns) => columns.map((column) => column.dataset.sprintColumn)),
    ["backlog", "ready", "assigned", "sprint"],
  );
  assert.equal(
    await planningColumns.first().locator(":scope > header").evaluate((header) => (
      globalThis.getComputedStyle(header).position
    )),
    "static",
  );

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await overview.waitFor({ state: "visible" });
  await planning.waitFor({ state: "hidden" });
  assert.equal(await overview.evaluate((element) => element.hidden), false);
  assert.equal(await planning.evaluate((element) => element.hidden), true);

  const sprintPanel = page.locator(".sprint-panel");

  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  assert.equal(await sprintPanel.evaluate((element) => element.hidden), true);

  await page.evaluate(() => {
    globalThis.document.querySelector(".sprint-panel").hidden = false;
  });
  await page.getByRole("button", { name: "Meta Boards", exact: true }).click();
  assert.equal(await sprintPanel.evaluate((element) => element.hidden), true);

  await page.evaluate(() => {
    const testTab = globalThis.document.querySelector(".test-output-tab");

    globalThis.document.querySelector(".sprint-panel").hidden = false;
    testTab.hidden = false;
    testTab.click();
  });
  assert.equal(await sprintPanel.evaluate((element) => element.hidden), true);
});

test("sprint overview shows status lanes for members and planning keeps membership controls", async (t) => {
  const graph = {
    branch: "main",
    commitCount: 0,
    commits: [],
    diffs: {},
    label: "comm",
    path: "/repo/comm",
    repository: "comm",
  };
  const initialMembers = ["100001", "100004", "100005", "100006", "100007"];
  let memberIds = [...initialMembers];
  const updates = [];
  const getBoard = () => ({
    assignees: [],
    cards: [
      ...["assigned", "in-progress", "in-review", "complete"].map((column, index) => ({
        column,
        id: String(100004 + index),
        parentMeta: { id: "900100", summary: "Stories" },
        points: 2,
        assignee: { email: "person@example.com", name: "Sprint owner" },
        summary: `${column} sprint story`,
        url: `https://bugzilla.mozilla.org/show_bug.cgi?id=${100004 + index}`,
      })),
      {
        column: "ready",
        id: "100001",
        parentMeta: { id: "900100", summary: "Stories" },
        points: 3,
        summary: "Current sprint story",
        url: "https://bugzilla.mozilla.org/show_bug.cgi?id=100001",
      },
      {
        column: "ready",
        id: "100002",
        parentMeta: { id: "900100", summary: "Stories" },
        points: 2,
        summary: "Ready story",
        url: "https://bugzilla.mozilla.org/show_bug.cgi?id=100002",
      },
      {
        column: "backlog",
        id: "100003",
        parentMeta: { id: "900100", summary: "Stories" },
        points: 1,
        summary: "Backlog story",
        url: "https://bugzilla.mozilla.org/show_bug.cgi?id=100003",
      },
    ],
    childMetas: [{ id: "900100", summary: "Stories" }],
    id: "900000",
    metaBug: { id: "900000", summary: "Desktop work" },
    sprints: [{
      createdAt: "2026-09-01T12:00:00Z",
      deadline: "2026-09-18",
      dependsOn: memberIds,
      id: "900200",
      isOpen: true,
      name: "September",
      summary: "[SPRINT] - September",
      url: "https://bugzilla.mozilla.org/show_bug.cgi?id=900200",
    }],
  });
  const html = buildGraphHtml({
    graphs: [graph],
    interactive: {
      enabled: true,
      pollIntervalMs: 20,
      token: "secret",
    },
    scriptSrcs: ["/assets/graph-client/init.js"],
    stylesheetHref: "/assets/graph-client/style.css",
  });
  const serverInfo = await startInteractiveGraphServer({
    tryMonitor: null,
    assignMetaBoardColors: async () => ({}),
    getBugHistoryByIds: async () => [],
    getMetaBoardData: async () => getBoard(),
    getRustUpstreamStatus: async () => ({
      message: "Rust dependencies match Firefox remote main.",
      state: "current",
    }),
    graphs: [graph],
    html,
    readMetaBoardStore: async () => ({
      boards: [{ id: "900000", metaBugId: "900000" }],
    }),
    token: "secret",
    updateBug: async (id, changes) => {
      updates.push({ changes, id });
      memberIds = changes.depends_on.set;
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { height: 900, width: 1400 } });

  t.after(async () => {
    await browser.close();
    if (serverInfo.server.listening) {
      await new Promise((resolve) => serverInfo.server.close(resolve));
    }
  });

  await page.goto(`${serverInfo.url}#sprints/900000/900200/overview`, {
    waitUntil: "domcontentloaded",
  });

  const chart = page.locator(".sprint-burndown");
  await chart.locator("svg").waitFor();
  assert.match(await chart.innerText(), /Points remaining/);
  assert.ok(await chart.locator("text").count() >= 7);
  assert.match(await page.locator(".sprint-burndown-legend").first().innerText(), /Actual remaining/);
  assert.match(await page.locator(".sprint-burndown-legend").first().innerText(), /Ideal plan/);
  assert.match(await chart.getAttribute("aria-label"), /9 points remaining/);
  const storyChart = page.locator(".sprint-story-burndown");
  assert.match(await storyChart.innerText(), /Stories remaining/);
  assert.match(await storyChart.getAttribute("aria-label"), /4 stories remaining/);
  assert.match(await storyChart.getAttribute("aria-label"), /2 stories not started/);
  assert.match(await chart.getAttribute("aria-label"), /5 points not started/);
  assert.equal(await page.locator(".sprint-burndown-progress-marker").count(), 2);
  const overviewBoard = page.locator(".sprint-overview-board");
  await overviewBoard.getByRole("button", { name: "Current sprint story", exact: true }).waitFor();
  assert.deepEqual(await overviewBoard.locator("[data-sprint-status]").evaluateAll(
    columns => columns.map(column => column.dataset.sprintStatus),
  ), ["ready", "assigned", "in-progress", "in-review", "complete"]);
  assert.equal(await overviewBoard.locator(".sprint-story-row").count(), 5);
  assert.equal(await page.locator(".sprint-people-section, .sprint-overview-story-groups").count(), 0);
  assert.doesNotMatch(await overviewBoard.innerText(), /Backlog story|Ready story/);
  for (const column of ["ready", "assigned", "in-progress", "in-review", "complete"]) {
    const lane = overviewBoard.locator(`[data-sprint-status="${column}"]`);
    assert.equal(await lane.locator(".sprint-story-row").count(), 1);
    assert.equal(await lane.locator(".meta-board-column-count").innerText(), "1");
    assert.equal(await lane.locator(".meta-board-column-points").innerText(), column === "ready" ? "3 points" : "2 points");
  }
  const overviewAssignee = page.locator(".sprint-overview-assignee-filter");
  await overviewAssignee.selectOption("person@example.com");
  assert.equal(await overviewBoard.locator(".sprint-story-row").count(), 4);
  assert.equal(await page.locator(".sprint-overview-story-points").innerText(), "8 points");
  assert.equal(await overviewBoard.locator('[data-sprint-status="ready"] .meta-board-column-count').innerText(), "0");
  assert.match(await chart.getAttribute("aria-label"), /9 points remaining/);
  await overviewAssignee.selectOption("unassigned");
  assert.equal(await overviewBoard.locator(".sprint-story-row").count(), 1);
  assert.equal(await page.locator(".sprint-overview-story-points").innerText(), "3 points");
  await overviewAssignee.selectOption("");
  assert.equal(await overviewBoard.locator(".sprint-story-row").count(), 5);
  assert.equal(await page.locator(".sprint-overview-story-points").innerText(), "11 points");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `/tmp/tb-sprint-overview-${colorScheme}.png`, fullPage: true });
  }
  const wideStoryChart = await storyChart.locator("svg").getAttribute("viewBox");
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForFunction(previous => globalThis.document.querySelector(".sprint-story-burndown svg")?.getAttribute("viewBox") !== previous, wideStoryChart);
  assert.equal(await overviewBoard.evaluate(element => element.scrollWidth > element.clientWidth), true);
  await page.setViewportSize({ width: 1400, height: 900 });
  await overviewBoard.getByRole("button", { name: "Remove from Sprint: Bug 100001" }).click();
  await overviewBoard.getByRole("button", { name: "Current sprint story", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await overviewBoard.locator('[data-sprint-status="ready"] .meta-board-column-count').innerText(), "0");
  await page.getByRole("button", { name: "Planning", exact: true }).click();
  await page.locator(".sprint-planning").getByRole("button", { name: "Add to Sprint: Bug 100001" }).click();
  await page.locator(".sprint-planning").getByRole("button", { name: "Remove from Sprint: Bug 100001" }).waitFor();
  const restoredMembers = [...memberIds];

  const readyStory = page.locator(
    '.sprint-column[data-sprint-column="ready"] .sprint-story-row',
  ).filter({ hasText: "Ready story" });
  const sprintStories = page.locator(
    '.sprint-column[data-sprint-column="sprint"] .sprint-story-row',
  );
  const backlogPoints = page.locator(
    '.sprint-column[data-sprint-column="backlog"] > header span',
  );

  await readyStory.getByRole("button", { name: "Add to Sprint: Bug 100002" }).waitFor();
  assert.equal(await backlogPoints.evaluate((element) => element.hidden), true);
  assert.equal(
    await sprintStories.filter({ hasText: "Current sprint story" })
      .getByRole("button", { name: "Remove from Sprint: Bug 100001" }).count(),
    1,
  );

  await readyStory.getByRole("button", { name: "Add to Sprint: Bug 100002" }).click();
  await sprintStories.filter({ hasText: "Ready story" })
    .getByRole("button", { name: "Remove from Sprint: Bug 100002" }).waitFor();
  assert.deepEqual(updates.at(-1), {
    changes: { depends_on: { set: [...restoredMembers, "100002"] } },
    id: "900200",
  });

  await sprintStories.filter({ hasText: "Ready story" })
    .getByRole("button", { name: "Remove from Sprint: Bug 100002" }).click();
  await readyStory.getByRole("button", { name: "Add to Sprint: Bug 100002" }).waitFor();
  assert.deepEqual(updates.at(-1), {
    changes: { depends_on: { set: restoredMembers } },
    id: "900200",
  });
});
