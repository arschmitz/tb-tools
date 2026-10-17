const fs = require("node:fs");
const path = require("node:path");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function validCommPath(candidate) {
  return typeof candidate === "string" && path.isAbsolute(candidate) &&
    fs.existsSync(path.join(candidate, ".git")) &&
    fs.existsSync(path.join(candidate, "mail", "config", "version.txt")) &&
    fs.existsSync(path.join(path.dirname(candidate), "mach"));
}

function findCheckout(candidate) {
  if (typeof candidate !== "string" || !candidate) return "";
  const absolute = path.resolve(candidate);
  for (const directory of [absolute, path.join(absolute, "comm")]) {
    if (validCommPath(directory)) return fs.realpathSync(directory);
  }
  return "";
}

function rememberCheckout(userData, candidate) {
  const commPath = findCheckout(candidate);
  if (!commPath) throw new Error("Choose the Thunderbird comm folder or its Firefox parent. Both source checkouts must be present.");
  const file = path.join(userData, "checkout.json");
  const previous = readJson(file);
  writeJson(file, { commPath,
    ...(previous?.commPath === commPath && previous.credentialsSetupComplete ? { credentialsSetupComplete: true } : {}) });
  return commPath;
}

function configuredCheckout({ userData, option, env = process.env }) {
  const explicit = option || env.TB_COMM_PATH;
  if (explicit) return rememberCheckout(userData, explicit);
  const saved = readJson(path.join(userData, "checkout.json"));
  return findCheckout(saved?.commPath);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function setupStatus(file) {
  const state = readJson(file);
  if (!state) return null;
  if (state.status === "running" && !processAlive(state.pid)) {
    return { ...state, status: "interrupted", error: "Setup stopped before it finished. Retry to continue. Downloaded files are kept." };
  }
  if (state.status === "opening" && Date.now() - state.updatedAt > 60_000) {
    return { ...state, status: "interrupted", error: "The setup terminal did not start. Check your terminal application, then retry." };
  }
  return state;
}

module.exports = { readJson, writeJson, validCommPath, findCheckout, rememberCheckout,
  configuredCheckout, processAlive, setupStatus };
