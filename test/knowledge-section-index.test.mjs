import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";

function storedRows(store) {
  return {
    records: store.db.prepare("SELECT * FROM records ORDER BY id").all(),
    sections: store.db.prepare("SELECT * FROM sections ORDER BY id").all(),
    sectionSearch: store.db.prepare("SELECT rowid, id, repository, text FROM section_search ORDER BY rowid").all(),
    sectionVectors: store.db.prepare("SELECT * FROM section_vectors ORDER BY id, model").all(),
    settings: store.db.prepare("SELECT * FROM settings ORDER BY key").all(),
  };
}

function queryResults(store) {
  return {
    exact: searchKnowledge(store, { query: "retrofitTarget", repository: "thunderbird" }),
    other: searchKnowledge(store, { query: "retrofitTarget", repository: "other" }),
    semantic: searchKnowledge(store, { query: "unmatchedSymbol", repository: "thunderbird", model: "test", vector: [1, 0] }),
  };
}

test("opening a version 1 section cache adds the record lookup index and preserves evidence", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-section-index-"));
  let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await openKnowledgeStore(directory);
  const target = await store.put({
    kind: "evidence", repository: "thunderbird", at: "2026-10-13T00:00:00.000Z",
    title: "Target source", paths: ["mail/target.js"], source: { revision: "a".repeat(40) },
    text: "# Target\n" + "Ordinary source context.\n".repeat(180) + "## retrofitTarget\nReturns the target value.\n",
  });
  const other = await store.put({
    kind: "evidence", repository: "other", at: "2026-10-13T00:00:00.000Z",
    title: "Other source", paths: ["other/target.js"], source: {},
    text: "retrofitTarget belongs to another repository.\n",
  });
  const lookup = "SELECT id FROM sections WHERE record_id=?";
  const targetSections = store.db.prepare(lookup).all(target.id);
  assert.ok(targetSections.length > 1, "The fixture should contain several sections for one record.");
  store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(targetSections.at(-1).id, "test", "[1,0]");

  // Recreate a completed version 1 cache from before the lookup index existed.
  store.db.exec("DROP INDEX sections_record_id");
  assert.equal(store.setting("sectionVersion"), 1, "The existing cache should have section version 1.");
  assert.ok(!store.db.prepare("PRAGMA index_list(sections)").all().some(index => index.name === "sections_record_id"),
    "The existing cache should lack the managed record lookup index.");
  const oldPlan = store.db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all(target.id).map(row => row.detail).join("\n");
  assert.match(oldPlan, /SCAN sections/, "The old record lookup should scan the section table.");
  const before = storedRows(store);
  const results = queryResults(store);
  assert.deepEqual(results.exact.ids, [target.id], "Exact search should return the target repository's record.");
  assert.deepEqual(results.other.ids, [other.id], "Exact search should isolate the other repository's record.");
  assert.deepEqual(results.semantic.ids, [target.id], "The cached vector should return the target record.");
  const files = [store.file(target), store.file(other)];
  const fileBytes = await Promise.all(files.map(file => readFile(file)));
  store.close();
  store = undefined;

  store = await openKnowledgeStore(directory);
  const index = store.db.prepare("PRAGMA index_list(sections)").all().find(row => row.name === "sections_record_id");
  assert.ok(index, "Opening the existing cache should add the managed record lookup index.");
  assert.equal(index.unique, 0, "The record lookup index should allow several sections per record.");
  assert.deepEqual(store.db.prepare("PRAGMA index_info(sections_record_id)").all().map(row => row.name), ["record_id"],
    "The managed index should cover the record_id column.");
  const newPlan = store.db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all(target.id).map(row => row.detail).join("\n");
  assert.match(newPlan, /SEARCH sections USING (?:COVERING )?INDEX sections_record_id\b/,
    "The record lookup should use the managed index.");
  assert.deepEqual(storedRows(store), before, "Opening the cache should preserve exact records, sections, search rows, vectors, and settings.");
  assert.deepEqual(queryResults(store), results, "Opening the cache should preserve exact and semantic query results.");
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), fileBytes,
    "Opening the cache should preserve immutable evidence file bytes.");
});
