import assert from "node:assert/strict";
import { test } from "node:test";
import { createPatchCommand, getPatchArgs, normalizeRevision, switchToBugBranch } from "../commands/patch.mjs";

test("normalizeRevision accepts numeric and D-prefixed revisions", () => {
  assert.equal(normalizeRevision("123456"), "D123456");
  assert.equal(normalizeRevision("d123456"), "D123456");
  assert.throws(() => normalizeRevision(), /revision is required/);
});

test("getPatchArgs builds moz-phab patch arguments", () => {
  assert.deepEqual(getPatchArgs({ revision: "D123456" }), [
    "patch",
    "D123456",
  ]);
  assert.deepEqual(getPatchArgs({
    revision: "D123456",
    applyTo: "here",
    diffId: 42,
    name: "Bug-1234567",
    noCommit: true,
    noBookmark: true,
    noTopic: true,
    noBranch: true,
    skipDependencies: true,
    includeAbandoned: true,
    yes: true,
    safeMode: true,
    forceVcs: true,
  }), [
    "patch",
    "D123456",
    "--apply-to",
    "here",
    "--diff-id",
    "42",
    "--name",
    "Bug-1234567",
    "--no-commit",
    "--no-bookmark",
    "--no-topic",
    "--no-branch",
    "--skip-dependencies",
    "--include-abandoned",
    "--yes",
    "--safe-mode",
    "--force-vcs",
  ]);
  assert.deepEqual(getPatchArgs({ revision: "D123456", raw: true }), [
    "patch",
    "D123456",
    "--raw",
  ]);
  assert.throws(
    () => getPatchArgs({ revision: "D123456", raw: true, applyTo: "here" }),
    /does not allow --raw with --apply-to/
  );
});

test("switchToBugBranch creates a Bug branch", async () => {
  const calls = [];

  const branch = await switchToBugBranch("1234567", {
    gitCommand: async (args) => {
      calls.push(args);
    },
  });

  assert.equal(branch, "Bug-1234567");
  assert.deepEqual(calls, [["switch", "-c", "Bug-1234567"]]);
});

test("switchToBugBranch switches to an existing Bug branch", async () => {
  const calls = [];

  await switchToBugBranch("1234567", {
    gitCommand: async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        throw new Error("exists");
      }
    },
  });

  assert.deepEqual(calls, [
    ["switch", "-c", "Bug-1234567"],
    ["switch", "Bug-1234567"],
  ]);
});

test("patch command creates a checkpoint and runs moz-phab patch", async () => {
  const calls = [];
  const patch = createPatchCommand({
    createPatchCheckpoint: async (name) => {
      calls.push(["checkpoint", name]);
      return { commit: "abc" };
    },
    switchBranch: async (bug) => {
      calls.push(["branch", bug]);
    },
    runCommand: async (command) => {
      calls.push(["run", command]);
    },
  });

  await patch({ revision: "D123456", bug: "1234567" });

  assert.deepEqual(calls, [
    ["checkpoint", "patch-start"],
    ["branch", "1234567"],
    ["run", {
      cmd: "moz-phab",
      args: ["patch", "D123456"],
    }],
  ]);
});

test("patch command passes through moz-phab patch options", async () => {
  const calls = [];
  const patch = createPatchCommand({
    runCommand: async (command) => {
      calls.push(command);
    },
  });

  await patch({
    revision: "123456",
    checkpoint: false,
    applyTo: "base",
    diffId: "42",
    name: "topic-name",
    noCommit: true,
    noBookmark: true,
    noTopic: true,
    noBranch: true,
    skipDependencies: true,
    includeAbandoned: true,
    yes: true,
    safeMode: true,
    forceVcs: true,
  });

  assert.deepEqual(calls, [{
    cmd: "moz-phab",
    args: [
      "patch",
      "D123456",
      "--apply-to",
      "base",
      "--diff-id",
      "42",
      "--name",
      "topic-name",
      "--no-commit",
      "--no-bookmark",
      "--no-topic",
      "--no-branch",
      "--skip-dependencies",
      "--include-abandoned",
      "--yes",
      "--safe-mode",
      "--force-vcs",
    ],
  }]);
});

test("patch command validates moz-phab options before creating a checkpoint", async () => {
  const calls = [];
  const patch = createPatchCommand({
    createPatchCheckpoint: async () => {
      calls.push("checkpoint");
    },
  });

  await assert.rejects(
    patch({ revision: "D123456", raw: true, applyTo: "here" }),
    /does not allow --raw with --apply-to/
  );
  assert.deepEqual(calls, []);
});

test("patch command restores the checkpoint on failure when requested", async () => {
  const patchError = new Error("patch failed");
  const calls = [];
  const patch = createPatchCommand({
    createPatchCheckpoint: async () => ({ commit: "abc" }),
    runCommand: async () => {
      throw patchError;
    },
    restorePatchCheckpoint: async (checkpoint, cwd, options) => {
      calls.push(["restore", checkpoint, cwd, options]);
    },
    prompts: {
      keyInYNStrict: () => true,
    },
  });

  await assert.rejects(patch({ revision: "D123456" }), patchError);
  assert.deepEqual(calls, [["restore", { commit: "abc" }, undefined, { clean: true }]]);
});
