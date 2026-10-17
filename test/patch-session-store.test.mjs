import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPatchSessionStore, assertPatchSessionCheckout, shouldResumeReviewAfterRestart } from "../commands/graph/patch-session-store.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("restart retains a review interrupted before its patch or AI turn is ready", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patch-pull-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graph = { path: "/removed/task/comm", taskWorktree: true, taskId: "task" };
  for (const currentHash of ["", "base-head"]) {
    const session = { id: "task", revision: "D332225", graph, repositoryPath: "/repo/comm",
      managedWorktree: true, status: "pulling", currentHash, codexSessionId: "", cancelled: false };
    createPatchSessionStore({ directory }).save("review", session);
    const store = createPatchSessionStore({ directory });
    const loaded = store.list([{ path: "/repo/comm" }]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].session.interrupted, true);
    assert.equal(loaded[0].session.revision, "D332225");
    assert.equal(store.load("review", session).interrupted, true);
  }
});

test("cancellation survives restart and suppresses older copies of the same review", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "review-cancel-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createPatchSessionStore({ directory });
  const session = { id: "older", revision: "D123", repositoryPath: "/repo/comm", managedWorktree: true,
    graph: { path: "/old/comm", taskWorktree: true }, status: "pulling" };
  store.save("review", session);
  await new Promise(resolve => setTimeout(resolve, 5));
  const current = { ...session, id: "current", graph: { path: "/current/comm", taskWorktree: true } };
  store.save("review", current);
  current.cancelled = true; current.status = "cancelled";
  store.save("review", current);
  const loaded = createPatchSessionStore({ directory }).list([{ path: "/repo/comm" }], { includeFinished: true });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].session.id, "current");
  assert.equal(loaded[0].session.status, "cancelled");
  assert.equal(loaded[0].session.resumeOnRestart, false);
  assert.equal(createPatchSessionStore({ directory }).load("review", { ...current, aiEnabled: true }), null);
});

test("restart resumes active reviews but keeps dismissed and old saved reviews inactive", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patch-dismiss-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graph = { path: "/task/comm", taskWorktree: true, repositoryPath: "/repo/comm" };
  const session = { id: "task", revision: "D123", graph, repositoryPath: "/repo/comm", managedWorktree: true,
    status: "pulling", cancelled: false };
  assert.equal(shouldResumeReviewAfterRestart(session), true);
  for (const extra of [{ dismissed: true }, { restored: true }, { cancelled: true }, { status: "posting" }, { status: "review" }]) {
    assert.equal(shouldResumeReviewAfterRestart({ ...session, ...extra }), false);
  }
  const store = createPatchSessionStore({ directory });
  store.save("review", session);
  let loaded = createPatchSessionStore({ directory }).list([{ path: "/repo/comm" }]);
  assert.equal(loaded[0].session.resumeOnRestart, true);
  session.dismissed = true;
  store.save("review", session);
  loaded = createPatchSessionStore({ directory }).list([{ path: "/repo/comm" }]);
  assert.equal(loaded[0].session.dismissed, true);
  assert.equal(loaded[0].session.resumeOnRestart, false);
});

test("server restart recovers one active review and retains dismissal across another restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "review-recovery-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graphs = [{ path: "/repo/comm", repository: "comm", checkout: "working" },
    { path: "/repo", repository: "firefox", checkout: "working" }];
  const store = createPatchSessionStore({ directory });
  for (const [id, extra] of [["active", {}], ["dismissed", { dismissed: true }], ["old", { restored: true }]]) {
    store.save("review", { id, revision: `D${id === "active" ? 123 : id === "old" ? 124 : 125}`,
      graph: { ...graphs[0], path: `/tasks/${id}/comm`, taskWorktree: true }, repositoryPath: "/repo/comm",
      managedWorktree: true, status: "pulling", cancelled: false, ...extra });
  }
  const prepared = [];
  const start = () => startInteractiveGraphServer({ graphs, html: "", token: "test",
    appConfig: { taskWorktrees: true, ai: { enabled: true } }, patchSessionDirectory: directory,
    runCommand: async () => "same-head", prepareTaskBuild: false,
    preparePatchReviewSession: async ({ session }) => {
      prepared.push(session.id); session.currentHash = "same-head"; session.codexSessionId = "thread";
      session.status = "reviewing"; session.restored = false; session.interrupted = false;
    },
  });
  let info = await start();
  t.after(async () => { if (info.server.listening) await new Promise(resolve => info.server.close(resolve)); });
  for (let n = 0; !prepared.length && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(prepared, ["active"]);
  const response = await fetch(new URL("/api/background-jobs/dismiss", info.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", kind: "review", id: "active" }),
  });
  assert.equal(response.status, 200);
  await new Promise(resolve => info.server.close(resolve));
  info = await start();
  const result = await (await fetch(new URL("/api/background-jobs?token=test", info.url))).json();
  assert.equal(result.jobs.some(job => job.id === "Review:active"), false);
  assert.deepEqual(prepared, ["active"]);
});

for (const error of [
  "Selected model is at capacity. Please try a different model.",
  "Code evidence check stopped this task: Evidence is incomplete: Build validation needs a separate authorized runner.",
  "The AI connection closed during review.",
]) {
  test(`resuming a failed review starts a new Codex turn: ${error}`, async (t) => {
    let retries = 0;
    const rawPatch = "same patch";
    const info = await startInteractiveGraphServer({
      graphs: [{ path: "/review/comm", checkout: "review", repository: "comm" }],
      html: "", token: "test", appConfig: { ai: { enabled: true } },
      runCommand: async () => "same-head",
      phabWebSession: { getReview: async () => ({ rawPatch, comments: [], inlineComments: [] }) },
      preparePatchReviewSession: async ({ session }) => {
        session.currentHash = "same-head";
        session.rawPatchHash = createHash("sha256").update(rawPatch).digest("hex");
        session.codexSessionId = "saved-thread";
        session.status = "error";
        session.error = error;
      },
      retryPatchReviewSession: ({ session }) => {
        retries++;
        session.status = "reviewing";
        session.error = "";
      },
    });
    t.after(() => new Promise(resolve => info.server.close(resolve)));
    const post = async (resume) => (await fetch(new URL("/api/review", info.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test", revision: "D330263", resume }),
    })).json();

    await post(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await post()).resumeAvailable, true, "The failed review should offer its saved conversation");
    const resumed = await post(true);
    assert.equal(resumed.status, "reviewing", "The failed review should start another AI turn");
    assert.equal(resumed.error, "", "The retry should clear the previous error");
    assert.equal(retries, 1, "The saved review should be retried once");
    assert.equal((await post(true)).status, "reviewing", "A second resume should return the active retry");
    assert.equal(retries, 1, "The saved review should be retried once");
  });

}

test("review resume refreshes a changed remote patch in the saved conversation", async (t) => {
  let rawPatch = "old patch";
  let preparations = 0;
  let release;
  let refreshed;
  let agentClosed = false;
  const info = await startInteractiveGraphServer({
    graphs: [{ path: "/review/comm", checkout: "review", repository: "comm" }],
    html: "", token: "test", appConfig: { ai: { enabled: true } },
    runCommand: async () => "same-head",
    phabWebSession: { getReview: async () => ({ rawPatch, comments: [], inlineComments: [] }) },
    preparePatchReviewSession: async ({ session, getRevisionReview }) => {
      preparations++;
      if (preparations > 1) {
        refreshed = session;
        assert.equal(session.codexSessionId, "saved-thread");
        assert.equal(agentClosed, true);
        assert.equal(session.codexAgent, null);
        assert.deepEqual(session.resumeReviewContext.issues, [{ id: "old-finding" }]);
        assert.deepEqual(session.issues, []);
        assert.equal((await getRevisionReview({ revision: session.revision })).rawPatch, "new patch");
        await new Promise((resolve) => { release = resolve; });
      }
      session.currentHash = "same-head";
      session.rawPatchHash = createHash("sha256").update(rawPatch).digest("hex");
      session.codexSessionId = "saved-thread";
      session.codexAgent = { client: { close: () => { agentClosed = true; } } };
      session.issues = [{ id: preparations === 1 ? "old-finding" : "new-finding" }];
      session.status = "review";
    },
  });
  t.after(() => new Promise((resolve) => info.server.close(resolve)));
  const post = async () => (await fetch(new URL("/api/review", info.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test", revision: "D324796", resume: true }),
  })).json();
  const original = await post();
  rawPatch = "new patch";
  const resumed = await post();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.id, original.id);
  assert.equal(resumed.status, "pulling");
  assert.deepEqual(resumed.issues, []);
  assert.equal((await post()).id, original.id);
  assert.equal(preparations, 2);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed.status, "review");
  assert.deepEqual(refreshed.issues, [{ id: "new-finding" }]);
});

test("saved patch sessions keep output and findings, not process objects", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patch-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graph = { path: "/work/comm" };
  const session = {
    id: "saved", revision: "D123", graph, status: "review", currentHash: "abc",
    output: "Last output", activity: [{ kind: "note", detail: "Last note" }],
    items: [{ id: "one", state: "skipped", suggestedReply: "My edited reply" }],
    codexSessionId: "thread", codexAgent: { client: { circular: null } },
    codexTurnId: "old-turn", abortController: new AbortController(),
    changeSnapshots: new Map([["one", { before: { treeish: "base" }, after: { treeish: "edit" } }]]),
  };
  session.codexAgent.client.circular = session.codexAgent;
  createPatchSessionStore({ directory }).save("update", session);
  const loaded = createPatchSessionStore({ directory }).load("update", { ...session, graphIndex: 4 });
  assert.equal(loaded.output, "Last output");
  assert.deepEqual(loaded.items, session.items);
  assert.deepEqual(loaded.changeSnapshots, session.changeSnapshots);
  assert.deepEqual(loaded.activity, session.activity);
  assert.equal(loaded.codexSessionId, "thread");
  assert.equal(loaded.codexAgent, null);
  assert.equal(loaded.codexTurnId, "");
  assert.equal(loaded.graphIndex, 4);
  assert.equal(loaded.interrupted, false);
  assert.equal(createPatchSessionStore({ directory }).load("review", session), null);
  await assert.rejects(assertPatchSessionCheckout(loaded, async () => "different"), /different commit/);
  await assertPatchSessionCheckout(loaded, async () => "abc\n");
});

test("failed preparation cannot replace a saved Codex conversation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patch-session-preserve-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = { id: "original", graph: { path: "/review/comm" }, revision: "D323799",
    status: "review", currentHash: "parent", codexSessionId: "original-thread", output: "Previous findings" };
  const store = createPatchSessionStore({ directory });
  store.save("review", saved);
  const failed = { ...saved, id: "failed", status: "error", currentHash: "child", codexSessionId: "", output: "Wrong checkout" };
  store.save("review", failed);
  const loaded = createPatchSessionStore({ directory }).load("review", failed);
  assert.equal(loaded.codexSessionId, "original-thread");
  assert.equal(loaded.currentHash, "parent");
  assert.equal(loaded.output, "Previous findings");
});

for (const kind of ["update", "review"]) {
  test(`${kind} resumes across servers without another preparation pass`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "patch-resume-server-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let preparations = 0;
    let head = "abc";
    let base = "base-one";
    const graphs = [
      { path: "/work/comm", checkout: "working", repository: "comm", commits: [] },
      { path: "/review/comm", checkout: "review", repository: "comm", commits: [] },
      { path: "/review", checkout: "review", repository: "firefox", commits: [] },
    ];
    const prepare = async ({ session }) => {
      preparations++;
      session.currentHash = head;
      session.baseHash = base;
      session.codexSessionId = "saved-thread";
      session.status = "review";
      session.output = "Last saved output";
      session.activity = [{ kind: "note", title: "Codex note", detail: "Last saved note" }];
    };
    const start = () => startInteractiveGraphServer({
      graphs, html: "", token: "test", appConfig: { ai: { enabled: true } },
      patchSessionDirectory: directory,
      preparePatchUpdateSession: prepare, preparePatchReviewSession: prepare,
      runCommand: async ({ args }) => args[1] === "origin/main" ? base : head,
    });
    let info = await start();
    t.after(async () => { if (info.server.listening) await new Promise((resolve) => info.server.close(resolve)); });
    const post = async (resume) => {
      const response = await fetch(new URL(kind === "update" ? "/api/patch-update" : "/api/review", info.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "test", revision: "D123", graphIndex: 0, ...(resume === undefined ? {} : { resume }) }),
      });
      return response.json();
    };
    assert.equal((await post()).ok, true);
    assert.equal(preparations, 1);
    await new Promise((resolve) => info.server.close(resolve));
    info = await start();
    assert.equal((await post()).resumeAvailable, true);
    const restored = await post(true);
    assert.equal(restored.output, "Last saved output");
    assert.equal(restored.activity[0].detail, "Last saved note");
    assert.equal(preparations, 1);
    if (kind === "update") {
      base = "base-two";
      const afterBaseUpdate = await post(true);
      assert.equal(preparations, 2);
      assert.equal(afterBaseUpdate.currentHash, "abc");
    }
    head = "wrong";
    const afterCheckoutUpdate = await post(true);
    if (kind === "update") {
      assert.equal(preparations, 3);
      assert.equal(afterCheckoutUpdate.currentHash, "wrong");
      assert.equal((await post(true)).currentHash, "wrong");
    } else {
      assert.equal(preparations, 2);
      assert.equal(afterCheckoutUpdate.id, restored.id);
      assert.equal(afterCheckoutUpdate.currentHash, "wrong");
      assert.equal((await post(true)).currentHash, "wrong");
    }
  });
}
