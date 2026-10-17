import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveLocalRustBuild, restoreLocalRustBuild } from "../commands/graph/local-rust-build.mjs";

test("local vendoring restores existing source edits and removes generated files after restart", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-local-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const comm = path.join(root, "comm");
  const git = path.join(root, "git-worktree");
  await mkdir(git);
  await mkdir(path.join(comm, "rust"), { recursive: true });
  await writeFile(path.join(comm, ".git"), `gitdir: ${git}\n`);
  await writeFile(path.join(comm, "rust/Cargo.toml"), "user's existing Rust edit\n");
  await writeFile(path.join(comm, "calendar.mjs"), "Calendar patch\n");
  await saveLocalRustBuild(comm);
  await writeFile(path.join(comm, "rust/Cargo.toml"), "local vendor result\n");
  await writeFile(path.join(comm, "rust/Cargo.lock"), "generated lock\n");
  await mkdir(path.join(comm, "third_party/rust"), { recursive: true });
  await writeFile(path.join(comm, "third_party/rust/generated.rs"), "local crate\n");
  // A new call reads the saved backup; no in-memory receipt is required.
  await restoreLocalRustBuild(comm);
  assert.equal(await readFile(path.join(comm, "rust/Cargo.toml"), "utf8"), "user's existing Rust edit\n");
  assert.equal(await readFile(path.join(comm, "calendar.mjs"), "utf8"), "Calendar patch\n");
  await assert.rejects(access(path.join(comm, "rust/Cargo.lock")), { code: "ENOENT" });
  await assert.rejects(access(path.join(comm, "third_party/rust")), { code: "ENOENT" });
  await restoreLocalRustBuild(comm);
});
