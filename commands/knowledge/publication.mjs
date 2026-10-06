import path from "node:path";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { canonical, digest } from "./store.mjs";
import { claimKey } from "./claims.mjs";

// Keep project knowledge portable. Raw transcripts and private quotes stay local.
export function portableText(text) {
  return String(text).replace(/\/Users\/[^\s/\\"'`<>]+\/projects\/fox(?:-review)?\/comm\//g, "")
    .replace(/\/Users\/[^\s/\\"'`<>]+\/projects\/commands\//g, "")
    .replace(/\/Users\/[^\s/\\"'`<>]+\/\.tb-tools\//g, "~/.tb-tools/")
    .replace(/\/Users\/[^\s/\\"'`<>]+\/\.codex\//g, "~/.codex/")
    .replace(/\/Users\/[^\s\\"'`<>]+/g, "[local path]");
}

function safeProjectClaim(record) {
  const text = portableText(record.text);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})|https?:\/\/[^\s/]+:[^\s/]+@/i.test(text)) {
    throw new Error(`Lesson ${record.id} contains a possible credential; publication stopped.`);
  }
  return text;
}

export async function publishProjectLessons(store, { shareRepositories = [] } = {}) {
  const counts = { published: 0, alreadyPublished: 0 };
  const all = store.all(), existing = new Map(all.filter(r => r.kind === "lesson" && r.visibility === "shared").map(r => [claimKey(r), r]));
  for (const lesson of all.filter(r => r.kind === "lesson" && r.visibility === "private" && shareRepositories.includes(r.repository))) {
    const key = claimKey(lesson);
    // The earlier backfill already recorded these original IDs. Keep its citations.
    const oldKey = digest([lesson.repository, lesson.title, lesson.text, lesson.component, lesson.paths]);
    if (existing.has(key) || store.setting(`shared-lesson-publication:${oldKey}`) || store.setting(`published-claim:${key}`)) {
      counts.alreadyPublished++; continue;
    }
    const text = safeProjectClaim(lesson);
    const sources = lesson.evidence.map(id => store.get(id));
    if (sources.some(source => !source || source.repository !== lesson.repository)) throw new Error(`Missing lesson evidence: ${lesson.id}`);
    const references = [...new Set(sources.flatMap(source => [source.source.url, source.source.reference])
      .filter(ref => typeof ref === "string" && /^https?:\/\//.test(ref) && !/https?:\/\/[^\s/]+:[^\s/]+@/.test(ref)))];
    const evidence = await store.put({ kind: "evidence", visibility: "shared", repository: lesson.repository,
      at: lesson.at, title: portableText(lesson.title), paths: lesson.paths, text,
      source: { type: "lesson-publication", reference: `knowledge-record:${lesson.id}`,
        originalLessons: [lesson.id], privateEvidence: lesson.evidence, sourceReferences: references,
        revision: lesson.source.revision || "", sourceAt: lesson.source.sourceAt || lesson.at,
        verification: "Recorded interpretation. Original private evidence is unavailable to other consumers; this summary is not independent verification." } });
    const published = await store.put({ kind: "lesson", visibility: "shared", repository: lesson.repository,
      at: lesson.at, title: portableText(lesson.title), text, component: lesson.component, paths: lesson.paths,
      evidence: [evidence.id], quotes: [{ id: evidence.id, text }], status: "provisional", supersedes: [],
      source: { type: "extraction", revision: lesson.source.revision || "", sourceAt: lesson.source.sourceAt || lesson.at,
        originalLessons: [lesson.id], basis: evidence.source.verification } });
    store.setting(`published-claim:${key}`, published.id); existing.set(key, published); counts.published++;
  }
  store.setting("lastPublication", { ...counts, at: new Date().toISOString() });
  return counts;
}

export async function exportLessonNotes(store, root) {
  await mkdir(path.join(root, "notes"), { recursive: true });
  const all = store.all(), linked = new Set(all.filter(r => r.source.type === "shared-note")
    .flatMap(r => [r.source.recordId, r.text.match(/\.\.\/records\/([a-f0-9]{64})\.json/)?.[1]]).filter(Boolean));
  let written = 0;
  for (const record of all.filter(r => r.kind === "lesson" && r.visibility === "shared")) {
    if (linked.has(record.id)) continue;
    const file = path.join(root, "notes", `${record.id}.md`);
    const metadata = { repository: record.repository, at: record.at, paths: record.paths,
      source: { reference: `knowledge-record:${record.id}`, recordId: record.id, status: record.status, publicationKey: claimKey(record) } };
    const body = `<!-- knowledge: ${JSON.stringify(metadata)} -->\n# ${record.title}\n\n${record.text}\n\nScope: ${record.component || "general"}.\n\n## Evidence\n\n[Lesson record](../records/${record.id}.json).\n\n` +
      record.evidence.map(id => `- [Supporting record](../records/${id}.json)`).join("\n") +
      `\n\n## Validation and limits\n\nStatus: **${record.status}**. ${record.source.basis || "Check the cited evidence and current source before use."}\n`;
    try { await writeFile(file, body, { flag: "wx", mode: 0o600 }); written++; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await lstat(file)).isFile()) throw new Error(`Knowledge notes must be regular files: ${file}`);
      if (await readFile(file, "utf8") !== body) throw new Error(`Knowledge note collision: ${file}`);
    }
  }
  return written;
}

// Append corrected copies. Existing content-addressed files remain unchanged.
export async function repairPortableRecords(store) {
  const copies = new Map(), records = store.all().filter(r => r.visibility === "shared");
  let corrected = 0;
  for (const record of records.sort((a, b) => (a.kind === "lesson") - (b.kind === "lesson"))) {
    if (!canonical(record).includes("/Users/")) continue;
    const key = `portable-record:${record.id}`;
    if (store.setting(key)) { copies.set(record.id, store.setting(key)); continue; }
    const sanitize = value => {
      if (typeof value === "string") return portableText(value);
      if (Array.isArray(value)) return value.map(sanitize);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
    };
    const body = sanitize(record);
    delete body.id;
    if (["ci-signature", "ci-push-summary"].includes(body.source.type)) {
      const data = sanitize(JSON.parse(record.text));
      delete data.fullMatchesFile; delete data.fullEvidenceFile;
      const strip = value => {
        if (Array.isArray(value)) return value.map(strip);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).filter(([name]) => !/^(?:evidenceFile|logFile|matchesFile)$/.test(name)).map(([name, child]) => [name, strip(child)]));
      };
      body.text = JSON.stringify({ ...strip(data), evidenceAvailability: "Full cached logs remain on the capturing computer. Use the retained push and job URLs to obtain remote evidence." });
    }
    if (body.kind === "lesson") {
      body.evidence = body.evidence.map(id => copies.get(id) || id);
      body.quotes = body.quotes?.map(quote => ({ ...quote, id: copies.get(quote.id) || quote.id,
        text: portableText(quote.text) }));
    }
    body.source = { ...body.source, portableCopies: [record.id], sourceAt: record.source.sourceAt || record.at };
    const copy = await store.put(body);
    store.setting(key, copy.id); copies.set(record.id, copy.id); corrected++;
  }
  return { corrected };
}
