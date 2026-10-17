import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAbandonedBoardPatch,
  isClosedBoardBug,
} from "../commands/graph/client/meta-board-visibility.js";

test("board bug visibility uses open flags, status, and resolution", () => {
  for (const card of [
    { isOpen: false },
    { status: "RESOLVED" },
    { status: "VERIFIED" },
    { status: "CLOSED" },
    { resolution: "WONTFIX" },
  ]) {
    assert.equal(isClosedBoardBug(card), true);
  }
  assert.equal(isClosedBoardBug({ status: "REOPENED", resolution: "---" }), false);
  assert.equal(isClosedBoardBug({ column: "complete", isOpen: true }), false);
});

test("abandoned patch visibility accepts both Phabricator status fields", () => {
  assert.equal(isAbandonedBoardPatch({ status: "status-abandoned" }), true);
  assert.equal(isAbandonedBoardPatch({ statusName: "Abandoned" }), true);
  for (const status of ["closed", "accepted", "needs-review", "Attached"]) {
    assert.equal(isAbandonedBoardPatch({ status }), false);
  }
});
