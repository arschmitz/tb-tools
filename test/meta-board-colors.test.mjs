import assert from "node:assert/strict";
import test from "node:test";
import {
  createColorAssignments,
  getAccessibleAssigneePillStyle,
  getContrastRatio,
} from "../commands/graph/client/meta-board-colors.js";

test("meta board color assignments are stable and avoid palette collisions", () => {
  const palette = ["#red", "#green", "#blue"];
  const first = createColorAssignments(
    ["klamping@thunderbird.net", "arschmitz@thunderbird.net"],
    palette,
  );
  const second = createColorAssignments(
    ["arschmitz@thunderbird.net", "klamping@thunderbird.net"],
    palette,
  );

  assert.equal(first.get("arschmitz@thunderbird.net"), "#red");
  assert.equal(first.get("klamping@thunderbird.net"), "#green");
  assert.notEqual(
    first.get("arschmitz@thunderbird.net"),
    first.get("klamping@thunderbird.net"),
  );
  assert.deepEqual(first, second);
});

test("meta board color assignments generate distinct colors beyond the palette", () => {
  const colors = createColorAssignments(["1", "2", "3"], ["#red", "#green"]);

  assert.equal(colors.get("1"), "#red");
  assert.equal(colors.get("2"), "#green");
  assert.match(colors.get("3"), /^#[\da-f]{6}$/i);
});

test("assignee pills meet WCAG AAA contrast for configured and generated colors", () => {
  const colors = createColorAssignments(
    Array.from({ length: 12 }, (_, index) => `person-${index}`),
    ["#0f766e", "#a21caf", "#1d4ed8", "#b45309", "#be123c", "#047857"],
  );

  for (const color of colors.values()) {
    const pill = getAccessibleAssigneePillStyle(color);

    assert.ok(getContrastRatio(pill.foreground, pill.background) >= 7);
  }
});
