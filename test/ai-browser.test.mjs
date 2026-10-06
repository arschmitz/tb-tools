import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { BACKGROUND_BROWSER_POLICY } from "../commands/graph/ai-writing.mjs";

test("the supplied browser module works outside the console checkout", async () => {
  const moduleUrl = BACKGROUND_BROWSER_POLICY.match(/await import\(("[^"]+ai-browser\.mjs")\)/)?.[1];
  assert.ok(moduleUrl, "the prompt provides an absolute browser module URL");
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const { launchReviewBrowser } = await import(${moduleUrl});
    const browser = await launchReviewBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<label><input type="checkbox">Test toggle</label>');
      await page.keyboard.press('Tab');
      const focused = await page.getByRole('checkbox').evaluate(el => el === document.activeElement);
      await page.keyboard.press('Space');
      console.log(JSON.stringify({ focused, checked: await page.getByRole('checkbox').isChecked(),
        screenshotBytes: (await page.screenshot()).length }));
    } finally { await browser.close(); }
  `], { cwd: tmpdir(), timeout: 30_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.focused, true);
  assert.equal(result.checked, true);
  assert.ok(result.screenshotBytes > 0);
});
