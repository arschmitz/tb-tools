import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run } from "../../lib/utils.mjs";
import { publishCompletedConsoleBuild } from "./build.mjs";
import { ensurePairedWorktrees, writeWorktreeBuildConfig } from "./worktrees.mjs";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeDailyBuildSettings(value = {}) {
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.times) ||
      (value.enabled && value.times.length === 0) ||
      value.times.some(time => typeof time !== "string" || !TIME.test(time))) {
    throw new Error("Daily build needs an enabled choice and times in HH:MM format.");
  }
  return { enabled: value.enabled, times: [...new Set(value.times)].sort() };
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function runLoggedBuild({ cwd, env, file, signal }) {
  await mkdir(path.dirname(file), { recursive: true });
  const output = createWriteStream(file, { flags: "a", mode: 0o600 });
  const command = process.platform === "win32" ? (process.env.TB_MACH_PYTHON || "python") : "./mach";
  const args = process.platform === "win32" ? ["mach", "build"] : ["build"];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd, env: { ...process.env, ...env, AUTOCLOBBER: "1",
          MOZ_SKIP_PATH_PERFORMANCE_CHECK: "1", SCCACHE_DIRECT: "false" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stop = () => {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGTERM"); return; } catch { /* Process already stopped. */ }
        }
        child.kill("SIGTERM");
      };
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.pipe(output, { end: false });
      child.stderr.pipe(output, { end: false });
      child.once("error", error => { signal?.removeEventListener("abort", stop); reject(error); });
      child.once("close", (code, stoppedBy) => {
        signal?.removeEventListener("abort", stop);
        if (signal?.aborted) reject(new Error("Daily build was cancelled."));
        else if (code === 0) resolve();
        else reject(new Error(`Daily build exited ${stoppedBy || code}. See ${file}.`));
      });
    });
  } finally {
    await new Promise(resolve => output.end(resolve));
  }
}

export function createDailyBuildService({
  geckoSource, commSource,
  directory = path.join(os.homedir(), ".tb-tools", "daily-build"),
  runCommand = run,
  build = runLoggedBuild,
  publishBuild = build === runLoggedBuild ? publishCompletedConsoleBuild : async () => null,
  now = () => new Date(),
  onSettingsSaved = async () => {},
} = {}) {
  if (!geckoSource || !commSource) throw new Error("Daily build needs Firefox and comm source checkouts.");
  const settingsFile = path.join(directory, "settings.json");
  const stateFile = path.join(directory, "state.json");
  const gecko = path.join(directory, "gecko");
  const mozconfig = path.join(directory, "mozconfig");
  const lockFile = path.join(directory, "run.lock");
  let settings = { enabled: false, times: [] };
  let state = { slots: [], status: "idle" };
  let timer;
  let current;
  let abort;
  let loginStatus = "";

  const git = async (cwd, args) => String(await runCommand({
    cmd: "git", args, cwd, capture: true, silent: true, signal: abort?.signal,
  })).trim();

  async function prepareSource() {
    // Fetching updates shared remote refs, but never switches the user's checkout.
    for (const source of [geckoSource, commSource]) {
      await git(source, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    }
    const geckoRevision = await git(geckoSource, ["rev-parse", "refs/remotes/origin/main"]);
    const commRevision = await git(commSource, ["rev-parse", "refs/remotes/origin/main"]);
    const trees = await ensurePairedWorktrees({ geckoSource, commSource, directory: gecko,
      geckoRevision, commRevision, update: true, runCommand });
    if (trees.gecko.hash !== geckoRevision || trees.comm.hash !== commRevision) {
      throw new Error("Daily build worktrees do not match the fetched revisions.");
    }
    const config = await writeWorktreeBuildConfig({ gecko, name: "daily-build" });
    await writeFile(mozconfig, await readFile(config, "utf8"));
    return { geckoRevision, commRevision };
  }

  async function saveState() { await saveJson(stateFile, state); }

  async function claimRun() {
    await mkdir(directory, { recursive: true });
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const file = await open(lockFile, "wx", 0o600);
        const id = randomUUID();
        try { await file.writeFile(JSON.stringify({ pid: process.pid, id })); }
        catch (error) { await unlink(lockFile).catch(() => {}); throw error; }
        finally { await file.close(); }
        return id;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let owner;
      try { owner = JSON.parse(await readFile(lockFile, "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") continue;
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
      }
      if (processIsRunning(owner.pid)) return "";
      await unlink(lockFile).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    throw new Error("Could not claim the daily build worktree.");
  }

  async function releaseRun(id) {
    const owner = await readJson(lockFile, null);
    if (owner?.id === id) await unlink(lockFile).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async function runNow(slots = []) {
    if (current) return { ...state, alreadyRunning: true };
    const runId = await claimRun();
    if (!runId) {
      state = await readJson(stateFile, state);
      return { ...state, alreadyRunning: true };
    }
    abort = new AbortController();
    const startedAt = now().toISOString();
    const logFile = path.join(directory, "logs", `${startedAt.replaceAll(":", "-")}.log`);
    state = { ...state, slots: [...new Set([...state.slots, ...slots])].slice(-40), activeSlots: slots,
      status: "running", ownerPid: process.pid, runId, startedAt, completedAt: null, error: "", logFile };
    try { await saveState(); }
    catch (error) { await releaseRun(runId); throw error; }
    current = (async () => {
      try {
        const revisions = await prepareSource();
        state = { ...state, ...revisions };
        await saveState();
        await build({ cwd: gecko, env: { MOZCONFIG: mozconfig }, file: logFile, signal: abort.signal });
        const buildSnapshot = await publishBuild({ graph: { path: path.join(gecko, "comm") },
          runCommand, env: { MOZCONFIG: mozconfig } });
        state = { ...state, buildSnapshot, status: "passed", activeSlots: [], ownerPid: null,
          completedAt: now().toISOString() };
      } catch (error) {
        state = { ...state, slots: abort.signal.aborted
          ? state.slots.filter(slot => !slots.includes(slot)) : state.slots,
          activeSlots: [], ownerPid: null, status: abort.signal.aborted ? "cancelled" : "failed",
          completedAt: now().toISOString(), error: error.message };
      } finally {
        try { await saveState(); }
        finally {
          try { await releaseRun(runId); }
          finally { current = null; abort = null; }
        }
      }
    })();
    return { ...state };
  }

  async function tick() {
    if (!settings.enabled || current) return;
    if (state.status === "running" && processIsRunning(state.ownerPid)) {
      state = await readJson(stateFile, state);
      if (state.status === "running") return;
    }
    const date = now();
    const due = settings.times.filter(time => time <= localTime(date))
      .map(time => `${localDay(date)}T${time}`)
      .filter(slot => !state.slots.includes(slot));
    if (due.length) await runNow(due);
  }

  return {
    async start() {
      settings = normalizeDailyBuildSettings(await readJson(settingsFile, settings));
      loginStatus = await onSettingsSaved(settings) || "";
      state = await readJson(stateFile, state);
      if (state.status === "running" && !processIsRunning(state.ownerPid)) state = { ...state,
        slots: state.slots.filter(slot => !state.activeSlots?.includes(slot)),
        activeSlots: [], status: "interrupted", completedAt: now().toISOString() };
      await saveState();
      timer = setInterval(() => { void tick().catch(error => { state.error = error.message; }); }, 30_000);
      await tick();
    },
    async stop() { clearInterval(timer); abort?.abort(); await current; },
    status() { return { settings, ...state, loginStatus, worktree: gecko,
      objectDirectory: path.join(gecko, "obj-daily-build") }; },
    async saveSettings(value) {
      settings = normalizeDailyBuildSettings(value);
      await saveJson(settingsFile, settings);
      loginStatus = await onSettingsSaved(settings) || "";
      await tick();
      return this.status();
    },
    runNow: () => runNow(),
    checkSchedule: tick,
    cancel() { abort?.abort(); return this.status(); },
    async readLog() {
      if (!state.logFile) return "";
      let size;
      try { size = (await stat(state.logFile)).size; }
      catch (error) { if (error.code === "ENOENT") return ""; throw error; }
      const length = Math.min(size, 64 * 1024);
      const file = await open(state.logFile, "r");
      try {
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, size - length);
        return buffer.toString("utf8");
      } finally { await file.close(); }
    },
    wait: async () => { await current; return { settings, ...state, loginStatus,
      worktree: gecko, objectDirectory: path.join(gecko, "obj-daily-build") }; },
  };
}
