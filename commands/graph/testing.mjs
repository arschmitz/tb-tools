import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { run } from "../../lib/utils.mjs";
import { getTestTargets } from "../test.mjs";
import {
  DEFAULT_SUBMIT_OUTPUT_LIMIT,
  GRAPH_MACH_TERMINAL_STATUSES,
} from "./constants.mjs";
import { getGraphChangedFilePaths } from "./actions.mjs";

const TEST_FLAVORS = new Set(["all", "browser", "unit"]);
const ESCAPE_CHARACTER = String.fromCharCode(27);
const BACKSPACE_CHARACTER = String.fromCharCode(8);
const ANSI_PATTERN = new RegExp(`${ESCAPE_CHARACTER}(?:\\[[0-?]*[ -/]*[@-~]|[()][A-Za-z0-9])`, "g");
const SCRIPT_EOF_MARKER_PATTERN = new RegExp(`\\^D${BACKSPACE_CHARACTER}${BACKSPACE_CHARACTER}`, "g");
const TERMINAL_CHARSET_PATTERN = new RegExp(`${ESCAPE_CHARACTER}[()][A-Za-z0-9]`, "g");
const TEST_PATH_EXTENSIONS = [
  "c",
  "cc",
  "cpp",
  "ftl",
  "h",
  "html",
  "ini",
  "js",
  "json",
  "jsx",
  "mjs",
  "py",
  "rs",
  "toml",
  "ts",
  "tsx",
  "xhtml",
  "xml",
  "yaml",
  "yml",
].join("|");
const FAILURE_STATUS_PATTERN = /(?:TEST-UNEXPECTED-[A-Z-]+|TEST-FAIL|PROCESS-CRASH|FAIL(?:ED)?|ERROR|TIMEOUT|CRASH|XPASS|XFAIL)/i;
const FAILURE_SECTION_PATTERN = /^(?:Unexpected Results|Error Summary|Failed tests?|Failures?|Errors?|=+\s+FAILURES\s+=+|=+\s+ERRORS\s+=+)$/i;
const FAILURE_SECTION_STOP_PATTERN = /^(?:Overall Summary|Expected results|Unexpected results|Passed:|Failed:|Todo:|Skipped:|OK|mochitest-.+|xpcshell|~+)$/i;
const TEST_PATH_WITH_SLASH_PATTERN = new RegExp(
  String.raw`(?:(?:file:\/\/)?\/[^\s|<>"']+|(?:chrome:\/\/mochitests\/content\/(?:browser|chrome)\/)?(?:\.\.\/)?(?:comm\/)?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+\.(?:${TEST_PATH_EXTENSIONS})(?::[A-Za-z_$][\w$.-]*)?(?::\d+)?(?::\d+)?(?:::[^\s|]+)?)(?=$|[\s|),;"'])`,
  "i"
);
const TEST_BASENAME_PATTERN = new RegExp(
  String.raw`\b[A-Za-z0-9_.@+-]+\.(?:${TEST_PATH_EXTENSIONS})(?::[A-Za-z_$][\w$.-]*)?(?::\d+)?(?::\d+)?(?:::[^\s|]+)?(?=$|[\s|),;"'])`,
  "i"
);

function stripAnsi(value = "") {
  return String(value).replace(ANSI_PATTERN, "");
}

function appendTestOutput(session, output = "") {
  if (!output) {
    return;
  }

  const text = cleanGraphTestTerminalOutput(output);

  recordGraphTestFailureOutput(session, text);
  session.output = `${session.output || ""}${text}`;

  if (session.output.length > DEFAULT_SUBMIT_OUTPUT_LIMIT) {
    session.output = session.output.slice(-DEFAULT_SUBMIT_OUTPUT_LIMIT);
  }
}

function formatCommandForOutput(command) {
  return [command.cmd, ...(command.args || [])].join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function formatShellCommand(command) {
  return [command.cmd, ...(command.args || [])].map(shellQuote).join(" ");
}

export function getPseudoTerminalCommand(command, platform = process.platform) {
  if (platform === "darwin") {
    return {
      ...command,
      cmd: "script",
      args: ["-q", "-e", "-F", "/dev/null", command.cmd, ...(command.args || [])],
    };
  }

  if (platform === "freebsd" || platform === "openbsd") {
    return {
      ...command,
      cmd: "script",
      args: ["-q", "-e", "/dev/null", command.cmd, ...(command.args || [])],
    };
  }

  if (platform === "linux") {
    return {
      ...command,
      cmd: "script",
      args: ["-q", "-e", "-f", "-c", formatShellCommand(command), "/dev/null"],
    };
  }

  return command;
}

export function cleanGraphTestTerminalOutput(output = "") {
  return String(output)
    .replace(SCRIPT_EOF_MARKER_PATTERN, "")
    .replace(TERMINAL_CHARSET_PATTERN, "");
}

function normalizePatternList(pattern) {
  if (Array.isArray(pattern)) {
    return pattern.map((item) => String(item || "").trim()).filter(Boolean);
  }

  return String(pattern || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBooleanOption(value) {
  return value === true || value === "true" || value === null;
}

export function normalizeGraphTestOptions(options = {}) {
  const flavor = TEST_FLAVORS.has(String(options.flavor || "").trim())
    ? String(options.flavor).trim()
    : "all";

  return {
    flavor,
    pattern: normalizePatternList(options.pattern),
    headless: normalizeBooleanOption(options.headless),
  };
}

function normalizeFailurePath(value = "", graphPath = "") {
  let filePath = String(value || "").trim();
  let lineNumber = 0;

  filePath = filePath
    .replace(/^file:\/\//, "")
    .replace(/^chrome:\/\/mochitests\/content\/(?:browser|chrome)\//, "")
    .replace(/^[([{<]+/, "")
    .replace(/[)\]},;]+$/, "")
    .replace(/^['"]|['"]$/g, "");

  const manifestPathMatch = filePath.match(/^[^/\s|]+\.ini:(.+)$/i);
  if (manifestPathMatch) {
    filePath = manifestPathMatch[1];
  }

  filePath = filePath.replace(/::.*$/, "");
  filePath = filePath.replace(
    new RegExp(String.raw`(\.(?:${TEST_PATH_EXTENSIONS})):[A-Za-z_$][\w$.-]*:(\d+)$`, "i"),
    "$1:$2"
  );

  const lineMatch = filePath.match(/^(.*?)(?::(\d+))(?::\d+)?$/);
  if (lineMatch && lineMatch[1]) {
    filePath = lineMatch[1];
    lineNumber = Number(lineMatch[2]) || 0;
  }

  if (path.isAbsolute(filePath) && graphPath) {
    const relative = path.relative(graphPath, filePath);

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      filePath = relative;
    }
  }

  filePath = filePath.replace(/^comm\//, "").replace(/^\.\.\/comm\//, "");

  if (!filePath) {
    return null;
  }

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(graphPath || process.cwd(), filePath);

  return {
    path: filePath,
    lineNumber,
    absolutePath,
    vscodeUrl: getVscodeFileUrl(absolutePath, lineNumber),
  };
}

function getVscodeFileUrl(filePath, lineNumber = 0) {
  const encodedPath = filePath
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const lineSuffix = lineNumber ? `:${lineNumber}` : "";

  return `vscode://file/${encodedPath}${lineSuffix}`;
}

function stripTrailingFailurePathText(value = "") {
  return String(value || "")
    .replace(/[.,;]+$/, "")
    .replace(/^['"]|['"]$/g, "");
}

function getTargetPathFromText(text = "", targets = []) {
  const normalizedTargets = targets
    .filter(Boolean)
    .map((target) => String(target))
    .sort((first, second) => second.length - first.length);

  for (const target of normalizedTargets) {
    if (text.includes(target)) {
      return target;
    }
  }

  for (const target of normalizedTargets) {
    const targetBaseName = path.basename(target);

    if (targetBaseName && text.includes(targetBaseName)) {
      return target;
    }
  }

  return "";
}

function getPathCandidateFromText(text = "", targets = [], { allowBasename = true } = {}) {
  const clean = stripAnsi(text).trim();
  const targetPath = getTargetPathFromText(clean, targets);
  const slashMatch = clean.match(TEST_PATH_WITH_SLASH_PATTERN);
  const basenameMatch = allowBasename ? clean.match(TEST_BASENAME_PATTERN) : null;
  const candidate = slashMatch?.[0] || targetPath || basenameMatch?.[0] || "";

  return stripTrailingFailurePathText(candidate);
}

function getSingleFailureTargetPath(targets = []) {
  const normalizedTargets = targets
    .filter(Boolean)
    .map((target) => String(target).trim())
    .filter(Boolean);

  return normalizedTargets.length === 1 ? normalizedTargets[0] : "";
}

function getFailureDetailsFromLine(line = "", graphPath = "", targets = [], {
  allowBarePath = false,
  contextPath = "",
} = {}) {
  const clean = stripAnsi(line).trim();
  const pipeMatch = clean.match(/\b(?<status>TEST-UNEXPECTED-[A-Z-]+|TEST-FAIL|PROCESS-CRASH|FAIL(?:ED)?|ERROR|TIMEOUT|CRASH|XPASS|XFAIL)\s*\|\s*(?<path>[^|]+?)\s*(?:\|\s*(?<message>.*))?$/i);
  const statusPathMatch = clean.match(/^\s*(?:\S+\s+-\s+)?(?<status>TEST-UNEXPECTED-[A-Z-]+|TEST-FAIL|PROCESS-CRASH|FAIL(?:ED)?|ERROR|TIMEOUT|CRASH|XPASS|XFAIL)\s+(?<rest>.+)$/i);
  const pathText = pipeMatch?.groups?.path ||
    getPathCandidateFromText(statusPathMatch?.groups?.rest || "", targets, {
      allowBasename: !contextPath,
    }) ||
    (statusPathMatch ? contextPath : "") ||
    (statusPathMatch ? getSingleFailureTargetPath(targets) : "") ||
    (allowBarePath ? getPathCandidateFromText(clean, targets, { allowBasename: !contextPath }) : "");
  const message = pipeMatch?.groups?.message ||
    (statusPathMatch?.groups?.rest || "").replace(pathText, "").replace(/^\s*(?:\||-|:)\s*/, "").trim();
  const failurePath = pathText ? normalizeFailurePath(pathText, graphPath) : null;

  return {
    status: pipeMatch?.groups?.status || statusPathMatch?.groups?.status || "",
    message,
    failurePath,
  };
}

function isGraphTestFailureLine(line = "", targets = [], {
  allowBarePath = false,
  contextPath = "",
} = {}) {
  const clean = stripAnsi(line).trim();

  if (FAILURE_SECTION_PATTERN.test(clean) || FAILURE_SECTION_STOP_PATTERN.test(clean)) {
    return false;
  }

  return (
    (FAILURE_STATUS_PATTERN.test(clean) && Boolean(getPathCandidateFromText(clean, targets))) ||
    (FAILURE_STATUS_PATTERN.test(clean) && Boolean(contextPath)) ||
    (FAILURE_STATUS_PATTERN.test(clean) && Boolean(getSingleFailureTargetPath(targets))) ||
    (FAILURE_STATUS_PATTERN.test(clean) && allowBarePath)
  );
}

function createGraphTestFailure(line = "", graphPath = "", targets = [], options = {}) {
  const { status, message, failurePath } = getFailureDetailsFromLine(line, graphPath, targets, options);

  return {
    line,
    status,
    message,
    ...(failurePath || {
      path: "",
      lineNumber: 0,
      absolutePath: "",
      vscodeUrl: "",
    }),
  };
}

function normalizeGraphTestFailureText(value = "") {
  return stripAnsi(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getGraphTestFailureKey(failure) {
  if (failure.path && failure.message) {
    return `${failure.path}:${normalizeGraphTestFailureText(failure.message)}`;
  }

  return failure.path
    ? `${failure.path}:${normalizeGraphTestFailureText(failure.line)}`
    : normalizeGraphTestFailureText(failure.line);
}

function mergeGraphTestFailure(existing, incoming) {
  if (!existing || !incoming) {
    return;
  }

  if (!existing.lineNumber && incoming.lineNumber) {
    existing.lineNumber = incoming.lineNumber;
    existing.absolutePath = incoming.absolutePath || existing.absolutePath;
    existing.vscodeUrl = incoming.vscodeUrl || existing.vscodeUrl;
  }

  if (!existing.message && incoming.message) {
    existing.message = incoming.message;
  }

  if (!existing.status && incoming.status) {
    existing.status = incoming.status;
  }
}

function isGraphTestBookkeepingFailure(failure) {
  return /^FAIL(?:ED)?$/i.test(failure.status || "") &&
    /^finished in \d+(?:\.\d+)?m?s\b/i.test(failure.message || "");
}

function createGraphTestParseState(state = {}) {
  return {
    failureSectionActive: Boolean(state.failureSectionActive),
    failureContextPath: state.failureContextPath || "",
    testContextPath: state.testContextPath || "",
    lastFailure: state.lastFailure || null,
  };
}

function syncGraphTestParseState(target, state) {
  target.failureSectionActive = state.failureSectionActive;
  target.failureContextPath = state.failureContextPath;
  target.testContextPath = state.testContextPath;
  target.lastFailure = state.lastFailure;
}

function updateGraphTestFailureSectionState(state, clean = "") {
  if (FAILURE_SECTION_PATTERN.test(clean)) {
    state.failureSectionActive = true;
    state.failureContextPath = "";
    return;
  }

  if (clean && FAILURE_SECTION_STOP_PATTERN.test(clean)) {
    state.failureSectionActive = false;
    state.failureContextPath = "";
  }
}

function updateGraphTestFailureLocation(failure, location) {
  if (!failure || !location) {
    return;
  }

  if (failure.path !== location.path || failure.lineNumber) {
    return;
  }

  failure.lineNumber = location.lineNumber || 0;
  failure.absolutePath = location.absolutePath || failure.absolutePath;
  failure.vscodeUrl = location.vscodeUrl || failure.vscodeUrl;
}

function updateGraphTestLiveContextFromLine(state, clean = "", graphPath = "", targets = []) {
  if (
    state.failureSectionActive ||
    FAILURE_STATUS_PATTERN.test(clean) ||
    !/\bTEST-START\b/i.test(clean)
  ) {
    return;
  }

  const pathText = getPathCandidateFromText(clean, targets, { allowBasename: false });
  const location = pathText ? normalizeFailurePath(pathText, graphPath) : null;

  if (location) {
    state.testContextPath = pathText;
  }
}

function updateGraphTestContextFromLine(state, clean = "", graphPath = "", targets = []) {
  if (!state.failureSectionActive || FAILURE_STATUS_PATTERN.test(clean)) {
    return;
  }

  const pathText = getPathCandidateFromText(clean, targets);
  const location = pathText ? normalizeFailurePath(pathText, graphPath) : null;

  if (!location) {
    return;
  }

  updateGraphTestFailureLocation(state.lastFailure, location);
  state.failureContextPath = pathText;
}

function parseGraphTestFailureLine({
  line = "",
  graphPath = "",
  targets = [],
  state,
}) {
  const clean = stripAnsi(line).trim();

  if (!clean) {
    return null;
  }

  updateGraphTestFailureSectionState(state, clean);
  updateGraphTestLiveContextFromLine(state, clean, graphPath, targets);
  updateGraphTestContextFromLine(state, clean, graphPath, targets);
  const contextPath = state.failureContextPath || (state.failureSectionActive ? "" : state.testContextPath);

  if (!isGraphTestFailureLine(clean, targets, {
    allowBarePath: state.failureSectionActive,
    contextPath,
  })) {
    return null;
  }

  const failure = createGraphTestFailure(clean, graphPath, targets, {
    allowBarePath: state.failureSectionActive,
    contextPath,
  });

  if (!failure.path) {
    return null;
  }

  if (isGraphTestBookkeepingFailure(failure)) {
    return null;
  }

  state.lastFailure = failure;
  if (failure.path) {
    state.failureContextPath = failure.path;
  }

  return failure;
}

function getGraphTestFailedFiles(failures = []) {
  const files = new Map();

  for (const failure of failures) {
    if (!failure.path) {
      continue;
    }

    const existing = files.get(failure.path);

    if (existing) {
      existing.failureCount += 1;
      if (!existing.lineNumber && failure.lineNumber) {
        existing.lineNumber = failure.lineNumber;
        existing.vscodeUrl = failure.vscodeUrl;
      }
      continue;
    }

    files.set(failure.path, {
      path: failure.path,
      lineNumber: failure.lineNumber || 0,
      absolutePath: failure.absolutePath || "",
      vscodeUrl: failure.vscodeUrl || "",
      failureCount: 1,
      firstLine: failure.line || "",
    });
  }

  return Array.from(files.values());
}

function ensureGraphTestFailureState(session) {
  if (!session.failureKeys) {
    session.failureKeys = new Set((session.failures || []).map(getGraphTestFailureKey));
  }

  if (!session.failureByKey) {
    session.failureByKey = new Map((session.failures || []).map((failure) => [
      getGraphTestFailureKey(failure),
      failure,
    ]));
  }

  if (!Array.isArray(session.failures)) {
    session.failures = [];
  }
}

function addGraphTestFailure(session, failure) {
  ensureGraphTestFailureState(session);

  const key = getGraphTestFailureKey(failure);

  if (session.failureKeys.has(key)) {
    mergeGraphTestFailure(session.failureByKey.get(key), failure);
    return;
  }

  session.failureKeys.add(key);
  session.failureByKey.set(key, failure);
  session.failures.push(failure);
}

function recordGraphTestFailureLines(session, lines = []) {
  ensureGraphTestFailureState(session);
  const state = createGraphTestParseState(session);

  for (const line of lines) {
    const failure = parseGraphTestFailureLine({
      line,
      graphPath: session.path,
      targets: session.targets,
      state,
    });

    if (!failure) {
      continue;
    }

    addGraphTestFailure(session, failure);
  }

  syncGraphTestParseState(session, state);
}

function recordGraphTestFailureOutput(session, output = "", { flush = false } = {}) {
  const text = stripAnsi(output).replace(/\r\n?/g, "\n");
  const combined = `${session.failureParseBuffer || ""}${text}`;
  const lines = combined.split("\n");
  let parsedLines;

  if (flush) {
    session.failureParseBuffer = "";
    parsedLines = lines;
  } else {
    session.failureParseBuffer = lines.pop() || "";
    parsedLines = lines;
  }

  recordGraphTestFailureLines(session, parsedLines);
}

function getSummaryNumber(output, patterns) {
  for (const pattern of patterns) {
    const match = output.match(pattern);

    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function getGraphTestFailureSectionTexts(text = "") {
  const lines = text.split("\n");
  const sectionIndexes = [];

  for (let index = 0; index < lines.length; index++) {
    if (FAILURE_SECTION_PATTERN.test(stripAnsi(lines[index]).trim())) {
      sectionIndexes.push(index);
    }
  }

  return sectionIndexes.map((start, index) => {
    const end = sectionIndexes[index + 1] ?? lines.length;

    return lines.slice(start, end).join("\n");
  });
}

function addGraphTestFailureToList(failures, seenFailures, failure) {
  const key = getGraphTestFailureKey(failure);

  if (seenFailures.has(key)) {
    mergeGraphTestFailure(seenFailures.get(key), failure);
    return;
  }

  seenFailures.set(key, failure);
  failures.push(failure);
}

function parseGraphTestFailuresFromText({
  text = "",
  graph,
  targets = [],
  knownFailures = [],
  useKnownFailures = false,
} = {}) {
  const lines = text.split("\n");
  const failures = useKnownFailures ? [...knownFailures] : [];
  const seenFailures = new Map();
  const state = createGraphTestParseState();

  for (const failure of failures) {
    seenFailures.set(getGraphTestFailureKey(failure), failure);
  }

  for (const line of lines) {
    const failure = parseGraphTestFailureLine({
      line,
      graphPath: graph?.path,
      targets,
      state,
    });

    if (!failure) {
      continue;
    }

    addGraphTestFailureToList(failures, seenFailures, failure);
  }

  return failures;
}

function parseGraphTestFinalSummaryFailures({
  text = "",
  graph,
  targets = [],
} = {}) {
  const sectionTexts = getGraphTestFailureSectionTexts(text);
  const failures = [];
  const seenFailures = new Map();

  for (const sectionText of sectionTexts) {
    for (const failure of parseGraphTestFailuresFromText({ text: sectionText, graph, targets })) {
      addGraphTestFailureToList(failures, seenFailures, failure);
    }
  }

  return {
    failures,
    hasFinalSummary: sectionTexts.length > 0,
  };
}

export function parseGraphTestOutput({
  output = "",
  graph,
  targets = [],
  commandFailed = false,
  running = false,
  knownFailures = [],
} = {}) {
  const text = stripAnsi(output).replace(/\r\n?/g, "\n");
  const finalSummaryFailures = parseGraphTestFinalSummaryFailures({
    text,
    graph,
    targets,
  });
  const failures = finalSummaryFailures.failures.length
    ? finalSummaryFailures.failures
    : parseGraphTestFailuresFromText({
      text,
      graph,
      targets,
      knownFailures,
      useKnownFailures: true,
    });

  const passed = getSummaryNumber(text, [/\bPassed:\s*(\d+)/i, /\b(\d+)\s+passed\b/i]);
  const failed = getSummaryNumber(text, [/\bFailed:\s*(\d+)/i, /\b(\d+)\s+failed\b/i]);
  const todo = getSummaryNumber(text, [/\bTodo:\s*(\d+)/i]);
  const skipped = getSummaryNumber(text, [/\bSkipped:\s*(\d+)/i, /\b(\d+)\s+skipped\b/i]);
  const unexpected = getSummaryNumber(text, [/\bUnexpected results:\s*(\d+)/i]);
  const expected = getSummaryNumber(text, [/\bExpected results:\s*(\d+)/i]);
  const ran = getSummaryNumber(text, [/\bRan\s+(\d+)\s+checks?\b/i, /\b(\d+)\s+tests?\s+run\b/i]);
  const fallbackFailureCount = failed ?? unexpected ?? 0;
  const failureCount = failures.length || fallbackFailureCount;
  const failedFiles = getGraphTestFailedFiles(failures);
  const status = !targets.length
    ? (running ? "running" : "not-run")
    : (running && failureCount === 0 ? "running" : (commandFailed || failureCount > 0 ? "failed" : "passed"));

  return {
    status,
    running,
    targetCount: targets.length,
    failureCount,
    passed,
    failed,
    todo,
    skipped,
    expected,
    unexpected,
    ran,
    failures,
    failedFiles,
    failedPaths: failedFiles.map((file) => file.path),
  };
}

function runInjectedTestCommand({ command, session, runCommand }) {
  appendTestOutput(session, `$ ${formatCommandForOutput(command)}\n`);

  return runCommand(command).then((output) => {
    appendTestOutput(session, output);
    return output;
  }, (error) => {
    appendTestOutput(session, error.stdout || "");
    appendTestOutput(session, error.stderr || "");

    if (!error.stdout && !error.stderr && error.message) {
      appendTestOutput(session, `${error.message}\n`);
    }

    throw error;
  });
}

export function runInteractiveTestCommand({
  command,
  session,
  spawnCommand = spawn,
}) {
  appendTestOutput(session, `$ ${formatCommandForOutput(command)}\n`);
  const processCommand = getPseudoTerminalCommand(command);

  return new Promise((resolve, reject) => {
    const child = spawnCommand(processCommand.cmd, processCommand.args || [], {
      cwd: processCommand.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR || "1",
        MOZ_FORCE_COLOR: process.env.MOZ_FORCE_COLOR || "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

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
      const text = cleanGraphTestTerminalOutput(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));

      target.push(Buffer.from(text));
      appendTestOutput(session, text);
    }

    child.stdout.on("data", (chunk) => handleOutput(chunk, stdout));
    child.stderr.on("data", (chunk) => handleOutput(chunk, stderr));
    child.on("error", (error) => {
      clearCurrentCommand();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearCurrentCommand();
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();

      if (session.cancelRequested) {
        const error = new Error("Test run canceled.");

        error.canceled = true;
        error.stdout = stdoutText;
        error.stderr = stderrText;
        reject(error);
        return;
      }

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
    });
  });
}

function runGraphTestCommand({
  graph,
  args,
  session,
  runCommand = run,
}) {
  const command = {
    cmd: path.join("..", "mach"),
    args,
    cwd: graph.path,
    capture: true,
  };

  return runCommand === run
    ? runInteractiveTestCommand({ command, session })
    : runInjectedTestCommand({ command, session, runCommand });
}

function finishGraphTestSession(session, graph, commandFailed = false) {
  recordGraphTestFailureOutput(session, "", { flush: true });
  session.summary = parseGraphTestOutput({
    output: session.output,
    graph,
    targets: session.targets,
    commandFailed,
    knownFailures: session.failures,
  });
  session.failures = session.summary.failures;
  session.canRerunFailures = session.targets.length > 1 && session.summary.failedPaths.length > 0;
}

function getGraphTestLiveSummary(session) {
  if (session.summary) {
    return session.summary;
  }

  return parseGraphTestOutput({
    output: session.output,
    graph: { path: session.path },
    targets: session.targets,
    running: session.status === "running",
    knownFailures: session.failures,
  });
}

export function createGraphTestSession({
  graph,
  graphIndex,
  options = {},
  runCommand = run,
}) {
  const normalizedOptions = normalizeGraphTestOptions(options);
  const session = {
    id: randomUUID(),
    graphIndex,
    label: graph.label,
    path: graph.path,
    options: normalizedOptions,
    targets: [],
    status: "running",
    message: "Tests starting...",
    output: "",
    error: "",
    summary: null,
    failures: [],
    failureKeys: new Set(),
    failureParseBuffer: "",
    canRerunFailures: false,
    cancelRequested: false,
    child: null,
    cancelCurrentCommand: null,
    canCancel: true,
  };

  session.cancel = () => {
    if (GRAPH_MACH_TERMINAL_STATUSES.has(session.status)) {
      return;
    }

    session.cancelRequested = true;
    session.message = "Canceling tests...";

    if (session.cancelCurrentCommand) {
      session.cancelCurrentCommand();
      return;
    }

    session.status = "canceled";
    session.message = "Test run canceled.";
    session.canCancel = false;
    appendTestOutput(session, "\nTest run canceled.\n");
    finishGraphTestSession(session, graph);
  };

  queueMicrotask(async () => {
    try {
      session.targets = await getTestTargets({
        flavor: normalizedOptions.flavor,
        pattern: normalizedOptions.pattern,
        getChangedFiles: () => getGraphChangedFilePaths({ graph, runCommand }),
      });

      if (!session.targets.length) {
        appendTestOutput(session, "No tests to run.\n");
        session.status = "complete";
        session.message = "No tests to run.";
        session.canCancel = false;
        finishGraphTestSession(session, graph);
        return;
      }

      session.message = `Running ${session.targets.length} test target${session.targets.length === 1 ? "" : "s"}...`;
      await runGraphTestCommand({
        graph,
        args: ["test", ...(normalizedOptions.headless ? ["--headless"] : []), ...session.targets],
        session,
        runCommand,
      });

      session.status = "complete";
      session.message = "Tests complete.";
      session.canCancel = false;
      finishGraphTestSession(session, graph);

      if (session.summary.status === "failed") {
        session.status = "error";
        session.message = "Tests failed.";
      }
    } catch (error) {
      if (session.cancelRequested || error.canceled) {
        session.status = "canceled";
        session.message = "Test run canceled.";
        session.error = "";
        appendTestOutput(session, "\nTest run canceled.\n");
      } else {
        session.status = "error";
        session.error = String(error?.message || error);
        session.message = "Tests failed.";
      }

      session.canCancel = false;
      finishGraphTestSession(session, graph, session.status === "error");
    }
  });

  return session;
}

export function serializeGraphTestSession(session) {
  const summary = getGraphTestLiveSummary(session);

  return {
    id: session.id,
    graphIndex: session.graphIndex,
    label: session.label,
    path: session.path,
    options: session.options,
    targets: session.targets,
    status: session.status,
    message: session.message,
    output: session.output || "",
    error: session.error,
    summary,
    failures: summary.failures || [],
    failedFiles: summary.failedFiles || [],
    canRerunFailures: Boolean(session.canRerunFailures || (session.targets.length > 1 && summary.failedPaths.length > 0)),
    canCancel: Boolean(session.canCancel),
  };
}
