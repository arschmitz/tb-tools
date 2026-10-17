import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphTrySession, serializeGraphTrySession } from "../commands/graph/actions.mjs";

for (const fail of [false, true]) test(`Try returns a session while checkout preparation waits (${fail})`, async () => {
  let finishPreparation, ranCommand = false;
  const prepared = new Promise(resolve => { finishPreparation = resolve; });
  const session = createGraphTrySession({ graph: { path: "/source", label: "comm" }, graphIndex: 0,
    prepareCheckout: async () => {
      await prepared;
      if (fail) throw new Error("Source changed during preparation.");
      return { graph: { path: "/task/comm", label: "comm" } };
    },
    runCommand: async () => { ranCommand = true; throw new Error("Submission reached prepared checkout."); },
  });
  const initial = serializeGraphTrySession(session);
  assert.ok(initial.id, "A pending checkout should have a pollable session ID.");
  assert.equal(initial.status, "running", "A pending checkout should report running status.");
  assert.equal(initial.phase, "preparing", "A pending checkout should report its preparation phase.");
  await Promise.resolve();
  assert.equal(ranCommand, false, "Submission should wait for checkout preparation.");
  finishPreparation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status, "error", "A preparation or command failure should finish the session with an error.");
  if (fail) {
    assert.equal(ranCommand, false, "A preparation failure should prevent Try submission.");
    assert.match(session.error, /Source changed/, "The session should expose the preparation error.");
  } else {
    assert.equal(session.path, "/task/comm", "The session should use the prepared checkout path.");
    assert.equal(ranCommand, true, "Submission should start after checkout preparation completes.");
  }
});

test("the Try HTTP endpoint responds before isolated checkout preparation finishes", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { startInteractiveGraphServer } = await import("../commands/graph/server.mjs");
  let server, directory, release;
  t.after(async () => {
    release?.();
    if (server) await new Promise(resolve => server.server.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  directory = await mkdtemp(path.join(tmpdir(), "tb-try-start-"));
  const pending = new Promise(resolve => { release = resolve; });
  server = await startInteractiveGraphServer({ html: "<p>Try</p>", token: "secret", tryMonitor: null,
    appConfig: { taskWorktrees: true }, taskWorktreeDirectory: id => path.join(directory, id),
    graphs: [{ label: "comm", path: "/source/comm", repository: "comm", checkout: "working", commits: [] },
      { label: "firefox", path: "/source", repository: "firefox", checkout: "working", commits: [] }],
    runCommand: async () => { await pending; throw new Error("Preparation stopped by test."); } });
  const response = await fetch(new URL("api/try", server.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret", graphIndex: 0 }) });
  const session = await response.json();
  assert.equal(response.status, 200, "Try startup should return before the preparation command finishes.");
  assert.equal(session.phase, "preparing", "The HTTP response should expose checkout preparation.");
  assert.ok(session.id, "The HTTP response should provide an ID for status polling.");
  release();
});
