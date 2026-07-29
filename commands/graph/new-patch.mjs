import { randomUUID } from "node:crypto";
import defaultConfig from "../../lib/config.mjs";
import { run } from "../../lib/utils.mjs";
import { DEFAULT_BRANCH } from "../../lib/git.mjs";
import { updateBug as defaultUpdateBug } from "../../lib/bugzilla.mjs";
import { getBugUrl } from "../../lib/workflow.mjs";
import { GRAPH_MACH_TERMINAL_STATUSES, GRAPH_UPDATE_MODE_UPDATE } from "./constants.mjs";
import { runGraphRepositoryUpdate } from "./actions.mjs";
import { getNextBugBranchName } from "./branches.mjs";

const NEW_PATCH_OUTPUT_LIMIT = 160000;

function appendNewPatchOutput(session, output = "") {
  if (!output) {
    return;
  }

  session.output = `${session.output || ""}${output}`;

  if (session.output.length > NEW_PATCH_OUTPUT_LIMIT) {
    session.output = session.output.slice(-NEW_PATCH_OUTPUT_LIMIT);
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

function normalizeBugId(bugId) {
  const normalized = String(bugId || "").trim();

  if (!/^\d{4,8}$/.test(normalized)) {
    const error = new Error("A Bugzilla bug ID is required.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

export function normalizeGraphNewPatchOptions(options = {}) {
  return {
    bugId: normalizeBugId(options.bugId),
    update: normalizeBoolean(options.update, true),
  };
}

function getBugzillaConfig(config = defaultConfig) {
  return config?.bugzilla || {};
}

function ensureBugzillaConfigured(config = defaultConfig) {
  const bugzilla = getBugzillaConfig(config);

  if (!bugzilla.user) {
    throw new Error("You must have a Bugzilla user in your configuration to assign bugs.");
  }

  if (!bugzilla.apiKey) {
    throw new Error("You must have a Bugzilla API key in your configuration to assign bugs.");
  }

  return bugzilla;
}

function setNewPatchRunning(session, message) {
  session.status = "running";
  session.message = message;
}

async function runNewPatchCommand({
  graph,
  command,
  session,
  runCommand = run,
}) {
  const commandWithCwd = {
    ...command,
    cwd: command.cwd || graph.path,
    capture: true,
    silent: command.silent !== false,
  };

  appendNewPatchOutput(session, `$ ${formatCommandForOutput(commandWithCwd)}\n`);

  return runCommand(commandWithCwd).then((output) => {
    appendNewPatchOutput(session, output);
    return output;
  }, (error) => {
    appendNewPatchOutput(session, error.stdout || "");
    appendNewPatchOutput(session, error.stderr || "");
    throw error;
  });
}

async function runNewPatchGit({
  graph,
  args,
  session,
  runCommand = run,
}) {
  return runNewPatchCommand({
    graph,
    command: {
      cmd: "git",
      args,
    },
    session,
    runCommand,
  });
}

async function createNewPatchBranch({
  graph,
  bugId,
  session,
  runCommand = run,
}) {
  setNewPatchRunning(session, "Choosing branch name...");
  const branchData = await runNewPatchGit({
    graph,
    args: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    session,
    runCommand,
  });
  const branches = branchData.split(/\r?\n/).filter(Boolean);
  const branch = getNextBugBranchName(branches, bugId);

  setNewPatchRunning(session, `Creating ${branch}...`);
  await runNewPatchGit({
    graph,
    args: ["switch", "-c", branch],
    session,
    runCommand,
  });
  appendNewPatchOutput(session, `Created branch ${branch}.\n`);

  return branch;
}

async function updateGraphsForNewPatch(session) {
  setNewPatchRunning(session, `Updating ${DEFAULT_BRANCH}...`);
  appendNewPatchOutput(session, `Updating checkouts from origin/${DEFAULT_BRANCH}...\n`);
  const result = await runGraphRepositoryUpdate({
    graphs: session.graphs,
    mode: GRAPH_UPDATE_MODE_UPDATE,
    runCommand: session.runCommand,
  });

  appendNewPatchOutput(session, `${result.message}\n`);
}

async function assignNewPatchBug(session) {
  setNewPatchRunning(session, `Assigning bug ${session.options.bugId}...`);
  appendNewPatchOutput(session, `Assigning bug ${session.options.bugId} to ${session.bugzilla.user}.\n`);
  await session.updateBug(session.options.bugId, {
    assigned_to: session.bugzilla.user,
    status: "ASSIGNED",
  });
  appendNewPatchOutput(session, `Bug ${session.options.bugId} assigned.\n`);
}

async function runGraphNewPatch(session) {
  ensureBugzillaConfigured(session.config);

  if (session.options.update) {
    await updateGraphsForNewPatch(session);
  }

  session.branch = await createNewPatchBranch({
    graph: session.graph,
    bugId: session.options.bugId,
    session,
    runCommand: session.runCommand,
  });
  await assignNewPatchBug(session);
}

function cancelGraphNewPatchSession(session) {
  if (GRAPH_MACH_TERMINAL_STATUSES.has(session.status)) {
    return;
  }

  session.cancelRequested = true;
  session.status = "canceled";
  session.message = "New patch canceled.";
  appendNewPatchOutput(session, "New patch canceled.\n");
}

export function createGraphNewPatchSession({
  graphs,
  graph,
  graphIndex,
  snapshotLimits = [],
  getSnapshots,
  options = {},
  runCommand = run,
  updateBug = defaultUpdateBug,
  config = defaultConfig,
}) {
  const normalizedOptions = normalizeGraphNewPatchOptions(options);
  const session = {
    id: randomUUID(),
    graphs,
    graph,
    graphIndex,
    label: graph.label,
    path: graph.path,
    options: normalizedOptions,
    branch: "",
    bugzilla: ensureBugzillaConfigured(config),
    config,
    status: "running",
    message: `Creating patch for bug ${normalizedOptions.bugId}...`,
    output: "",
    error: "",
    snapshots: null,
    cancelRequested: false,
    runCommand,
    updateBug,
    cancel() {
      cancelGraphNewPatchSession(session);
    },
  };

  queueMicrotask(async () => {
    try {
      await runGraphNewPatch(session);
      if (session.cancelRequested) {
        session.status = "canceled";
        session.message = "New patch canceled.";
        return;
      }
      session.snapshots = await getSnapshots(snapshotLimits);
      session.status = "complete";
      session.message = `Created ${session.branch}.`;
    } catch (error) {
      if (session.cancelRequested) {
        session.status = "canceled";
        session.message = "New patch canceled.";
      } else {
        try {
          session.snapshots = await getSnapshots(snapshotLimits);
        } catch {
          session.snapshots = null;
        }
        session.status = "error";
        session.error = String(error?.message || error);
        session.message = session.error;
      }
    }
  });

  return session;
}

export function serializeGraphNewPatchSession(session) {
  return {
    id: session.id,
    graphIndex: session.graphIndex,
    label: session.label,
    path: session.path,
    bugId: session.options.bugId,
    branch: session.branch,
    status: session.status,
    message: session.message,
    output: session.output || "",
    error: session.error,
    snapshots: session.snapshots,
    links: session.options.bugId
      ? [{ label: `Bug ${session.options.bugId}`, url: getBugUrl(session.options.bugId) }]
      : [],
  };
}
