import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { importLegacyKnowledge } from "../commands/knowledge/import.mjs";

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
