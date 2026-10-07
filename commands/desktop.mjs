import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import defaultConfig from "../lib/config.mjs";

const defaultProject = path.resolve(import.meta.dirname, "..");

export function createDesktopCommand({
  config = defaultConfig,
  cwd = process.cwd(),
  projectRoot = defaultProject,
  exists = existsSync,
  getElectron = root => createRequire(path.join(root, "package.json"))("electron"),
  spawnApp = spawn,
  env = process.env,
  log = console.log,
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
    const child = spawnApp(executable, [root, ...(comm ? [`--comm=${comm}`] : [])], {
      cwd: root, env: environment, detached: true, stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    log("Thunderbird Commands started.");
    return { pid: child.pid, project: root, comm };
  };
}

export default createDesktopCommand();
