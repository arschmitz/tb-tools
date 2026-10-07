import { CODEX_MEMORY_ARGS, knowledgeInstructions } from "../knowledge/instructions.mjs";
import { consoleKnowledgeDirectory, consoleKnowledgeRepository } from "../knowledge-service.mjs";
import { BACKGROUND_BROWSER_POLICY } from "./ai-writing.mjs";
import { getTbToolsCommandEnvironment } from "../../lib/utils.mjs";
import { spawn as defaultSpawn } from "node:child_process";
import { readAiProfiles, selectAiModel } from "./ai-models.mjs";
import { recordAiUsage } from "./ai-usage.mjs";
import { getDefaultKnowledgeService } from "../knowledge-service.mjs";

const APP_SERVER_STARTUP_TIMEOUT_MS = 30 * 1000;
const CONSOLE_SECTION_NAME = "TB Console";

function toError(value, fallback = "Codex App Server request failed.") {
  const error = new Error(value?.message || fallback);

  error.code = value?.code;
  return error;
}

export function createGraphCodexAppServer({
  command,
  cwd,
  env = {},
  sandbox = "danger-full-access",
  threadName = "",
  threadId = "",
  onNotification,
  onStderr,
  spawnProcess = defaultSpawn,
  saveUsage = recordAiUsage,
  knowledge,
  getAiProfiles = readAiProfiles,
}) {
  const child = spawnProcess(command, ["app-server", "--stdio", ...CODEX_MEMORY_ARGS], {
    cwd,
    env: getTbToolsCommandEnvironment({ ...process.env, ...env }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const completedTurns = new Map();
  const messages = new Map();
  const waiters = new Map();
  let nextRequestId = 1;
  let stdoutBuffer = "";
  let closed = false;
  const archivedThreads = new Set();
  let availableModels;
  let tokenUsage;
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
    if (message.method === "thread/tokenUsage/updated") tokenUsage = params.tokenUsage;

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
  const resumeParams = (id) => ({ threadId: id, approvalPolicy: "never", cwd, sandbox });
  const restoreThread = async (id) => {
    // Restore the original rollout. Never replace an archived conversation.
    try {
      await request("thread/unarchive", { threadId: id });
      const result = await request("thread/resume", resumeParams(id));
      archivedThreads.delete(id);
      return result;
    } catch (error) {
      const failure = new Error(`Could not restore archived Codex chat ${id}: ${error.message}`);
      failure.code = "ARCHIVED_THREAD_RESTORE_FAILED";
      throw failure;
    }
  };
  const resumeThread = async (id) => {
    try {
      const result = await request("thread/resume", resumeParams(id));
      archivedThreads.delete(id);
      return result;
    } catch (error) {
      if (!/\bis archived\b/i.test(error.message)) throw error;
      return restoreThread(id);
    }
  };
  const groupThread = async (thread) => {
    if (thread.section?.name === CONSOLE_SECTION_NAME) return;
    try {
      let section;
      let cursor;
      do {
        const page = await request("threadSection/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        section = page.data.find(entry => entry.name === CONSOLE_SECTION_NAME);
        cursor = page.nextCursor;
      } while (!section && cursor);
      if (!section) {
        ({ section } = await request("threadSection/create", { name: CONSOLE_SECTION_NAME }));
      }
      await request("thread/section/move", { threadId: thread.id, sectionId: section.id });
    } catch (error) {
      onStderr?.(`Could not group the Codex chat in ${CONSOLE_SECTION_NAME}: ${error.message}\n`);
    }
  };
  const archiveThread = async (id) => {
    try {
      await request("thread/archive", { threadId: id });
      archivedThreads.add(id);
    } catch (error) {
      // Sidebar cleanup must not hide a successful AI result.
      onStderr?.(`Could not archive the completed Codex chat: ${error.message}\n`);
    }
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

  let initialization;
  const initialize = () => initialization ||= request("initialize", {
    clientInfo: { name: "tb-tools", version: "1.0" },
    capabilities: { experimentalApi: true },
  });

  return {
    get pid() { return child.pid; },
    async start() {
      await initialize();
      const result = threadId ? await resumeThread(threadId) : await request("thread/start", {
        approvalPolicy: "never",
        cwd,
        sandbox,
      });
      const thread = result.thread;
      await request("thread/memoryMode/set", { threadId: thread.id, mode: "disabled" });
      const name = String(threadName || "").trim();

      if (name && thread?.id && !threadId) {
        await request("thread/name/set", {
          name,
          threadId: thread.id,
        });
      }

      await groupThread(thread);
      return thread;
    },
    async listModels() {
      await initialize();
      const models = [];
      let cursor;
      do {
        const page = await request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        models.push(...(page.data || []));
        cursor = page.nextCursor;
      } while (cursor);
      return models;
    },
    async startTurn({ prompt, threadId, onTurnStarted, model, effort, task, knowledgeQuery = prompt }) {
      let memory;
      try {
        knowledgeService = knowledge === false ? null : knowledge || await getDefaultKnowledgeService();
        memory = await knowledgeService?.beforeTurn({ cwd, prompt: knowledgeQuery, task });
      } catch (error) { onStderr?.(`Knowledge retrieval unavailable: ${error.message}\n`); }
      if (task && !model) {
        availableModels ||= await this.listModels();
        const selected = selectAiModel(availableModels, task, getAiProfiles());
        model = selected.model;
        effort = selected.effort;
      }
      if (archivedThreads.has(threadId)) await resumeThread(threadId);
      tokenUsage = undefined;
      let result;
      const context = memory?.text ? `${prompt}\n\n${memory.text}` : prompt;
      const input = `${context}\n\n${BACKGROUND_BROWSER_POLICY}\n\n${knowledgeInstructions(knowledgeService?.store?.directory || consoleKnowledgeDirectory(), consoleKnowledgeRepository())}`;
      const params = { threadId, input: [{ type: "text", text: input }],
        ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      try {
        result = await request("turn/start", params);
      } catch (error) {
        // The desktop app can also archive an idle chat between console turns.
        if (!/\bis archived\b/i.test(error.message)) throw error;
        await restoreThread(threadId);
        result = await request("turn/start", params);
      }
      const turn = result.turn;

      onTurnStarted?.(turn.id);
      const completed = await waitForTurn(turn.id);
      if (tokenUsage) {
        try { await saveUsage({ threadId, turnId: turn.id, task, model, effort,
          promptCharacters: input.length, memoryCharacters: memory?.text?.length || 0, tokenUsage }); }
        catch (error) { onStderr?.(`Could not save AI usage: ${error.message}`); }
      }
      try {
        await knowledgeService?.capture({ context: memory?.context, prompt: knowledgeQuery,
          message: completed.message, task, threadId, turnId: turn.id, status: completed.turn?.status,
          ...evidenceByTurn.get(turn.id) });
      } catch (error) { onStderr?.(`Could not save knowledge evidence: ${error.message}\n`); }
      evidenceByTurn.delete(turn.id);
      if (completed.turn?.status === "completed") await archiveThread(threadId);
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
        input: [{ type: "text", text: `${prompt}\n\n${BACKGROUND_BROWSER_POLICY}\n\n${knowledgeInstructions(knowledgeService?.store?.directory || consoleKnowledgeDirectory(), consoleKnowledgeRepository())}` }],
        threadId,
      });
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      rejectPending(new Error("Codex App Server was stopped. The saved session can be resumed."));
      child.kill("SIGTERM");
    },
  };
}

export async function startGraphCodexAppServer({
  command,
  cwd,
  env = {},
  threadName,
  sandbox,
  threadId,
  onNotification,
  onStderr,
  spawnProcess,
  knowledge,
}) {
  const client = createGraphCodexAppServer({
    command,
    cwd,
    env,
    threadName,
    sandbox,
    threadId,
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
