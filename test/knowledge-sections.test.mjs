import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { recordSections } from "../commands/knowledge/sections.mjs";

test("deep sections keep source offsets, heading context, and bounded model inputs", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-sections-"));
  let store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const record = await store.put({ kind: "evidence", repository: "thunderbird", at: new Date().toISOString(),
    title: "Function map", paths: ["calendar/map.js"], source: { revision: "abc", symbol: "deepSymbol", fileRole: "module" },
    text: "# Calendar\n" + "ordinary entry\n".repeat(600) + "## deepSymbol\nReturns the deep target value.\n" });
  const sections = recordSections(record);
  assert.ok(sections.every(section => section.input.length <= 2000), "Model inputs should fit the worker limit.");
  const result = searchKnowledge(store, { query: "deepSymbol", repository: "thunderbird" });
  const entry = JSON.parse(result.text.trim().split("\n").at(-1));
  assert.equal(entry.id, record.id, "Evidence should cite the original record.");
  assert.match(entry.text, /Calendar > deepSymbol/, "The excerpt should include parent headings.");
  assert.equal(record.text.slice(entry.section.start, entry.section.end), sections.at(-1).text, "Offsets should point to the original text.");
  assert.equal(entry.section.metadata.revision, "abc", "Metadata should retain the source revision.");
  assert.deepEqual(searchKnowledge(store, { query: "deepSymbol", repository: "other" }).ids, [], "Search should isolate repositories.");
  assert.equal(searchKnowledge(store, { query: "deepSymbol", repository: "thunderbird", maxChars: 100 }).text, "", "Search should respect small budgets.");
  const before = store.db.prepare("SELECT id FROM sections ORDER BY id").all();
  await store.rebuild();
  assert.deepEqual(store.db.prepare("SELECT id FROM sections ORDER BY id").all(), before, "Rebuild should keep stable identities.");
  const section = sections.at(-1);
  store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(section.id, "test", "[1,0]");
  const semantic = searchKnowledge(store, { query: "unrelated", repository: "thunderbird", model: "test", vector: [1, 0] });
  assert.match(semantic.text, /deepSymbol/, "Semantic search should retrieve the deep section.");
  store.db.exec("DELETE FROM sections; DELETE FROM section_search; DELETE FROM settings WHERE key='sectionVersion'");
  store.close();
  store = await openKnowledgeStore(directory);
  assert.deepEqual(store.db.prepare("SELECT id FROM sections ORDER BY id").all(), before, "Opening an old cache should rebuild sections.");
});

test("small focused records stay whole and repeated sections count once", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-section-count-"));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const small = await store.put({ kind: "evidence", repository: "tb-tools", at: new Date().toISOString(),
    source: {}, text: "# First\nA short claim.\n## Second\nMore context." });
  assert.equal(recordSections(small).length, 1, "A small record should stay whole.");
  const large = await store.put({ kind: "evidence", repository: "tb-tools", at: new Date().toISOString(),
    source: {}, text: "# Repeated\n" + "matchingSymbol has one source.\n".repeat(1000) });
  for (const section of recordSections(large)) {
    store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(section.id, "test", "[1,0]");
  }
  const result = searchKnowledge(store, { query: "matchingSymbol", repository: "tb-tools", model: "test", vector: [1, 0] });
  assert.deepEqual(result.ids, [large.id], "Many matching sections should return one parent claim.");
});
