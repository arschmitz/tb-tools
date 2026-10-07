import { CODEX_MEMORY_ARGS } from "../commands/knowledge/instructions.mjs";
import { DEFAULT_AI_PROFILES } from "../commands/graph/ai-models.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createGraphCodexAppServer } from "../commands/graph/codex-app-server.mjs";
import { BACKGROUND_BROWSER_POLICY } from "../commands/graph/ai-writing.mjs";

test("new and follow-up turns receive the console browser instructions", async () => {
  const requests = [];
  const child = createAppServerChild(requests, request => {
    if (request.method !== "turn/start") return;
    const turn = { id: "browser-turn", status: "completed" };
    setImmediate(() => child.stdout.emit("data", JSON.stringify({
      method: "turn/completed", params: { turn },
    }) + "\n"));
    return { result: { turn } };
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/review/comm",
    spawnProcess: () => child, knowledge: false });
  try {
    await client.start();
    await client.startTurn({ threadId: "thread-1", prompt: "Check Storybook" });
    await client.steerTurn({ threadId: "thread-1", turnId: "browser-turn", prompt: "Check focus" });
    for (const method of ["turn/start", "turn/steer"]) {
      assert.ok(requests.find(request => request.method === method).params.input[0].text.includes("# Console knowledge instructions"));
      assert.ok(requests.find(request => request.method === method).params.input[0].text
        .includes(BACKGROUND_BROWSER_POLICY));
    }
  } finally { client.close(); }
});

test("task routing selects an available model and records usage without prompt contents", async () => {
  const requests = [], usage = [];
  const child = createAppServerChild(requests, (request, process) => {
    if (request.method === "model/list") return { result: { data: [
      { id: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
      { id: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    ] } };
    if (request.method === "turn/start") {
      const turn = { id: "policy-turn", status: "completed" };
      setImmediate(() => {
        process.stdout.emit("data", JSON.stringify({ method: "thread/tokenUsage/updated", params: {
          threadId: "thread-1", tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 20 } },
        } }) + "\n");
        process.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n");
      });
      return { result: { turn } };
    }
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm", spawnProcess: () => child, getAiProfiles: () => DEFAULT_AI_PROFILES, saveUsage: async record => usage.push(record) });
  try {
    await client.start();
    await client.startTurn({ threadId: "thread-1", prompt: "Private task text", task: "edit" });
    const params = requests.find(request => request.method === "turn/start").params;
    assert.equal(params.model, "gpt-6-sol");
    assert.equal(params.effort, "medium");
    assert.equal(usage[0].tokenUsage.total.inputTokens, 1000);
    assert.equal(usage[0].promptCharacters, params.input[0].text.length);
    assert.ok(!JSON.stringify(usage).includes("Private task text"));
  } finally { client.close(); }
});

function createAppServerChild(requests, respond) {
  const child = new EventEmitter();

  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = {
    writable: true,
    write(value) {
      const request = JSON.parse(value);

      requests.push(request);
      const result = ["thread/start", "thread/resume"].includes(request.method)
        ? { thread: { id: request.params.threadId || "thread-1" } }
        : request.method === "threadSection/list"
          ? { data: [{ id: "console-section", name: "TB Console" }], nextCursor: null }
          : {};
      const response = respond?.(request, child) ?? { result };
      queueMicrotask(() => child.stdout.emit(
        "data",
        `${JSON.stringify({ id: request.id, ...response })}\n`,
      ));
      return true;
    },
  };
  child.kill = () => child.emit("exit", 0);
  return child;
}

test("knowledge injection captures evidence without changing the task result", async () => {
  const requests = [], captures = [];
  const knowledge = {
    beforeTurn: async ({ prompt }) => {
      assert.equal(prompt, "Original full request");
      return { text: "Historical evidence only", context: { repository: "thunderbird" } };
    },
    capture: async value => captures.push(value),
  };
  const child = createAppServerChild(requests, request => {
    if (request.method !== "turn/start") return;
    const turn = { id: "memory-turn", status: "completed" };
    setImmediate(() => {
      for (const notification of [
        { method: "item/completed", params: { turnId: turn.id, item: { type: "commandExecution", command: "git show", aggregatedOutput: "Exact source", exitCode: 0 } } },
        { method: "item/completed", params: { turnId: turn.id, item: { type: "reasoning", text: "Never record reasoning" } } },
        { method: "item/completed", params: { turnId: turn.id, item: { type: "agentMessage", text: '{"result":"ok"}' } } },
        { method: "turn/completed", params: { turn } },
      ]) child.stdout.emit("data", JSON.stringify(notification) + "\n");
    });
    return { result: { turn } };
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", knowledge, spawnProcess: () => child });
  try {
    await client.start();
    const result = await client.startTurn({ threadId: "thread-1", prompt: "Request file pointer", knowledgeQuery: "Original full request" });
    assert.equal(result.message, '{"result":"ok"}');
    assert.match(requests.find(r => r.method === "turn/start").params.input[0].text, /Historical evidence only/);
    assert.equal(captures[0].prompt, "Original full request");
    assert.equal(captures[0].events[0].output, "Exact source");
    assert.ok(!JSON.stringify(captures).includes("Never record reasoning"));
  } finally { client.close(); }
});

test("knowledge failures do not fail an AI turn", async () => {
  const requests = [], warnings = [];
  const child = createAppServerChild(requests, request => {
    if (request.method !== "turn/start") return;
    const turn = { id: "failure-test", status: "completed" };
    setImmediate(() => child.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n"));
    return { result: { turn } };
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", spawnProcess: () => child,
    knowledge: { beforeTurn: async () => { throw new Error("index unavailable"); }, capture: async () => { throw new Error("disk unavailable"); } },
    onStderr: value => warnings.push(value) });
  try {
    await client.start();
    assert.equal((await client.startTurn({ prompt: "task", threadId: "thread-1" })).turn.status, "completed");
    assert.match(requests.find(r => r.method === "turn/start").params.input[0].text, /^task\n\nKeep browser work hidden/);
    assert.match(warnings.join("\n"), /index unavailable/);
    assert.match(warnings.join("\n"), /disk unavailable/);
  } finally { client.close(); }
});

test("Codex app-server names explicitly named threads after creating them", async () => {
  const requests = [];
  const child = createAppServerChild(requests);
  const client = createGraphCodexAppServer({
    command: "codex",
    cwd: "/work/comm",
    threadName: "D320328 - Update 2026-09-08 14:37",
    spawnProcess(command, args, options) {
      assert.equal(command, "codex");
      assert.deepEqual(args, ["app-server", "--stdio", ...CODEX_MEMORY_ARGS]);
      assert.equal(options.env.AUTOCLOBBER, "1");
      assert.equal(options.cwd, "/work/comm");
      return child;
    },
  });

  const thread = await client.start();

  assert.deepEqual(thread, { id: "thread-1" });
  assert.deepEqual(
    requests.map(({ method, params }) => ({ method, params })),
    [
      {
        method: "initialize",
        params: {
          clientInfo: { name: "tb-tools", version: "1.0" },
          capabilities: { experimentalApi: true },
        },
      },
      {
        method: "thread/start",
        params: {
          approvalPolicy: "never",
          cwd: "/work/comm",
          sandbox: "danger-full-access",
        },
      },
      { method: "thread/memoryMode/set", params: { threadId: "thread-1", mode: "disabled" } },
      {
        method: "thread/name/set",
        params: {
          name: "D320328 - Update 2026-09-08 14:37",
          threadId: "thread-1",
        },
      },
      { method: "threadSection/list", params: { limit: 100 } },
      { method: "thread/section/move", params: { threadId: "thread-1", sectionId: "console-section" } },
    ],
  );

  client.close();
});

test("Codex app-server leaves unnamed threads untouched", async () => {
  const requests = [];
  const child = createAppServerChild(requests);
  const client = createGraphCodexAppServer({
    command: "codex",
    cwd: "/work/review",
    spawnProcess: () => child,
  });

  await client.start();

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["initialize", "thread/start", "thread/memoryMode/set", "threadSection/list", "thread/section/move"],
  );

  client.close();
});

test("Codex resumes the saved thread without creating or renaming one", async () => {
  const requests = [];
  const client = createGraphCodexAppServer({
    command: "codex", cwd: "/work/comm", threadId: "saved-thread", threadName: "Old name",
    spawnProcess: () => createAppServerChild(requests),
  });
  assert.equal((await client.start()).id, "saved-thread");
  assert.deepEqual(requests.map(({ method }) => method), ["initialize", "thread/resume", "thread/memoryMode/set", "threadSection/list", "thread/section/move"]);
  assert.equal(requests[1].params.cwd, "/work/comm");
  assert.equal(requests[1].params.threadId, "saved-thread");
  client.close();
});

test("Codex resolution sessions use a read-only sandbox", async () => {
  const { startGraphCodexAppServer } = await import("../commands/graph/codex-app-server.mjs");
  const requests = [];
  const { client } = await startGraphCodexAppServer({
    command: "codex", cwd: "/work/comm", sandbox: "read-only",
    spawnProcess: () => createAppServerChild(requests),
  });
  assert.equal(requests.find(request => request.method === "thread/start").params.sandbox, "read-only");
  client.close();
});

function lifecycleClient({ archived = false, status = "completed", failRestore = false, failArchive = false } = {}) {
  const requests = [], warnings = [];
  let turnCount = 0;
  const child = createAppServerChild(requests, (request, process) => {
    if (["thread/resume", "turn/start"].includes(request.method) && archived) {
      return { error: { code: -32600, message: "session saved-thread is archived. Unarchive it first." } };
    }
    if (request.method === "thread/unarchive") {
      if (failRestore) return { error: { message: "Could not restore rollout" } };
      archived = false;
    }
    if (request.method === "thread/archive") {
      if (failArchive) return { error: { message: "Archive unavailable" } };
      archived = true;
    }
    if (request.method === "turn/start") {
      const turn = { id: `turn-${++turnCount}`, status };
      setImmediate(() => process.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n"));
      return { result: { turn } };
    }
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm", threadId: "saved-thread",
    spawnProcess: () => child, onStderr: message => warnings.push(message) });
  return { client, requests, warnings };
}

test("console restores an archived saved conversation before resuming, without creating a chat", async () => {
  const { client, requests } = lifecycleClient({ archived: true });
  try {
    assert.equal((await client.start()).id, "saved-thread");
    assert.deepEqual(requests.slice(0, 4).map(r => r.method), ["initialize", "thread/resume", "thread/unarchive", "thread/resume"]);
    assert.equal(requests.some(r => r.method === "thread/start"), false);
  } finally { client.close(); }
});

test("completed turns archive and the next turn restores the same conversation", async () => {
  const { client, requests } = lifecycleClient();
  try {
    await client.start();
    await client.startTurn({ threadId: "saved-thread", prompt: "Inspect the patch" });
    await client.startTurn({ threadId: "saved-thread", prompt: "Address the first finding" });
    const methods = requests.map(r => r.method);
    assert.deepEqual(methods.slice(methods.indexOf("turn/start")), ["turn/start", "thread/archive", "thread/resume", "thread/unarchive", "thread/resume", "turn/start", "thread/archive"]);
    assert.ok(requests.filter(r => r.method.startsWith("turn/") || ["thread/archive", "thread/unarchive", "thread/resume"].includes(r.method))
      .every(r => r.params.threadId === "saved-thread"));
    await client.steerTurn({ threadId: "saved-thread", turnId: "turn-2", prompt: "Check the linked page" });
    const turns = requests.filter(r => ["turn/start", "turn/steer"].includes(r.method));
    assert.equal(turns.length, 3);
    for (const request of turns) {
      assert.match(request.params.input[0].text, /Do not open, show, select, or focus visible browser tabs or windows/);
      assert.match(request.params.input[0].text, /Never use a visible browser as a fallback/);
    }
  } finally { client.close(); }
});

for (const status of ["failed", "interrupted"]) {
  test(`${status} turns stay visible`, async () => {
    const { client, requests } = lifecycleClient({ status });
    try {
      await client.start();
      assert.equal((await client.startTurn({ threadId: "saved-thread", prompt: "Inspect" })).turn.status, status);
      assert.equal(requests.some(r => r.method === "thread/archive"), false);
    } finally { client.close(); }
  });
}

test("archive failure preserves a successful AI result", async () => {
  const { client, warnings } = lifecycleClient({ failArchive: true });
  try {
    await client.start();
    assert.equal((await client.startTurn({ threadId: "saved-thread", prompt: "Inspect" })).turn.status, "completed");
    assert.match(warnings[0], /Could not archive/);
  } finally { client.close(); }
});

test("restore failure leaves the saved chat intact and fails instead of starting a replacement", async () => {
  const { client, requests } = lifecycleClient({ archived: true, failRestore: true });
  try {
    await assert.rejects(client.start(), { code: "ARCHIVED_THREAD_RESTORE_FAILED" });
    assert.equal(requests.some(r => r.method === "thread/start"), false);
  } finally { client.close(); }
});

test("section lookup pages before creating a section", async () => {
  const requests = [];
  const child = createAppServerChild(requests, request => {
    if (request.method === "threadSection/list") return { result: request.params.cursor
      ? { data: [{ id: "existing", name: "TB Console" }], nextCursor: null }
      : { data: [], nextCursor: "next" } };
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm", spawnProcess: () => child });
  try {
    await client.start();
    assert.equal(requests.some(r => r.method === "threadSection/create"), false);
    assert.equal(requests.at(-1).params.sectionId, "existing");
  } finally { client.close(); }
});

test("console creates its section when missing and puts a new chat there", async () => {
  const requests = [];
  const child = createAppServerChild(requests, request => {
    if (request.method === "threadSection/list") return { result: { data: [], nextCursor: null } };
    if (request.method === "threadSection/create") return { result: { section: { id: "created", name: "TB Console" } } };
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm", spawnProcess: () => child });
  try {
    await client.start();
    assert.equal(requests.find(r => r.method === "threadSection/create").params.name, "TB Console");
    assert.deepEqual(requests.at(-1).params, { threadId: "thread-1", sectionId: "created" });
  } finally { client.close(); }
});

test("an older Codex without section support still starts and reports the grouping failure", async () => {
  const warnings = [], requests = [];
  const child = createAppServerChild(requests, request => request.method === "threadSection/list"
    ? { error: { message: "Unknown method" } } : undefined);
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm",
    spawnProcess: () => child, onStderr: message => warnings.push(message) });
  try {
    assert.equal((await client.start()).id, "thread-1");
    assert.match(warnings[0], /Could not group/);
  } finally { client.close(); }
});

test("console does not unarchive twice when the user already restored the chat", async () => {
  const requests = [];
  let turnCount = 0;
  const child = createAppServerChild(requests, (request, process) => {
    if (request.method === "turn/start") {
      const turn = { id: `turn-${++turnCount}`, status: "completed" };
      setImmediate(() => process.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n"));
      return { result: { turn } };
    }
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm", threadId: "saved-thread", spawnProcess: () => child });
  try {
    await client.start();
    await client.startTurn({ threadId: "saved-thread", prompt: "First" });
    await client.startTurn({ threadId: "saved-thread", prompt: "Second" });
    assert.equal(requests.some(r => r.method === "thread/unarchive"), false);
    assert.equal(turnCount, 2);
  } finally { client.close(); }
});

test("Codex lists model pages and sends explicit model and reasoning on turns", async () => {
  const requests = [];
  const child = createAppServerChild(requests, (request, process) => {
    if (request.method === "model/list") return { result: { data: [{ id: request.params.cursor ? "gpt-6-astra" : "gpt-6-sol" }], nextCursor: request.params.cursor ? null : "page-2" } };
    if (request.method === "turn/start") {
      const turn = { id: "model-turn", status: "completed" };
      setImmediate(() => process.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n"));
      return { result: { turn } };
    }
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work/comm", spawnProcess: () => child });
  try {
    await client.start();
    assert.deepEqual((await client.listModels()).map(model => model.id), ["gpt-6-sol", "gpt-6-astra"]);
    await client.startTurn({ threadId: "thread-1", prompt: "Implement", model: "gpt-6-astra", effort: "xhigh" });
    assert.equal(requests.find(request => request.method === "turn/start").params.model, "gpt-6-astra");
    assert.equal(requests.find(request => request.method === "turn/start").params.effort, "xhigh");
  } finally { client.close(); }
});


test("model catalog loads without creating a conversation or starting an AI turn", async () => {
  const requests = [];
  const child = createAppServerChild(requests, request => {
    if (request.method === "model/list") return { result: { data: [{ id: "gpt-6-sol" }] } };
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", spawnProcess: () => child });
  try {
    assert.equal((await client.listModels())[0].id, "gpt-6-sol");
    assert.deepEqual(requests.map(request => request.method), ["initialize", "model/list"]);
  } finally { client.close(); }
});

test("a resumed AI task uses updated settings on its next turn", async () => {
  const requests = [];
  let profile = { model: "gpt-6-sol", effort: "medium" };
  let turns = 0;
  const child = createAppServerChild(requests, (request, process) => {
    if (request.method === "model/list") return { result: { data: [
      { id: "gpt-6-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
      { id: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    ] } };
    if (request.method === "turn/start") {
      const turn = { id: `settings-${++turns}`, status: "completed" };
      setImmediate(() => process.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: { turn } }) + "\n"));
      return { result: { turn } };
    }
  });
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", spawnProcess: () => child,
    knowledge: false, getAiProfiles: () => ({ review: profile }) });
  try {
    await client.start();
    await client.startTurn({ threadId: "thread-1", prompt: "Review", task: "review" });
    profile = { model: "gpt-6-astra", effort: "high" };
    await client.startTurn({ threadId: "thread-1", prompt: "Continue", task: "review" });
    assert.deepEqual(requests.filter(request => request.method === "turn/start").map(request =>
      ({ model: request.params.model, effort: request.params.effort })), [
      { model: "gpt-6-sol", effort: "medium" }, { model: "gpt-6-astra", effort: "high" },
    ]);
    profile = { model: "gpt-6-astra", effort: "max" };
    await assert.rejects(client.startTurn({ threadId: "thread-1", prompt: "Continue", task: "review" }), /Settings/);
    assert.equal(turns, 2);
  } finally { client.close(); }
});


test("console refuses a task when native memory exclusion fails", async () => {
  const requests = [];
  const child = createAppServerChild(requests, request => request.method === "thread/memoryMode/set"
    ? { error: { message: "Memory mode unavailable" } } : undefined);
  const client = createGraphCodexAppServer({ command: "codex", cwd: "/work", spawnProcess: () => child });
  try {
    await assert.rejects(client.start(), /Memory mode unavailable/);
    assert.ok(!requests.some(request => request.method === "turn/start"));
  } finally { client.close(); }
});
