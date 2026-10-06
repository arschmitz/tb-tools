import assert from "node:assert/strict";
import { test } from "node:test";
import { getCodexRunStatus } from "../commands/graph/client/codex-run-status.js";

test("Codex status distinguishes running, quiet, waiting, complete, and failed", () => {
  assert.match(getCodexRunStatus({ busy: true, silenceSeconds: 2 }).label, /Working - last output 2s/);
  assert.match(getCodexRunStatus({ busy: true, silenceSeconds: 61 }).label, /no new output for 61s/);
  assert.equal(getCodexRunStatus({ status: "review" }).label, "Waiting for your input");
  assert.equal(getCodexRunStatus({ status: "complete" }).label, "Finished");
  assert.equal(getCodexRunStatus({ busy: true, error: "Disconnected" }).state, "error");
});


test("paused implementation and input requests are not failures", () => {
  assert.equal(getCodexRunStatus({ status: "paused", error: "Resume to clarify" }).state, "waiting");
  assert.equal(getCodexRunStatus({ status: "input-required", error: "Which label?" }).label, "Waiting for your answer");
});
