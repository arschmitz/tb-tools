import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import config from "../lib/config.mjs";
import {
  formatGraphPatchUpdateMemory,
  compactGraphPatchUpdateHistory,
  getGraphPatchUpdateMemoryPath,
  saveGraphPatchUpdateMemory,
} from "../commands/graph/patch-update-memory.mjs";

test("default patch history writes to the configured standalone store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-patch-store-"));
  const original = config.ai;
  config.ai = { ...original, knowledge: { directory } };
  try {
    const file = await saveGraphPatchUpdateMemory({ event: "reviewed", session: makeSession() });
    assert.equal(file, path.join(directory, "private/patch-history/tb-tools-patch-d123456.md"));
    assert.match(await readFile(file, "utf8"), /Please use the shared helper/);
  } finally { config.ai = original; await rm(directory, { recursive: true, force: true }); }
});

function makeSession() {
  return {
    branch: "Bug-123456",
    codexSessionId: "codex-session",
    currentHash: "def456",
    items: [{
      appliedSummary: "Updated the helper and ran the focused test.",
      assessment: "The reviewer is right that the helper already exists.",
      author: "Reviewer",
      changeSummary: "Replace the local implementation with the shared helper.",
      content: "Please use the shared helper.",
      draftReply: "Updated to use the shared helper and added coverage.",
      feedbackType: "Inline review feedback",
      filePath: "mail/base/content/example.js",
      lineNumber: 42,
      rationale: "The existing helper preserves the required normalization behavior.",
      recommendation: "change",
      state: "handled",
      url: "https://phabricator.services.mozilla.com/D123456#inline-42",
    }],
    message: "The selected review change has been applied locally.",
    originalHash: "abc123",
    revision: "D123456",
    status: "review",
  };
}

test("history compaction keeps distinct evidence and reversals in event order", () => {
  const session = makeSession();
  session.items[0].validation = "Focused test failed: expected 2, got 1.";
  const record = (event) => formatGraphPatchUpdateMemory({
    event, session, now: new Date("2026-09-03T12:00:00.000Z"),
  });
  const first = record("First assessment");
  const duplicate = record("Repeated assessment");
  session.currentHash = "new-commit";
  session.items[0].validation = "Focused test passed.";
  session.items[0].state = "ready";
  const changed = record("Retested");
  session.items[0].validation = "Focused test failed: expected 2, got 1.";
  const reversal = record("Failure returned");
  delete session.items[0].draftReply;
  const cleared = record("Reply cleared");
  const result = compactGraphPatchUpdateHistory(first + duplicate + changed + reversal + cleared);
  assert.equal(result.split("> Please use the shared helper.").length - 1, 1);
  assert.equal(result.split("> Focused test failed: expected 2, got 1.").length - 1, 2);
  assert.match(result, /Focused test passed/);
  assert.match(result, /new-commit/);
  assert.match(result, /State: ready/);
  assert.match(result, /\*\*Draft reply\*\*\n\n> \(cleared in this record\)/);
  for (const event of ["First assessment", "Repeated assessment", "Retested", "Failure returned", "Reply cleared"]) {
    assert.ok(result.includes(event));
  }
  const values = [...(first + changed + reversal).matchAll(/^> .+$/gm)].map(([value]) => value);
  assert.ok(values.every((value) => result.includes(value)));
});

test("history compaction preserves unknown text and separate comment identities", () => {
  const session = makeSession();
  session.items.push({ ...session.items[0], url: "https://example.com/other-comment" });
  const history = formatGraphPatchUpdateMemory({ event: "Review", session });
  const context = "Project summary\n\n---\n\n" + history +
    "\n\n---\n\nRelevant index\n### Unrelated section\nUnique older evidence";
  assert.equal(compactGraphPatchUpdateHistory(context), context);
  const unknown = history + "### Unknown record\n- State: ready\n\n**Custom field**\n\nUnquoted text\n";
  assert.equal(compactGraphPatchUpdateHistory(unknown), unknown);
});

test("patch update memory records concise append-only review history", async (t) => {
  const memoryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "tb-tools-patch-memory-"),
  );
  const session = makeSession();

  t.after(() => rm(memoryDirectory, { force: true, recursive: true }));

  const pathName = await saveGraphPatchUpdateMemory({
    event: "Codex review completed",
    memoryDirectory,
    now: new Date("2026-09-03T12:00:00.000Z"),
    session,
  });
  await saveGraphPatchUpdateMemory({
    event: "Patch submitted to Phabricator",
    memoryDirectory,
    now: new Date("2026-09-03T12:10:00.000Z"),
    session,
  });

  assert.equal(
    pathName,
    getGraphPatchUpdateMemoryPath({ memoryDirectory, revision: "D123456" }),
  );

  const memory = await readFile(pathName, "utf8");

  assert.equal((memory.match(/# tb-tools patch update history/g) || []).length, 1);
  assert.match(memory, /Codex review completed/);
  assert.match(memory, /Patch submitted to Phabricator/);
  assert.match(memory, /Reviewer \(mail\/base\/content\/example\.js:42\)/);
  assert.match(memory, /Codex recommendation/);
  assert.match(memory, /Planned source change/);
  assert.match(memory, /Applied source change/);
  assert.doesNotMatch(memory, /session\.output/);
});

test("patch update memory formatting omits absent optional details", () => {
  const memory = formatGraphPatchUpdateMemory({
    event: "Patch rebased and checked out",
    now: new Date("2026-09-03T12:00:00.000Z"),
    session: {
      currentHash: "abc123",
      items: [],
      revision: "D123456",
      status: "complete",
    },
  });

  assert.match(memory, /Patch rebased and checked out/);
  assert.doesNotMatch(memory, /Branch:/);
  assert.doesNotMatch(memory, /Session message/);
});
