import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { createKnowledgeSearch } from "../commands/knowledge/search-process.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-search-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const evidence = text => ({ kind: "evidence", repository: "tb-tools", text,
  at: "2026-10-18T12:00:00Z", source: { type: "code-snapshot" } });

test("isolated search returns committed evidence and sees later writes and archives", async t => {
  const directory = await fixture(t), store = await openKnowledgeStore(directory);
  t.after(() => store.close());
  const search = createKnowledgeSearch(directory);
  t.after(() => search.close());
  const first = await store.put(evidence("uniqueFirstSearchSymbol"));
  let callbackRan = false;
  setImmediate(() => { callbackRan = true; });
  const query = { query: "uniqueFirstSearchSymbol", repository: "tb-tools", trace: true };
  const result = await search.search(query);
  assert.ok(callbackRan, "Dashboard callbacks should run while the isolated search is pending.");
  assert.ok(result.ids.includes(first.id), "The isolated search should find committed evidence.");
  assert.ok(Object.hasOwn(result.trace.timings, "claims"), "The first search should build the claim cache.");
  store.setting("lastRetrieval", { at: new Date().toISOString() });
  const warm = await search.search(query);
  assert.equal(Object.hasOwn(warm.trace.timings, "claims"), false,
    "A settings write should preserve the warm claim cache.");

  const second = await store.put(evidence("uniqueSecondSearchSymbol"));
  const later = await search.search({ query: "uniqueSecondSearchSymbol", repository: "tb-tools" });
  assert.ok(later.ids.includes(second.id), "The search process should see later committed writes.");
  store.db.prepare("INSERT INTO retrieval_archives VALUES (?, 'fixture', 1)").run(second.id);
  const archived = await search.search({ query: "uniqueSecondSearchSymbol", repository: "tb-tools" });
  assert.ok(!archived.ids.includes(second.id), "The search process should honor later archive changes.");
  store.db.prepare("DELETE FROM retrieval_archives WHERE id=?").run(second.id);
  store.db.prepare("INSERT INTO retrieval_archives VALUES (?, 'fixture', 1)").run(first.id);
  const swapped = await search.search({ query: "uniqueSecondSearchSymbol", repository: "tb-tools", trace: true });
  assert.ok(Object.hasOwn(swapped.trace.timings, "claims"),
    "An archive membership swap should rebuild the cache even when the record count stays the same.");
  assert.ok(swapped.ids.includes(second.id), "The swapped archive should make the second record searchable again.");
});

test("timed-out search kills the busy child and the next request starts a fresh process", async t => {
  const directory = await fixture(t), file = path.join(directory, "busy-worker.mjs");
  await writeFile(file, `process.on('message', ({ id, query }) => {
    if (query.hang) { while (true) {} }
    process.send({ id, result: { pid: process.pid } });
  });`);
  const search = createKnowledgeSearch(directory, { workerUrl: pathToFileURL(file), timeoutMs: 150 });
  t.after(() => search.close());
  await assert.rejects(search.search({ hang: true }), /timed out/,
    "A busy child should time out without blocking the parent.");
  const result = await search.search({});
  assert.ok(Number.isInteger(result.pid), "A later request should run in a fresh child.");
});

test("closing search rejects pending work and prevents another process from starting", async t => {
  const directory = await fixture(t), file = path.join(directory, "pending-worker.mjs");
  await writeFile(file, "process.on('message', () => {});\n");
  const search = createKnowledgeSearch(directory, { workerUrl: pathToFileURL(file) });
  t.after(() => search.close());
  const rejected = assert.rejects(search.search({}), /closed/,
    "Shutdown should reject the pending search.");
  await search.close();
  await rejected;
  await assert.rejects(search.search({}), /closed/,
    "A closed search should reject new work without starting a child.");
});

test("a search child exit rejects the waiting request", async t => {
  const directory = await fixture(t), file = path.join(directory, "exit-worker.mjs");
  await writeFile(file, "process.on('message', () => process.exit(2));\n");
  const search = createKnowledgeSearch(directory, { workerUrl: pathToFileURL(file) });
  t.after(() => search.close());
  await assert.rejects(search.search({}), /exited \(2\)/,
    "An exited child should reject the waiting request.");
});

test("isolated embedding lookup bounds batches and sees model-specific committed vectors", async t => {
  const directory = await fixture(t), store = await openKnowledgeStore(directory);
  t.after(() => store.close());
  const search = createKnowledgeSearch(directory);
  t.after(() => search.close());
  await store.put(evidence("A long source section with several words.\n".repeat(2000)));
  let callbackRan = false;
  setImmediate(() => { callbackRan = true; });
  const first = await search.missingSections("test-model");
  assert.ok(callbackRan, "Dashboard callbacks should run while embedding candidates are read.");
  assert.equal(first.length, 32, "The lookup should return at most one embedding batch.");
  assert.ok(first.every(row => JSON.parse(row.body).input), "Each candidate should retain its section input.");
  for (const row of first) {
    store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(row.id, "test-model", "[1,0]");
  }
  const later = await search.missingSections("test-model"), indexed = new Set(first.map(row => row.id));
  assert.ok(later.length > 0 && later.every(row => !indexed.has(row.id)),
    "Later lookups should omit newly committed vectors for the requested model.");
  const other = await search.missingSections("other-model");
  assert.deepEqual(other.map(row => row.id), first.map(row => row.id),
    "Vectors for one model should not hide missing vectors for another model.");
});
