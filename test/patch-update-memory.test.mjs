import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  formatGraphPatchUpdateMemory,
  getGraphPatchUpdateMemoryPath,
  saveGraphPatchUpdateMemory,
} from "../commands/graph/patch-update-memory.mjs";

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
