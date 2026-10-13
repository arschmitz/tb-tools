import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { extractDirectBodyFacts } from "./body-facts.mjs";
import { initializeGroupedIngestion, groupedIngestionStatus, submitGroupedResponse } from "./ingestion-grouped.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const encode = value => JSON.stringify(value, null, 2) + "\n";
const readJSON = async file => JSON.parse(await readFile(file, "utf8"));
const optionalJSON = async file => readJSON(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const sourceID = target => `${target.repository}:${target.path}`;
const bindings = ["receiver", "arguments", "branches", "state", "errors", "completion", "ownership"];
const rules = new Set(["return-primitive", "return-bound-parameter", "empty-or-bare-return"]);
const present = value => typeof value === "string" && value.trim().length > 0;
const sameIDs = (expected, actual) => Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length && expected.every(id => actual.includes(id));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const anchored = value => value && present(value.claim || value.explanation) && Array.isArray(value.anchors) && value.anchors.length > 0;
const uuid = value => { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

async function immutable(file, value) {
  const text = typeof value === "string" ? value : encode(value);
  const temporary = `${file}.${process.pid}.${hash(text)}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, text, { flag: "wx" }).catch(async error => {
    if (error.code !== "EEXIST" || await readFile(temporary, "utf8") !== text) throw error;
  });
  try { await link(temporary, file); }
  catch (error) {
    if (error.code !== "EEXIST" || await readFile(file, "utf8") !== text) throw new Error(`Immutable output differs: ${file}`);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function compactSourceFacts(bundle) {
  return Object.fromEntries(Object.entries(bundle.sources).map(([id, source]) => {
    const targets = bundle.targets.filter(target => sourceID(target) === id);
    const direct = /\.(?:[cm]?js|jsx)$/.test(source.path)
      ? extractDirectBodyFacts(source.text, source)
      : { status: "unsupported-language", facts: [], limits: "No automatic local-body rule is available for this language." };
    return [id, { sourceHash: source.sourceHash, sourceBytes: Buffer.byteLength(source.text), lineCount: source.text.split("\n").length,
      units: targets.flatMap(target => target.expectedUnits.map(unit => ({ targetId: target.id, ...unit,
        sliceHash: hash(source.text.split("\n").slice(unit.start - 1, unit.end).join("\n")) }))), direct }];
  }));
}

async function compactConfiguration(directory) {
  const saved = await readJSON(path.join(directory, "compact.json"));
  const manifest = await readJSON(path.join(directory, "manifest.json"));
  assert(saved.configuration?.compactVersion === 1 && hash(encode(saved.configuration)) === manifest.configurationHash, "The frozen compact configuration changed.");
  return saved.configuration;
}

export async function initializeCompactIngestion(configuration) {
  assert(configuration.compactVersion === 1, "Supply compactVersion 1.");
  if (configuration.deadlineAt) assert(Number.isFinite(Date.parse(configuration.deadlineAt)), "deadlineAt must be a valid timestamp.");
  await initializeGroupedIngestion(configuration);
  await immutable(path.join(configuration.directory, "compact.json"), { version: 1, configuration });
  const manifest = await readJSON(path.join(configuration.directory, "manifest.json"));
  for (const group of manifest.groups) {
    const bundle = await readJSON(path.join(configuration.directory, "bundles", `${group.id}.json`));
    await immutable(path.join(configuration.directory, "compact-facts", `${group.id}.json`), compactSourceFacts(bundle));
  }
  return compactIngestionStatus(configuration.directory);
}

export async function compactIngestionStatus(directory) {
  const status = await groupedIngestionStatus(directory), config = await compactConfiguration(directory);
  const deadlineViolations = [];
  for (const group of status.groups) {
    for (const objectHash of [group.producerHash, group.reviewHash].filter(Boolean)) {
      const object = await readJSON(path.join(directory, "objects", `${objectHash}.json`));
      const receipt = await optionalJSON(path.join(directory, "compact-receipts", `${object.response.requestId}.json`));
      if (config.deadlineAt && [object.receivedAt, receipt?.completedAt].filter(Boolean).some(value => Date.parse(value) > Date.parse(config.deadlineAt))) deadlineViolations.push({ groupId: group.groupId, hash: objectHash, receivedAt: object.receivedAt, completedAt: receipt?.completedAt });
    }
  }
  return { ...status, adapter: "compact-v1", deadlineAt: config.deadlineAt, deadlineViolations,
    limits: [...status.limits, "Automatic local-body facts do not establish caller contracts or full behavior coverage.", "Unsupported text languages may be read individually; non-text preparation failures cannot produce complete records."] };
}

async function verifiedObject(directory, objectHash) {
  assert(/^[a-f0-9]{64}$/.test(objectHash || ""), "Contract references need exact object hashes.");
  const text = await readFile(path.join(directory, "objects", `${objectHash}.json`), "utf8");
  assert(hash(text) === objectHash, "Referenced contract object hash changed.");
  return JSON.parse(text);
}

async function resolveContractReferences(directory, response) {
  const contracts = [];
  let status;
  for (const contract of response.contracts || []) {
    assert(!Object.hasOwn(contract, "acceptedFrom"), "A producer cannot supply accepted-contract provenance.");
    if (!contract.reference) { contracts.push(contract); continue; }
    assert(sameIDs(["id", "reference"], Object.keys(contract)) && sameIDs(["producerHash", "reviewHash", "contractId"], Object.keys(contract.reference)), "A contract reference cannot override its definition.");
    const reference = contract.reference;
    assert(contract.id === reference.contractId, "A reused contract must retain its original ID.");
    status ||= await compactIngestionStatus(directory);
    const group = status.groups.find(item => item.state === "reviewed" && item.producerHash === reference.producerHash && item.reviewHash === reference.reviewHash);
    assert(group && !status.deadlineViolations.some(item => item.groupId === group.groupId), "Contract origin must be independently reviewed and within the deadline.");
    const producer = await verifiedObject(directory, reference.producerHash), review = await verifiedObject(directory, reference.reviewHash);
    assert(review.response.producerHash === reference.producerHash && review.response.worker !== producer.response.worker && review.response.checkedContractIds?.includes(contract.id), "Contract origin needs an independent definition check.");
    for (const object of [producer, review]) {
      const receipt = await readJSON(path.join(directory, "compact-receipts", `${object.response.requestId}.json`));
      assert(!status.deadlineAt || Date.parse(receipt.completedAt) <= Date.parse(status.deadlineAt), "Referenced contract completed after the deadline.");
    }
    const original = producer.response.compact?.contracts.find(item => item.id === contract.id);
    assert(original && group.files.some(file => file.decision === "complete" && producer.response.compact.files.find(item => item.targetId === file.targetId)?.units.some(unit => unit.contractRefs?.includes(contract.id))), "A checked contract must be used by an accepted complete origin.");
    assert(!original.acceptedFrom, "Reference the original accepted contract directly, not an inherited copy.");
    const anchors = new Map(producer.anchors.map(anchor => [anchorKey(anchor), anchor]));
    const resolved = structuredClone(original);
    resolved.anchors = original.anchors.map(anchor => {
      const source = anchors.get(anchorKey(anchor));
      assert(source, "Original contract evidence is missing.");
      return { repository: source.repository, revision: source.revision, path: source.path, start: source.start, end: source.end, quote: source.quote };
    });
    resolved.acceptedFrom = { ...reference, noteFile: `${uuid(encode([original, reference.producerHash, reference.reviewHash]))}.md` };
    contracts.push(resolved);
  }
  return { ...response, contracts };
}

function validateCompactProducer(response, bundle, facts) {
  const contracts = new Map((response.contracts || []).map(contract => [contract.id, contract]));
  for (const contract of contracts.values()) {
    assert(["shared", "body-rule", "exact-body"].includes(contract.kind) && anchored(contract), "A compact contract needs its kind, explanation and evidence.");
    if (contract.kind === "body-rule") assert(rules.has(contract.rule), "Unsupported whole-body family rule.");
    if (contract.kind === "exact-body" && !contract.acceptedFrom) {
      const owner = bundle.targets.find(target => target.id === contract.targetId);
      const unit = facts[owner && sourceID(owner)]?.units.find(item => item.targetId === contract.targetId && item.id === contract.unitId);
      assert(unit && unit.sliceHash === contract.bodyHash, "Exact-body contract does not match its frozen owner unit.");
    }
  }
  for (const file of response.files || []) {
    const target = bundle.targets.find(item => item.id === file.targetId);
    assert(target, "Unknown compact target.");
    for (const unit of file.units || []) {
      const expected = target.expectedUnits.find(item => item.id === unit.id);
      assert(expected && present(unit.explanation) && anchored(unit), "Each compact unit needs a known ID, explanation and source anchors.");
      assert(unit.anchors.some(anchor => (anchor.sourceId === sourceID(target) || (anchor.repository === target.repository && anchor.path === target.path)) && anchor.start <= expected.start && anchor.end >= expected.end), "Every unit needs an anchor covering its own frozen source range.");
      for (const fact of unit.facts || []) assert(present(fact.claim) && anchored(fact) && ["observed", "inferred", "unresolved"].includes(fact.status), "Compact facts need a claim, status and evidence.");
      if (!unit.reuse) continue;
      const contract = contracts.get(unit.reuse.contractId);
      assert(contract && ["body-rule", "exact-body"].includes(contract.kind) && unit.contractRefs?.includes(contract.id), "Reuse needs a referenced checked family contract.");
      assert(bindings.every(name => anchored(unit.reuse.bindings?.[name])), "Reuse needs every anchored contextual binding.");
      const source = facts[sourceID(target)];
      if (contract.kind === "body-rule") {
        const matching = source.direct.facts.filter(fact => Array.isArray(expected.functionRangeUtf16) && encode(fact.functionRangeUtf16) === encode(expected.functionRangeUtf16));
        assert(matching.length === 1 && matching[0].id === unit.reuse.factId && matching[0].bodyHash === unit.reuse.bodyHash && matching[0].contract.rule === contract.rule, "Reuse does not match one generated whole-body fact in the frozen unit.");
      } else {
        assert(source.units.find(item => item.targetId === target.id && item.id === unit.id)?.sliceHash === contract.bodyHash, "Reuse body bytes differ from the exact-body contract.");
      }
    }
    for (const check of file.needChecks || []) assert(anchored(check), "Relationship obligation checks need anchored evidence.");
    const unresolved = (file.relationships || []).some(item => item.status !== "observed") || (file.units || []).some(unit => (unit.facts || []).some(fact => fact.status !== "observed"));
    assert(!file.complete || !unresolved, "Unresolved or inferred relationships cannot establish complete coverage.");
  }
}

function validateCompactReview(response, producer) {
  const contracts = producer.contracts || [];
  assert(Array.isArray(response.checkedContractIds) && response.checkedContractIds.every(id => contracts.some(contract => contract.id === id)), "Review needs known checked contract IDs.");
  for (const review of response.files || []) {
    const file = producer.files.find(item => item.targetId === review.targetId);
    const reused = file?.units.filter(unit => unit.reuse).map(unit => unit.id) || [];
    const used = new Set(file?.units.flatMap(unit => unit.contractRefs || []) || []);
    if (review.decision === "complete") {
      assert(sameIDs(reused, review.checkedReuseUnitIds), "Complete review must independently check every reuse member.");
      assert([...used].every(id => response.checkedContractIds.includes(id) || contracts.find(contract => contract.id === id)?.acceptedFrom), "Complete review needs independently checked shared contracts.");
    }
  }
}

export async function submitCompactResponse(directory, response) {
  assert(/^[a-f0-9]{64}$/.test(response.requestId || ""), "Response needs a valid request ID.");
  const config = await compactConfiguration(directory);
  assert(!config.deadlineAt || Date.now() <= Date.parse(config.deadlineAt), "The frozen submission deadline has passed.");
  const request = await readJSON(path.join(directory, "requests", `${response.requestId}.json`));
  const bundleText = await readFile(path.join(directory, request.bundle), "utf8");
  assert(hash(bundleText) === request.bundleHash, "The frozen source bundle changed.");
  const bundle = JSON.parse(bundleText), facts = compactSourceFacts(bundle);
  let translated;
  if (request.stage === "review") {
    const producer = await readJSON(path.join(directory, "objects", `${request.producerHash}.json`));
    assert(producer.response.compact, "Review requires a compact producer response.");
    validateCompactReview(response, producer.response.compact);
    translated = response;
  } else {
    const resolved = await resolveContractReferences(directory, response);
    validateCompactProducer(resolved, bundle, facts);
    // The older transport requires these fields. This tag makes no source claim.
    const tag = { compactTransportOnly: true, claim: null };
    translated = { ...resolved, compact: resolved, originalCompact: response, files: resolved.files.map(file => ({ ...file, units: file.units.map(unit => ({ ...unit,
      reads: tag, writes: tag, branches: tag, result: tag, errors: tag, async: tag, ownership: tag })) })) };
  }
  await submitGroupedResponse(directory, translated);
  const completedAt = new Date().toISOString();
  const receiptFile = path.join(directory, "compact-receipts", `${request.id}.json`);
  if (!await optionalJSON(receiptFile)) await immutable(receiptFile, { requestId: request.id, completedAt });
  const status = await compactIngestionStatus(directory);
  if (config.deadlineAt && Date.parse(completedAt) > Date.parse(config.deadlineAt)) status.deadlineViolations.push({ groupId: request.groupId, requestId: request.id, completedAt });
  return status;
}

function linkFor(anchor, manifest) {
  const repository = manifest.repositories.find(item => item.id === anchor.repository);
  const base = repository.sourceURL || (anchor.repository === "thunderbird" ? "https://github.com/mozilla/releases-comm-central" : "https://github.com/mozilla-firefox/firefox");
  return `${base}/blob/${anchor.revision}/${anchor.path}#L${anchor.start}-L${anchor.end}`;
}
const anchorKey = anchor => `${anchor.sourceId || sourceID(anchor)}:${anchor.start}:${anchor.end}`;
function collectAnchors(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Number.isInteger(value.start) && Number.isInteger(value.end) && (value.sourceId || value.repository)) output.push(value);
  else for (const item of Object.values(value)) collectAnchors(item, output);
  return output;
}
function metadataNote(metadata, title, body) { return `<!-- knowledge: ${JSON.stringify(metadata)} -->\n# ${title}\n\n${body}\n`; }

export async function exportCompactIngestion(directory) {
  const manifest = await readJSON(path.join(directory, "manifest.json")), status = await compactIngestionStatus(directory);
  const failed = new Set(manifest.preparation.failures.map(item => item.target.id));
  const records = [], evidence = new Map(), contracts = new Map(), blockedGroups = new Set(status.deadlineViolations.map(item => item.groupId));
  const destination = path.join(directory, "compact-exports");
  for (const group of status.groups.filter(item => item.state === "reviewed")) {
    const producer = await readJSON(path.join(directory, "objects", `${group.producerHash}.json`));
    const reviewObject = await readJSON(path.join(directory, "objects", `${group.reviewHash}.json`));
    for (const object of [producer, reviewObject]) {
      const receipt = await readJSON(path.join(directory, "compact-receipts", `${object.response.requestId}.json`));
      if (status.deadlineAt && Date.parse(receipt.completedAt) > Date.parse(status.deadlineAt)) blockedGroups.add(group.groupId);
    }
    if (blockedGroups.has(group.groupId)) continue;
    const compact = producer.response.compact;
    if (!compact) continue;
    const bundleText = await readFile(path.join(directory, "bundles", `${group.groupId}.json`), "utf8");
    assert(hash(bundleText) === manifest.bundleHashes[group.groupId], "The frozen source bundle changed.");
    const generated = compactSourceFacts(JSON.parse(bundleText));
    const anchors = new Map(producer.anchors.map(anchor => [anchorKey(anchor), anchor]));
    const evidenceLinks = value => [...new Set(collectAnchors(value).map(anchor => {
      const resolved = anchors.get(anchorKey(anchor));
      assert(resolved, "Export evidence must resolve to a checked source anchor.");
      const identity = encode([manifest.configurationHash, manifest.startedAt, resolved.repository, resolved.revision, resolved.path, resolved.start, resolved.end, resolved.quote]);
      const file = `${uuid(identity)}.md`;
      if (!evidence.has(file)) evidence.set(file, { file, repository: resolved.repository, path: resolved.path, markdown: metadataNote({ repository: resolved.repository, at: manifest.startedAt, paths: [resolved.path], source: { reference: linkFor(resolved, manifest), status: "provisional", evidenceOnly: true } }, `${resolved.path}:${resolved.start}-${resolved.end}: source evidence`, `Exact source at ${resolved.revision}. This excerpt does not establish a behavioral interpretation or test result.\n\n[Original source](${linkFor(resolved, manifest)})\n\n~~~\n${resolved.quote}\n~~~`) });
      return `[${resolved.path}:${resolved.start}-${resolved.end}](${file})`;
    }))].join("; ");
    for (const file of compact.files) {
      const review = group.files.find(item => item.targetId === file.targetId);
      if (review.decision === "rejected" || failed.has(file.targetId)) continue;
      const target = manifest.groups.find(item => item.id === group.groupId).targets.find(item => item.id === file.targetId);
      const usedContracts = (compact.contracts || []).filter(contract => file.units.some(unit => unit.contractRefs?.includes(contract.id)));
      const contractFiles = new Map();
      for (const contract of usedContracts) {
        const name = contract.acceptedFrom?.noteFile || `${uuid(encode([contract, group.producerHash, group.reviewHash]))}.md`;
        contractFiles.set(contract.id, name);
        if (contract.acceptedFrom) continue;
        contracts.set(name, { file: name, markdown: metadataNote({ repository: target.repository, at: compact.finishedAt, paths: [], source: { status: "provisional", producerHash: group.producerHash, reviewHash: group.reviewHash, contractId: contract.id } }, `${contract.id}: shared behavior contract`, `${contract.explanation}\n\nKind: ${contract.kind}. Rule: ${contract.rule || "none"}.\n\nEvidence: ${evidenceLinks(contract)}\n\nThis contract applies only to independently checked member bindings. It does not establish arbitrary same-name or similar-body equivalence.`) });
      }
      const meta = { repository: target.repository, at: compact.finishedAt, paths: [target.path], source: { reference: linkFor({ ...target, revision: manifest.repositories.find(item => item.id === target.repository).revision, start: 1, end: 1 }, manifest), status: "provisional", coverage: review.decision, producerHash: group.producerHash, reviewHash: group.reviewHash, pairedRevisions: Object.fromEntries(manifest.repositories.map(item => [item.id, item.revision])), priorEvidence: target.priorEvidence || null, reusedContracts: usedContracts.filter(contract => contract.acceptedFrom).map(contract => contract.acceptedFrom), reusedRecordIds: file.reusedRecordIds || [], corrections: file.corrections || [] } };
      let body = `Coverage: ${review.decision}. Product tests were not run.\n\nSource context: ${JSON.stringify({ language: file.language || target.language || "unknown", runtime: file.runtime || target.runtime || "unknown", role: file.fileRole || target.primaryRole || target.role || "unknown", component: file.component || target.component || "unknown" })}\n\n`;
      for (const unit of file.units) {
        const expected = target.expectedUnits.find(item => item.id === unit.id);
        body += `## ${expected.symbol || unit.id} (${unit.id})\n\n${unit.explanation}\n\n`;
        for (const fact of unit.facts || []) body += `- ${fact.status}: ${fact.claim}\n`;
        if (unit.reuse) {
          body += `\nReuse: ${JSON.stringify(unit.reuse)}\n`;
          const fact = generated[sourceID(target)]?.direct.facts.find(item => item.id === unit.reuse.factId);
          if (fact) body += `\nGenerated local body fact: ${JSON.stringify({ rule: fact.contract.rule, bodyHash: fact.bodyHash, contract: fact.contract })}\n`;
        }
        if (unit.contractRefs?.length) body += `\nContracts: ${unit.contractRefs.map(id => `[${id}](${contractFiles.get(id)})`).join("; ")}\n`;
        body += `\nEvidence: ${evidenceLinks(unit)}\n\n`;
      }
      body += `## Relationships and tests\n\n${JSON.stringify({ needChecks: file.needChecks, relationships: file.relationships || [], tests: file.tests || [] }, null, 2)}\n\nEvidence: ${evidenceLinks([file.needChecks, file.relationships, file.tests])}\n\n## Limits\n\n${review.gaps.length ? review.gaps.map(gap => `- ${gap}`).join("\n") : "No required gap was reported within the frozen target scope. Full transitive repository coverage is not implied."}\n`;
      const name = `${uuid(encode([target.id, group.producerHash, group.reviewHash]))}.md`;
      const markdown = metadataNote(meta, `${target.path}: compact behavior record`, body);
      await immutable(path.join(destination, name), markdown);
      records.push({ targetId: target.id, decision: review.decision, file: name, hash: hash(markdown), producerHash: group.producerHash, reviewHash: group.reviewHash });
    }
  }
  for (const item of [...evidence.values(), ...contracts.values()]) await immutable(path.join(destination, item.file), item.markdown);
  const result = { version: 1, state: "drafts-not-published", records, evidence: [...evidence.keys()], contracts: [...contracts.keys()], blockedGroups: [...blockedGroups], preparationFailures: status.preparationFailures, pendingGroups: status.groups.filter(group => group.state !== "reviewed").map(group => group.groupId) };
  await immutable(path.join(destination, `${hash(encode(result))}.manifest.json`), result);
  return result;
}

export async function runCompactCLI(argv) {
  const { values } = parseArgs({ args: argv, options: { init: { type: "string" }, directory: { type: "string" }, submit: { type: "string" }, export: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) return { usage: "node commands/knowledge/ingestion-compact.mjs --init config.json OR --directory queue [--submit response.json | --export]" };
  if (values.init) return initializeCompactIngestion(await readJSON(values.init));
  assert(values.directory, "Supply --init or --directory.");
  if (values.submit) return submitCompactResponse(values.directory, await readJSON(values.submit));
  if (values.export) return exportCompactIngestion(values.directory);
  return compactIngestionStatus(values.directory);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCompactCLI(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error.message); process.exitCode = 1; });
