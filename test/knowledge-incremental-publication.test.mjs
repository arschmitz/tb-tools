import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openKnowledgeStore, canonical } from "../commands/knowledge/store.mjs";
import { publishProjectLessons, exportLessonNotes } from "../commands/knowledge/publication.mjs";
import { syncKnowledgeRepository } from "../commands/knowledge/repository.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
const evidence = (text, extra = {}) => ({ kind: "evidence", visibility: "shared", repository: "thunderbird",
  at: "2026-10-13T12:00:00Z", paths: ["calendar/dialog.js"], title: text.slice(0, 60), text,
  source: { type: "code-snapshot", revision: "a".repeat(40), verified: true }, ...extra });
const lesson = (source, extra = {}) => ({ kind: "lesson", visibility: "shared", repository: source.repository,
  at: source.at, paths: source.paths, component: "calendar", title: "Wait for the dialog update", text: source.text,
  evidence: [source.id], quotes: [{ id: source.id, text: source.text }], status: "supported", supersedes: [],
  source: { type: "extraction", revision: "a".repeat(40) }, ...extra });
const note = title => `<!-- knowledge: {"repository":"thunderbird","at":"2026-10-13T12:00:00Z","paths":[],"source":{"reference":"review:D123"}} -->\n# ${title}\nScoped evidence.\n`;

async function fixture(t) {
  let root;
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  root = await mkdtemp(path.join(tmpdir(), "tb-incremental-publication-"));
  const open = async name => {
    const store = await openKnowledgeStore(path.join(root, name));
    stores.push(store);
    return store;
  };
  const seed = path.join(root, "seed");
  await mkdir(seed);
  await git(seed, "init", "-b", "main");
  await writeFile(path.join(seed, "AGENTS.md"), "Read scoped evidence.\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Instructions");
  const remote = path.join(root, "remote.git");
  await git(root, "clone", "--bare", seed, remote);
  const clone = async name => {
    const directory = path.join(root, name);
    await git(root, "clone", remote, directory);
    const store = await open(`${name}-cache`);
    await mkdir(path.join(directory, "notes"), { recursive: true });
    return { directory, store };
  };
  return { root, remote, open, clone };
}

function watchBodies(t, store) {
  const reads = new Map(), get = store.get;
  t.mock.method(store, "all", () => assert.fail("Publication should not decode all record bodies."));
  t.mock.method(store, "get", function (id) {
    reads.set(id, (reads.get(id) || 0) + 1);
    return get.call(this, id);
  });
  return reads;
}

test("record metadata queries preserve exact scope, bounds, and insertion order", async t => {
  const { open } = await fixture(t), store = await open("scope");
  assert.equal(store.maxRecordRowid(), 0, "An empty store should have a zero pass bound.");
  const first = await store.put(evidence("First scoped source."));
  const privateSource = await store.put(evidence("Private source.", { visibility: "private" }));
  const other = await store.put(evidence("Other repository.", { repository: "tb-tools" }));
  const firstLesson = await store.put(lesson(first));
  const second = await store.put(evidence("Second scoped source."));
  const bound = store.maxRecordRowid(), reads = watchBodies(t, store);
  const page = store.recordIds({ repository: "thunderbird", kind: "evidence", visibility: "shared", sourceType: "code-snapshot", limit: 1 });
  assert.deepEqual(page.map(row => row.id), [first.id], "The first filtered page should contain the first matching source.");
  assert.deepEqual(Object.keys(page[0]).sort(), ["id", "kind", "repository", "rowid", "visibility"], "Metadata rows should omit record bodies.");
  const next = store.recordIds({ repository: "thunderbird", kind: "evidence", visibility: "shared", sourceType: "code-snapshot",
    afterRowid: page[0].rowid, throughRowid: bound, limit: 1 });
  assert.deepEqual(next.map(row => row.id), [second.id], "The next page should skip other scopes without skipping a matching source.");
  assert.deepEqual(store.recordIds({ afterRowid: bound, throughRowid: bound }), [], "An exclusive lower bound should omit its own row.");
  assert.deepEqual(store.recordIds({ sourceType: "code-snapshot' OR 1=1 --" }), [], "A source type should be matched as a literal SQL parameter.");
  assert.equal(reads.size, 0, "Metadata enumeration should not fetch any record body.");
  assert.deepEqual([...store.records({ kind: "lesson", limit: 1 })].map(record => record.id), [firstLesson.id], "Body iteration should retain the requested lesson scope.");
  assert.equal(reads.get(firstLesson.id), 1, "The iterator should fetch each selected lesson once.");
  assert.ok([first, privateSource, other, second].every(record => !reads.has(record.id)), "The lesson iterator should not fetch evidence bodies.");
  for (const query of [{ unknown: true }, { kind: "unknown" }, { visibility: "unknown" }, { repository: [] }, { sourceType: {} },
    { afterRowid: -1 }, { throughRowid: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 1001 }]) {
    assert.throws(() => store.recordIds(query), /Invalid knowledge record query/, "Invalid query options should be rejected.");
  }
  const classification = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM records WHERE kind=? AND visibility=? AND repository=?")
    .all("lesson", "shared", "thunderbird").map(row => row.detail).join("\n");
  const sourceType = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM records WHERE json_extract(body, '$.source.type')=?")
    .all("code-snapshot").map(row => row.detail).join("\n");
  assert.match(classification, /records_classification/, "The classification lookup should use its managed index.");
  assert.match(sourceType, /records_source_type/, "The source-type lookup should use its managed index.");
});

test("a paged body pass omits another writer's later append until the next pass", async t => {
  const { open } = await fixture(t), store = await open("append"), writer = await open("append");
  const source = await store.put(evidence("Shared source for a bounded pass."));
  const first = await store.put(lesson(source, { text: "First lesson." }));
  const second = await store.put(lesson(source, { text: "Second lesson." }));
  const iterator = store.records({ kind: "lesson", limit: 1 });
  assert.equal(iterator.next().value.id, first.id, "The first yield should follow insertion order.");
  const appended = await writer.put(lesson(source, { text: "Appended lesson." }));
  assert.deepEqual([...iterator].map(record => record.id), [second.id], "An active pass should omit records appended beyond its fixed bound.");
  assert.deepEqual([...store.records({ kind: "lesson", limit: 1 })].map(record => record.id), [first.id, second.id, appended.id],
    "The next pass should see the other writer's append without losing earlier rows.");
});

test("selective publication preserves first-claim ownership and keeps raw private quotes local", async t => {
  const { clone } = await fixture(t), { store, directory } = await clone("private");
  const raw = await store.put(evidence("PRIVATE_RAW_QUOTE should never be exported.", {
    visibility: "private", source: { type: "agent-turn", personal: true, url: "https://example.invalid/review" },
  }));
  const summary = "Read /Users/person/projects/fox/comm/calendar/dialog.js before checking focus.";
  const first = await store.put(lesson(raw, { visibility: "private", text: summary, status: "provisional" }));
  await store.put(lesson(raw, { visibility: "private", title: "Duplicate claim", text: summary.toUpperCase(), status: "provisional" }));
  const unrelated = [];
  for (let index = 0; index < 8; index++) unrelated.push(await store.put(evidence(`Unrelated source ${index}. ` + "unrelated background evidence. ".repeat(100), { visibility: "private" })));
  const reads = watchBodies(t, store);
  assert.equal((await publishProjectLessons(store, { shareRepositories: ["tb-tools"] })).published, 0, "An unauthorized repository should publish no lesson.");
  const result = await publishProjectLessons(store, { shareRepositories: ["thunderbird"] });
  assert.deepEqual(result, { published: 1, alreadyPublished: 1 }, "Duplicate claims should publish once in original candidate order.");
  const published = [...store.records({ kind: "lesson", visibility: "shared" })][0];
  assert.deepEqual(published.source.originalLessons, [first.id], "The first private claimant should own the shared publication.");
  assert.equal(published.status, "provisional", "A private-source publication should remain provisional.");
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  const files = await git(directory, "ls-tree", "-r", "--name-only", "HEAD");
  assert.ok(!files.includes(raw.id), "The raw private evidence file should remain outside the shared tree.");
  const exported = await readFile(path.join(directory, "records", `${published.id}.json`), "utf8");
  assert.doesNotMatch(exported, /PRIVATE_RAW_QUOTE|\/Users\//, "The shared lesson should omit raw private quotes and personal paths.");
  assert.ok(unrelated.every(record => !reads.has(record.id)), "Publication should not fetch unrelated private evidence bodies.");
});

test("warm sync avoids old evidence bodies and still validates and exports fresh records", async t => {
  const { clone } = await fixture(t), { store, directory } = await clone("warm");
  const source = await store.put(evidence("Wait for the checked dialog update."));
  const original = await store.put(lesson(source));
  const noise = await store.put(evidence("Unrelated shared background. ".repeat(100)));
  const reads = watchBodies(t, store);
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  assert.ok(reads.get(source.id) > 0, "Cold publication should read the source to check the exact quote.");
  assert.equal(reads.get(noise.id) || 0, 0, "Record export should not decode unrelated shared evidence.");
  const recordFile = path.join(directory, "records", `${original.id}.json`), noteFile = path.join(directory, "notes", `${original.id}.md`);
  const recordBytes = await readFile(recordFile, "utf8"), noteBytes = await readFile(noteFile, "utf8");
  reads.clear();
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  assert.equal(reads.get(source.id) || 0, 0, "Warm citation validation should not reload unchanged evidence bodies.");
  assert.equal(reads.get(noise.id) || 0, 0, "Warm export should not reload unchanged unrelated evidence bodies.");
  // The first repeat exports the note mirror imported after the first push.
  const head = await git(directory, "rev-parse", "HEAD");
  reads.clear();
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  assert.equal(await git(directory, "rev-parse", "HEAD"), head, "An unchanged repeat should create no new commit.");
  assert.equal(await readFile(recordFile, "utf8"), recordBytes, "Repeat publication should preserve exact record bytes and identity.");
  assert.equal(await readFile(noteFile, "utf8"), noteBytes, "Repeat publication should preserve exact note bytes.");
  const freshSource = await store.put(evidence("A newly checked source must remain visible."));
  const freshLesson = await store.put(lesson(freshSource, { title: "A new lesson" }));
  reads.clear();
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  assert.ok(reads.get(freshSource.id) > 0, "A new lesson should still check its fresh source body.");
  assert.equal(reads.get(source.id) || 0, 0, "A new lesson should not invalidate unrelated old citation receipts.");
  assert.equal(await readFile(path.join(directory, "records", `${freshSource.id}.json`), "utf8"), canonical(freshSource) + "\n", "A warm pass should export fresh evidence bytes.");
  assert.equal(await readFile(path.join(directory, "records", `${freshLesson.id}.json`), "utf8"), canonical(freshLesson) + "\n", "A warm pass should export the fresh lesson.");
  assert.match(await readFile(path.join(directory, "notes", `${freshLesson.id}.md`), "utf8"), /A new lesson/, "A warm pass should create the fresh lesson note.");
});

test("warm citation receipts reject current dependency scope faults", async t => {
  for (const fault of ["repository", "visibility", "missing"]) await t.test(fault, async child => {
    const { clone } = await fixture(child), { store, directory } = await clone(`fault-${fault}`);
    const source = await store.put(evidence("Exact quoted dependency."));
    await store.put(lesson(source));
    watchBodies(child, store);
    await syncKnowledgeRepository(store, { repositoryDirectory: directory });
    const before = await git(directory, "rev-parse", "HEAD");
    // Simulate damaged index metadata after a valid receipt has been saved.
    if (fault === "missing") {
      store.db.prepare("DELETE FROM records WHERE id=?").run(source.id);
      const unchanged = store.unchangedFile;
      child.mock.method(store, "unchangedFile", function (file, stat) {
        // Keep import from repairing this one row so validation sees the gap.
        return path.basename(file) === `${source.id}.json` || unchanged.call(this, file, stat);
      });
    } else store.db.prepare(`UPDATE records SET ${fault}=? WHERE id=?`).run(fault === "repository" ? "tb-tools" : "private", source.id);
    await assert.rejects(syncKnowledgeRepository(store, { repositoryDirectory: directory }), /unavailable or invalid citations/,
      "A warm receipt should reject a missing, private, or foreign-repository dependency.");
    assert.equal(await git(directory, "rev-parse", "HEAD"), before, "Rejected dependency metadata should create no publication commit.");
  });
});

test("receipt changes and fresh bad quotes still require exact source validation", async t => {
  const { clone } = await fixture(t), { store, directory } = await clone("receipts");
  const source = await store.put(evidence("The exact permitted source quotation."));
  const checked = await store.put(lesson(source)), reads = watchBodies(t, store);
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  const key = `shared-lesson-validation:v1:${checked.id}`;
  store.setting(key, { evidence: [] });
  reads.clear();
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  assert.ok(reads.get(source.id) > 0, "A mismatched receipt should trigger full quote validation.");
  store.db.prepare("DELETE FROM settings WHERE key=?").run(key);
  store.setting(`shared-lesson-validation:v0:${checked.id}`, { evidence: checked.evidence });
  reads.clear();
  await syncKnowledgeRepository(store, { repositoryDirectory: directory });
  assert.ok(reads.get(source.id) > 0, "A receipt from another validation version should not replace current quote validation.");
  const invalid = await store.put(lesson(source, { text: "A different proposed claim.", quotes: [{ id: source.id, text: "A quotation absent from the source." }] }));
  await assert.rejects(syncKnowledgeRepository(store, { repositoryDirectory: directory }), /unavailable or invalid citations/,
    "A new immutable lesson should not inherit another lesson's quote receipt.");
  assert.ok(!(await readdir(path.join(directory, "records"))).includes(`${invalid.id}.json`), "An invalid new lesson should remain unexported.");
});

test("linked-note fallback and exclusive note collision checks survive selective export", async t => {
  const { clone } = await fixture(t), { store, directory } = await clone("notes");
  const source = await store.put(evidence("A lesson linked by legacy Markdown."));
  const linked = await store.put(lesson(source));
  await store.put(evidence(`[Legacy lesson](../records/${linked.id}.json).`, { visibility: "private", source: { type: "shared-note" } }));
  watchBodies(t, store);
  assert.equal(await exportLessonNotes(store, directory), 0, "A Markdown-only shared-note link should prevent a duplicate generated note.");
  const fresh = await store.put(lesson(source, { text: "A separate lesson needs its own note." }));
  assert.equal(await exportLessonNotes(store, directory), 1, "An unlinked lesson should still receive a note.");
  const file = path.join(directory, "notes", `${fresh.id}.md`), collision = note("User content at the generated path");
  await writeFile(file, collision);
  await assert.rejects(exportLessonNotes(store, directory), /Knowledge note collision/, "Selective export should reject different content at an existing note path.");
  assert.equal(await readFile(file, "utf8"), collision, "A note collision should preserve the existing user content.");
});

test("warm sync still checks dirty instructions, immutable records, and full tree modes", async t => {
  for (const fault of ["dirty", "record", "tree"]) await t.test(fault, async child => {
    const { clone, root, remote } = await fixture(child), { store, directory } = await clone(`guards-${fault}`);
    const source = await store.put(evidence("An initial immutable record."));
    await store.put(lesson(source));
    watchBodies(child, store);
    await syncKnowledgeRepository(store, { repositoryDirectory: directory });
    const before = await git(root, "--git-dir", remote, "rev-parse", "main");
    let file, content, expected;
    if (fault === "dirty") {
      file = path.join(directory, "AGENTS.md"); content = "User's unfinished instruction change.\n"; expected = /tracked memory repository edits/;
    } else if (fault === "record") {
      const fresh = await store.put(evidence("New source awaiting export."));
      file = path.join(directory, "records", `${fresh.id}.json`); content = JSON.stringify({ ...fresh, text: "Changed immutable body." }); expected = /checksum|collision/;
    } else {
      file = path.join(directory, "script.sh"); content = "Unapproved file.\n"; expected = /unsupported files or modes/;
    }
    await writeFile(file, content);
    if (fault === "tree") { await git(directory, "add", "script.sh"); await git(directory, "commit", "-m", "Unsupported tree entry"); }
    await assert.rejects(syncKnowledgeRepository(store, { repositoryDirectory: directory }), expected, "A warm pass should retain the dirty, immutable, and full-tree safety gates.");
    assert.equal(await readFile(file, "utf8"), content, "A failed safety gate should preserve the original changed file.");
    assert.equal(await git(root, "--git-dir", remote, "rev-parse", "main"), before, "A rejected warm pass should leave the remote unchanged.");
  });
});

test("nonforce retry preserves concurrent additions and pull-only creates no exports", async t => {
  const { clone, root, remote } = await fixture(t), a = await clone("writer-a"), b = await clone("writer-b");
  await writeFile(path.join(a.directory, "notes/a.md"), note("First contributor"));
  await writeFile(path.join(b.directory, "notes/b.md"), note("Second contributor"));
  watchBodies(t, a.store);
  const attempts = [];
  const result = await syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory, beforePush: async ({ attempt }) => {
    attempts.push(attempt);
    if (!attempt) await syncKnowledgeRepository(b.store, { repositoryDirectory: b.directory });
  } });
  assert.equal(result.pushed, true, "Concurrent additions should finish with a normal push.");
  assert.deepEqual(attempts, [0, 1], "A rejected first push should fetch and retry once.");
  const files = await git(root, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main");
  assert.match(files, /notes\/a\.md/, "The merged remote should retain the first contributor's note.");
  assert.match(files, /notes\/b\.md/, "The merged remote should retain the second contributor's note.");
  const reader = await clone("pull-only"), source = await reader.store.put(evidence("Local shared source awaiting a write-enabled sync."));
  watchBodies(t, reader.store);
  const before = await git(root, "--git-dir", remote, "rev-parse", "main");
  await syncKnowledgeRepository(reader.store, { repositoryDirectory: reader.directory, push: false });
  assert.equal(await git(root, "--git-dir", remote, "rev-parse", "main"), before, "Pull-only sync should not change the remote.");
  assert.ok(!(await git(reader.directory, "ls-tree", "-r", "--name-only", "HEAD")).includes(source.id), "Pull-only sync should not export a new local shared record.");
});

test("divergent concurrent immutable notes require review and preserve both versions", async t => {
  const { clone, root, remote } = await fixture(t), a = await clone("conflict-a"), b = await clone("conflict-b");
  const aText = note("First conflicting account"), bText = note("Second conflicting account");
  await writeFile(path.join(a.directory, "notes/same.md"), aText);
  await writeFile(path.join(b.directory, "notes/same.md"), bText);
  watchBodies(t, a.store);
  await assert.rejects(syncKnowledgeRepository(a.store, { repositoryDirectory: a.directory, beforePush: async ({ attempt }) => {
    if (!attempt) await syncKnowledgeRepository(b.store, { repositoryDirectory: b.directory });
  } }), /Shared note was edited|Knowledge merge needs review/, "Divergent immutable content should stop the concurrent retry for review.");
  assert.equal(await readFile(path.join(a.directory, "notes/same.md"), "utf8"), aText, "The stopped retry should preserve the local contributor's note.");
  assert.equal(await git(root, "--git-dir", remote, "show", "main:notes/same.md"), bText.trim(), "The remote should preserve the other contributor's note.");
});
