import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { recordSections } from "../commands/knowledge/sections.mjs";

test("large maps keep section paths small and preserve the complete source record", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-map-metadata-"));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const paths = Array.from({ length: 500 }, (_, index) => `calendar/components/subfolder-${index}/module-${index}.sys.mjs`);
  const record = await store.put({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T00:00:00Z",
    paths, title: "Calendar file map", source: { revision: "a".repeat(40) },
    text: "# Calendar\n" + "General map context.\n".repeat(100) + `## ${paths[499]}\nmetadataBoundTarget returns the checked value.\n` });
  const sections = recordSections(record);
  assert.deepEqual(store.get(record.id).paths, paths, "The source record should retain every original path.");
  assert.ok(sections.every(section => section.metadata.paths.length <= 8), "Each section should contain at most eight paths.");
  assert.ok(sections.every(section => JSON.stringify(section.metadata).length < 1000), "Section metadata should remain small for a large file map.");
  assert.deepEqual(sections.at(-1).metadata.paths, [paths[499]], "The target section should retain its actual file path.");
  const result = searchKnowledge(store, { query: "metadataBoundTarget", repository: "thunderbird", maxChars: 10000 });
  // A corrected copy keeps parent metadata within the search budget.
  const copy = await store.put({ kind: "evidence", repository: "thunderbird", at: record.at,
    paths: ["calendar"], title: record.title, source: { ...record.source, portableCopies: [record.id] }, text: record.text });
  const sourceSection = sections.at(-1);
  store.db.prepare("UPDATE sections SET body=? WHERE id=?").run(JSON.stringify({ ...sourceSection,
    metadata: { ...sourceSection.metadata, paths } }), sourceSection.id);
  const copied = searchKnowledge(store, { query: "metadataBoundTarget", repository: "thunderbird", maxChars: 10000 });
  assert.deepEqual(copied.ids, [copy.id], "Search should group the original map with its retrieval copy.");
  assert.match(copied.text, /metadataBoundTarget/, "The target should remain retrievable within the console budget.");
  const entry = JSON.parse(copied.text.trim().split("\n").at(-1));
  assert.ok(entry.section.metadata.paths.length <= 8, "Legacy section metadata should be bounded when returned.");
  assert.deepEqual(store.get(record.id).paths, paths, "Retrieval should leave immutable source paths unchanged.");
  assert.ok(result.ids.length <= 1, "An ungrouped record should appear at most once.");
});
