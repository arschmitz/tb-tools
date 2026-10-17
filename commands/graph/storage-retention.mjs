import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import path from "node:path";

export const STORAGE_LIMITS = {
  tryEvidence: { maxBytes: 5 * 1024 ** 3, maxAgeMs: 7 * 86400000 },
  assessmentEvidence: { maxBytes: 2 * 1024 ** 3, maxAgeMs: 7 * 86400000 },
  buildSnapshots: { maxBytes: 10 * 1024 ** 3, maxAgeMs: 14 * 86400000 },
  dailyLogs: { maxBytes: 256 * 1024 ** 2, maxAgeMs: 14 * 86400000 },
};

async function entries(directory) {
  try { return await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function size(file) {
  const info = await lstat(file);
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await entries(file)) bytes += await size(path.join(file, name));
  return bytes;
}

async function lockStorage(directory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, ".retention.lock");
  for (;;) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(await readFile(file, "utf8").catch(error => {
        if (error.code === "ENOENT") return "";
        throw error;
      }));
      if (pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === "ESRCH") { await rm(file, { force: true }); continue; } }
      }
      await setTimeout(50);
    }
  }
}

// A live reader or writer protects its files across desktop processes.
export async function leaseStorage(directory, protectedPaths = [directory]) {
  const unlock = await lockStorage(directory);
  try {
  const leases = path.join(directory, ".leases");
  await mkdir(leases, { recursive: true });
  const file = path.join(leases, `${process.pid}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ pid: process.pid, paths: protectedPaths.map(value => path.resolve(value)) }));
  return () => rm(file, { force: true });
  } finally { await unlock(); }
}

export async function pruneStorage({ directory, maxBytes, maxAgeMs, now = Date.now(),
  keepPaths = [], select = () => true }) {
  const unlock = await lockStorage(directory);
  try {
  const protectedPaths = keepPaths.map(value => path.resolve(value));
  const leases = path.join(directory, ".leases");
  for (const name of await entries(leases)) {
    const file = path.join(leases, name);
    try {
      const lease = JSON.parse(await readFile(file, "utf8"));
      try { process.kill(lease.pid, 0); protectedPaths.push(...lease.paths); }
      catch (error) { if (error.code === "ESRCH") await rm(file, { force: true }); else throw error; }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const protectedEntry = file => protectedPaths.some(value => value === file ||
    value.startsWith(`${file}${path.sep}`) || file.startsWith(`${value}${path.sep}`));
  const items = [];
  for (const name of await entries(directory)) {
    if (name.startsWith(".") || !select(name)) continue;
    const file = path.resolve(directory, name);
    try {
      const info = await lstat(file);
      items.push({ file, bytes: await size(file), time: info.mtimeMs, protected: protectedEntry(file) });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  items.sort((a, b) => a.time - b.time);
  let bytes = items.reduce((total, item) => total + item.bytes, 0);
  let removedBytes = 0;
  const removed = [];
  for (const item of items) {
    if (item.protected || (now - item.time <= maxAgeMs && bytes <= maxBytes)) continue;
    await rm(item.file, { recursive: true, force: true });
    bytes -= item.bytes;
    removedBytes += item.bytes;
    removed.push(item.file);
  }
  return { bytes, removedBytes, removed };
  } finally { await unlock(); }
}
