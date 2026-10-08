import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";

test("desktop tabs keep the same shape, readable colors, and close buttons inside the border", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const css = await readFile(new URL("../commands/graph/client/style.css", import.meta.url), "utf8");
    const source = await readFile(new URL("../commands/graph/client/desktop-browser-tabs.js", import.meta.url), "utf8");
    for (const colorScheme of ["light", "dark"]) {
      const page = await browser.newPage({ colorScheme });
      await page.setContent(`<style>${css}</style><header><div class="console-footer"><nav class="console-navigation"><button class="tab console-view-tab active">Tree</button><button class="tab console-view-tab">Dashboard</button><button class="tab console-view-tab test-output-tab" hidden>Test Output</button></nav></div></header>`);
      await page.evaluate(async source => {
        globalThis.browserActions = [];
        // A running desktop window can still have the preload from before overlay support.
        globalThis.commandsBrowser = { layout() {}, action(action) { globalThis.browserActions.push(action); }, onState(callback) { globalThis.publishBrowserState = callback; } };
        const module = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
        module.initializeDesktopBrowserTabs();
        globalThis.publishBrowserState({ activeId: "page", address: "example", canGoBack: true, canGoForward: true, canReload: true, tabs: [{ id: "page", title: "A long browser page title", url: "https://example.com" }] });
      }, source);
      for (const name of ["Back", "Forward", "Reload"]) {
        const button = page.getByRole("button", { name, exact: true });
        const bounds = await button.boundingBox();
        assert.ok(bounds.width >= 42 && bounds.height >= 38);
        await button.click();
      }
      assert.deepEqual(await page.evaluate(() => globalThis.browserActions), ["back", "forward", "reload"]);
      const outputTab = page.locator(".test-output-tab");
      assert.equal(await outputTab.isVisible(), false);
      await outputTab.evaluate(element => { element.hidden = false; });
      assert.equal(await outputTab.isVisible(), true);
      await outputTab.evaluate(element => { element.hidden = true; });
      assert.equal(await outputTab.isVisible(), false);
      const styles = await page.evaluate(() => {
        const tree = globalThis.document.querySelector(".console-view-tab");
        const tab = globalThis.document.querySelector(".desktop-browser-tab");
        const close = globalThis.document.querySelector(".desktop-browser-tab-close");
        const summarize = element => {
          const style = globalThis.getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return { height: bounds.height, radius: style.borderRadius, background: style.backgroundColor, color: style.color };
        };
        const outer = tab.getBoundingClientRect();
        const inner = close.getBoundingClientRect();
        return { tree: summarize(tree), tab: summarize(tab), closeInside: inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom };
      });
      assert.equal(styles.tree.height, styles.tab.height);
      assert.equal(styles.tree.radius, styles.tab.radius);
      assert.notEqual(styles.tree.color, styles.tree.background);
      assert.notEqual(styles.tree.background, "rgba(0, 0, 0, 0)");
      assert.notEqual(styles.tree.background, styles.tab.background);
      assert.ok(styles.closeInside);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("console dialogs hide the browser until the last dialog closes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<header><nav class="console-navigation"></nav></header><dialog id="first">Build?</dialog><dialog id="second">Confirm</dialog>');
    const source = await readFile(new URL("../commands/graph/client/desktop-browser-tabs.js", import.meta.url), "utf8");
    await page.evaluate(async source => {
      globalThis.overlayStates = [];
      globalThis.commandsBrowser = { layout() {}, action() {}, onState() {},
        overlay(open) { globalThis.overlayStates.push(open); } };
      const module = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
      module.initializeDesktopBrowserTabs();
      globalThis.document.querySelector("#first").showModal();
    }, source);
    await page.waitForFunction(() => globalThis.overlayStates.at(-1) === true);
    await page.evaluate(() => {
      globalThis.document.querySelector("#second").showModal();
      globalThis.document.querySelector("#first").close();
    });
    assert.deepEqual(await page.evaluate(() => globalThis.overlayStates), [false, true]);
    await page.evaluate(() => globalThis.document.querySelector("#second").remove());
    await page.waitForFunction(() => globalThis.overlayStates.at(-1) === false);
    assert.deepEqual(await page.evaluate(() => globalThis.overlayStates), [false, true, false]);
  } finally { await browser.close(); }
});
