import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getGraphPatchUpdateHandledCommentIds,
  markGraphPatchUpdateCommentHandled,
} from "../commands/graph/patch-update-state.mjs";

test("handled patch update comments persist by revision across sessions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-tools-patch-update-state-"));
  const statePath = path.join(directory, "handled-comments.json");

  t.after(() => rm(directory, { force: true, recursive: true }));

  assert.deepEqual(
    await getGraphPatchUpdateHandledCommentIds({ revision: "D123456", statePath }),
    new Set(),
  );

  await markGraphPatchUpdateCommentHandled({
    itemId: "inline:100",
    now: new Date("2026-09-03T12:00:00.000Z"),
    revision: "D123456",
    statePath,
  });
  await markGraphPatchUpdateCommentHandled({
    itemId: "comment:200",
    now: new Date("2026-09-03T12:05:00.000Z"),
    revision: "123456",
    statePath,
  });

  assert.deepEqual(
    await getGraphPatchUpdateHandledCommentIds({ revision: "D123456", statePath }),
    new Set(["inline:100", "comment:200"]),
  );
  assert.deepEqual(
    await getGraphPatchUpdateHandledCommentIds({ revision: "D654321", statePath }),
    new Set(),
  );

  const state = JSON.parse(await readFile(statePath, "utf8"));

  assert.deepEqual(state.revisions.D123456.handledCommentIds, ["inline:100", "comment:200"]);
  assert.equal(state.revisions.D123456.updatedAt, "2026-09-03T12:05:00.000Z");
});
