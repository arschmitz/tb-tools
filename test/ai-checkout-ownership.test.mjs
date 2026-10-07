import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";
import { steerGraphPatchReviewSession } from "../commands/graph/patch-review.mjs";

test("an older Update session cannot edit while another task owns the working checkout", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-checkout-"));
  const sessions = [];
  const server = await startInteractiveGraphServer({ html: "", graphs: [{ path: "/working/comm", label: "comm", repository: "comm", checkout: "working" }], token: "secret", tryMonitor: null,
    patchSessionDirectory: directory, appConfig: { ai: { enabled: true } },
    runCommand: async () => "", preparePatchUpdateSession: async ({ session }) => { sessions.push(session); session.status = "review"; },
  });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const post = (url, body = {}) => fetch(new URL(url, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret", ...body }) });
  for (const revision of ["D123", "D456"]) {
    const response = await post("/api/patch-update", { graphIndex: 0, revision, resume: false });
    assert.equal(response.status, 200, await response.text());
  }
  sessions[1].status = "applying";
  const response = await post(`/api/patch-update/${sessions[0].id}/apply`, { itemId: "old" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Another AI task owns/);
  for (const route of ["checkout", "try", "submit", "amend-current", "mach-action"]) {
    assert.equal((await post(`/api/${route}`)).status, 409, route);
  }
});

test("Review follow-ups on one checkout queue; separate checkouts can run together", async () => {
  const started = [], finish = new Map();
  const make = (id, cwd) => ({ id, graph: { path: cwd, checkout: "review", repository: "comm" }, aiEnabled: true,
    status: "review", activity: [], issues: [], codexAgent: { threadId: id, client: {
      startTurn: ({ onTurnStarted }) => { onTurnStarted(id); started.push(id); return new Promise(resolve => finish.set(id, resolve)); },
    } },
  });
  const a = make("a", "/review/shared/comm"), b = make("b", "/review/shared/comm"), c = make("c", "/review/other/comm");
  for (const session of [a, b, c]) await steerGraphPatchReviewSession({ session, instruction: "Check this finding" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["a", "c"]);
  // A failed turn must release the checkout just like a completed one.
  finish.get("a")({ turn: { status: "failed", error: { message: "test failure" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(started.includes("b"));
  for (const id of ["b", "c"]) finish.get(id)({ turn: { status: "failed", error: { message: "test failure" } } });
  await new Promise(resolve => setImmediate(resolve));
});

test("a restored Review chat cannot inspect a different patch after waiting", async () => {
  const session = { id: "restored", graph: { path: "/review/restored/comm", checkout: "review", repository: "comm" },
    currentHash: "expected", aiEnabled: true, status: "review", activity: [], issues: [],
    codexAgent: { threadId: "saved", client: { startTurn: () => assert.fail("No AI on the wrong patch") } },
  };
  await steerGraphPatchReviewSession({ session, instruction: "Continue", runCommand: async () => "different" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status, "review");
  assert.match(session.error, /another patch/);
});
