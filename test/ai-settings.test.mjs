import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { AI_TASK_TYPES, DEFAULT_AI_PROFILES, readAiProfiles, saveAiProfiles, selectAiModel } from "../commands/graph/ai-models.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

const models = [
  { id: "gpt-6-sol", supportedReasoningEfforts: ["medium", "high"].map(reasoningEffort => ({ reasoningEffort })) },
  { id: "gpt-6-astra", supportedReasoningEfforts: ["low", "high"].map(reasoningEffort => ({ reasoningEffort })) },
  { id: "hidden-model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
];

test("AI settings persist per task and reject unavailable models or unsupported reasoning", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  assert.deepEqual(readAiProfiles(file), DEFAULT_AI_PROFILES);
  const profiles = { ...DEFAULT_AI_PROFILES, review: { model: "gpt-6-astra", effort: "low" } };
  saveAiProfiles(profiles, models, file);
  assert.deepEqual(readAiProfiles(file), profiles);
  assert.deepEqual(selectAiModel(models, "review", readAiProfiles(file)), profiles.review);
  for (const review of [{ model: "missing", effort: "high" }, { model: "hidden-model", effort: "high" },
    { model: "gpt-6-sol", effort: "max" }]) {
    assert.throws(() => saveAiProfiles({ ...profiles, review }, models, file), /supported reasoning/);
    assert.deepEqual(readAiProfiles(file), profiles);
    assert.throws(() => selectAiModel(models, "review", { ...profiles, review }), /Settings/);
  }
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))), AI_TASK_TYPES.map(task => task.id));
});

test("Settings saves model and reasoning independently and restores them after server restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-settings-browser-"));
  const file = path.join(directory, "settings.json");
  const start = () => startInteractiveGraphServer({ graphs: [], token: "test", tryMonitor: null,
    aiSettingsPath: file, getAiModels: async () => models,
    html: buildGraphHtml({ graphs: [], interactive: { enabled: true, aiEnabled: true, token: "test" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  let server = await start();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.server.closeAllConnections();
    await new Promise(resolve => server.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
  page.setDefaultTimeout(5000);
  const open = () => page.evaluate(async () => (await import("/assets/graph-client/settings.js")).openConsoleSettings());
  await page.goto(server.url);
  await open();
  const rows = page.locator(".console-settings-rows fieldset");
  assert.equal(await rows.count(), 6);
  const review = page.locator('[data-task-type="review"]');
  await review.getByLabel("Model", { exact: true }).selectOption("gpt-6-astra");
  assert.deepEqual(await review.getByLabel("Reasoning").locator("option").allTextContents(), ["low", "high"]);
  await review.getByLabel("Reasoning").selectOption("low");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved. These choices apply to the next AI turn.").waitFor();
  assert.deepEqual(readAiProfiles(file).review, { model: "gpt-6-astra", effort: "low" });
  assert.deepEqual(readAiProfiles(file).repair, DEFAULT_AI_PROFILES.repair);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const contrasts = await page.locator(".console-settings-dialog").evaluate(dialog => {
      const luminance = color => {
        const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      return [dialog, dialog.querySelector("select")].map(node => {
        const style = globalThis.getComputedStyle(node);
        const foreground = luminance(style.color), background = luminance(style.backgroundColor);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
    });
    assert.ok(contrasts.every(ratio => ratio >= 4.5), `${colorScheme}: ${contrasts}`);
    await page.screenshot({ path: `/tmp/console-ai-settings-${colorScheme}.png` });
  }
  const bad = await fetch(new URL("/api/ai-settings", server.url), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "wrong", profiles: DEFAULT_AI_PROFILES }) });
  assert.equal(bad.status, 403);
  server.server.closeAllConnections();
  await new Promise(resolve => server.server.close(resolve));
  server = await start();
  await page.goto(server.url);
  await open();
  assert.equal(await review.getByLabel("Model", { exact: true }).inputValue(), "gpt-6-astra");
  assert.equal(await review.getByLabel("Reasoning").inputValue(), "low");
  assert.equal(await page.locator('[data-task-type="edit"]').getByLabel("Model", { exact: true }).inputValue(), "gpt-6-sol");
});
