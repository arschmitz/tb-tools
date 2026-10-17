import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cancelGraphPatchUpdateSession, createGraphPatchUpdateSession, findGraphPatchCommit,
  getGraphPatchVerifyPrompt, prepareGraphPatchUpdateSession,
  serializeGraphPatchUpdateSession } from "../commands/graph/patch-update.mjs";
import { createPatchSessionStore } from "../commands/graph/patch-session-store.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

const message = "Bug 123456 - Preserve focus\n\nDifferential Revision: https://phabricator.services.mozilla.com/D123456";
const context = { purpose: "Preserve focus", behaviorContract: "Focus returns to the trigger",
  validation: "Source checked; runtime not run" };
const finding = { id: "focus", filePath: "mail/example.mjs", lineNumber: 1,
  content: "Focus is lost on close", recommendation: "change", assessment: "Restore focus on close",
  rationale: "The close path does not focus the trigger", validation: "Inspected close handler",
  requiresChanges: true, changeSummary: "Focus the trigger after close" };

function setup() {
  const graph = { path: "/work/comm", checkout: "working", repository: "comm", knownHashes: new Set() };
  const session = createGraphPatchUpdateSession({ graph, graphIndex: 0, revision: "D123456", mode: "verify", aiEnabled: true });
  return { graph, session };
}

test("Update prepares source without building before the first instruction", async () => {
  const { graph } = setup();
  const session = createGraphPatchUpdateSession({ graph, graphIndex: 0, revision: "D123456", mode: "freeform", aiEnabled: true });
  session.managedWorktree = true;
  await prepareGraphPatchUpdateSession({ session, graphs: [graph],
    findPatchCommit: async () => ({ hash: "selected", message }),
    assertSafeWorktree: async () => {},
    getReview: async () => ({ comments: [], transactions: [] }),
    getSnapshot: async () => ({ commits: [] }),
    prepareBuild: async () => assert.fail("Update must not build before input"),
    runCodexTask: async () => assert.fail("Update must wait for input"),
    runCommand: async ({ args }) => args[0] === "rev-parse" ? "selected" : "",
  });
  assert.equal(session.status, "review");
  assert.equal(session.requireLocalBuild, false);
});

test("Verify selects the newest exact revision across branches, including detached HEAD", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verify-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args, date = "2026-01-01T12:00:00Z") => execFileSync("git", args, { cwd: directory,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init"]);
  git(["commit", "--allow-empty", "-m", message]);
  git(["branch", "older"]);
  git(["checkout", "--detach"]);
  git(["commit", "--amend", "--allow-empty", "-m", message], "2026-02-01T12:00:00Z");
  const newest = git(["rev-parse", "HEAD"]);
  git(["branch", "newer"]);
  git(["commit", "--allow-empty", "-m", message.replaceAll("D123456", "D1234567")], "2026-03-01T12:00:00Z");
  const found = await findGraphPatchCommit({ graph: { path: directory }, revision: "D123456", newest: true,
    runCommand: async ({ args }) => git(args) });
  assert.equal(found.hash, newest);
  git(["checkout", "--detach", newest]);
  git(["branch", "-D", "newer"]);
  assert.equal((await findGraphPatchCommit({ graph: { path: directory }, revision: "D123456", newest: true,
    runCommand: async ({ args }) => git(args) })).hash, newest);
});

for (const alreadyCurrent of [true, false]) {
  test(`Verify reviews without rebasing and checks out only when needed: ${alreadyCurrent}`, async () => {
    const { graph, session } = setup();
    let checkouts = 0;
    await prepareGraphPatchUpdateSession({ session, graphs: [graph],
      findPatchCommit: async (options) => { assert.equal(options.newest, true); return { hash: "newest", message }; },
      assertSafeWorktree: async () => {},
      updateCheckout: async () => assert.fail("Verify must not update repositories"),
      rebasePatch: async () => assert.fail("Verify must not rewrite the patch before review"),
      getReview: async () => assert.fail("Verify must run even without reviewer comments"),
      checkoutPatch: async ({ hash, graph: target }) => { assert.equal(hash, "newest"); assert.equal(target, graph); checkouts++; return { branch: "latest" }; },
      getSnapshot: async () => ({ commits: [] }),
      runCommand: async ({ args, cwd }) => { assert.equal(cwd, graph.path); return args[0] === "rev-parse" ? (alreadyCurrent ? "newest" : "other") : ""; },
      runCodexTask: async ({ prompt }) => {
        assert.match(prompt, /coequal accessibility review/);
        assert.match(prompt, /coderabbit review --agent --committed/);
        assert.match(prompt, /Do not edit source/);
        return { sessionId: "verify-thread", message: JSON.stringify({ patchContext: context, comments: [finding] }) };
      },
    });
    assert.equal(checkouts, alreadyCurrent ? 0 : 1);
    assert.equal(session.status, "review");
    assert.equal(session.items[0].type, "finding");
    assert.equal(session.items[0].parentCommentPHID, "");
    assert.equal(session.items[0].requiresChanges, true);
    assert.equal(session.items[0].changeApplied, false);
    assert.equal(serializeGraphPatchUpdateSession(session).mode, "verify");
  });
}

test("Verify preserves dirty working checkout before any switch or AI turn", async () => {
  const { graph, session } = setup();
  await assert.rejects(prepareGraphPatchUpdateSession({ session, graphs: [graph],
    findPatchCommit: async () => ({ hash: "newest", message }), assertSafeWorktree: async () => {},
    runCommand: async ({ args }) => args[0] === "status" ? " M source.mjs" : "",
    checkoutPatch: async () => assert.fail("must preserve dirty checkout"),
    runCodexTask: async () => assert.fail("must not start AI"),
  }), /working checkout changes/);
  assert.equal(session.status, "error");
});

test("Verify and Review Update keep separate saved results", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verify-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createPatchSessionStore({ directory });
  const { session } = setup();
  Object.assign(session, { currentHash: "abc", status: "review", items: [finding] });
  store.save("update", session);
  const update = { ...session, id: "update", mode: "update", items: [] };
  store.save("update", update);
  assert.deepEqual(store.load("update", session).items, [finding]);
  assert.deepEqual(store.load("update", update).items, []);
  assert.match(getGraphPatchVerifyPrompt(session), /full self review/);
});

test("Verify API routes to working, blocks comments, and keeps handled findings local", async (t) => {
  let preparations = 0;
  const { graph } = setup();
  const info = await startInteractiveGraphServer({ graphs: [{ ...graph, path: "/review/comm", checkout: "review" }, graph],
    html: "", token: "test", appConfig: { ai: { enabled: true } },
    runCommand: async () => "", savePatchUpdateMemory: async () => {},
    persistPatchUpdateHandledComment: async () => assert.fail("Verify must not mark a reviewer comment handled"),
    phabWebSession: { postInlineReply: async () => assert.fail("must not post"), markInlineCommentDone: async () => assert.fail("must not mark remote comments") },
    preparePatchUpdateSession: async ({ session }) => {
      preparations++;
      assert.equal(session.graph.path, "/work/comm");
      Object.assign(session, { currentHash: "abc", status: "review", patchContext: context,
        items: [{ ...finding, type: "finding", state: "ready" }] });
    },
  });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const post = async (url, body) => {
    const response = await fetch(new URL(url, info.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test", ...body }) });
    return { status: response.status, data: await response.json() };
  };
  const { data: verify } = await post("/api/patch-update", { graphIndex: 0, revision: "D123456", mode: "verify" });
  assert.equal(verify.mode, "verify");
  assert.equal(verify.graphIndex, 1);
  const update = await post("/api/patch-update", { graphIndex: 0, revision: "D123456" });
  assert.equal(update.data.resumeAvailable, undefined);
  assert.notEqual(update.data.id, verify.id);
  assert.equal(preparations, 2);
  assert.equal((await post(`/api/patch-update/${verify.id}/comment`, { itemId: "focus", message: "post" })).status, 409);
  const handled = await post(`/api/patch-update/${verify.id}/handled`, { itemId: "focus" });
  assert.equal(handled.status, 200);
  assert.equal(handled.data.items[0].state, "handled");
  assert.equal(handled.data.currentItemIndex, 1);
});

for (const comments of [[], undefined]) {
  test(`Verify distinguishes no findings from a missing result: ${comments === undefined ? "missing" : "empty"}`, async () => {
    const { graph, session } = setup();
    const prepare = () => prepareGraphPatchUpdateSession({ session, graphs: [graph],
      findPatchCommit: async () => ({ hash: "head", message }), assertSafeWorktree: async () => {},
      getSnapshot: async () => ({}), runCommand: async ({ args }) => args[0] === "rev-parse" ? "head" : "",
      runCodexTask: async () => ({ message: JSON.stringify({ patchContext: context, comments }) }),
    });
    if (comments === undefined) {
      await assert.rejects(prepare(), /findings array/);
      assert.equal(session.status, "error");
    } else {
      await prepare();
      assert.equal(session.status, "review");
      assert.deepEqual(session.items, []);
      assert.match(session.message, /no actionable issues/);
    }
  });
}

test("Verify resume refreshes a newer local copy in its saved conversation", async (t) => {
  let newest = "old";
  let calls = 0;
  const { graph } = setup();
  const info = await startInteractiveGraphServer({ graphs: [graph], html: "", token: "test",
    appConfig: { ai: { enabled: true } }, savePatchUpdateMemory: async () => {},
    runCommand: async ({ args }) => {
      if (args[0] === "rev-parse") return "old";
      if (args[0] === "log") return args.includes("-1") ? message : `${newest} 123`;
      return "";
    },
    preparePatchUpdateSession: async ({ session }) => {
      if (++calls === 2) {
        assert.equal(session.codexSessionId, "saved-verify");
        assert.equal(session.refreshAfterCheckoutUpdate, true);
      }
      Object.assign(session, { status: "review", currentHash: newest, codexSessionId: "saved-verify" });
    },
  });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const post = async () => (await fetch(new URL("/api/patch-update", info.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", graphIndex: 0, revision: "D123456", mode: "verify", resume: true }),
  })).json();
  const first = await post();
  newest = "new";
  const second = await post();
  assert.equal(second.id, first.id);
  assert.equal(second.currentHash, "new");
  assert.equal(calls, 2);
});


test("Local Verify and Update select the exact commit without a Phabricator ID", async () => {
  const hash = "2135bbdeb7dd3feafb298c0220b412a66cc41826";
  const graph = { path: "/work/comm", checkout: "working", repository: "comm" };
  for (const mode of ["verify", "freeform"]) {
    const session = createGraphPatchUpdateSession({ graph, revision: hash.toUpperCase(), mode, aiEnabled: true });
    assert.equal(session.revision, hash);
    assert.match(session.codexThreadName, /^2135bbdeb7dd - /);
    const commands = [];
    const found = await findGraphPatchCommit({ graph, revision: session.revision, newest: true,
      runCommand: async ({ args }) => {
        commands.push(args);
        return args[0] === "rev-parse" ? hash : "Bug 2061199 - Add writable calendar selection";
      } });
    assert.equal(found.hash, hash);
    assert.equal(found.revision, hash);
    assert.deepEqual(commands[0], ["rev-parse", "--verify", `${hash}^{commit}`]);
    assert.equal(commands.some(args => args.some(arg => arg.startsWith("--grep="))), false);
  }
  assert.throws(() => createGraphPatchUpdateSession({ graph, revision: hash, mode: "update", aiEnabled: true }),
    /Review Update requires a Phabricator revision/);
});


test("Local Verify resumes its amended commit without reverting to the original hash", async (t) => {
  const original = "2135bbdeb7dd3feafb298c0220b412a66cc41826";
  const amended = "a".repeat(40);
  let calls = 0;
  const { graph } = setup();
  const info = await startInteractiveGraphServer({ graphs: [graph], html: "", token: "test",
    appConfig: { ai: { enabled: true } }, savePatchUpdateMemory: async () => {},
    runCommand: async ({ args }) => {
      if (args[0] === "rev-parse") return amended;
      if (args[0] === "log") assert.fail("A local Verify resume must retain its amended commit");
      return "";
    },
    preparePatchUpdateSession: async ({ session }) => {
      calls++;
      Object.assign(session, { status: "review", currentHash: amended, codexSessionId: "saved-local" });
    },
  });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const post = async () => (await fetch(new URL("/api/patch-update", info.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", graphIndex: 0, revision: original, mode: "verify", resume: true }),
  })).json();
  const first = await post();
  const second = await post();
  assert.equal(second.id, first.id);
  assert.equal(second.currentHash, amended);
  assert.equal(calls, 1);
});


test("Cancel interrupts the running update and keeps unfinished changes", async () => {
  const { session } = setup();
  const calls = [];
  const candidate = { id: "edit", changeApplied: true, changesAmended: false };
  session.items = [candidate];
  session.status = "applying";
  session.freeformOperationRunning = true;
  session.freeformOperationStatus = "applying";
  session.codexTurnId = "turn";
  session.codexAgent = { threadId: "thread", client: {
    interruptTurn: async value => calls.push(value), close: () => calls.push("closed"),
  } };
  await cancelGraphPatchUpdateSession({ session });
  assert.deepEqual(calls, [{ threadId: "thread", turnId: "turn" }, "closed"]);
  assert.equal(session.abortController.signal.aborted, true);
  assert.equal(session.items[0], candidate);
  session.status = "review";
  const result = serializeGraphPatchUpdateSession(session);
  assert.equal(result.status, "cancelled");
  assert.match(result.message, /Unfinished edits are kept/);
  await cancelGraphPatchUpdateSession({ session });
  assert.equal(calls.length, 2);
});


test("Cancel API aborts preparation and stays cancelled after the callback ends", async (t) => {
  const { graph } = setup();
  let prepared;
  const info = await startInteractiveGraphServer({ graphs: [graph], html: "", token: "test",
    appConfig: { ai: { enabled: true } }, savePatchUpdateMemory: async () => {},
    runCommand: async () => "",
    preparePatchUpdateSession: async ({ session }) => {
      prepared = session;
      await new Promise(resolve => session.abortController.signal.addEventListener("abort", resolve, { once: true }));
      session.status = "complete";
    } });
  t.after(() => new Promise(resolve => info.server.close(resolve)));
  const post = async (route, body) => (await fetch(new URL(route, info.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", ...body }),
  })).json();
  const started = await post("/api/patch-update", { graphIndex: 0, revision: "D123456", mode: "freeform" });
  const stopped = await post(`/api/patch-update/${started.id}/cancel`, {});
  assert.equal(stopped.status, "cancelled");
  assert.equal(prepared.abortController.signal.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
  const status = await (await fetch(new URL(`/api/patch-update/${started.id}?token=test`, info.url))).json();
  assert.equal(status.status, "cancelled");
  const rejected = await post(`/api/patch-update/${started.id}/steer`, { instruction: "Continue" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /cancelled/);
});
