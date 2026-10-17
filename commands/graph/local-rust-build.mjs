import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// These are the files and directories written by comm's tb-rust vendor command.
const generated = ["rust/Cargo.toml", "rust/gkrust/Cargo.toml", "rust/Cargo.lock",
  "rust/.cargo/config.toml.in", "rust/checksums.json", "third_party/rust"];

async function backupDirectory(comm) {
  const dotGit = path.join(comm, ".git");
  const stat = await lstat(dotGit).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  const directory = stat.isDirectory() ? dotGit :
    path.resolve(comm, (await readFile(dotGit, "utf8")).trim().replace(/^gitdir: /, ""));
  return path.join(directory, "tb-local-rust-build");
}

export async function restoreLocalRustBuild(comm) {
  const directory = await backupDirectory(comm);
  if (!directory) return;
  const files = await readFile(path.join(directory, "files.json"), "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!files) return;
  for (const file of generated) {
    const target = path.join(comm, file);
    await rm(target, { recursive: true, force: true });
    if (files.includes(file)) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(directory, file), target, { recursive: true, mode: constants.COPYFILE_FICLONE });
    }
  }
  await rm(directory, { recursive: true, force: true });
}

export async function saveLocalRustBuild(comm) {
  const directory = await backupDirectory(comm);
  if (!directory) throw new Error("Local Rust recovery requires a Git task checkout.");
  await restoreLocalRustBuild(comm);
  const staging = await mkdtemp(`${directory}-`);
  const files = [];
  try {
    for (const file of generated) {
      const source = path.join(comm, file);
      if (!await lstat(source).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      })) continue;
      const target = path.join(staging, file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE });
      files.push(file);
    }
    await writeFile(path.join(staging, "files.json"), JSON.stringify(files));
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
