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
        globalThis.commandsBrowser = { layout() {}, action() {}, onState(callback) { globalThis.publishBrowserState = callback; } };
        const module = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
        module.initializeDesktopBrowserTabs();
        globalThis.publishBrowserState({ activeId: "page", address: "example", tabs: [{ id: "page", title: "A long browser page title", url: "https://example.com" }] });
      }, source);
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
