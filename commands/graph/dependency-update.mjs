import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { getGraphRustUpstreamStatus } from "./actions.mjs";
import { getConsoleBuildEnvironment } from "./build.mjs";
import { runLoggedBuild } from "./daily-build.mjs";
import { ensurePairedWorktrees, writeWorktreeBuildConfig } from "./worktrees.mjs";

async function hasInstalledBuild({ commSource, runCommand }) {
  const env = await getConsoleBuildEnvironment({ path: commSource });
  const output = String(await runCommand({ cmd: "./mach", args: ["environment", "--format", "json"],
    cwd: path.dirname(commSource), env, capture: true, silent: true }));
  const environment = JSON.parse(output.slice(output.indexOf("{")));
  if (!environment.topobjdir) throw new Error("Build environment has no object directory.");
  return access(path.join(environment.topobjdir, "dist", "bin")).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export function createDependencyUpdateService({ geckoSource, commSource,
  directory = path.join(os.homedir(), ".tb-tools", "dependency-update",
    createHash("sha256").update(JSON.stringify([geckoSource, commSource])).digest("hex").slice(0, 16)),
  runCommand = run, getRustStatus = getGraphRustUpstreamStatus, build = runLoggedBuild,
  isBuildReady = hasInstalledBuild,
  now = () => Date.now(), intervalMs = 5 * 60_000, retryMs = 30 * 60_000,
} = {}) {
  if (!geckoSource || !commSource) throw new Error("Dependency updates need Firefox and comm checkouts.");
  const graphs = [{ repository: "firefox", path: geckoSource }, { repository: "comm", path: commSource }];
  const stateFile = path.join(directory, "state.json");
  const lockFile = path.join(directory, "run.sqlite");
  let state = { phase: "idle", message: "", logFile: "" };
  let current, timer, abort;
  let nextCheckAt = 0;
  let stopped = false;
  const git = async (cwd, args) => String(await runCommand({ cmd: "git", args, cwd,
    capture: true, silent: true, signal: abort?.signal })).trim();
  const setState = (phase, message) => { state = { ...state, phase, message }; };
  const checkCancelled = () => { if (abort.signal.aborted) throw new Error("Dependency update was cancelled."); };

  async function claim() {
    await mkdir(directory, { recursive: true });
    const lock = new DatabaseSync(lockFile);
    try {
      // SQLite releases this lock if the backend exits during a build.
      lock.exec("BEGIN EXCLUSIVE");
      return lock;
    } catch (error) {
      lock.close();
      if ([5, 6].includes(error.errcode)) return null;
      throw error;
    }
  }

  async function saveState() {
    const temporary = `${stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ state, nextCheckAt }), { mode: 0o600 });
    await rename(temporary, stateFile);
  }

  async function inspectMain(source, target, expected) {
    const head = await git(source, ["rev-parse", "HEAD"]);
    const branch = await git(source, ["branch", "--show-current"]);
    if (branch && branch !== "main") throw new Error(`Automatic update is waiting: ${source} is on patch branch ${branch}.`);
    if (expected && (head !== expected.head || branch !== expected.branch)) {
      throw new Error(`Automatic update is waiting: ${source} changed during the build.`);
    }
    if (await git(source, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new Error(`Automatic update is waiting: ${source} has local tracked changes.`);
    }
    // Detached checkouts can advance only along published main history.
    await git(source, ["merge-base", "--is-ancestor", head, target]);
    return { head, branch };
  }

  async function update() {
    if (stopped) return;
    let lock;
    abort = new AbortController();
    try {
      lock = await claim();
      if (!lock) return;
      {
        const saved = await readFile(stateFile, "utf8").then(JSON.parse).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (saved) { state = saved.state; nextCheckAt = saved.nextCheckAt || 0; }
        if (now() < nextCheckAt) return;
      }
      state = { ...state, updatedSources: [] };
      setState("fetching", "Fetching main to check source and build freshness.");
      for (const source of [geckoSource, commSource]) {
        checkCancelled();
        await git(source, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      }
      const candidate = await getRustStatus({ graphs, runCommand });
      if (!candidate.upToDate) {
        nextCheckAt = now() + retryMs;
        setState("waiting", "Automatic update is waiting for compatible Rust dependencies on main.");
        return;
      }
      const targets = [candidate.firefoxRemoteHash, candidate.commLocalHash];
      if (targets.some(hash => !/^[a-f0-9]{40,64}$/.test(hash || ""))) throw new Error("Rust check did not return pinned source revisions.");
      const sources = [geckoSource, commSource];
      const heads = [];
      for (let index = 0; index < sources.length; index++) {
        heads.push(await inspectMain(sources[index], targets[index]));
      }
      const matchesCompletedBuild = state.completed && state.geckoRevision === targets[0] &&
        state.commRevision === targets[1] && heads.every((source, index) => source.head === targets[index]);
      if (!state.pending && matchesCompletedBuild && await isBuildReady({ commSource, runCommand })) {
        nextCheckAt = 0;
        setState("passed", "Main checkout build is ready.");
        return;
      }

      nextCheckAt = now() + retryMs;
      state = { ...state, pending: true, completed: false };
      await saveState();
      const gecko = path.join(directory, "gecko");
      const trees = await ensurePairedWorktrees({ geckoSource, commSource, directory: gecko,
        geckoRevision: targets[0], commRevision: targets[1], update: true, runCommand });
      if (trees.gecko.hash !== targets[0] || trees.comm.hash !== targets[1]) throw new Error("Dependency worktrees do not match the checked revisions.");
      const mozconfig = await writeWorktreeBuildConfig({ gecko, name: "dependency-update" });
      state = { ...state, logFile: path.join(directory, "build.log"), completed: false };
      await writeFile(state.logFile, "", { mode: 0o600 });
      setState("building", "Building compatible main revisions in worktrees.");
      checkCancelled();
      await runCommand({ cmd: "./mach", args: ["tb-rust", "check-upstream"], cwd: gecko,
        env: { MOZCONFIG: mozconfig }, capture: true, silent: true, signal: abort.signal });
      await build({ cwd: gecko, env: { MOZCONFIG: mozconfig }, file: state.logFile, signal: abort.signal, runCommand });
      checkCancelled();
      for (const [source, target] of [[gecko, targets[0]], [path.join(gecko, "comm"), targets[1]]]) {
        if (await git(source, ["rev-parse", "HEAD"]) !== target || await git(source, ["status", "--porcelain"])) {
          throw new Error(`Dependency build worktree changed during the build: ${source}`);
        }
      }
      // A build may take hours. Check both sources again before the first update.
      for (let index = 0; index < sources.length; index++) {
        await inspectMain(sources[index], targets[index], heads[index]);
      }
      // Persist the pending build before either primary checkout can move.
      await saveState();
      setState("updating", "Updating the main checkouts to the successful worktree build revisions.");
      state = { ...state, updatedSources: [] };
      for (let index = 0; index < sources.length; index++) {
        checkCancelled();
        await inspectMain(sources[index], targets[index], heads[index]);
        const args = heads[index].branch ? ["merge", "--ff-only", "--no-overwrite-ignore", targets[index]]
          : ["switch", "--detach", "--no-overwrite-ignore", targets[index]];
        await git(sources[index], args);
        state.updatedSources.push(sources[index]);
      }
      setState("building-main", "Updating the main checkout build.");
      await build({ cwd: geckoSource, env: {}, file: state.logFile, signal: abort.signal, runCommand });
      checkCancelled();
      for (let index = 0; index < sources.length; index++) {
        await inspectMain(sources[index], targets[index], { head: targets[index], branch: heads[index].branch });
      }
      nextCheckAt = 0;
      state = { ...state, completed: true, pending: false, geckoRevision: targets[0], commRevision: targets[1] };
      setState("passed", "Main checkout build is ready.");
    } catch (error) {
      setState(abort.signal.aborted ? "cancelled" : "failed", `${error.message}${state.updatedSources?.length
        ? ` Updated checkouts: ${state.updatedSources.join(", ")}.` : ""}`);
      nextCheckAt = now() + retryMs;
    } finally {
      try { if (lock) await saveState(); }
      finally { lock?.close(); abort = null; }
    }
  }

  function check() {
    if (current) return current;
    if (stopped || now() < nextCheckAt) return Promise.resolve();
    // Assign the promise before any lock or source operation can yield.
    current = Promise.resolve().then(update).finally(() => { current = null; });
    return current;
  }

  return {
    start() {
      stopped = false;
      timer = setInterval(() => { void check().catch(error => setState("failed", error.message)); }, intervalMs);
      timer.unref?.();
      void check().catch(error => setState("failed", error.message));
    },
    check,
    status: () => ({ ...state, nextCheckAt }),
    async stop() { stopped = true; clearInterval(timer); abort?.abort(); await current; },
  };
}
