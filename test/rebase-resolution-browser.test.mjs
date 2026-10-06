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

test("AI resolves all conflict files together, cancels, and continues after review", async (t) => {
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
  await writeFile(path.join(upstream, "second.txt"), "base\n");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "Base");
  await git(root, "clone", upstream, checkout);
  await git(checkout, "switch", "-c", "topic");
  await writeFile(path.join(checkout, "conflict.txt"), "local\n");
  await writeFile(path.join(checkout, "second.txt"), "local\n");
  await git(checkout, "commit", "-am", "Local change");
  await writeFile(path.join(upstream, "conflict.txt"), "upstream\n");
  await writeFile(path.join(upstream, "second.txt"), "upstream\n");
  await git(upstream, "commit", "-am", "Upstream change");

  const graphs = [
    { label: "Review", path: upstream, checkout: "review" },
    { label: "Working", path: checkout, checkout: "working" },
  ].map((graph) => ({ ...graph, branch: "main", commits: [], commitCount: 0, diffs: {} }));
  let finishGeneration;
  let generationGate;
  let failGeneration = false;
  const serverInfo = await startInteractiveGraphServer({
    graphs,
    html: buildGraphHtml({
      graphs,
      interactive: { enabled: true, aiEnabled: true, token: "secret" },
      scriptSrcs: [],
      stylesheetHref: "/assets/graph-client/style.css",
    }),
    token: "secret",
    appConfig: { ai: { enabled: true } },
    generateRebaseResolution: async (prompt, { onProgress }) => {
      assert.match(prompt, /conflict.txt/);
      assert.match(prompt, /second.txt/);
      onProgress({ message: "AI is generating targeted edits...", elapsedSeconds: 12, outputCharacters: 250 });
      await generationGate;
      if (failGeneration) throw new Error("Test generation failed");
      const edit = async name => ({ startLine: 1,
        endLine: (await readFile(path.join(checkout, name), "utf8")).match(/[^\n]*\n|[^\n]+$/g).length,
        text: name === "conflict.txt" ? "resolved\n" : "also resolved\n" });
      return JSON.stringify({ files: [
        { path: "conflict.txt", edits: [await edit("conflict.txt")] },
        { path: "second.txt", edits: [await edit("second.txt")] },
      ] });
    },
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

  const before = await readFile(path.join(checkout, "conflict.txt"), "utf8");
  const index = await git(checkout, "ls-files", "--stage");
  const resolve = async () => {
    generationGate = new Promise(resolve => { finishGeneration = resolve; });
    await page.evaluate(async () => {
      const { handleRebaseDialogClick } = await import("/assets/graph-client/rebase-dialog.js");
      handleRebaseDialogClick({ target: globalThis.document.querySelector(".rebase-resolve") });
    });
    await page.waitForFunction(() => globalThis.document.querySelector(".rebase-status").textContent.includes("250 characters received"));
    assert.equal(await page.locator(".rebase-continue").isDisabled(), true);
    assert.equal(await page.locator(".rebase-resolution-review").isVisible(), false);
    finishGeneration();
    if (failGeneration) {
      await page.waitForFunction(() => globalThis.document.querySelector(".rebase-error").textContent.includes("Test generation failed"));
      return;
    }
    await page.waitForFunction(() => !globalThis.document.querySelector(".rebase-resolution-review").hidden);
  };
  await resolve();
  assert.equal(await readFile(path.join(checkout, "conflict.txt"), "utf8"), "resolved\n");
  assert.equal(await readFile(path.join(checkout, "second.txt"), "utf8"), "also resolved\n");
  assert.equal(await git(checkout, "ls-files", "--stage"), index);
  assert.match(await page.locator(".rebase-resolution-diff").textContent(), /second.txt/);
  assert.equal(await page.locator(".rebase-resolution-diff .pretty-file").count(), 2);
  assert.equal(await page.locator(".rebase-resolution-diff .diff-table").count(), 2);
  assert.equal(await page.locator("pre.rebase-resolution-diff").count(), 0);
  assert.equal(await page.locator(".rebase-continue").textContent(), "Continue");
  await page.evaluate(async () => {
    const { closeRebaseDialog } = await import("/assets/graph-client/rebase-dialog.js");
    closeRebaseDialog();
  });
  await page.waitForFunction(() => globalThis.document.querySelector(".rebase-resolution-review").hidden);
  assert.equal(await readFile(path.join(checkout, "conflict.txt"), "utf8"), before);
  assert.equal(await git(checkout, "ls-files", "--stage"), index);
  failGeneration = true;
  await resolve();
  assert.equal(await page.locator(".rebase-resolve").isDisabled(), false);
  assert.equal(await readFile(path.join(checkout, "conflict.txt"), "utf8"), before);
  assert.equal(await git(checkout, "ls-files", "--stage"), index);
  failGeneration = false;
  await resolve();
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
