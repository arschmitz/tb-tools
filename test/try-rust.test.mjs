import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRustDependencyFailure, checkRustOriginUpdate } from "../commands/graph/try-rust.mjs";

test("Rust dependency detection ignores compiler output without a dependency mismatch", async () => {
  assert.equal(await findRustDependencyFailure({ failures: [{ logs: [{ text: "Compiling rust; error[E0308]: mismatched types" }] }] }), null);
  assert.ok(await findRustDependencyFailure({ failures: [{ id: "1", logs: [{ text: "make: vendored-rust-check Error 88" }] }] }));
});

test("Rust detection scans full logs and skips profiler diagnostics", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "try-rust-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "build.log");
  await writeFile(file, "ordinary compiler output\n".repeat(10000) + "vendored-rust-check failed: Error 88\n");
  const result = await findRustDependencyFailure({ failures: [{ id: "build", logs: [
    { name: "startup_profile", fullLogPath: path.join(directory, "must-not-read.json") },
    { name: "live_backing_log", fullLogPath: file, text: "excerpt without the failure", url: "log-url" },
  ] }] });
  assert.equal(result.jobId, "build");
  assert.equal(result.url, "log-url");
});

for (const [commits, gecko, compatible, expected] of [
  [0, "old-gecko", true, false],
  [1, "old-gecko", false, false],
  [0, "new-gecko", false, false],
  [1, "old-gecko", true, true],
  [0, "new-gecko", true, true],
]) {
  test(`origin Rust gate: ${commits} new comm commits, ${gecko}, compatible=${compatible}`, async () => {
    const fetched = [];
    const result = await checkRustOriginUpdate({ path: "/test/comm", sourceHash: "source", geckoHash: "old-gecko" }, {
      runCommand: async ({ args, cwd }) => {
        assert.ok(["fetch", "rev-list"].includes(args[0]));
        if (args[0] === "fetch") fetched.push(cwd);
        return args[0] === "rev-list" ? String(commits) : "";
      },
      getStatus: async () => ({ upToDate: compatible, commLocalHash: "origin-main", firefoxRemoteHash: gecko }),
    });
    assert.equal(result.available, expected);
    assert.deepEqual(fetched, ["/test/comm", "/test"]);
  });
}
