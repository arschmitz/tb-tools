import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openKnowledgeStore, searchKnowledge } from "../commands/knowledge/store.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createKnowledgeService } from "../commands/knowledge/service.mjs";
import { retrievalPlan, matchesScope, evidencePreference } from "../commands/knowledge/routing.mjs";

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-routing-"));
  const store = await openKnowledgeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}
const record = (source, extra = {}) => ({ kind: "evidence", repository: "thunderbird", at: "2026-10-01T00:00:00Z",
  title: "CachedStore evidence", text: `CachedStore saves values. ${source.type} ${source.accepted ?? "unknown"}`, paths: ["calendar/store.js"], source, ...extra });

test("questions select ranking preferences and mixed questions retain general search", () => {
  for (const [question, intent] of [["Where is CachedStore implemented?", "implementation"],
    ["Why was CachedStore changed?", "reason"], ["How should I test CachedStore?", "testing"],
    ["Where is CachedStore implemented? How should I test it?", "general"], ["CachedStore", "general"]]) {
    assert.equal(retrievalPlan(question).intent, intent, "The question should select its preference or general fallback.");
  }
  assert.equal(evidencePreference(record({ type: "review-feedback" }), "reason").factor, 1,
    "Unaccepted review feedback should receive no acceptance preference.");
  assert.equal(evidencePreference(record({ type: "review-feedback", accepted: true, reverted: true }), "reason").factor, 1,
    "Reverted feedback should receive no acceptance preference.");
});

test("scope filters require explicit metadata and preserve false values", () => {
  const scoped = record({ component: "calendar", language: "JavaScript", fileRole: "production", generated: false, imported: false });
  const filters = { component: "calendar", language: "JavaScript", role: "production", generated: false, imported: false };
  assert.equal(matchesScope(scoped, filters), true, "Recorded metadata should match all explicit filters.");
  assert.equal(matchesScope(record({}), filters), false, "Missing metadata should not match explicit filters.");
  assert.equal(matchesScope(record({ ...scoped.source, metadataInferred: true }), filters), false,
    "Inferred metadata should not match strict filters.");
  assert.equal(matchesScope(record({ ...scoped.source, scopeUncertain: true }), filters), false,
    "Uncertain metadata should not match strict filters.");
  assert.equal(matchesScope(scoped, { role: "test" }), false, "A production role should not match a test filter.");
  assert.throws(() => retrievalPlan("CachedStore", { generated: "false" }), /true or false/,
    "String Boolean values should be rejected by the search API.");
  assert.throws(() => retrievalPlan("CachedStore", { role: "fixture" }), /production or test/,
    "Unsupported role filters should fail clearly.");
});

test("exact search ranks each evidence family without excluding other matches", async t => {
  const store = await setup(t);
  const source = await store.put(record({ type: "code-snapshot", revision: "a".repeat(40) }));
  const commit = await store.put(record({ type: "landed-patch", revision: "b".repeat(40) }));
  const accepted = await store.put(record({ type: "review-feedback", accepted: true }));
  const tests = await store.put(record({ type: "test-harness", fileRole: "test" }));
  const unknown = await store.put(record({ type: "review-feedback" }));
  const foreign = await store.put(record({ type: "code-snapshot" }, { repository: "tb-tools" }));
  for (const [question, expected] of [["Where is CachedStore implemented?", [source.id]],
    ["Why was CachedStore changed?", [commit.id, accepted.id]], ["How should I test CachedStore?", [tests.id]]]) {
    const result = searchKnowledge(store, { query: "CachedStore", question, repository: "thunderbird", maxChars: 24000 });
    assert.ok(expected.includes(result.ids[0]), "The preferred evidence family should rank first.");
    assert.ok(result.ids.includes(unknown.id), "Other matching evidence should remain available.");
    assert.ok(!result.ids.includes(foreign.id), "Search should keep repositories separate.");
    assert.match(result.text, /Retrieval choices:/, "Context should explain retrieval choices.");
    assert.match(result.text, /recorded revision|Acceptance|harness/, "Context should state the evidence limits.");
  }
});

test("explicit filters apply before candidate limits and missing metadata returns empty results", async t => {
  const store = await setup(t);
  for (let i = 0; i < 65; i++) await store.put(record({ type: "code-snapshot" }, { text: `CachedStore unrelated ${i}` }));
  const target = await store.put(record({ type: "code-snapshot", language: "JavaScript", fileRole: "test", generated: false, imported: false },
    { component: "calendar", text: "CachedStore scoped test evidence" }));
  const filters = { component: "calendar", language: "JavaScript", role: "test", generated: false, imported: false };
  const result = searchKnowledge(store, { query: "CachedStore", repository: "thunderbird", filters });
  assert.deepEqual(result.ids, [target.id], "Strict matching evidence should survive candidate limits.");
  assert.deepEqual(result.retrieval.filters, filters, "Results should identify explicit filters separately from intent.");
  const missing = searchKnowledge(store, { query: "CachedStore", repository: "thunderbird", filters: { language: "Rust" } });
  assert.deepEqual(missing.ids, [], "Unavailable metadata should return no matches without relaxing a filter.");
  assert.match(missing.retrieval.scopeLimit, /Missing or uncertain/, "Empty results should explain strict scope limits.");
  for (const maxChars of [0, 100, 1000, 24000]) {
    const bounded = searchKnowledge(store, { query: "CachedStore", repository: "thunderbird", maxChars });
    assert.ok(bounded.text.length <= maxChars, "Retrieval explanations and evidence should stay inside the context budget.");
  }
});


test("CLI passes explicit filters and rejects invalid Boolean values", async t => {
  const store = await setup(t);
  const target = await store.put(record({ type: "code-snapshot", language: "JavaScript", fileRole: "test", generated: false },
    { component: "calendar" }));
  const execute = promisify(execFile);
  const cli = new URL("../commands/knowledge/cli.mjs", import.meta.url).pathname;
  const args = [cli, "search", "--directory", store.directory, "--repository", "thunderbird", "--component", "calendar",
    "--language", "JavaScript", "--role", "test", "--generated", "false", "How should I test CachedStore?"];
  const result = JSON.parse((await execute(process.execPath, args, { cwd: store.directory })).stdout);
  assert.deepEqual(result.ids, [target.id], "CLI filters should retain only the recorded scope.");
  assert.equal(result.retrieval.intent, "testing", "The CLI question should select testing evidence.");
  await assert.rejects(execute(process.execPath, [...args, "--imported", "maybe"], { cwd: store.directory }),
    /needs true or false/, "Invalid CLI Boolean filters should fail clearly.");
});

test("console separates question intent from changed paths and passes filters", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-routing-service-"));
  const execute = promisify(execFile);
  await execute("git", ["init", directory]);
  await execute("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Test source baseline"]);
  const service = await createKnowledgeService({ directory: path.join(directory, "cache"), semantic: false,
    importLegacy: false, repositories: { [directory]: "thunderbird" }, maxContextChars: 10000 });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const target = await service.store.put(record({ type: "test-harness", fileRole: "test" }));
  const result = await service.beforeTurn({ cwd: directory, prompt: "How should I test CachedStore?", filters: { role: "test" } });
  assert.deepEqual(result.ids, [target.id], "Console retrieval should pass the explicit test filter.");
  assert.equal(result.retrieval.intent, "testing", "Console retrieval should route the request question.");
  assert.ok(result.text.length <= 10000, "Console retrieval should preserve its total context budget.");
});
