import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  const cache = path.join(process.env.TB_BUILD_CACHE_PATH || path.join(os.homedir(), ".tb-tools", "build-cache"), "compiler");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const serverId = createHash("sha256").update(path.resolve(gecko)).digest("hex").slice(0, 12);
  const server = process.platform === "win32"
    ? `export SCCACHE_SERVER_PORT=${20000 + parseInt(serverId.slice(0, 4), 16) % 40000}`
    : `export SCCACHE_SERVER_UDS=${quote(path.join(os.tmpdir(), `tb-cache-${serverId}.sock`))}`;
  const text = ["export SCCACHE_DIRECT=false", server, "export SCCACHE_IDLE_TIMEOUT=120", `export SCCACHE_BASEDIRS=${quote(path.resolve(gecko))}`,
    `export SCCACHE_DIR=${quote(cache)}`, "ac_add_options --enable-project=comm/mail",
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
  return /^(?:export SCCACHE_(?:DIRECT|BASEDIRS|DIR|SERVER_UDS|SERVER_PORT|IDLE_TIMEOUT)=[^\n]+\n)*ac_add_options --enable-project=comm\/mail\n(?:ac_add_options --with-ccache=[^\n]+\n)?mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/obj-[a-z0-9-]+\n$/.test(text);
}

export async function getSccacheConfigureOption() {
  const executable = path.join(os.homedir(), ".mozbuild", "sccache",
    process.platform === "win32" ? "sccache.exe" : "sccache");
  if (!await exists(executable)) return "";
  const target = process.platform === "win32" ? executable.replaceAll("\\", "/") : executable;
  return `ac_add_options --with-ccache='${target.replaceAll("'", "'\\''")}'`;
}
