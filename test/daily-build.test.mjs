import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDailyBuildService, normalizeDailyBuildSettings } from "../commands/graph/daily-build.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function repository(root, name) {
  const remote = path.join(root, `${name}.git`);
  const source = path.join(root, name);
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, source);
  git(source, "config", "user.name", "Build test");
  git(source, "config", "user.email", "build@example.test");
  git(source, "switch", "-c", "main");
  await writeFile(path.join(source, "source.txt"), "first\n");
  git(source, "add", "source.txt");
  git(source, "commit", "-m", "first");
  git(source, "push", "-u", "origin", "main");
  return source;
}

test("daily build uses detached paired worktrees and does not move either source checkout", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daily-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const geckoSource = await repository(root, "gecko");
  const commSource = await repository(root, "comm");
  const directory = path.join(root, "build-service");
  const sourceHeads = [git(geckoSource, "rev-parse", "HEAD"), git(commSource, "rev-parse", "HEAD")];
  const built = [];
  const published = [];
  let failBuild = false;
  let date = new Date(2026, 9, 6, 8, 0);
  const service = createDailyBuildService({ geckoSource, commSource, directory,
    now: () => date,
    build: async options => {
      built.push(options);
      if (failBuild) throw new Error("Build failed before completion");
      assert.equal(git(options.cwd, "rev-parse", "HEAD"), git(geckoSource, "rev-parse", "origin/main"));
      assert.equal(git(path.join(options.cwd, "comm"), "rev-parse", "HEAD"),
        git(commSource, "rev-parse", "origin/main"));
      assert.match(await readFile(options.env.MOZCONFIG, "utf8"), /obj-daily-build/);
      await mkdir(path.dirname(options.file), { recursive: true });
      await writeFile(options.file, "build passed\n");
    },
    publishBuild: async options => {
      assert.equal(await readFile(built.at(-1).file, "utf8"), "build passed\n");
      assert.equal(options.graph.path, path.join(built.at(-1).cwd, "comm"));
      published.push(options);
      return path.join(root, "shared-binaries");
    },
  });
  await service.start();
  t.after(() => service.stop());
  await service.saveSettings({ enabled: true, times: ["09:00", "09:00", "21:30"] });
  assert.equal(built.length, 0);
  date = new Date(2026, 9, 6, 9, 1);
  await service.checkSchedule();
  await service.wait();
  assert.equal(service.status().status, "passed");
  assert.equal(await service.readLog(), "build passed\n");
  assert.equal(built.length, 1);
  assert.equal(published.length, 1);
  assert.equal(service.status().buildSnapshot, path.join(root, "shared-binaries"));
  await service.checkSchedule();
  assert.equal(built.length, 1);
  assert.deepEqual([git(geckoSource, "rev-parse", "HEAD"), git(commSource, "rev-parse", "HEAD")], sourceHeads);

  await writeFile(path.join(commSource, "source.txt"), "second\n");
  git(commSource, "commit", "-am", "second");
  git(commSource, "push");
  const newSourceHead = git(commSource, "rev-parse", "HEAD");
  await service.runNow();
  await service.wait();
  assert.equal(built.length, 2);
  assert.equal(git(path.join(directory, "gecko", "comm"), "rev-parse", "HEAD"), newSourceHead);
  assert.equal(git(geckoSource, "rev-parse", "HEAD"), sourceHeads[0]);
  assert.deepEqual(service.status().settings.times, ["09:00", "21:30"]);
  assert.equal(published.length, 2);
  failBuild = true;
  await service.runNow();
  await service.wait();
  assert.equal(service.status().status, "failed");
  assert.equal(published.length, 2, "Failed builds must not publish a snapshot");
});

test("daily build rejects invalid local times", () => {
  assert.throws(() => normalizeDailyBuildSettings({ enabled: true, times: [] }), /HH:MM/);
  assert.throws(() => normalizeDailyBuildSettings({ enabled: true, times: ["24:00"] }), /HH:MM/);
  assert.throws(() => normalizeDailyBuildSettings({ enabled: true, times: ["9:00"] }), /HH:MM/);
});

test("a second service keeps a running build and cannot start another one", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daily-build-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const geckoSource = await repository(root, "gecko");
  const commSource = await repository(root, "comm");
  const directory = path.join(root, "build-service");
  let finish;
  let builds = 0;
  const first = createDailyBuildService({ geckoSource, commSource, directory,
    build: async () => { builds++; await new Promise(resolve => { finish = resolve; }); } });
  await first.start();
  t.after(() => first.stop());
  await first.runNow();
  const second = createDailyBuildService({ geckoSource, commSource, directory,
    build: async () => { builds++; } });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.status().status, "running");
  assert.equal((await second.runNow()).alreadyRunning, true);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(builds, 1);
  finish();
  await first.wait();
  await second.runNow();
  await second.wait();
  assert.equal(builds, 2);
});
