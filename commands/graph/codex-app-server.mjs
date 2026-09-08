import { spawn as defaultSpawn } from "node:child_process";

const APP_SERVER_STARTUP_TIMEOUT_MS = 30 * 1000;

function toError(value, fallback = "Codex App Server request failed.") {
  const error = new Error(value?.message || fallback);

  error.code = value?.code;
  return error;
}

export function createGraphCodexAppServer({
  command,
  cwd,
  threadName = "",
  onNotification,
  onStderr,
  spawnProcess = defaultSpawn,
}) {
  const child = spawnProcess(command, ["app-server", "--stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const completedTurns = new Map();
  const messages = new Map();
  const waiters = new Map();
  let nextRequestId = 1;
  let stdoutBuffer = "";
  let closed = false;

  const rejectPending = (error) => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();

    for (const { reject } of waiters.values()) {
      reject(error);
    }
    waiters.clear();
  };
  const resolveTurn = (turn) => {
    const turnId = turn?.id;

    if (!turnId) {
      return;
    }

    const result = {
      message: messages.get(turnId) || "",
      turn,
    };
    const waiter = waiters.get(turnId);

    if (waiter) {
      waiters.delete(turnId);
      waiter.resolve(result);
    } else {
      completedTurns.set(turnId, result);
    }
  };
  const handleNotification = (message) => {
    onNotification?.(message);
    const params = message.params || {};

    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const current = messages.get(params.turnId) || "";

      messages.set(params.turnId, params.item.text || current);
    }

    if (message.method === "turn/completed") {
      resolveTurn(params.turn);
    }
  };
  const handleMessage = (message) => {
    if (Object.hasOwn(message, "id") && pending.has(message.id)) {
      const { reject, resolve } = pending.get(message.id);

      pending.delete(message.id);
      if (message.error) {
        reject(toError(message.error));
      } else {
        resolve(message.result);
      }
      return;
    }

    if (message.method) {
      handleNotification(message);
    }
  };
  const request = (method, params) => {
    if (closed || !child.stdin.writable) {
      return Promise.reject(new Error("Codex App Server is not running."));
    }

    const id = nextRequestId++;

    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };
  const waitForTurn = (turnId) => {
    if (completedTurns.has(turnId)) {
      const result = completedTurns.get(turnId);

      completedTurns.delete(turnId);
      return Promise.resolve(result);
    }

    return new Promise((resolve, reject) => {
      waiters.set(turnId, { resolve, reject });
    });
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);

    stdoutBuffer = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        onStderr?.(`Could not parse Codex App Server output: ${error.message}`);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => onStderr?.(chunk));
  child.on("error", (error) => {
    closed = true;
    rejectPending(error);
  });
  child.on("exit", (code, signal) => {
    if (closed) {
      return;
    }

    closed = true;
    rejectPending(toError(
      { message: `Codex App Server exited ${signal ? `with signal ${signal}` : `with code ${code}`}.` },
    ));
  });

  return {
    async start() {
      await request("initialize", {
        clientInfo: { name: "tb-tools", version: "1.0" },
        capabilities: {},
      });
      const result = await request("thread/start", {
        approvalPolicy: "never",
        cwd,
        sandbox: "danger-full-access",
      });
      const thread = result.thread;
      const name = String(threadName || "").trim();

      if (name && thread?.id) {
        await request("thread/name/set", {
          name,
          threadId: thread.id,
        });
      }

      return thread;
    },
    async startTurn({ prompt, threadId, onTurnStarted }) {
      const result = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
      });
      const turn = result.turn;

      onTurnStarted?.(turn.id);
      return waitForTurn(turn.id);
    },
    async steerTurn({ prompt, threadId, turnId }) {
      return request("turn/steer", {
        expectedTurnId: turnId,
        input: [{ type: "text", text: prompt }],
        threadId,
      });
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      child.kill("SIGTERM");
    },
  };
}

export async function startGraphCodexAppServer({
  command,
  cwd,
  threadName,
  onNotification,
  onStderr,
  spawnProcess,
}) {
  const client = createGraphCodexAppServer({
    command,
    cwd,
    threadName,
    onNotification,
    onStderr,
    spawnProcess,
  });
  const thread = await Promise.race([
    client.start(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Codex App Server did not start in time."));
      }, APP_SERVER_STARTUP_TIMEOUT_MS);

      timer.unref?.();
    }),
  ]).catch((error) => {
    client.close();
    throw error;
  });

  return { client, thread };
}
