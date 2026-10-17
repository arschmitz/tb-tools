import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

test("desktop overlay hides the native browser and restores it without switching tabs", async () => {
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const layoutAndFocus = source.slice(source.indexOf("function layoutBrowser()"), source.indexOf("function activateTab("));
  const handler = source.slice(source.indexOf('ipcMain.on("commands-browser-overlay"'), source.indexOf('ipcMain.on("commands-browser-layout"'));
  let listener;
  const visible = [], focused = [];
  const consoleContents = { isDestroyed: () => false, focus: () => focused.push("console") };
  const browserView = { setBounds() {}, setVisible: value => visible.push(value),
    webContents: { isDestroyed: () => false, focus: () => focused.push("browser") } };
  const context = vm.createContext({
    consoleWindow: { isDestroyed: () => false, contentView: { getBounds: () => ({ width: 1000, height: 700 }) } },
    consoleView: { setBounds() {}, webContents: consoleContents }, activeView: browserView,
    browserHeaderHeight: 100, consoleDialogOpen: false,
    ipcMain: { on(_name, callback) { listener = callback; } },
  });
  vm.runInContext(layoutAndFocus + handler, context);
  listener({ sender: {} }, true);
  assert.deepEqual(visible, []);
  listener({ sender: consoleContents }, true);
  assert.deepEqual(visible, [false]);
  assert.deepEqual(focused, ["console"]);
  vm.runInContext("layoutBrowser();", context);
  assert.equal(visible.at(-1), false);
  listener({ sender: consoleContents }, false);
  assert.equal(visible.at(-1), true);
  assert.equal(focused.at(-1), "browser");
  assert.equal(context.activeView, browserView);
});

test("desktop views follow the content view when the native title bar changes", async () => {
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const layout = source.slice(source.indexOf("function layoutBrowser()"), source.indexOf("function focusActivePage()"));
  let height = 700;
  const dashboardBounds = [], pageBounds = [];
  const context = vm.createContext({
    consoleWindow: { isDestroyed: () => false,
      getContentSize: () => [1000, 700],
      contentView: { getBounds: () => ({ width: 1000, height }) } },
    consoleView: { setBounds: bounds => dashboardBounds.push({ ...bounds }) },
    activeView: { setBounds: bounds => pageBounds.push({ ...bounds }), setVisible() {} },
    browserHeaderHeight: 129, consoleDialogOpen: false,
  });
  vm.runInContext(layout + "layoutBrowser();", context);
  height = 732;
  vm.runInContext("layoutBrowser();", context);
  assert.deepEqual(dashboardBounds.at(-1), { x: 0, y: 0, width: 1000, height: 732 });
  assert.deepEqual(pageBounds.at(-1), { x: 0, y: 129, width: 1000, height: 603 });
  height = 700;
  vm.runInContext("layoutBrowser();", context);
  assert.deepEqual(dashboardBounds.at(-1), { x: 0, y: 0, width: 1000, height: 700 });
  assert.deepEqual(pageBounds.at(-1), { x: 0, y: 129, width: 1000, height: 571 });
});


test("only dashboard notification clicks can show the desktop window", async () => {
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('ipcMain.on("commands-browser-focus"'), source.indexOf('ipcMain.on("commands-browser-ready"'));
  let listener, shown = 0;
  const contents = {};
  vm.runInNewContext(handler, {
    consoleView: { webContents: contents },
    showConsole() { shown++; },
    ipcMain: { on(_name, callback) { listener = callback; } },
  });
  listener({ sender: {} });
  assert.equal(shown, 0);
  listener({ sender: contents });
  assert.equal(shown, 1);
});


test("notification focus restores a minimized window and selects the dashboard first", async () => {
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const show = source.slice(source.indexOf("function showConsole()"), source.indexOf("function openManagedPage("));
  const calls = [];
  vm.runInNewContext(show + "showConsole();", {
    consoleServer: {},
    consoleWindow: {
      isDestroyed: () => false, isMinimized: () => true,
      restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus"),
    },
    activateTab: id => calls.push(id),
  });
  assert.deepEqual(calls, ["restore", "console", "show", "focus"]);
});
