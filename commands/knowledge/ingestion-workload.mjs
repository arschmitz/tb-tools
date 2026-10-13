import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { readGitBlobs } from "./git-data.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
const blobHash = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const manifests = ["moz.build", "jar.mn", "browser.toml", "xpcshell.toml", "mochitest.toml", "chrome.toml", "Cargo.toml", "manifest.json", "package.json"];
const maximumBytes = 4_000_000;
const identity = item => `${item.repository}:${item.path}`;
const git = async (directory, args) => (await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
  cwd: directory, timeout: 30_000, maxBuffer: 8_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})).stdout;

function validPath(value) {
  return typeof value === "string" && value.length > 0 && !path.posix.isAbsolute(value) &&
    !value.includes("\\") && !Array.from(value).some(character => character.charCodeAt(0) < 32) && !value.split("/").some(part => !part || part === "." || part === "..");
}
function excluded(item) {
  return item.scope === "excluded-suite" || (item.repository === "thunderbird" && /^suite(?:\/|$)/.test(item.path));
}
function validateTarget(item) {
  if (!validPath(item.path) || !item.repository) throw new Error("Invalid repository-relative target path.");
  if (excluded(item)) throw new Error("Thunderbird Suite is excluded.");
  if (item.oid && !/^[a-f0-9]{40}$/.test(item.oid)) throw new Error("Invalid expected blob ID.");
}
export async function* readWorkloadRows(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line++;
    if (!text.trim()) continue;
    try { yield JSON.parse(text); }
    catch (error) { throw new Error(`Invalid workload JSON at line ${line}: ${error.message}`); }
  }
}

// Size bands support sampling. They do not estimate behavioral complexity.
export function workloadStratum(row) {
  const band = row.sizeBand || (row.bytes <= 4096 ? "up-to-4KiB" : row.bytes <= 32768 ? "4-to-32KiB" : row.bytes <= 262144 ? "32-to-256KiB" : "over-256KiB");
  return [row.repository, row.language || "unknown", row.primaryRole || row.role || "unknown", band].join("|");
}
export async function sampleWorkload(ledger, { seed = "ingestion-v1", perStratum = 1 } = {}) {
  if (!Number.isSafeInteger(perStratum) || perStratum < 1 || perStratum > 100) throw new Error("perStratum must be from 1 to 100.");
  const groups = new Map(), dispositions = {};
  let total = 0, excludedCount = 0;
  for await (const row of readWorkloadRows(ledger)) {
    total++;
    const disposition = row.disposition || "unknown";
    dispositions[disposition] = (dispositions[disposition] || 0) + 1;
    if (excluded(row)) { excludedCount++; continue; }
    const stratum = workloadStratum(row), rank = hash(JSON.stringify([seed, row.repository, row.revision, row.path]));
    const group = groups.get(stratum) || { population: 0, selected: [] };
    group.population++;
    group.selected.push({ ...row, stratum, sampleRank: rank });
    group.selected.sort((a, b) => a.sampleRank.localeCompare(b.sampleRank) || identity(a).localeCompare(identity(b)));
    group.selected.length = Math.min(perStratum, group.selected.length);
    groups.set(stratum, group);
  }
  const strata = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([stratum, group]) => ({ stratum, ...group }));
  return { version: 1, seed, perStratum, total, excluded: excludedCount, dispositions, strata,
    targets: strata.flatMap(group => group.selected), limits: ["Non-text, oversized and failed-parser rows remain in their sample populations.", "Sample selection does not establish behavior coverage or variance within a stratum."] };
}

async function resolvedDestination(value) {
  const absolute = path.resolve(value);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(await resolvedDestination(path.dirname(absolute)), path.basename(absolute));
  }
}
async function outsideRepositories(destination, roots) {
  const resolved = await resolvedDestination(destination);
  for (const root of roots) {
    const owner = await realpath(root);
    if (resolved === owner || resolved.startsWith(owner + path.sep)) throw new Error("Packet outputs and caches must stay outside source and knowledge checkouts.");
  }
  return resolved;
}
function contextPaths(file) {
  const paths = new Set();
  let directory = path.posix.dirname(file);
  for (let level = 0; level < 4; level++) {
    for (const name of manifests) paths.add(path.posix.join(directory, name));
    if (directory === ".") break;
    directory = path.posix.dirname(directory);
  }
  const extension = path.posix.extname(file), stem = file.slice(0, file.length - extension.length);
  for (const next of [".h", ".cpp", ".cc", ".js", ".mjs", ".xhtml", ".css", ".ftl"]) paths.add(stem + next);
  paths.delete(file);
  return [...paths].filter(validPath);
}
function sourceRange(source, start = 1, end = source.split("\n").length) {
  const lines = source.split("\n");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw new Error("Invalid complete source line range.");
  const text = lines.slice(start - 1, end).join("\n");
  return { start, end, text, sourceHash: hash(text) };
}
function literalSites(source, limit) {
  const found = [];
  const pattern = /(?:\b(?:import|export|require|include|use|mod)\b|addEventListener|removeEventListener|addObserver|removeObserver|notifyObservers|dispatchEvent|sendAsyncMessage|addMessageListener|Services\.prefs|data-l10n-id|\[\[|TEST|SOURCES|FINAL_TARGET|\.ftl|\.css)/;
  for (const [offset, text] of source.split("\n").entries()) {
    if (pattern.test(text)) found.push({ start: offset + 1, end: offset + 1, quote: text, status: "unverified-literal-site" });
  }
  return { items: found.slice(0, limit), total: found.length, omitted: Math.max(0, found.length - limit),
    coverage: "Line patterns can miss multiline, dynamic and language-specific relationships. A hit does not establish a target or caller." };
}
async function nearbyMatches(repository, target, limit) {
  const terms = [...new Set([target.symbol, path.posix.basename(target.path)].filter(value => typeof value === "string" && value.length >= 3 && !/[\r\n\0]/.test(value)))];
  const scopes = target.searchScopes || [path.posix.dirname(target.path)];
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => scope !== "." && !validPath(scope))) throw new Error("Invalid literal-search scopes.");
  if (!terms.length) return { terms, scopes, items: [], omitted: 0 };
  let text;
  try {
    text = await git(repository.directory, ["grep", "-n", "-I", "-F", ...terms.flatMap(term => ["-e", term]), repository.revision, "--", ...scopes.map(scope => `:(literal)${scope}`), ...(repository.id === "thunderbird" ? [":(exclude)suite/**"] : [])]);
  } catch (error) {
    if (error.code === 1) text = "";
    else return { terms, scopes, status: "search-failed", error: error.message, items: [], omitted: null };
  }
  const items = text.split("\n").filter(Boolean).map(line => {
    const match = line.match(/^[a-f0-9]{40}:(.+?):(\d+):(.*)$/);
    return match ? { repository: repository.id, revision: repository.revision, path: match[1], start: Number(match[2]), end: Number(match[2]), quote: match[3], status: "unverified-spelling-match" } : { unparsed: line, status: "unresolved-search-output" };
  }).filter(item => !item.path || !(repository.id === "thunderbird" && /^suite\//.test(item.path)));
  return { terms, scopes, status: "searched", items: items.slice(0, limit), total: items.length, omitted: Math.max(0, items.length - limit),
    coverage: "Only the listed scopes and literal spellings were searched. A matching name does not identify the receiver, caller, test assertion or runtime use." };
}
function evidenceReuse(evidence, target, repository, text) {
  return evidence.filter(item => item.repository === target.repository && item.path === target.path).map(item => {
    const copy = { ...item, reuseStatus: "unverified-prior-reference" };
    if (item.revision !== repository.revision) return { ...copy, reuseStatus: "different-revision-needs-review" };
    if (!item.sourceHash) return copy;
    try {
      const actual = sourceRange(text, item.start, item.end);
      return { ...copy, reuseStatus: actual.sourceHash === item.sourceHash ? "source-matched-prior-claim" : "source-hash-mismatch", actualSourceHash: actual.sourceHash,
        limit: "Source matching does not independently validate the prior interpretation or extend its coverage." };
    } catch (error) { return { ...copy, reuseStatus: "invalid-prior-anchor", error: error.message }; }
  });
}

export async function prepareWorkloadPackets(configuration) {
  const startedAt = new Date().toISOString(), started = performance.now();
  if (configuration.version !== 1 || !Array.isArray(configuration.repositories) || !configuration.repositories.length || !configuration.output || !configuration.cache) throw new Error("Supply version 1, repositories, output and cache.");
  const repositories = new Map();
  for (const repository of configuration.repositories) {
    if (!repository.id || repositories.has(repository.id) || !/^[a-f0-9]{40}$/.test(repository.revision)) throw new Error("Use unique repository IDs and full commit revisions.");
    const resolved = (await git(repository.directory, ["rev-parse", "--verify", `${repository.revision}^{commit}`])).trim();
    if (resolved !== repository.revision) throw new Error("Repository revision does not identify that commit.");
    repositories.set(repository.id, repository);
  }
  const roots = [...repositories.values()].map(repository => repository.directory);
  if (configuration.knowledgeDirectory) roots.push(configuration.knowledgeDirectory);
  const output = await outsideRepositories(configuration.output, roots), cache = await outsideRepositories(configuration.cache, roots);
  const limit = configuration.maxLeads ?? 80;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("maxLeads must be from 1 to 1000.");
  const selection = configuration.targets ? null : await sampleWorkload(configuration.ledger, configuration);
  const targets = configuration.targets || selection.targets;
  if (!Array.isArray(targets) || !targets.length || targets.length > 1000) throw new Error("Prepare from 1 to 1000 bounded targets.");
  await mkdir(output, { recursive: true }); await mkdir(cache, { recursive: true });
  const packets = [], failures = [], sources = new Map(), sourceErrors = new Map();
  const metrics = { cacheHits: 0, blobReads: 0, sourceBytes: 0, sourceFiles: 0 };
  const pathsByRepository = new Map();
  for (const target of targets) {
    try {
      validateTarget(target);
      if (!repositories.has(target.repository)) throw new Error("Unknown target repository.");
      const selected = pathsByRepository.get(target.repository) || new Set();
      for (const file of [target.path, ...contextPaths(target.path)]) selected.add(file);
      pathsByRepository.set(target.repository, selected);
    } catch (error) { failures.push({ target, stage: "target-validation", error: error.message }); }
  }
  for (const [id, files] of pathsByRepository) {
    const repository = repositories.get(id);
    const tree = await git(repository.directory, ["ls-tree", "-r", "-l", "-z", repository.revision, "--", ...[...files].map(file => `:(literal)${file}`)]);
    const pending = [], queued = new Map();
    for (const row of tree.split("\0").filter(Boolean)) {
      const match = row.match(/^(\d+) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/);
      if (!match) continue;
      const [, mode, oid, size, file] = match, key = `${id}:${file}`;
      const descriptor = { repository: id, revision: repository.revision, path: file, mode, oid, bytes: Number(size) };
      if (!["100644", "100755"].includes(mode) || Number(size) > maximumBytes) {
        sourceErrors.set(key, { ...descriptor, error: mode === "120000" ? "Symlink source is not followed." : "Source exceeds the 4 MB blob reader limit." });
        continue;
      }
      const stored = await readFile(path.join(cache, `${oid}.txt`), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (stored !== null) {
        if (blobHash(stored) !== oid || stored.includes("\0")) { sourceErrors.set(key, { ...descriptor, error: "Cached source failed blob or text validation." }); continue; }
        sources.set(key, { ...descriptor, text: stored, sourceHash: hash(stored) }); metrics.cacheHits++; continue;
      }
      const entry = queued.get(oid);
      if (entry) entry.descriptors.push(descriptor);
      else { const next = { oid, descriptors: [descriptor] }; queued.set(oid, next); pending.push(next); }
    }
    await readGitBlobs(pending, async (entry, text) => {
      if (blobHash(text) !== entry.oid || text.includes("\0")) {
        for (const descriptor of entry.descriptors) sourceErrors.set(identity(descriptor), { ...descriptor, error: "Source is binary or cannot round-trip as UTF-8." });
        return;
      }
      await writeFile(path.join(cache, `${entry.oid}.txt`), text, { flag: "wx" }).catch(async error => {
        if (error.code !== "EEXIST" || await readFile(path.join(cache, `${entry.oid}.txt`), "utf8") !== text) throw error;
      });
      metrics.blobReads++;
      for (const descriptor of entry.descriptors) sources.set(identity(descriptor), { ...descriptor, text, sourceHash: hash(text) });
    }, { cwd: repository.directory });
  }
  for (const target of targets) {
    if (failures.some(item => item.target === target)) continue;
    try {
      const repository = repositories.get(target.repository), source = sources.get(identity(target));
      if (!source) throw new Error(sourceErrors.get(identity(target))?.error || "Target is absent from the pinned tree or is not a regular blob.");
      if (target.revision && target.revision !== repository.revision) throw new Error("Workload revision differs from packet revision.");
      if (target.oid && target.oid !== source.oid) throw new Error("Workload blob differs from the pinned tree.");
      const range = sourceRange(source.text, target.start, target.end), context = [], contextFailures = [];
      for (const file of contextPaths(target.path)) {
        const key = `${target.repository}:${file}`;
        if (sources.has(key)) context.push({ ...sources.get(key), reason: "sibling-or-ancestor-path-lead", status: "unverified-context" });
        if (sourceErrors.has(key)) contextFailures.push(sourceErrors.get(key));
      }
      const packet = { version: 1, id: target.id || hash(JSON.stringify([target.repository, repository.revision, target.path, range.start, range.end])), target,
        repositories: [...repositories.values()].map(({ id, revision }) => ({ id, revision })),
        source, range, context, contextFailures, literalSites: literalSites(source.text, limit),
        nearbyMatches: await nearbyMatches(repository, target, limit), priorEvidence: evidenceReuse(configuration.priorEvidence || [], target, repository, source.text),
        knownPriorCoverage: target.analysis || null, priorEvidenceLookup: configuration.priorEvidence ? "provided-record-set" : "not-looked-up",
        obligations: ["Read and explain the complete target body or file.", "Verify actual receivers, triggers, state, consumers, async completion and ownership.", "Check related implementation and test assertions; nearby names and manifests are search leads.", "Search outside these bounded scopes where the implementation requires it.", "Check source revisions and correction/copy grouping before reusing claims."],
        behavioralCoverage: "not-analyzed", testExecution: "not-run", preparedAt: new Date().toISOString() };
      const file = `${hash(packet.id)}.json`;
      await writeFile(path.join(output, file), JSON.stringify(packet, null, 2) + "\n", { flag: "wx" });
      packets.push({ id: packet.id, file, repository: target.repository, path: target.path, sourceHash: source.sourceHash, rangeHash: range.sourceHash,
        contextFiles: context.length, literalSites: packet.literalSites.total, nearbyMatches: packet.nearbyMatches.total ?? null,
        unresolvedLeadsOmitted: packet.literalSites.omitted + (packet.nearbyMatches.omitted || 0), searchStatus: packet.nearbyMatches.status, priorEvidence: packet.priorEvidence.length });
    } catch (error) { failures.push({ target, stage: "packet-preparation", error: error.message }); }
  }
  metrics.sourceFiles = sources.size;
  metrics.sourceBytes = [...sources.values()].reduce((sum, source) => sum + source.bytes, 0);
  const report = { version: 1, startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started, metrics, selection, packets, failures,
    limits: ["Preparation is not body analysis, relationship closure or a test result.", "Identical source bytes share a cache object; each repository path retains its own context and obligations.", "Caller, test and manifest matches require source review. Search is bounded and may omit relevant links.", "The current Git reader accepts UTF-8 regular files up to 4 MB. All other selected targets retain explicit failures."] };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}

export async function runWorkloadCLI(argv) {
  const { values } = parseArgs({ args: argv, options: { config: { type: "string" }, ledger: { type: "string" }, output: { type: "string" }, seed: { type: "string" }, "per-stratum": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return { usage: "node commands/knowledge/ingestion-workload.mjs --config packet-config.json OR --ledger file-dispositions.jsonl --output sample.json [--seed text --per-stratum 1]" };
  if (values.config) return prepareWorkloadPackets(JSON.parse(await readFile(values.config, "utf8")));
  if (!values.ledger || !values.output) throw new Error("Specify --config or --ledger and --output.");
  const report = await sampleWorkload(values.ledger, { seed: values.seed, perStratum: values["per-stratum"] === undefined ? 1 : Number(values["per-stratum"]) });
  await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkloadCLI(process.argv.slice(2)).then(report => console.log(JSON.stringify({ elapsedMs: report.elapsedMs, packets: report.packets?.length, failures: report.failures?.length, selected: report.targets?.length, usage: report.usage })), error => { console.error(error.message); process.exitCode = 1; });
}
