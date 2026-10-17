import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { leaseStorage, pruneStorage } from "../commands/graph/storage-retention.mjs";
import { createTryMonitorStore } from "../commands/graph/try-monitor-store.mjs";
import { pruneTryStorage } from "../commands/graph/try-storage.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("retention removes old and excess files while a live lease protects active evidence", async t => {
  const root = await fixture(t);
  for (const name of ["old", "recent", "active"]) await writeFile(path.join(root, name), "123456");
  await utimes(path.join(root, "old"), new Date(0), new Date(0));
  const release = await leaseStorage(root, [path.join(root, "active")]);
  const result = await pruneStorage({ directory: root, maxBytes: 6, maxAgeMs: 1000 });
  assert.equal(result.bytes, 6);
  assert.equal(await readFile(path.join(root, "active"), "utf8"), "123456");
  await assert.rejects(readFile(path.join(root, "old")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, "recent")), { code: "ENOENT" });
  await release();
  await pruneStorage({ directory: root, maxBytes: 0, maxAgeMs: 0 });
  await assert.rejects(readFile(path.join(root, "active")), { code: "ENOENT" });
});

test("retention removes a symlink without deleting the file it points to", async t => {
  const root = await fixture(t);
  const cache = path.join(root, "cache");
  await mkdir(cache);
  const source = path.join(root, "source");
  await writeFile(source, "user source");
  await symlink(source, path.join(cache, "link"));
  await pruneStorage({ directory: cache, maxBytes: 0, maxAgeMs: 0 });
  assert.equal(await readFile(source, "utf8"), "user source");
});

test("inactive Try tasks keep their verdicts and lose working evidence; active tasks keep theirs", async t => {
  const root = await fixture(t);
  const store = createTryMonitorStore(path.join(root, "monitor"));
  for (const [id, phase] of [["done", "passed"], ["active", "analyzing"]]) {
    store.save({ id, phase, path: "/source/comm", attempts: [{ assessment: { result: "saved verdict" } }], evidence: { logs: "working evidence" } });
    const directory = path.join(store.directory, "assessment-evidence", id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "log"), "working evidence");
  }
  await pruneTryStorage({ store, evidenceDirectory: path.join(root, "cache") });
  assert.equal(store.read("done").attempts[0].assessment.result, "saved verdict");
  assert.equal(store.read("done").evidenceFile, undefined);
  assert.ok(store.read("active").evidenceFile);
  await assert.rejects(readFile(path.join(store.directory, "assessment-evidence", "done", "log")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(store.directory, "assessment-evidence", "active", "log"), "utf8"), "working evidence");
});
