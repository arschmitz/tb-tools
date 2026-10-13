import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initializeCompactIngestion, compactIngestionStatus, submitCompactResponse, exportCompactIngestion } from "../commands/knowledge/ingestion-compact.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
async function fixture(t, options = {}) {
  const { sourceText = "export function first() { return 4; }\nexport function second() { return 5; }\n", extraSources = {}, ...configurationOptions } = options;
  const root = await mkdtemp(path.join(tmpdir(), "tb-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await writeFile(path.join(source, "module.mjs"), sourceText);
  for (const [file, text] of Object.entries(extraSources)) await writeFile(path.join(source, file), text);
  await git(source, "add", ".");
  await git(source, "commit", "-m", "Pinned source");

  const revision = await git(source, "rev-parse", "HEAD"), directory = path.join(root, "queue");
  const config = { version: 1, compactVersion: 1, directory, cache: path.join(root, "cache"), repositories: [{ id: "thunderbird", directory: source, revision }], maxRepairs: 1,
    groups: [{ id: "sample", targets: [{ id: "module", repository: "thunderbird", path: "module.mjs", expectedUnits: [{ id: "first", start: 1, end: 1, functionRangeUtf16: [7, 37] }, { id: "second", start: 2, end: 2, functionRangeUtf16: [45, 76] }], needs: ["callers"] }] }], ...configurationOptions };
  const status = await initializeCompactIngestion(config);
  const bundle = JSON.parse(await readFile(path.join(directory, "bundles/sample.json"), "utf8"));
  const facts = JSON.parse(await readFile(path.join(directory, "compact-facts/sample.json"), "utf8"));
  const anchors = line => [{ sourceId: "thunderbird:module.mjs", start: line, end: line }];
  const timing = () => ({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const producer = request => ({ requestId: request.id, worker: "producer", ...timing(), contracts: [], files: [{ targetId: "module", sourceHash: bundle.sources["thunderbird:module.mjs"].sourceHash, complete: true,
    units: [1, 2].map((line, index) => ({ id: ["first", "second"][index], explanation: `Returns the primitive ${line + 3} after parameter binding.`, anchors: anchors(line), facts: [], contractRefs: [] })),
    needChecks: [{ need: "callers", status: "not-applicable", explanation: "This isolated fixture exports two unconsumed functions.", anchors: anchors(1) }], relationships: [], tests: [], parseFailures: [], unreadDependencies: [], gaps: [] }] });
  const review = request => ({ requestId: request.id, producerHash: request.producerHash, worker: "reviewer", ...timing(), repairNeeded: false, checkedContractIds: [],
    files: [{ targetId: "module", decision: "complete", checkedUnitIds: ["first", "second"], checkedReuseUnitIds: [], inventoryChecked: true, missingUnitIds: [], missingEdges: [], gaps: [] }] });
  const reuse = response => {
    response.contracts = [{ id: "primitive", kind: "body-rule", rule: "return-primitive", explanation: "Returns the exact primitive recorded by each generated local body fact.", anchors: anchors(1) }];
    const unit = response.files[0].units[0];
    unit.contractRefs = ["primitive"];
    unit.reuse = { contractId: "primitive", factId: facts["thunderbird:module.mjs"].direct.facts[0].id, bodyHash: facts["thunderbird:module.mjs"].direct.facts[0].bodyHash,
      bindings: Object.fromEntries(["receiver", "arguments", "branches", "state", "errors", "completion", "ownership"].map(name => [name, { claim: `The fixture's ${name} contract was checked in this body.`, anchors: anchors(1) }])) };
    return response;
  };
  return { root, source, directory, config, status, producer, review, reuse, facts };
}

test("compact records keep exact evidence separate and omit transport padding", async t => {
  const f = await fixture(t), response = f.producer(f.status.pendingRequests[0]);
  const next = await submitCompactResponse(f.directory, response);
  const repeated = await submitCompactResponse(f.directory, response);

  assert.deepEqual(repeated.pendingRequests, next.pendingRequests, "An identical compact response should resume the same request.");
  await submitCompactResponse(f.directory, f.review(next.pendingRequests[0]));
  const exported = await exportCompactIngestion(f.directory);
  const text = await readFile(path.join(f.directory, "compact-exports", exported.records[0].file), "utf8");

  assert.equal(exported.records.length, 1, "The two-body file should count as one complete file record.");
  assert.equal(exported.evidence.length, 2, "Repeated anchors should share two exact source evidence notes.");
  assert.doesNotMatch(text, /compactTransportOnly|reads:|ownership:/, "Transport padding should never appear as published behavior claims.");
  assert.match(text, /Returns the primitive 4/, "The compact record should preserve the body's specific behavior.");
  assert.equal(exported.state, "drafts-not-published", "Export should not claim publication or retrieval success.");
});

test("whole-body family reuse needs generated membership and independent contextual review", async t => {
  const f = await fixture(t), response = f.reuse(f.producer(f.status.pendingRequests[0]));
  const next = await submitCompactResponse(f.directory, response), review = f.review(next.pendingRequests[0]);

  await assert.rejects(submitCompactResponse(f.directory, review), /every reuse member/, "A missing independent member check should prevent complete coverage.");
  review.files[0].checkedReuseUnitIds = ["first"];
  await assert.rejects(submitCompactResponse(f.directory, review), /checked shared contracts/, "An unchecked family contract should prevent complete coverage.");
  review.checkedContractIds = ["primitive"];
  await submitCompactResponse(f.directory, review);

  assert.equal((await exportCompactIngestion(f.directory)).contracts.length, 1, "A checked reused family should export one linked contract.");
});

test("matching names absent bindings and another unit's generated fact do not prove reuse", async t => {
  const f = await fixture(t);
  const missing = f.reuse(f.producer(f.status.pendingRequests[0]));
  delete missing.files[0].units[0].reuse.bindings.receiver;
  await assert.rejects(submitCompactResponse(f.directory, missing), /every anchored contextual binding/, "A missing receiver binding should reject reuse.");

  const wrong = f.reuse(f.producer(f.status.pendingRequests[0]));
  wrong.files[0].units[0].reuse.factId = f.facts["thunderbird:module.mjs"].direct.facts[1].id;
  await assert.rejects(submitCompactResponse(f.directory, wrong), /one generated whole-body fact/, "Another unit's rule match should not establish this unit's membership.");

  const outside = f.reuse(f.producer(f.status.pendingRequests[0]));
  Object.assign(outside.contracts[0], { kind: "exact-body", targetId: "module", unitId: "unknown", bodyHash: "a".repeat(64) });
  await assert.rejects(submitCompactResponse(f.directory, outside), /frozen owner unit/, "An exact-body hash outside the frozen units should reject reuse.");
});

test("exact-body reuse rejects changed bytes even when both bodies return a primitive", async t => {
  const f = await fixture(t), response = f.reuse(f.producer(f.status.pendingRequests[0]));
  Object.assign(response.contracts[0], { kind: "exact-body", targetId: "module", unitId: "second", bodyHash: f.facts["thunderbird:module.mjs"].units[1].sliceHash });

  await assert.rejects(submitCompactResponse(f.directory, response), /body bytes differ/, "Different return values should reject exact-byte reuse.");
});

test("dynamic or inferred links and empty anchors cannot promote a complete file", async t => {
  const f = await fixture(t), response = f.producer(f.status.pendingRequests[0]);
  response.files[0].relationships = [{ status: "unresolved", claim: "The dynamic receiver is unknown.", anchors: response.files[0].units[0].anchors }];
  await assert.rejects(submitCompactResponse(f.directory, response), /Unresolved or inferred/, "An unresolved dynamic receiver should prevent complete coverage.");

  const malformed = f.producer(f.status.pendingRequests[0]);
  malformed.files[0].units[0].facts = [{ status: "observed", explanation: "This is not a fact claim.", anchors: malformed.files[0].units[0].anchors }];
  await assert.rejects(submitCompactResponse(f.directory, malformed), /facts need a claim/, "A fact without a claim should not render undefined text.");

  const invalid = f.producer(f.status.pendingRequests[0]);
  invalid.files[0].units[0].anchors = [{}];
  await assert.rejects(submitCompactResponse(f.directory, invalid), /own frozen source range/, "Empty anchors should not establish evidence for a unit.");
});

test("completed receipt time controls the deadline even when admission time was earlier", async t => {
  const deadlineAt = new Date(Date.now() - 1000).toISOString();
  const f = await fixture(t, { deadlineAt });
  t.mock.method(Date, "now", () => Date.parse(deadlineAt) - 1);
  const next = await submitCompactResponse(f.directory, f.producer(f.status.pendingRequests[0]));

  assert.equal(next.deadlineViolations.length > 0, true, "A submission completed after the cutoff should record a deadline violation.");
  await submitCompactResponse(f.directory, f.review(next.pendingRequests[0]));
  const exported = await exportCompactIngestion(f.directory);

  assert.equal(exported.records.length, 0, "A late completed receipt should receive no export or throughput credit.");
  assert.deepEqual(exported.blockedGroups, ["sample"], "The exporter should preserve the group blocked by the cutoff.");
});

test("the current wall clock rejects new submissions after the frozen cutoff", async t => {
  const f = await fixture(t, { deadlineAt: "2000-01-01T00:00:00Z" });

  await assert.rejects(submitCompactResponse(f.directory, f.producer(f.status.pendingRequests[0])), /deadline has passed/, "An expired queue should reject new source submissions.");
  assert.equal((await compactIngestionStatus(f.directory)).pendingRequests[0].stage, "produce", "A rejected late submission should leave its original request pending.");
});


test("a nested same-line constant-return body cannot explain its effectful outer function", async t => {
  const sourceText = "export function outer() { sideEffect(); return function inner() { return 4; }; }\n";
  const groups = [{ id: "sample", targets: [{ id: "module", repository: "thunderbird", path: "module.mjs", expectedUnits: [{ id: "first", start: 1, end: 1, functionRangeUtf16: [7, sourceText.length - 1] }], needs: ["callers"] }] }];
  const f = await fixture(t, { sourceText, groups });
  const response = f.reuse(f.producer(f.status.pendingRequests[0]));
  response.files[0].units.length = 1;

  await assert.rejects(submitCompactResponse(f.directory, response), /one generated whole-body fact/, "The inner primitive-return fact should not establish a contract for the outer effectful function.");
});

test("separate queues namespace shared evidence so later contributions never overwrite it", async t => {
  const f = await fixture(t);
  const next = await submitCompactResponse(f.directory, f.producer(f.status.pendingRequests[0]));
  await submitCompactResponse(f.directory, f.review(next.pendingRequests[0]));
  const first = await exportCompactIngestion(f.directory);
  const other = path.join(f.root, "other-queue");
  const initial = await initializeCompactIngestion({ ...f.config, directory: other });
  const pending = await submitCompactResponse(other, f.producer(initial.pendingRequests[0]));
  await submitCompactResponse(other, f.review(pending.pendingRequests[0]));
  const second = await exportCompactIngestion(other);

  assert.equal(first.evidence.some(file => second.evidence.includes(file)), false, "Later queues should use fresh evidence note names even when their source quotes match.");
});

test("changing the compact deadline cannot extend the frozen queue", async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, "compact.json"), saved = JSON.parse(await readFile(file, "utf8"));
  saved.configuration.deadlineAt = "2100-01-01T00:00:00Z";
  await writeFile(file, JSON.stringify(saved));

  await assert.rejects(compactIngestionStatus(f.directory), /configuration changed/, "A changed deadline should fail the frozen configuration check.");
});


async function contractFixture(t, originDecision = "complete", checkedDefinition = true) {
  const expectedUnits = [{ id: "first", start: 1, end: 1, functionRangeUtf16: [7, 37] }, { id: "second", start: 2, end: 2, functionRangeUtf16: [45, 76] }];
  const groups = ["module", "other", "third"].map(id => ({ id, targets: [{ id, repository: "thunderbird", path: `${id}.mjs`, expectedUnits, needs: ["callers"] }] }));
  // The base fixture reads sample.json; its first group keeps that fixture name.
  groups[0].id = "sample";
  const f = await fixture(t, { groups, extraSources: Object.fromEntries(["other.mjs", "third.mjs"].map(file => [file, "export function first() { return 4; }\nexport function second() { return 5; }\n"])) });
  const response = f.reuse(f.producer(f.status.pendingRequests.find(item => item.groupId === "sample")));
  const pending = await submitCompactResponse(f.directory, response);
  const review = f.review(pending.pendingRequests.find(item => item.groupId === "sample"));
  review.files[0].decision = originDecision;
  review.files[0].checkedReuseUnitIds = ["first"];
  review.checkedContractIds = checkedDefinition ? ["primitive"] : [];
  const status = await submitCompactResponse(f.directory, review);
  const original = status.groups.find(item => item.groupId === "sample");
  const current = f.reuse(f.producer(status.pendingRequests.find(item => item.groupId === "other")));
  current.files[0].targetId = "other";
  const replace = value => {
    if (!value || typeof value !== "object") return;
    if (value.sourceId === "thunderbird:module.mjs") value.sourceId = "thunderbird:other.mjs";
    for (const item of Object.values(value)) replace(item);
  };
  replace(current.files);
  const facts = JSON.parse(await readFile(path.join(f.directory, "compact-facts/other.json"), "utf8"));
  current.files[0].units[0].reuse.factId = facts["thunderbird:other.mjs"].direct.facts[0].id;
  current.contracts = [{ id: "primitive", reference: { producerHash: original.producerHash, reviewHash: original.reviewHash, contractId: "primitive" } }];
  return { ...f, original, current };
}

test("cross-file reuse keeps the accepted definition and still checks every new member", async t => {
  const f = await contractFixture(t);
  const pending = await submitCompactResponse(f.directory, f.current);
  const review = f.review(pending.pendingRequests.find(item => item.groupId === "other"));
  review.files[0].targetId = "other";

  await assert.rejects(submitCompactResponse(f.directory, review), /every reuse member/, "Reusing an accepted definition should still require independent review of the current member.");
  review.files[0].checkedReuseUnitIds = ["first"];
  await submitCompactResponse(f.directory, review);
  const exported = await exportCompactIngestion(f.directory);
  const text = await readFile(path.join(f.directory, "compact-exports", exported.records.find(item => item.targetId === "other").file), "utf8");

  assert.equal(exported.records.length, 2, "Both independently checked file origins should export.");
  assert.equal(exported.contracts.length, 1, "Cross-file reuse should publish one original shared definition.");
  assert.match(text, new RegExp(f.original.producerHash), "The later record should retain the exact original accepted producer hash.");
  assert.match(text, new RegExp(exported.contracts[0].replaceAll(".", "\\.")), "The later file should link the original contract note.");
});

test("wrong hashes overridden definitions and partial origins cannot supply accepted contracts", async t => {
  const f = await contractFixture(t);
  const wrong = structuredClone(f.current);
  wrong.contracts[0].reference.producerHash = "a".repeat(64);
  await assert.rejects(submitCompactResponse(f.directory, wrong), /independently reviewed/, "A different producer hash should not identify an accepted contract.");

  const override = structuredClone(f.current);
  override.contracts[0].explanation = "An unreviewed replacement definition.";
  await assert.rejects(submitCompactResponse(f.directory, override), /cannot override/, "A contract reference should not override its accepted definition.");

  const partial = await contractFixture(t, "partial");
  await assert.rejects(submitCompactResponse(partial.directory, partial.current), /accepted complete origin/, "A partial-only source should not register an accepted shared contract.");

  const unchecked = await contractFixture(t, "partial", false);
  await assert.rejects(submitCompactResponse(unchecked.directory, unchecked.current), /independent definition check/, "An unchecked definition should not become reusable.");
});


test("a contract reference must point to its original accepted definition", async t => {
  const f = await contractFixture(t);
  const pending = await submitCompactResponse(f.directory, f.current);
  const review = f.review(pending.pendingRequests.find(item => item.groupId === "other"));
  review.files[0].targetId = "other";
  review.files[0].checkedReuseUnitIds = ["first"];
  review.checkedContractIds = ["primitive"];
  const status = await submitCompactResponse(f.directory, review);
  const intermediary = status.groups.find(item => item.groupId === "other");
  const response = structuredClone(f.current);
  response.requestId = status.pendingRequests.find(item => item.groupId === "third").id;
  response.files[0].targetId = "third";
  response.contracts[0].reference = { producerHash: intermediary.producerHash, reviewHash: intermediary.reviewHash, contractId: "primitive" };

  await assert.rejects(submitCompactResponse(f.directory, response), /original accepted contract directly/, "An inherited contract should not create an intermediate nonexistent definition note.");
});

test("out-of-order group completion retains identical shared evidence content", async t => {
  const units = [{ id: "first", start: 1, end: 1 }, { id: "second", start: 2, end: 2 }];
  const groups = ["sample", "later"].map(id => ({ id, targets: [{ id: id === "sample" ? "module" : "later", repository: "thunderbird", path: "module.mjs", expectedUnits: units, needs: ["callers"] }] }));
  const f = await fixture(t, { groups });
  const later = f.producer(f.status.pendingRequests.find(item => item.groupId === "later"));
  later.files[0].targetId = "later";
  const pending = await submitCompactResponse(f.directory, later);
  const review = f.review(pending.pendingRequests.find(item => item.groupId === "later"));
  review.files[0].targetId = "later";
  const status = await submitCompactResponse(f.directory, review);
  const first = await exportCompactIngestion(f.directory);
  const before = await readFile(path.join(f.directory, "compact-exports", first.evidence[0]), "utf8");

  const earlier = await submitCompactResponse(f.directory, f.producer(status.pendingRequests.find(item => item.groupId === "sample")));
  await submitCompactResponse(f.directory, f.review(earlier.pendingRequests.find(item => item.groupId === "sample")));
  const second = await exportCompactIngestion(f.directory);
  const after = await readFile(path.join(f.directory, "compact-exports", first.evidence[0]), "utf8");

  assert.equal(second.records.length, 2, "A newly completed earlier group should export without rewriting shared evidence.");
  assert.equal(after, before, "Shared evidence content should remain identical regardless of group completion order.");
});
