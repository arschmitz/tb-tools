import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { recordSections } from "../commands/knowledge/sections.mjs";
import { checkAnswer, scoreReturnedAnchors } from "../commands/knowledge/evaluation.mjs";

const revision = "a".repeat(40);
const mainQuote = "saveOperation calls commitChanges only after validateInputs returns true.";
const exceptionQuote = "readOnly calendars reject changes before commitChanges runs.";
const unrelated = "This paragraph supplies background details for the source document.\n";
const sourceText = `# Save contract\n${mainQuote}\n${unrelated.repeat(10)}\n## Read-only exception\n${exceptionQuote}\n${unrelated.repeat(10)}\n## Cancellation\ncancelSignal prevents subsequent writes.\n${unrelated.repeat(10)}`;
const evidence = (text = sourceText, extra = {}) => ({ kind: "evidence", repository: "thunderbird", at: "2026-10-13T10:00:00Z",
  title: "Calendar save behavior", paths: ["calendar/save.js"], text,
  source: { type: "code-snapshot", revision, file: "calendar/save.js", verified: true, fileRole: "production" }, ...extra });
const entries = result => result.text.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-multisection-"));
  let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await openKnowledgeStore(directory);
  return store;
}

test("separated contract and exception sections retain exact source citations", async t => {
  const store = await fixture(t), record = await store.put(evidence());
  const args = { query: "saveOperation readOnly", repository: "thunderbird", maxChars: 12_000 };
  const baseline = searchKnowledge(store, { ...args, maxSectionsPerClaim: 1 });
  assert.equal(entries(baseline).length, 1, "The one-section comparison should return one excerpt.");
  assert.equal(baseline.text.includes(mainQuote) && baseline.text.includes(exceptionQuote), false,
    "The one-section comparison should reproduce the missing contract or exception.");
  const result = searchKnowledge(store, args), selected = entries(result);
  assert.deepEqual(result.ids, [record.id], "Multiple excerpts should count as one independent source.");
  assert.equal(selected.length, 2, "The task should receive both matching sections from the source.");
  assert.ok(result.text.includes(mainQuote), "The selected context should contain the main contract.");
  assert.ok(result.text.includes(exceptionQuote), "The selected context should contain the exception.");
  for (const entry of selected) {
    const section = recordSections(record).find(section => section.id === entry.section.id);
    assert.ok(section, "Every selected section should have a stable original section ID.");
    assert.equal(entry.section.recordId, record.id, "Every excerpt should identify its physical source record.");
    assert.equal(entry.section.start, section.start, "The section start should match the immutable source.");
    assert.equal(entry.section.end, section.end, "The section end should match the immutable source.");
    assert.ok(entry.text.endsWith(record.text.slice(section.start, section.end)), "The returned excerpt should end with the exact source slice.");
    assert.equal(entry.section.metadata.revision, revision, "Every excerpt should retain its checked source revision.");
  }
  const citations = checkAnswer({ facts: [], prohibited: [], limits: "Fixture" }, selected.map(entry => entry.section.id).join(" "), result.ids, result.text);
  assert.deepEqual(citations.unknownCitations, [], "Citations to every selected section should remain recognized.");
  const traced = searchKnowledge(store, { ...args, trace: true });
  assert.equal(traced.text, result.text, "Tracing should preserve all selected excerpts.");
  assert.deepEqual(traced.ids, result.ids, "Tracing should preserve the unique source list.");
});

test("extra sections preserve two independent sources under a tight context budget", async t => {
  const store = await fixture(t);
  const guide = await store.put(evidence());
  const caller = await store.put(evidence("saveOperation is called after the dialog confirms its target calendar.", {
    title: "Save caller", paths: ["calendar/caller.js"], source: { type: "code-snapshot", revision, file: "calendar/caller.js", verified: true },
  }));
  const args = { query: "saveOperation readOnly", repository: "thunderbird", limit: 2, maxChars: 24_000 };
  const primaries = searchKnowledge(store, { ...args, maxSectionsPerClaim: 1 });
  assert.equal(primaries.ids.length, 2, "The comparison budget should include both independent sources.");
  const result = searchKnowledge(store, { ...args, maxChars: primaries.text.length });
  assert.ok(result.ids.includes(guide.id), "The constrained context should retain the guide source.");
  assert.ok(result.ids.includes(caller.id), "The constrained context should retain the caller before guide supplements.");
  assert.ok(result.text.length <= primaries.text.length, "Supplemental excerpts should obey the exact context budget.");
});

test("section and claim limits bound a source with many distinct matches", async t => {
  const store = await fixture(t);
  const text = Array.from({ length: 12 }, (_, index) => `# Contract ${index}\nmatchingOperation preserves clause${index}.\n${unrelated.repeat(3)}`).join("\n");
  const record = await store.put(evidence(text));
  const args = { query: "matchingOperation", repository: "thunderbird", maxChars: 24_000, limit: 1, trace: true };
  const result = searchKnowledge(store, args);
  assert.deepEqual(result.ids, [record.id], "A section-rich source should occupy one claim slot.");
  assert.equal(entries(result).length, 3, "The default should return at most three useful sections from a claim.");
  const single = searchKnowledge(store, { ...args, maxSectionsPerClaim: 1 });
  assert.equal(entries(single).length, 1, "The comparison option should restrict each claim to one section.");
  const trace = result.trace.candidates.find(candidate => candidate.id === record.id);
  const oneSectionTrace = single.trace.candidates.find(candidate => candidate.id === record.id);
  assert.equal(trace.sections.length, 3, "The trace should identify every selected physical section.");
  assert.ok(trace.sections.length + trace.omittedSections.length <= 8, "Each claim should retain at most eight distinct section candidates.");
  assert.ok(trace.omittedSections.every(section => section.reason === "section-limit"), "The trace should state when the section cap omits a candidate.");
  assert.ok(Math.abs(trace.score - oneSectionTrace.score) < 1e-8, "Additional excerpts should preserve the independent claim score apart from elapsed source age.");
  for (const maxSectionsPerClaim of [0, 4, 1.5]) {
    assert.throws(() => searchKnowledge(store, { ...args, maxSectionsPerClaim }), /section|claim/i,
      "An unsupported section limit should fail before retrieval.");
  }
  const tiny = searchKnowledge(store, { ...args, maxChars: 100 });
  assert.equal(tiny.text, "", "An excerpt that cannot fit should not exceed a tiny context budget.");
});

test("identical repeated sections and exact-semantic duplicates appear once", async t => {
  const store = await fixture(t);
  const repeated = `# Repeat\nmatchingOperation has one unchanged contract.\n${unrelated.repeat(3)}`;
  const record = await store.put(evidence(Array.from({ length: 8 }, () => repeated).join("")));
  for (const section of recordSections(record)) {
    store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(section.id, "test", "[1,0]");
  }
  const result = searchKnowledge(store, { query: "matchingOperation", repository: "thunderbird", vector: [1, 0], model: "test", maxChars: 24_000 });
  assert.deepEqual(result.ids, [record.id], "Repeated matching sections should remain one claim.");
  assert.equal(entries(result).length, 1, "Identical source text should occupy one excerpt even with exact and semantic matches.");
});

test("exact and semantic matches can supply complementary sections with scope intact", async t => {
  const store = await fixture(t), record = await store.put(evidence());
  const foreign = await store.put(evidence(sourceText, { repository: "tb-tools" }));
  const testSource = await store.put(evidence(sourceText, { source: { type: "code-snapshot", revision, fileRole: "test" } }));
  for (const item of [record, foreign, testSource]) {
    const section = recordSections(item).find(section => section.text.includes(exceptionQuote));
    store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(section.id, "test", "[1,0]");
  }
  const result = searchKnowledge(store, { query: "saveOperation", repository: "thunderbird", filters: { role: "production" },
    vector: [1, 0], model: "test", maxChars: 12_000 });
  assert.deepEqual(result.ids, [record.id], "All supplementary sections should obey repository and file-role scope.");
  assert.ok(result.text.includes(mainQuote), "Exact search should retain the main contract excerpt.");
  assert.ok(result.text.includes(exceptionQuote), "Semantic search should add the complementary exception excerpt.");
  assert.equal(entries(result).length, 2, "Complementary matches should return two distinct physical sections.");
});

test("portable copies retain one claim and physical section identities", async t => {
  const store = await fixture(t), record = await store.put(evidence());
  const copy = await store.put(evidence(sourceText, { source: { type: "shared-note", portableCopies: [record.id] } }));
  const result = searchKnowledge(store, { query: "saveOperation readOnly", repository: "thunderbird", maxChars: 24_000 });
  assert.equal(result.ids.length, 1, "A portable copy should not add independent authority.");
  const selected = entries(result);
  assert.equal(selected.length, 2, "Copies should not multiply the two useful source excerpts.");
  assert.ok(selected.every(entry => [record.id, copy.id].includes(entry.section.recordId)), "Every excerpt should name an existing physical source.");
  assert.ok(selected.every(entry => entry.id === result.ids[0]), "Every excerpt should cite the selected canonical claim.");
  const bodies = selected.map(entry => store.get(entry.section.recordId).text.slice(entry.section.start, entry.section.end).trim());
  assert.equal(new Set(bodies).size, bodies.length, "Copied section bodies should appear once.");
});

test("record-wide metadata does not add unmatched supplemental sections", async t => {
  for (const metadata of [
    { source: { type: "code-snapshot", revision, file: "calendar/save.js", verified: true, symbol: "saveOperation" } },
    { title: "saveOperation" },
    { component: "saveOperation" },
  ]) {
    const store = await fixture(t);
    await store.put(evidence(sourceText, metadata));
    const result = searchKnowledge(store, { query: "saveOperation", repository: "thunderbird", maxChars: 24_000 });
    assert.equal(entries(result).length, 1, "Record-wide symbol, title, or component metadata should not add unrelated section bodies as supplements.");
    assert.ok(result.text.includes(mainQuote), "The section with the actual matching symbol should remain available.");
    assert.ok(!result.text.includes("cancelSignal prevents subsequent writes"), "An unmatched section should not consume supplemental context.");
  }
});

test("a short physical source retains its provenance through a different representative", async t => {
  const store = await fixture(t);
  const quote = "function shortSave() { return true; }";
  const original = await store.put(evidence(quote));
  const copy = await store.put(evidence(`shortSave is summarized in this portable note.\n${unrelated.repeat(30)}`, {
    source: { type: "shared-note", portableCopies: [original.id] },
  }));
  const result = searchKnowledge(store, { query: "shortSave", repository: "thunderbird", maxChars: 24_000 });
  assert.deepEqual(result.ids, [copy.id], "The portable representative should remain the single selected claim.");
  const physical = entries(result).find(entry => entry.text.includes(quote));
  assert.ok(physical, "The original short source excerpt should remain selected.");
  assert.equal(physical.section?.recordId, original.id, "A short alias excerpt should retain the original physical source ID.");
  assert.equal(physical.section?.start, 0, "A whole short alias excerpt should start at the original source boundary.");
  assert.equal(physical.section?.end, quote.length, "A whole short alias excerpt should end at the original source boundary.");
  const question = { repository: "thunderbird", evidence: [{ label: "short implementation", ids: [original.id],
    anchors: [{ repository: "thunderbird", revision, path: "calendar/save.js", contains: [quote] }] }] };
  assert.equal(scoreReturnedAnchors(question, result, store).returnedAnchorsComplete, true,
    "The short physical source should satisfy its original-source anchor through the selected representative.");
});

test("the original winning section survives a crowded alias candidate cap", async t => {
  const store = await fixture(t);
  const quote = "priorityOperation calls writeChecked after validating the target.";
  const original = await store.put(evidence(`# Original implementation\n${quote}\n${unrelated.repeat(19)}`));
  const originalSection = recordSections(original).find(section => section.text.includes(quote));
  const aliasText = Array.from({ length: 8 }, (_, index) =>
    `# Alias clause ${index}\n${"priorityOperation ".repeat(12)}defines distinct clause${index}.\n`).join("\n");
  const copy = await store.put(evidence(aliasText, { source: { type: "shared-note", portableCopies: [original.id] } }));
  for (let index = 0; index < 8; index++) {
    const decoy = await store.put(evidence(`semanticDecoy${index} describes an unrelated operation.`, {
      paths: [`calendar/semantic-decoy-${index}.js`],
    }));
    const section = recordSections(decoy)[0];
    store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(section.id, "test", "[1,0]");
  }
  store.db.prepare("INSERT INTO section_vectors VALUES (?, ?, ?)").run(originalSection.id, "test", "[0.5,0.8660254]");
  const result = searchKnowledge(store, { query: "priorityOperation", repository: "thunderbird", vector: [1, 0], model: "test",
    maxSectionsPerClaim: 1, maxChars: 24_000, trace: true });
  const primary = result.trace.candidates.find(candidate => candidate.id === original.id);
  const canonical = result.trace.candidates.find(candidate => candidate.id === copy.id);
  assert.ok(primary.exactRank >= 9, "Eight alias sections should outrank the original section in exact search.");
  assert.equal(primary.semanticRank, 9, "Eight stronger semantic matches should put the original section at semantic rank nine.");
  assert.equal(canonical.section.id, originalSection.id, "The combined exact and semantic score should keep the original section as the winning primary.");
  assert.equal(result.ids[0], copy.id, "The winning original source should retain the portable canonical claim.");
  const first = entries(result)[0];
  assert.equal(first.section.id, canonical.section.id, "The first returned section should remain the winning primary before the eight-candidate cap.");
  assert.equal(first.section.recordId, original.id, "The winning primary should retain its original physical source.");
  assert.ok(first.text.includes(quote), "The retained primary should supply the checked original implementation quote.");
});

test("supplemental sections preserve every fitting primary source", async t => {
  const store = await fixture(t);
  for (let source = 0; source < 4; source++) {
    const text = Array.from({ length: 5 }, (_, section) =>
      `# Source ${source} section ${section}\nprimaryOperation preserves source${source} clause${section}.\n${unrelated.repeat(4)}`).join("\n");
    await store.put(evidence(text, { title: `Independent source ${source}`, paths: [`calendar/primary-${source}.js`],
      source: { type: "code-snapshot", revision, file: `calendar/primary-${source}.js`, verified: true } }));
  }
  const args = { query: "primaryOperation", repository: "thunderbird", maxChars: 24_000 };
  const primaries = searchKnowledge(store, { ...args, maxSectionsPerClaim: 1 });
  assert.equal(primaries.ids.length, 4, "The comparison context should contain all four independent primary sources.");
  const result = searchKnowledge(store, { ...args, maxChars: primaries.text.length });
  assert.deepEqual(result.ids, primaries.ids, "Supplemental excerpts should preserve every fitting primary source in its original order.");
  assert.equal(entries(result).length, 4, "A budget filled by primary sources should not replace the third or fourth source with a supplement.");
  assert.ok(result.text.length <= primaries.text.length, "All selected primary sources should remain inside the original exact context budget.");
});
