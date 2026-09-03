import assert from "node:assert/strict";
import test from "node:test";
import {
  formatConsoleRoute,
  parseConsoleRoute,
} from "../commands/graph/client/view-router.js";

test("console view routes support dashboard, boards, and sprints", () => {
  assert.deepEqual(parseConsoleRoute("#dashboard"), { view: "dashboard" });
  assert.deepEqual(parseConsoleRoute("#meta-boards/2061179"), {
    boardId: "2061179",
    view: "meta-boards",
  });
  assert.deepEqual(parseConsoleRoute("#sprints/2061179/2064000/planning"), {
    boardId: "2061179",
    sprintId: "2064000",
    sprintView: "planning",
    view: "sprint",
  });
  assert.equal(formatConsoleRoute({ view: "dashboard" }), "#dashboard");
  assert.equal(
    formatConsoleRoute({ boardId: "2061179", view: "meta-boards" }),
    "#meta-boards/2061179",
  );
  assert.equal(
    formatConsoleRoute({
      boardId: "2061179",
      sprintId: "2064000",
      sprintView: "planning",
      view: "sprint",
    }),
    "#sprints/2061179/2064000/planning",
  );
});

test("console view routes reject unrecognized or malformed hashes", () => {
  assert.equal(parseConsoleRoute("#graph/0"), null);
  assert.equal(parseConsoleRoute("#meta-boards/%"), null);
  assert.equal(formatConsoleRoute(null), "");
});
