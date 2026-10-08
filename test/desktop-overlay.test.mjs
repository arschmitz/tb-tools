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
    consoleWindow: { isDestroyed: () => false, getContentSize: () => [1000, 700] },
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
