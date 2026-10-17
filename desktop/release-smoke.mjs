import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import branding from "./branding.cjs";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the packaged app directory.");
const userData = await mkdtemp(path.join(os.tmpdir(), "tb-release-smoke-"));
const env = { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: userData };
delete env.TB_COMM_PATH;
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
let application;
try {
  application = await _electron.launch({ executablePath: branding.packagedExecutable(path.resolve(directory)),
    args: process.platform === "linux" ? ["--no-sandbox"] : [], env, timeout: 60_000 });
  const window = await application.firstWindow();
  await window.locator("#existing").waitFor();
  await window.locator("#new").waitFor();
  assert.equal(await window.locator("#existing").isVisible(), true, "The shipped app should offer an existing checkout on first launch.");
  await window.locator("#new").click();
  assert.equal(await window.locator("#configure").isVisible(), true, "The shipped app should open the new-environment setup screen.");
  assert.equal(await window.locator("#start").isDisabled(), true, "The shipped app should require a source folder before setup.");
  console.log("Packaged first-run startup passed.");
} finally {
  await application?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 3 });
}
