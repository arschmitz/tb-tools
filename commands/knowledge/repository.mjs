import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, lstat, mkdir, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { canonical, digest, validateRecord } from "./store.mjs";
import { withKnowledgeLock } from "./sync.mjs";

const execute = promisify(execFile);
const documents = new Set(["README.md", "AGENTS.md", "CONTRIBUTING.md", "FORMAT.md", ".gitignore"]);
const noteName = /^notes\/[a-z0-9-]+\.md$/;
const recordName = /^records\/[a-f0-9]{64}\.json$/;
const git = async (cwd, args) => (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
  cwd, timeout: 30_000, maxBuffer: 8_000_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
})).stdout.trim();

export function parseKnowledgeNote(text) {
  const match = text.match(/^<!-- knowledge: (.+) -->\r?\n([\s\S]+)$/);
  if (!match) throw new Error("Knowledge note needs a JSON metadata header.");
  const metadata = JSON.parse(match[1]);
  if (!metadata.source?.reference || !metadata.repository || !metadata.at || !Array.isArray(metadata.paths)) {
    throw new Error("Knowledge note needs repository, date, paths, and a source reference.");
  }
  const body = { version: 1, kind: "evidence", visibility: "shared", repository: metadata.repository,
    at: metadata.at, paths: metadata.paths, source: { ...metadata.source, type: "shared-note" },
    title: match[2].match(/^# (.+)/)?.[1] || "Shared knowledge note", text: match[2].trim() };
  return validateRecord({ ...body, id: digest(body) });
}

async function importFile(store, file, text) {
  if (documents.has(file)) return;
  if (noteName.test(file)) {
    const fingerprint = digest(text.trimEnd()), key = `shared-note:${file}`;
    if (store.setting(key) && store.setting(key) !== fingerprint) throw new Error(`Shared note was edited: ${file}. Add a correction instead.`);
    await store.put(parseKnowledgeNote(text));
    store.setting(key, fingerprint);
    return;
  }
  if (!recordName.test(file)) throw new Error(`Unsupported knowledge file: ${file}`);
  const record = validateRecord(JSON.parse(text));
  if (record.visibility !== "shared" || file !== `records/${record.id}.json`) throw new Error("Invalid shared record location.");
  await store.put(record);
}

async function importCheckout(store, directory) {
  for (const folder of ["notes", "records"]) {
    for (const name of await readdir(path.join(directory, folder)).catch(error => {
      if (error.code === "ENOENT") return []; throw error;
    })) {
      const file = `${folder}/${name}`, absolute = path.join(directory, file);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > 4_000_000) throw new Error(`Invalid knowledge file: ${file}`);
      await importFile(store, file, await readFile(absolute, "utf8"));
    }
  }
}

async function importTree(store, directory, ref) {
  const entries = (await git(directory, ["ls-tree", "-r", "-z", ref])).split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^100644 blob ([a-f0-9]+)\t(.+)$/);
    if (!match || !(documents.has(match[2]) || noteName.test(match[2]) || recordName.test(match[2]))) {
      throw new Error("Knowledge repository contains unsupported files or modes.");
    }
    if (Number(await git(directory, ["cat-file", "-s", match[1]])) > 4_000_000) throw new Error("Knowledge file is too large.");
    if (!documents.has(match[2])) await importFile(store, match[2], await git(directory, ["cat-file", "blob", match[1]]));
  }
}

export async function readKnowledgeRepository(store, directory) {
  if (directory) await importCheckout(store, directory);
}

export async function syncKnowledgeRepository(store, { repositoryDirectory, push = true, beforePush } = {}) {
  if (!repositoryDirectory) return { localOnly: true };
  return withKnowledgeLock(store.directory, "shared-repository", async () => {
    const root = repositoryDirectory;
    const branch = await git(root, ["symbolic-ref", "--short", "HEAD"]);
    // Never stage edits to instructions, existing records, or other user work.
    if (await git(root, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new Error("Commit or restore tracked memory repository edits before automatic sync.");
    }
    await importTree(store, root, "HEAD");
    await importCheckout(store, root);
    if (push) {
      await mkdir(path.join(root, "records"), { recursive: true });
      for (const record of store.all().filter(record => record.visibility === "shared")) {
        const file = path.join(root, "records", `${record.id}.json`);
        try { await copyFile(store.file(record), file, constants.COPYFILE_EXCL); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (canonical(JSON.parse(await readFile(file, "utf8"))) !== canonical(record)) throw new Error("Shared record collision.");
        }
      }
      const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0")
        .filter(file => noteName.test(file) || recordName.test(file));
      for (let offset = 0; offset < untracked.length; offset += 100) {
        await git(root, ["add", "--", ...untracked.slice(offset, offset + 100)]);
      }
      if (untracked.length) await git(root, ["-c", "user.name=TB Knowledge", "-c", "user.email=knowledge@localhost",
        "-c", "commit.gpgsign=false", "commit", "-m", "Add knowledge evidence"]);
    }
    const remote = await git(root, ["remote", "get-url", "origin"]).catch(() => "");
    if (!remote) return { localOnly: true, repositoryDirectory: root };
    for (let attempt = 0; attempt < 4; attempt++) {
      const exists = await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
      if (exists) {
        await git(root, ["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
        await importTree(store, root, "FETCH_HEAD");
        // Unique immutable files merge normally. Governance conflicts require review.
        try { await git(root, ["-c", "user.name=TB Knowledge", "-c", "user.email=knowledge@localhost",
          "-c", "commit.gpgsign=false", "merge", "--no-edit", "FETCH_HEAD"]); }
        catch (error) {
          await git(root, ["merge", "--abort"]).catch(() => {});
          throw new Error(`Knowledge merge needs review: ${error.message}`);
        }
      }
      if (!push) return { pulled: true, pushed: false };
      await beforePush?.({ attempt });
      try {
        await git(root, ["push", "origin", `HEAD:refs/heads/${branch}`]);
        return { pulled: Boolean(exists), pushed: true };
      } catch (error) {
        if (attempt === 3 || !/rejected|fetch first|non-fast-forward|cannot lock ref/i.test(error.stderr || error.message)) throw error;
      }
    }
  });
}
