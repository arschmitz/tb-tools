import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDependencyUpdateService } from "../commands/graph/dependency-update.mjs";
import { getGraphRustUpstreamStatus } from "../commands/graph/actions.mjs";
import { startInteractiveGraphServer } from "../commands/graph/server.mjs";

const files = { mc_workspace_toml: "Cargo.toml", mc_gkrust_toml: "toolkit/library/rust/shared/Cargo.toml",
  mc_hack_toml: "build/workspace-hack/Cargo.toml", mc_cargo_lock: "Cargo.lock" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependency-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [];
  const writers = [];
  for (const name of ["gecko", "comm"]) {
    const remote = path.join(root, `${name}.git`);
    const source = path.join(root, name);
    const writer = path.join(root, `${name}-writer`);
    git(root, "init", "--bare", remote);
    git(root, "clone", remote, source);
    git(source, "config", "user.name", "Dependency test");
    git(source, "config", "user.email", "test@example.test");
    git(source, "switch", "-c", "main");
    if (name === "gecko") {
      await writeFile(path.join(source, ".gitignore"), "/.mozconfig*\n/obj*/\n/comm/\n");
      for (const file of Object.values(files)) {
        await mkdir(path.dirname(path.join(source, file)), { recursive: true });
        await writeFile(path.join(source, file), `${file}\n`);
      }
    } else {
      await mkdir(path.join(source, "rust"));
      await writeFile(path.join(source, "rust/checksums.json"), "{}\n");
    }
    git(source, "add", ".");
    git(source, "commit", "-m", "initial source");
    git(source, "push", "-u", "origin", "main");
    git(root, "clone", "-b", "main", remote, writer);
    git(writer, "config", "user.name", "Dependency test");
    git(writer, "config", "user.email", "test@example.test");
    sources.push(source);
    writers.push(writer);
  }
  const checksums = {};
  for (const [key, file] of Object.entries(files)) {
    checksums[key] = createHash("sha512").update(await readFile(path.join(writers[0], file))).digest("hex");
  }
  await writeFile(path.join(writers[1], "rust/checksums.json"), JSON.stringify(checksums));
  git(writers[1], "commit", "-am", "compatible Rust dependencies");
  git(writers[1], "push");
  const builds = [];
  const commands = [];
  let time = 1_000_000;
  const runCommand = async options => {
    commands.push(options);
    if (options.cmd === "git") return execFileSync("git", options.args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(options.args, ["tb-rust", "check-upstream"], "The worktree should run the Rust check before building.");
    return "";
  };
  const directory = path.join(root, "service");
  const create = (options = {}) => {
    const service = createDependencyUpdateService({ geckoSource: sources[0], commSource: sources[1], directory,
      runCommand, now: () => time, build: async options => { builds.push(options); }, ...options });
    t.after(() => service.stop());
    return service;
  };
  return { sources, writers, builds, commands, create, directory, runCommand,
    advance: () => { time += 31 * 60_000; } };
}

test("automatic updates fetch compatible Rust, build worktrees, then update and build main", async t => {
  const f = await fixture(t);
  const original = git(f.sources[1], "rev-parse", "HEAD");
  const service = f.create({ build: async options => {
    if (f.builds.length === 0) {
      const saved = JSON.parse(await readFile(path.join(f.directory, "state.json"), "utf8"));
      assert.equal(saved.state.pending, true, "The pending build should be saved before a worktree build can be interrupted.");
      assert.equal(git(f.sources[1], "rev-parse", "HEAD"), original, "The main source should stay unchanged until the worktree build passes.");
      assert.equal(git(options.cwd, "branch", "--show-current"), "", "The build worktree should use a detached revision.");
      assert.match(await readFile(options.env.MOZCONFIG, "utf8"), /obj-dependency-update/, "The worktree should have its own object directory.");
    }
    f.builds.push(options);
  } });
  const first = service.check();
  assert.equal(service.check(), first, "Overlapping checks should share one operation.");
  await first;
  assert.equal(service.status().phase, "passed", "The automatic update should finish with a ready build.");
  assert.equal(f.builds.length, 2, "The service should build the worktree and main checkout.");
  assert.equal(f.builds[1].cwd, f.sources[0], "The second build should use the primary checkout.");
  assert.deepEqual(f.builds[1].env, {}, "The primary build should use its existing configuration.");
  assert.equal(git(f.sources[1], "rev-parse", "HEAD"), git(f.writers[1], "rev-parse", "HEAD"), "Main should advance to the tested revision.");
  f.advance();
  await service.check();
  assert.equal(f.builds.length, 2, "Current dependencies should not trigger another build.");
  assert.equal(f.commands.filter(command => command.args[0] === "fetch").length, 2, "Current dependencies should not trigger another fetch.");
});

test("incompatible fetched Rust leaves the primary checkouts and builds untouched", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.writers[1], "rust/checksums.json"), "{}\n");
  git(f.writers[1], "commit", "-am", "still incompatible");
  git(f.writers[1], "push");
  const heads = f.sources.map(source => git(source, "rev-parse", "HEAD"));
  const service = f.create();
  await service.check();
  assert.equal(service.status().phase, "waiting", "Incompatible dependencies should wait for an upstream fix.");
  assert.equal(f.builds.length, 0, "Incompatible dependencies should not build.");
  assert.deepEqual(f.sources.map(source => git(source, "rev-parse", "HEAD")), heads, "Incompatible candidates should preserve both primary revisions.");
  const count = f.commands.length;
  await service.check();
  assert.equal(f.commands.length, count, "The retry cooldown should prevent repeated fetches.");
});

for (const condition of ["dirty", "branch", "diverged", "changed-during-build", "changed-worktree", "build-failure"]) {
  test(`automatic updates preserve main source when ${condition}`, async t => {
    const f = await fixture(t);
    const original = git(f.sources[1], "rev-parse", "HEAD");
    if (condition === "dirty") await writeFile(path.join(f.sources[1], "untracked.txt"), "keep me\n");
    if (condition === "branch") git(f.sources[1], "switch", "-c", "Bug-123");
    if (condition === "diverged") {
      await writeFile(path.join(f.sources[1], "local.txt"), "local commit\n");
      git(f.sources[1], "add", ".");
      git(f.sources[1], "commit", "-m", "local change");
    }
    const before = git(f.sources[1], "rev-parse", "HEAD");
    const service = f.create({ build: async options => {
      f.builds.push(options);
      if (condition === "changed-during-build") git(f.sources[1], "switch", "-c", "Bug-456");
      if (condition === "changed-worktree") await writeFile(path.join(options.cwd, "Cargo.toml"), "changed during build\n");
      if (condition === "build-failure") throw new Error("Worktree build failed");
    } });
    await service.check();
    assert.equal(service.status().phase, "failed", "Unsafe updates or failed builds should report a failure.");
    assert.equal(git(f.sources[1], "rev-parse", "HEAD"), before, "The service should preserve the primary revision.");
    assert.ok(f.builds.length <= 1, "The service should not build main after a blocked update.");
    if (condition !== "diverged") assert.equal(before, original, "The fixture should keep the original revision before the attempted update.");
  });
}

test("a failed primary build is retried even after source dependencies become current", async t => {
  const f = await fixture(t);
  let failMain = true;
  const service = f.create({ build: async options => {
    f.builds.push(options);
    if (options.cwd === f.sources[0] && failMain) throw new Error("Primary build failed");
  } });
  await service.check();
  assert.equal(service.status().phase, "failed", "A failed primary build should remain a failure.");
  assert.equal(service.status().pending, true, "A failed primary build should keep pending build state.");
  failMain = false;
  f.advance();
  await service.check();
  assert.equal(service.status().phase, "passed", "The next attempt should retry the pending primary build.");
  assert.equal(f.builds.length, 4, "Retry should rebuild the worktree and primary checkout.");
});

test("a live owner lock prevents another service from fetching or building", async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  const lock = new DatabaseSync(path.join(f.directory, "run.sqlite"));
  t.after(() => lock.close());
  lock.exec("BEGIN EXCLUSIVE");
  const service = f.create();
  await service.check();
  assert.equal(f.commands.length, 0, "A live owner should prevent duplicate source operations.");
  assert.equal(f.builds.length, 0, "A live owner should prevent duplicate builds.");
});

test("Rust status can compare local HEADs without reusing fetched-main results", async t => {
  const f = await fixture(t);
  const graphs = [{ repository: "firefox", path: f.sources[0] }, { repository: "comm", path: f.sources[1] }];
  git(f.sources[1], "fetch", "origin", "main");
  const fetched = await getGraphRustUpstreamStatus({ graphs, runCommand: f.runCommand });
  const local = await getGraphRustUpstreamStatus({ graphs, commRef: "HEAD", firefoxRef: "HEAD", runCommand: f.runCommand });
  assert.equal(fetched.upToDate, true, "The fetched main pair should have valid Rust dependencies.");
  assert.equal(local.upToDate, false, "The local HEAD pair should still have outdated dependencies.");
  assert.notEqual(local.commLocalHash, fetched.commLocalHash, "Local status should resolve its own pinned revision.");
});

test("a new backend retries a saved failed primary build", async t => {
  const f = await fixture(t);
  const first = f.create({ build: async options => {
    if (options.cwd === f.sources[0]) throw new Error("Primary build failed");
  } });
  await first.check();
  await first.stop();
  f.advance();
  const restarted = f.create();
  await restarted.check();
  assert.equal(restarted.status().phase, "passed", "A restarted backend should finish the saved pending build.");
  assert.equal(f.builds.length, 2, "A restarted backend should run the pending worktree and primary builds.");
});

test("separate services cannot overlap and release the lock when stopped", async t => {
  const f = await fixture(t);
  let started;
  const building = new Promise(resolve => { started = resolve; });
  const first = f.create({ build: async ({ signal }) => {
    started();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  } });
  const pending = first.check();
  await building;
  const commandsBefore = f.commands.length;
  const second = f.create();
  await second.check();
  assert.equal(f.commands.length, commandsBefore, "Another service should not run commands while the build lock is held.");
  await first.stop();
  await pending;
  assert.equal(first.status().phase, "cancelled", "Stopping the service should cancel its active build.");
  f.advance();
  await second.check();
  assert.equal(second.status().phase, "passed", "Another service should acquire the released lock and complete the update.");
});

test("the worktree Rust command must pass before either build starts", async t => {
  const f = await fixture(t);
  const before = f.sources.map(source => git(source, "rev-parse", "HEAD"));
  const service = f.create({ runCommand: async options => {
    if (options.cmd === "./mach") throw new Error("Rust check failed");
    return f.runCommand(options);
  } });
  await service.check();
  assert.equal(service.status().phase, "failed", "A failed Rust command should stop the update.");
  assert.equal(f.builds.length, 0, "A failed Rust command should prevent both builds.");
  assert.deepEqual(f.sources.map(source => git(source, "rev-parse", "HEAD")), before, "A failed Rust command should preserve both main checkouts.");
});

test("manual source changes clear the saved ready-build claim", async t => {
  const f = await fixture(t);
  const service = f.create();
  await service.check();
  assert.equal(service.status().phase, "passed", "The initial update should prepare the primary build.");
  await writeFile(path.join(f.sources[1], "manual.txt"), "new source\n");
  git(f.sources[1], "add", ".");
  git(f.sources[1], "commit", "-m", "manual source change");
  f.advance();
  await service.check();
  assert.equal(service.status().completed, false, "A changed primary revision should clear the saved build completion.");
  assert.equal(service.status().phase, "idle", "Current dependencies on unbuilt source should not claim a ready build.");
});


test("Rust status includes live dependency update progress even when checksum status is cached", async t => {
  let phase = "building";
  const graph = { path: "/repo/comm", label: "comm", repository: "comm", checkout: "working",
    branch: "main", commits: [], commitCount: 0, diffs: {} };
  const started = await startInteractiveGraphServer({ graphs: [graph], token: "secret", html: "<html></html>",
    dependencyUpdate: { status: () => ({ phase, message: `Update phase: ${phase}` }) },
    getRustUpstreamStatus: async () => ({ type: "rust-upstream", state: "current", message: "Rust matches." }),
    runCommand: async () => "a".repeat(40),
  });
  t.after(() => new Promise(resolve => started.server.close(resolve)));
  const status = async () => {
    const response = await fetch(new URL("/api/origin-main-status?token=secret&wait=1", started.url));
    const data = await response.json();
    return data.statuses.find(item => item.type === "rust-upstream");
  };
  assert.match((await status()).message, /Update phase: building/, "Rust status should show the active update progress.");
  phase = "passed";
  const updated = await status();
  assert.equal(updated.dependencyUpdate.phase, "passed", "Cached Rust status should include the latest update phase.");
  assert.match(updated.message, /Rust matches.*Update phase: passed/, "Rust status should retain checksum details and show build completion.");
});

test("a partial update reports the changed checkout and can retry", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.writers[0], "new-source.txt"), "new source\n");
  git(f.writers[0], "add", ".");
  git(f.writers[0], "commit", "-m", "new Firefox source");
  git(f.writers[0], "push");
  const commBefore = git(f.sources[1], "rev-parse", "HEAD");
  let failComm = true;
  const service = f.create({ runCommand: async options => {
    if (options.args[0] === "merge" && options.cwd === f.sources[1] && failComm) throw new Error("Comm fast-forward failed");
    return f.runCommand(options);
  } });
  await service.check();
  assert.equal(service.status().phase, "failed", "A partial update should report failure.");
  assert.deepEqual(service.status().updatedSources, [f.sources[0]], "A partial update should name the checkout that advanced.");
  assert.equal(git(f.sources[0], "rev-parse", "HEAD"), git(f.writers[0], "rev-parse", "HEAD"), "The successful first update should remain available for retry.");
  assert.equal(git(f.sources[1], "rev-parse", "HEAD"), commBefore, "A failed second update should preserve its original checkout.");
  assert.equal(f.builds.length, 1, "A partial update should not start the primary build.");
  failComm = false;
  f.advance();
  await service.check();
  assert.equal(service.status().phase, "passed", "A retry should complete the remaining update and primary build.");
});
