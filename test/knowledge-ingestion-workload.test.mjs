import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { prepareWorkloadPackets, sampleWorkload, runWorkloadCLI } from "../commands/knowledge/ingestion-workload.mjs";

const execute = promisify(execFile);
const sha = text => createHash("sha256").update(text).digest("hex");
const git = async (cwd, ...args) => (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
async function fixture(t, files = { "src/module.mjs": "export function value() { return 4; }\n", "src/moz.build": 'SOURCES += ["module.mjs"]\n' }) {
  const root = await mkdtemp(path.join(tmpdir(), "tb-ingestion-workload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "source"); await mkdir(directory);
  await git(directory, "init", "-b", "main");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  await git(directory, "add", "."); await git(directory, "commit", "-m", "Pinned input");
  const revision = await git(directory, "rev-parse", "HEAD");
  let next = 0;
  const configuration = targets => ({ version: 1, repositories: [{ id: "thunderbird", directory, revision }], targets,
    output: path.join(root, `packets-${next++}`), cache: path.join(root, "cache"), maxLeads: 2 });
  const readPacket = async (config, report, index = 0) => JSON.parse(await readFile(path.join(config.output, report.packets[index].file), "utf8"));
  return { root, directory, revision, configuration, readPacket };
}

test("preparation reads the pinned tree and preserves full source on warm reuse", async t => {
  const f = await fixture(t), target = { repository: "thunderbird", path: "src/module.mjs", symbol: "value" };
  await writeFile(path.join(f.directory, target.path), "uncommitted work\n");
  const cold = f.configuration([target]), first = await prepareWorkloadPackets(cold), packet = await f.readPacket(cold, first);
  const warm = f.configuration([target]), second = await prepareWorkloadPackets(warm);
  assert.equal(packet.source.text, "export function value() { return 4; }\n", "The packet should use the pinned source rather than working changes.");
  assert.equal(packet.source.revision, f.revision, "The packet should retain the source revision.");
  assert.equal(first.metrics.blobReads, 2, "The cold run should read the target and nearby build source.");
  assert.equal(second.metrics.blobReads, 0, "The warm run should reuse verified cache bytes.");
  assert.equal(second.packets[0].sourceHash, first.packets[0].sourceHash, "Warm preparation should preserve the source hash.");
  assert.equal(packet.priorEvidenceLookup, "not-looked-up", "An omitted evidence list should not imply no prior evidence exists.");
});

test("path spelling matches and context files remain unresolved leads", async t => {
  const f = await fixture(t, { "src/module.mjs": 'export function value() { return 4; }\nobject.value();\nother.value();\n', "src/moz.build": 'SOURCES += ["module.mjs"]\n' });
  const config = f.configuration([{ repository: "thunderbird", path: "src/module.mjs", symbol: "value" }]);
  const report = await prepareWorkloadPackets(config), packet = await f.readPacket(config, report);
  assert.equal(packet.behavioralCoverage, "not-analyzed", "A prepared packet should not claim behavior analysis.");
  assert.equal(packet.context[0].status, "unverified-context", "A nearby manifest should remain an unverified relationship.");
  assert.equal(packet.nearbyMatches.items.length, 2, "The lead cap should bound emitted matches.");
  assert.ok(packet.nearbyMatches.omitted > 0, "The report should retain the count of omitted matches.");
  assert.ok(packet.nearbyMatches.items.every(item => item.status === "unverified-spelling-match"), "Matching method names should remain unverified targets.");
});

test("stale identities and excluded paths do not become prepared packets", async t => {
  const f = await fixture(t, { "src/module.mjs": "value();\n", "suite/module.mjs": "value();\n" });
  const config = f.configuration([
    { repository: "thunderbird", path: "src/module.mjs", oid: "a".repeat(40) },
    { repository: "thunderbird", path: "suite/module.mjs" },
    { repository: "thunderbird", path: "../source/src/module.mjs" },
  ]);
  const report = await prepareWorkloadPackets(config);
  assert.equal(report.packets.length, 0, "Invalid targets should not produce packets.");
  assert.equal(report.failures.length, 3, "Each rejected target should retain its own failure.");
  assert.match(report.failures.find(item => item.target.oid).error, /blob differs/, "A stale inventory object should report the mismatch.");
});

test("binary invalid UTF-8 oversized and symlink targets retain failures", async t => {
  const f = await fixture(t, { "src/binary": Buffer.from([1, 0, 2]), "src/invalid": Buffer.from([255, 254]), "src/large": "a".repeat(4_000_001), "src/module.mjs": "return 1;\n" });
  await symlink("module.mjs", path.join(f.directory, "src/link")); await git(f.directory, "add", "."); await git(f.directory, "commit", "-m", "Add link");
  const config = f.configuration(["binary", "invalid", "large", "link"].map(name => ({ repository: "thunderbird", path: `src/${name}` })));
  config.repositories[0].revision = await git(f.directory, "rev-parse", "HEAD");
  const report = await prepareWorkloadPackets(config);
  assert.equal(report.packets.length, 0, "Unsupported source bytes and modes should not produce text packets.");
  assert.equal(report.failures.length, 4, "Unsupported targets should remain counted as open failures.");
  assert.match(report.failures.find(item => item.target.path.endsWith("link")).error, /Symlink/, "The source reader should reject symlinks rather than follow them.");
});

test("duplicate bytes retain independent path context and obligations", async t => {
  const source = "export const same = 1;\n";
  const f = await fixture(t, { "a/module.mjs": source, "b/module.mjs": source, "a/moz.build": 'SOURCES += ["module.mjs"]\n', "b/moz.build": 'TESTS += ["module.mjs"]\n' });
  const config = f.configuration(["a", "b"].map(directory => ({ repository: "thunderbird", path: `${directory}/module.mjs` })));
  const report = await prepareWorkloadPackets(config), first = await f.readPacket(config, report), second = await f.readPacket(config, report, 1);
  assert.equal(report.metrics.blobReads, 3, "Duplicate file bytes should share a single blob read.");
  assert.notEqual(first.id, second.id, "Identical source in different paths should retain separate packet identities.");
  assert.notEqual(first.context[0].text, second.context[0].text, "Different build contexts should remain separate.");
  assert.equal(first.obligations.length, second.obligations.length, "Copy grouping should not remove per-path relationship review.");
});

test("prior source matching does not extend the prior coverage", async t => {
  const f = await fixture(t), config = f.configuration([{ repository: "thunderbird", path: "src/module.mjs" }]);
  config.priorEvidence = [
    { id: "body", repository: "thunderbird", revision: f.revision, path: "src/module.mjs", start: 1, end: 1, sourceHash: sha("export function value() { return 4; }"), coverage: "body-only" },
    { id: "wrong", repository: "thunderbird", revision: f.revision, path: "src/module.mjs", start: 1, end: 1, sourceHash: "b".repeat(64), coverage: "body-only" },
  ];
  const report = await prepareWorkloadPackets(config), packet = await f.readPacket(config, report);
  assert.equal(packet.priorEvidence[0].reuseStatus, "source-matched-prior-claim", "A matching prior anchor should be available for scoped reuse.");
  assert.equal(packet.priorEvidence[0].coverage, "body-only", "Hash matching should preserve the prior coverage limit.");
  assert.equal(packet.priorEvidence[1].reuseStatus, "source-hash-mismatch", "A mismatching prior claim should remain unresolved.");
  assert.equal(packet.behavioralCoverage, "not-analyzed", "Evidence reuse should not automatically close the packet.");
});

test("output checks resolve symlinks before writing into source checkouts", async t => {
  const f = await fixture(t), config = f.configuration([{ repository: "thunderbird", path: "src/module.mjs" }]);
  const link = path.join(f.root, "alias"); await symlink(f.directory, link);
  config.output = path.join(link, "new-output");
  await assert.rejects(prepareWorkloadPackets(config), /outside source/, "An output alias into source should be rejected before writing.");
  await assert.rejects(readFile(path.join(f.directory, "new-output/report.json")), { code: "ENOENT" }, "Rejected output should not create a source artifact.");
});

test("tampered cache data fails validation instead of silently becoming evidence", async t => {
  const f = await fixture(t), target = { repository: "thunderbird", path: "src/module.mjs" };
  const first = f.configuration([target]), report = await prepareWorkloadPackets(first), packet = await f.readPacket(first, report);
  await writeFile(path.join(first.cache, `${packet.source.oid}.txt`), "tampered\n");
  const second = await prepareWorkloadPackets(f.configuration([target]));
  assert.equal(second.packets.length, 0, "A corrupt cache should not produce a packet.");
  assert.match(second.failures[0].error, /validation/, "A corrupt cache should retain an explicit source validation failure.");
});

test("sampling is repeatable and keeps failed or binary populations visible", async t => {
  const f = await fixture(t), ledger = path.join(f.root, "ledger.jsonl");
  const rows = [
    { repository: "thunderbird", path: "a.js", revision: f.revision, language: "JavaScript", bytes: 2, disposition: "parse-repair-needed" },
    { repository: "thunderbird", path: "b.js", revision: f.revision, language: "JavaScript", bytes: 2, disposition: "body-analysis-needed" },
    { repository: "thunderbird", path: "c.png", revision: f.revision, language: "binary", bytes: 3, disposition: "non-text-inspection-needed" },
    { repository: "thunderbird", path: "suite/d.js", revision: f.revision, language: "JavaScript", bytes: 2, scope: "excluded-suite" },
  ];
  await writeFile(ledger, rows.map(row => JSON.stringify(row)).join("\n"));
  const first = await sampleWorkload(ledger, { seed: "fixed" });
  await writeFile(ledger, rows.reverse().map(row => JSON.stringify(row)).join("\n"));
  const second = await sampleWorkload(ledger, { seed: "fixed" });
  assert.deepEqual(first.targets, second.targets, "Sample selection should not depend on JSONL row order.");
  assert.equal(first.total, 4, "The inventory count should include excluded entries.");
  assert.equal(first.excluded, 1, "Suite should retain an explicit excluded count.");
  assert.equal(first.dispositions["parse-repair-needed"], 1, "Failed parser entries should remain counted in the population.");
  assert.ok(first.targets.some(row => row.language === "binary"), "Binary entries should remain eligible for diagnostic preparation failure measurement.");
});

test("the CLI exposes direct standalone usage", async () => {
  const result = await runWorkloadCLI(["--help"]);
  assert.match(result.usage, /--config packet-config.json/, "The CLI should describe the packet configuration entry point.");
});
