import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { prepareDesktopRuntime } from "../desktop/launch-runtime.mjs";
import branding from "../desktop/branding.cjs";
import defaultConfig from "../lib/config.mjs";

const defaultProject = path.resolve(import.meta.dirname, "..");

export function createDesktopCommand({
  config = defaultConfig,
  cwd = process.cwd(),
  projectRoot = defaultProject,
  exists = existsSync,
  getElectron = root => createRequire(path.join(root, "package.json"))("electron"),
  spawnApp = spawn,
  prepareRuntime = prepareDesktopRuntime,
  env = process.env,
  log = console.log,
  openLogs = () => {
    const directory = path.join(os.homedir(), ".tb-tools", "desktop-logs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `desktop-${Date.now()}.log`);
    const fd = openSync(filename, "a", 0o600);
    return { stdio: ["ignore", fd, fd], close: () => closeSync(fd) };
  },
} = {}) {
  return async function desktopCommand(options = {}) {
    const root = path.resolve(options.project || config.desktop?.projectDirectory || projectRoot);
    const entry = path.join(root, "desktop", "main.cjs");
    if (!exists(entry)) {
      throw new Error("Desktop app source not found. Use tb desktop --project=/path/to/commands, or set desktop.projectDirectory in ~/.tb.json.");
    }
    let executable;
    try { executable = getElectron(root); }
    catch {
      throw new Error(`Electron is not installed in ${root}. Run npm install there first.`);
    }
    const isComm = directory => exists(path.join(directory, ".git")) &&
      exists(path.join(directory, "..", "mach"));
    const comm = options.comm ? path.resolve(cwd, options.comm) : isComm(cwd) ? cwd : "";
    if (comm && !isComm(comm)) {
      throw new Error(`Not a Thunderbird comm checkout: ${comm}. It must have .git and a Firefox parent with mach.`);
    }
    const environment = { ...env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const runtime = await prepareRuntime({ projectRoot: root, electronExecutable: executable, env: environment });
    const logs = openLogs();
    let child;
    try {
      child = spawnApp(runtime.executable, [...runtime.args, ...(comm ? [`--comm=${comm}`] : [])], {
        cwd: root, env: environment, detached: true, stdio: logs.stdio,
      });
    } finally { logs.close(); }
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    log(`${branding.APP_NAME} started.`);
    return { pid: child.pid, project: root, comm };
  };
}

export default createDesktopCommand();
