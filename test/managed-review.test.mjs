import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { createGraphPatchReviewSession, prepareGraphPatchReviewSession } from "../commands/graph/patch-review.mjs";

const graphs = [
  { checkout: "working", repository: "firefox", path: "/working", label: "Working firefox" },
  { checkout: "working", repository: "comm", path: "/working/comm", label: "Working comm" },
  { checkout: "review", repository: "firefox", path: "/review", label: "Review firefox" },
  { checkout: "review", repository: "comm", path: "/review/comm", label: "Review comm" },
];

test("desktop reviews of different revisions use different worktrees", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "managed-reviews-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const startedSessions = [];
  const started = await startInteractiveGraphServer({ graphs, html: "<html></html>", token: "secret",
    appConfig: { managedReviewWorktrees: "12345678" }, patchSessionDirectory: directory,
    preparePatchReviewSession: async ({ session }) => { startedSessions.push(session); },
    getRustUpstreamStatus: async () => ({ state: "current" }) });
  t.after(() => new Promise(resolve => started.server.close(resolve)));
  const start = revision => fetch(new URL("/api/review", started.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret", revision }) });
  assert.equal((await start("D100001")).status, 200);
  assert.equal((await start("D100002")).status, 200);
  assert.equal(startedSessions.length, 2);
  assert.notEqual(startedSessions[0].graph.path, startedSessions[1].graph.path);
  assert.equal(startedSessions[0].reviewFirefoxPath, path.dirname(startedSessions[0].graph.path));
  assert.equal(startedSessions[1].reviewFirefoxPath, path.dirname(startedSessions[1].graph.path));
  assert.equal(startedSessions[0].managedWorktree, true);
  assert.equal((await start("D100001")).status, 200);
  assert.equal(startedSessions.length, 2);
});

test("managed review detaches at main so another worktree can use that branch", async () => {
  const session = createGraphPatchReviewSession({ graphs, revision: "D100003", aiEnabled: false });
  session.managedWorktree = true;
  const calls = [];
  let prepared = false;
  await prepareGraphPatchReviewSession({ session, prepareCheckout: async () => { prepared = true; },
    getSnapshot: async () => ({ branch: "(detached)", commits: [] }),
    getRevisionReview: async () => ({ rawPatch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n" }),
    makeTempDirectory: async () => "/tmp/managed-review-test",
    writeRawPatch: async () => {},
    runCommand: async command => {
      calls.push(command);
      if (command.cmd === "git" && command.args[0] === "rev-parse") return "a".repeat(40);
      if (command.cmd === "git" && command.args[0] === "log" && command.args[1] === "-1") {
        return "Differential Revision: https://phabricator.services.mozilla.com/D100003";
      }
      if (command.cmd === "git" && command.args[0] === "branch") return "";
      return "";
    },
  });
  assert.equal(prepared, true);
  assert.deepEqual(calls.find(command => command.args[0] === "switch").args,
    ["switch", "--detach", "main"]);
  assert.equal(session.status, "complete");
});
