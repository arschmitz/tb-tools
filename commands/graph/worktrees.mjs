import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../../lib/utils.mjs";

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function getWorktreeDirectory(name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("Worktree name must use letters, numbers, and hyphens.");
  return path.join(os.homedir(), ".tb-tools", "worktrees", name);
}

export async function shareGitRepository(first, second, runCommand = run) {
  const common = async cwd => {
    const value = String(await runCommand({ cmd: "git", args: ["rev-parse", "--git-common-dir"],
      cwd, capture: true, silent: true })).trim();
    return realpath(path.resolve(cwd, value));
  };
  return await common(first) === await common(second);
}

export async function ensureWorktree({ source, destination, revision = "HEAD",
  update = false, runCommand = run }) {
  const git = async (cwd, args) => String(await runCommand({
    cmd: "git", args, cwd, capture: true, silent: true,
  })).trim();
  if (!await exists(path.join(destination, ".git"))) {
    if (await exists(destination)) throw new Error(`Worktree path is occupied: ${destination}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await git(source, ["worktree", "add", "--detach", destination, revision]);
  } else {
    if (!await shareGitRepository(source, destination, runCommand)) {
      throw new Error(`Worktree belongs to a different repository: ${destination}`);
    }
    if (update) {
      const changed = await git(destination, ["status", "--porcelain", "--untracked-files=no"]);
      if (changed) throw new Error(`Worktree has source changes: ${destination}`);
      await git(destination, ["switch", "--detach", revision]);
    }
  }
  return { path: destination, hash: await git(destination, ["rev-parse", "HEAD"]) };
}

export async function ensurePairedWorktrees({ geckoSource, commSource, directory,
  geckoRevision = "HEAD", commRevision = "HEAD", update = false, runCommand = run }) {
  const gecko = path.resolve(directory);
  const comm = path.join(gecko, "comm");
  const geckoTree = await ensureWorktree({ source: geckoSource, destination: gecko,
    revision: geckoRevision, update, runCommand });
  const commTree = await ensureWorktree({ source: commSource, destination: comm,
    revision: commRevision, update, runCommand });
  return { gecko: geckoTree, comm: commTree };
}

export async function writeWorktreeBuildConfig({ gecko, name }) {
  const sccache = await getSccacheConfigureOption();
  const text = ["export SCCACHE_DIRECT=false", "ac_add_options --enable-project=comm/mail",
    ...(sccache ? [sccache] : []),
    `mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-${name}`, ""].join("\n");
  const file = path.join(gecko, ".mozconfig");
  let current = "";
  try { current = await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!current || isGeneratedWorktreeBuildConfig(current)) {
    if (current !== text) await writeFile(file, text);
  }
  return file;
}

export function isGeneratedWorktreeBuildConfig(text) {
  return /^(?:export SCCACHE_DIRECT=false\n)?ac_add_options --enable-project=comm\/mail\n(?:ac_add_options --with-ccache=[^\n]+\n)?mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/obj-[a-z0-9-]+\n$/.test(text);
}

export async function getSccacheConfigureOption() {
  const executable = path.join(os.homedir(), ".mozbuild", "sccache",
    process.platform === "win32" ? "sccache.exe" : "sccache");
  if (!await exists(executable)) return "";
  const target = process.platform === "win32" ? executable.replaceAll("\\", "/") : executable;
  return `ac_add_options --with-ccache='${target.replaceAll("'", "'\\''")}'`;
}
