import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  getTbToolsCommandEnvironment,
  run,
} from "../lib/utils.mjs";

test("tb-tools commands always skip mach path performance checks", () => {
  const environment = getTbToolsCommandEnvironment({
    MOZ_SKIP_PATH_PERFORMANCE_CHECK: "0",
    AUTOCLOBBER: "0",
    PATH: "/tools",
  });

  assert.equal(environment.MOZ_SKIP_PATH_PERFORMANCE_CHECK, "1");
  assert.equal(environment.PATH, "/tools");
  assert.equal(environment.AUTOCLOBBER, "1");
});

test("run passes the shared mach environment to child commands", async () => {
  const output = await run({
    args: ["-e", "process.stdout.write(process.env.MOZ_SKIP_PATH_PERFORMANCE_CHECK + ':' + process.env.AUTOCLOBBER)"],
    capture: true,
    cmd: process.execPath,
    silent: true,
  });

  assert.equal(output, "1:1");
});

test("run cancels an active child process", async () => {
  const controller = new AbortController();
  const running = run({
    args: ["-e", "setInterval(() => {}, 1000)"],
    capture: true,
    cmd: process.execPath,
    killProcessGroup: true,
    silent: true,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, (error) => error?.code === "ABORT_ERR");
});

for (const exitCode of [0, 1]) {
  test(`run waits for output streams after the process exits with ${exitCode}`, async () => {
    const writer = 'setTimeout(() => { process.stdout.write("revision-hash\\n"); process.stderr.write("diagnostic\\n"); }, 100)';
    const source = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {
        stdio: ["ignore", 1, 2],
      });
      process.exit(${exitCode});
    `;
    const result = run({
      cmd: process.execPath, args: ["-e", source], capture: true, silent: true,
    });
    if (exitCode) {
      await assert.rejects(result, (error) => {
        assert.equal(error.code, exitCode);
        assert.equal(error.stdout, "revision-hash\n");
        assert.equal(error.stderr, "diagnostic\n");
        return true;
      });
    } else {
      assert.equal(await result, "revision-hash\n");
    }
  });
}

test("every streamed Mozilla command launcher preserves the shared environment", () => {
  const files = [
    "commands/graph/actions.mjs",
    "commands/graph/patching.mjs",
    "commands/graph/testing.mjs",
  ];

  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

    assert.match(source, /getTbToolsCommandEnvironment/);
    assert.match(source, /env:\s*(?:getTbToolsCommandEnvironment\(|\{\s*\.\.\.getTbToolsCommandEnvironment\()/);
  }

  const actions = readFileSync(
    new URL("../commands/graph/actions.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    (actions.match(/env: getTbToolsCommandEnvironment\(/g) || []).length,
    2,
  );
});


test("run passes build config overrides without changing the shared environment", async () => {
  const output = await run({
    cmd: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify([process.env.MOZCONFIG, process.env.MOZ_SKIP_PATH_PERFORMANCE_CHECK]))"],
    env: { MOZCONFIG: "/test/artifact-config", MOZ_SKIP_PATH_PERFORMANCE_CHECK: "0" },
    capture: true,
    silent: true,
  });
  assert.deepEqual(JSON.parse(output), ["/test/artifact-config", "1"]);
});
