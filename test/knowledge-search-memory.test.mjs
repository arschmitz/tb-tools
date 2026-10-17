import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { claimGroups } from "../commands/knowledge/claims.mjs";

async function fixture(t) {
  let directory, store;
  t.after(async () => {
    store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  directory = await mkdtemp(path.join(tmpdir(), "tb-search-memory-"));
  store = await openKnowledgeStore(directory);
  return store;
}
const evidence = (text, source = {}) => ({ kind: "evidence", repository: "thunderbird", visibility: "shared",
  at: "2026-10-15T12:00:00Z", title: text.slice(0, 50), paths: ["calendar/dialog.js"], text,
  source: { type: "code-snapshot", ...source } });

test("claim metadata keeps copy identities without caching evidence bodies or source payloads", async t => {
  const store = await fixture(t);
  const original = await store.put(evidence("DistinctLookup checks the current calendar.", { rawPayload: "Private large payload" }));
  const lesson = await store.put({ ...evidence(original.text), kind: "lesson", component: "calendar", status: "supported",
    evidence: [original.id], quotes: [{ id: original.id, text: original.text }], supersedes: [], source: { type: "extraction" } });
  const mirror = await store.put(evidence(`DistinctLookup [Lesson record](../records/${lesson.id}.json).`, { type: "shared-note" }));
  const full = store.searchableRecords("thunderbird");
  const compact = [...store.searchableMetadata("thunderbird")];
  const fullGroups = claimGroups(full), compactGroups = claimGroups(compact);
  assert.equal(compactGroups.representatives.get(mirror.id).id, fullGroups.representatives.get(mirror.id).id,
    "A legacy note link should retain the same claim representative.");
  assert.equal(compact.find(record => record.id === lesson.id).text, lesson.text, "Grouping should retain exact lesson text.");
  assert.equal(compact.find(record => record.id === original.id).text, "", "Grouping should omit ordinary evidence text.");
  assert.equal(compact.find(record => record.id === original.id).source.rawPayload, undefined, "Grouping should omit unneeded source payloads.");
  assert.ok(compact.every(record => !record.quotes), "Grouping should omit stored quote bodies.");
  store.all = store.searchableRecords = () => { throw new Error("Search should not load corpus bodies."); };
  const result = searchKnowledge(store, { query: "DistinctLookup", repository: "thunderbird", maxChars: 24000 });
  assert.ok(result.ids.includes(lesson.id), "Search should still return the original grouped lesson.");
  assert.ok(result.text.includes(original.text), "Search should hydrate full text for returned representatives.");
  const cached = store.claimCache.get("thunderbird").representatives.get(original.id);
  assert.equal(cached.text, "", "The claim cache should not retain evidence bodies after search.");
  assert.equal(cached.source.rawPayload, undefined, "The claim cache should not retain source payloads after search.");
});

test("scope matching preserves explicit false metadata with streamed corpus reads", async t => {
  const store = await fixture(t);
  const source = await store.put(evidence("StrictScopeToken preserves scope.", { language: "javascript", fileRole: "production",
    generated: false, imported: false, metadataVerified: true }));
  await store.put(evidence("StrictScopeToken uncertain source.", { generated: false, imported: false, scopeUncertain: true }));
  store.all = store.searchableRecords = () => { throw new Error("Scope should not load corpus bodies."); };
  const result = searchKnowledge(store, { query: "StrictScopeToken", repository: "thunderbird",
    filters: { generated: false, imported: false }, maxChars: 24000 });
  assert.deepEqual(result.ids, [source.id], "Explicit false filters should match verified metadata and exclude uncertain scope.");
  assert.match(result.text, /StrictScopeToken preserves scope/, "Scoped results should retain full source excerpts.");
});
