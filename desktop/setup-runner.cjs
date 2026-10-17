const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readJson, writeJson, processAlive, validCommPath } = require("./setup-store.cjs");

const { toolEnvironment, validateIdentity, gitIdentity } = require("./setup-environment.cjs");

const FIREFOX_URL = "https://github.com/mozilla-firefox/firefox";
const THUNDERBIRD_URL = "https://github.com/thunderbird/thunderbird-desktop";

function runSetup(file, { execute = spawnSync, platform = process.platform } = {}) {
  const state = readJson(file);
  if (!state || !path.isAbsolute(state.destination) || !["artifact", "full"].includes(state.mode)) {
    throw new Error("Setup settings are missing or invalid.");
  }
  if (state.status === "running" && state.pid !== process.pid && processAlive(state.pid)) {
    throw new Error("Setup is already running in another terminal.");
  }
  // Publish the PID and lock together so another runner never sees an empty lock.
  const lock = `${file}.lock`;
  if (fs.existsSync(lock)) {
    throw new Error("Setup is already running, or its previous lock needs recovery. Retry from the setup window after the previous terminal has stopped.");
  }
  const ownerFile = `${lock}.${randomUUID()}`;
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  try { fs.linkSync(ownerFile, lock); }
  finally { fs.unlinkSync(ownerFile); }
  const save = values => {
    Object.assign(state, values, { updatedAt: Date.now() });
    writeJson(file, state);
  };
  const command = (executable, args, cwd) => {
    console.log(`\n${executable} ${args.join(" ")}\n`);
    const result = execute(executable, args, { cwd, stdio: "inherit", env: toolEnvironment(process.env, platform) });
    if (result.error) throw new Error(`Could not start ${executable}: ${result.error.message}. Check the prerequisites in the setup window.`);
    if (result.status !== 0) throw new Error(`${executable} failed (${result.signal || result.status}). See the terminal output above.`);
  };
  const clone = (url, destination, marker, key) => {
    if (state[key]) {
      if (!fs.existsSync(path.join(destination, marker))) throw new Error(`Source files are missing from ${destination}. Choose a new setup folder.`);
      return;
    }
    if (fs.existsSync(destination)) {
      throw new Error(`A previous download left ${destination}. Choose a new folder, or move the incomplete download before retrying. Setup keeps existing files.`);
    }
    command("git", ["clone", "--progress", "--branch", "main", url, destination], path.dirname(destination));
    save({ [key]: true });
  };
  try {
    save({ status: "running", pid: process.pid, error: "", environmentVerified: false, step: "Checking prerequisites" });
    if (state.task === "prerequisites") {
      command(process.execPath, [path.join(__dirname, "setup-prerequisites.cjs"), path.dirname(file)], path.dirname(file));
      save({ status: "complete", pid: null, step: "Tools installed. Recheck tools before continuing." });
      return state;
    }
    const python = platform === "win32" ? "python" : "python3";
    if (state.task === "submission") {
      save({ step: "Installing and connecting moz-phab — follow the terminal prompts" });
      const env = toolEnvironment(process.env, platform);
      const installed = execute("moz-phab", ["--version"], { env, stdio: "ignore" }).status === 0;
      command(python, ["mach", "install-moz-phab"], state.destination);
      if (installed) command("moz-phab", ["install-certificate"], path.join(state.destination, "comm"));
      save({ step: "Checking your patch submission account" });
      command("moz-phab", ["list"], path.join(state.destination, "comm"));
      save({ status: "complete", pid: null, step: "Patch submission account verified" });
      return state;
    }
    const identity = validateIdentity(state.identity);
    command("git", ["--version"], path.dirname(state.destination));
    command(python, ["-c", "import sys; sys.exit(sys.version_info < (3, 10))"], path.dirname(state.destination));
    if (!state.existing) {
      save({ step: "Downloading Firefox" });
      clone(FIREFOX_URL, state.destination, "mach", "firefoxCloned");
      save({ step: "Downloading Thunderbird" });
      clone(THUNDERBIRD_URL, path.join(state.destination, "comm"), "mail/config/version.txt", "commCloned");
    }
    save({ step: "Saving checkout Git identity" });
    for (const directory of [state.destination, path.join(state.destination, "comm")]) {
      const current = gitIdentity(directory, execute, toolEnvironment(process.env, platform));
      if (!current.name) command("git", ["-C", directory, "config", "--local", "user.name", identity.name], directory);
      if (!current.email) command("git", ["-C", directory, "config", "--local", "user.email", identity.email], directory);
    }
    save({ step: "Configuring the Thunderbird build" });
    const mozconfig = path.join(state.destination, "mozconfig");
    const contents = "ac_add_options --enable-project=comm/mail\n" +
      (state.mode === "artifact" ? "ac_add_options --enable-artifact-builds\n" : "");
    if (!state.configured) {
      // Never replace a configuration created by the user or the bootstrap command.
      if (!state.existing && fs.existsSync(mozconfig) && fs.readFileSync(mozconfig, "utf8") !== contents) {
        throw new Error(`A build configuration already exists at ${mozconfig}. Keep it and use the existing checkout option, or choose a new folder.`);
      }
      const hasOtherConfig = state.existing && (fs.existsSync(path.join(state.destination, ".mozconfig")) || process.env.MOZCONFIG);
      if (!fs.existsSync(mozconfig) && !hasOtherConfig) fs.writeFileSync(mozconfig, contents, { flag: "wx" });
      save({ configured: true });
    }
    save({ step: "Installing development tools — check the terminal for prompts" });
    command(python, ["mach", "bootstrap", "--application-choice", "browser"], state.destination);
    if (!validCommPath(path.join(state.destination, "comm"))) throw new Error("The new source checkout is incomplete.");
    save({ step: "Checking the active Thunderbird build configuration" });
    const configuration = execute(python, ["mach", "environment", "--format=json"], { cwd: state.destination, env: toolEnvironment(process.env, platform), encoding: "utf8" });
    let active;
    try { active = JSON.parse(configuration.stdout); } catch { /* Mach prints its failure in the terminal. */ }
    if (configuration.status !== 0 || !active?.mozconfig?.configure_args?.includes("--enable-project=comm/mail")) {
      throw new Error("The active build configuration must include --enable-project=comm/mail. Keep your existing settings and add that option, then retry.");
    }
    save({ step: "Building Thunderbird — this can take a long time" });
    command(python, ["mach", "build"], state.destination);
    save({ step: "Opening Thunderbird in a separate development profile" });
    command(process.execPath, [path.join(__dirname, "setup-launch-check.cjs"), path.join(path.dirname(file), "development-profiles"), state.destination, python], state.destination);
    save({ status: "complete", step: "Thunderbird built and its window verified", environmentVerified: true, pid: null });
    console.log("\nEnvironment setup finished. Return to the setup window and select Continue to add your service keys.\n");
  } catch (error) {
    save({ status: "failed", error: error.message, pid: null });
    console.error(`\nSetup stopped: ${error.message}\nReturn to the setup window to retry or choose another folder.`);
  } finally {
    fs.unlinkSync(lock);
  }
  return state;
}

if (require.main === module) {
  try { process.exitCode = runSetup(process.argv[2]).status === "complete" ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { runSetup, FIREFOX_URL, THUNDERBIRD_URL };
