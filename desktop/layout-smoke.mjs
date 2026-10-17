import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { prepareDesktopRuntime } from "./launch-runtime.mjs";

const comm = process.argv[2] || process.env.TB_COMM_PATH;
if (!comm) throw new Error("Pass the Thunderbird comm checkout path.");
const runtime = await prepareDesktopRuntime({ projectRoot: path.resolve(import.meta.dirname, "..") });
const data = await mkdtemp(path.join(os.tmpdir(), "tb-layout-check-"));
let application;
try {
  application = await _electron.launch({ executablePath: runtime.executable, args: [`--comm=${comm}`],
    env: { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: data }, timeout: 60000 });
  let page;
  for (let attempt = 0; attempt < 300; attempt++) {
    page = application.context().pages().find(item => item.url().startsWith("http://127.0.0.1:"));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page);
  await page.locator("body.desktop-browser-host").waitFor();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  for (const height of [948, 980, 948]) {
    await application.evaluate(({ BrowserWindow }, height) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1500, height);
    }, height);
    await page.waitForFunction(height => {
      const panel = globalThis.document.querySelector(".dashboard-panel");
      return globalThis.innerHeight === height && panel.getBoundingClientRect().bottom + 12 <= height + 1 &&
        globalThis.document.documentElement.scrollHeight <= height + 1;
    }, height);
    const metrics = await page.evaluate(() => ({
      headerTop: globalThis.document.querySelector("body > header").getBoundingClientRect().top,
      scroll: globalThis.scrollY,
    }));
    assert.equal(metrics.headerTop, 0);
    assert.equal(metrics.scroll, 0);
    const native = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { root: window.contentView.getBounds(), dashboard: window.contentView.children[0].getBounds(),
        visible: window.isVisible() };
    });
    assert.deepEqual(native.dashboard, { x: 0, y: 0, width: native.root.width, height: native.root.height });
    assert.equal(native.visible, false);
  }
  if (process.argv.includes("--fullscreen") && process.platform === "darwin") {
    for (const fullscreen of [true, false]) {
      await application.evaluate(async ({ BrowserWindow }, fullscreen) => {
        const window = BrowserWindow.getAllWindows()[0];
        await new Promise(resolve => {
          window.once(fullscreen ? "enter-full-screen" : "leave-full-screen", resolve);
          window.setFullScreen(fullscreen);
        });
      }, fullscreen);
      await page.mouse.move(600, 500);
      await page.waitForFunction(() => {
        const header = globalThis.document.querySelector("body > header");
        const panel = globalThis.document.querySelector(".dashboard-panel");
        return header.getBoundingClientRect().top === 0 && globalThis.scrollY === 0 &&
          panel.getBoundingClientRect().bottom + 12 <= globalThis.innerHeight + 1 &&
          globalThis.document.documentElement.scrollHeight <= globalThis.innerHeight + 1;
      });
      const native = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { fullscreen: window.isFullScreen(), root: window.contentView.getBounds(),
          dashboard: window.contentView.children[0].getBounds() };
      });
      assert.equal(native.fullscreen, fullscreen);
      assert.deepEqual(native.dashboard, { x: 0, y: 0, width: native.root.width, height: native.root.height });
    }
    console.log("Native macOS fullscreen entry and exit keep the dashboard header at the top without page scroll.");
  }
  if (process.argv.includes("--fill-display") && process.platform === "darwin") {
    for (const fullscreen of [true, false]) {
      await application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById("fill-entire-display");
        item.click(item);
      });
      await page.waitForFunction(() => globalThis.document.querySelector("body > header").getBoundingClientRect().top === 0 &&
        globalThis.document.documentElement.scrollHeight <= globalThis.innerHeight + 1 && globalThis.scrollY === 0);
      const native = await application.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { fullscreen: window.isSimpleFullScreen(), bounds: window.getBounds(),
          display: screen.getDisplayMatching(window.getBounds()).bounds,
          root: window.contentView.getBounds(), dashboard: window.contentView.children[0].getBounds() };
      });
      assert.equal(native.fullscreen, fullscreen);
      if (fullscreen) assert.deepEqual(native.bounds, native.display);
      assert.deepEqual(native.dashboard, { x: 0, y: 0, width: native.root.width, height: native.root.height });
    }
    console.log("Fill Entire Display uses every screen pixel, including the top strip, and restores the window on exit.");
  }
  console.log("Dashboard fills the native content area across title-bar-sized height changes without a header gap or page scroll.");
} finally {
  await application?.close();
  await rm(data, { recursive: true, force: true });
}
