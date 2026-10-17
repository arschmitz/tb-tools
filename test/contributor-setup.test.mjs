import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkPrerequisites, installPrerequisites } from "../desktop/setup-prerequisites.cjs";
import { toolEnvironment, validateIdentity } from "../desktop/setup-environment.cjs";
import { runSetup } from "../desktop/setup-runner.cjs";
import { writeJson } from "../desktop/setup-store.cjs";
import { terminalPlan } from "../desktop/setup-launcher.cjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-contributor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "comm", "mail", "config"), { recursive: true });
  fs.writeFileSync(path.join(source, "comm", "mail", "config", "version.txt"), "1");
  fs.writeFileSync(path.join(source, "mach"), "");
  const globalFile = path.join(root, "gitconfig");
  fs.writeFileSync(globalFile, "[core]\n  autocrlf = false\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: "1" };
  for (const directory of [source, path.join(source, "comm")]) spawnSync("git", ["init", directory], { env });
  const file = path.join(root, "setup.json");
  writeJson(file, { destination: source, existing: true, mode: "full", identity: { name: "First Contributor", email: "test@example.invalid" } });
  return { root, source, file, globalFile, env };
}

test("prerequisites detect old Python and Linux installers use fixed package arguments", async () => {
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, args]);
    return { status: command === "python3" ? 1 : 0, stdout: "" };
  };
  const result = checkPrerequisites({ platform: "linux", execute });
  assert.equal(result.ready, false, "Old Python should prevent preparation.");
  assert.equal(result.checks.find(check => check.label.startsWith("Python")).ready, false, "Python should require version 3.10 or newer.");
  await assert.rejects(installPrerequisites({ platform: "linux", execute }), /still need attention/, "An unsuccessful tool recheck should keep setup incomplete.");
  assert.ok(calls.some(([command, args]) => command === "sudo" && args.join(" ") === "apt-get install -y curl python3 python3-venv git make"), "Linux should install the documented prerequisite packages.");
  assert.equal(calls.some(([command]) => command === "sh"), false, "Package installation should not interpolate shell commands.");
});

test("Apple tool installation waits for the operating system installer and Windows can start without MozillaBuild", async () => {
  const calls = [];
  await assert.rejects(installPrerequisites({ platform: "darwin", execute: (command, args) => {
    calls.push([command, args]);
    return { status: args[0] === "-p" ? 1 : 0 };
  } }), /Complete the Apple/, "The Apple installer should require a later recheck before setup continues.");
  assert.deepEqual(calls.at(-1), ["/usr/bin/xcode-select", ["--install"]], "Missing Apple tools should open the system installer.");
  const plan = terminalPlan({ directory: "C:\\data", node: "C:\\app\\node.exe", runner: "C:\\app\\runner.cjs", stateFile: "C:\\data\\setup.json", platform: "win32", useMozillaBuild: false, exists: () => false });
  assert.doesNotMatch(plan.batchContents, /start-shell/, "Prerequisite installation should work before MozillaBuild exists.");
  assert.match(plan.batchContents, /"C:\\app\\node.exe"/, "The native installer should use the bundled Node executable.");
  assert.throws(() => validateIdentity({ name: "Test", email: "bad" }), /Git name and email/, "An invalid identity should stop setup before cloning.");
  assert.match(toolEnvironment({ HOME: "/test", PATH: "/usr/bin" }, "darwin").PATH, /\/test\/\.local\/bin.*\/opt\/homebrew\/bin/, "A new process should find user tools and Homebrew without restarting the desktop.");
});

test("existing preparation keeps mozconfig and global Git settings and fails on build or launch failure", t => {
  const { source, file, globalFile, env } = fixture(t);
  const config = "# Keep this build setting\nac_add_options --enable-project=comm/mail\n";
  fs.writeFileSync(path.join(source, "mozconfig"), config);
  spawnSync("git", ["-C", source, "config", "--local", "user.name", "Existing Name"], { env });
  const before = fs.readFileSync(globalFile, "utf8");
  const calls = [];
  let failure = "build";
  const execute = (command, args, options) => {
    calls.push([command, args]);
    if (command === "git") return spawnSync(command, args, { ...options, env });
    if (args.includes("environment")) return { status: 0, stdout: JSON.stringify({ mozconfig: { configure_args: ["--enable-project=comm/mail"] } }) };
    if (args.includes("build")) return { status: failure === "build" ? 7 : 0 };
    if (args[0]?.endsWith("setup-launch-check.cjs")) return { status: failure === "launch" ? 9 : 0 };
    return { status: 0 };
  };
  assert.equal(runSetup(file, { execute }).status, "failed", "A build failure should keep setup incomplete.");
  assert.equal(calls.some(([, args]) => args[0]?.endsWith("setup-launch-check.cjs")), false, "A failed build should not launch Thunderbird.");
  failure = "launch";
  assert.equal(runSetup(file, { execute }).environmentVerified, false, "A launch failure should not mark the environment verified.");
  failure = "";
  assert.equal(runSetup(file, { execute }).environmentVerified, true, "A successful build and verified launch should complete the environment.");
  assert.equal(fs.readFileSync(path.join(source, "mozconfig"), "utf8"), config, "Existing build settings should stay unchanged.");
  assert.equal(fs.readFileSync(globalFile, "utf8"), before, "Setup should preserve global Git settings.");
  assert.equal(spawnSync("git", ["-C", source, "config", "--local", "user.name"], { env, encoding: "utf8" }).stdout.trim(), "Existing Name", "Setup should preserve an existing identity.");
  for (const directory of [source, path.join(source, "comm")]) {
    assert.equal(spawnSync("git", ["-C", directory, "config", "--local", "user.email"], { env, encoding: "utf8" }).stdout.trim(), "test@example.invalid", "Both checkouts should receive their missing email locally.");
  }
  assert.equal(calls.some(([, args]) => args[0] === "clone"), false, "An existing checkout should never be cloned or reset.");
});

test("patch setup verifies authentication after installation and never submits a patch", t => {
  const { source, file } = fixture(t);
  writeJson(file, { destination: source, mode: "full", task: "submission" });
  const calls = [];
  let failedAuth = true;
  const execute = (command, args) => {
    calls.push([command, args]);
    return { status: args[0] === "list" && failedAuth ? 1 : 0 };
  };
  assert.equal(runSetup(file, { execute }).status, "failed", "Authentication failure should keep patch setup incomplete.");
  failedAuth = false;
  assert.equal(runSetup(file, { execute }).status, "complete", "A read-only account check should verify patch setup.");
  assert.ok(calls.some(([command, args]) => command === "moz-phab" && args[0] === "install-certificate"), "An existing moz-phab installation should still authenticate.");
  assert.ok(calls.some(([, args]) => args.join(" ") === "mach install-moz-phab"), "Patch setup should use the supported Mach installer.");
  assert.equal(calls.some(([, args]) => args.includes("submit")), false, "Setup should never submit patches.");
});

test("an existing .mozconfig keeps its priority during preparation", t => {
  const { source, file } = fixture(t);
  const contents = "ac_add_options --enable-project=comm/mail\n# Existing configuration\n";
  fs.writeFileSync(path.join(source, ".mozconfig"), contents);
  const execute = (_command, args) => args.includes("environment")
    ? { status: 0, stdout: JSON.stringify({ mozconfig: { configure_args: ["--enable-project=comm/mail"] } }) }
    : { status: 0, stdout: "" };
  assert.equal(runSetup(file, { execute }).status, "complete", "An existing alternate configuration should remain usable.");
  assert.equal(fs.existsSync(path.join(source, "mozconfig")), false, "Setup should not create a file that overrides the existing .mozconfig.");
  assert.equal(fs.readFileSync(path.join(source, ".mozconfig"), "utf8"), contents, "Setup should keep the alternate configuration unchanged.");
});

test("Windows prerequisite installation requests elevation and waits for the installer", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tb installer "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const options = { platform: "win32", directory, exists: () => true,
    fetchResponse: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    execute: (command, args, settings) => { calls.push({ command, args, settings }); return { status: 0 }; } };
  await installPrerequisites(options);
  const installer = calls[0];
  assert.equal(installer.command, "powershell.exe", "Windows should use PowerShell to request installer elevation.");
  assert.match(installer.args.at(-1), /ErrorActionPreference = 'Stop'.*-Verb RunAs -Wait -PassThru; exit \$installer.ExitCode/,
    "Installation should stop on cancellation, wait for completion, and return the installer result.");
  assert.equal(installer.settings.env.TB_SETUP_INSTALLER, path.join(directory, "MozillaBuildSetup-Latest.exe"), "The installer path should pass as environment data.");
  assert.equal(installer.args.at(-1).includes(directory), false, "A path with spaces should not become PowerShell source text.");
  assert.deepEqual(calls.slice(1).map(call => call.command), ["git", "python"], "Tool checks should run after installer completion.");
  for (const failure of [{ status: 1 }, { status: 1603 }, { error: new Error("launch failed") }]) {
    calls.length = 0;
    await assert.rejects(installPrerequisites({ ...options, execute: (...args) => { calls.push(args); return failure; } }),
      /did not finish/, "Cancellation or installer failure should leave setup incomplete.");
    assert.equal(calls.length, 1, "Failed installation should stop before tools are rechecked.");
  }
});

test("Windows tools are found without restarting the desktop", () => {
  const env = toolEnvironment({ USERPROFILE: "C:\\Users\\Contributor", Path: "C:\\Windows\\System32", MOZILLABUILD: "D:\\mozilla-build" }, "win32");
  assert.equal(env.PATH, undefined, "Windows should retain the existing Path variable spelling.");
  assert.ok(env.Path.includes("D:\\mozilla-build\\msys2\\usr\\bin"), "Windows should find MozillaBuild Git immediately.");
  assert.ok(env.Path.includes("D:\\mozilla-build\\python3"), "Windows should find MozillaBuild Python immediately.");
  assert.ok(env.Path.endsWith("C:\\Windows\\System32"), "Windows should retain the existing search path.");
  const result = checkPrerequisites({ platform: "win32", env, exists: () => false, execute: () => assert.fail("Missing MozillaBuild should stop tool probes.") });
  assert.equal(result.ready, false, "Missing MozillaBuild should keep setup incomplete.");
  assert.equal(result.canInstall, true, "Missing MozillaBuild should offer its installer.");
});
