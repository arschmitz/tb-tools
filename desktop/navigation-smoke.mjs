import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import electronExecutable from "electron";

const directory = await mkdtemp(path.join(os.tmpdir(), "tb-navigation-"));
const site = createServer((request, response) => response.end(request.url === "/second"
  ? "<title>Second page</title><p>Second page</p>"
  : '<title>Browser test</title><a href="/second">Next</a>'));
await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
let electron;
try {
  electron = await _electron.launch({ executablePath: process.env.TB_DESKTOP_EXECUTABLE || electronExecutable,
    args: [...(process.env.TB_DESKTOP_EXECUTABLE ? [] : ["."]), `--comm=${process.argv[2]}`],
    env: { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: directory }, timeout: 120000 });
  let page;
  for (let attempt = 0; attempt < 200; attempt++) {
    page = electron.context().pages().find(item => item.url().startsWith("http://127.0.0.1:"));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page);
  await page.locator(".desktop-browser-tabs").waitFor({ state: "attached" });
  assert.equal(await page.getByRole("tab", { name: "Console", exact: true }).count(), 0);
  assert.equal(await page.locator(".console-navigation .background-jobs-open").count(), 0);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Background jobs", exact: true }).click();
  await page.locator(".background-jobs-dialog[open]").waitFor();
  await page.locator(".jobs-close").click();
  const url = `http://127.0.0.1:${site.address().port}/`;
  await page.evaluate(url => globalThis.window.open(url), url);
  await page.getByRole("tab", { name: "Browser test", exact: true }).waitFor();
  assert.equal(await page.locator(".console-navigation .desktop-browser-tab").count(), 1);
  const bounds = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map(view => view.getBounds()));
  assert.equal(bounds.length, 2);
  assert.ok(bounds[1].y > 0);
  assert.equal(bounds[0].y, 0);
  const externalPage = electron.context().pages().find(item => item.url() === url);
  assert.ok(externalPage);
  await externalPage.getByRole("link", { name: "Next" }).click();
  await page.getByRole("tab", { name: "Second page", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("tab", { name: "Browser test", exact: true }).waitFor();
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await page.getByRole("tab", { name: "Second page", exact: true }).waitFor();
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Background jobs", exact: true }).click();
  await page.locator(".background-jobs-dialog[open]").waitFor();
  await page.locator(".jobs-close").click();
  await page.getByRole("button", { name: "Tree", exact: true }).click();
  await page.waitForFunction(() => !globalThis.document.body.classList.contains("desktop-browser-active"));
  assert.equal((await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length)), 1);
  await page.getByRole("tab", { name: "Second page", exact: true }).click();
  await page.getByRole("button", { name: "Close Second page", exact: true }).click();
  await page.waitForFunction(() => !globalThis.document.body.classList.contains("desktop-browser-active"));
  assert.equal(await page.locator(".desktop-browser-tab").count(), 0);
  console.log("Desktop navigation passed: shared tabs, page switching, close, and jobs menu.");
} finally {
  await electron?.close();
  await new Promise(resolve => site.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
