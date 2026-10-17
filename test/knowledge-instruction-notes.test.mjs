import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseKnowledgeNote, readKnowledgeRepository, syncKnowledgeRepository } from "../commands/knowledge/repository.mjs";
import { learningSkipReason, classifyLearningQueue } from "../commands/knowledge/claims.mjs";
import { openKnowledgeStore } from "../commands/knowledge/store.mjs";

const metadata = {
  repository: "thunderbird", at: "2026-10-06T12:00:00Z", paths: ["calendar/example.js"],
  source: { reference: "https://phabricator.services.mozilla.com/D123456", status: "provisional" },
};
const note = (data, body = "# Scoped ordinary observation\n\nAn ordinary cited observation.\n") =>
  `<!-- knowledge: ${JSON.stringify(data)} -->\n${body}`;
const instruction = {
  ...metadata, paths: [], source: { type: "user-directed-code-style", status: "instruction" },
};

test("Git sync recognizes the evidence workflow without importing instructions as lessons", async t => {
  let store;
  t.after(() => store?.close());
  const root = await mkdtemp(path.join(tmpdir(), "tb-instruction-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "repository");
  await mkdir(checkout);
  const execute = promisify(execFile);
  const git = (...args) => execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd: checkout });
  await git("init", "-b", "main");
  await writeFile(path.join(checkout, "CODE-EVIDENCE.md"), "# Evidence workflow\n\nReviewed writing instructions.\n");
  await git("add", "CODE-EVIDENCE.md");
  await git("commit", "-m", "Add reviewed evidence workflow");
  store = await openKnowledgeStore(path.join(root, "store"));
  const result = await syncKnowledgeRepository(store, { repositoryDirectory: checkout, push: false });
  assert.equal(result.localOnly, true, "A local instruction checkout should sync without a remote.");
  assert.equal(store.all().length, 0, "Reviewed instruction text should not become learned evidence.");
  await writeFile(path.join(checkout, "UNKNOWN.md"), "Unsupported document.\n");
  await git("add", "UNKNOWN.md");
  await git("commit", "-m", "Add unsupported document");
  await assert.rejects(syncKnowledgeRepository(store, { repositoryDirectory: checkout, push: false }),
    /unsupported files or modes/, "The importer should still reject an unknown document.");
});

test("instruction notes preserve their marker and ordinary note identities", () => {
  const parsed = parseKnowledgeNote(note(instruction));
  assert.equal(parsed.source.type, "user-directed-code-style", "The imported note should preserve its instruction type.");
  assert.equal(parsed.source.status, "instruction", "The imported note should preserve its instruction status.");
  assert.equal(parseKnowledgeNote(note(metadata)).id,
    "c6b359c48511545bf915a456e393e182f947ea89fe6dc21904d0a096d7e83bb5",
    "An ordinary note should retain its existing record identity.");
  for (const source of [{}, { type: "user-directed-code-style" }, { status: "instruction" }]) {
    assert.throws(() => parseKnowledgeNote(note({ ...metadata, source })), /source reference/,
      "A note without both instruction markers should still require a source reference.");
  }
});

test("imported instructions leave the learning queue without hiding ordinary evidence", async t => {
  let store;
  t.after(() => store?.close());
  const root = await mkdtemp(path.join(tmpdir(), "tb-instruction-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "repository"), notes = path.join(checkout, "notes");
  await mkdir(notes, { recursive: true });
  await writeFile(path.join(notes, "instruction.md"), note(instruction));
  await writeFile(path.join(notes, "ordinary.md"), note(metadata));
  store = await openKnowledgeStore(path.join(root, "store"));
  await readKnowledgeRepository(store, checkout);
  const imported = store.get(parseKnowledgeNote(note(instruction)).id);
  const ordinary = store.get(parseKnowledgeNote(note(metadata)).id);
  assert.ok(imported, "The repository import should retain the instruction note.");
  assert.ok(ordinary, "The repository import should retain the ordinary evidence note.");
  assert.equal(learningSkipReason(imported, store), "reviewed-instruction",
    "A user instruction should stay outside automatic lesson generation.");
  assert.equal(learningSkipReason({ ...imported, source: { type: "shared-note", status: "instruction" } }, store),
    "reviewed-instruction", "An older imported instruction should also stay outside automatic lesson generation.");
  assert.deepEqual(classifyLearningQueue(store), { "reviewed-instruction": 1 },
    "Queue classification should skip the instruction without skipping ordinary evidence.");
  const state = id => store.db.prepare("SELECT state FROM jobs WHERE id=?").get(id).state;
  assert.equal(state(imported.id), "skipped", "The instruction job should be skipped.");
  assert.equal(state(ordinary.id), "pending", "Ordinary evidence should remain available for learning.");
});
