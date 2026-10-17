const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function terminalPlan({ directory, node, runner, stateFile, platform = process.platform,
  mozillaBuild = process.env.MOZILLABUILD || "C:\\mozilla-build", exists = fs.existsSync, useMozillaBuild = true }) {
  const posix = value => platform === "win32" ? value.replace(/\\/g, "/") : value;
  const command = [node, runner, stateFile].map(value => shellQuote(posix(value))).join(" ");
  const script = path.join(directory, platform === "darwin" ? "setup.command" : "setup.sh");
  let contents = `#!/bin/sh\n${command}\nresult=$?\nprintf '\\nYou can return to the setup window. Press Enter to close this terminal.\\n'\nread answer\nexit "$result"\n`;
  if (platform === "darwin") return { script, contents, executable: "/usr/bin/open", args: ["-a", "Terminal", script] };
  if (platform === "linux") return { script, contents, executable: "x-terminal-emulator", args: ["-e", "/bin/sh", script] };
  if (platform !== "win32") throw new Error("Guided setup supports macOS, Linux, and Windows.");
  const startShell = path.win32.join(mozillaBuild, "start-shell.bat");
  if (useMozillaBuild && !exists(startShell)) throw new Error("Install MozillaBuild in C:\\mozilla-build first, then retry. Use Prerequisites below for the installer.");
  // Batch files expand percent signs even inside double quotes.
  if ([node, runner, stateFile, startShell, directory].some(value => /[%!\r\n"&|<>^]/.test(value))) {
    throw new Error("The app or setup data path contains characters that Windows batch files cannot pass safely. Move the app or its data directory before retrying.");
  }
  contents = `#!/bin/sh\n${command}\nexit $?\n`;
  const batch = path.join(directory, "setup.bat");
  const run = !useMozillaBuild
    ? `"${node}" "${runner}" "${stateFile}"`
    : `call "${startShell}" -no-start -defterm -c "sh '${posix(script).replace(/'/g, "'\\''")}'"`;
  return { script, contents, batch,
    batchContents: `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${run}\r\nset "setup_result=%errorlevel%"\r\necho.\r\necho You can return to the setup window.\r\npause\r\nexit /b %setup_result%\r\n`,
    openPath: batch };
}

async function launchTerminal(plan, { openPath, spawnProcess = spawn } = {}) {
  fs.writeFileSync(plan.script, plan.contents, { mode: 0o700 });
  if (plan.batch) fs.writeFileSync(plan.batch, plan.batchContents, { mode: 0o600 });
  if (plan.openPath) {
    const error = await openPath(plan.openPath);
    if (error) throw new Error(error);
    return;
  }
  const launch = (executable, args) => new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  try { await launch(plan.executable, plan.args); }
  catch (error) {
    if (plan.executable !== "x-terminal-emulator" || error.code !== "ENOENT") throw error;
    try { await launch("gnome-terminal", ["--", "/bin/sh", plan.script]); }
    catch (fallback) {
      if (fallback.code !== "ENOENT") throw fallback;
      await launch("xterm", ["-e", "/bin/sh", plan.script]);
    }
  }
}

module.exports = { shellQuote, terminalPlan, launchTerminal };
