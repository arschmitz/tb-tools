import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, lstat, mkdir, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { canonical, digest, validateRecord } from "./store.mjs";
import { withKnowledgeLock } from "./sync.mjs";
import { readGitBlobs } from "./git-data.mjs";
import { publishProjectLessons, exportLessonNotes } from "./publication.mjs";

const execute = promisify(execFile);
const documents = new Set(["README.md", "AGENTS.md", "CONTRIBUTING.md", "FORMAT.md", "SCHEMA.md", "CONSUMING.md", "SKILLS.md", ".gitignore"]);
const skillDocument = /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:SKILL\.md|references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;
const instructionFile = file => documents.has(file) || skillDocument.test(file);
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
  if (instructionFile(file)) return;
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
    const folderStat = await lstat(path.join(directory, folder)).catch(error => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (!folderStat) continue;
    if (!folderStat.isDirectory()) throw new Error(`Invalid knowledge folder: ${folder}`);
    for (const name of await readdir(path.join(directory, folder))) {
      const file = `${folder}/${name}`, absolute = path.join(directory, file);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > 4_000_000) throw new Error(`Invalid knowledge file: ${file}`);
      if (!(noteName.test(file) || recordName.test(file))) throw new Error(`Unsupported knowledge file: ${file}`);
      if (store.unchangedFile(absolute, stat)) continue;
      const text = await readFile(absolute, "utf8");
      await importFile(store, file, text);
      const id = noteName.test(file) ? parseKnowledgeNote(text).id : name.slice(0, -5);
      store.rememberFile(absolute, stat, id);
    }
  }
}

async function importTree(store, directory, ref) {
  const entries = (await git(directory, ["ls-tree", "-r", "-z", ref])).split("\0").filter(Boolean);
  const pending = [];
  for (const entry of entries) {
    const match = entry.match(/^100644 blob ([a-f0-9]+)\t(.+)$/);
    if (!match || !(instructionFile(match[2]) || noteName.test(match[2]) || recordName.test(match[2]))) {
      throw new Error("Knowledge repository contains unsupported files or modes.");
    }
    const key = `repository-blob:${directory}:${match[2]}`;
    if (store.setting(key) === match[1]) continue;
    pending.push({ oid: match[1], file: match[2], key });
  }
  await readGitBlobs(pending, async ({ file, key, oid }, text) => {
    await importFile(store, file, text); store.setting(key, oid);
  }, { cwd: directory });
}

export async function knowledgeRepositoryRemote(directory) {
  return directory ? await git(directory, ["remote", "get-url", "origin"]).catch(() => "") : "";
}

export async function readKnowledgeRepository(store, directory) {
  if (directory) await importCheckout(store, directory);
}

export async function syncKnowledgeRepository(store, { repositoryDirectory, push = true, beforePush, shareRepositories = [] } = {}) {
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
      await publishProjectLessons(store, { shareRepositories });
      for (const lesson of store.all().filter(record => record.kind === "lesson" && record.visibility === "shared")) {
        if (lesson.evidence.some(id => store.get(id)?.visibility !== "shared" || store.get(id)?.repository !== lesson.repository) ||
            lesson.quotes?.some(quote => !lesson.evidence.includes(quote.id) || !store.get(quote.id)?.text.includes(quote.text))) {
          throw new Error(`Shared lesson has unavailable or invalid citations: ${lesson.id}`);
        }
      }
      await exportLessonNotes(store, root);
      await mkdir(path.join(root, "records"), { recursive: true });
      for (const record of store.all().filter(record => record.visibility === "shared")) {
        const file = path.join(root, "records", `${record.id}.json`);
        const stat = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (stat && !stat.isFile()) throw new Error("Shared records must be regular files.");
        if (stat && store.unchangedFile(file, stat)) continue;
        try { await copyFile(store.file(record), file, constants.COPYFILE_EXCL); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (canonical(JSON.parse(await readFile(file, "utf8"))) !== canonical(record)) throw new Error("Shared record collision.");
        }
        store.rememberFile(file, await lstat(file), record.id);
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
