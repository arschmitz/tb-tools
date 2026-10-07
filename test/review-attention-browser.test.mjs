import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("review attention follows ready changes and rebuilt diffs without stealing focus or repeated scrolling", async t => {
  const info = await startInteractiveGraphServer({ graphs: [], token: "test", html: `
    <input id="guidance"><div id="diff" style="height:300px;overflow:auto">
    <div style="height:2000px"></div><div id="actions"><button>Make Change</button></div>
    <div style="height:2000px"></div></div>` });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => info.server.close(resolve)); });
  const page = await browser.newPage();
  await page.goto(info.url);
  await page.evaluate(async () => {
    const { createReviewAttentionScroller } = await import("/assets/graph-client/review-attention.js");
    globalThis.followReview = createReviewAttentionScroller();
    globalThis.document.querySelector("#guidance").focus();
    globalThis.followReview("comment-1", globalThis.document.querySelector("#actions"));
  });
  await page.waitForFunction(() => globalThis.document.querySelector("#diff").scrollTop > 1000);
  assert.equal(await page.evaluate(() => globalThis.document.activeElement.id), "guidance");
  await page.evaluate(() => {
    globalThis.document.querySelector("#diff").scrollTop = 0;
    globalThis.followReview("comment-1", globalThis.document.querySelector("#actions"));
  });
  await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  assert.equal(await page.locator("#diff").evaluate(e => e.scrollTop), 0);
  await page.evaluate(() => {
    const old = globalThis.document.querySelector("#actions");
    const replacement = old.cloneNode(true);
    old.replaceWith(replacement);
    globalThis.followReview("comment-1", replacement);
  });
  await page.waitForFunction(() => globalThis.document.querySelector("#diff").scrollTop > 1000);
  await page.evaluate(() => {
    globalThis.document.querySelector("#diff").scrollTop = 0;
    globalThis.followReview("candidate-1", globalThis.document.querySelector("#actions"), false);
  });
  await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(resolve)));
  assert.equal(await page.locator("#diff").evaluate(e => e.scrollTop), 0);
  await page.evaluate(() => globalThis.followReview("candidate-1", globalThis.document.querySelector("#actions")));
  await page.waitForFunction(() => globalThis.document.querySelector("#diff").scrollTop > 1000);
});
