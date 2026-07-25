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
    "--skip-dependencies",
    "--apply-to",
    "here",
  ]);
  assert.deepEqual(getPatchArgs({ revision: "D123456", skipDependencies: false }), [
    "patch",
    "D123456",
    "--apply-to",
    "here",
  ]);
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
      args: ["patch", "D123456", "--skip-dependencies", "--apply-to", "here"],
      capture: true,
    }],
  ]);
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
