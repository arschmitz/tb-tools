import { openKnowledgeStore, searchKnowledge } from "./store.mjs";
import { createHash } from "node:crypto";

const ready = openKnowledgeStore(process.argv[2]);
ready.catch(() => {});
let queue = Promise.resolve(), version;
process.on("message", ({ id, query, operation = "search" }) => {
  queue = queue.then(async () => {
    try {
      const store = await ready;
      if (operation === "missingSections") {
        const result = store.db.prepare("SELECT s.id,s.body FROM sections s LEFT JOIN section_vectors v ON s.id=v.id AND v.model=? WHERE v.id IS NULL LIMIT 32").all(query.model);
        if (process.connected) process.send({ id, result });
        return;
      }
      if (operation !== "search") throw new Error("Unknown knowledge read operation.");
      const archives = createHash("sha256");
      for (const row of store.db.prepare("SELECT id FROM retrieval_archives ORDER BY id").iterate()) {
        archives.update(row.id).update("\0");
      }
      const current = `${store.maxRecordRowid()}:${archives.digest("hex")}`;
      // Immutable records append. Settings writes must not discard warm claim caches.
      if (version !== current) store.claimCache?.clear();
      version = current;
      const result = searchKnowledge(store, query);
      if (process.connected) process.send({ id, result });
    } catch (error) {
      if (process.connected) process.send({ id, error: error.message });
    }
  });
});
process.on("disconnect", () => process.exit());
