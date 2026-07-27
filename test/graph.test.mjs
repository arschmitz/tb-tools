import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  amendCommitMessage,
  amendCurrentCommit,
  answerSubmitSessionPrompt,
  buildGraphHtml,
  chooseCheckoutBranch,
  choosePruneBranches,
  chooseRebaseBranch,
  chooseRewordBranch,
  checkoutCommit,
  createGraphCommand,
  getGraphCommitMessage,
  getGraphCurrentCommitMessage,
  getCheckoutCommitPage,
  getCheckoutGraphData,
  getCheckoutGraphMetadata,
  getCommitDiffs,
  getWorkingTreeCommits,
  getWorkingTreeDiff,
  getGraphOutputPath,
  formatPrettyDiffHtml,
  isWorkingTreeCommitHash,
  parseDecorations,
  parseGitLog,
  pruneCommitBranches,
  pruneMissingParents,
  rebaseCommit,
  getInteractiveYesNoPrompt,
  runInteractiveSubmitCommand,
  splitPrettyDiffFiles,
  startInteractiveGraphServer,
  truncateDiff,
  waitForInteractiveServerClose,
} from "../commands/graph.mjs";

async function waitForSubmitSession(url, predicate) {
  for (let index = 0; index < 50; index++) {
    const response = await fetch(url);
    const session = await response.json();

    if (predicate(session)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for submit session.");
}

async function waitForSubmitSessionLike(session, predicate) {
  for (let index = 0; index < 50; index++) {
    if (predicate(session)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for submit session state.");
}

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

test("chooseCheckoutBranch prefers the current branch when available", () => {
  assert.equal(chooseCheckoutBranch("topic\nmain\n", "main"), "main");
  assert.equal(chooseCheckoutBranch("topic\nmain\n", "other"), "topic");
  assert.equal(chooseCheckoutBranch("", "main"), "");
});

test("choosePruneBranches picks the local branch to rewrite", () => {
  assert.deepEqual(choosePruneBranches({
    containingRefs: "topic\nmain\n",
    currentBranch: "main",
  }), ["main"]);
  assert.deepEqual(choosePruneBranches({
    containingRefs: "topic\nmain\n",
    tipRefs: "topic\nmain\n",
  }), ["topic", "main"]);
  assert.deepEqual(choosePruneBranches({
    containingRefs: "topic\n",
  }), ["topic"]);
  assert.deepEqual(choosePruneBranches({
    containingRefs: "topic\nmain\n",
  }), []);
});

test("chooseRebaseBranch picks one source branch containing the selected commit", () => {
  assert.equal(chooseRebaseBranch({
    containingRefs: "topic\nmain\n",
    tipRefs: "topic\nmain\n",
    currentBranch: "main",
  }), "main");
  assert.equal(chooseRebaseBranch({
    containingRefs: "topic\n",
    currentBranch: "main",
  }), "topic");
  assert.equal(chooseRebaseBranch({
    containingRefs: "topic\nother\n",
    currentBranch: "main",
  }), "");
  assert.equal(chooseRebaseBranch({
    containingRefs: "main\n",
    currentBranch: "main",
  }), "main");
});

test("chooseRewordBranch prefers the checked-out branch containing the selected commit", () => {
  assert.equal(chooseRewordBranch({
    containingRefs: "topic\nmain\n",
    currentBranch: "main",
  }), "main");
  assert.equal(chooseRewordBranch({
    containingRefs: "topic\n",
    currentBranch: "main",
  }), "topic");
  assert.equal(chooseRewordBranch({
    containingRefs: "topic\nother\n",
    currentBranch: "main",
  }), "");
  assert.equal(chooseRewordBranch({
    containingRefs: "topic\nmain\n",
    tipRefs: "topic\n",
  }), "topic");
});

test("truncateDiff caps embedded diff size", () => {
  assert.deepEqual(truncateDiff("small diff", 100), {
    text: "small diff",
    html: "",
    truncated: false,
    insertions: 0,
    deletions: 0,
  });
  assert.deepEqual(truncateDiff("abcdef", 3), {
    text: "abc\n\n[diff truncated at 3 bytes]",
    html: "<pre class=\"info\">[diff truncated at 3 bytes]</pre>",
    truncated: true,
    insertions: 0,
    deletions: 0,
  });

  assert.deepEqual(truncateDiff([
    "diff --git a/file.txt b/file.txt",
    "@@ -1,2 +1,3 @@",
    " unchanged",
    "-old",
    "+new",
    "+extra",
  ].join("\n"), 1000), {
    text: [
      "diff --git a/file.txt b/file.txt",
      "@@ -1,2 +1,3 @@",
      " unchanged",
      "-old",
      "+new",
      "+extra",
    ].join("\n"),
    html: formatPrettyDiffHtml([
      "diff --git a/file.txt b/file.txt",
      "@@ -1,2 +1,3 @@",
      " unchanged",
      "-old",
      "+new",
      "+extra",
    ].join("\n")),
    truncated: false,
    insertions: 2,
    deletions: 1,
  });
});

test("runInteractiveSubmitCommand routes child yes/no prompts through submit session", async () => {
  let child;
  const writes = [];
  const session = {
    status: "running",
    message: "",
    prompt: null,
    pendingPrompt: null,
    output: "",
  };
  const spawnCommand = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(value) {
        writes.push(value);
        child.stdout.emit("data", "Submitted https://phabricator.services.mozilla.com/D123456\n");
        queueMicrotask(() => child.emit("exit", 0));
      },
    };
    child.kill = () => {};
    return child;
  };

  const command = runInteractiveSubmitCommand({
    command: { cmd: "moz-phab", args: ["submit"], cwd: "/repo/comm" },
    session,
    spawnCommand,
  });

  child.stdout.emit("data", "Submit to https://phabricator.services.mozilla.com (Yes/no/always)? ");
  await waitForSubmitSessionLike(session, (item) => Boolean(item.prompt));
  assert.equal(
    getInteractiveYesNoPrompt(session.output),
    "Submit to https://phabricator.services.mozilla.com (Yes/no/always)?"
  );
  assert.equal(session.prompt.message, "Submit to https://phabricator.services.mozilla.com (Yes/no/always)?");

  answerSubmitSessionPrompt(session, session.prompt.id, true);

  assert.equal(await command, "Submit to https://phabricator.services.mozilla.com (Yes/no/always)? Submitted https://phabricator.services.mozilla.com/D123456\n");
  assert.deepEqual(writes, ["y\n"]);
  assert.match(session.output, /\$ moz-phab submit/);
  assert.match(session.output, /> yes/);
  assert.match(session.output, /Submitted https:\/\/phabricator\.services\.mozilla\.com\/D123456/);
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
    "index 123..456 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -10,2 +20,2 @@",
    " unchanged",
    "-old <value>",
    "+new & better",
  ].join("\n"));

  assert.match(html, /class="pretty-file"/);
  assert.match(html, /class="file-heading"/);
  assert.match(html, /class="file-stats" aria-label="1 addition and 1 deletion"/);
  assert.match(html, /class="stat-additions">\+1<\/span>/);
  assert.match(html, /class="stat-deletions">-1<\/span>/);
  assert.match(html, /class="copy-path" type="button" data-path="file.txt">Copy path<\/button>/);
  assert.match(html, /<div class="file-diff"><table class="diff-table"><tbody>/);
  assert.doesNotMatch(html, /diff --git/);
  assert.doesNotMatch(html, /index 123\.\.456/);
  assert.doesNotMatch(html, /--- a\/file\.txt/);
  assert.doesNotMatch(html, /\+\+\+ b\/file\.txt/);
  assert.match(html, /class="diff-line info"/);
  assert.match(html, /<span class="line-content">@@ -10,2 \+20,2 @@<\/span>/);
  assert.match(html, /class="diff-line context"/);
  assert.match(html, /class="line-number old-line">10<\/td>/);
  assert.match(html, /class="line-number new-line">20<\/td>/);
  assert.match(html, /<span class="line-content">unchanged<\/span>/);
  assert.match(html, /class="diff-line delete"/);
  assert.match(html, /class="line-number old-line">11<\/td>/);
  assert.match(html, /class="line-number new-line"><\/td>/);
  assert.match(html, /<span class="line-marker">-<\/span><span class="line-content">old &lt;value&gt;<\/span>/);
  assert.match(html, /class="diff-line insert"/);
  assert.match(html, /class="line-number old-line"><\/td>/);
  assert.match(html, /class="line-number new-line">21<\/td>/);
  assert.match(html, /<span class="line-marker">\+<\/span><span class="line-content">new &amp; better<\/span>/);
  assert.match(html, /data-path="file.txt"/);

  const newFileHtml = formatPrettyDiffHtml([
    "diff --git a/new.txt b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+second",
  ].join("\n"));

  assert.match(newFileHtml, /class="line-number new-line">1<\/td>/);
  assert.match(newFileHtml, /class="line-number new-line">2<\/td>/);

  const markerLikeContentHtml = formatPrettyDiffHtml([
    "diff --git a/marker.txt b/marker.txt",
    "--- a/marker.txt",
    "+++ b/marker.txt",
    "@@ -1 +1 @@",
    "--- markdown heading",
    "+++ plus heading",
  ].join("\n"));

  assert.match(markerLikeContentHtml, /class="file-stats" aria-label="1 addition and 1 deletion"/);
  assert.match(markerLikeContentHtml, /class="diff-line delete"[^]*<span class="line-marker">-<\/span><span class="line-content">-- markdown heading<\/span>/);
  assert.match(markerLikeContentHtml, /class="diff-line insert"[^]*<span class="line-marker">\+<\/span><span class="line-content">\+\+ plus heading<\/span>/);

  const highlightedHtml = formatPrettyDiffHtml([
    "diff --git a/file.mjs b/file.mjs",
    "@@ -1 +1 @@",
    "-const oldValue = 1;",
    "+const newValue = \"ok\";",
  ].join("\n"));

  assert.match(highlightedHtml, /<span class="hljs-keyword">const<\/span>/);
  assert.match(highlightedHtml, /<span class="hljs-number">1<\/span>/);
  assert.match(highlightedHtml, /<span class="hljs-string">&quot;ok&quot;<\/span>/);
});

test("getCommitDiffs collects git show output by commit hash", async () => {
  const commands = [];
  const diffs = await getCommitDiffs({
    cwd: "/repo/comm",
    maxDiffBytes: 100,
    commits: [{ hash: "abc123" }],
    runCommand: async (command) => {
      commands.push(command);
      return `commit ${command.args.at(-1)}\n\ndiff --git a/file b/file\n@@ -1 +1 @@\n-old\n+new\n`;
    },
  });

  assert.equal(commands[0].cmd, "git");
  assert.equal(commands[0].cwd, "/repo/comm");
  assert.deepEqual(commands[0].args.slice(0, 2), ["show", "--format="]);
  assert.match(diffs.abc123.text, /diff --git/);
  assert.match(diffs.abc123.html, /pretty-file/);
  assert.equal(diffs.abc123.truncated, false);
  assert.equal(diffs.abc123.insertions, 1);
  assert.equal(diffs.abc123.deletions, 1);
});

test("getWorkingTreeCommits returns one uncommitted item for staged, unstaged, and untracked changes", async () => {
  const commands = [];
  const untrackedDiff = [
    "diff --git a/untracked.txt b/untracked.txt",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/untracked.txt",
    "@@ -0,0 +1 @@",
    "+fresh",
  ].join("\n");
  const workingTree = await getWorkingTreeCommits({
    cwd: "/repo/comm",
    parentHash: "abc123",
    runCommand: async (command) => {
      commands.push(command);

      if (command.args.includes("--no-index")) {
        const error = new Error("files differ");
        error.code = 1;
        error.stdout = untrackedDiff;
        throw error;
      }

      if (command.args[0] === "diff") {
        return [
          "diff --git a/tracked.txt b/tracked.txt",
          "index 1234567..89abcde 100644",
          "--- a/tracked.txt",
          "+++ b/tracked.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n");
      }

      if (command.args[0] === "ls-files") {
        return "untracked.txt\0";
      }

      return "";
    },
  });

  assert.equal(workingTree.commits.length, 1);
  assert.equal(isWorkingTreeCommitHash(workingTree.commits[0].hash), true);
  assert.equal(workingTree.commits[0].subject, "Uncommitted changes");
  assert.deepEqual(workingTree.commits[0].parents, ["abc123"]);
  assert.equal(workingTree.commits[0].workingTree, true);
  assert.match(workingTree.commits[0].changeId, /^[a-f0-9]{64}$/);
  assert.match(workingTree.diffs[workingTree.commits[0].hash].text, /tracked\.txt/);
  assert.match(workingTree.diffs[workingTree.commits[0].hash].text, /untracked\.txt/);
  assert.equal(workingTree.diffs[workingTree.commits[0].hash].insertions, 2);
  assert.equal(workingTree.diffs[workingTree.commits[0].hash].deletions, 1);
  assert.equal(commands.some((command) => command.args.includes("HEAD")), true);
  assert.equal(commands.some((command) => command.args[0] === "ls-files"), true);
  assert.equal(commands.some((command) => command.args.includes("--no-index")), true);
});

test("getWorkingTreeDiff returns an empty rendered diff when the working tree is clean", async () => {
  const diff = await getWorkingTreeDiff({
    cwd: "/repo/comm",
    runCommand: async () => "",
  });

  assert.deepEqual(diff, {
    text: "",
    html: "",
    truncated: false,
    insertions: 0,
    deletions: 0,
  });
});

test("getGraphCurrentCommitMessage reads the full current commit message", async () => {
  const calls = [];
  const message = await getGraphCurrentCommitMessage({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    runCommand: async (command) => {
      calls.push(command);
      return "Bug 123 - Fix thing. r=#reviewers\n\nBody text.\n";
    },
  });

  assert.equal(message, "Bug 123 - Fix thing. r=#reviewers\n\nBody text.\n");
  assert.deepEqual(calls.map((call) => call.args), [
    ["log", "-1", "--format=%B"],
  ]);
});

test("getGraphCommitMessage reads the full selected commit message", async () => {
  const calls = [];
  const message = await getGraphCommitMessage({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);
      return "Bug 123 - Selected message. r=#reviewers\n\nBody text.\n";
    },
  });

  assert.equal(message, "Bug 123 - Selected message. r=#reviewers\n\nBody text.\n");
  assert.deepEqual(calls.map((call) => call.args), [
    ["log", "-1", "--format=%B", "abc123"],
  ]);
});

test("amendCurrentCommit stages shown changes and amends with an edited message", async () => {
  const calls = [];
  const writes = [];
  const removes = [];
  const result = await amendCurrentCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    message: "Bug 123 - Better message. r=#reviewers\n\nUpdated body.",
    includeChanges: true,
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "diff") {
        return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "branch") {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Better message. r=#reviewers\n\nUpdated body.\n";
      }

      return "";
    },
    writeMessage: async (file, content) => writes.push({ file, content }),
    removeMessage: async (file) => removes.push(file),
  });

  assert.equal(result.message, "comm amended current commit def456.");
  assert.equal(result.branch, "topic");
  assert.equal(result.currentHash, "def456");
  assert.match(writes[0].file, /tb-tools-amend-[^.]+\.txt$/);
  assert.equal(writes[0].content, "Bug 123 - Better message. r=#reviewers\n\nUpdated body.\n");
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["diff", "--patch", "--find-renames", "--no-ext-diff", "--no-color", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["add", "-A"],
    ["commit", "--amend", "-F", writes[0].file],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
    ["log", "-1", "--format=%B", "def456"],
  ]);
});

test("amendCurrentCommit can update only the commit message without staging dirty files", async () => {
  const calls = [];
  const writes = [];
  const removes = [];
  const result = await amendCurrentCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
    },
    message: "Bug 123 - Message only. r=#reviewers",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Message only. r=#reviewers\n";
      }

      return "";
    },
    writeMessage: async (file, content) => writes.push({ file, content }),
    removeMessage: async (file) => removes.push(file),
  });

  assert.equal(result.message, "comm amended current commit def456.");
  assert.equal(result.branch, "topic");
  assert.equal(result.currentHash, "def456");
  assert.equal(result.rewrittenHash, "def456");
  assert.equal(writes[0].content, "Bug 123 - Message only. r=#reviewers\n");
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["commit", "--amend", "--only", "-F", writes[0].file],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
    ["log", "-1", "--format=%B", "def456"],
  ]);
});

test("amendCommitMessage rewrites a selected commit message and replays descendants", async () => {
  const calls = [];
  const writes = [];
  const removes = [];
  let revParseCount = 0;
  const graph = {
    label: "comm",
    path: "/repo/comm",
    branch: "topic",
    knownHashes: new Set(["abc123", "def456", "fed789"]),
  };
  const result = await amendCommitMessage({
    graph,
    hash: "abc123",
    message: "Bug 123 - Reword selected commit. r=#reviewers",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        revParseCount += 1;
        if (revParseCount === 1) {
          return "fed789\n";
        }
        if (revParseCount === 2) {
          return "newabc999\n";
        }
        return "newtip999\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--points-at")) {
        return "";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--contains")) {
        return "topic\n";
      }

      if (command.args[0] === "rev-list" && command.args.includes("--parents")) {
        return "abc123 parent000\n";
      }

      if (command.args[0] === "rev-list" && command.args.includes("--ancestry-path")) {
        return "def456\nfed789\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Reword selected commit. r=#reviewers\n";
      }

      return "";
    },
    writeMessage: async (file, content) => writes.push({ file, content }),
    removeMessage: async (file) => removes.push(file),
  });

  assert.equal(result.message, "comm amended message for abc123 and replayed 2 descendant commits on branch topic.");
  assert.equal(result.branch, "topic");
  assert.equal(result.currentHash, "newtip999");
  assert.equal(result.rewrittenHash, "newabc999");
  assert.equal(result.amendedCount, 3);
  assert.deepEqual(result.commits, ["abc123", "def456", "fed789"]);
  assert.equal(graph.branch, "topic");
  assert.match(writes[0].file, /tb-tools-amend-[^.]+\.txt$/);
  assert.equal(writes[0].content, "Bug 123 - Reword selected commit. r=#reviewers\n");
  assert.deepEqual(removes, [writes[0].file]);
  assert.deepEqual(calls.map((call) => call.args), [
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
    ["status", "--porcelain"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", "abc123", "refs/heads"],
    ["rev-list", "--parents", "-n", "1", "abc123"],
    ["rev-list", "--reverse", "--topo-order", "--ancestry-path", "abc123..topic"],
    ["switch", "--detach", "parent000"],
    ["cherry-pick", "--no-commit", "abc123"],
    ["commit", "-C", "abc123"],
    ["commit", "--amend", "--only", "-F", writes[0].file],
    ["rev-parse", "HEAD"],
    ["log", "-1", "--format=%B", "newabc999"],
    ["cherry-pick", "--no-commit", "def456"],
    ["commit", "-C", "def456"],
    ["cherry-pick", "--no-commit", "fed789"],
    ["commit", "-C", "fed789"],
    ["rev-parse", "HEAD"],
    ["branch", "-f", "topic", "newtip999"],
    ["switch", "topic"],
    ["rev-parse", "HEAD"],
  ]);
});

test("amendCurrentCommit refuses when the shown working tree diff is stale", async () => {
  await assert.rejects(
    amendCurrentCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
      },
      message: "Bug 123 - Better message. r=#reviewers",
      expectedChangeId: "different",
      includeChanges: true,
      runCommand: async (command) => {
        if (command.args[0] === "diff") {
          return "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
        }

        return "";
      },
      writeMessage: async () => {
        throw new Error("stale amend should not write a commit message");
      },
    }),
    /Working tree changed since this diff was loaded/
  );
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

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "\x1eabc123\x1f\x1fHEAD -> Bug-1234567\x1fAlice\x1falice@example.com\x1f1710000000\x1fFix the thing\n";
    },
  });

  assert.equal(data.label, "comm");
  assert.equal(data.path, "/repo/comm");
  assert.equal(data.branch, "Bug-1234567");
  assert.equal(data.commitCount, 1);
  assert.equal(data.workingTreeCount, 0);
  assert.match(data.diffs.abc123.text, /diff --git/);
  assert.equal(commands[2].args.includes("--max-count=12"), true);
  assert.equal(commands.some((command) => command.args[0] === "show"), true);
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

test("getCheckoutCommitPage inserts one uncommitted item above HEAD and keeps later offsets aligned", async () => {
  const firstCommands = [];
  const firstPage = await getCheckoutCommitPage({
    cwd: "/repo/comm",
    offset: 0,
    limit: 10,
    includeWorkingTree: true,
    runCommand: async (command) => {
      firstCommands.push(command);

      if (command.args[0] === "diff") {
        return "diff --git a/file b/file\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return "head123\n";
      }

      return [
        "\x1enewer123\x1f\x1forigin/main\x1fAlice\x1falice@example.com\x1f1710000100\x1fNewer upstream thing\n",
        "\x1ehead123\x1fparent123\x1fHEAD -> topic\x1fAlice\x1falice@example.com\x1f1710000000\x1fChecked out thing\n",
      ].join("");
    },
  });

  assert.equal(firstPage.commits.length, 3);
  assert.equal(firstPage.commits[0].hash, "newer123");
  assert.equal(firstPage.commits[1].subject, "Uncommitted changes");
  assert.deepEqual(firstPage.commits[1].parents, ["head123"]);
  assert.equal(firstPage.commits[2].hash, "head123");
  assert.equal(firstPage.nextOffset, 3);
  assert.equal(firstPage.workingTreeCount, 1);
  assert.equal(firstPage.hasMore, false);
  assert.equal(firstCommands.some((command) => command.args[0] === "rev-parse" && command.args[1] === "HEAD"), true);

  const nextCommands = [];
  await getCheckoutCommitPage({
    cwd: "/repo/comm",
    offset: firstPage.nextOffset,
    limit: 10,
    includeWorkingTree: true,
    workingTreeCount: firstPage.workingTreeCount,
    runCommand: async (command) => {
      nextCommands.push(command);
      return "";
    },
  });

  assert.equal(nextCommands[0].args.includes("--skip=2"), true);
  assert.equal(nextCommands.some((command) => command.args[0] === "diff"), false);
});

test("checkoutCommit checks out loaded commits only when the tree is clean", async () => {
  const calls = [];
  const result = await checkoutCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
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
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["switch", "--detach", "abc123"],
  ]);
});

test("checkoutCommit switches to a local branch when the commit is a branch tip", async () => {
  const calls = [];
  const result = await checkoutCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "for-each-ref") {
        return "topic\nmain\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm checked out branch main at abc123.");
  assert.equal(result.branch, "main");
  assert.equal(result.detached, false);
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["switch", "main"],
  ]);
});

test("rebaseCommit rebases a selected local branch tip onto the current checkout", async () => {
  const calls = [];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "";
      }

      if (command.args[0] === "for-each-ref") {
        return "topic\n";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "base123\n"
          : "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased branch topic onto base123.");
  assert.equal(result.branch, "topic");
  assert.equal(result.base, "base123");
  assert.deepEqual(result.commits, ["abc123"]);
  assert.equal(result.rebasedCount, 1);
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.detached, false);
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", "abc123", "refs/heads"],
    ["rev-list", "--reverse", "--topo-order", "--ancestry-path", "abc123..topic"],
    ["switch", "--detach", "base123"],
    ["cherry-pick", "--no-commit", "abc123"],
    ["commit", "-C", "abc123"],
    ["rev-parse", "HEAD"],
    ["branch", "-f", "topic", "rebased456"],
    ["switch", "topic"],
    ["rev-parse", "HEAD"],
  ]);
});

test("rebaseCommit rebases a selected commit onto the current checkout without a branch tip", async () => {
  const calls = [];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch" || command.args[0] === "for-each-ref") {
        return "";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "base123\n"
          : "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased abc123 onto base123.");
  assert.equal(result.branch, "");
  assert.equal(result.base, "base123");
  assert.deepEqual(result.commits, ["abc123"]);
  assert.equal(result.rebasedCount, 1);
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.detached, true);
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", "abc123", "refs/heads"],
    ["switch", "--detach", "base123"],
    ["cherry-pick", "--no-commit", "abc123"],
    ["commit", "-C", "abc123"],
    ["rev-parse", "HEAD"],
  ]);
});

test("rebaseCommit rebases a selected commit and descendants in order", async () => {
  const calls = [];
  const result = await rebaseCommit({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch") {
        return "main\n";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--points-at")) {
        return "";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--contains")) {
        return "topic\n";
      }

      if (command.args[0] === "rev-list") {
        return "def456\nghi789\n";
      }

      if (command.args[0] === "rev-parse") {
        return calls.filter((call) => call.args[0] === "rev-parse").length === 1
          ? "base123\n"
          : "rebased999\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm rebased branch topic (3 commits) onto main.");
  assert.equal(result.branch, "topic");
  assert.equal(result.base, "base123");
  assert.deepEqual(result.commits, ["abc123", "def456", "ghi789"]);
  assert.equal(result.rebasedCount, 3);
  assert.equal(result.currentHash, "rebased999");
  assert.equal(result.detached, false);
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", "abc123", "refs/heads"],
    ["rev-list", "--reverse", "--topo-order", "--ancestry-path", "abc123..topic"],
    ["switch", "--detach", "base123"],
    ["cherry-pick", "--no-commit", "abc123"],
    ["commit", "-C", "abc123"],
    ["cherry-pick", "--no-commit", "def456"],
    ["commit", "-C", "def456"],
    ["cherry-pick", "--no-commit", "ghi789"],
    ["commit", "-C", "ghi789"],
    ["rev-parse", "HEAD"],
    ["branch", "-f", "topic", "rebased999"],
    ["switch", "topic"],
    ["rev-parse", "HEAD"],
  ]);
});

test("rebaseCommit refuses to rebase the current checkout onto itself", async () => {
  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "(detached)",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async (command) => {
        if (command.args[0] === "status" || command.args[0] === "branch") {
          return "";
        }

        if (command.args[0] === "rev-parse") {
          return "abc123\n";
        }

        return "";
      },
    }),
    /already checked out/
  );
});

test("rebaseCommit refuses when the current checkout is inside the selected stack", async () => {
  await assert.rejects(
    rebaseCommit({
      graph: {
        label: "comm",
        path: "/repo/comm",
        branch: "main",
        knownHashes: new Set(["abc123"]),
      },
      hash: "abc123",
      runCommand: async (command) => {
        if (command.args[0] === "status") {
          return "";
        }

        if (command.args[0] === "branch") {
          return "main\n";
        }

        if (command.args[0] === "rev-parse") {
          return "def456\n";
        }

        if (command.args[0] === "for-each-ref" && command.args.includes("--points-at")) {
          return "";
        }

        if (command.args[0] === "for-each-ref" && command.args.includes("--contains")) {
          return "main\n";
        }

        if (command.args[0] === "rev-list") {
          return "def456\n";
        }

        return "";
      },
    }),
    /current checkout is inside the selected commit stack/
  );
});

test("pruneCommitBranches drops a commit from the current branch history", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "main",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--points-at")) {
        return "";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--contains")) {
        return "topic\nmain\n";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse") {
        return "rebased456\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from branch main.");
  assert.deepEqual(result.branches, ["main"]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "rebased456");
  assert.equal(result.branch, "main");
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", "abc123", "refs/heads"],
    ["rev-list", "--parents", "-n", "1", "abc123"],
    ["rebase", "--onto", "parent123", "abc123", "main"],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
  ]);
});

test("pruneCommitBranches drops a branch-tip commit without deleting the branch", async () => {
  const calls = [];
  const result = await pruneCommitBranches({
    graph: {
      label: "comm",
      path: "/repo/comm",
      branch: "(detached)",
      knownHashes: new Set(["abc123"]),
    },
    hash: "abc123",
    runCommand: async (command) => {
      calls.push(command);

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return calls.filter((call) => call.args[0] === "branch" && call.args[1] === "--show-current").length === 1
          ? ""
          : "main\n";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--points-at")) {
        return "main\n";
      }

      if (command.args[0] === "for-each-ref" && command.args.includes("--contains")) {
        return "main\n";
      }

      if (command.args[0] === "rev-list") {
        return "abc123 parent123\n";
      }

      if (command.args[0] === "rev-parse") {
        return "parent123\n";
      }

      return "";
    },
  });

  assert.equal(result.message, "comm pruned abc123 from branch main.");
  assert.deepEqual(result.branches, ["main"]);
  assert.equal(result.parent, "parent123");
  assert.equal(result.currentHash, "parent123");
  assert.equal(result.branch, "main");
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--points-at", "abc123", "refs/heads"],
    ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "--contains", "abc123", "refs/heads"],
    ["rev-list", "--parents", "-n", "1", "abc123"],
    ["rebase", "--onto", "parent123", "abc123", "main"],
    ["branch", "--show-current"],
    ["rev-parse", "HEAD"],
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

test("buildGraphHtml creates tabbed lane graph HTML", () => {
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
        workingTreeCount: 1,
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
  assert.match(html, /1 uncommitted change set/);
  assert.match(html, /data-index="0"/);
  assert.match(html, /data-index="1"/);
  assert.match(html, /class="summary" data-index="0"/);
  assert.match(html, /class="summary-branch"/);
  assert.match(html, /class="summary-working-tree"/);
  assert.match(html, /function renderGraph/);
  assert.match(html, /renderGraph\(0\)/);
  assert.match(html, /function showDiff/);
  assert.match(html, /id="commit-context-menu"/);
  assert.match(html, /data-action="checkout"/);
  assert.match(html, /data-action="rebase"/);
  assert.match(html, /data-action="prune"/);
  assert.match(html, /class="amend-commit" type="button" hidden>Amend<\/button>/);
  assert.match(html, /class="submit-commit" type="button" hidden>Submit<\/button>/);
  assert.match(html, /class="diff-message" hidden/);
  assert.match(html, /id="amend-dialog"/);
  assert.match(html, /class="amend-message"/);
  assert.match(html, /id="submit-dialog"/);
  assert.match(html, /class="submit-prompt"/);
  assert.match(html, /class="submit-links" hidden/);
  assert.match(html, /class="submit-output"/);
  assert.match(html, /class="workspace" data-index="0"/);
  assert.match(html, /class="pane-resizer"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-controls="graph-0 diff-0"/);
  assert.match(html, /class="diff-stats" hidden aria-label=""/);
  assert.match(html, /\.workspace \{ --graph-pane-width: 54%; display: grid/);
  assert.match(html, /\.pane-resizer \{[^}]*cursor: col-resize/);
  assert.match(html, /\.pane-resizer:hover::before/);
  assert.match(html, /body\.is-resizing-panes/);
  assert.match(html, /\.graph svg \{ overflow: visible; \}/);
  assert.match(html, /\.lane-path \{ fill: none; stroke-linecap: round/);
  assert.match(html, /\.commit-dot \{ stroke: #ffffff/);
  assert.match(html, /\.commit-hash, \.commit-message \{ dominant-baseline: central/);
  assert.match(html, /\.branch-label-bg \{ stroke-width: 1/);
  assert.match(html, /\.branch-label-text \{ dominant-baseline: central/);
  assert.match(html, /\.commit-row, \.commit-row \* \{ cursor: pointer; \}/);
  assert.match(html, /\.commit-row\.active \.commit-row-hitbox/);
  assert.match(html, /\.commit-row\.working-tree \.commit-row-hitbox/);
  assert.match(html, /\.commit-row\.current \.commit-row-hitbox/);
  assert.match(html, /\.context-menu button\[data-action="prune"\]/);
  assert.match(html, /\.checkout-commit, \.amend-commit, \.submit-commit, \.load-more/);
  assert.match(html, /\.amend-dialog \{/);
  assert.match(html, /\.amend-message \{/);
  assert.match(html, /\.submit-dialog \{/);
  assert.match(html, /\.submit-links a/);
  assert.match(html, /\.submit-output \{/);
  assert.match(html, /\.diff-placeholder/);
  assert.match(html, /\.diff-message \{/);
  assert.match(html, /\.diff-message a \{ color: #0969da; text-decoration: none; \}/);
  assert.match(html, /\.diff-message\[hidden\] \{ display: none; \}/);
  assert.match(html, /\.diff-table \{ border-collapse: collapse/);
  assert.match(html, /\.diff-line \{ height: 24px/);
  assert.match(html, /\.diff-line\.delete \.old-line/);
  assert.match(html, /\.diff-line\.insert \.line-code/);
  assert.match(html, /\.file-stats/);
  assert.match(html, /\.diff-stats/);
  assert.match(html, /\.line-marker/);
  assert.match(html, /\.line-number/);
  assert.match(html, /\.line-content \.hljs-keyword/);
  assert.match(html, /\.line-content \.hljs-string/);
  assert.match(html, /const COMMIT_DOT_RADIUS = 10/);
  assert.match(html, /const LANE_SPACING = 20/);
  assert.match(html, /const COMMIT_HASH_WIDTH = 116/);
  assert.match(html, /function normalizeBranchRef/);
  assert.match(html, /function getCommitBranchRefs/);
  assert.match(html, /function getPrioritizedCommitBranchRefs/);
  assert.match(html, /function getBranchColor/);
  assert.match(html, /function addBranchLabels/);
  assert.match(html, /function getLaneRows/);
  assert.match(html, /function renderLaneGraph/);
  assert.match(html, /function drawLaneContinuations/);
  assert.match(html, /function addLaneCommitRow/);
  assert.match(html, /fill: branchColor/);
  assert.match(html, /drawLanePath\(svg, index/);
  assert.match(html, /function centerBranchLabelsVertically/);
  assert.match(html, /function decorateCommitRows/);
  assert.match(html, /function showCommitContextMenu/);
  assert.match(html, /function runCommitAction/);
  assert.match(html, /function openAmendDialog/);
  assert.match(html, /function submitAmendDialog/);
  assert.match(html, /function openSubmitDialog/);
  assert.match(html, /function renderSubmitSession/);
  assert.match(html, /function answerSubmitPrompt/);
  assert.match(html, /submitOutput\.textContent = session\.output \|\| ""/);
  assert.match(html, /function isWorkingTreeCommit/);
  assert.match(html, /function getSnapshotFingerprint/);
  assert.match(html, /function refreshGraphFromServer/);
  assert.match(html, /function pollGraphUpdates/);
  assert.match(html, /function selectCommitActionResult/);
  assert.match(html, /function loadSelectedCommitMessage/);
  assert.match(html, /function setCommitMessage/);
  assert.match(html, /function getCommitMessageLinkUrl/);
  assert.match(html, /function getLinkedCommitMessageNodes/);
  assert.match(html, /const BUGZILLA_BUG_URL = "https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id="/);
  assert.match(html, /const PHABRICATOR_REVISION_URL = "https:\/\/phabricator\.services\.mozilla\.com\/D"/);
  assert.match(html, /const COMMIT_MESSAGE_LINK_PATTERN = /);
  assert.match(html, /document\.createTextNode/);
  assert.match(html, /document\.createElement\("a"\)/);
  assert.match(html, /BUGZILLA_BUG_URL \+ bugMatch\[1\]/);
  assert.match(html, /PHABRICATOR_REVISION_URL \+ phabMatch\[1\]/);
  assert.match(html, /link\.target = "_blank"/);
  assert.match(html, /link\.rel = "noreferrer"/);
  assert.match(html, /function formatCommitTitle/);
  assert.match(html, /Current staged, unstaged, and untracked changes/);
  assert.match(html, /!INTERACTIVE\.enabled \|\| isWorkingTreeCommit\(commit\)/);
  assert.match(html, /amendButton\.hidden = !INTERACTIVE\.enabled/);
  assert.match(html, /function startPaneResize/);
  assert.match(html, /function resizePaneFromKeyboard/);
  assert.match(html, /restoreGraphPaneWidth\(0\)/);
  assert.match(html, /resizer\.addEventListener\("pointerdown", startPaneResize\)/);
  assert.match(html, /function setDiffStats/);
  assert.match(html, /setDiffStats\(stats, result\)/);
  assert.match(html, /function isCurrentCommit/);
  assert.match(html, /const labelTranslate = getTranslate\(labelContainer\)/);
  assert.match(html, /graphStates\[index\]\.selectedHash = commit\.hash/);
  assert.match(html, /const commits = placeWorkingTreeCommits\(graph\.commits \? \[\.\.\.graph\.commits\] : \[\]\)/);
  assert.match(html, /currentHash: getCurrentCommitHash\(commits\)/);
  assert.match(html, /row\.classList\.toggle\("current", row\.dataset\.hash === currentHash\)/);
  assert.match(html, /graphStates\[graphIndex\]\.currentHash = hash/);
  assert.match(html, /\/api\/graph\/" \+ index \+ "\/snapshot/);
  assert.match(html, /setInterval\(pollGraphUpdates, INTERACTIVE\.pollIntervalMs\)/);
  assert.match(html, /\/api\/graph\/" \+ graphIndex \+ "\/message\/" \+ encodeURIComponent\(hash\)/);
  assert.match(html, /\/api\/graph\/" \+ index \+ "\/message\/" \+ encodeURIComponent\(commit\.hash\)/);
  assert.match(html, /loadSelectedCommitMessage\(index, commit, commitMessage\)/);
  assert.match(html, /\/api\/amend-message/);
  assert.match(html, /amendButton\.textContent = isWorkingTreeCommit\(commit\) \? "Amend" : "Amend Message"/);
  assert.match(html, /submitButton\.hidden = !INTERACTIVE\.enabled \|\| isWorkingTreeCommit\(commit\) \|\| !isCurrentCommit\(commit\)/);
  assert.match(html, /hash: amendDialogState\.hash/);
  assert.match(html, /expectedChangeId: amendDialogState\.changeId/);
  assert.match(html, /includeChanges: amendDialogState\.includeChanges/);
  assert.match(html, /selectCommitActionResult\(graphIndex, result\.rewrittenHash \|\| result\.currentHash, result\.message\)/);
  assert.match(html, /\/api\/submit/);
  assert.match(html, /\/api\/submit\/" \+ encodeURIComponent\(submitDialogState\.sessionId\)/);
  assert.match(html, /button\.dataset\.answer === "true"/);
  assert.match(html, /scheduleGraphEnhancements\(index\)/);
  assert.match(html, /Branch tips will check out the branch/);
  assert.match(html, /commitGroup\.addEventListener\("contextmenu"/);
  assert.match(html, /runCommitAction\(button\.dataset\.action, actionState\)/);
  assert.doesNotMatch(html, /orientation: GitgraphJS\.Orientation\.VerticalReverse/);
  assert.match(html, /renderLaneGraph\(index, pruneLoadedParents\(state\.commits\)\)/);
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
  assert.match(html, /\/api\/commit-action/);
  assert.match(html, /snapshotLimit: getLoadedGitCommitLimit\(graphStates\[graphIndex\]\)/);
  assert.match(html, /applyGraphSnapshot\(graphIndex, result\.snapshot, \{ force: true \}\)/);
  assert.match(html, /\/api\/close/);
  assert.match(html, /\/api\/ping/);
  assert.match(html, /beforeunload/);
  assert.match(html, /checkout-commit/);
  assert.match(html, /amend-commit/);
  assert.match(html, /submit-commit/);
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

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (command.args[0] === "for-each-ref") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });
  assert.equal(typeof serverInfo.server.shutdown, "function");

  const pageResponse = await fetch(serverInfo.url);
  assert.equal(await pageResponse.text(), "<!doctype html><p>graph</p>");

  const commitsResponse = await fetch(new URL("api/graph/0/commits?offset=0&limit=1&token=secret", serverInfo.url));
  const commits = await commitsResponse.json();
  assert.equal(commits.commits[0].hash, "abc123");

  const diffResponse = await fetch(new URL("api/graph/0/diff/abc123?token=secret", serverInfo.url));
  const diff = await diffResponse.json();
  assert.match(diff.html, /pretty-file/);
  assert.equal(diff.insertions, 1);
  assert.equal(diff.deletions, 1);

  const snapshotResponse = await fetch(new URL("api/graph/0/snapshot?limit=1&token=secret", serverInfo.url));
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.commitCount, 1);
  assert.equal(snapshot.commits[0].hash, "abc123");

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
  assert.equal(checkout.message, "comm checked out branch main at abc123.");
  assert.equal(checkout.snapshot.branch, "main");
  assert.equal(checkout.snapshot.commits[0].hash, "abc123");

  const rebaseResponse = await fetch(new URL("api/commit-action", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", graphIndex: 0, hash: "abc123", action: "rebase", snapshotLimit: 1 }),
  });
  const rebase = await rebaseResponse.json();
  assert.equal(rebase.message, "comm rebased branch main onto main.");
  assert.equal(rebase.currentHash, "def456");
  assert.equal(rebase.snapshot.branch, "main");
  assert.equal(rebase.snapshot.commits[0].hash, "abc123");

  const closePromise = new Promise((resolve) => serverInfo.server.once("close", resolve));
  const closeResponse = await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  assert.equal(closeResponse.ok, true);
  await closePromise;

  assert.equal(calls.some((call) => call.args[0] === "switch" && call.args[1] === "main"), true);
  assert.equal(calls.some((call) => call.args[0] === "switch" && call.args[1] === "--detach"), true);
  assert.equal(calls.some((call) => call.args[0] === "cherry-pick" && call.args[1] === "--no-commit"), true);
  assert.equal(calls.some((call) => call.args[0] === "commit" && call.args[1] === "-C"), true);
  assert.equal(calls.some((call) => call.args[0] === "branch" && call.args[1] === "-f" && call.args[2] === "main"), true);
});

test("interactive graph server amends current commit with edited message and refreshes", async (t) => {
  const calls = [];
  let amended = false;
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

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return amended
          ? "Bug 123 - New message. r=#reviewers\n\nNew body.\n"
          : "Bug 123 - Old message. r=#reviewers\n\nOld body.\n";
      }

      if (command.args[0] === "log") {
        return amended
          ? "\x1edef456\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - New message\n"
          : "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Old message\n";
      }

      if (command.args[0] === "diff") {
        return amended
          ? ""
          : "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
      }

      if (command.args[0] === "ls-files") {
        return "";
      }

      if (command.args[0] === "commit" && command.args[1] === "--amend") {
        amended = true;
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "def456\n";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const messageResponse = await fetch(new URL("api/graph/0/message/uncommitted-changes?token=secret", serverInfo.url));
  const currentMessage = await messageResponse.json();
  assert.equal(currentMessage.message, "Bug 123 - Old message. r=#reviewers\n\nOld body.\n");

  const amendResponse = await fetch(new URL("api/amend-message", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "secret",
      graphIndex: 0,
      hash: "uncommitted-changes",
      message: "Bug 123 - New message. r=#reviewers\n\nNew body.",
      includeChanges: true,
      snapshotLimit: 1,
    }),
  });
  const amend = await amendResponse.json();

  assert.equal(amend.ok, true);
  assert.equal(amend.message, "comm amended current commit def456.");
  assert.equal(amend.currentHash, "def456");
  assert.equal(amend.rewrittenHash, "def456");
  assert.equal(amend.snapshot.commits[0].hash, "def456");
  assert.equal(amend.snapshot.workingTreeCount, 0);
  assert.equal(calls.some((call) => call.args[0] === "add" && call.args[1] === "-A"), true);
  assert.equal(calls.some((call) => call.args[0] === "commit" && call.args[1] === "--amend" && call.args[2] === "-F"), true);

  const closePromise = new Promise((resolve) => serverInfo.server.once("close", resolve));
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
});

test("interactive graph server submits current commit through browser prompts", async (t) => {
  const calls = [];
  const comments = [];
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
    postComment: async (comment) => {
      comments.push(comment);
    },
    runCommand: async (command) => {
      calls.push(command);

      if (command.cmd === "moz-phab") {
        return "Submitted https://phabricator.services.mozilla.com/D123456\n";
      }

      if (command.cmd.endsWith("mach")) {
        return "Created try push: https://treeherder.mozilla.org/jobs?repo=try&revision=abc\n";
      }

      if (command.args[0] === "status") {
        return "";
      }

      if (command.args[0] === "branch" && command.args[1] === "--show-current") {
        return "main\n";
      }

      if (command.args[0] === "rev-parse") {
        return "abc123\n";
      }

      if (command.args[0] === "log" && command.args.includes("--format=%B")) {
        return "Bug 123 - Submit me. r=#reviewers\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456\n";
      }

      if (command.args[0] === "log") {
        return "\x1eabc123\x1f\x1fHEAD -> main\x1fAlice\x1falice@example.com\x1f1710000000\x1fBug 123 - Submit me\n";
      }

      if (command.args[0] === "diff" || command.args[0] === "ls-files") {
        return "";
      }

      return "";
    },
  });
  t.after(() => {
    if (serverInfo.server.listening) {
      serverInfo.server.close();
    }
  });

  const startResponse = await fetch(new URL("api/submit", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret", graphIndex: 0, hash: "abc123", snapshotLimit: 1 }),
  });
  const start = await startResponse.json();
  assert.equal(start.ok, true);

  const sessionUrl = new URL(`api/submit/${start.id}?token=secret`, serverInfo.url);
  let session = await waitForSubmitSession(sessionUrl, (item) => item.status === "prompt");
  assert.equal(session.prompt.message, "Do you want to run lint? [y/n]:");

  for (const answer of [false, false, true, true]) {
    const answerResponse = await fetch(new URL(`api/submit/${start.id}/answer`, serverInfo.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret", promptId: session.prompt.id, answer }),
    });
    assert.equal(answerResponse.ok, true);
    session = await waitForSubmitSession(
      sessionUrl,
      (item) => item.status === "prompt" || item.status === "complete" || item.status === "error"
    );

    if (session.status === "complete") {
      break;
    }

    assert.equal(session.status, "prompt");
  }

  assert.equal(session.status, "complete");
  assert.match(session.output, /\$ moz-phab submit/);
  assert.match(session.output, /Submitted https:\/\/phabricator\.services\.mozilla\.com\/D123456/);
  assert.match(session.output, /\$ \.\.\/mach try auto --artifact/);
  assert.match(session.output, /Created try push: https:\/\/treeherder\.mozilla\.org\/jobs\?repo=try&revision=abc/);
  assert.deepEqual(session.links, [
    {
      label: "D123456",
      url: "https://phabricator.services.mozilla.com/D123456",
    },
    {
      label: "Try",
      url: "https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
    },
  ]);
  assert.equal(session.snapshot.branch, "main");
  assert.equal(session.snapshot.commits[0].hash, "abc123");
  assert.deepEqual(comments, [{
    message: "try: https://treeherder.mozilla.org/jobs?repo=try&revision=abc",
    resolve: true,
    id: "123456",
  }]);
  assert.equal(calls.some((call) => call.cmd === "moz-phab" && call.cwd === "/repo/comm" && call.capture), true);
  assert.equal(calls.some((call) => call.cmd.endsWith("mach") && call.cwd === "/repo/comm" && call.args.join(" ") === "try auto --artifact"), true);

  const closePromise = new Promise((resolve) => serverInfo.server.once("close", resolve));
  await fetch(new URL("api/close", serverInfo.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "secret" }),
  });
  await closePromise;
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
  assert.equal(serverInfo.server.closeReason, "browser heartbeat timed out after 1 second");
});

test("waitForInteractiveServerClose routes signals through the interactive shutdown hook", async () => {
  const signals = new EventEmitter();
  const server = new EventEmitter();
  const calls = [];

  server.listening = true;
  server.shutdown = (delay, reason) => {
    calls.push({ delay, reason });
    server.closeReason = reason;
    server.listening = false;
    queueMicrotask(() => server.emit("close"));
  };
  server.close = () => {
    throw new Error("waitForInteractiveServerClose should use server.shutdown when available");
  };

  const wait = waitForInteractiveServerClose(server, signals);
  signals.emit("SIGINT");
  const closeReason = await wait;

  assert.equal(closeReason, "terminal signal received");
  assert.deepEqual(calls, [{ delay: 0, reason: "terminal signal received" }]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
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
