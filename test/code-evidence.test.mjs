import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createGraphCodexAppServer } from "../commands/graph/codex-app-server.mjs";
import { validateCodeEvidence, snapshotCodeEvidence, changedEvidencePaths, evidencePreparationPrompt } from "../commands/knowledge/code-evidence.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await writeFile(path.join(root, "example.js"), "export const existing = 1;\n");
  await writeFile(path.join(root, "target.js"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const prompt = "Use const for this binding.";
  const plan = { mode: "write", gaps: [], decisions: [{ paths: ["target.js"], pattern: "Use a const binding",
    evidence: [{ source: "user", quote: prompt, scope: "This binding", application: "Preserve const" }],
    example: { path: "example.js", revision: git("rev-parse", "HEAD"), quote: "export const existing = 1;", scope: "Same module role" } }] };
  return { root, prompt, plan };
}

test("citations must match current source, pinned revision, and request", async t => {
  const { root, prompt, plan } = await fixture(t);
  const valid = await validateCodeEvidence(plan, { root, prompt });
  assert.deepEqual(valid.paths, ["target.js"], "The record should authorize the exact target");
  for (const mutate of [
    record => { record.gaps = ["Missing harness evidence"]; },
    record => { record.decisions[0].evidence[0].quote = "Invented instruction"; },
    record => { record.decisions[0].example.revision = "0".repeat(40); },
    record => { record.decisions[0].paths = ["../outside.js"]; },
    record => { record.decisions[0].pattern = 42; },
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    await assert.rejects(validateCodeEvidence(invalid, { root, prompt }), { code: "CODE_EVIDENCE_REQUIRED" }, "Unsupported records should be marked incomplete");
  }
  await writeFile(path.join(root, "example.js"), "Different source\n");
  await assert.rejects(validateCodeEvidence(plan, { root, prompt }), { code: "CODE_EVIDENCE_REQUIRED" }, "Stale local examples should invalidate the record");
});

test("snapshot comparison separates old edits from newly changed paths", async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "target.js"), "Existing user change\n");
  const before = await snapshotCodeEvidence(root);
  await writeFile(path.join(root, "example.js"), "New unsupported change\n");
  const after = await snapshotCodeEvidence(root);
  assert.deepEqual(await changedEvidencePaths(before, after), ["example.js"], "The comparison should retain the user's baseline");
});

test("evidence cannot follow a source symlink out of the repository", async t => {
  const { root, prompt, plan } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "external-evidence-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "source.js"), plan.decisions[0].example.quote);
  await rm(path.join(root, "example.js"));
  await symlink(path.join(external, "source.js"), path.join(root, "example.js"));
  await assert.rejects(validateCodeEvidence(plan, { root, prompt }), { code: "CODE_EVIDENCE_REQUIRED" }, "An escaping symlink should invalidate the record");
});

function server(t, root, responses, knowledge = false, options = {}) {
  const requests = [], warnings = [], child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  let thread = 0, turn = 0;
  child.stdin = { writable: true, write(line) {
    const request = JSON.parse(line);
    requests.push(request);
    let result = {};
    if (request.method === "thread/start") result = { thread: { id: `thread-${++thread}` } };
    if (request.method === "threadSection/list") result = { data: [{ id: "section", name: "TB Console" }] };
    if (request.method === "turn/start") {
      const id = `turn-${++turn}`;
      result = { turn: { id, status: "inProgress" } };
      setImmediate(async () => {
        const response = responses.shift();
        await response?.action?.();
        child.stdout.emit("data", JSON.stringify({ method: "item/completed", params: { turnId: id,
          item: { type: "agentMessage", text: JSON.stringify(response?.message) } } }) + "\n");
        child.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn: { id, status: response?.status || "completed" } } }) + "\n");
      });
    }
    queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ id: request.id, result }) + "\n"));
    return true;
  } };
  child.kill = () => child.emit("exit", 0);
  const client = createGraphCodexAppServer({ cwd: root, command: "codex", knowledge, spawnProcess: () => child, onStderr: message => warnings.push(message), ...options });
  t.after(() => client.close());
  return { client, requests, warnings };
}

const approval = { approved: true, reasons: ["The scoped example supports this decision."] };

test("runner collects evidence before execution and compares changes afterward", async t => {
  const { root, prompt, plan } = await fixture(t);
  const { client, requests } = server(t, root, [
    { message: plan }, { message: approval },
    { message: "Updated", action: () => writeFile(path.join(root, "target.js"), "export const value = 2;\n") },
    { message: approval },
  ]);
  const thread = await client.start();
  const result = await client.startTurn({ threadId: thread.id, prompt });
  assert.deepEqual(result.codeEvidence.changedPaths, ["target.js"], "The result should include checked changed paths");
  const turns = requests.filter(request => request.method === "turn/start");
  assert.deepEqual(turns.map(request => request.params.sandboxPolicy.type), ["readOnly", "readOnly", "dangerFullAccess", "readOnly"], "Task execution should retain its configured write permissions");
  assert.notEqual(turns[0].params.threadId, turns[1].params.threadId, "The checker should use an independent conversation");
  assert.equal(turns[0].params.threadId, turns[2].params.threadId, "The writer should retain its task conversation");
});

for (const stage of ["preparation", "decision", "diff", "scope"]) {
  test(`runner reports an incomplete ${stage} assessment and completes work once`, async t => {
    const { root, prompt, plan } = await fixture(t);
    const rejected = { approved: false, reasons: ["The proposed style lacks local support."] };
    let executions = 0;
    const execution = { message: "Updated", action: async () => {
      executions++;
      await writeFile(path.join(root, stage === "scope" ? "example.js" : "target.js"), "Retained change\n");
    } };
    const responses = stage === "preparation" ? [{ message: { ...plan, gaps: ["No evidence"] } }, execution] : [
      { message: plan }, { message: stage === "decision" ? rejected : approval }, execution,
      { message: stage === "diff" ? rejected : approval },
    ];
    const { client, warnings } = server(t, root, responses);
    const thread = await client.start();
    const result = await client.startTurn({ threadId: thread.id, prompt });
    assert.equal(result.message, JSON.stringify("Updated"), "The runner should preserve the task result");
    assert.equal(result.codeEvidence.status, "incomplete", "The runner should report incomplete evidence");
    assert.ok(warnings.length, "The runner should expose the evidence limit in task output");
    assert.equal(executions, 1, "An evidence failure should not rerun completed work");
    const file = stage === "scope" ? "example.js" : "target.js";
    assert.equal(await readFile(path.join(root, file), "utf8"), "Retained change\n", "The task's edits should remain available for inspection");
    assert.deepEqual(result.codeEvidence.changedPaths, [file], "The audit should collect changes even when evidence is missing");
  });
}

test("review validation keeps configured permissions despite preparation gaps", async t => {
  const { root } = await fixture(t);
  const plan = { mode: "readOnly", decisions: [], gaps: ["Build validation has not run", "CodeRabbit has not run"] };
  const captures = [];
  const { client, requests } = server(t, root, [{ message: plan }, { message: { issues: [], coverage: "Validated" } }], {
    beforeTurn: async () => {}, capture: async record => captures.push(record),
  });
  const thread = await client.start();
  const result = await client.startTurn({ threadId: thread.id, prompt: "Review the patch and run validation", task: "review", model: "test-model" });
  assert.equal(result.turn.status, "completed", "Missing validation evidence should not stop the review");
  const turns = requests.filter(request => request.method === "turn/start");
  assert.deepEqual(turns.map(request => request.params.sandboxPolicy.type), ["readOnly", "dangerFullAccess"], "Review execution should retain its configured permissions");
  assert.deepEqual(result.codeEvidence.plan, plan, "The audit should retain the original evidence gaps");
  assert.equal(captures.at(-1).task, "code-evidence", "The evidence audit should still be captured");
  assert.equal(JSON.parse(captures.at(-1).message).status, "incomplete", "Captured gaps should not be reported as verified work");
  assert.doesNotMatch(evidencePreparationPrompt("Review"), /must remain read-only|need a separate authorized runner/, "Preparation should not forbid authorized validation");
});

test("an unplanned source mutation is recorded without losing the task result", async t => {
  const { root, prompt } = await fixture(t);
  const { client } = server(t, root, [
    { message: { mode: "readOnly", decisions: [], gaps: [] } },
    { message: "Reviewed", action: () => writeFile(path.join(root, "target.js"), "Experiment\n") },
  ]);
  const thread = await client.start();
  const result = await client.startTurn({ threadId: thread.id, prompt });
  assert.equal(result.message, JSON.stringify("Reviewed"), "The result should survive an unplanned change");
  assert.equal(result.codeEvidence.status, "incomplete", "The unplanned change should be an evidence limit");
  assert.deepEqual(result.codeEvidence.changedPaths, ["target.js"], "The evidence record should identify the change");
});

test("new guidance during evidence checking reaches execution without cancellation", async t => {
  const { root, prompt, plan } = await fixture(t);
  const { client, requests } = server(t, root, [{ message: plan }, { message: approval }, { message: "Updated" }, { message: approval }]);
  const thread = await client.start();
  let phase = 0, steering;
  const result = await client.startTurn({ threadId: thread.id, prompt, onTurnStarted(turnId) {
    if (++phase !== 2) return;
    steering = client.steerTurn({ threadId: thread.id, turnId, prompt: "Use the new instruction" });
  } });
  await steering;
  assert.equal(result.turn.status, "completed", "New guidance should not cancel the task");
  assert.equal(requests.some(request => request.method === "turn/interrupt"), false, "Evidence collection should not interrupt work for new guidance");
  const execution = requests.filter(request => request.method === "turn/start")[2];
  assert.match(execution.params.input[0].text, /Use the new instruction/, "Execution should receive queued guidance");
  assert.equal(result.codeEvidence.status, "incomplete", "The original evidence should not verify changed guidance");
});

test("evidence capture failure preserves the result and reports the limit", async t => {
  const { root, prompt } = await fixture(t);
  const { client } = server(t, root, [{ message: { mode: "readOnly", decisions: [], gaps: [] } }, { message: "Reviewed" }], {
    beforeTurn: async () => {}, capture: async () => { throw new Error("Capture unavailable"); },
  });
  const thread = await client.start();
  const result = await client.startTurn({ threadId: thread.id, prompt });
  assert.equal(result.message, JSON.stringify("Reviewed"), "Capture failure should preserve the result");
  assert.equal(result.codeEvidence.status, "incomplete", "Capture failure should leave the audit incomplete");
  assert.match(result.codeEvidence.warnings.join(" "), /Capture unavailable/, "The audit should explain the capture failure");
});

for (const sandbox of ["read-only", "workspace-write"]) {
  test(`execution preserves the configured ${sandbox} sandbox`, async t => {
    const { root, prompt } = await fixture(t);
    const { client, requests } = server(t, root, [{ message: {} }, { message: "Done" }], false, { sandbox });
    const thread = await client.start();
    await client.startTurn({ threadId: thread.id, prompt });
    const execution = requests.filter(request => request.method === "turn/start")[1];
    assert.equal(execution.params.sandboxPolicy.type, sandbox === "read-only" ? "readOnly" : "workspaceWrite", "Incomplete evidence should not widen task permissions");
  });
}

test("a failed task is not retried by evidence collection", async t => {
  const { root, prompt } = await fixture(t);
  const { client, requests } = server(t, root, [{ message: {} }, { message: "Failed", status: "failed" }]);
  const thread = await client.start();
  const result = await client.startTurn({ threadId: thread.id, prompt });
  assert.equal(result.turn.status, "failed", "The runner should preserve a real task failure");
  assert.equal(requests.filter(request => request.method === "turn/start").length, 2, "The runner should not rerun failed execution");
});

test("explicit cancellation during preparation still stops execution", async t => {
  const { root, prompt, plan } = await fixture(t);
  const { client, requests } = server(t, root, [{ message: plan }]);
  const thread = await client.start();
  let cancellation;
  await assert.rejects(client.startTurn({ threadId: thread.id, prompt, onTurnStarted(turnId) {
    cancellation = client.interruptTurn({ threadId: thread.id, turnId });
  } }), /task was interrupted/, "A user cancellation should still stop the task");
  await cancellation;
  assert.equal(requests.filter(request => request.method === "turn/start").length, 1, "Cancellation should prevent execution");
});


test("guidance sent to active execution is applied once", async t => {
  const { root, prompt, plan } = await fixture(t);
  const { client, requests } = server(t, root, [{ message: plan }, { message: approval }, { message: "Updated" }, { message: approval }]);
  const thread = await client.start();
  let phase = 0, steering;
  const result = await client.startTurn({ threadId: thread.id, prompt, onTurnStarted(turnId) {
    if (++phase === 3) steering = client.steerTurn({ threadId: thread.id, turnId, prompt: "Check focus too" });
  } });
  await steering;
  const steered = requests.find(request => request.method === "turn/steer");
  assert.equal(steered.params.expectedTurnId, "turn-3", "Live guidance should target the active execution turn");
  assert.equal(requests.filter(request => request.method === "turn/start").length, 4, "Already steered guidance should not start another execution");
  assert.equal(result.message, JSON.stringify("Updated"), "The runner should preserve the guided execution result");
});

test("guidance during the final assessment reaches a follow-up task turn", async t => {
  const { root, prompt, plan } = await fixture(t);
  const { client, requests } = server(t, root, [
    { message: plan }, { message: approval }, { message: "Initial result" }, { message: approval },
    { message: "Updated result", action: () => writeFile(path.join(root, "target.js"), "Follow-up change\n") },
  ]);
  const thread = await client.start();
  let phase = 0, steering;
  const result = await client.startTurn({ threadId: thread.id, prompt, onTurnStarted(turnId) {
    if (++phase === 4) steering = client.steerTurn({ threadId: thread.id, turnId, prompt: "Check this additional behavior" });
  } });
  await steering;
  assert.equal(result.message, JSON.stringify("Updated result"), "The task should apply guidance received during the final assessment");
  const followup = requests.filter(request => request.method === "turn/start")[4];
  assert.match(followup.params.input[0].text, /Check this additional behavior/, "The follow-up turn should receive late guidance");
  assert.match(followup.params.input[0].text, /Initial result/, "The follow-up turn should reuse the completed result");
  assert.deepEqual(result.codeEvidence.changedPaths, ["target.js"], "The evidence record should include follow-up edits");
  assert.equal(result.codeEvidence.status, "incomplete", "The original assessment should not verify follow-up edits");
});

test("a failed source snapshot does not prevent task execution", async t => {
  const { root, prompt } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "external-snapshot-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "source.js"), "External source\n");
  await rm(path.join(root, "target.js"));
  await symlink(path.join(external, "source.js"), path.join(root, "target.js"));
  const { client, requests } = server(t, root, [{ message: "Reviewed" }]);
  const thread = await client.start();
  const result = await client.startTurn({ threadId: thread.id, prompt });
  assert.equal(result.message, JSON.stringify("Reviewed"), "Snapshot failure should preserve task execution");
  assert.equal(result.codeEvidence.status, "incomplete", "Snapshot failure should be recorded as an evidence limit");
  assert.match(result.codeEvidence.warnings.join(" "), /outside the repository/, "The audit should explain why the snapshot failed");
  assert.equal(requests.filter(request => request.method === "turn/start").length, 1, "The task should execute once without a usable snapshot");
});


test("all evidence phases preserve the original contract and structured task request", async t => {
  const { root, prompt, plan } = await fixture(t);
  const observations = [];
  const knowledge = { beforeTurn: async request => { observations.push(request); }, capture: async () => {} };
  const { client } = server(t, root, [
    { message: plan }, { message: approval }, { message: "Updated" }, { message: approval },
  ], knowledge);
  const thread = await client.start();
  await client.startTurn({ threadId: thread.id, prompt: "Short transport pointer", knowledgeQuery: prompt,
    knowledgeRequest: { question: "Preserve the existing binding", taskType: "implement", paths: ["target.js"],
      symbols: ["value"], revision: plan.decisions[0].example.revision } });
  assert.equal(observations.length, 4, "All four evidence phases should retrieve for the task");
  for (const observation of observations) {
    assert.equal(observation.prompt, prompt, "Each phase should keep the complete original contract");
    assert.equal(observation.knowledgeRequest, observations[0].knowledgeRequest, "Each phase should reuse the same normalized task request");
    assert.equal(observation.knowledgeRequest.question, "Preserve the existing binding", "Workflow wrappers should not replace the task question");
    assert.deepEqual(observation.knowledgeRequest.paths, ["target.js"], "Each phase should retain the exact task path");
  }
});
