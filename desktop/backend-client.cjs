const { fork, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

function backendNodeExecutable() {
  if (process.env.TB_DESKTOP_NODE_EXECUTABLE) return process.env.TB_DESKTOP_NODE_EXECUTABLE;
  const bundled = path.join(process.resourcesPath || __dirname, "node-runtime", process.platform === "win32" ? "node.exe" : "node");
  if (existsSync(bundled)) return bundled;
  if (!process.versions.electron) return process.execPath;
  // Source launches can use the installed Node. Packaged apps ship their own.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  try { return execFileSync("node", ["-p", "process.execPath"], { env, encoding: "utf8", timeout: 5000 }).trim(); }
  catch { throw new Error("Standalone Node.js is missing. Start with tb desktop or rebuild the desktop package."); }
}

function createDesktopBackend({ onMainRequest, onExit = () => {}, entry = path.join(__dirname, "backend.mjs"),
  nodeExecutable = backendNodeExecutable(), heapMb = Number(process.env.TB_DESKTOP_HEAP_MB || 8192) } = {}) {
  if (!Number.isInteger(heapMb) || heapMb < 256 || heapMb > 65536) {
    throw new Error("TB_DESKTOP_HEAP_MB must be an integer from 256 to 65536.");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // Standalone Node cannot read Electron's app.asar archive.
  entry = entry.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  const child = fork(entry, [], { execPath: nodeExecutable, execArgv: [`--max-old-space-size=${heapMb}`],
    env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  child.on("message", async message => {
    if (message.mainRequest) {
      try {
        const value = await onMainRequest(message.action, message.value);
        if (child.connected) child.send({ mainReply: message.mainRequest, value });
      } catch (error) {
        if (child.connected) child.send({ mainReply: message.mainRequest, error: error.message });
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  const fail = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(`Dashboard service exited (${signal || code}).`));
    if (!stopped) onExit(code, signal);
  });
  function call(action, value) {
    if (!child.connected) return Promise.reject(new Error("Dashboard service is disconnected."));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.send({ id, action, value }, error => {
        if (error) { pending.delete(id); reject(error); }
      });
    });
  }
  return { call, pid: child.pid, async stop() {
    stopped = true;
    const timeout = setTimeout(() => child.kill(), 5000);
    try { if (child.connected) await call("stop"); }
    finally { clearTimeout(timeout); child.kill(); }
  } };
}

module.exports = { createDesktopBackend, backendNodeExecutable };
