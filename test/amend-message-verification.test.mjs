import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureAmendedCommitMessage } from "../commands/graph/data.mjs";

test("amend verification accepts Git whitespace cleanup and rejects changed text", () => {
  const actual = "Bug 2061199 - Add writable calendar selection. r=#thunderbird-front-end-reviewers\n\nDescription.\n\nDifferential Revision: https://phabricator.services.mozilla.com/D332509\n";
  const requested = `\n${actual.replaceAll("\n", "  \r\n\r\n")}\n`;
  assert.doesNotThrow(() => ensureAmendedCommitMessage(actual, requested, "ec6cf807c425"));
  assert.throws(() => ensureAmendedCommitMessage(actual, actual.replace("Description.", "Different description."), "ec6cf807c425"), /requested commit message/);
  assert.throws(() => ensureAmendedCommitMessage(actual, actual.replace("D332509", "D331224"), "ec6cf807c425"), /requested commit message/);
});
