import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphCodexAppServer } from "../commands/graph/codex-app-server.mjs";

function childProcess(onRequest) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.stdin = { writable: true, write(text) {
    const request = JSON.parse(text);
    const result = onRequest(request, child) || (request.method === "thread/start" ? { thread: { id: "thread" } }
      : request.method === "threadSection/list" ? { data: [{ id: "section", name: "TB Console" }] } : {});
    queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ id: request.id, result }) + "\n"));
    return true;
  } };
  child.kill = () => child.emit("exit", 0);
  return child;
}
function completeTurn(child) {
  const turn = { id: "turn", status: "completed" };
  setImmediate(() => {
    for (const item of [
      { type: "commandExecution", command: "git show", aggregatedOutput: "Exact source evidence", exitCode: 0 },
      { type: "commandExecution", aggregatedOutput: "x".repeat(160000) },
      { type: "reasoning", text: "Private reasoning is excluded" },
      { type: "agentMessage", text: "ok" },
    ]) child.stdout.emit("data", JSON.stringify({ method: "item/completed", params: { turnId: turn.id, item } }) + "\n");
    child.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n");
  });
  return { turn };
}

test("the console retrieves before a turn and captures bounded evidence without private reasoning", async () => {
  const requests = [], captures = [];
  const knowledge = { beforeTurn: async ({ prompt }) => {
    assert.equal(prompt, "full original request");
    return { text: "A supplied historical claim", context: { repository: "tb-tools" } };
  }, capture: async record => captures.push(record) };
  const child = childProcess((request, child) => {
    requests.push(request);
    if (request.method === "turn/start") return completeTurn(child);
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", knowledge, spawnProcess: () => child });
  try {
    const thread = await client.start();
    const result = await client.startTurn({ threadId: thread.id, prompt: "short file pointer", knowledgeQuery: "full original request" });
    assert.equal(result.message, "ok");
    assert.match(requests.find(r => r.method === "turn/start").params.input[0].text, /A supplied historical claim/);
    assert.equal(captures[0].prompt, "full original request");
    assert.equal(captures[0].events.length, 1); assert.equal(captures[0].truncated, true);
    assert.equal(captures[0].events[0].output, "Exact source evidence");
    assert.doesNotMatch(JSON.stringify(captures), /Private reasoning/);
  } finally { client.close(); }
});

test("knowledge failures warn without changing a successful console result", async () => {
  const warnings = [], child = childProcess((request, child) => request.method === "turn/start" ? completeTurn(child) : undefined);
  const knowledge = { beforeTurn: async () => { throw new Error("index unavailable"); }, capture: async () => { throw new Error("disk unavailable"); } };
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", knowledge,
    onStderr: value => warnings.push(value), spawnProcess: () => child });
  try {
    const thread = await client.start();
    assert.equal((await client.startTurn({ threadId: thread.id, prompt: "task" })).message, "ok");
    assert.match(warnings.join("\n"), /index unavailable/); assert.match(warnings.join("\n"), /disk unavailable/);
  } finally { client.close(); }
});
