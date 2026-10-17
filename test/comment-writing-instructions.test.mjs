import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_WRITING_GUIDANCE } from "../commands/knowledge/comment-writing.mjs";
import { knowledgeInstructions } from "../commands/knowledge/instructions.mjs";

test("comment guidance is supplied even without a knowledge checkout", () => {
  for (const repository of ["", "/shared/knowledge"]) {
    const input = knowledgeInstructions("/private/knowledge", repository);
    assert.ok(input.includes(COMMENT_WRITING_GUIDANCE));
    assert.match(input, /Read the implementation and relevant callers first/);
    assert.match(input, /Do not rewrite unrelated comments/);
  }
});
