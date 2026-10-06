/* global document */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const commPath = process.argv[2] || process.env.TB_COMM_PATH;
if (!commPath) throw new Error("Pass the Thunderbird comm checkout path.");

const site = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(request.url === "/second"
    ? "<!doctype html><title>Second page</title><p>Second page</p>"
    : "<!doctype html><title>Managed test page</title><a id='next' href='/second'>Next page</a>");
});
const otherSite = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Other service</title><p>Other service</p>");
});
await Promise.all([
  new Promise(resolve => site.listen(0, "127.0.0.1", resolve)),
  new Promise(resolve => otherSite.listen(0, "127.0.0.1", resolve)),
]);
const address = `http://127.0.0.1:${site.address().port}/`;
const otherAddress = `http://127.0.0.1:${otherSite.address().port}/`;
const executablePath = process.env.TB_DESKTOP_EXECUTABLE || path.resolve("dist",
  `Thunderbird-Commands-${process.platform}-${process.arch}`,
  process.platform === "darwin" ? "Thunderbird-Commands.app/Contents/MacOS/Thunderbird-Commands"
    : process.platform === "win32" ? "Thunderbird-Commands.exe" : "Thunderbird-Commands");
const testUserData = await fs.mkdtemp(path.join(os.tmpdir(), "tb-desktop-smoke-"));
let electron;
try {
  electron = await _electron.launch({ executablePath, args: [`--comm=${commPath}`],
    env: { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: testUserData },
    timeout: 120_000 });
  const shell = await electron.firstWindow();
  await shell.locator(".browser-header").waitFor({ state: "attached", timeout: 30_000 });
  assert.match(await shell.title(), /Thunderbird/i);
  await shell.getByRole("tab", { name: "Console" }).waitFor();
  let consoleAddress;
  for (let attempt = 0; attempt < 100; attempt++) {
    consoleAddress = await electron.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find(contents =>
        contents.getTitle() === "Thunderbird Desktop Console")?.getURL());
    if (consoleAddress) break;
    await shell.waitForTimeout(100);
  }
  assert.ok(consoleAddress?.startsWith("http://127.0.0.1:"));
  assert.equal((await fetch(consoleAddress)).ok, true);
  const windowControls = await electron.evaluate(({ BrowserWindow, Menu }) => ({
    windows: BrowserWindow.getAllWindows().map(window => ({
      closable: window.isClosable(),
      minimizable: window.isMinimizable(),
      maximizable: window.isMaximizable(),
    })),
    menuRoles: Menu.getApplicationMenu().items.find(item => item.label === "Window")
      ?.submenu.items.map(item => item.role),
  }));
  assert.deepEqual(windowControls.windows, [
    { closable: true, minimizable: true, maximizable: true },
  ]);
  assert.deepEqual(windowControls.menuRoles, ["minimize", "zoom", "togglefullscreen", "close"]);
  for (const name of ["Close window", "Minimize window", "Maximize window"]) {
    assert.equal(await shell.getByRole("button", { name }).isVisible(), true);
  }

  const reloadAndWait = async (url, trigger) => {
    const id = await electron.evaluate(async ({ webContents }, target) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === target);
      if (contents.isLoading()) await new Promise(resolve => contents.once("did-stop-loading", resolve));
      await contents.executeJavaScript("document.body.dataset.desktopSmokeReload = 'before'");
      contents.desktopSmokeReloadFinished = false;
      contents.once("did-finish-load", () => { contents.desktopSmokeReloadFinished = true; });
      return contents.id;
    }, url);
    await trigger();
    let finished = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      finished = await electron.evaluate(({ webContents }, contentsId) =>
        webContents.fromId(contentsId)?.desktopSmokeReloadFinished === true, id);
      if (finished) break;
      await shell.waitForTimeout(100);
    }
    assert.equal(finished, true, `Reload did not finish for ${url}`);
    assert.equal(await electron.evaluate(({ webContents }, contentsId) =>
      webContents.fromId(contentsId).executeJavaScript("document.body.dataset.desktopSmokeReload"), id), undefined);
    assert.equal(await shell.evaluate(() => document.body.dataset.desktopSmokeShell), "keep");
  };
  const reloadFromMenu = async () => {
    const accelerator = await electron.evaluate(({ Menu }) => {
      const reload = Menu.getApplicationMenu().items.find(item => item.label === "Pages")
        .submenu.items.find(item => item.label === "Reload Page");
      reload.click();
      return reload.accelerator;
    });
    assert.equal(accelerator, "CmdOrCtrl+R");
  };
  await shell.evaluate(() => { document.body.dataset.desktopSmokeShell = "keep"; });
  assert.equal(await shell.getByRole("button", { name: "Reload", exact: true }).isEnabled(), true);
  await reloadAndWait(consoleAddress, () => shell.getByRole("button", { name: "Reload", exact: true }).click());
  await reloadAndWait(consoleAddress, reloadFromMenu);
  assert.equal((await fetch(consoleAddress)).ok, true);

  const openFromConsole = url => electron.evaluate(({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find(item =>
      item.getTitle() === "Thunderbird Desktop Console");
    return contents.executeJavaScript(`(() => {
      const link = document.createElement("a");
      link.href = ${JSON.stringify(target)};
      link.target = "_blank";
      document.body.append(link);
      link.click();
      link.remove();
    })()`);
  }, url);
  await openFromConsole(address);
  await shell.getByRole("tab", { name: "Managed test page" }).waitFor();
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal(await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().filter(contents => contents.getURL() === url).length,
  address), 1);
  const serviceContentsId = await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url).id, address);
  assert.equal(await shell.locator("#address").textContent(), address);
  await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url)
      .executeJavaScript("document.body.dataset.desktopSmokeInactive = 'keep'"), consoleAddress);
  await reloadAndWait(address, () => shell.getByRole("button", { name: "Reload", exact: true }).click());
  await reloadAndWait(address, reloadFromMenu);
  assert.equal(await shell.getByRole("tab").count(), 2);
  assert.equal(await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url)
      .executeJavaScript("document.body.dataset.desktopSmokeInactive"), consoleAddress), "keep");
  const linkMenus = await electron.evaluate(({ webContents, Menu }, url) => {
    const original = Menu.buildFromTemplate;
    const labels = [];
    Menu.buildFromTemplate = items => {
      labels.push(items.map(item => item.label));
      return { popup() {} };
    };
    try {
      for (const contents of webContents.getAllWebContents().filter(item =>
        item.getURL() === url || item.getTitle() === "Thunderbird Desktop Console")) {
        contents.emit("context-menu", {}, { linkURL: url });
      }
    } finally { Menu.buildFromTemplate = original; }
    return labels;
  }, address);
  assert.deepEqual(linkMenus, [
    ["Open in New Tab", "Open in Browser", "Copy Link Address"],
    ["Open in New Tab", "Open in Browser", "Copy Link Address"],
  ]);

  await shell.getByRole("tab", { name: "Console" }).click();
  assert.equal(await shell.getByRole("tab", { name: "Console" }).getAttribute("aria-selected"), "true");
  await openFromConsole(address);
  assert.equal(await shell.getByRole("tab").count(), 2);
  assert.equal(await shell.getByRole("tab", { name: "Managed test page" }).getAttribute("aria-selected"), "true");

  await electron.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url);
    return contents.executeJavaScript("document.getElementById('next').click()");
  }, address);
  await shell.waitForFunction(url => document.getElementById("address").textContent === url,
    `${address}second`);
  await shell.waitForFunction(() => !document.getElementById("back").disabled);
  assert.equal(await shell.getByRole("button", { name: "Back" }).isEnabled(), true);
  await shell.getByRole("button", { name: "Back" }).click();
  await shell.waitForFunction(url => document.getElementById("address").textContent === url, address);
  await shell.waitForFunction(() => !document.getElementById("forward").disabled);
  assert.equal(await shell.getByRole("button", { name: "Forward" }).isEnabled(), true);
  await shell.getByRole("button", { name: "Forward" }).click();
  await shell.waitForFunction(url => document.getElementById("address").textContent === url,
    `${address}second`);
  await electron.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === `${url}second`);
    return contents.executeJavaScript(`(() => {
      const link = document.createElement("a");
      link.href = ${JSON.stringify(`${url}third`)};
      link.target = "_blank";
      document.body.append(link);
      link.click();
      link.remove();
    })()`);
  }, address);
  await shell.waitForFunction(url => document.getElementById("address").textContent === url,
    `${address}third`);
  assert.equal(await shell.getByRole("tab").count(), 2);
  assert.equal(await electron.evaluate(({ webContents }, id) =>
    webContents.fromId(id).getURL(), serviceContentsId), `${address}third`);
  await shell.getByRole("button", { name: "Back" }).click();
  await shell.waitForFunction(url => document.getElementById("address").textContent === url,
    `${address}second`);
  await electron.evaluate(({ webContents, Menu }, url) => {
    const contents = webContents.getAllWebContents().find(item =>
      item.getTitle() === "Thunderbird Desktop Console");
    const original = Menu.buildFromTemplate;
    Menu.buildFromTemplate = items => ({ popup() {
      items.find(item => item.label === "Open in New Tab").click();
    } });
    try { contents.emit("context-menu", {}, { linkURL: url }); }
    finally { Menu.buildFromTemplate = original; }
  }, `${address}second`);
  await shell.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')]
    .filter(tab => tab.textContent === "Second page").length === 2);
  assert.equal(await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().filter(item => item.getURL() === url).length,
  `${address}second`), 2);
  await openFromConsole(`${address}third`);
  await shell.waitForFunction(url => document.getElementById("address").textContent === url,
    `${address}third`);
  assert.equal(await shell.getByRole("tab").count(), 3);
  assert.equal(await electron.evaluate(({ webContents }, id) =>
    webContents.fromId(id).getURL(), serviceContentsId), `${address}second`);
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await shell.getByRole("button", { name: "Close tab" }).click();
  await shell.waitForFunction(url => document.getElementById("address").textContent === url,
    `${address}second`);
  await openFromConsole(otherAddress);
  await shell.getByRole("tab", { name: "Other service" }).waitFor();
  assert.equal(await shell.getByRole("tab").count(), 3);
  await shell.getByRole("tab", { name: "Second page" }).click();
  const clickPageLink = (contentsId, url) => electron.evaluate(({ webContents }, target) =>
    webContents.fromId(target.id).executeJavaScript(`(() => {
      const link = document.createElement('a');
      link.href = ${JSON.stringify(target.url)};
      document.body.append(link);
      link.click();
      link.remove();
    })()`), { id: contentsId, url });
  await clickPageLink(serviceContentsId, otherAddress);
  await shell.waitForFunction(url => document.getElementById("address").textContent === url, otherAddress);
  assert.equal(await shell.getByRole("tab").count(), 3);
  assert.equal(await electron.evaluate(({ webContents }, id) =>
    webContents.fromId(id).getURL(), serviceContentsId), `${address}second`);
  const otherContentsId = await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url).id, otherAddress);
  await clickPageLink(otherContentsId, address);
  await shell.waitForFunction(url => document.getElementById("address").textContent === url, address);
  assert.equal(await shell.getByRole("tab").count(), 3);
  assert.equal(await electron.evaluate(({ webContents }, id) =>
    webContents.fromId(id).getURL(), serviceContentsId), address);
  assert.equal(await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().filter(item => item.getURL() === url).length, otherAddress), 1);
  await shell.getByRole("button", { name: "Close tab" }).click();
  await shell.waitForFunction(url => document.getElementById("address").textContent === url, otherAddress);
  await shell.getByRole("button", { name: "Close tab" }).click();
  assert.equal(await shell.getByRole("tab").count(), 1);
  assert.equal(await shell.getByRole("tab", { name: "Console" }).getAttribute("aria-selected"), "true");
  assert.equal(await electron.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(url)).length,
  address), 0);
  await electron.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item =>
      item.getTitle() === "Thunderbird Desktop Console");
    return contents.executeJavaScript(`(() => {
      const link = document.createElement("a");
      link.href = ${JSON.stringify(url)};
      document.body.append(link);
      link.click();
      link.remove();
    })()`);
  }, address);
  await shell.waitForFunction(url => document.getElementById("address").textContent === url, address);
  assert.equal(await shell.getByRole("tab").count(), 2);
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await shell.getByRole("button", { name: "Maximize window" }).click();
  await shell.getByRole("button", { name: "Restore window" }).waitFor();
  assert.equal(await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isMaximized()), true);
  await shell.getByRole("button", { name: "Restore window" }).click();
  await shell.getByRole("button", { name: "Maximize window" }).waitFor();
  assert.equal(await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isMaximized()), false);
  await shell.getByRole("button", { name: "Minimize window" }).click();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized())) break;
    await shell.waitForTimeout(100);
  }
  assert.equal(await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isMinimized()), true);
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await shell.getByRole("button", { name: "Close window" }).click();
  assert.equal(await electron.evaluate(({ app }) => app.isReady()), true);
  assert.equal((await fetch(consoleAddress)).ok, true);
  const reopenedWindow = electron.waitForEvent("window");
  await electron.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().items.find(item => item.label === "Commands")
      .submenu.items.find(item => item.label === "Show Console").click();
  });
  const reopened = await reopenedWindow;
  await reopened.getByRole("tab", { name: "Console" }).waitFor();
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  process.stdout.write("Desktop service tab reuse, new tabs, navigation, console and page reload, window controls, and tray persistence passed.\n");
} finally {
  await electron?.close();
  await Promise.all([
    new Promise(resolve => site.close(resolve)),
    new Promise(resolve => otherSite.close(resolve)),
  ]);
  await fs.rm(testUserData, { recursive: true, force: true });
}
