import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareGraphPatchUpdateCodexPrompt, runGraphPatchUpdateCodexTurn } from "../commands/graph/patch-update.mjs";

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-update-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("small update requests remain inline", async t => {
  const root = await directory(t);
  assert.equal(await prepareGraphPatchUpdateCodexPrompt({ prompt: "Explain this patch", directory: root }), "Explain this patch");
  assert.deepEqual(await readdir(root), []);
});

test("oversized update requests retain every character in a private stable file", async t => {
  const root = await directory(t);
  const prompt = 'Author request: check "use strict" and renamed files.\n' +
    "Distinct review history.\n".repeat(60000) + "Final decision: keep the new file names.";
  const input = await prepareGraphPatchUpdateCodexPrompt({ prompt, directory: root });
  assert.ok(input.length < 1048576);
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const file = path.join(root, files[0]);
  assert.ok(input.includes(JSON.stringify(file)));
  assert.equal(await readFile(file, "utf8"), prompt);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await prepareGraphPatchUpdateCodexPrompt({ prompt, directory: root }), input);
  assert.deepEqual(await readdir(root), files);
});

test("Codex receives a bounded prompt without starting a duplicate writer", async t => {
  const root = await directory(t);
  const prompt = "history".repeat(180000);
  const inputs = [];
  const session = { codexSessionId: "old", graph: { path: "/repo/comm" } };
  let attempts = 0;
  await assert.rejects(runGraphPatchUpdateCodexTurn({ session, prompt, promptDirectory: root,
    getAgent: async () => ({ threadId: "new", client: {
      close() {},
      async startTurn({ prompt: input }) {
        inputs.push(input);
        if (++attempts === 1) throw new Error("already has an active writer");
        return { turn: { status: "completed" }, message: "Done" };
      },
    } }),
  }), /active writer/);
  assert.equal(inputs.length, 1);
  assert.ok(inputs.every(input => input.length < 1048576));
  assert.equal(await readFile(path.join(root, (await readdir(root))[0]), "utf8"), prompt);
});


test("review prompt data shares repeated patches without losing comments or distinct diffs", async () => {
  const { compactGraphPatchReviewContext } = await import("../commands/graph/patch-update-memory.mjs");
  const original = { rawPatch: "large patch\n".repeat(10000), historyTruncated: false,
    comments: [{ id: "regular", content: "Keep this decision" }],
    inlineComments: Array.from({ length: 30 }, (_, index) => ({ id: String(index),
      content: `Comment ${index}`, filePath: "renamed.js", lineNumber: index + 1,
      codeSuggestion: { content: '"use strict";', isDeletion: false },
      contextDiff: "large patch\n".repeat(10000) })),
  };
  original.inlineComments.push({ id: "older", content: "Earlier decision", contextDiff: "distinct older diff" });
  const before = JSON.stringify(original);
  const compact = compactGraphPatchReviewContext(original);
  assert.equal(Object.keys(compact.sharedDiffs).length, 2);
  assert.equal(compact.sharedDiffs[compact.rawPatch.sharedDiff], original.rawPatch);
  compact.inlineComments.forEach((comment, index) => {
    assert.deepEqual({ ...comment, contextDiff: compact.sharedDiffs[comment.contextDiff.sharedDiff] }, original.inlineComments[index]);
  });
  assert.deepEqual(compact.comments, original.comments);
  assert.ok(JSON.stringify(compact).length < before.length / 10);
  assert.equal(JSON.stringify(original), before);
});
