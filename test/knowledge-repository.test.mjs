import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { readKnowledgeRepository, syncKnowledgeRepository } from "../commands/knowledge/repository.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
const note = (title, extra = "") => `<!-- knowledge: {"repository":"thunderbird","at":"2026-10-06T12:00:00Z","paths":[],"source":{"reference":"review:D123"}} -->\n# ${title}\nEvidence with exact source and scope. ${extra}\n`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tb-shared-memory-")), stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(root, { recursive: true, force: true }); });
  const seed = path.join(root, "seed"); await mkdir(seed);
  await git(seed, "init", "-b", "main"); await writeFile(path.join(seed, "AGENTS.md"), "Read targeted evidence.\n");
  await git(seed, "add", "."); await git(seed, "commit", "-m", "Instructions");
  const remote = path.join(root, "remote.git"); await git(root, "clone", "--bare", seed, remote);
  const clone = async name => {
    const directory = path.join(root, name); await git(root, "clone", remote, directory);
    const store = await openKnowledgeStore(path.join(root, `${name}-cache`)); stores.push(store);
    await mkdir(path.join(directory, "notes"), { recursive: true });
    return { directory, store };
  };
  return { root, remote, clone };
}

test("memory checkout combines concurrent notes and records without private history", async t => {
  const { root, remote, clone } = await fixture(t), a = await clone("a"), b = await clone("b");
  await writeFile(path.join(a.directory, "notes/a.md"), note("First"));
  await writeFile(path.join(b.directory, "notes/b.md"), note("Second"));
  await a.store.put({ kind: "evidence", repository: "thunderbird", at: "2026-10-06T12:00:00Z", text: "Personal transcript",
    source: { type: "agent-turn", personal: true } });
  const result = await syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory,
    beforePush: async ({ attempt }) => { if (!attempt) await syncKnowledgeRepository(b.store, { repositoryDirectory: b.directory }); } });
  assert.equal(result.pushed, true);
  const files = await git(root, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main");
  assert.match(files, /notes\/a.md/); assert.match(files, /notes\/b.md/); assert.match(files, /AGENTS.md/);
  assert.doesNotMatch(files, /private|history.git/);
  assert.equal(a.store.all().filter(r => r.visibility === "shared").length, 2);
  assert.equal(await git(a.directory, "status", "--porcelain"), "");
  const reader = await clone("reader"), before = await git(root, "--git-dir", remote, "rev-parse", "main");
  await syncKnowledgeRepository(reader.store, { repositoryDirectory: reader.directory, push: false });
  assert.equal(await git(root, "--git-dir", remote, "rev-parse", "main"), before);
  assert.ok(reader.store.all().every(record => record.visibility === "shared"));
});

test("memory sync preserves user instruction edits and rejects changed historical notes", async t => {
  const { clone } = await fixture(t), a = await clone("a");
  await writeFile(path.join(a.directory, "notes/a.md"), note("Original"));
  await syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory });
  await writeFile(path.join(a.directory, "AGENTS.md"), "User's unfinished instructions\n");
  await assert.rejects(syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory }), /tracked memory repository edits/);
  assert.equal(await readFile(path.join(a.directory, "AGENTS.md"), "utf8"), "User's unfinished instructions\n");
  await writeFile(path.join(a.directory, "notes/a.md"), note("Edited"));
  await assert.rejects(readKnowledgeRepository(a.store, a.directory), /Shared note was edited/);
});

test("memory sync accepts plain notes without installed console commands", async t => {
  const { clone } = await fixture(t), a = await clone("a");
  await writeFile(path.join(a.directory, "notes/manual.md"), note("Manual evidence"));
  await readKnowledgeRepository(a.store, a.directory);
  assert.equal(a.store.all()[0].title, "Manual evidence");
  assert.equal(a.store.all()[0].source.reference, "review:D123");
});

test("shared skills sync as reviewed instructions without becoming learning evidence", async t => {
  const { root, remote, clone } = await fixture(t), a = await clone("skills-writer");
  const folder = path.join(a.directory, "skills/thunderbird-review");
  await mkdir(path.join(folder, "references"), { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), "---\nname: thunderbird-review\ndescription: Review an exact patch.\n---\nRead the raw diff.\n");
  await writeFile(path.join(folder, "references/anchors.md"), "Use exact raw-diff coordinates.\n");
  await writeFile(path.join(a.directory, "SKILLS.md"), "Read the selected standalone workflow.\n");
  await git(a.directory, "add", "skills", "SKILLS.md");
  await git(a.directory, "commit", "-m", "Add reviewed skill instructions");
  await writeFile(path.join(a.directory, "notes/result.md"), note("Review observation"));
  const result = await syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory });
  assert.equal(result.pushed, true);
  const reader = await clone("skills-reader");
  await syncKnowledgeRepository(reader.store, { repositoryDirectory: reader.directory, push: false });
  assert.equal(await readFile(path.join(reader.directory, "skills/thunderbird-review/references/anchors.md"), "utf8"), "Use exact raw-diff coordinates.\n");
  assert.deepEqual(reader.store.all().map(record => record.title), ["Review observation"]);
  assert.equal(reader.store.db.prepare("SELECT count(*) AS count FROM jobs").get().count, 1);
  const tip = await git(root, "--git-dir", remote, "rev-parse", "main");
  await writeFile(path.join(folder, "SKILL.md"), "Unfinished user edit\n");
  await assert.rejects(syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory }), /tracked memory repository edits/);
  assert.equal(await readFile(path.join(folder, "SKILL.md"), "utf8"), "Unfinished user edit\n");
  assert.equal(await git(root, "--git-dir", remote, "rev-parse", "main"), tip);
});

test("shared skill support still rejects scripts, executable files, and symbolic links", async t => {
  const { clone } = await fixture(t);
  for (const variant of ["script", "executable", "symlink"]) {
    const a = await clone(variant), folder = path.join(a.directory, "skills/thunderbird-review");
    await mkdir(folder, { recursive: true });
    if (variant === "script") {
      await mkdir(path.join(folder, "scripts"));
      await writeFile(path.join(folder, "scripts/run.sh"), "#!/bin/sh\nexit 0\n");
    } else if (variant === "executable") {
      await writeFile(path.join(folder, "SKILL.md"), "Reviewed instructions\n");
      await chmod(path.join(folder, "SKILL.md"), 0o755);
    } else await symlink("../../AGENTS.md", path.join(folder, "SKILL.md"));
    await git(a.directory, "add", "skills");
    await git(a.directory, "commit", "-m", "Unsupported skill file");
    await assert.rejects(syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory }), /unsupported files or modes/);
  }
});
