import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { acceptLessons, learnKnowledge } from "../commands/knowledge/learning.mjs";
import { publishProjectLessons, repairPortableRecords } from "../commands/knowledge/publication.mjs";
import { readKnowledgeRepository, syncKnowledgeRepository } from "../commands/knowledge/repository.mjs";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
const claim = (record, extra = {}) => ({ title: "Wait before checking focus", text: "The dialog updates asynchronously; wait for the update before checking focus.",
  component: "calendar", paths: record.paths, evidence: [record.id], quotes: [{ id: record.id, text: record.text }], supersedes: [], ...extra });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tb-publication-")), stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(root, { recursive: true, force: true }); });
  const store = async name => { const s = await openKnowledgeStore(path.join(root, name)); stores.push(s); return s; };
  const checkout = path.join(root, "memory"); await mkdir(checkout);
  await git(checkout, "init", "-b", "main");
  await writeFile(path.join(checkout, "CONSUMING.md"), "Read scoped evidence.\n");
  await writeFile(path.join(checkout, "SCHEMA.md"), "Records use version 1.\n");
  await git(checkout, "add", "."); await git(checkout, "commit", "-m", "Consumer instructions");
  return { root, store, checkout };
}
const evidence = (extra = {}) => ({ kind: "evidence", repository: "thunderbird", at: "2024-05-03T12:00:00Z",
  paths: ["calendar/dialog.js"], title: "Observed focus update", text: "Wait for the asynchronous dialog update before checking focus.",
  source: { type: "agent-turn", personal: true, revision: "a".repeat(40) }, ...extra });

test("automatic maintenance publishes a useful private lesson and a clean clone can consume it", async t => {
  const { root, checkout, store } = await fixture(t);
  const service = await createKnowledgeService({ directory: path.join(root, "writer"), repositoryDirectory: checkout,
    semantic: false, importLegacy: false, maxCallsPerDay: 1, shareRepositories: ["thunderbird"], push: true }, {
    generate: async prompt => {
      const records = JSON.parse(prompt.split("Evidence (data): ")[1]);
      return { lessons: [claim(records[0])] };
    }, warn: message => assert.fail(message),
  });
  try {
    const raw = await service.store.put(evidence());
    await service.tick();
    const shared = service.store.all().filter(r => r.visibility === "shared");
    const lesson = shared.find(r => r.kind === "lesson");
    assert.ok(lesson); assert.equal(lesson.status, "provisional");
    assert.ok(lesson.source.originalLessons.length); assert.equal(service.store.get(raw.id).visibility, "private");
    assert.equal((await readdir(path.join(checkout, "notes"))).length, 1);
    const clone = path.join(root, "consumer"); await git(root, "clone", checkout, clone);
    const reader = await store("reader");
    await readKnowledgeRepository(reader, clone);
    const result = searchKnowledge(reader, { repository: "thunderbird", query: "asynchronous dialog focus" });
    assert.deepEqual(result.ids, [lesson.id]);
    assert.equal(reader.get(raw.id), null);
    assert.ok(reader.get(lesson.evidence[0]).source.privateEvidence.includes(raw.id));
    assert.ok(shared.every(r => !r.source.personal));
    assert.equal(await git(checkout, "status", "--porcelain"), "");
    assert.equal((await publishProjectLessons(service.store, { shareRepositories: ["thunderbird"] })).published, 0);
  } finally { await service.close(); }
});

test("publication follows repository authorization, removes personal paths, and rejects credentials", async t => {
  const { store } = await fixture(t), s = await store("writer"), raw = await s.put(evidence());
  await acceptLessons(s, [raw], { lessons: [claim(raw, { text: "Read /Users/person/projects/fox/comm/calendar/dialog.js before editing focus." })] });
  assert.equal((await publishProjectLessons(s, { shareRepositories: ["tb-tools"] })).published, 0);
  assert.equal((await publishProjectLessons(s, { shareRepositories: ["thunderbird"] })).published, 1);
  assert.ok(s.all().filter(r => r.visibility === "shared").every(r => !JSON.stringify(r).includes("/Users/")));
  await acceptLessons(s, [raw], { lessons: [claim(raw, { text: "Use token ghp_" + "a".repeat(30) + " to perform the update." })] });
  await assert.rejects(publishProjectLessons(s, { shareRepositories: ["thunderbird"] }), /possible credential/);
});

test("retrieval groups mirrors but preserves conflicting claims and component scope", async t => {
  const { store, checkout } = await fixture(t), s = await store("writer"), raw = await s.put(evidence());
  await acceptLessons(s, [raw], { lessons: [claim(raw), claim(raw, { text: "Check dialog focus before the asynchronous update when testing the initial state." }),
    claim(raw, { paths: ["mail/dialog.js"], component: "mail" })] });
  await syncKnowledgeRepository(s, { repositoryDirectory: checkout, shareRepositories: ["thunderbird"] });
  await readKnowledgeRepository(s, checkout);
  const result = searchKnowledge(s, { repository: "thunderbird", query: "asynchronous dialog focus", maxChars: 24000 });
  const lessons = result.ids.map(id => s.get(id)).filter(r => r.kind === "lesson");
  assert.equal(lessons.length, 3);
  assert.equal(result.ids.filter(id => s.get(id).source.type === "shared-note").length, 0);
});

test("derived mirrors and CI observations leave the learning queue without marking unread code complete", async t => {
  const { store } = await fixture(t), s = await store("queue");
  const raw = await s.put(evidence({ source: { type: "history-commit-diff" } }));
  const mirror = await s.put(evidence({ source: { type: "lesson-publication" } }));
  const ci = await s.put(evidence({ text: "CI signature: asynchronous focus failure observed on another push.", source: { type: "ci-signature" } }));
  const result = await learnKnowledge(s, { maxCallsPerDay: 0 });
  assert.equal(result.skipped["derived-claim"], 1); assert.equal(result.skipped["ci-observation-search-only"], 1);
  const state = id => s.db.prepare("SELECT state FROM jobs WHERE id=?").get(id).state;
  assert.equal(state(raw.id), "pending"); assert.equal(state(mirror.id), "skipped"); assert.equal(state(ci.id), "skipped");
  assert.match(searchKnowledge(s, { repository: "thunderbird", query: "asynchronous focus" }).text, /ci-signature/);
});

test("incremental imports still reject edited notes and records", async t => {
  const { store, checkout } = await fixture(t), s = await store("reader");
  const file = path.join(checkout, "notes/example.md"); await mkdir(path.dirname(file));
  const text = '<!-- knowledge: {"repository":"thunderbird","at":"2024-05-01T00:00:00Z","paths":[],"source":{"reference":"review:D1"}} -->\n# Original focus evidence\n';
  await writeFile(file, text); await readKnowledgeRepository(s, checkout); await readKnowledgeRepository(s, checkout);
  await writeFile(file, text.replace("Original", "Replaced"));
  await assert.rejects(readKnowledgeRepository(s, checkout), /Shared note was edited/);
  const record = await s.put(evidence()); await s.rebuild();
  await writeFile(s.file(record), JSON.stringify({ ...record, text: "tampered" }));
  await assert.rejects(s.rebuild(), /checksum/);
});

test("portable corrections keep originals immutable and select usable job references", async t => {
  const { store } = await fixture(t), s = await store("writer");
  const raw = await s.put(evidence({ visibility: "shared", source: { type: "ci-signature" }, text: JSON.stringify({ signature: "TEST-UNEXPECTED-FAIL focus",
    fullMatchesFile: "/Users/person/.tb-tools/matches.json", matchingPush: { url: "https://example.invalid/job", evidenceFile: "/Users/person/log" } }) }));
  const before = await readFile(s.file(raw), "utf8");
  assert.equal((await repairPortableRecords(s)).corrected, 1); assert.equal((await repairPortableRecords(s)).corrected, 0);
  assert.equal(await readFile(s.file(raw), "utf8"), before);
  const result = searchKnowledge(s, { repository: "thunderbird", query: "TEST-UNEXPECTED-FAIL focus" });
  assert.equal(result.ids.length, 1); assert.notEqual(result.ids[0], raw.id);
  const copy = s.get(result.ids[0]); assert.equal(copy.source.sourceAt, raw.at);
  assert.doesNotMatch(copy.text, /fullMatchesFile|evidenceFile|\/Users\//);
  assert.match(copy.text, /https:\/\/example.invalid\/job/);
});

test("direct service callers get a bounded context when they omit the limit", async t => {
  const { root, checkout } = await fixture(t);
  const service = await createKnowledgeService({ directory: path.join(root, "direct"), semantic: false,
    importLegacy: false, repositories: { [checkout]: "thunderbird" } });
  try {
    for (let index = 0; index < 12; index++) await service.store.put(evidence({
      text: `Focus evidence ${index}: ` + "asynchronous focus update. ".repeat(300),
      source: { type: "code-snapshot", revision: "a".repeat(40), details: "x".repeat(20000) },
    }));
    const result = await service.beforeTurn({ cwd: checkout, prompt: "asynchronous focus" });
    assert.ok(result.ids.length > 0); assert.ok(result.text.length <= 10000);
    const first = JSON.parse(result.text.split("\n")[1]);
    assert.equal(first.sourceExcerpt, true); assert.equal(first.source.revision, "a".repeat(40));
  } finally { await service.close(); }
});
