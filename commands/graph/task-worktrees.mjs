import { runConsoleBuild } from "./build.mjs";
import { restoreLocalRustBuild, saveLocalRustBuild } from "./local-rust-build.mjs";
import { normalizeMachCommand } from "../../lib/mach-command.mjs";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensurePairedWorktrees, forgetWorktree, getWorktreeDirectory, writeWorktreeBuildConfig } from "./worktrees.mjs";
import { isPrivateGraphBranch } from "./branches.mjs";

// Task worktrees share Git objects with the source checkout.
export function createTaskWorktreeManager({ graphs, runCommand, directory = getWorktreeDirectory }) {
  const comm = graphs.find(graph => graph.checkout === "working" && graph.repository === "comm");
  const gecko = graphs.find(graph => graph.checkout === "working" && graph.repository === "firefox");
  if (!comm || !gecko) throw new Error("Task worktrees need Firefox and comm repositories.");
  const git = async (cwd, args) => String(await runCommand({ cmd: "git", args, cwd,
    capture: true, silent: true })).trim();
  const preparing = new Map();
  const beginPreparation = id => preparing.set(id, (preparing.get(id) || 0) + 1);
  const endPreparation = id => {
    const count = preparing.get(id) - 1;
    if (count) preparing.set(id, count);
    else preparing.delete(id);
  };
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
  async function prepare(session, { geckoRevision = "HEAD", commRevision = "HEAD", cloneBranches = false, cloneRevision = commRevision, signal } = {}) {
    beginPreparation(session.id);
    try {
      const taskRun = options => runCommand({ ...options, signal, killProcessGroup: true });
      const taskGit = async (cwd, args) => String(await taskRun({ cmd: "git", args, cwd,
        capture: true, silent: true })).trim();
      const root = path.dirname(session.graph.path);
      const ownerFile = commandRecord(session.id);
      await mkdir(path.dirname(ownerFile), { recursive: true });
      await writeFile(ownerFile, JSON.stringify({ id: session.id, kind: session.taskKind, pid: process.pid, repositoryPath: comm.path }));
      await ensurePairedWorktrees({ geckoSource: gecko.path, commSource: comm.path,
        directory: root, geckoRevision, commRevision, runCommand: taskRun });
      await writeWorktreeBuildConfig({ gecko: root, name: "task" });
      const authorTask = ["verify", "freeform", "update"].includes(session.taskKind);
      if (cloneBranches || authorTask) {
        const refs = (await Promise.all([
          taskGit(comm.path, ["for-each-ref", "--format=%(refname:short)%00%(objectname)",
            "--contains", cloneRevision, "refs/heads"]),
          taskGit(comm.path, ["for-each-ref", "--format=%(refname:short)%00%(objectname)",
            "--merged", cloneRevision, "--no-merged", "origin/main", "refs/heads"]),
        ])).join("\n");
        const sourceRefs = [];
        for (const record of refs.split("\n")) {
          const [branch, hash] = record.split("\0");
          if (!branch || branch === "main" || isPrivateGraphBranch(branch)) continue;
          sourceRefs.push({ branch, hash });
          if (authorTask) continue;
          const ref = `refs/heads/${session.graph.branchNamespace}${branch}`;
          if (!await taskGit(session.graph.path, ["for-each-ref", "--format=%(objectname)", ref])) {
            await taskGit(session.graph.path, ["update-ref", ref, hash, "0".repeat(40)]);
          }
        }
        if (authorTask) {
          session.patchSourceRefs ||= [...new Map(sourceRefs.map(entry => [entry.branch, entry])).values()];
          session.patchSourceHash ||= String(await taskGit(comm.path, ["rev-parse", cloneRevision]));
          return session;
        }
        const result = `refs/heads/${session.graph.branchNamespace}result`;
        if (!await taskGit(session.graph.path, ["for-each-ref", "--format=%(objectname)", result])) {
          await taskGit(session.graph.path, ["update-ref", result, cloneRevision, "0".repeat(40)]);
        }
      }
      return session;
    } finally { endPreparation(session.id); }
  }
  function commandRecord(id) {
    return path.join(path.dirname(directory(`task-${id}`)), ".task-owners", `${id}.json`);
  }
  async function prepareCurrent(kind, cloneRevision, { signal, session: owner } = {}) {
    const execute = options => {
      signal?.throwIfAborted();
      return runCommand({ ...options, signal, killProcessGroup: true });
    };
    const git = async (cwd, args) => String(await execute({ cmd: "git", args, cwd, capture: true, silent: true })).trim();
    const rawGit = async (cwd, args) => String(await execute({ cmd: "git", args, cwd, capture: true, silent: true }));
    const session = configure(owner || { id: randomUUID() }, kind);
    beginPreparation(session.id);
    try {
      if (["build", "test", "lint", "try"].includes(kind)) {
        const file = commandRecord(session.id);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ id: session.id, kind, pid: process.pid, repositoryPath: comm.path }));
      }
      const revision = await git(comm.path, ["rev-parse", "HEAD"]);
      const geckoRevision = await git(gecko.path, ["rev-parse", "HEAD"]);
      await prepare(session, { geckoRevision, commRevision: revision,
        cloneBranches: kind === "rebase" || kind === "interactive-rebase", cloneRevision, signal });
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
          signal?.throwIfAborted();
          if (source === gecko.path && (name === ".mozconfig" || name.startsWith("comm/") || name.startsWith(".tb-review-"))) continue;
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
    } finally { endPreparation(session.id); }
  }
  const prepareBuild = session => prepareTaskWorktreeBuild(session, options => runCommand({
    ...options, signal: session.abortController?.signal, killProcessGroup: true,
  }));
  async function prepareReview(session) {
    const revisions = [];
    for (const source of [gecko.path, comm.path]) {
      const options = { cwd: source, capture: true, silent: true,
        signal: session.abortController?.signal, killProcessGroup: true };
      await runCommand({ ...options, cmd: "git", args: ["fetch", "--no-tags", "--no-write-fetch-head", "origin",
        "+refs/heads/main:refs/remotes/origin/main"] });
      revisions.push(String(await runCommand({ ...options, cmd: "git", args: ["rev-parse", "origin/main"] })).trim());
    }
    session.reviewMainHash = revisions[1];
    return prepare(session, { geckoRevision: revisions[0], commRevision: revisions[1],
      signal: session.abortController?.signal });
  }
  const cleaning = new Map();
  async function cleanup(session, { review = session.taskKind === "review" } = {}) {
    const graph = session.graph;
    if (!graph?.taskWorktree) return;
    if (session.worktreeRemoved && !existsSync(path.dirname(graph.path))) return;
    const root = path.dirname(graph.path);
    if (!graph.taskId || root !== directory(`task-${graph.taskId}`) || graph.path !== path.join(root, "comm")) {
      throw new Error("Refusing to remove a worktree outside this task's directory.");
    }
    if (cleaning.has(root)) return cleaning.get(root);
    const operation = removePair(root, `tb-task/${graph.taskId}/`, review).then(async () => {
      session.worktreeRemoved = true;
      await rm(commandRecord(graph.taskId), { force: true });
    });
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
          const complete = existsSync(path.join(destination, ".git"));
          const dirty = complete ? await git(destination, ["status", "--porcelain"]) : "";
          let head = complete ? await git(destination, ["rev-parse", "HEAD"])
            : trees.split("\n\n").find(block => block.startsWith(`worktree ${canonical}\n`))?.match(/\nHEAD ([a-f0-9]+)/)?.[1];
          if (!head) throw new Error("Cannot retain the interrupted worktree commit.");
          if (dirty) {
            // Save source edits as a recovery commit before removing the task.
            await git(destination, ["add", "--all", "--", ".", ":(exclude).tb-review-*", ":(exclude)comm"]);
            const tree = await git(destination, ["write-tree"]);
            head = String(await runCommand({ cmd: "git", args: ["commit-tree", tree, "-p", head, "-m", "Retain unfinished task source before cleanup"],
              cwd: destination, capture: true, silent: true, env: { GIT_AUTHOR_NAME: "Thunderbird task recovery", GIT_AUTHOR_EMAIL: "task-recovery@localhost",
                GIT_COMMITTER_NAME: "Thunderbird task recovery", GIT_COMMITTER_EMAIL: "task-recovery@localhost" } })).trim();
          }
          const recoveryRef = namespace.startsWith("tb-task/")
            ? `refs/tb-tools/task-history/${namespace.slice("tb-task/".length)}retained-head`
            : namespace.startsWith("tb-try-workspace/")
              ? `refs/tb-tools/try-history/${namespace.slice("tb-try-workspace/".length)}retained-head`
            : `refs/heads/${namespace}retained-head`;
          await git(source, ["update-ref", recoveryRef, head]);
        }
        try { await git(source, ["worktree", "remove", "--force", destination]); }
        catch (error) {
          const remaining = await git(source, ["worktree", "list", "--porcelain"]);
          if (remaining.split("\n").includes(`worktree ${canonical}`)) throw error;
        }
      }
      await forgetWorktree({ source, destination, runCommand });
      if (namespace.startsWith("tb-task/")) await retireBranches(source, namespace, { archive: !review });
    }
    if (review && namespace.startsWith("tb-task/")) {
      const prefix = `refs/tb-tools/task-history/${namespace.slice("tb-task/".length)}`;
      for (const source of [comm.path, gecko.path]) {
        const refs = await git(source, ["for-each-ref", "--format=%(refname)", prefix]);
        for (const ref of refs.split("\n").filter(Boolean)) await git(source, ["update-ref", "-d", ref]);
      }
    }
    // Git can unregister a worktree while leaving its ignored build files.
    await rm(root, { recursive: true, force: true });
  }

  async function retireBranches(source, namespace, { archive = true } = {}) {
    const prefix = `refs/heads/${namespace}`;
    const refs = await git(source, ["for-each-ref", "--format=%(refname)%00%(objectname)", prefix]);
    for (const record of refs.split("\n").filter(Boolean)) {
      const [ref, hash] = record.split("\0");
      if (!ref.startsWith(prefix)) continue;
      if (archive) await git(source, ["update-ref",
        `refs/tb-tools/task-history/${ref.slice("refs/heads/tb-task/".length)}`, hash]);
      await git(source, ["update-ref", "-d", ref, hash]);
    }
  }

  async function archiveRetiredBranches(activeIds = new Set()) {
    const trees = await Promise.all([comm, gecko].map(graph => git(graph.path, ["worktree", "list", "--porcelain"])));
    for (const source of [comm.path, gecko.path]) {
      const refs = await git(source, ["for-each-ref", "--format=%(refname)", "refs/heads/tb-task/"]);
      const ids = new Set(refs.split("\n").map(ref => ref.match(/^refs\/heads\/tb-task\/([^/]+)\//)?.[1]).filter(Boolean));
      for (const id of ids) {
        if (typeof activeIds === "function" ? activeIds(id) : activeIds.has(id)) continue;
        const root = directory(`task-${id}`);
        const registered = trees.some(tree => tree.split("\n").some(line =>
          line === `worktree ${root}` || line === `worktree ${path.join(root, "comm")}`));
        if (!registered) await retireBranches(source, `tb-task/${id}/`);
      }
    }
  }

  async function cleanupInactiveWorktrees(activeIds = new Set(), activePaths = new Set()) {
    const parent = path.dirname(directory("task-probe"));
    const files = await readdir(parent).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const owners = await readdir(path.dirname(commandRecord("probe"))).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of owners) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const task = `task-${name.slice(0, -5)}`;
        if (!files.includes(task)) files.push(task);
      }
    }
    const trees = await git(gecko.path, ["worktree", "list", "--porcelain"]);
    const registered = new Set(trees.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9)));
    const common = await git(gecko.path, ["rev-parse", "--git-common-dir"]);
    const registry = path.join(path.resolve(gecko.path, common), "tb-tools-worktrees");
    for (const name of files) {
      const match = name.match(/^task-([a-f0-9-]{36})$/);
      const legacyReview = /^review-[a-f0-9]{8}(?:-d[0-9]+)?$/.test(name);
      if (!match && !legacyReview || match && (activeIds.has(match[1]) || preparing.has(match[1]))) continue;
      const root = directory(name);
      if (activePaths.has(root)) continue;
      const recordId = createHash("sha256").update(path.resolve(root)).digest("hex");
      const ownership = await readFile(path.join(registry, `${recordId}.json`), "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (ownership?.ownerPid && ownership.ownerPid !== process.pid) {
        try { process.kill(ownership.ownerPid, 0); continue; }
        catch (error) { if (error.code !== "ESRCH") continue; }
      }
      if (legacyReview) {
        if (!registered.has(root)) continue;
        await removePair(root, `tb-review/${name}/`, true);
        continue;
      }
      if (!registered.has(root)) {
        // Only our ownership record permits removing an unregistered partial tree.
        if (!existsSync(commandRecord(match[1]))) continue;
      }
      const record = await readFile(commandRecord(match[1]), "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (record?.repositoryPath && record.repositoryPath !== comm.path) continue;
      if (record?.pid && record.pid !== process.pid) {
        try { process.kill(record.pid, 0); continue; }
        catch (error) { if (error.code !== "ESRCH") continue; }
      }
      await cleanup(configure({ id: match[1] }, record?.kind || "retired"));
    }
  }

  async function cleanupInactiveTryWorkspaces(states, storeDirectory, isActive) {
    if (!storeDirectory) return;
    const canonical = await realpath(storeDirectory).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!canonical) return;
    const parent = path.join(canonical, "workspaces");
    const names = await readdir(parent).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const protectedRoots = new Set(states.filter(isActive).map(state => state.workspace && path.dirname(state.workspace)).filter(Boolean));
    const trees = await git(gecko.path, ["worktree", "list", "--porcelain"]);
    for (const name of names) {
      const match = name.match(/^([a-f0-9-]{36})-([0-9]+)$/);
      if (!match) continue;
      const root = path.join(parent, name, "gecko");
      if (protectedRoots.has(root)) continue;
      const owned = states.some(state => state.id === match[1] && (state.repositoryPath || state.path) === comm.path);
      if (!owned || !trees.split("\n").includes(`worktree ${root}`)) continue;
      await removePair(root, `tb-try-workspace/${name}/`, false);
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }

  async function cleanupTryWorkspace(state, storeDirectory) {
    if (!state.workspace) return;
    if (!/^[a-z0-9-]+$/.test(state.id) || !Number.isSafeInteger(state.workspaceGeneration || 0) || (state.workspaceGeneration || 0) < 0) {
      throw new Error("Invalid Try workspace identity.");
    }
    const expected = path.join(await realpath(storeDirectory), "workspaces", `${state.id}-${state.workspaceGeneration || 0}`, "gecko", "comm");
    if (state.workspace !== expected) throw new Error("Refusing to remove a Try workspace outside its saved directory.");
    await removePair(path.dirname(expected), `tb-try-workspace/${state.id}-${state.workspaceGeneration || 0}/`, false);
    state.workspaceRemoved = true;
  }
  return { configure, prepare, prepareReview, prepareCurrent, prepareBuild, cleanup, cleanupTryWorkspace, cleanupInactiveTryWorkspaces, cleanupInactiveWorktrees, archiveRetiredBranches, taskGraphs, sourceGraph: comm };
}

export async function prepareTaskWorktreeBuild(session, runCommand) {
    const log = text => { session.output = `${session.output || ""}${text}`.slice(-160000); };
    session.abortController ||= new AbortController();
    let repairedRust = false;
    const execute = async command => {
      if (session.cancelRequested) throw new Error("Build cancelled.");
      let output = "";
      const record = text => { output = `${output}${text}`.slice(-160000); log(text); };
      const options = { ...command, killProcessGroup: true, env: { ...command.env, AUTOCLOBBER: "1" },
        onStdout: record, onStderr: record, signal: session.abortController.signal };
      try { return await runCommand(options); }
      catch (error) {
        const failureOutput = `${output}\n${error.stdout || ""}\n${error.stderr || ""}`;
        const errors = failureOutput.split("\n").filter(line => /Rust dependencies are out of sync|\bE make|\berror:|\bfatal:|\*\*\*.*Error \d/i.test(line));
        if (errors.length) error.message = errors.slice(-8).join("\n");
        if (session.abortController.signal.aborted || session.cancelRequested || repairedRust ||
            !/Rust dependencies are out of sync|vendored-rust-check[^\n]*Error 88/i.test(`${failureOutput}\n${error.message}`)) throw error;
        repairedRust = true;
        await saveLocalRustBuild(session.graph.path);
        session.message = "Updating vendored Rust dependencies before retrying the build...";
        log("Rust dependencies are out of sync. Running mach tb-rust vendor in the task worktree.\n");
        await runCommand(normalizeMachCommand({ ...options, cmd: "./mach", args: ["tb-rust", "vendor"], cwd: path.dirname(session.graph.path) }));
        session.message = "Retrying the task build after updating Rust dependencies...";
        return runCommand(options);
      }
    };
    session.message = "Preparing the task's local build...";
    await restoreLocalRustBuild(session.graph.path);
    try { await runConsoleBuild({ graph: session.graph, runCommand, execute, log,
      canceled: () => session.cancelRequested,
    }); } finally {
      await restoreLocalRustBuild(session.graph.path);
      if (repairedRust) log("Restored source files after local Rust vendoring. Local build repairs are excluded from commits and Try.\n");
    }
  }
