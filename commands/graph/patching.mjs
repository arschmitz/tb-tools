import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { run } from "../../lib/utils.mjs";
import { getPhabUrl } from "../../lib/workflow.mjs";
import { getPatchArgs } from "../patch.mjs";
import { DEFAULT_SUBMIT_OUTPUT_LIMIT, GRAPH_MACH_TERMINAL_STATUSES } from "./constants.mjs";
import { getInteractiveYesNoPrompt } from "./actions.mjs";

function stripAnsi(value = "") {
  const escapeCharacter = String.fromCharCode(27);

  return String(value).replace(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function appendPatchOutput(session, output = "") {
  if (!output) {
    return;
  }

  session.output = `${session.output || ""}${stripAnsi(output)}`;

  if (session.output.length > DEFAULT_SUBMIT_OUTPUT_LIMIT) {
    session.output = session.output.slice(-DEFAULT_SUBMIT_OUTPUT_LIMIT);
  }
}

function formatCommandForOutput(command) {
  return [command.cmd, ...(command.args || [])].join(" ");
}

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return value === true || value === "true" || value === "on";
}

function normalizeOptionalString(value) {
  return String(value || "").trim();
}

export function normalizeGraphPatchOptions(options = {}) {
  const normalized = {
    revision: normalizeOptionalString(options.revision),
    bug: normalizeOptionalString(options.bug),
    checkpoint: normalizeBoolean(options.checkpoint, true),
    rollback: normalizeBoolean(options.rollback, true),
    applyTo: normalizeOptionalString(options.applyTo),
    raw: normalizeBoolean(options.raw),
    diffId: normalizeOptionalString(options.diffId),
    name: normalizeOptionalString(options.name),
    noCommit: normalizeBoolean(options.noCommit),
    noBookmark: normalizeBoolean(options.noBookmark),
    noTopic: normalizeBoolean(options.noTopic),
    noBranch: normalizeBoolean(options.noBranch),
    skipDependencies: normalizeBoolean(options.skipDependencies),
    includeAbandoned: normalizeBoolean(options.includeAbandoned),
    safeMode: normalizeBoolean(options.safeMode),
    forceVcs: normalizeBoolean(options.forceVcs),
  };

  let patchArgs;

  try {
    patchArgs = getPatchArgs(normalized);
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }

  return {
    ...normalized,
    revision: patchArgs[1],
    patchArgs,
  };
}

function setPatchRunning(session, message) {
  session.status = "running";
  session.message = message;
  session.prompt = null;
}

function askPatchConfirm(session, message, source = "tb patch") {
  return new Promise((resolve, reject) => {
    if (session.prompt) {
      reject(new Error("Patch pull is already waiting on a browser prompt."));
      return;
    }

    session.status = "prompt";
    session.message = "Waiting for input.";
    session.prompt = {
      id: randomUUID(),
      type: "confirm",
      source,
      message,
    };
    session.pendingPrompt = { resolve, reject };
  });
}

export function answerGraphPatchPrompt(session, promptId, answer) {
  if (!session.prompt || !session.pendingPrompt) {
    const error = new Error("Patch pull is not waiting for input.");
    error.statusCode = 409;
    throw error;
  }

  if (session.prompt.id !== promptId) {
    const error = new Error("Patch pull prompt is no longer active.");
    error.statusCode = 409;
    throw error;
  }

  const pendingPrompt = session.pendingPrompt;
  session.prompt = null;
  session.pendingPrompt = null;
  setPatchRunning(session, "Pulling patch...");
  appendPatchOutput(session, `\n> ${answer ? "yes" : "no"}\n`);
  pendingPrompt.resolve(Boolean(answer));
}

function runInjectedPatchCommand({ command, session, runCommand }) {
  appendPatchOutput(session, `$ ${formatCommandForOutput(command)}\n`);

  return runCommand(command).then((output) => {
    appendPatchOutput(session, output);
    return output;
  }, (error) => {
    appendPatchOutput(session, error.stdout || "");
    appendPatchOutput(session, error.stderr || "");
    throw error;
  });
}

export async function runInteractivePatchCommand({
  command,
  session,
  spawnCommand = spawn,
}) {
  appendPatchOutput(session, `$ ${formatCommandForOutput(command)}\n`);
  const initialOutputLength = session.output.length;

  return new Promise((resolve, reject) => {
    const child = spawnCommand(command.cmd, command.args || [], {
      cwd: command.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let promptSearchStart = initialOutputLength;
    let promptPromise = Promise.resolve();

    session.child = child;
    session.cancelCurrentCommand = () => {
      child.kill("SIGTERM");
    };

    function clearCurrentCommand() {
      if (session.child === child) {
        session.child = null;
      }
      if (session.cancelCurrentCommand) {
        session.cancelCurrentCommand = null;
      }
    }

    function handleOutput(chunk, target) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      target.push(Buffer.from(text));
      appendPatchOutput(session, text);

      if (session.prompt) {
        return;
      }

      const searchable = session.output.slice(promptSearchStart);
      const prompt = getInteractiveYesNoPrompt(searchable);

      if (!prompt) {
        return;
      }

      promptSearchStart = session.output.length;
      promptPromise = promptPromise.then(async () => {
        const answer = await askPatchConfirm(session, prompt, command.cmd);
        child.stdin.write(answer ? "y\n" : "n\n");
      }).catch((error) => {
        child.kill();
        throw error;
      });
    }

    child.stdout.on("data", (chunk) => handleOutput(chunk, stdout));
    child.stderr.on("data", (chunk) => handleOutput(chunk, stderr));
    child.on("error", (error) => {
      clearCurrentCommand();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearCurrentCommand();
      promptPromise.then(() => {
        const stdoutText = Buffer.concat(stdout).toString();
        const stderrText = Buffer.concat(stderr).toString();

        if (code > 0 || signal) {
          const error = new Error(stderrText || `${command.cmd} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`);
          error.code = code;
          error.signal = signal;
          error.stdout = stdoutText;
          error.stderr = stderrText;
          reject(error);
          return;
        }

        resolve(stdoutText);
      }, reject);
    });
  });
}

function runGraphPatchCommand({
  graph,
  command,
  session,
  runCommand = run,
}) {
  const commandWithCwd = {
    ...command,
    cwd: command.cwd || graph.path,
    capture: true,
  };

  return runCommand === run
    ? runInteractivePatchCommand({ command: commandWithCwd, session })
    : runInjectedPatchCommand({ command: commandWithCwd, session, runCommand });
}

function runGraphPatchGit({
  graph,
  args,
  session,
  runCommand = run,
}) {
  return runGraphPatchCommand({
    graph,
    command: {
      cmd: "git",
      args,
      silent: true,
    },
    session,
    runCommand,
  });
}

async function createGraphPatchCheckpoint({ graph, session, runCommand }) {
  const branch = (await runGraphPatchGit({
    graph,
    args: ["branch", "--show-current"],
    session,
    runCommand,
  })).trim();
  const commit = (await runGraphPatchGit({
    graph,
    args: ["rev-parse", "HEAD"],
    session,
    runCommand,
  })).trim();
  const ref = "refs/tb-tools/patch-start";

  await runGraphPatchGit({
    graph,
    args: ["update-ref", ref, commit],
    session,
    runCommand,
  });
  appendPatchOutput(session, `Created checkpoint ${ref} at ${commit.slice(0, 12)}.\n`);

  return { branch, commit, ref };
}

async function restoreGraphPatchCheckpoint({
  graph,
  checkpoint,
  session,
  clean = false,
  runCommand = run,
}) {
  setPatchRunning(session, "Rolling back patch pull...");

  if (checkpoint.branch) {
    try {
      await runGraphPatchGit({
        graph,
        args: ["switch", checkpoint.branch],
        session,
        runCommand,
      });
    } catch {
      await runGraphPatchGit({
        graph,
        args: ["switch", "--detach", checkpoint.commit],
        session,
        runCommand,
      });
    }
  } else {
    await runGraphPatchGit({
      graph,
      args: ["switch", "--detach", checkpoint.commit],
      session,
      runCommand,
    });
  }

  await runGraphPatchGit({
    graph,
    args: ["reset", "--hard", checkpoint.commit],
    session,
    runCommand,
  });

  if (clean) {
    await runGraphPatchGit({
      graph,
      args: ["clean", "-fd"],
      session,
      runCommand,
    });
  }

  appendPatchOutput(session, `Rolled back to ${checkpoint.commit.slice(0, 12)}.\n`);
}

async function switchGraphPatchBugBranch({
  graph,
  bug,
  session,
  runCommand = run,
}) {
  if (!bug) {
    return "";
  }

  const branch = `Bug-${bug}`;
  setPatchRunning(session, `Switching to ${branch}...`);

  try {
    await runGraphPatchGit({
      graph,
      args: ["switch", "-c", branch],
      session,
      runCommand,
    });
  } catch {
    await runGraphPatchGit({
      graph,
      args: ["switch", branch],
      session,
      runCommand,
    });
  }

  return branch;
}

async function runGraphPatchPull(session) {
  const { graph, options, runCommand } = session;
  let checkpoint = null;

  setPatchRunning(session, `Pulling ${options.revision}...`);

  if (options.checkpoint) {
    checkpoint = await createGraphPatchCheckpoint({ graph, session, runCommand });
    session.checkpoint = checkpoint;
  }

  if (options.bug) {
    session.branch = await switchGraphPatchBugBranch({
      graph,
      bug: options.bug,
      session,
      runCommand,
    });
  }

  try {
    await runGraphPatchCommand({
      graph,
      command: {
        cmd: "moz-phab",
        args: options.patchArgs,
      },
      session,
      runCommand,
    });
  } catch (error) {
    if (checkpoint && options.rollback) {
      const shouldRollback = await askPatchConfirm(session, "Patch failed. Roll back to checkpoint? [y/n]:");

      if (shouldRollback) {
        await restoreGraphPatchCheckpoint({
          graph,
          checkpoint,
          session,
          clean: true,
          runCommand,
        });
      }
    }

    throw error;
  }
}

function cancelGraphPatchSession(session) {
  if (GRAPH_MACH_TERMINAL_STATUSES.has(session.status)) {
    return;
  }

  session.cancelRequested = true;

  if (session.pendingPrompt) {
    session.pendingPrompt.reject(new Error("Patch pull canceled."));
    session.pendingPrompt = null;
  }

  session.prompt = null;
  session.cancelCurrentCommand?.();
  session.status = "canceled";
  session.message = "Patch pull canceled.";
  appendPatchOutput(session, "Patch pull canceled.\n");
}

export function createGraphPatchSession({
  graph,
  graphIndex,
  snapshotLimit,
  getSnapshot,
  options = {},
  runCommand = run,
}) {
  const normalizedOptions = normalizeGraphPatchOptions(options);
  const session = {
    id: randomUUID(),
    graph,
    graphIndex,
    label: graph.label,
    path: graph.path,
    options: normalizedOptions,
    checkpoint: null,
    branch: "",
    status: "running",
    message: `Pulling ${normalizedOptions.revision}...`,
    prompt: null,
    pendingPrompt: null,
    output: "",
    error: "",
    snapshot: null,
    cancelRequested: false,
    child: null,
    cancelCurrentCommand: null,
    runCommand,
    answer(promptId, answer) {
      answerGraphPatchPrompt(session, promptId, answer);
    },
    cancel() {
      cancelGraphPatchSession(session);
    },
  };

  queueMicrotask(async () => {
    try {
      await runGraphPatchPull(session);
      session.snapshot = await getSnapshot(graph, snapshotLimit);
      session.status = "complete";
      session.message = `${normalizedOptions.revision} pulled.`;
    } catch (error) {
      if (session.cancelRequested) {
        session.status = "canceled";
        session.message = "Patch pull canceled.";
      } else {
        try {
          session.snapshot = await getSnapshot(graph, snapshotLimit);
        } catch {
          session.snapshot = null;
        }
        session.status = "error";
        session.error = String(error?.message || error);
        session.message = session.error;
      }
      if (session.pendingPrompt) {
        session.pendingPrompt.reject(error);
        session.pendingPrompt = null;
      }
      session.prompt = null;
    }
  });

  return session;
}

export function serializeGraphPatchSession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    label: session.label,
    path: session.path,
    revision: session.options.revision,
    status: session.status,
    message: session.message,
    prompt: session.prompt,
    output: session.output || "",
    error: session.error,
    snapshot: session.snapshot,
    links: session.options.revision
      ? [{ label: session.options.revision, url: getPhabUrl(session.options.revision) }]
      : [],
  };
}
