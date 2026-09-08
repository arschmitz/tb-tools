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
    PATH: "/tools",
  });

  assert.equal(environment.MOZ_SKIP_PATH_PERFORMANCE_CHECK, "1");
  assert.equal(environment.PATH, "/tools");
});

test("run passes the shared mach environment to child commands", async () => {
  const output = await run({
    args: ["-e", "process.stdout.write(process.env.MOZ_SKIP_PATH_PERFORMANCE_CHECK)"],
    capture: true,
    cmd: process.execPath,
    silent: true,
  });

  assert.equal(output, "1");
});

test("every streamed Mozilla command launcher preserves the shared environment", () => {
  const files = [
    "commands/graph/actions.mjs",
    "commands/graph/patching.mjs",
    "commands/graph/testing.mjs",
  ];

  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

    assert.match(source, /getTbToolsCommandEnvironment/);
    assert.match(source, /env:\s*(?:getTbToolsCommandEnvironment\(\)|\{\s*\.\.\.getTbToolsCommandEnvironment\(\))/);
  }

  const actions = readFileSync(
    new URL("../commands/graph/actions.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    (actions.match(/env: getTbToolsCommandEnvironment\(\)/g) || []).length,
    2,
  );
});
