import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { attachGraphTryRunsToCommits, recordGraphTryRun } from "../commands/graph/data.mjs";

test("tree refresh limits Git lookups and reuses immutable commit IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-try-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph = { label: "comm", path: root, patchIdCache: new Map() };
  let active = 0;
  let peak = 0;
  let messageReads = 0;
  const runCommand = async ({ cmd, args }) => {
    if (args[0] === "rev-parse") {
      return path.join(root, "try-runs.json");
    }
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (cmd === "git") {
      messageReads++;
      return "Bug 123 - Test\n\nTb-Tools-Id: stable-id\n";
    }
    return "patch-id abc123\n";
  };
  await recordGraphTryRun({ graph, runCommand, tryRun: {
    id: "run", hash: "old", patchId: "patch-id", label: "comm",
    url: "https://treeherder.mozilla.org/jobs?repo=try&revision=test",
    createdAt: "2026-09-24T12:00:00.000Z",
  } });
  const commits = Array.from({ length: 24 }, (_, i) => ({ hash: i.toString(16).padStart(40, "0"), subject: "Test" }));
  const first = await attachGraphTryRunsToCommits({ graph, commits, runCommand });
  const second = await attachGraphTryRunsToCommits({ graph, commits, runCommand });
  assert.ok(peak <= 4, `Spawned ${peak} concurrent lookups`);
  assert.equal(messageReads, commits.length);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ hash }) => hash), commits.map(({ hash }) => hash));
  assert.ok(first.every(({ tryRuns }) => tryRuns.length === 1));
});
