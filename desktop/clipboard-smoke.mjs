/* global document */
import assert from "node:assert/strict";

export async function checkClipboard(electron, shell, url, label) {
  const page = electron.context().pages().find(page => page.url() === url);
  assert.ok(page, `Missing ${label} page`);
  await page.waitForLoadState();
  const activeTabId = await shell.locator('[role="tab"][aria-selected="true"]')
    .getAttribute("data-tab-id");
  const wasVisible = await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isVisible());
  await electron.evaluate(async ({ clipboard, ClipboardItem, Menu }) => {
    const saved = await clipboard.read();
    globalThis.desktopSmokeSavedClipboard = await Promise.all(saved.filter(item => item.types.length).map(async item =>
      new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type =>
        [type, await item.getType(type)]))))));
    globalThis.desktopSmokeOriginalMenuBuilder = Menu.buildFromTemplate;
    Menu.buildFromTemplate = items => {
      globalThis.desktopSmokeContextItems = items.filter(item => item.type !== "separator")
        .map(item => ({ label: item.label, enabled: item.enabled !== false }));
      return { popup() {
        const label = globalThis.desktopSmokeContextAction;
        if (!label) return;
        const item = items.find(item => item.label === label && item.enabled !== false);
        if (!item) throw new Error(`Context action is unavailable: ${label}`);
        item.click();
      } };
    };
  });
  try {
    const roles = await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().items
      .find(item => item.role === "editmenu")?.submenu.items.map(item => item.role));
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectall"]) {
      assert.ok(roles?.includes(role), `Missing Edit command: ${role}`);
    }
    await page.evaluate(() => {
      const fixture = document.createElement("div");
      fixture.id = "desktop-clipboard-smoke";
      fixture.style = "position:fixed;top:10px;left:10px;z-index:2147483647;background:white;color:black";
      fixture.innerHTML = "<textarea id='clipboard-editor'></textarea>" +
        "<p id='clipboard-text'>Selected page text</p>" +
        "<a id='clipboard-link' href='https://example.com/'>Selected link text</a>";
      document.body.append(fixture);
    });
    const editor = page.locator("#clipboard-editor");
    const waitForClipboard = async expected => {
      let actual;
      for (let attempt = 0; attempt < 50; attempt++) {
        actual = await electron.evaluate(({ clipboard }) => clipboard.readText());
        if (actual === expected) return;
        await shell.waitForTimeout(50);
      }
      const focus = await electron.evaluate(async ({ BrowserWindow, webContents }, url) => {
        const window = BrowserWindow.getAllWindows()[0];
        const contents = webContents.getAllWebContents().find(item => item.getURL() === url);
        return { window: window.isFocused(), page: contents.isFocused(),
          inputs: contents.desktopSmokeInputs,
          selection: await contents.executeJavaScript(`({ id: document.activeElement.id,
            start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd })`) };
      }, url);
      assert.fail(`${label} did not copy the expected test text: ${JSON.stringify(focus)}`);
    };
    const contextAction = async (target, action) => {
      await electron.evaluate((_electron, label) => {
        globalThis.desktopSmokeContextAction = label;
        globalThis.desktopSmokeContextItems = undefined;
      }, action);
      await target.click({ button: "right" });
      let items;
      for (let attempt = 0; attempt < 50; attempt++) {
        items = await electron.evaluate(() => globalThis.desktopSmokeContextItems);
        if (items) return items;
        await shell.waitForTimeout(50);
      }
      throw new Error(`No ${label} context menu`);
    };
    const pressEditingKey = async (key, shift = false) => {
      await electron.evaluate(({ BrowserWindow, webContents }, target) => {
        const window = BrowserWindow.getAllWindows()[0];
        const contents = webContents.getAllWebContents().find(item => item.getURL() === target.url);
        window.show();
        window.focus();
        contents.focus();
        if (!contents.desktopSmokeInputs) {
          contents.desktopSmokeInputs = [];
          contents.on("before-input-event", (_event, input) => contents.desktopSmokeInputs.push(input));
        }
      }, { url });
      await shell.waitForTimeout(100);
      await electron.evaluate(({ webContents }, target) => {
        const contents = webContents.getAllWebContents().find(item => item.getURL() === target.url);
        const modifiers = [process.platform === "darwin" ? "meta" : "control"];
        if (target.shift) modifiers.push("shift");
        contents.sendInputEvent({ type: "keyDown", keyCode: target.key, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: target.key, modifiers });
      }, { url, key, shift });
    };
    await editor.fill(`${label} keyboard copy`);
    await editor.selectText();
    await pressEditingKey("C");
    await waitForClipboard(`${label} keyboard copy`);
    await electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), `${label} keyboard paste`);
    await pressEditingKey("V");
    await page.waitForFunction(text => document.getElementById("clipboard-editor").value === text,
      `${label} keyboard paste`);
    await pressEditingKey("A");
    await pressEditingKey("X");
    await waitForClipboard(`${label} keyboard paste`);
    await page.waitForFunction(() => document.getElementById("clipboard-editor").value === "");
    await pressEditingKey("Z");
    await page.waitForFunction(text => document.getElementById("clipboard-editor").value === text,
      `${label} keyboard paste`);
    await pressEditingKey(process.platform === "win32" ? "Y" : "Z", process.platform !== "win32");
    await page.waitForFunction(() => document.getElementById("clipboard-editor").value === "");
    await electron.evaluate(({ app }) => app.emit("activate"));
    await shell.waitForTimeout(50);
    assert.equal(await shell.locator('[role="tab"][aria-selected="true"]')
      .getAttribute("data-tab-id"), activeTabId, "App activation changed the selected tab");

    await editor.fill(`${label} context copy`);
    await editor.selectText();
    const editItems = await contextAction(editor, "Copy");
    assert.equal(editItems.find(item => item.label === "Copy")?.enabled, true);
    await waitForClipboard(`${label} context copy`);
    await electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), `${label} context paste`);
    await contextAction(editor, "Paste");
    await page.waitForFunction(text => document.getElementById("clipboard-editor").value === text,
      `${label} context paste`);
    await contextAction(editor, "Select All");
    await contextAction(editor, "Cut");
    await waitForClipboard(`${label} context paste`);
    await page.waitForFunction(() => document.getElementById("clipboard-editor").value === "");
    await contextAction(editor, "Undo");
    await page.waitForFunction(text => document.getElementById("clipboard-editor").value === text,
      `${label} context paste`);
    await contextAction(editor, "Redo");
    await page.waitForFunction(() => document.getElementById("clipboard-editor").value === "");
    const emptyItems = await contextAction(editor, undefined);
    assert.equal(emptyItems.find(item => item.label === "Copy")?.enabled, false);
    assert.equal(emptyItems.find(item => item.label === "Cut")?.enabled, false);

    const text = page.locator("#clipboard-text");
    await text.selectText();
    const textItems = await contextAction(text, "Copy");
    assert.deepEqual(textItems, [{ label: "Copy", enabled: true }]);
    await waitForClipboard("Selected page text");
    const link = page.locator("#clipboard-link");
    await link.selectText();
    const linkItems = await contextAction(link, "Copy Link Address");
    assert.deepEqual(linkItems.map(item => item.label),
      ["Copy", "Open in New Tab", "Open in Browser", "Copy Link Address"]);
    await waitForClipboard("https://example.com/");
  } finally {
    await page.evaluate(() => document.getElementById("desktop-clipboard-smoke")?.remove());
    await electron.evaluate(async ({ clipboard, Menu, BrowserWindow }, wasVisible) => {
      Menu.buildFromTemplate = globalThis.desktopSmokeOriginalMenuBuilder;
      if (globalThis.desktopSmokeSavedClipboard.length) {
        await clipboard.write(globalThis.desktopSmokeSavedClipboard);
      } else clipboard.clear();
      delete globalThis.desktopSmokeOriginalMenuBuilder;
      delete globalThis.desktopSmokeSavedClipboard;
      delete globalThis.desktopSmokeContextAction;
      delete globalThis.desktopSmokeContextItems;
      if (!wasVisible) BrowserWindow.getAllWindows()[0].hide();
    }, wasVisible);
  }
}
