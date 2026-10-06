import { CODEX_MEMORY_ARGS, knowledgeInstructions } from "../knowledge/instructions.mjs";
import { consoleKnowledgeDirectory, consoleKnowledgeRepository, getDefaultKnowledgeService } from "../knowledge-service.mjs";
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
  knowledge,
}) {
  const child = spawnProcess(command, ["app-server", "--stdio", ...CODEX_MEMORY_ARGS], {
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
  let knowledgeService;
  const evidenceByTurn = new Map();

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
    if (knowledgeService && message.method === "item/completed" &&
        ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(params.item?.type)) {
      const evidence = evidenceByTurn.get(params.turnId) || { events: [], size: 0, truncated: false };
      const item = params.item;
      const event = { type: item.type, command: item.command, output: item.aggregatedOutput,
        exitCode: item.exitCode, changes: item.changes, server: item.server, tool: item.tool,
        arguments: item.arguments, result: item.result, query: item.query };
      const text = JSON.stringify(event);
      if (evidence.size + text.length <= 160_000) { evidence.events.push(event); evidence.size += text.length; }
      else evidence.truncated = true;
      evidenceByTurn.set(params.turnId, evidence);
    }


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
        capabilities: { experimentalApi: true },
      });
      const result = await request("thread/start", {
        approvalPolicy: "never",
        cwd,
        sandbox: "danger-full-access",
      });
      const thread = result.thread;
      await request("thread/memoryMode/set", { threadId: thread.id, mode: "disabled" });
      const name = String(threadName || "").trim();

      if (name && thread?.id) {
        await request("thread/name/set", {
          name,
          threadId: thread.id,
        });
      }

      return thread;
    },
    async startTurn({ prompt, threadId, onTurnStarted, task, knowledgeQuery = prompt }) {
      let memory;
      try {
        knowledgeService = knowledge === false ? null : knowledge || await getDefaultKnowledgeService();
        memory = await knowledgeService?.beforeTurn({ cwd, prompt: knowledgeQuery, task });
      } catch (error) { onStderr?.(`Knowledge retrieval unavailable: ${error.message}\n`); }
      const context = memory?.text ? `${prompt}\n\n${memory.text}` : prompt;
      const input = `${context}\n\n${knowledgeInstructions(knowledgeService?.store?.directory || consoleKnowledgeDirectory(), consoleKnowledgeRepository())}`;
      const result = await request("turn/start", { threadId, input: [{ type: "text", text: input }] });
      const turn = result.turn;
      onTurnStarted?.(turn.id);
      const completed = await waitForTurn(turn.id);
      try {
        await knowledgeService?.capture({ context: memory?.context, prompt: knowledgeQuery,
          message: completed.message, task, threadId, turnId: turn.id, status: completed.turn?.status,
          ...evidenceByTurn.get(turn.id) });
      } catch (error) { onStderr?.(`Could not save knowledge evidence: ${error.message}\n`); }
      evidenceByTurn.delete(turn.id);
      return completed;
    },
    async steerTurn({ prompt, threadId, turnId }) {
      if (knowledgeService) {
        const evidence = evidenceByTurn.get(turnId) || { events: [], size: 0, truncated: false };
        if (evidence.size + prompt.length <= 160_000) {
          evidence.events.push({ type: "user-followup", text: prompt }); evidence.size += prompt.length;
        } else evidence.truncated = true;
        evidenceByTurn.set(turnId, evidence);
      }

      return request("turn/steer", {
        expectedTurnId: turnId,
        input: [{ type: "text", text: `${prompt}\n\n${knowledgeInstructions(knowledgeService?.store?.directory || consoleKnowledgeDirectory(), consoleKnowledgeRepository())}` }],
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
  knowledge,
}) {
  const client = createGraphCodexAppServer({
    command,
    cwd,
    threadName,
    onNotification,
    onStderr,
    spawnProcess,
    knowledge,
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
