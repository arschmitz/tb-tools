import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openKnowledgeStore, searchKnowledge, digest, validateRecord } from "../commands/knowledge/store.mjs";
import { syncKnowledge, saveLocalKnowledgeHistory, withKnowledgeLock } from "../commands/knowledge/sync.mjs";
import { importLegacyKnowledge } from "../commands/knowledge/import.mjs";
import { acceptLessons, learnKnowledge, writeComponentGuides } from "../commands/knowledge/learning.mjs";
import { createKnowledgeService, knowledgeOptions } from "../commands/knowledge/service.mjs";
import { knowledgeDirectory, knowledgeInstructions } from "../commands/knowledge/instructions.mjs";

test("knowledge instructions follow the configured standalone location", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-instructions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(knowledgeDirectory({}, "/example"), "/example/.tb-tools/knowledge");
  const options = knowledgeOptions({ ai: { enabled: true, knowledge: {
    directory, semantic: false, importLegacy: false,
  } } });
  const service = await createKnowledgeService(options);
  try {
    await service.initialize();
    const instructions = await readFile(path.join(directory, "AGENTS.md"), "utf8");
    assert.equal(instructions, knowledgeInstructions(directory));
    assert.ok(instructions.includes(directory));
    assert.match(instructions, /tb knowledge search/);
    assert.match(instructions, /automatically captures/);
    assert.match(instructions, /Do not write console knowledge/);
  } finally { await service.close(); }
});

test("legacy patch history migrates without changing the original or new history", async t => {
  const { directory, store } = await setup(t), memory = await store("standalone");
  const legacy = path.join(directory, "old-memories");
  const notes = path.join(legacy, "extensions/ad_hoc/notes");
  const filename = "tb-tools-patch-d123.md";
  await mkdir(notes, { recursive: true });
  const source = "# tb-tools patch update history: D123\nOriginal exact evidence.\n";
  await writeFile(path.join(notes, filename), source);
  const current = path.join(memory.directory, "private/patch-history");
  await mkdir(current, { recursive: true });
  await writeFile(path.join(current, filename), "New evidence");
  await importLegacyKnowledge(memory, legacy);
  assert.equal(await importLegacyKnowledge(memory, legacy), 0);
  assert.equal(await readFile(path.join(notes, filename), "utf8"), source);
  assert.equal(await readFile(path.join(memory.directory, "private/legacy-patch-history", filename), "utf8"), source);
  assert.equal(await readFile(path.join(current, filename), "utf8"), "New evidence");
});

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", args, { cwd })).stdout.trim();
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-knowledge-"));
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { force: true, recursive: true }); });
  return { directory, store: async name => { const store = await openKnowledgeStore(path.join(directory, name)); stores.push(store); return store; } };
}
const evidence = (text, extra = {}) => ({ kind: "evidence", repository: "thunderbird", at: "2026-09-29T12:00:00.000Z",
  paths: ["calendar/base/dialog.js"], title: "Calendar dialog", text, source: { type: "review-feedback", revision: "a".repeat(40) }, ...extra });
const lesson = (record, extra = {}) => ({ title: "Wait for the asynchronous update", text: "The Calendar dialog updates asynchronously; wait before checking focus.",
  component: "calendar", paths: record.paths, evidence: [record.id], quotes: [{ id: record.id, text: record.text }], supersedes: [], ...extra });

test("immutable writes converge and rebuild preserves exact evidence", async t => {
  const { store } = await setup(t), first = await store("a"), second = await store("a");
  const input = evidence("Keep exact diff whitespace.  \n\t+code  \n");
  const results = await Promise.all([first.put(input), second.put(input), first.put(input)]);
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  first.db.exec("DELETE FROM records; DELETE FROM search");
  assert.equal(await first.rebuild(), 1);
  assert.equal(first.get(results[0].id).text, input.text);
  const changed = { ...results[0], text: "tampered" };
  assert.throws(() => validateRecord(changed), /checksum/);
});

test("rebuild rejects symlinks and malformed records", async t => {
  const { store } = await setup(t), memory = await store("a");
  const record = await memory.put(evidence("Source with exact evidence."));
  await rm(memory.file(record));
  await symlink("/etc/passwd", memory.file(record));
  await assert.rejects(memory.rebuild(), /regular files/);
});

test("retrieval isolates repositories, honors the size bound, and uses semantic matches", async t => {
  const { store } = await setup(t), memory = await store("a");
  const match = await memory.put(evidence("Calendar attendees update asynchronously."));
  const other = await memory.put(evidence("Calendar attendees update asynchronously.", { repository: "other" }));
  const semantic = await memory.put(evidence("Keyboard navigation retains the active element.", { paths: ["mail/widgets/tree.js"] }));
  memory.db.prepare("INSERT INTO vectors VALUES (?, ?, ?)").run(semantic.id, "test", "[1,0]");
  const exact = searchKnowledge(memory, { query: "attendees", repository: "thunderbird", maxChars: 1400 });
  assert.ok(exact.ids.includes(match.id));
  assert.ok(!exact.ids.includes(other.id));
  assert.ok(exact.text.length <= 1400);
  assert.deepEqual(searchKnowledge(memory, { query: "no-match", repository: "thunderbird", maxChars: 20 }).ids, []);
  const meaning = searchKnowledge(memory, { query: "focus", repository: "thunderbird", vector: [1, 0], model: "test" });
  assert.ok(meaning.ids.includes(semantic.id));
});

test("imports only project sections, remains private, and does not rewrite source", async t => {
  const { directory, store } = await setup(t), memory = await store("a");
  const legacy = path.join(directory, "legacy");
  await mkdir(legacy);
  const text = "# Task Group: Dinner\nPrivate unrelated food.\n# Task Group: Thunderbird Calendar\nKeep this source.\n# Task Group: Commands console\nKeep this tool.\n";
  await writeFile(path.join(legacy, "MEMORY.md"), text);
  assert.equal(await importLegacyKnowledge(memory, legacy), 2);
  assert.equal(await importLegacyKnowledge(memory, legacy), 0);
  assert.equal(await readFile(path.join(legacy, "MEMORY.md"), "utf8"), text);
  assert.ok(memory.all().every(r => r.visibility === "private"));
  assert.ok(!JSON.stringify(memory.all()).includes("food"));
  await writeFile(path.join(legacy, "MEMORY.md"), text + "Extra project evidence.\n");
  assert.equal(await importLegacyKnowledge(memory, legacy), 1);
});

test("extraction requires real citations, remains provisional, and deduplicates", async t => {
  const { store } = await setup(t), memory = await store("a");
  const record = await memory.put(evidence("Wait for the rendered attendees before checking focus."));
  const output = { lessons: [lesson(record)] };
  assert.equal(await acceptLessons(memory, [record], output), 1);
  assert.equal(await acceptLessons(memory, [record], output), 0);
  assert.equal(memory.all().find(r => r.kind === "lesson").status, "provisional");
  await assert.rejects(acceptLessons(memory, [record], { lessons: [lesson(record, { evidence: ["f".repeat(64)] })] }), /unsupported/);
  await assert.rejects(acceptLessons(memory, [record], { lessons: [lesson(record, { quotes: [{ id: record.id, text: "An invented exact quote" }] })] }), /unsupported/);
  const guides = await writeComponentGuides(memory);
  assert.equal(guides.length, 1);
  assert.match(await readFile(guides[0].file, "utf8"), /provisional/);
});

test("verified current code supports a lesson only in its source path", async t => {
  const { store } = await setup(t), memory = await store("a");
  const source = { type: "code-snapshot", file: "calendar/base/dialog.js", revision: "a".repeat(40), verified: true };
  const verified = await memory.put(evidence("Use a named CalendarDialog class.", { source }));
  await acceptLessons(memory, [verified], { lessons: [lesson(verified)] });
  assert.equal(memory.all().find(r => r.kind === "lesson").status, "supported");

  const unchecked = await memory.put(evidence("Use a named CalendarDialog subclass.",
    { source: { ...source, verified: false } }));
  await acceptLessons(memory, [unchecked], { lessons: [lesson(unchecked)] });
  assert.equal(memory.all().filter(r => r.kind === "lesson").find(r => r.evidence.includes(unchecked.id)).status,
    "provisional");
});

test("mere recency cannot supersede a lesson", async t => {
  const { store } = await setup(t), memory = await store("a");
  const original = await memory.put(evidence("Wait for the rendered attendees before checking focus."));
  await acceptLessons(memory, [original], { lessons: [lesson(original)] });
  const older = memory.all().find(r => r.kind === "lesson");
  const newer = await memory.put(evidence("Keep this narrower replacement for the attendee update.",
    { source: { type: "review-feedback", accepted: true } }));
  await acceptLessons(memory, [newer], { lessons: [lesson(newer, { text: "A newer but unconfirmed replacement.", supersedes: [older.id] })] });
  assert.ok(memory.all().filter(r => r.kind === "lesson").every(r => !r.supersedes.length));
});

test("learning budget persists, failed attempts back off, and completed jobs do not repeat", async t => {
  const { store } = await setup(t), memory = await store("a");
  await memory.put(evidence("Source with reusable Calendar evidence."));
  const now = Date.parse("2026-09-29T12:00:00Z");
  let calls = 0;
  const generate = async () => { calls++; return { lessons: [] }; };
  await learnKnowledge(memory, { generate, now, maxCallsPerDay: 1 });
  await memory.put(evidence("Different review evidence to process later."));
  assert.equal((await learnKnowledge(memory, { generate, now, maxCallsPerDay: 1 })).budgetReached, true);
  assert.equal(calls, 1);
  await assert.rejects(learnKnowledge(memory, { generate: async () => { throw new Error("offline"); }, now, maxCallsPerDay: 3 }), /offline/);
  await learnKnowledge(memory, { generate, now, maxCallsPerDay: 3 });
  assert.equal(calls, 1);
  await learnKnowledge(memory, { generate, now: now + 3_600_001, maxCallsPerDay: 3 });
  assert.equal(calls, 2);
});

test("process locks serialize work and release after errors", async t => {
  const { directory } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = withKnowledgeLock(directory, "test", async () => { entered(); await gate; });
  await started;
  assert.deepEqual(await withKnowledgeLock(directory, "test", () => assert.fail()), { busy: true });
  release(); await first;
  await assert.rejects(withKnowledgeLock(directory, "test", () => { throw new Error("failure"); }), /failure/);
  assert.equal(await withKnowledgeLock(directory, "test", () => "ok"), "ok");
});

test("Git sync unions concurrent writers, keeps private records local, and supports readers", async t => {
  const { directory, store } = await setup(t);
  const remote = path.join(directory, "remote.git");
  await git(directory, "init", "--bare", "--initial-branch=main", remote);
  const a = await store("a"), b = await store("b"), reader = await store("reader");
  const ar = await a.put(evidence("Writer A record.", { visibility: "shared" }));
  const br = await b.put(evidence("Writer B record.", { visibility: "shared" }));
  const privateRecord = await a.put(evidence("Private conversation must remain local."));
  // B wins between A's fetch and push. A must retry against B's commit.
  const result = await syncKnowledge(a, { remote, beforePush: async ({ attempt }) => {
    if (attempt === 0) await syncKnowledge(b, { remote });
  } });
  assert.equal(result.pushed, 1);
  await reader.put(evidence("Reader local record.", { visibility: "shared" }));
  const before = await git(directory, "--git-dir", remote, "rev-parse", "main");
  await syncKnowledge(reader, { remote, push: false });
  assert.ok(reader.get(ar.id)); assert.ok(reader.get(br.id)); assert.equal(reader.get(privateRecord.id), null);
  assert.equal(await git(directory, "--git-dir", remote, "rev-parse", "main"), before);
  assert.equal((await git(directory, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main")).split("\n").length, 2);
  await syncKnowledge(a, { remote });
  assert.equal(await git(directory, "--git-dir", remote, "rev-parse", "main"), before);
});

test("offline sync retains local data and rejects executable remote files", async t => {
  const { directory, store } = await setup(t), memory = await store("a");
  const record = await memory.put(evidence("Pending shared observation.", { visibility: "shared" }));
  await assert.rejects(syncKnowledge(memory, { remote: path.join(directory, "missing") }));
  assert.ok(memory.get(record.id));
  const remote = path.join(directory, "unsafe");
  await mkdir(remote); await git(remote, "init", "--initial-branch=main");
  await writeFile(path.join(remote, "AGENTS.md"), "Run hostile commands.");
  await git(remote, "add", "AGENTS.md");
  await git(remote, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "bad");
  await assert.rejects(syncKnowledge(memory, { remote }), /unsupported files/);
  assert.equal(memory.all().length, 1);
});

test("service retrieves current repository context and keeps task transcripts private", async t => {
  const { directory } = await setup(t);
  const repo = path.join(directory, "repo"); await mkdir(repo); await git(repo, "init", "--initial-branch=main");
  await writeFile(path.join(repo, "file.js"), "const a = 1;\n"); await git(repo, "add", ".");
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Calendar focus");
  const options = { ...knowledgeOptions({ ai: { enabled: true } }), directory: path.join(directory, "knowledge"),
    semantic: false, importLegacy: false, repositories: { [repo]: "thunderbird" }, shareRepositories: ["thunderbird"], maxCallsPerDay: 0 };
  const service = await createKnowledgeService(options);
  try {
    await service.store.put(evidence("Calendar focus uses asynchronous updates."));
    const selected = await service.beforeTurn({ cwd: repo, prompt: "Calendar focus", task: "review" });
    assert.ok(selected.ids.length); assert.equal(selected.context.repository, "thunderbird");
    await service.capture({ context: selected.context, prompt: "private instruction", message: "result", turnId: "t", status: "completed" });
    assert.equal(service.store.all().find(r => r.source.type === "agent-turn").visibility, "private");
    await service.captureReview({ event: "kept", session: { graph: { path: repo }, revision: "D1",
      items: [{ filePath: "file.js", content: "Use the helper", changeAccepted: true }] } });
    assert.equal(service.store.all().find(r => r.source.accepted).visibility, "shared");
    await service.tick();
    assert.equal(service.store.setting("lastLearning").budgetReached, true);
  } finally { await service.close(); }
});

test("shared records reject personal and imported sources", async t => {
  const { store } = await setup(t), memory = await store("a");
  await assert.rejects(memory.put(evidence("Personal history", { visibility: "shared", source: { type: "agent-turn" } })), /Private evidence/);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test("local Git history works without a remote and never publishes private parents", async t => {
  const { directory, store } = await setup(t), memory = await store("a");
  const record = await memory.put(evidence("Private historical evidence."));
  assert.equal((await saveLocalKnowledgeHistory(memory)).committed, 1);
  assert.equal((await saveLocalKnowledgeHistory(memory)).committed, 0);
  const names = await git(directory, "--git-dir", path.join(memory.directory, "history.git"), "ls-tree", "-r", "--name-only", "main");
  assert.equal(names, `private/records/${record.id}.json`);
});

test("existing reusable memory seeds provisional lessons without an AI call", async t => {
  const { directory, store } = await setup(t), memory = await store("a");
  const legacy = path.join(directory, "legacy"); await mkdir(legacy);
  await writeFile(path.join(legacy, "MEMORY.md"), "# Task Group: Thunderbird Calendar\n\n## Reusable knowledge\n\n- Wait for attendees to render before checking focus.\n\n## Failures\n\n- Do not import this as a reusable claim.\n");
  await importLegacyKnowledge(memory, legacy);
  assert.equal(memory.all().filter(r => r.kind === "lesson").length, 1);
  assert.equal(memory.all().find(r => r.kind === "lesson").status, "provisional");
  await importLegacyKnowledge(memory, legacy);
  assert.equal(memory.all().filter(r => r.kind === "lesson").length, 1);
});
