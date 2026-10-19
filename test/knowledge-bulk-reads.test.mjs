import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { importLegacyKnowledge } from "../commands/knowledge/import.mjs";
import { writeComponentGuides } from "../commands/knowledge/learning.mjs";
import { publishProjectLessons } from "../commands/knowledge/publication.mjs";

async function fixture(t) {
  let directory, store;
  t.after(async () => {
    store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  directory = await mkdtemp(path.join(tmpdir(), "tb-bulk-reads-"));
  store = await openKnowledgeStore(directory);
  return { store, directory };
}

const evidence = (text, source) => ({ kind: "evidence", repository: "tb-tools", visibility: "private",
  at: "2026-10-15T12:00:00Z", title: "# Task Group: Commands", paths: [], text, source });

test("searchable counts use a covering index and preserve repository and archive filters", async t => {
  const { store } = await fixture(t);
  const archived = await store.put(evidence("Archived evidence", { type: "code-snapshot" }));
  await store.put(evidence("Available evidence", { type: "code-snapshot" }));
  await store.put({ ...evidence("Other repository", { type: "code-snapshot" }), repository: "thunderbird" });
  store.db.prepare("INSERT INTO retrieval_archives VALUES (?, 'fixture', 1)").run(archived.id);
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT count(*) AS count FROM records r WHERE r.repository=? AND NOT EXISTS
    (SELECT 1 FROM retrieval_archives a WHERE a.id=r.id)`).all("tb-tools");

  assert.ok(plan.some(row => /SEARCH r USING COVERING INDEX/.test(row.detail)),
    "Searchable counts should avoid fetching large record table rows.");
  assert.equal(store.searchableCount("tb-tools"), 1, "The count should exclude archived records.");
  assert.equal(store.searchableCount("thunderbird"), 1, "The count should use the requested repository.");
  assert.equal(store.searchableCount("missing"), 0, "A missing repository should have no searchable records.");
});

test("classification pages use the covering index and retain row boundaries and filters", async t => {
  const { store } = await fixture(t);
  const source = await store.put(evidence("Source evidence", { type: "code-snapshot" }));
  const lesson = { kind: "lesson", repository: "tb-tools", visibility: "shared", at: source.at,
    text: "A lesson", evidence: [source.id], source: { type: "extraction" },
    status: "provisional", supersedes: [] };
  const first = await store.put(lesson);
  const second = await store.put({ ...lesson, text: "Another lesson" });
  await store.put({ ...lesson, repository: "thunderbird" });
  await store.put({ ...lesson, visibility: "private" });
  const prepare = store.db.prepare.bind(store.db), plans = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT rowid,id,repository,kind,visibility")) return statement;
    return { all(...values) {
      plans.push({ sql, rows: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) });
      return statement.all(...values);
    } };
  };
  const query = { kind: "lesson", visibility: "shared", repository: "tb-tools", limit: 1 };
  const page = store.recordIds(query);
  assert.deepEqual(page.map(row => row.id), [first.id], "The first page should retain insertion order and filters.");
  assert.ok(plans.at(-1).rows.some(row => /COVERING INDEX records_classification_metadata/.test(row.detail)),
    "The actual classification page should avoid record body-table reads.");
  const next = store.recordIds({ ...query, afterRowid: page[0].rowid });
  assert.deepEqual(next.map(row => row.id), [second.id], "The next page should start after the previous row.");
  assert.deepEqual(store.recordIds({ ...query, throughRowid: page[0].rowid, afterRowid: page[0].rowid }), [],
    "A bounded page should not return rows beyond its snapshot.");
  store.recordIds({ ...query, sourceType: "extraction" });
  assert.ok(!plans.at(-1).sql.includes("INDEXED BY"), "A source-type query should retain its existing index choices.");
});

test("publication yields while collecting existing lessons and skipping private lessons", async t => {
  const { store } = await fixture(t);
  const source = await store.put(evidence("Source evidence", { type: "code-snapshot" }));
  for (const visibility of ["shared", "private"]) {
    for (let index = 0; index < 3; index++) {
      await store.put({ kind: "lesson", repository: "tb-tools", visibility, at: source.at,
        text: `${visibility} lesson ${index}`, evidence: [source.id], source: { type: "extraction" },
        status: "provisional", supersedes: [] });
    }
  }
  const get = store.get.bind(store), callbacks = [], reads = { shared: 0, private: 0 };
  store.get = id => {
    const record = get(id);
    if (record?.kind === "lesson" && ++reads[record.visibility] === 1) {
      const visibility = record.visibility;
      setImmediate(() => callbacks.push([visibility, reads[visibility]]));
    }
    return record;
  };
  assert.deepEqual(await publishProjectLessons(store), { published: 0, alreadyPublished: 0 },
    "An empty repository allowlist should leave private lessons unpublished.");
  assert.deepEqual(callbacks, [["shared", 1], ["private", 1]],
    "Dashboard callbacks should run between shared and skipped private lesson reads.");
});

test("component guides check citation presence without reading source bodies and yield between batches", async t => {
  const { store } = await fixture(t);
  const source = await store.put(evidence("Large source evidence", { type: "code-snapshot" }));
  for (let index = 0; index < 70; index++) {
    await store.put({ kind: "lesson", repository: "tb-tools", visibility: "private",
      at: source.at, title: `Lesson ${index}`, text: `Scoped observation ${index}`,
      evidence: [source.id], quotes: [{ id: source.id, text: source.text }],
      source: { type: "extraction" }, status: "provisional", supersedes: [] });
  }
  const get = store.get.bind(store);
  let reads = 0, readsAtCallback = 0;
  store.get = id => {
    assert.notEqual(id, source.id, "Guide generation should not load citation bodies.");
    if (++reads === 1) setImmediate(() => { readsAtCallback = reads; });
    return get(id);
  };

  const guides = await writeComponentGuides(store);

  assert.equal(guides.length, 1, "Lessons with existing citations should produce a guide.");
  assert.equal(guides[0].lessons, 70, "The guide should include every eligible lesson.");
  assert.ok(readsAtCallback > 0 && readsAtCallback < 70,
    "Dashboard callbacks should run before guide collection finishes.");

  store.db.prepare("DELETE FROM records WHERE id=?").run(source.id);
  assert.deepEqual(await writeComponentGuides(store), [],
    "Lessons with missing citations should stay out of component guides.");
});

test("changed legacy memory reuses only matching source identities without bulk reads", async t => {
  const { store, directory } = await fixture(t);
  const file = path.join(directory, "MEMORY.md");
  const text = "# Task Group: Commands\nExisting scoped evidence.\n";
  const original = await store.put(evidence(text, { type: "legacy-memory", file }));
  await store.put(evidence(text, { type: "legacy-memory", file: "/different/MEMORY.md" }));
  await store.put(evidence("Unrelated source", { type: "code-snapshot", file }));
  await writeFile(file, text);
  store.all = () => { throw new Error("Legacy import should not load the corpus."); };
  const get = store.get.bind(store), queries = [], reads = [];
  const records = store.records.bind(store);
  store.records = function* (query) { queries.push(query); yield* records(query); };
  store.get = id => { reads.push(id); return get(id); };
  assert.equal(await importLegacyKnowledge(store, directory), 0, "Existing legacy text should reuse its source record.");
  assert.ok(queries.some(query => query.sourceType === "legacy-memory" && Number.isSafeInteger(query.throughRowid)),
    "Legacy identity lookup should use a fixed rowid boundary and source filter.");
  assert.equal(store.count("tb-tools"), 3, "Reusing legacy evidence should preserve the record count.");
  assert.ok(reads.includes(original.id), "Legacy import should reuse the matching file record.");
  assert.equal(store.setting(`legacy-content:${digest({ file, heading: original.title, text })}`), original.id,
    "Legacy import should retain the matching file identity instead of an identical record from another file.");
  const before = queries.length;
  assert.equal(await importLegacyKnowledge(store, directory), 0, "An unchanged file should skip import.");
  assert.equal(queries.length, before + 1, "An unchanged file should only read lessons for component guides.");
});

test("bulk arrays reject excess UTF8 bytes while filtered and streamed reads remain available", async t => {
  const { store } = await fixture(t);
  const small = await store.put(evidence("Small scoped record", { type: "code-snapshot" }));
  const body = JSON.stringify({ ...small, text: "é".repeat(512 * 1024) });
  const insert = store.db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 65; i++) insert.run(`large-${i}`, "large", "evidence", "private", body);
  for (const read of [() => store.all(), () => store.searchableRecords(), () => store.all("large")]) {
    assert.throws(read, error => error.code === "KNOWLEDGE_BULK_READ_LIMIT" && /records\(\)/.test(error.message),
      "Bulk reads should reject excessive bytes with streaming guidance.");
  }
  assert.deepEqual(store.all("tb-tools"), [small], "Repository filtering should keep small bulk reads available.");
  store.db.exec("INSERT INTO retrieval_archives SELECT id, 'fixture', 1 FROM records WHERE repository='large'");
  assert.deepEqual(store.searchableRecords(), [small], "Searchable arrays should exclude archived bodies before the limit.");
  let count = 0;
  for (const record of store.records({ repository: "large", limit: 2 })) {
    assert.equal(record.text.length, 512 * 1024, "Streaming should preserve each full record body.");
    count++;
  }
  assert.equal(count, 65, "Streaming should return every record beyond the bulk array limit.");
});
