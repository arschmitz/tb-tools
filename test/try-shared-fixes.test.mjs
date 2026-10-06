import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSharedTryValidation, reuseSharedTryRepair } from "../commands/graph/try-shared-fixes.mjs";
import { addTryAttempt } from "../commands/graph/try-submission.mjs";
const exec = promisify(execFile);

for (const scenario of ["reuse", "legacy", "dirty", "conflict"]) test(`shared fix integration: ${scenario}`, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "shared-try-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  const commit = async (file, text, subject) => {
    await writeFile(path.join(cwd, file), text); await git("add", file); await git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const boundary = await commit("base.txt", "base\n", "base");
  const target = await commit("shared.txt", "broken\n", "shared owner");
  const source = await commit("own.txt", "broken\n", "own owner");
  const fixup = await commit("own.txt", "fixed\n", "fixup! own owner");
  await git("branch", "own-fixup", fixup);
  await git("checkout", "--detach", target);
  const shared = await commit("shared.txt", "fixed\n", "fixup! shared owner");
  await git("branch", "shared-fixup", shared);
  await git("checkout", "--detach", fixup);
  const state = { id: "test", path: cwd, workspace: cwd, sourceHash: source, fixupHash: fixup,
    fixupTargetHash: source, fixupRef: "refs/heads/own-fixup", attempts: [] };
  const other = { id: "other", path: cwd, phase: "passed", fixupTargetHash: target, fixupHash: shared, fixupRef: "refs/heads/shared-fixup" };
  const store = { list: () => [state, other], save() {} };
  const report = { targetHash: target, files: ["shared.txt"] };
  if (scenario === "dirty") {
    await writeFile(path.join(cwd, "own.txt"), "user changes\n");
    assert.equal(await reuseSharedTryRepair(state, report, store), false);
    assert.equal(await git("rev-parse", "HEAD"), fixup);
    return;
  }
  if (scenario === "conflict") {
    state.fixupHash = await commit("shared.txt", "different repair\n", "other change");
    await assert.rejects(reuseSharedTryRepair(state, report, store));
    assert.equal(await git("rev-parse", "HEAD"), state.fixupHash);
    assert.equal(state.validationHash, undefined);
    return;
  }
  if (scenario === "legacy") {
    const tree = (await git("merge-tree", "--write-tree", `--merge-base=${target}`, fixup, shared)).split("\n")[0];
    state.validationHash = await git("commit-tree", tree, "-p", fixup, "-m", "Try validation: old workaround");
    state.validationKey = "old";
    await git("checkout", "--detach", state.validationHash);
  }
  assert.equal(await reuseSharedTryRepair(state, report, store), true);
  assert.equal(await git("show", "HEAD:shared.txt"), "fixed");
  assert.equal(await git("show", "HEAD:own.txt"), "fixed");
  assert.equal(await git("rev-parse", "own-fixup"), fixup);
  assert.equal(await git("rev-parse", "shared-fixup"), shared);
  assert.equal(state.fixupTargetHash, source);
  assert.equal(state.phase, "ready-to-submit");
  assert.equal(await git("log", "--format=%s", `${boundary}..HEAD`), "own owner\nshared owner");
  assert.equal(await git("rev-list", "--count", `${boundary}..HEAD`), "2");
  assert.equal(await git("show", "-s", "--format=%B", "HEAD"), await git("show", "-s", "--format=%B", source));
  assert.equal(await git("show", "-s", "--format=%B", "HEAD^"), await git("show", "-s", "--format=%B", target));
  assert.equal(addTryAttempt(state).hash, state.validationHash);
  // The saved intended revision recovers a crash before checkout.
  const validated = state.validationHash;
  await git("checkout", "--detach", fixup);
  await prepareSharedTryValidation(state, store);
  assert.equal(await git("rev-parse", "HEAD"), state.validationHash);
  assert.equal(state.validationHash, validated);
});
