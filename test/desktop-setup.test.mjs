import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { configuredCheckout, rememberCheckout, readJson, writeJson, setupStatus } from "../desktop/setup-store.cjs";
import { runSetup } from "../desktop/setup-runner.cjs";
import { terminalPlan, launchTerminal } from "../desktop/setup-launcher.cjs";

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-setup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function checkout(root) {
  fs.mkdirSync(path.join(root, "comm", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "comm", "mail", "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "comm", "mail", "config", "version.txt"), "1");
  fs.writeFileSync(path.join(root, "mach"), "");
  return path.join(root, "comm");
}

test("saved checkout survives arbitrary launch directories and accepts a Firefox parent", t => {
  const root = temporary(t);
  const userData = path.join(root, "app");
  const comm = checkout(path.join(root, "source"));
  assert.equal(rememberCheckout(userData, path.dirname(comm)), comm, "The Firefox parent should resolve to comm.");
  assert.equal(configuredCheckout({ userData, env: {} }), comm, "Startup should use the absolute saved checkout.");
  assert.equal(readJson(path.join(userData, "checkout.json")).commPath, comm, "The saved path should be absolute.");
  fs.rmSync(path.join(comm, "mail"), { recursive: true });
  assert.equal(configuredCheckout({ userData, env: {} }), "", "A moved or incomplete checkout should return to setup.");
  assert.throws(() => configuredCheckout({ userData, option: root, env: {} }), /Both source checkouts/, "An invalid explicit path should report the error.");
  assert.equal(readJson(path.join(userData, "checkout.json")).commPath, comm, "An invalid choice should preserve the saved checkout.");
});

test("explicit checkout overrides saved settings and malformed settings reopen setup", t => {
  const root = temporary(t);
  const userData = path.join(root, "app");
  const first = checkout(path.join(root, "first"));
  const second = checkout(path.join(root, "second"));
  rememberCheckout(userData, first);
  assert.equal(configuredCheckout({ userData, option: second, env: { TB_COMM_PATH: first } }), second,
    "An explicit option should take precedence over the environment and saved path.");
  fs.writeFileSync(path.join(userData, "checkout.json"), "{");
  assert.equal(configuredCheckout({ userData, env: {} }), "", "Malformed settings should reopen setup.");
});

test("runner clones real local Git sources and retries a failed bootstrap without replacing source files", t => {
  const root = temporary(t);
  const gecko = path.join(root, "gecko-origin");
  const comm = path.join(root, "comm-origin");
  fs.mkdirSync(gecko);
  fs.mkdirSync(path.join(comm, "mail", "config"), { recursive: true });
  fs.writeFileSync(path.join(gecko, "mach"), "# test mach\n");
  fs.writeFileSync(path.join(comm, "mail", "config", "version.txt"), "1");
  for (const source of [gecko, comm]) {
    execFileSync("git", ["init", "--initial-branch=main", source]);
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "-c", "user.name=Setup Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Setup fixture"], { stdio: "ignore" });
  }
  const stateFile = path.join(root, "state.json");
  const destination = path.join(root, "destination");
  writeJson(stateFile, { destination, mode: "artifact", identity: { name: "Setup Test", email: "test@example.invalid" } });
  const calls = [];
  let bootstrapFailed = true;
  const execute = (executable, args, options) => {
    calls.push([executable, args]);
    if (args.includes("environment")) return { status: 0, stdout: JSON.stringify({mozconfig:{configure_args:["--enable-project=comm/mail"]}}) };
    if (args.includes("bootstrap")) return { status: bootstrapFailed ? 7 : 0 };
    if (executable !== "git") return { status: 0 };
    if (args.includes("--get")) return {status:1,stdout:""};
    if (args[0] === "clone") {
      const local = [...args];
      local[local.length - 2] = args.at(-1).endsWith("comm") ? comm : gecko;
      execFileSync(executable, local, options);
    } else execFileSync(executable, args, options);
    return { status: 0 };
  };
  assert.equal(runSetup(stateFile, { execute }).status, "failed", "A failed bootstrap should leave setup incomplete.");
  const mozconfig = path.join(destination, "mozconfig");
  assert.match(fs.readFileSync(mozconfig, "utf8"), /--enable-project=comm\/mail\nac_add_options --enable-artifact-builds\n/,
    "Artifact configuration should target Thunderbird and enable artifact builds.");
  fs.writeFileSync(path.join(destination, "comm", "local-edit.txt"), "keep");
  bootstrapFailed = false;
  assert.equal(runSetup(stateFile, { execute }).status, "complete", "Retry should finish after bootstrap succeeds.");
  assert.equal(calls.filter(([, args]) => args[0] === "clone").length, 2, "Retry should reuse both completed clones.");
  assert.equal(fs.readFileSync(path.join(destination, "comm", "local-edit.txt"), "utf8"), "keep", "Retry should preserve local edits.");
  assert.ok(calls.some(([, args]) => args.join(" ") === "mach bootstrap --application-choice browser"),
    "Bootstrap should install the full desktop dependencies required by Thunderbird.");
  assert.equal(fs.existsSync(`${stateFile}.lock`), false, "The runner should release its setup lock.");
});

test("runner preserves existing folders and reports missing tools and interrupted runs", t => {
  const root = temporary(t);
  const file = path.join(root, "state.json");
  const destination = path.join(root, "existing");
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "keep"), "keep");
  writeJson(file, { destination, mode: "full", identity: { name: "Setup Test", email: "test@example.invalid" } });
  assert.equal(runSetup(file, { execute: () => ({ status: 0 }) }).status, "failed", "Setup should reject an existing destination.");
  assert.equal(fs.readFileSync(path.join(destination, "keep"), "utf8"), "keep", "Setup should preserve existing files.");
  assert.equal(runSetup(file, { execute: () => ({ error: new Error("ENOENT") }) }).status, "failed", "Missing tools should leave setup incomplete.");
  writeJson(file, { status: "running", pid: 2147483647 });
  assert.equal(setupStatus(file).status, "interrupted", "A dead runner should offer recovery.");
  writeJson(file, { status: "opening", updatedAt: Date.now() - 61_000 });
  assert.equal(setupStatus(file).status, "interrupted", "A terminal that did not start should offer recovery.");
  writeJson(file, { status: "running", pid: process.pid });
  assert.equal(setupStatus(file).status, "running", "A live runner should remain in progress.");
});

test("runner preserves a build configuration created outside setup", t => {
  const root = temporary(t);
  const destination = path.join(root, "source");
  checkout(destination);
  const file = path.join(root, "state.json");
  const mozconfig = path.join(destination, "mozconfig");
  fs.writeFileSync(mozconfig, "# User build settings\n");
  writeJson(file, { destination, mode: "full", identity: { name: "Setup Test", email: "test@example.invalid" }, firefoxCloned: true, commCloned: true });
  const result = runSetup(file, { execute: () => ({ status: 0 }) });
  assert.equal(result.status, "failed", "Setup should stop when a user build configuration exists.");
  assert.equal(fs.readFileSync(mozconfig, "utf8"), "# User build settings\n", "Setup should preserve the user build configuration.");
});

test("terminal scripts quote shell input and dispatch each supported platform", async t => {
  const directory = temporary(t);
  const options = { directory, node: "/app's path/node", runner: "/app/$(touch unexpected).cjs", stateFile: path.join(directory, "state.json") };
  const mac = terminalPlan({ ...options, platform: "darwin" });
  assert.deepEqual(mac.args, ["-a", "Terminal", mac.script], "macOS should open the script in Terminal.");
  const linux = terminalPlan({ ...options, platform: "linux" });
  const spawned = [];
  await launchTerminal(linux, { spawnProcess: (executable, args) => {
    spawned.push([executable, args]);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  } });
  assert.deepEqual(spawned, [["x-terminal-emulator", ["-e", "/bin/sh", linux.script]]], "Linux should open an interactive terminal with the script.");
  const windows = terminalPlan({ ...options, platform: "win32", node: "C:\\app\\node.exe", runner: "C:\\app\\runner.cjs", exists: () => true });
  assert.match(windows.batchContents, /start-shell\.bat" -no-start -defterm -c/, "Windows should run inside MozillaBuild.");
  const opened = [];
  await launchTerminal(windows, { openPath: async file => { opened.push(file); return ""; } });
  assert.deepEqual(opened, [windows.batch], "Windows should open the generated batch file.");
  assert.throws(() => terminalPlan({ ...options, platform: "win32", exists: () => false }), /Install MozillaBuild/, "Windows should explain missing MozillaBuild.");
  assert.throws(() => terminalPlan({ ...options, platform: "win32", runner: "C:\\%INJECT%\\runner.cjs", exists: () => true }), /cannot pass safely/, "Windows should reject batch expansion characters.");
});

test("setup runner refuses a second live owner", t => {
  const root = temporary(t);
  const file = path.join(root, "state.json");
  writeJson(file, { destination: path.join(root, "source"), mode: "full", identity: { name: "Setup Test", email: "test@example.invalid" } });
  writeJson(`${file}.lock`, { pid: process.pid });
  assert.throws(() => runSetup(file), /already running/, "A second runner should preserve the live setup process.");
  fs.writeFileSync(`${file}.lock`, "");
  assert.throws(() => runSetup(file), /already running/, "A second runner should preserve a lock before its owner writes the PID.");
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "", "A second runner should not remove an initializing lock.");
});

test("POSIX scripts preserve shell arguments", { skip: process.platform === "win32" }, t => {
  const directory = temporary(t);
  const options = { directory, node: "/app's path/node", runner: "/app/$(touch unexpected).cjs", stateFile: path.join(directory, "state.json") };
  const plan = terminalPlan({ ...options, platform: "darwin" });
  const output = execFileSync("/bin/sh", ["-c", plan.contents.split("\n")[1].replace(/^/, "printf '%s\\n' ")], { encoding: "utf8" });
  assert.equal(output, [options.node, options.runner, options.stateFile].join("\n") + "\n", "Shell arguments should preserve quotes and command substitution as literal text.");
});

test("Windows installer batch preserves spaced paths and the runner exit code", { skip: process.platform !== "win32" }, async t => {
  const directory = path.join(temporary(t), "setup with spaces");
  fs.mkdirSync(directory);
  const runner = path.join(directory, "test runner.cjs");
  const stateFile = path.join(directory, "setup state.json");
  fs.writeFileSync(runner, 'require("node:fs").writeFileSync(process.argv[2], "started"); process.exit(7);');
  const plan = terminalPlan({ directory, node: process.execPath, runner, stateFile, useMozillaBuild: false });
  let result;
  await launchTerminal(plan, { openPath: async file => {
    result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${file}"`],
      { windowsVerbatimArguments: true, input: "\r\n", encoding: "utf8", timeout: 10000 });
    return "";
  } });
  assert.equal(result.error, undefined, "The batch should start without a process error.");
  assert.equal(result.status, 7, "The batch should preserve the runner failure after the pause.");
  assert.equal(fs.readFileSync(stateFile, "utf8"), "started", "The runner should receive the full state path with spaces.");
});
