const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { toolEnvironment } = require("./setup-environment.cjs");

function checkPrerequisites({ platform = process.platform, env = toolEnvironment(process.env, platform), execute = spawnSync, exists = fs.existsSync } = {}) {
  const probe = (command, args) => execute(command, args, { env, encoding: "utf8", timeout: 5000 });
  const checks = [];
  if (platform === "darwin") {
    const installed = probe("/usr/bin/xcode-select", ["-p"]).status === 0;
    checks.push({ label: "Apple command line tools", ready: installed });
    if (!installed) return { checks, ready: false, canInstall: true };
  }
  if (platform === "win32") {
    const installed = exists(path.win32.join(env.MOZILLABUILD || "C:\\mozilla-build", "start-shell.bat"));
    checks.push({ label: "MozillaBuild", ready: installed });
    // MozillaBuild supplies Git and Python inside its development shell.
    if (!installed) return { checks, ready: false, canInstall: true };
  }
  checks.push({ label: "Git", ready: probe("git", ["--version"]).status === 0 });
  const python = probe(platform === "win32" ? "python" : "python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2]); sys.exit(sys.version_info < (3, 10))"]);
  checks.push({ label: "Python 3.10 or newer", ready: python.status === 0 });
  const canInstall = ["darwin", "win32"].includes(platform) || ["apt-get", "dnf"].some(command => probe(command, ["--version"]).status === 0);
  return { checks, ready: checks.every(check => check.ready), canInstall };
}

async function installPrerequisites({ platform = process.platform, execute = spawnSync, directory = __dirname, fetchResponse = fetch, exists = fs.existsSync } = {}) {
  let env = toolEnvironment(process.env, platform);
  const command = (file, args, extraEnv = {}) => {
    const result = execute(file, args, { env: { ...env, ...extraEnv }, stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`${file} did not finish. Follow the terminal prompts, then recheck tools.`);
  };
  const download = async (url, file) => {
    const response = await fetchResponse(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}). Try again.`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()), { mode: 0o700 });
  };
  if (platform === "darwin") {
    if (execute("/usr/bin/xcode-select", ["-p"], { env, stdio: "ignore" }).status !== 0) {
      command("/usr/bin/xcode-select", ["--install"]);
      throw new Error("Complete the Apple command line tools installer, then select Recheck tools.");
    }
    if (execute("brew", ["--version"], { env, stdio: "ignore" }).status !== 0) {
      const file = path.join(directory, "homebrew-install.sh");
      await download("https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh", file);
      command("/bin/bash", [file]);
      env = toolEnvironment();
    }
    command("brew", ["install", "git", "python"]);
  } else if (platform === "win32") {
    const file = path.join(directory, "MozillaBuildSetup-Latest.exe");
    await download("https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe", file);
    // Request elevation for the installer and wait for its result before rechecking tools.
    command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; $installer = Start-Process -FilePath $env:TB_SETUP_INSTALLER -Verb RunAs -Wait -PassThru; exit $installer.ExitCode"],
    { TB_SETUP_INSTALLER: file });
  } else if (platform === "linux") {
    if (execute("apt-get", ["--version"], { env, stdio: "ignore" }).status === 0) {
      command("sudo", ["apt-get", "update"]);
      command("sudo", ["apt-get", "install", "-y", "curl", "python3", "python3-venv", "git", "make"]);
    } else if (execute("dnf", ["--version"], { env, stdio: "ignore" }).status === 0) {
      command("sudo", ["dnf", "install", "-y", "python3", "git"]);
    } else throw new Error("Use the platform instructions to install Git and Python, then select Recheck tools.");
  } else throw new Error("Guided setup supports macOS, Linux, and Windows.");
  if (!checkPrerequisites({ platform, execute, exists }).ready) throw new Error("Some tools still need attention. Select Recheck tools after the installers finish.");
}

if (require.main === module) {
  installPrerequisites({ directory: process.argv[2] }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { checkPrerequisites, installPrerequisites };
