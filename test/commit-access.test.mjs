import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ensureGraphCommit } from "../commands/graph/commit-access.mjs";

const exec = promisify(execFile);

test("commit access checks unloaded objects in Git", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tb-commit-access-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial");
  const hash = await git("rev-parse", "HEAD");
  const graph = { path: cwd, label: "test", knownHashes: new Set() };
  await ensureGraphCommit(graph, hash);
  await ensureGraphCommit(graph, hash.slice(0, 12));
  const tree = await git("rev-parse", "HEAD^{tree}");
  for (const missing of ["f".repeat(40), tree]) {
    await assert.rejects(ensureGraphCommit(graph, missing), {
      statusCode: 404,
      message: `Commit ${missing} does not exist in test.`,
    });
  }
  for (const invalid of ["--help", "HEAD", "main", "", "HEAD:file.txt"]) {
    await assert.rejects(ensureGraphCommit(graph, invalid), { statusCode: 400 });
  }
});
