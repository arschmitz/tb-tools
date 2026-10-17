import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";
/* global document */

async function fixture(t, { modelsFail = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "service-keys-settings-"));
  const file = path.join(directory, "config.json");
  let server, browser;
  t.after(async () => {
    await browser?.close();
    server?.server.closeAllConnections();
    if (server) await new Promise(resolve => server.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(file, JSON.stringify({ lando: { repo: "keep" }, phabricator: { user: "old-user", token: "old-fake-token" },
    bugzilla: { apiKey: "old-fake-bugzilla-key" } }));
  server = await startInteractiveGraphServer({ graphs: [], token: "test", tryMonitor: null, implementationManager: null,
    serviceCredentialsPath: file, aiSettingsPath: path.join(directory, "ai.json"), appConfig: {},
    patchSessionDirectory: path.join(directory, "sessions"),
    getAiModels: async () => { if (modelsFail) throw new Error("Models unavailable in test"); return []; },
    html: buildGraphHtml({ graphs: [], interactive: { enabled: true, aiEnabled: true, token: "test" },
      scriptSrcs: [], stylesheetHref: "/assets/graph-client/style.css" }),
  });
  return { file, server, async page() {
    browser = await chromium.launch({ headless: true });
    return browser.newPage({ viewport: { width: 1000, height: 950 } });
  } };
}

test("service credential API authenticates writes and returns only saved-state information", async t => {
  const { file, server } = await fixture(t);
  const endpoint = new URL("/api/service-credentials", server.url);
  const before = await readFile(file, "utf8");
  const unauthorized = await fetch(endpoint);
  assert.equal(unauthorized.status, 403, "Reading service settings should require the console token.");
  const denied = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong", credentials: { bugzillaKey: "do-not-save" } }) });
  assert.equal(denied.status, 403, "Saving service settings should require the console token.");
  assert.equal(await readFile(file, "utf8"), before, "An unauthorized write should preserve existing settings.");
  endpoint.searchParams.set("token", "test");
  const response = await fetch(endpoint);
  const status = await response.json();
  assert.deepEqual(status.credentials, { phabricatorUser: "old-user", hasPhabricatorToken: true, hasBugzillaKey: true },
    "Settings should expose the username and saved-state flags without saved keys.");
  assert.equal(JSON.stringify(status).includes("old-fake"), false, "The response should not expose saved credential values.");
  const saved = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test", credentials: { phabricatorUser: "new-user", phabricatorToken: "new-fake-token", bugzillaKey: "" } }) });
  const result = await saved.json();
  assert.equal(result.restartRequired, true, "Saving service credentials should tell callers that a restart is required.");
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.phabricator.token, "new-fake-token", "An authenticated write should save the new token.");
  assert.equal(config.bugzilla.apiKey, "old-fake-bugzilla-key", "A blank key field should preserve the saved key.");
  assert.equal(config.lando.repo, "keep", "Saving credentials should preserve unrelated settings.");
  assert.equal(JSON.stringify(result).includes("fake-token"), false, "Saving should not return the new token to the browser.");
});

test("Settings can save service keys when AI models fail and clears inputs on close", async t => {
  const { file, server, page: createPage } = await fixture(t, { modelsFail: true });
  const page = await createPage();
  page.setDefaultTimeout(8000);
  await page.goto(server.url);
  const open = () => page.evaluate(async () => (await import("/assets/graph-client/settings.js")).openConsoleSettings());
  await open();
  await page.waitForFunction(() => !document.querySelector(".service-credentials-save").disabled);
  const section = page.locator(".service-credentials-settings");
  assert.equal(await section.getByLabel("Phabricator username", { exact: true }).inputValue(), "old-user",
    "Settings should load the saved Phabricator username.");
  assert.equal(await section.getByLabel("Phabricator API token", { exact: true }).inputValue(), "",
    "Settings should keep saved API tokens out of the input.");
  assert.equal(await page.locator(".console-settings-save").isDisabled(), true,
    "The AI save button should remain disabled when model loading fails.");
  await section.getByLabel("Bugzilla API key", { exact: true }).fill("new-browser-fake-key");
  await section.getByRole("button", { name: "Save service keys" }).click();
  await section.getByText("Saved. Restart the app or console to use changed credentials.", { exact: true }).waitFor();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.bugzilla.apiKey, "new-browser-fake-key", "Service settings should save independently of AI model availability.");
  assert.equal(saved.phabricator.token, "old-fake-token", "Saving a Bugzilla key should preserve a blank Phabricator token.");
  assert.equal(await section.getByLabel("Bugzilla API key", { exact: true }).inputValue(), "", "Saving should clear the entered key.");
  await section.getByLabel("Phabricator API token", { exact: true }).fill("unsaved-fake-token");
  await page.locator(".console-settings-close").click();
  await open();
  await page.waitForFunction(() => !document.querySelector(".service-credentials-save").disabled);
  assert.equal(await section.getByLabel("Phabricator API token", { exact: true }).inputValue(), "",
    "Closing Settings should discard unsaved credentials.");
  assert.equal(await section.locator("#service-bugzilla-saved").textContent(), "An API key is saved. Leave the field blank to keep it.",
    "Reopening Settings should report saved keys without revealing them.");
  if (process.env.TB_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.TB_SETTINGS_SCREENSHOT });
});
