import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

test("Restart schedules one relaunch and uses normal shutdown", async () => {
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("function restartApp() {"), source.indexOf("function installMenu() {"));
  const calls = [];
  const context = vm.createContext({ app: {
    relaunch: () => calls.push("relaunch"),
    quit: () => calls.push("quit"),
  } });
  vm.runInContext(`let restarting = false; let quitting = false; ${restart}`, context);
  vm.runInContext("restartApp(); restartApp();", context);
  assert.deepEqual(calls, ["relaunch", "quit"]);
  calls.length = 0;
  vm.runInContext("restarting = false; quitting = true; restartApp();", context);
  assert.deepEqual(calls, []);
  assert.equal(source.match(/label: "Restart", click: restartApp/g)?.length, 2);
});
