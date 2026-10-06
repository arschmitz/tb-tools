import assert from "node:assert/strict";
import { test } from "node:test";
import { findRustDependencyFailure, checkRustOriginUpdate } from "../commands/graph/try-rust.mjs";

test("Rust dependency detection ignores compiler output without a dependency mismatch", async () => {
  assert.equal(await findRustDependencyFailure({ failures: [{ logs: [{ text: "Compiling rust; error[E0308]: mismatched types" }] }] }), null);
  assert.ok(await findRustDependencyFailure({ failures: [{ id: "1", logs: [{ text: "make: vendored-rust-check Error 88" }] }] }));
});

for (const [commits, gecko, compatible, expected] of [
  [0, "old-gecko", true, false],
  [1, "old-gecko", false, false],
  [0, "new-gecko", false, false],
  [1, "old-gecko", true, true],
  [0, "new-gecko", true, true],
]) {
  test(`origin Rust gate: ${commits} new comm commits, ${gecko}, compatible=${compatible}`, async () => {
    const result = await checkRustOriginUpdate({ path: "/test/comm", sourceHash: "source", geckoHash: "old-gecko" }, {
      runCommand: async ({ args }) => {
        assert.ok(["fetch", "rev-list"].includes(args[0]));
        return args[0] === "rev-list" ? String(commits) : "";
      },
      getStatus: async () => ({ upToDate: compatible, commLocalHash: "origin-main", firefoxRemoteHash: gecko }),
    });
    assert.equal(result.available, expected);
  });
}
