import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { buildGraphHtml } from "../commands/graph/templates.mjs";

const execFileAsync = promisify(execFile);

test("update rebase opens conflicts and continues the correct checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-update-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout");
  const git = async (cwd, ...args) => (await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd })).stdout;
  await git(root, "init", "-b", "main", upstream);
  await writeFile(path.join(upstream, "conflict.txt"), "base\n");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "Base");
  await git(root, "clone", upstream, checkout);
  await git(checkout, "switch", "-c", "topic");
  await writeFile(path.join(checkout, "conflict.txt"), "local\n");
  await git(checkout, "commit", "-am", "Local change");
  await writeFile(path.join(upstream, "conflict.txt"), "upstream\n");
  await git(upstream, "commit", "-am", "Upstream change");

  const graphs = [
    { label: "Review", path: upstream, checkout: "review" },
    { label: "Working", path: checkout, checkout: "working" },
  ].map((graph) => ({ ...graph, branch: "main", commits: [], commitCount: 0, diffs: {} }));
  const serverInfo = await startInteractiveGraphServer({
    graphs,
    html: buildGraphHtml({
      graphs,
      interactive: { enabled: true, token: "secret" },
      scriptSrcs: [],
      stylesheetHref: "/assets/graph-client/style.css",
    }),
    token: "secret",
    runCommand: async ({ cmd, args, cwd }) => {
      assert.equal(cmd, "git");
      assert.ok([checkout, upstream].includes(cwd));
      return git(cwd, ...args);
    },
  });
  t.after(() => new Promise((resolve) => serverInfo.server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(serverInfo.url);
  await page.evaluate(async () => {
    const { runGraphUpdate } = await import("/assets/graph-client/command-sessions.js");
    const { uiState } = await import("/assets/graph-client/config.js");
    uiState.loadObserver = new globalThis.IntersectionObserver(() => {});
    await runGraphUpdate("rebase", "", "current", 1);
  });
  const dialog = page.locator("#rebase-dialog");
  assert.equal(await dialog.isVisible(), true);
  assert.match(await dialog.textContent(), /conflict.txt/);
  assert.equal(await page.locator(".rebase-continue").isVisible(), true);
  assert.equal(await page.evaluate(async () => {
    const { uiState } = await import("/assets/graph-client/config.js");
    return uiState.rebaseDialogState.graphIndex;
  }), 1);

  // Continue must leave the dialog open while conflict markers remain.
  await page.evaluate(async () => {
    const { continueRebaseDialog } = await import("/assets/graph-client/commit-actions.js");
    await continueRebaseDialog();
  });
  assert.equal(await dialog.isVisible(), true);
  assert.match(await dialog.textContent(), /still contain conflict markers/);

  await writeFile(path.join(checkout, "conflict.txt"), "resolved\n");
  await page.evaluate(async () => {
    const { continueRebaseDialog } = await import("/assets/graph-client/commit-actions.js");
    await continueRebaseDialog();
  });
  assert.equal(await dialog.isVisible(), false, await dialog.textContent());
  assert.equal((await git(checkout, "branch", "--show-current")).trim(), "topic");
  assert.equal((await git(checkout, "status", "--porcelain")).trim(), "");
  assert.equal(await readFile(path.join(checkout, "conflict.txt"), "utf8"), "resolved\n");
  assert.equal((await git(checkout, "rev-parse", "HEAD^")).trim(),
    (await git(upstream, "rev-parse", "HEAD")).trim());
  assert.equal(await page.evaluate(async () => {
    const { graphStates } = await import("/assets/graph-client/config.js");
    return graphStates[1].graph.branch;
  }), "topic");
});

test("pull collects live output without expanding the panel and retains failures", async (t) => {
  const graphs = [{ label: "comm", path: "/test/comm", checkout: "working", branch: "main", commits: [], diffs: {} }];
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  t.after(() => releaseFetch());
  const serverInfo = await startInteractiveGraphServer({
    graphs,
    html: buildGraphHtml({
      graphs,
      interactive: { enabled: true, token: "secret" },
      scriptSrcs: [],
      stylesheetHref: "/assets/graph-client/style.css",
    }),
    token: "secret",
    runCommand: async (command) => {
      if (command.args[0] === "fetch") {
        assert.ok(command.args.includes("--progress"));
        command.onStderr("Receiving objects: 42%\r");
        await fetchGate;
        command.onStderr("Connection lost\n");
        const error = new Error("Fetch failed");
        error.stderr = "Receiving objects: 42%\rConnection lost\n";
        throw error;
      }
      return "";
    },
  });
  t.after(() => new Promise((resolve) => serverInfo.server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(serverInfo.url);
  await page.evaluate(async () => {
    const { runGraphUpdate } = await import("/assets/graph-client/command-sessions.js");
    globalThis.pullDone = runGraphUpdate("update", "", "current", 0);
  });
  await page.waitForFunction(() => globalThis.document.querySelector(".mach-output").textContent.includes("Receiving objects: 42%"));
  assert.equal(await page.locator(".mach-output-panel").isVisible(), false);
  assert.equal(await page.locator(".mach-output-toggle").isVisible(), true);
  assert.equal(await page.locator(".command-status-bar").evaluate((node) => node.classList.contains("busy")), true);
  releaseFetch();
  await page.evaluate(() => globalThis.pullDone);
  assert.match(await page.locator(".update-status").textContent(), /Fetch failed/);
  const output = await page.locator(".mach-output").textContent();
  assert.equal(output.split("Receiving objects: 42%").length - 1, 1);
  assert.match(output, /Connection lost/);
  assert.equal(await page.locator(".command-status-bar").evaluate((node) => node.classList.contains("busy")), false);
});
