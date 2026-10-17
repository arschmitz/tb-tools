import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRebaseSessionStore } from "../commands/graph/rebase-session-store.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

test("restored rebases remain only while Git has an active operation", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rebase-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph = { path: root, label: "comm", commits: [] };
  const directory = path.join(root, "rebases");
  const store = createRebaseSessionStore({ directory });
  store.save({ id: "abc123", graph, status: "review", savedConflict: { id: "abc123" } });
  const marker = path.join(root, "rebase-merge");
  await mkdir(marker);
  const info = await startInteractiveGraphServer({ graphs: [graph], token: "test", html: "",
    patchSessionDirectory: root, tryMonitor: null,
    runCommand: async ({ args }) => args[0] === "diff" ? "" : path.join(root, args.at(-1)) });
  t.after(async () => { info.server.closeAllConnections(); await new Promise(resolve => info.server.close(resolve)); });
  const jobs = async () => (await (await fetch(new URL("/api/background-jobs?token=test", info.url))).json()).jobs;
  assert.equal((await jobs()).some(job => job.id === "Rebase:abc123"), true);
  await rm(marker, { recursive: true });
  assert.equal((await jobs()).some(job => job.id === "Rebase:abc123"), false);
  assert.equal((await fetch(new URL("/api/rebase/abc123?token=test", info.url))).status, 404);
  assert.deepEqual(store.load([graph]), [], "stale records must not return after restart");
});
