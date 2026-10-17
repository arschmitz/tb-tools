import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { implementationKnowledgeRequest, patchKnowledgeRequest, tryKnowledgeRequest } from "../commands/graph/task-knowledge.mjs";

const revision = "a".repeat(40);

test("a new implementation searches its bug and current guidance without inheriting base files", () => {
  const state = { bugId: 123, bug: { summary: "Calendar save focus" }, baseHash: revision,
    comments: [{ text: "Keep focus on the selected calendar." }],
    instructions: [{ text: "Old guidance" }, { text: "Test keyboard selection." }] };
  const repository = { head: revision, files: "M\tunrelated.js" };
  const request = implementationKnowledgeRequest(state, "implement", repository);
  assert.ok(request.question.startsWith("Test keyboard selection."), "The question should start with the latest human guidance");
  assert.match(request.question, /Calendar save focus/, "The question should include the bug title");
  assert.match(request.question, /Keep focus on the selected calendar/, "The question should include the original bug description");
  assert.deepEqual(request.paths, [], "A new implementation should not inherit base-commit paths");
  assert.equal(request.taskType, "implement", "The request should identify implementation work");
  assert.equal(request.revision, revision, "The request should preserve the current source revision");
  const verify = implementationKnowledgeRequest({ ...state, commitHash: revision }, "verify", repository);
  assert.deepEqual(verify.paths, ["unrelated.js"], "Verification should use the implementation commit paths");
  assert.equal(verify.taskType, "verify", "Verification should retain its task type");
});

test("patch retrieval uses the selected commit and specific feedback instead of unrelated checkout changes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-knowledge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(directory, "old.js"), "Old source\n");
  git("add", "."); git("commit", "-qm", "Base");
  await writeFile(path.join(directory, "selected.js"), "Selected source\n");
  git("add", "."); git("commit", "-qm", "Selected patch");
  const selected = git("rev-parse", "HEAD");
  await writeFile(path.join(directory, "later.js"), "Later source\n");
  git("add", "."); git("commit", "-qm", "Later patch");
  await writeFile(path.join(directory, "old.js"), "Unrelated dirty source\n");
  const session = { currentHash: selected, mode: "verify", revision: "D123", graph: { path: directory },
    commitMessage: "Correct the selected calendar", items: [{ content: "Other comment", filePath: "other.js" }] };
  const request = await patchKnowledgeRequest(session, {
    question: "Check the rejection path.",
    item: { filePath: "selected.js", content: "Keep the selected value on error.", instruction: "Test keyboard focus." },
  });
  assert.ok(request.question.startsWith("Check the rejection path."), "The request should start with the current follow-up");
  assert.match(request.question, /Keep the selected value on error/, "The question should retain the selected comment");
  assert.doesNotMatch(request.question, /Other comment/, "The question should omit unrelated comments for focused work");
  assert.deepEqual(request.paths, ["selected.js"], "The request should contain selected-commit paths only");
  assert.equal(request.revision, selected, "The request should retain the selected revision");
  assert.equal(request.taskType, "verify", "The request should preserve the verification task type");
});

test("Try retrieval retains failed jobs and current assessment without copying workflow instructions", () => {
  const request = tryKnowledgeRequest({ subject: "Bug 123 - Preserve calendar selection",
    sourceHash: "b".repeat(40), assessment: { failures: [{ reason: "CalendarDialog rejects the selected value" }] } }, true,
  { head: revision, files: "M\tcalendar/dialog.js\nD\tcalendar/old.js" },
  { failures: [{ job: "browser_calendar_save.js" }] });
  assert.match(request.question, /CalendarDialog rejects the selected value/, "The question should retain the observed failure");
  assert.match(request.question, /browser_calendar_save.js/, "The question should identify the failing job");
  assert.deepEqual(request.paths, ["calendar/dialog.js", "calendar/old.js"], "The request should retain changed and deleted source paths");
  assert.equal(request.revision, revision, "The request should use the current checkout revision");
  assert.equal(request.taskType, "repair", "The request should identify repair work");
});
