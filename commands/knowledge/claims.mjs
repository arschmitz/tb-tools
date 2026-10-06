import { digest } from "./store.mjs";

export const normalizedClaim = text => text.trim().replace(/\s+/g, " ").toLowerCase();
export const claimKey = record => digest([record.repository, record.component || "general",
  [...record.paths].sort(), normalizedClaim(record.text)]);

// A copy of a claim is not another independent source for that claim.
export function claimGroups(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  const parents = new Map(records.map(record => [record.id, record.id]));
  const find = id => {
    if (!parents.has(id)) return null;
    if (parents.get(id) !== id) parents.set(id, find(parents.get(id)));
    return parents.get(id);
  };
  const join = (a, b) => {
    if (byId.get(a)?.repository !== byId.get(b)?.repository) return;
    const x = find(a), y = find(b);
    if (x && y && x !== y) parents.set(x, y);
  };
  const claims = new Map();
  for (const record of records) {
    if (record.kind === "lesson") {
      const key = claimKey(record);
      if (claims.has(key)) join(record.id, claims.get(key));
      else claims.set(key, record.id);
      for (const id of record.source.originalLessons || []) join(record.id, id);
      for (const id of record.evidence) {
        if (["lesson-publication", "historical-lesson-summary"].includes(byId.get(id)?.source.type)) join(record.id, id);
      }
    }
    if (record.source.type === "historical-lesson-summary") {
      for (const id of record.source.priorLessons || []) join(record.id, id);
    }
    if (record.source.type === "shared-note") {
      const id = record.source.recordId || record.text.match(/\.\.\/records\/([a-f0-9]{64})\.json/)?.[1];
      if (byId.get(id)?.kind === "lesson") join(record.id, id);
    }
    // Portability corrections preserve the claim and its original source age.
    for (const id of record.source.portableCopies || []) join(record.id, id);
  }
  const groups = new Map();
  for (const record of records) {
    const key = find(record.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const rank = record => (record.kind === "lesson" ? 100 : 0) +
    (record.status === "supported" ? 20 : 0) + (record.visibility === "shared" ? 10 : 0) +
    (record.source.portableCopies?.length ? 5 : 0);
  const representatives = new Map(), aliases = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => rank(b) - rank(a) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (const record of group) representatives.set(record.id, group[0]);
    aliases.set(group[0].id, group.map(record => record.id).filter(id => id !== group[0].id));
  }
  return { representatives, aliases };
}

export function learningSkipReason(record, store) {
  if (["historical-lesson-summary", "lesson-publication", "knowledge-publication-audit"].includes(record.source.type)) return "derived-claim";
  if (record.source.type === "shared-note" && (record.source.publicationKey || record.source.recordId ||
      /\.\.\/records\/[a-f0-9]{64}\.json/.test(record.text))) return "lesson-mirror";
  if (["ci-signature", "ci-push-summary"].includes(record.source.type)) return "ci-observation-search-only";
  if (record.source.portableCopies?.some(id => store.get(id))) return "portable-copy";
  return "";
}

export function classifyLearningQueue(store) {
  const counts = {};
  const rows = store.db.prepare("SELECT r.body FROM jobs j JOIN records r ON r.id=j.id WHERE j.state='pending'").all();
  for (const row of rows) {
    const record = JSON.parse(row.body), reason = learningSkipReason(record, store);
    if (!reason) continue;
    store.db.prepare("UPDATE jobs SET state='skipped' WHERE id=? AND state='pending'").run(record.id);
    store.setting(`learning-skip:${record.id}`, reason);
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

export function existingLessonsFor(store, records, limit = 24) {
  const words = new Set(records.flatMap(r => (r.title + " " + r.paths.join(" ") + " " + r.text.slice(0, 2000))
    .toLowerCase().match(/[a-z_][a-z0-9_-]{3,}/g) || []));
  const paths = new Set(records.flatMap(r => r.paths));
  const lessons = store.all(records[0].repository).filter(r => r.kind === "lesson");
  const groups = claimGroups(lessons), seen = new Set();
  return lessons.map(r => ({ r, score: r.paths.filter(p => paths.has(p)).length * 10 +
    [...new Set((r.title + " " + r.text).toLowerCase().match(/[a-z_][a-z0-9_-]{3,}/g) || [])].filter(w => words.has(w)).length }))
    .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id))
    .filter(({ r, score }) => {
      const id = groups.representatives.get(r.id).id;
      if (!score || seen.has(id)) return false;
      seen.add(id); return true;
    }).slice(0, limit).map(({ r }) => ({ id: r.id, text: r.text.slice(0, 600), paths: r.paths, component: r.component }));
}
