import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";
import { saveLocalKnowledgeHistory } from "../commands/knowledge/sync.mjs";

const execute = promisify(execFile);

test("history pages new IDs without loading saved record bodies", async t => {
  let directory, store;
  t.after(async () => {
    store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  directory = await mkdtemp(path.join(tmpdir(), "tb-history-pages-"));
  store = await openKnowledgeStore(directory);
  const records = [];
  for (let index = 0; index < 5; index++) {
    records.push(await store.put({ kind: "evidence", repository: "tb-tools", visibility: index % 2 ? "shared" : "private",
      at: "2026-10-15T08:00:00Z", title: `Record ${index}`, text: `Evidence ${index}`, paths: [], source: { type: "code-snapshot" } }));
  }
  const recordIds = store.recordIds.bind(store), get = store.get.bind(store);
  const snapshots = [];
  store.recordIds = query => {
    snapshots.push(query.throughRowid);
    return recordIds({ ...query, limit: 2 });
  };
  store.all = () => { throw new Error("History should never load the whole corpus."); };
  assert.equal((await saveLocalKnowledgeHistory(store)).committed, 5, "History should save records across all pages.");
  assert.ok(snapshots.length >= 4, "History should visit multiple bounded pages.");
  assert.equal(new Set(snapshots).size, 1, "History should use one fixed snapshot boundary.");
  const git = async (...args) => (await execute("git", ["--git-dir", path.join(directory, "history.git"), ...args])).stdout.trim();
  assert.deepEqual((await git("ls-tree", "-r", "--name-only", "main")).split("\n").sort(),
    records.map(record => `${record.visibility}/records/${record.id}.json`).sort(), "History should retain both private and shared record paths.");
  const head = await git("rev-parse", "main");
  store.get = () => { throw new Error("History should not load an already saved record."); };
  assert.deepEqual(await saveLocalKnowledgeHistory(store), { committed: 0, commit: head }, "An unchanged corpus should keep the history commit and skip all saved bodies.");
  store.get = get;
  const added = await store.put({ kind: "evidence", repository: "tb-tools", visibility: "private",
    at: "2026-10-15T08:01:00Z", title: "New evidence", text: "New evidence", paths: [], source: {} });
  await writeFile(store.file(added), JSON.stringify({ ...added, text: "Changed on disk" }));
  await assert.rejects(saveLocalKnowledgeHistory(store), /Local knowledge record changed/, "History should reject a changed immutable file.");
  assert.equal(await git("rev-parse", "main"), head, "A failed backup should leave the history ref unchanged.");
});
