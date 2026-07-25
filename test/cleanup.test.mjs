import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCleanupCommand,
  filterCleanupPlan,
  formatCleanupPlan,
  getCleanupItemCount,
  parseMergedBugBranches,
  parseRefList,
  parseTbToolsStashes,
} from "../commands/cleanup.mjs";

test("cleanup parsers find checkpoint refs, merged bug branches, and tb-tools stashes", () => {
  assert.deepEqual(parseRefList("refs/tb-tools/a\nrefs/tb-tools/b\n"), [
    "refs/tb-tools/a",
    "refs/tb-tools/b",
  ]);
  assert.deepEqual(parseMergedBugBranches("main\nBug-1234567\nBug-7654321\nfeature\n", "Bug-7654321"), [
    "Bug-1234567",
  ]);
  assert.deepEqual(parseTbToolsStashes("stash@{0}: On main: tb-tools rebase\nstash@{1}: On main: unrelated\n"), [
    {
      ref: "stash@{0}",
      index: 0,
      message: "On main: tb-tools rebase",
    },
  ]);
});

test("filterCleanupPlan honors cleanup categories", () => {
  assert.deepEqual(filterCleanupPlan({
    refs: ["refs/tb-tools/a"],
    branches: ["Bug-1234567"],
    stashes: [{ ref: "stash@{0}", index: 0 }],
  }, {
    branches: false,
  }), {
    refs: ["refs/tb-tools/a"],
    branches: [],
    stashes: [{ ref: "stash@{0}", index: 0 }],
  });
});

test("formatCleanupPlan prints counts and candidates", () => {
  const output = formatCleanupPlan({
    refs: ["refs/tb-tools/a"],
    branches: ["Bug-1234567"],
    stashes: [{ ref: "stash@{0}", message: "On main: tb-tools rebase" }],
  });

  assert.match(output, /Checkpoint refs: 1/);
  assert.match(output, /Merged Bug branches: 1/);
  assert.match(output, /tb-tools stashes: 1/);
});

test("getCleanupItemCount counts selected candidates", () => {
  assert.equal(getCleanupItemCount({
    refs: ["refs/tb-tools/a"],
    branches: ["Bug-1234567"],
    stashes: [{ ref: "stash@{0}" }],
  }), 3);
});

test("cleanup command deletes candidates in a safe order", async () => {
  const calls = [];
  const cleanup = createCleanupCommand({
    getPlan: async () => ({
      refs: ["refs/tb-tools/a"],
      branches: ["Bug-1234567"],
      stashes: [
        { ref: "stash@{0}", index: 0, message: "newer tb-tools stash" },
        { ref: "stash@{2}", index: 2, message: "older tb-tools stash" },
      ],
    }),
    gitCommand: async (args) => {
      calls.push(args);
    },
    write: () => {},
  });

  await cleanup({ yes: true });

  assert.deepEqual(calls, [
    ["update-ref", "-d", "refs/tb-tools/a"],
    ["branch", "-d", "Bug-1234567"],
    ["stash", "drop", "stash@{2}"],
    ["stash", "drop", "stash@{0}"],
  ]);
});

test("cleanup command only prints candidates during dry runs", async () => {
  const writes = [];
  const cleanup = createCleanupCommand({
    getPlan: async () => ({
      refs: ["refs/tb-tools/a"],
      branches: [],
      stashes: [],
    }),
    gitCommand: async () => {
      assert.fail("dry run should not delete anything");
    },
    write: (message) => writes.push(message),
  });

  await cleanup({ dryRun: true });

  assert.equal(writes.length, 1);
});
