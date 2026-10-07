import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPatchSessionStore, assertPatchSessionCheckout } from "../commands/graph/patch-session-store.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("resuming a capacity-failed review starts a new Codex turn", async (t) => {
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
      session.error = "Selected model is at capacity. Please try a different model.";
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
  assert.equal((await post()).resumeAvailable, true);
  const resumed = await post(true);
  assert.equal(resumed.status, "reviewing");
  assert.equal(resumed.error, "");
  assert.equal(retries, 1);
  assert.equal((await post(true)).status, "reviewing");
  assert.equal(retries, 1);
});

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
