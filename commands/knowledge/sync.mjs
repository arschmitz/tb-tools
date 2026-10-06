import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { canonical, validateRecord } from "./store.mjs";

const execute = promisify(execFile);

export async function saveLocalKnowledgeHistory(store) {
  return withKnowledgeLock(store.directory, "history", async () => {
    const repository = path.join(store.directory, "history.git");
    await mkdir(repository, { recursive: true, mode: 0o700 });
    const index = path.join(store.directory, `history-index-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "TB Knowledge", GIT_AUTHOR_EMAIL: "knowledge@localhost",
      GIT_COMMITTER_NAME: "TB Knowledge", GIT_COMMITTER_EMAIL: "knowledge@localhost", GIT_TERMINAL_PROMPT: "0" };
    const git = async args => (await execute("git", ["--git-dir", repository, "-c", "core.hooksPath=/dev/null", ...args],
      { env, timeout: 30_000, maxBuffer: 8_000_000 })).stdout.trim();
    await git(["init", "--bare", "--initial-branch=main"]);
    try {
      const parent = await git(["rev-parse", "--verify", "refs/heads/main"]).catch(() => "");
      const known = new Set(parent ? (await git(["ls-tree", "-r", "--name-only", parent])).split("\n") : []);
      const pending = store.all().filter(record => !known.has(`${record.visibility}/records/${record.id}.json`));
      if (!pending.length) return { committed: 0, commit: parent };
      await git(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
      for (const record of pending) {
        const file = store.file(record);
        if (canonical(JSON.parse(await readFile(file, "utf8"))) !== canonical(record)) throw new Error("Local knowledge record changed.");
        const blob = await git(["hash-object", "-w", "--", file]);
        await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${record.visibility}/records/${record.id}.json`]);
      }
      const tree = await git(["write-tree"]);
      const commit = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Record local knowledge"]);
      await git(["update-ref", "refs/heads/main", commit, parent || "0".repeat(40)]);
      return { committed: pending.length, commit };
    } finally { await rm(index, { force: true }); }
  });
}

// Separate processes may run consoles against the same knowledge directory.
export async function withKnowledgeLock(directory, name, work) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(directory, "locks.sqlite"));
  const token = randomUUID();
  try {
    db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, host TEXT, pid INTEGER, token TEXT); BEGIN IMMEDIATE;");
    const owner = db.prepare("SELECT * FROM locks WHERE name=?").get(name);
    let alive = Boolean(owner);
    if (owner?.host === os.hostname()) {
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
    }
    if (alive) { db.exec("ROLLBACK"); return { busy: true }; }
    db.prepare("INSERT OR REPLACE INTO locks VALUES (?, ?, ?, ?)").run(name, os.hostname(), process.pid, token);
    db.exec("COMMIT");
    return await work();
  } finally {
    try { db.prepare("DELETE FROM locks WHERE name=? AND token=?").run(name, token); } finally { db.close(); }
  }
}

export async function syncKnowledge(store, { remote, push = true, branch = "main", beforePush } = {}) {
  if (!remote) return { localOnly: true };
  if (typeof remote !== "string" || remote.startsWith("-") || /[\r\n]/.test(remote) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(branch) || branch.includes("..")) throw new Error("Invalid knowledge remote or branch.");
  return withKnowledgeLock(store.directory, "sync", async () => {
    const transport = path.join(store.directory, "transport.git");
    await mkdir(transport, { recursive: true, mode: 0o700 });
    const index = path.join(store.directory, `sync-index-${randomUUID()}`);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: "TB Knowledge", GIT_AUTHOR_EMAIL: "knowledge@localhost",
      GIT_COMMITTER_NAME: "TB Knowledge", GIT_COMMITTER_EMAIL: "knowledge@localhost" };
    const git = async args => (await execute("git", ["--git-dir", transport, "-c", "core.hooksPath=/dev/null", ...args],
      { env, timeout: 30_000, maxBuffer: 8_000_000 })).stdout;
    await git(["init", "--bare", "--initial-branch=main"]);
    let received = 0;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const advertised = await git(["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`]);
        let parent = "";
        const remoteRecords = new Map();
        if (advertised.trim()) {
          await git(["fetch", "--no-tags", "--", remote, `refs/heads/${branch}`]);
          parent = (await git(["rev-parse", "FETCH_HEAD"])).trim();
          const tree = (await git(["ls-tree", "-r", "-z", parent])).split("\0").filter(Boolean);
          // A remote is a data source. Never check out files, hooks, or instructions from it.
          for (const entry of tree) {
            const match = entry.match(/^100644 blob ([a-f0-9]+)\trecords\/([a-f0-9]{64})\.json$/);
            if (!match) throw new Error("Knowledge remote contains unsupported files or modes.");
            const size = Number((await git(["cat-file", "-s", match[1]])).trim());
            if (size > 4_000_000) throw new Error("Remote knowledge record is too large.");
            const record = validateRecord(JSON.parse(await git(["cat-file", "blob", match[1]])));
            if (record.id !== match[2] || record.visibility !== "shared") throw new Error("Invalid shared knowledge record.");
            remoteRecords.set(record.id, record);
          }
          for (const record of remoteRecords.values()) {
            const existed = store.get(record.id);
            await store.put(record);
            if (!existed) received++;
          }
        }
        if (!push) return { received, pushed: 0 };
        const pending = store.all().filter(record => record.visibility === "shared" && !remoteRecords.has(record.id));
        if (!pending.length) return { received, pushed: 0 };
        await git(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
        for (const record of pending) {
          const file = store.file(record);
          // Hash the immutable file. The index is disposable and never touches source checkouts.
          if (canonical(JSON.parse(await readFile(file, "utf8"))) !== canonical(record)) throw new Error("Local knowledge record changed.");
          const oid = (await git(["hash-object", "-w", "--", file])).trim();
          await git(["update-index", "--add", "--cacheinfo", `100644,${oid},records/${record.id}.json`]);
        }
        const tree = (await git(["write-tree"])).trim();
        const commit = (await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Add knowledge records"])).trim();
        await beforePush?.({ attempt, commit });
        try {
          await git(["push", "--", remote, `${commit}:refs/heads/${branch}`]);
          return { received, pushed: pending.length };
        } catch (error) {
          if (attempt === 3 || !/rejected|fetch first|non-fast-forward|cannot lock ref/i.test(error.stderr || error.message)) throw error;
          // Fetch the winner, union immutable records, and retry. Never force-push.
        }
      }
    } finally { await rm(index, { force: true }); }
  });
}
