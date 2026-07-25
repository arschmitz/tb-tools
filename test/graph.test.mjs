import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGraphHtml,
  checkoutCommit,
  createGraphCommand,
  getCheckoutCommitPage,
  getCheckoutGraphData,
  getCheckoutGraphMetadata,
  getCommitDiffs,
  getGraphOutputPath,
  formatPrettyDiffHtml,
  parseDecorations,
  parseGitLog,
  pruneMissingParents,
  splitPrettyDiffFiles,
  startInteractiveGraphServer,
  truncateDiff,
} from "../commands/graph.mjs";

test("parseDecorations expands HEAD arrows and tags", () => {
  assert.deepEqual(parseDecorations("HEAD -> main, origin/main, tag: v1.0.0"), [
    "HEAD",
    "main",
    "origin/main",
    "tag: v1.0.0",
  ]);
  assert.deepEqual(parseDecorations("origin/HEAD -> origin/main"), ["origin/main"]);
});

test("parseGitLog converts git log records into GitGraph import data", () => {
  const output = "\x1eabc123\x1fparent1 parent2\x1fHEAD -> main, tag: v1.0.0\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";

  assert.deepEqual(parseGitLog(output), [{
    hash: "abc123",
    parents: ["parent1", "parent2"],
    refs: ["HEAD", "main", "tag: v1.0.0"],
    author: {
      name: "Alice",
      email: "alice@example.com",
      timestamp: 1710000000000,
    },
    subject: "Fix the thing",
  }]);
});

test("pruneMissingParents removes parents outside the displayed commit window", () => {
  assert.deepEqual(pruneMissingParents([
    { hash: "child", parents: ["parent", "missing"] },
    { hash: "parent", parents: ["older"] },
  ]), [
    { hash: "child", parents: ["parent"] },
    { hash: "parent", parents: [] },
  ]);
});

test("truncateDiff caps embedded diff size", () => {
  assert.deepEqual(truncateDiff("small diff", 100), {
    text: "small diff",
    html: "",
    truncated: false,
  });
  assert.deepEqual(truncateDiff("abcdef", 3), {
    text: "abc\n\n[diff truncated at 3 bytes]",
    html: "<pre class=\"info\">[diff truncated at 3 bytes]</pre>",
    truncated: true,
  });
});

test("splitPrettyDiffFiles groups patch output by file", () => {
  assert.deepEqual(splitPrettyDiffFiles([
    "diff --git a/file.txt b/file.txt",
    "index 123..456 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n")), {
    "file.txt": [
      "diff --git a/file.txt b/file.txt",
      "index 123..456 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ],
  });
});

test("formatPrettyDiffHtml renders pretty-diff style markup", () => {
  const html = formatPrettyDiffHtml([
    "diff --git a/file.txt b/file.txt",
    "@@ -1 +1 @@",
    "-old <value>",
    "+new & better",
  ].join("\n"));

  assert.match(html, /class="pretty-file"/);
  assert.match(html, /class="delete">-old &lt;value&gt;<\/pre>/);
  assert.match(html, /class="insert">\+new &amp; better<\/pre>/);
  assert.match(html, /data-path="file.txt"/);
});

test("getCommitDiffs collects git show output by commit hash", async () => {
  const commands = [];
  const diffs = await getCommitDiffs({
    cwd: "/repo/comm",
    maxDiffBytes: 100,
    commits: [{ hash: "abc123" }],
    runCommand: async (command) => {
      commands.push(command);
      return `commit ${command.args.at(-1)}\n\ndiff --git a/file b/file\n`;
    },
  });

  assert.equal(commands[0].cmd, "git");
  assert.equal(commands[0].cwd, "/repo/comm");
  assert.deepEqual(commands[0].args.slice(0, 2), ["show", "--format="]);
  assert.match(diffs.abc123.text, /diff --git/);
  assert.match(diffs.abc123.html, /pretty-file/);
  assert.equal(diffs.abc123.truncated, false);
});

test("getCheckoutGraphData collects git log data for a checkout", async () => {
  const commands = [];
  const data = await getCheckoutGraphData({
    label: "comm",
    cwd: ".",
    limit: 12,
    runCommand: async (command) => {
      commands.push(command);

      if (command.args[0] === "rev-parse") {
        return "/repo/comm\n";
      }

      if (command.args[0] === "branch") {
        return "Bug-1234567\n";
      }

      if (command.args[0] === "show") {
        return "diff --git a/file b/file\n";
      }

      return "\x1eabc123\x1f\x1fHEAD -> Bug-1234567\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
    },
  });

  assert.equal(data.label, "comm");
  assert.equal(data.path, "/repo/comm");
  assert.equal(data.branch, "Bug-1234567");
  assert.equal(data.commitCount, 1);
  assert.match(data.diffs.abc123.text, /diff --git/);
  assert.equal(commands[2].args.includes("--max-count=12"), true);
  assert.equal(commands[3].args[0], "show");
});

test("getCheckoutGraphMetadata collects checkout identity without commits", async () => {
  const commands = [];
  const data = await getCheckoutGraphMetadata({
    label: "firefox",
    cwd: "..",
    runCommand: async (command) => {
      commands.push(command);

      if (command.args[0] === "rev-parse") {
        return "/repo/firefox\n";
      }

      return "main\n";
    },
  });

  assert.equal(data.label, "firefox");
  assert.equal(data.path, "/repo/firefox");
  assert.equal(data.branch, "main");
  assert.deepEqual(data.commits, []);
  assert.equal(commands.length, 2);
});

test("getCheckoutCommitPage collects a page of commits without pruning parents", async () => {
  const commands = [];
  const page = await getCheckoutCommitPage({
    cwd: "/repo/comm",
    offset: 20,
    limit: 10,
    runCommand: async (command) => {
      commands.push(command);
      return "\x1eabc123\x1fmissing-parent\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
    },
  });

  assert.equal(page.offset, 20);
  assert.equal(page.nextOffset, 21);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.commits[0].parents, ["missing-parent"]);
  assert.equal(commands[0].args.includes("--skip=20"), true);
  assert.equal(commands[0].args.includes("--max-count=10"), true);
});

test("checkoutCommit checks out loaded commits only when the tree is clean", async () => {
  const calls = [];
  const result = await checkoutCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "";
    },
  });

  assert.equal(result.message, "comm checked out abc123 as detached HEAD.");
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["switch", "--detach", "abc123"],
  ]);
});

test("checkoutCommit refuses dirty working trees", async () => {
  await assert.rejects(
    checkoutCommit({
      graph: {
        label: "firefox",
        path: "/repo/firefox",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async () => " M file.txt\n",
    }),
    /local changes/
  );
});

test("buildGraphHtml creates tabbed GitGraph HTML", () => {
  const html = buildGraphHtml({
    gitgraphScript: "window.GitgraphJS = {};",
    graphs: [
      {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        commitCount: 1,
        diffs: {
          abc123: {
            text: "diff --git a/file b/file",
            truncated: false,
          },
        },
        commits: [{
          hash: "abc123",
          parents: [],
          refs: ["HEAD", "main"],
          author: { name: "Alice", email: "alice@example.com" },
          subject: "Fix",
        }],
      },
      {
        label: "firefox",
        path: "/repo",
        branch: "main",
        commitCount: 0,
        commits: [],
      },
    ],
  });

  assert.match(html, /TB Tools Branch Graph/);
  assert.match(html, /data-index="0"/);
  assert.match(html, /data-index="1"/);
  assert.match(html, /GitgraphJS\.createGitgraph/);
  assert.match(html, /function renderGraph/);
  assert.match(html, /renderGraph\(0\)/);
  assert.match(html, /function showDiff/);
  assert.match(html, /\.graph svg \{ overflow: visible; \}/);
  assert.match(html, /\.commit-row, \.commit-row \* \{ cursor: pointer; \}/);
  assert.match(html, /\.commit-row\.active \.commit-row-hitbox/);
  assert.match(html, /\.commit-row\.current \.commit-row-hitbox/);
  assert.match(html, /const COMMIT_DOT_RADIUS = 10/);
  assert.match(html, /function centerBranchLabelsVertically/);
  assert.match(html, /function decorateCommitRows/);
  assert.match(html, /function isCurrentCommit/);
  assert.match(html, /const labelTranslate = getTranslate\(labelContainer\)/);
  assert.match(html, /graphStates\[index\]\.selectedHash = commit\.hash/);
  assert.match(html, /currentHash: getCurrentCommitHash\(graph\.commits \|\| \[\]\)/);
  assert.match(html, /row\.classList\.toggle\("current", row\.dataset\.hash === currentHash\)/);
  assert.match(html, /graphStates\[graphIndex\]\.currentHash = hash/);
  assert.match(html, /scheduleGraphEnhancements\(index\)/);
  assert.match(html, /onClick: \(\) => showDiff/);
  assert.doesNotMatch(html, /orientation: GitgraphJS\.Orientation\.VerticalReverse/);
  assert.match(html, /branch: \{\n\s+spacing: 24/);
  assert.match(html, /commit: \{\n\s+spacing: 30/);
  assert.match(html, /borderRadius: 4/);
  assert.match(html, /normal 10px/);
  assert.match(html, /size: COMMIT_DOT_RADIUS/);
  assert.match(html, /strokeColor: "#ffffff"/);
  assert.match(html, /strokeWidth: 2/);
  assert.match(html, /normal 16px/);
});

test("buildGraphHtml supports interactive loading and checkout callbacks", () => {
  const html = buildGraphHtml({
    gitgraphScript: "window.GitgraphJS = {};",
    interactive: {
      enabled: true,
      pageSize: 25,
      token: "secret",
    },
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      commitCount: 0,
      commits: [],
      diffs: {},
    }],
  });

  assert.match(html, /const INTERACTIVE = /);
  assert.match(html, /"pageSize":25/);
  assert.match(html, /\/api\/graph\/" \+ index \+ "\/commits/);
  assert.match(html, /\/api\/checkout/);
  assert.match(html, /\/api\/close/);
  assert.match(html, /\/api\/ping/);
  assert.match(html, /beforeunload/);
  assert.match(html, /checkout-commit/);
  assert.match(html, /IntersectionObserver/);
  assert.match(html, /load-sentinel/);
  assert.doesNotMatch(html, /window\.innerHeight \+ window\.scrollY/);
});

test("getGraphOutputPath defaults to a temp HTML file", () => {
  assert.match(getGraphOutputPath(), /tb-tools-branch-graph\.html$/);
  assert.equal(getGraphOutputPath("/tmp/custom.html"), "/tmp/custom.html");
});

test("graph command writes and opens a tabbed graph", async () => {
  const calls = [];
  const graph = createGraphCommand({
    getCheckoutData: async ({ label, limit }) => ({
      label,
      path: `/repo/${label}`,
      branch: "main",
      limit,
      commitCount: 0,
      commits: [],
      diffs: {},
    }),
    readBundle: async () => "window.GitgraphJS = {};",
    makeDir: async (dir, options) => calls.push(["mkdir", dir, options]),
    write: async (file, html) => calls.push(["write", file, /comm/.test(html) && /firefox/.test(html)]),
    open: async (file) => calls.push(["open", file]),
  });

  const outputPath = await graph({ limit: 5, output: "/tmp/graph.html" });

  assert.equal(outputPath, "/tmp/graph.html");
  assert.deepEqual(calls, [
    ["mkdir", "/tmp", { recursive: true }],
    ["write", "/tmp/graph.html", true],
    ["open", "/tmp/graph.html"],
  ]);
});

test("interactive graph server streams commits, diffs, checkout responses, and closes", async (t) => {
  const calls = [];
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    pageSize: 1,
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      commits: [],
      commitCount: 0,
      diffs: {},
    }],
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
      }

      if (command.args[0] === "show") {
        return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const pageResponse = await fetch(serverInfo.url);
  assert.equal(await pageResponse.text(), "<!doctype html><p>graph</p>");

  const commitsResponse = await fetch(new URL("api/graph/0/commits?offset=0&limit=1&token=secret", serverInfo.url));
  const commits = await commitsResponse.json();
  assert.equal(commits.commits[0].hash, "abc123");

  const diffResponse = await fetch(new URL("api/graph/0/diff/abc123?token=secret", serverInfo.url));
  const diff = await diffResponse.json();
  assert.match(diff.html, /pretty-file/);

  const pingResponse = await fetch(new URL("api/ping", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  assert.equal(pingResponse.ok, true);

  const checkoutResponse = await fetch(new URL("api/checkout", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", graphIndex: 0, hash: "abc123" }),
  });
  const checkout = await checkoutResponse.json();
  assert.equal(checkout.message, "comm checked out abc123 as detached HEAD.");

  const closePromise = new Promise((resolve) => serverInfo.server.once("close", resolve));
  const closeResponse = await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  assert.equal(closeResponse.ok, true);
  await closePromise;

  assert.equal(calls.some((call) => call.args[0] === "switch"), true);
});

test("interactive graph server closes when page heartbeats stop", async (t) => {
  const serverInfo = await startInteractiveGraphServer({
    html: "<!doctype html><p>graph</p>",
    token: "secret",
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 30,
    graphs: [{
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      commits: [],
      commitCount: 0,
      diffs: {},
    }],
    runCommand: async () => "",
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const pageResponse = await fetch(serverInfo.url);
  assert.equal(pageResponse.ok, true);

  await new Promise((resolve) => serverInfo.server.once("close", resolve));
  assert.equal(serverInfo.server.listening, false);
});

test("graph command serves interactive mode without writing static output", async () => {
  const calls = [];
  const graph = createGraphCommand({
    getCheckoutMetadata: async ({ label }) => ({
      label,
      path: `/repo/${label}`,
      branch: "main",
      commitCount: 0,
      commits: [],
      diffs: {},
    }),
    readBundle: async () => "window.GitgraphJS = {};",
    makeDir: async () => calls.push(["mkdir"]),
    write: async () => calls.push(["write"]),
    open: async (url) => calls.push(["open", url]),
    makeToken: () => "secret",
    log: () => {},
    startServer: async ({ html, token, pageSize }) => {
      calls.push(["server", /const INTERACTIVE/.test(html), token, pageSize]);
      return {
        url: "http://127.0.0.1:1234/",
        server: {},
      };
    },
    waitForClose: async (server) => calls.push(["wait", server]),
  });

  const url = await graph({ interactive: true, pageSize: 25 });

  assert.equal(url, "http://127.0.0.1:1234/");
  assert.deepEqual(calls, [
    ["server", true, "secret", 25],
    ["open", "http://127.0.0.1:1234/"],
    ["wait", {}],
  ]);
});
