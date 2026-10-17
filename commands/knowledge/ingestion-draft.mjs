import { canonical, digest, validateRecord } from "./store.mjs";
import { acceptLessons } from "./learning.mjs";
import { IngestionInputError } from "./ingestion-queue.mjs";
import { INGESTION_ACCESS_GAP_STATUS, validateIngestionAccessGap } from "./ingestion-access-gap.mjs";

const recordId = /^[a-f0-9]{64}$/;
// These are the history exporter's explicit input formats. The exporter still
// checks each format's metadata and exact Git or experiment evidence.
export const HISTORY_PUBLIC_SOURCE_TYPES = Object.freeze([
  "git-commit", "git-diff", "git-show", "git-history", "grouped-git-chain", "history-commit-diff", "git-chain-context",
  "code-snapshot", "git-mail-fixture-inspection", "git-text-fixture-inspection", "git-binary-fixture-inspection",
  "git-binary-fixture", "git-fixture-metadata", "git-byte-comparison", "git-file-byte-comparison", "git-chain-comparison",
  "bounded-git-symbol-check", "git-source-query", "git-static-preference-label-inspection", "git-string-history-inspection",
  "git-name-status-inspection", "git-path-presence-inspection", "git-path-absence-inspection", "git-decoded-utf16-fixture",
  "local-language-experiment", "historical-code-diffs",
]);
const proposedLesson = lesson => lesson.status === "provisional" ||
  /^propos(?:al|ed)/i.test(lesson.classification || "") || /^propos(?:al|ed)\b/i.test(lesson.text);
const reject = message => { throw new IngestionInputError(message); };

function indicesOf(values) {
  if (!Array.isArray(values) || !values.length || values.some(index => !Number.isSafeInteger(index) || index < 1) ||
      new Set(values).size !== values.length) reject("Invalid ingestion draft indices.");
  return [...values].sort((a, b) => a - b);
}

/**
 * Checks saved draft structure and citations without writing records.
 * The caller supplies exact record lookups and a reviewed public source-type list.
 * This check does not verify Git bytes, source meaning or remote publication.
 */
export async function validateIngestionDrafts(drafts, { getRecord, expectedIndices,
  publicSourceTypes = ["git-diff", "code-snapshot"] } = {}) {
  if (typeof getRecord !== "function" || !Array.isArray(publicSourceTypes) || !publicSourceTypes.length ||
      publicSourceTypes.some(type => typeof type !== "string" || !type || type.includes("*"))) {
    throw new Error("Invalid ingestion draft validator options.");
  }
  if (!Array.isArray(drafts) || !drafts.length) reject("Ingestion drafts are missing.");

  const types = new Set(publicSourceTypes), locals = new Map(), records = new Map(), selected = new Set();
  const publicProof = record => record.kind === "evidence" && record.source.public === true &&
    record.source.verified === true && !record.source.personal && types.has(record.source.type);

  for (const draft of drafts) {
    if (!draft || !Number.isFinite(Date.parse(draft.at)) || !Array.isArray(draft.records) ||
        !Array.isArray(draft.lessons) || !Array.isArray(draft.coverage)) reject("Invalid ingestion draft.");
    for (const input of draft.records) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          typeof input.localKey !== "string" || !input.localKey.trim()) reject("Local evidence key is missing.");
      const { localKey, id: suppliedId, ...inputBody } = input;
      const body = { version: 1, visibility: "private", paths: [], ...inputBody };
      const record = { ...body, id: digest(body) }, alias = `local:${localKey}`;
      if (suppliedId !== undefined && suppliedId !== record.id) reject("Local evidence ID does not match its body.");
      try { validateRecord(record); } catch { reject("Invalid local evidence record."); }
      if (locals.has(alias) && locals.get(alias).id !== record.id) reject("Conflicting local evidence key.");
      locals.set(alias, record);
      records.set(record.id, record);
      selected.add(record.id);
    }
  }

  // Missing or corrupt durable records remain storage failures. Do not label
  // them as a draft correction or hide an error from the supplied lookup.
  const read = reference => {
    if (typeof reference !== "string") reject("Invalid evidence reference.");
    if (reference.startsWith("local:")) {
      if (!locals.has(reference)) reject("Unresolved local evidence reference.");
      return locals.get(reference);
    }
    if (!recordId.test(reference)) reject("Invalid evidence reference.");
    if (!records.has(reference)) {
      const record = getRecord(reference);
      if (!record) throw new Error(`Missing knowledge record: ${reference}`);
      validateRecord(record);
      if (record.id !== reference) throw new Error("Knowledge lookup returned a different record.");
      records.set(reference, record);
    }
    return records.get(reference);
  };
  const referenceFields = new Set(["id", "recordId", "recordIds", "evidence", "sourceEvidence", "supersedes"]);
  const remap = (value, field) => typeof value === "string" && referenceFields.has(field) && locals.has(value) ? locals.get(value).id :
    Array.isArray(value) ? value.map(item => remap(item, field)) : value && typeof value === "object" ?
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, key)])) : value;

  for (const draft of drafts) {
    if (!Array.isArray(draft.existingEvidence || [])) reject("Invalid selected evidence list.");
    for (const reference of draft.existingEvidence || []) selected.add(read(reference).id);
  }
  const allIndices = [], lessons = [];
  for (const draft of drafts) {
    const indices = indicesOf(draft.coverage.map(row => row?.index));
    if (draft.selectedIndices !== undefined) {
      if (canonical(indicesOf(draft.selectedIndices)) !== canonical(indices)) reject("Selected indices differ from coverage.");
    } else if (indices.some((index, offset) => offset && index !== indices[offset - 1] + 1)) {
      reject("Sparse coverage needs explicit selected indices.");
    }
    if (draft.range && (draft.range.start !== indices[0] || draft.range.end !== indices.at(-1))) {
      reject("Draft range differs from selected coverage.");
    }
    allIndices.push(...indices);

    for (const original of draft.coverage) {
      for (const id of original.sourceEvidence || []) if (id.startsWith("local:")) read(id);
      for (const check of original.currentChecks || []) {
        for (const id of [check.id, check.recordId, check.evidence]) {
          if (typeof id === "string" && id.startsWith("local:")) read(id);
        }
      }
      const row = remap(original);
      if (!["examined", "examined-with-complete-retained-context", "excluded", INGESTION_ACCESS_GAP_STATUS].includes(row.status)) {
        reject("Incomplete ingestion draft row.");
      }
      if (row.status === "excluded") {
        if (typeof row.reason !== "string" || !row.reason.trim()) reject("Exclusion reason is missing.");
        continue;
      }
      for (const context of [...(row.bugs || []), ...(row.reviews || [])]) {
        if (!context.status || /pending|unread|loading|not-read/i.test(context.status)) reject("Unread assigned discussion.");
        if (context.status === "access-denied" && row.status !== INGESTION_ACCESS_GAP_STATUS) reject("Access gap status is missing.");
        for (const id of context.evidence || []) if (id.startsWith("local:")) read(id);
      }
      if (row.status === INGESTION_ACCESS_GAP_STATUS) {
        for (const context of [...(row.bugs || []), ...(row.reviews || [])]) {
          for (const id of context.evidence || []) read(id);
        }
        try { validateIngestionAccessGap(row, id => records.get(id)); }
        catch { reject("Invalid ingestion access gap proof."); }
      }
    }

    for (const input of draft.lessons) {
      if (!input || !Array.isArray(input.evidence) || !Array.isArray(input.quotes)) reject("Invalid lesson evidence.");
      const lesson = remap(input);
      for (const id of lesson.evidence) {
        if (typeof id === "string" && id.startsWith("local:")) read(id);
        if (!selected.has(id) || !publicProof(read(id))) reject("Lesson includes unselected or nonpublic evidence.");
      }
      for (const quote of lesson.quotes) {
        if (!quote || typeof quote.id !== "string") reject("Invalid lesson quote reference.");
        if (quote.id.startsWith("local:")) read(quote.id);
      }
      for (const id of lesson.supersedes || []) read(id);
      lessons.push(lesson);
    }
    if (!Array.isArray(draft.reusedClaims || [])) reject("Invalid reused claim list.");
    for (const input of draft.reusedClaims || []) {
      const reuse = remap(input), record = read(reuse.id);
      if (record.kind !== "lesson" || record.visibility !== "shared") reject("Reused claim is not a shared lesson.");
      if (!Array.isArray(reuse.evidence || [])) reject("Invalid reused claim evidence.");
      for (const id of reuse.evidence || []) {
        const source = read(id);
        if (!selected.has(source.id)) reject("Reused claim includes unselected comparison evidence.");
      }
      if (!Array.isArray(reuse.quotes || [])) reject("Invalid reused claim quotes.");
      for (const quote of reuse.quotes || []) {
        if (!quote || typeof quote.text !== "string" || quote.text.length < 12) reject("Invalid reused claim quote.");
        const source = read(quote.id);
        if (!source.text.includes(quote.text)) reject("Invalid reused claim quote.");
      }
    }
  }

  const selectedIndices = indicesOf(allIndices);
  if (expectedIndices !== undefined && canonical(indicesOf(expectedIndices)) !== canonical(selectedIndices)) {
    reject("Frozen assignment differs from draft coverage.");
  }
  if (expectedIndices === undefined && selectedIndices.some((index, offset) => offset && index !== selectedIndices[offset - 1] + 1) &&
      drafts.some(draft => draft.selectedIndices === undefined)) reject("Disjoint coverage needs explicit selected indices.");

  // Use the actual learner's schema and support decision. Its writes go only
  // to this local sink; no caller store or generated note is changed.
  const predicted = [];
  const sink = { get: id => records.get(id), setting: () => undefined,
    put: async record => { predicted.push(record); return { id: "0".repeat(64) }; } };
  for (let offset = 0; offset < lessons.length; offset += 8) {
    try { await acceptLessons(sink, [...records.values()], { lessons: lessons.slice(offset, offset + 8) }); }
    catch { reject("Lesson has invalid or unsupported evidence."); }
  }
  for (let index = 0; index < lessons.length; index++) {
    if (proposedLesson(lessons[index]) && predicted[index].status === "supported") reject("Proposal would become supported.");
  }
  return { selectedIndices, localRecordIds: Object.fromEntries([...locals].map(([key, value]) => [key, value.id])),
    lessonStatuses: predicted.map(({ title, status }) => ({ title, status })) };
}
