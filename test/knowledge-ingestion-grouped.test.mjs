import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initializeGroupedIngestion, groupedIngestionStatus, submitGroupedResponse, exportGroupedIngestion } from "../commands/knowledge/ingestion-grouped.mjs";
const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "tb-grouped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await mkdir(source);
  await git(source, "init", "-b", "main"); await writeFile(path.join(source, "module.mjs"), "export function value() { return 4; }\n");
  await git(source, "add", "."); await git(source, "commit", "-m", "Pinned source");
  const revision = await git(source, "rev-parse", "HEAD"), directory = path.join(root, "queue");
  const config = { version: 1, directory, cache: path.join(root, "cache"), repositories: [{ id: "thunderbird", directory: source, revision }], maxRepairs: 1,
    groups: [{ id: "sample", targets: [{ id: "module", repository: "thunderbird", path: "module.mjs", expectedUnits: [{ id: "value", start: 1, end: 1 }], needs: ["callers"] }] }] };
  const status = await initializeGroupedIngestion(config), bundle = JSON.parse(await readFile(path.join(directory, "bundles/sample.json"), "utf8"));
  const timing = () => ({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const producer = request => ({ requestId: request.id, worker: "producer", ...timing(), contracts: [], files: [{ targetId: "module", sourceHash: bundle.sources["thunderbird:module.mjs"].sourceHash, complete: true,
    units: [{ id: "value", explanation: "Returns the constant number four.", reads: [], writes: [], branches: [], result: "4", errors: "No explicit errors", async: "Synchronous", ownership: "No allocated object", anchors: [{ sourceId: "thunderbird:module.mjs", start: 1, end: 1 }] }],
    needChecks: [{ need: "callers", status: "checked", explanation: "The frozen fixture has no consumers." }], relationships: [], tests: [], parseFailures: [], unreadDependencies: [], gaps: [] }] });
  const review = (request, overrides = {}) => ({ requestId: request.id, producerHash: request.producerHash, worker: "reviewer", ...timing(), repairNeeded: false,
    files: [{ targetId: "module", decision: "complete", checkedUnitIds: ["value"], inventoryChecked: true, missingUnitIds: [], missingEdges: [], gaps: [], ...overrides }] });
  return { root, source, directory, config, status, producer, review };
}

test("a grouped response resumes through independent review and renders exact source", async t => {
  const f = await fixture(t), response = f.producer(f.status.pendingRequests[0]);

  const next = await submitGroupedResponse(f.directory, response);

  assert.equal(next.pendingRequests[0].stage, "review", "Producer submission should create an independent review request.");
  assert.deepEqual((await initializeGroupedIngestion(f.config)).pendingRequests, next.pendingRequests, "Restart should preserve the exact pending review.");
  assert.deepEqual((await submitGroupedResponse(f.directory, response)).pendingRequests, next.pendingRequests, "A repeated identical response should be idempotent.");

  await submitGroupedResponse(f.directory, f.review(next.pendingRequests[0]));
  const exported = await exportGroupedIngestion(f.directory);

  assert.equal(exported.records[0].decision, "complete", "A checked complete inventory should yield one complete draft.");
  assert.equal(exported.state, "drafts-not-published", "A rendered draft should not claim publication.");

  const text = await readFile(path.join(f.directory, "exports", exported.records[0].file), "utf8");
  assert.match(text, /export function value\(\) \{ return 4; \}/, "The draft should contain the exact Git source quote.");
});

test("same-worker stale-hash and incomplete inventory reviews cannot promote coverage", async t => {
  const f = await fixture(t), next = await submitGroupedResponse(f.directory, f.producer(f.status.pendingRequests[0])), request = next.pendingRequests[0];

  await assert.rejects(submitGroupedResponse(f.directory, { ...f.review(request), worker: "producer" }), /different worker/, "A producer should not independently review its own response.");
  await assert.rejects(submitGroupedResponse(f.directory, { ...f.review(request), producerHash: "a".repeat(64) }), /exact producer hash/, "A review should bind the current producer response.");
  await assert.rejects(submitGroupedResponse(f.directory, f.review(request, { checkedUnitIds: [] })), /cannot promote/, "An unchecked unit should prevent complete coverage.");

  assert.equal((await groupedIngestionStatus(f.directory)).pendingRequests[0].id, request.id, "Rejected submissions should leave the review request pending.");
});

test("parse failures and unread dependencies remain partial across immutable repair attempts", async t => {
  const f = await fixture(t), first = f.producer(f.status.pendingRequests[0]);
  first.files[0].parseFailures = ["Parser did not recognize the file."]; first.files[0].unreadDependencies = ["A caller is unread."];

  const next = await submitGroupedResponse(f.directory, first), review = f.review(next.pendingRequests[0]);
  await assert.rejects(submitGroupedResponse(f.directory, review), /cannot promote/, "Unresolved parsing and dependencies should prevent complete review.");

  review.files[0].decision = "partial"; review.repairNeeded = true;
  const repair = await submitGroupedResponse(f.directory, review);
  assert.equal(repair.pendingRequests[0].stage, "repair", "A repair request should retain the rejected producer and review hashes.");

  const checked = await submitGroupedResponse(f.directory, f.producer(repair.pendingRequests[0]));
  await submitGroupedResponse(f.directory, f.review(checked.pendingRequests[0]));

  assert.equal((await exportGroupedIngestion(f.directory)).records.length, 1, "Only the latest reviewed result should be exported.");
  assert.equal((await readdir(path.join(f.directory, "objects"))).length, 4, "Both original and repaired attempts should remain immutable objects.");
});

test("invalid anchors source hashes and frozen bundle tampering reject submission", async t => {
  const f = await fixture(t), first = f.producer(f.status.pendingRequests[0]);
  first.files[0].sourceHash = "a".repeat(64);
  await assert.rejects(submitGroupedResponse(f.directory, first), /source hash differs/, "An incorrect source hash should reject the response.");

  const invalid = f.producer(f.status.pendingRequests[0]); invalid.files[0].units[0].anchors[0].end = 900;
  await assert.rejects(submitGroupedResponse(f.directory, invalid), /line range/, "An anchor outside the pinned source should reject the response.");

  const bundleFile = path.join(f.directory, "bundles/sample.json"); await writeFile(bundleFile, "{}\n");
  await assert.rejects(submitGroupedResponse(f.directory, f.producer(f.status.pendingRequests[0])), /bundle changed/, "A changed frozen bundle should reject submission.");
});

test("empty anchor objects cannot bypass source validation", async t => {
  const f = await fixture(t), first = f.producer(f.status.pendingRequests[0]); first.files[0].units[0].anchors = [{}];
  await assert.rejects(submitGroupedResponse(f.directory, first), /Every declared anchor/, "An empty anchor should not produce checked evidence.");
});

test("request identity binds revisions even when target bytes are unchanged", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "dependency.mjs"), "export const changed = true;\n");
  await git(f.source, "add", "."); await git(f.source, "commit", "-m", "Changed dependency");
  const config = { ...f.config, directory: path.join(f.root, "other-queue"), repositories: [{ ...f.config.repositories[0], revision: await git(f.source, "rev-parse", "HEAD") }] };

  const other = await initializeGroupedIngestion(config);

  assert.notEqual(other.pendingRequests[0].id, f.status.pendingRequests[0].id, "Changed source pins should create a different request even when the target bytes match.");
});


test("unprepared targets remain failures and do not become partial publication drafts", async t => {
  const f = await fixture(t);
  const target = { ...f.config.groups[0].targets[0], id: "missing", path: "missing.mjs" };
  const config = { ...f.config, directory: path.join(f.root, "failed-queue"), groups: [{ id: "failure", targets: [target] }] };

  const initial = await initializeGroupedIngestion(config);
  const producer = f.producer(initial.pendingRequests[0]);
  Object.assign(producer.files[0], { targetId: "missing", sourceHash: null, complete: false, units: [], needChecks: [], gaps: ["Source is absent."] });
  const next = await submitGroupedResponse(config.directory, producer);
  const review = f.review(next.pendingRequests[0], { targetId: "missing", decision: "partial", checkedUnitIds: [], inventoryChecked: false, gaps: ["Preparation failed."] });
  await submitGroupedResponse(config.directory, review);
  const result = await exportGroupedIngestion(config.directory);

  assert.equal(result.records.length, 0, "An unprepared file should not produce a publication draft.");
  assert.equal(result.preparationFailures.length, 1, "The publication manifest should preserve the preparation failure.");
});
