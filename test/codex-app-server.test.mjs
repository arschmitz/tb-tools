import { CODEX_MEMORY_ARGS } from "../commands/knowledge/instructions.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createGraphCodexAppServer } from "../commands/graph/codex-app-server.mjs";

function createAppServerChild(requests) {
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
      const result = request.method === "thread/start"
        ? { thread: { id: "thread-1" } }
        : {};
      queueMicrotask(() => child.stdout.emit(
        "data",
        `${JSON.stringify({ id: request.id, result })}\n`,
      ));
      return true;
    },
  };
  child.kill = () => child.emit("exit", 0);
  return child;
}

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
    ["initialize", "thread/start", "thread/memoryMode/set"],
  );

  client.close();
});
