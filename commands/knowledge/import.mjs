import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { digest, atomicWrite } from "./store.mjs";
import { acceptLessons, writeComponentGuides } from "./learning.mjs";

// Imports stay private and provisional. Do not copy unrelated personal memories.
export async function importLegacyKnowledge(store, memoryDirectory) {
  const files = [path.join(memoryDirectory, "MEMORY.md")];
  const notes = path.join(memoryDirectory, "extensions", "ad_hoc", "notes");
  for (const entry of await readdir(notes, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /^tb-tools-patch-.*\.md$/.test(entry.name)) files.push(path.join(notes, entry.name));
  }
  let imported = 0;
  for (const file of files) {
    const metadata = await stat(file).catch(() => null);
    if (!metadata || metadata.size > 20_000_000) continue;
    const text = await readFile(file, "utf8");
    if (path.basename(file).startsWith("tb-tools-patch-")) {
      await atomicWrite(path.join(store.directory, "private", "legacy-patch-history", path.basename(file)), text);
    }
    const key = `import-v3:${file}`, fingerprint = digest(text);
    if (store.setting(key) === fingerprint) continue;
    const previous = new Map(store.all().filter(record => record.source.type === "legacy-memory" && record.source.file === file)
      .map(record => [digest({ heading: record.title, text: record.text }), record.id]));
    let line = 1;
    for (const section of text.split(/(?=^# Task Group: )/m)) {
      const start = line;
      line += (section.match(/\n/g) || []).length;
      const heading = section.split("\n")[0];
      const patch = path.basename(file).startsWith("tb-tools-patch-");
      if (!patch && !/^# Task Group:.*(?:Thunderbird|Calendar|Commands|tb-tools)/i.test(heading)) continue;
      const repository = /Commands|tb-tools/i.test(heading) && !/Thunderbird/i.test(heading) ? "tb-tools" : "thunderbird";
      const dated = [...section.matchAll(/(?:updated_at=|^## )(\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?)/gm)]
        .map(match => Date.parse(match[1])).filter(Number.isFinite);
      const at = dated.length ? new Date(Math.max(...dated)).toISOString() : metadata.mtime.toISOString();
      // Preserve whole lines and their original locations. Large sections are split without losing text.
      let offset = 0, chunk = [], length = 0;
      const save = async () => {
        if (!chunk.length) return;
        const content = chunk.join("\n");
        const source = { type: "legacy-memory", file, line: start + offset, imported: true, personal: true };
        const identity = digest({ file, heading, text: content });
        let recordId = store.setting(`legacy-content:${identity}`) || previous.get(digest({ heading, text: content }));
        if (!recordId) {
          const record = await store.put({ kind: "evidence", repository, at, title: heading,
            text: content, source, paths: [], visibility: "private" });
          recordId = record.id;
          imported++;
        }
        store.setting(`legacy-content:${identity}`, recordId);
        const record = recordId && store.get(recordId);
        if (record && !patch) {
          const reusable = content.split("## Reusable knowledge\n")[1]?.split(/^## /m)[0] || "";
          const bullets = reusable.split("\n").filter(line => line.startsWith("- ") && line.length >= 20 && line.length <= 2002);
          for (let i = 0; i < bullets.length; i += 8) {
            await acceptLessons(store, [record], { lessons: bullets.slice(i, i + 8).map(bullet => ({
              title: heading.replace(/^# Task Group: /, "").slice(0, 160), text: bullet.slice(2),
              component: /calendar/i.test(heading) ? "calendar" : repository === "tb-tools" ? "console" : "general",
              paths: [], evidence: [record.id], quotes: [{ id: record.id, text: bullet }], supersedes: [],
            })) });
          }
        }
        offset += chunk.length; chunk = []; length = 0;
      };
      for (const part of section.split("\n")) {
        if (length + part.length > 10_000) await save();
        chunk.push(part); length += part.length + 1;
      }
      await save();
    }
    store.setting(key, fingerprint);
  }
  await writeComponentGuides(store);
  return imported;
}
