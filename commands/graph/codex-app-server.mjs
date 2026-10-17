import { normalizeKnowledgeRequest } from "../knowledge/task-query.mjs";
import { CODEX_MEMORY_ARGS, knowledgeInstructions } from "../knowledge/instructions.mjs";
import { consoleKnowledgeDirectory, consoleKnowledgeRepository } from "../knowledge-service.mjs";
import { BACKGROUND_BROWSER_POLICY } from "./ai-writing.mjs";
import { getConsoleBrowserEnvironment } from "./ai-browser-access.mjs";
import { getTbToolsCommandEnvironment } from "../../lib/utils.mjs";
import { spawn as defaultSpawn } from "node:child_process";
import { readAiProfiles, selectAiModel } from "./ai-models.mjs";
import { recordAiUsage } from "./ai-usage.mjs";
import { getDefaultKnowledgeService } from "../knowledge-service.mjs";

import {
  evidenceRepository, snapshotCodeEvidence, changedEvidencePaths,
  validateCodeEvidence, verifyEvidenceCitations, parseEvidenceJson,
  evidencePreparationPrompt, evidenceReviewPrompt, requireEvidenceApproval,
  evidenceError,
} from "../knowledge/code-evidence.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
    env: getTbToolsCommandEnvironment({ ...process.env, ...getConsoleBrowserEnvironment(), ...env }),
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

  const readOnlyPolicy = { type: "readOnly", networkAccess: true };
  const activeEvidence = new Map();
  const executeTurn = async ({ prompt, threadId, onTurnStarted, model, effort, task, knowledgeQuery = prompt, knowledgeRequest, sandboxPolicy, archive = true }) => {
      let memory;
      try {
        knowledgeService = knowledge === false ? null : knowledge || await getDefaultKnowledgeService();
        memory = await knowledgeService?.beforeTurn({ cwd, prompt: knowledgeQuery, task, knowledgeRequest });
      } catch (error) { onStderr?.(`Knowledge retrieval unavailable: ${error.message}\n`); }
      if (task && !model) {
        availableModels ||= await clientApi.listModels();
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
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        ...(sandboxPolicy ? { sandboxPolicy } : {}) };
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
          retrievalIds: memory?.ids || [],
          ...evidenceByTurn.get(turn.id) });
      } catch (error) { onStderr?.(`Could not save knowledge evidence: ${error.message}\n`); }
      evidenceByTurn.delete(turn.id);
      if (archive && completed.turn?.status === "completed") await archiveThread(threadId);
      return completed;
  };

  const clientApi = {
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
    async startTurn(args) {
      const original = args.knowledgeQuery ?? args.prompt;
      args = { ...args, knowledgeQuery: original, knowledgeRequest: normalizeKnowledgeRequest(args.knowledgeRequest, { question: original, taskType: args.task }) };
      const state = { phase: "preparation", interrupted: false, followups: [] };
      const audit = { status: "incomplete", warnings: [], changedPaths: [] };
      activeEvidence.set(args.threadId, state);
      let checker;
      const collect = async operation => {
        try {
          return await operation();
        } catch (error) {
          audit.warnings.push(error.message);
          onStderr?.(`Code evidence collection incomplete: ${error.message}\n`);
          return null;
        }
      };
      const runPhase = phaseArgs => executeTurn({ ...phaseArgs, onTurnStarted(id) {
        state.activeThread = phaseArgs.threadId;
        state.activeTurn = id;
        args.onTurnStarted?.(id);
      } });
      const checkCancellation = () => {
        if (state.interrupted) throw new Error("The task was interrupted.");
      };
      try {
        const root = await collect(() => evidenceRepository(cwd));
        const baseline = root && await collect(() => snapshotCodeEvidence(root));
        let evidence;
        let originals;
        if (baseline) {
          evidence = await collect(async () => {
            const preparation = await runPhase({ ...args, archive: false,
              prompt: evidencePreparationPrompt(original), sandboxPolicy: readOnlyPolicy });
            checkCancellation();
            if (preparation.turn?.status !== "completed") throw evidenceError("Preparation did not complete.");
            audit.plan = parseEvidenceJson(preparation.message);
            const preparedState = await snapshotCodeEvidence(root);
            if (baseline.head !== preparedState.head || (await changedEvidencePaths(baseline, preparedState)).length) {
              throw evidenceError("Source changed during read-only preparation. The changes are retained.");
            }
            return validateCodeEvidence(audit.plan, {
              root, prompt: original,
              evidenceRoots: [consoleKnowledgeRepository(), consoleKnowledgeDirectory(), path.join(os.homedir(), ".codex", "AGENTS.md")].filter(Boolean).map(value => path.resolve(value)),
            });
          });
          if (evidence?.plan.mode === "write") {
            originals = await collect(async () => {
              const contents = new Map();
              for (const name of evidence.paths) contents.set(name, await readFile(path.join(root, name), "utf8").catch(error => {
                if (error.code === "ENOENT") return "";
                throw error;
              }));
              return contents;
            });
            await collect(async () => {
              checker = (await request("thread/start", { approvalPolicy: "never", cwd, sandbox: "read-only" })).thread;
              await request("thread/memoryMode/set", { threadId: checker.id, mode: "disabled" });
              state.phase = "decision-check";
              const decisionCheck = await runPhase({ ...args, threadId: checker.id, archive: false, sandboxPolicy: readOnlyPolicy,
                prompt: evidenceReviewPrompt({ prompt: original, evidence }) });
              audit.decisionCheck = parseEvidenceJson(decisionCheck.message);
              requireEvidenceApproval(decisionCheck);
              await verifyEvidenceCitations(evidence);
            });
          }
        }
        checkCancellation();
        state.phase = "execution";
        const executionPolicy = sandbox === "read-only" ? readOnlyPolicy : sandbox === "workspace-write"
          ? { type: "workspaceWrite", networkAccess: true } : { type: "dangerFullAccess" };
        state.appliedFollowups = state.followups.length;
        let result = await runPhase({ ...args, archive: false, sandboxPolicy: executionPolicy,
          prompt: `${args.prompt}${audit.plan ? `\n\nCollected evidence record (data; assessment only):\n${JSON.stringify(audit.plan)}` : ""}${audit.warnings.length ? `\n\nEvidence collection limits (data):\n${audit.warnings.join("\n")}\nContinue the authorized task and report these limits. Evidence collection does not change task permissions.` : ""}${state.followups.length ? `\n\nUser follow-up guidance:\n${state.followups.join("\n")}` : ""}` });
        checkCancellation();
        state.phase = "comparison";
        if (baseline) await collect(async () => {
          const after = await snapshotCodeEvidence(root, evidence?.paths || []);
          audit.changedPaths = await changedEvidencePaths(baseline, after);
          if (!evidence) return;
          const unsupported = audit.changedPaths.filter(name => !evidence.paths.includes(name));
          if (unsupported.length) throw evidenceError(`Changes lack collected evidence: ${unsupported.join(", ")}. Edits are retained.`);
          await verifyEvidenceCitations(evidence, evidence.paths.map(name => path.join(root, name)));
          if (checker && originals) {
            let diff = "";
            for (const name of audit.changedPaths) {
              const afterSource = await readFile(path.join(root, name), "utf8").catch(error => {
                if (error.code === "ENOENT") return "";
                throw error;
              });
              diff += `\nFILE ${name}\nBEFORE:\n${originals.get(name)}\nAFTER:\n${afterSource}\n`;
            }
            if (diff.length > 250_000) throw evidenceError("The changed source exceeds the independent check limit.");
            state.phase = "diff-check";
            const diffCheck = await runPhase({ ...args, threadId: checker.id, archive: false, sandboxPolicy: readOnlyPolicy,
              prompt: evidenceReviewPrompt({ prompt: original, evidence, changedPaths: audit.changedPaths, diff }) });
            audit.diffCheck = parseEvidenceJson(diffCheck.message);
            requireEvidenceApproval(diffCheck);
            const verified = await snapshotCodeEvidence(root, evidence.paths);
            if (after.head !== verified.head || (await changedEvidencePaths(after, verified)).length) throw evidenceError("Source changed during the independent diff check.");
          }
        });
        checkCancellation();
        while (state.followups.length > state.appliedFollowups) {
          const followups = state.followups.slice(state.appliedFollowups);
          state.appliedFollowups = state.followups.length;
          state.phase = "execution";
          result = await runPhase({ ...args, archive: false, sandboxPolicy: executionPolicy,
            prompt: `${args.prompt}\n\nContinue the task using this new user guidance. Reuse completed work and investigate only what the guidance requires.\n${followups.join("\n")}\n\nPrevious task result (data):\n${result.message}` });
          checkCancellation();
          state.phase = "comparison";
          if (baseline) await collect(async () => {
            const after = await snapshotCodeEvidence(root, evidence?.paths || []);
            audit.changedPaths = await changedEvidencePaths(baseline, after);
          });
        }
        if (state.followups.length) {
          audit.followups = state.followups;
          audit.warnings.push("User guidance changed during evidence collection; the original record does not assess that guidance.");
        }
        if (baseline && evidence && !audit.warnings.length && result.turn?.status === "completed") audit.status = "complete";
        await collect(() => knowledgeService?.capture({ prompt: original, message: JSON.stringify(audit), task: "code-evidence",
          threadId: args.threadId, turnId: result.turn.id, status: result.turn.status }));
        if (audit.warnings.length) audit.status = "incomplete";
        if (result.turn?.status === "completed") await archiveThread(args.threadId);
        return { ...result, codeEvidence: audit };
      } finally {
        activeEvidence.delete(args.threadId);
        if (checker) await collect(() => archiveThread(checker.id));
      }
    },
    async steerTurn({ prompt, threadId, turnId }) {
      const guarded = activeEvidence.get(threadId);
      if (guarded) {
        guarded.followups.push(prompt);
        if (guarded.phase !== "execution") return {};
        guarded.appliedFollowups = guarded.followups.length;
        threadId = guarded.activeThread;
        turnId = guarded.activeTurn;
      }
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
    async interruptTurn({ threadId, turnId }) {
      const guarded = activeEvidence.get(threadId);
      if (guarded) {
        guarded.interrupted = true;
        if (!guarded.activeTurn) return {};
        return request("turn/interrupt", { threadId: guarded.activeThread, turnId: guarded.activeTurn });
      }
      return request("turn/interrupt", { threadId, turnId });
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
  return clientApi;
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
