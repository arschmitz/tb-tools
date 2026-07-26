import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildDiffHtml,
  createDiffCommand,
  getDiffOutputPath,
  getPrettyDiffCommand,
  parseDiffArgs,
} from "../commands/diff.mjs";

test("getPrettyDiffCommand uses the installed local binary when present", () => {
  const command = getPrettyDiffCommand({
    exists: () => true,
    platform: "darwin",
  });

  assert.match(command, /node_modules\/\.bin\/pretty-diff$/);
});

test("getPrettyDiffCommand falls back to PATH when the local binary is missing", () => {
  assert.equal(getPrettyDiffCommand({ exists: () => false }), "pretty-diff");
});

test("getPrettyDiffCommand chooses gist-diff when publishing", () => {
  const command = getPrettyDiffCommand({
    exists: () => true,
    platform: "darwin",
    publish: true,
  });

  assert.match(command, /node_modules\/\.bin\/gist-diff$/);
});

test("parseDiffArgs extracts gist publishing flags", () => {
  assert.deepEqual(parseDiffArgs(["--gist", "HEAD^"]), {
    args: ["HEAD^"],
    publish: true,
  });
  assert.deepEqual(parseDiffArgs(["--public", "--cached"]), {
    args: ["--public", "--cached"],
    publish: true,
  });
});

test("getDiffOutputPath creates temp HTML paths", () => {
  assert.equal(
    getDiffOutputPath({ tmpdir: "/tmp", now: () => 123 }),
    "/tmp/tb-diff-123.html"
  );
  assert.equal(
    getDiffOutputPath({ output: "diff.html" }),
    path.resolve("diff.html")
  );
});

test("buildDiffHtml renders the shared diff view", () => {
  const html = buildDiffHtml({
    args: ["--cached"],
    diff: [
      "diff --git a/file.mjs b/file.mjs",
      "@@ -1 +1 @@",
      "-const oldValue = 1;",
      "+const newValue = \"ok\";",
    ].join("\n"),
  });

  assert.match(html, /TB Tools Diff/);
  assert.match(html, /git diff --cached/);
  assert.match(html, /class="diff-stats" aria-label="1 addition and 1 deletion"/);
  assert.match(html, /class="stat-additions">\+1<\/span>/);
  assert.match(html, /class="stat-deletions">-1<\/span>/);
  assert.match(html, /class="diff-table"/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /\.diff-line \{ height: 24px/);
});

test("diff command writes and opens a rendered git diff", async () => {
  const calls = [];
  const diff = createDiffCommand({
    getCommand: ({ publish }) => publish ? "gist-diff" : "pretty-diff",
    getOutputPath: () => "/tmp/tb-diff.html",
    cwd: "/repo/comm",
    makeDir: async (...args) => calls.push(["mkdir", ...args]),
    write: async (...args) => calls.push(["write", ...args]),
    open: async (...args) => calls.push(["open", ...args]),
    runCommand: async (command) => {
      calls.push(command);
      return [
        "diff --git a/file.mjs b/file.mjs",
        "@@ -1 +1 @@",
        "-const oldValue = 1;",
        "+const newValue = \"ok\";",
      ].join("\n");
    },
  });

  const outputPath = await diff(["--cached", "--", "mail/base/test/browser/browser_tree.js"]);

  assert.equal(outputPath, "/tmp/tb-diff.html");
  assert.deepEqual(calls[0], {
    cmd: "git",
    args: ["diff", "--cached", "--", "mail/base/test/browser/browser_tree.js"],
    cwd: "/repo/comm",
    capture: true,
    silent: true,
  });
  assert.deepEqual(calls[1], ["mkdir", "/tmp", { recursive: true }]);
  assert.equal(calls[2][0], "write");
  assert.equal(calls[2][1], "/tmp/tb-diff.html");
  assert.match(calls[2][2], /class="diff-table"/);
  assert.match(calls[2][2], /class="diff-stats" aria-label="1 addition and 1 deletion"/);
  assert.deepEqual(calls[3], ["open", "/tmp/tb-diff.html"]);
});

test("diff command publishes via gist-diff", async () => {
  const calls = [];
  const diff = createDiffCommand({
    getCommand: ({ publish }) => publish ? "gist-diff" : "pretty-diff",
    runCommand: async (command) => {
      calls.push(command);
    },
  });

  await diff(["--gist", "--public", "HEAD^"]);

  assert.deepEqual(calls, [{
    cmd: "gist-diff",
    args: ["--public", "HEAD^"],
  }]);
});
