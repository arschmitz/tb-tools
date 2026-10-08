import { executeConsoleArtifactBuild, prepareConsoleBuild, publishCompletedConsoleBuild } from "./build.mjs";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensurePairedWorktrees, getWorktreeDirectory, writeWorktreeBuildConfig } from "./worktrees.mjs";

// Source and result branches share Git objects. Each task owns its branch names.
export function createTaskWorktreeManager({ graphs, runCommand, directory = getWorktreeDirectory }) {
  const comm = graphs.find(graph => graph.checkout === "working" && graph.repository === "comm");
  const gecko = graphs.find(graph => graph.checkout === "working" && graph.repository === "firefox");
  if (!comm || !gecko) throw new Error("Task worktrees need Firefox and comm repositories.");
  const git = async (cwd, args) => String(await runCommand({ cmd: "git", args, cwd,
    capture: true, silent: true })).trim();
  const rawGit = async (cwd, args) => String(await runCommand({ cmd: "git", args, cwd, capture: true, silent: true }));
  function configure(session, kind) {
    const id = session.id || randomUUID();
    const root = directory(`task-${id}`);
    session.repositoryPath = comm.path;
    session.taskKind = kind;
    session.managedWorktree = true;
    session.reviewFirefoxPath = root;
    session.graph = { ...comm, knownHashes: new Set(comm.knownHashes || []),
      path: path.join(root, "comm"), branch: "(detached)",
      taskWorktree: true, taskId: id, branchNamespace: `tb-task/${id}/`, repositoryPath: comm.path };
    session.graphIndex = graphs.indexOf(comm);
    return session;
  }
  function taskGraphs(session) {
    return [session.graph, { ...gecko, path: path.dirname(session.graph.path),
      taskWorktree: true, taskId: session.graph.taskId, repositoryPath: gecko.path }];
  }
  async function prepare(session, { geckoRevision = "HEAD", commRevision = "HEAD", cloneBranches = false, cloneRevision = commRevision } = {}) {
    const root = path.dirname(session.graph.path);
    await ensurePairedWorktrees({ geckoSource: gecko.path, commSource: comm.path,
      directory: root, geckoRevision, commRevision, runCommand });
    await writeWorktreeBuildConfig({ gecko: root, name: "task" });
    if (cloneBranches) {
      const refs = (await Promise.all([
        git(comm.path, ["for-each-ref", "--format=%(refname:short)%00%(objectname)",
          "--contains", cloneRevision, "refs/heads"]),
        git(comm.path, ["for-each-ref", "--format=%(refname:short)%00%(objectname)",
          "--merged", cloneRevision, "--no-merged", "origin/main", "refs/heads"]),
      ])).join("\n");
      for (const record of refs.split("\n")) {
        const [branch, hash] = record.split("\0");
        if (!branch || branch === "main" || branch.startsWith("tb-task/")) continue;
        const ref = `refs/heads/${session.graph.branchNamespace}${branch}`;
        if (!await git(session.graph.path, ["for-each-ref", "--format=%(objectname)", ref])) {
          await git(session.graph.path, ["update-ref", ref, hash, "0".repeat(40)]);
        }
      }
      const result = `refs/heads/${session.graph.branchNamespace}result`;
      if (!await git(session.graph.path, ["for-each-ref", "--format=%(objectname)", result])) {
        await git(session.graph.path, ["update-ref", result, cloneRevision, "0".repeat(40)]);
      }
    }
    return session;
  }
  async function prepareCurrent(kind, cloneRevision) {
    const session = configure({ id: randomUUID() }, kind);
    const revision = await git(comm.path, ["rev-parse", "HEAD"]);
    const geckoRevision = await git(gecko.path, ["rev-parse", "HEAD"]);
    await prepare(session, { geckoRevision, commRevision: revision,
      cloneBranches: kind === "rebase" || kind === "interactive-rebase", cloneRevision });
    // Rebases apply committed patches. Keep unfinished source work in its checkout.
    if (kind === "rebase" || kind === "interactive-rebase") return session;
    for (const [source, destination] of [[gecko.path, path.dirname(session.graph.path)], [comm.path, session.graph.path]]) {
      const patch = await rawGit(source, ["diff", "--binary", "HEAD", "--"]);
      if (patch) {
        const temporary = await mkdtemp(path.join(os.tmpdir(), "tb-task-source-"));
        try {
          const file = path.join(temporary, "source.patch");
          await writeFile(file, patch);
          await git(destination, ["apply", "--binary", file]);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      const untracked = await rawGit(source, ["ls-files", "--others", "--exclude-standard", "-z"]);
      const copied = [];
      for (const name of untracked.split("\0").filter(Boolean)) {
        if (source === gecko.path && (name === ".mozconfig" || name.startsWith("comm/"))) continue;
        const target = path.resolve(destination, name);
        if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new Error("Invalid source file path.");
        await mkdir(path.dirname(target), { recursive: true });
        const before = await lstat(path.join(source, name), { bigint: true });
        await cp(path.join(source, name), target, { recursive: true });
        copied.push({ name, before });
      }
      for (const { name, before } of copied) {
        const after = await lstat(path.join(source, name), { bigint: true });
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
          throw new Error("An untracked source file changed while preparing the task. Start it again with the current files.");
        }
      }
      if (await rawGit(source, ["diff", "--binary", "HEAD", "--"]) !== patch ||
          await rawGit(source, ["ls-files", "--others", "--exclude-standard", "-z"]) !== untracked) {
        throw new Error("Source changed while preparing the task. Start it again with the current files.");
      }
    }
    if (await git(comm.path, ["rev-parse", "HEAD"]) !== revision ||
        await git(gecko.path, ["rev-parse", "HEAD"]) !== geckoRevision) throw new Error("The source commit changed while preparing the task.");
    return session;
  }
  const prepareBuild = session => prepareTaskWorktreeBuild(session, runCommand);
  const cleaning = new Map();
  async function cleanup(session, { review = session.taskKind === "review" } = {}) {
    const graph = session.graph;
    if (!graph?.taskWorktree || session.worktreeRemoved) return;
    const root = path.dirname(graph.path);
    if (!graph.taskId || root !== directory(`task-${graph.taskId}`) || graph.path !== path.join(root, "comm")) {
      throw new Error("Refusing to remove a worktree outside this task's directory.");
    }
    if (cleaning.has(root)) return cleaning.get(root);
    const operation = removePair(root, `tb-task/${graph.taskId}/`, review).then(() => { session.worktreeRemoved = true; });
    cleaning.set(root, operation);
    try { await operation; } finally { cleaning.delete(root); }
  }
  async function removePair(root, namespace, review) {
    for (const [source, destination] of [[comm.path, path.join(root, "comm")], [gecko.path, root]]) {
      const trees = await git(source, ["worktree", "list", "--porcelain"]);
      const canonical = await realpath(destination).catch(error => {
        if (error.code === "ENOENT") return destination;
        throw error;
      });
      if (trees.split("\n").includes(`worktree ${canonical}`)) {
        if (!review) {
          const head = await git(destination, ["rev-parse", "HEAD"]);
          await git(source, ["update-ref", `refs/heads/${namespace}retained-head`, head]);
        }
        await git(source, ["worktree", "remove", "--force", destination]);
      }
      if (review) {
        const refs = await git(source, ["for-each-ref", "--format=%(refname)", `refs/heads/${namespace}`]);
        for (const ref of refs.split("\n").filter(Boolean)) await git(source, ["update-ref", "-d", ref]);
      }
    }
  }

  async function cleanupTryWorkspace(state, storeDirectory) {
    if (!state.workspace || state.workspaceRemoved) return;
    if (!/^[a-z0-9-]+$/.test(state.id) || !Number.isSafeInteger(state.workspaceGeneration || 0) || (state.workspaceGeneration || 0) < 0) {
      throw new Error("Invalid Try workspace identity.");
    }
    const expected = path.join(await realpath(storeDirectory), "workspaces", `${state.id}-${state.workspaceGeneration || 0}`, "gecko", "comm");
    if (state.workspace !== expected) throw new Error("Refusing to remove a Try workspace outside its saved directory.");
    await removePair(path.dirname(expected), `tb-try-workspace/${state.id}-${state.workspaceGeneration || 0}/`, false);
    state.workspaceRemoved = true;
  }
  return { configure, prepare, prepareCurrent, prepareBuild, cleanup, cleanupTryWorkspace, taskGraphs, sourceGraph: comm };
}

export async function prepareTaskWorktreeBuild(session, runCommand) {
    const log = text => { session.output = `${session.output || ""}${text}`.slice(-160000); };
    session.abortController ||= new AbortController();
    const execute = command => {
      if (session.cancelRequested) throw new Error("Build cancelled.");
      return runCommand({ ...command, killProcessGroup: true, env: { ...command.env, AUTOCLOBBER: "1" },
      onStdout: log, onStderr: log, signal: session.abortController.signal });
    };
    session.message = "Preparing the task's local build...";
    const plan = await prepareConsoleBuild({ graph: session.graph, runCommand, log });
    if (plan) {
      try { await executeConsoleArtifactBuild({ plan, execute, log, canceled: () => session.cancelRequested }); return; }
      catch (error) { log(`Artifact setup failed: ${error.message}. Retrying a normal build.\n`); }
    }
    await execute({ cmd: "./mach", args: ["build"], cwd: path.dirname(session.graph.path) });
    // Native changes can compile with the shared compiler cache. Publish installed
    // binaries only when they describe a clean, committed source revision.
    await publishCompletedConsoleBuild({ graph: session.graph, runCommand }).catch(error => log(`Build passed; binary snapshot was not saved: ${error.message}\n`));
  }
