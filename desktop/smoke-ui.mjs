/* global document */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { _electron } from "playwright";

const commPath = process.argv[2] || process.env.TB_COMM_PATH;
if (!commPath) throw new Error("Pass the Thunderbird comm checkout path.");

const site = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Managed test page</title><p>External page</p>");
});
await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${site.address().port}/`;
const executablePath = process.env.TB_DESKTOP_EXECUTABLE || path.resolve("dist",
  `Thunderbird-Commands-${process.platform}-${process.arch}`,
  process.platform === "darwin" ? "Thunderbird-Commands.app/Contents/MacOS/Thunderbird-Commands"
    : process.platform === "win32" ? "Thunderbird-Commands.exe" : "Thunderbird-Commands");
let electron;
try {
  electron = await _electron.launch({ executablePath, args: [`--comm=${commPath}`],
    env: { ...process.env, TB_DESKTOP_TEST: "1" }, timeout: 120_000 });
  const page = await electron.firstWindow();
  await page.locator(".daily-build-settings").waitFor({ state: "attached", timeout: 30_000 });
  assert.match(await page.title(), /Thunderbird/i);
  assert.equal(await page.locator(".daily-build-times").count(), 1);
  await page.evaluate(url => {
    const link = document.createElement("a");
    link.href = url;
    link.id = "managed-test-link";
    link.target = "_blank";
    link.textContent = "Open managed test page";
    document.body.append(link);
  }, address);
  await page.getByText("Open managed test page").click();
  await page.waitForTimeout(500);
  const first = await electron.evaluate(({ BrowserWindow, webContents }, url) => ({
    windows: BrowserWindow.getAllWindows().length,
    pages: webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(url)).length,
  }), address);
  assert.equal(first.windows, 2);
  assert.equal(first.pages, 1);
  await page.evaluate(url => { document.getElementById("managed-test-link").href = `${url}second`; }, address);
  await page.getByText("Open managed test page").click();
  let second;
  for (let attempt = 0; attempt < 50; attempt++) {
    second = await electron.evaluate(({ BrowserWindow, webContents }, url) => ({
      windows: BrowserWindow.getAllWindows().length,
      pages: webContents.getAllWebContents().filter(contents => contents.getURL() === `${url}second`).length,
      urls: webContents.getAllWebContents().map(contents => contents.getURL()),
    }), address);
    if (second.pages === 1) break;
    await page.waitForTimeout(100);
  }
  assert.equal(second.windows, 2);
  assert.equal(second.pages, 1, JSON.stringify(second.urls));
  await electron.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.getTitle().startsWith("Managed test page —"))?.close();
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1) break;
    await page.waitForTimeout(100);
  }
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.getByText("Open managed test page").click();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 2) break;
    await page.waitForTimeout(100);
  }
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  const consoleAddress = page.url();
  await page.close();
  assert.equal(await electron.evaluate(({ app }) => app.isReady()), true);
  assert.equal((await fetch(consoleAddress)).ok, true);
  process.stdout.write("Desktop UI, page reuse, and tray persistence passed.\n");
} finally {
  await electron?.close();
  await new Promise(resolve => site.close(resolve));
}
