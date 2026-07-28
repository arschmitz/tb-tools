import {
  INTERACTIVE,
  testClose,
  testDialog,
  testFlavor,
  testHeadless,
  testOutputCommand,
  testOutputFailures,
  testOutputLog,
  testOutputPanel,
  testOutputStatus,
  testOutputSummary,
  testOutputTab,
  testRerunAll,
  testResultsState,
  testPattern,
  testStatus,
  testSubmit,
  uiState,
} from "./config.js";
import {
  hasActiveCommandSession,
  hasActiveTestSession,
  setMachCancelButton,
  setMachOutputPanel,
  setUpdateBusy,
  setUpdateStatus,
} from "./command-sessions.js";

const ANSI_COLORS = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};
const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE_CHARACTER}(?:\\[([0-9;]*)[ -/]*([@-~])|[()][A-Za-z0-9])`, "g");

function getAnsi256Color(index) {
  const colorIndex = Number(index);

  if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 255) {
    return "";
  }

  const baseColors = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];

  if (colorIndex < baseColors.length) {
    return baseColors[colorIndex];
  }

  if (colorIndex >= 232) {
    const level = 8 + ((colorIndex - 232) * 10);

    return `rgb(${level}, ${level}, ${level})`;
  }

  const cube = colorIndex - 16;
  const red = Math.floor(cube / 36);
  const green = Math.floor((cube % 36) / 6);
  const blue = cube % 6;
  const toValue = (part) => part === 0 ? 0 : 55 + (part * 40);

  return `rgb(${toValue(red)}, ${toValue(green)}, ${toValue(blue)})`;
}

function getAnsiClasses(state) {
  return [
    state.colorClass,
    state.bold ? "ansi-bold" : "",
    state.underline ? "ansi-underline" : "",
  ].filter(Boolean);
}

function appendAnsiText(container, text, state) {
  if (!text) {
    return;
  }

  const classes = getAnsiClasses(state);

  if (!classes.length && !state.color) {
    container.append(document.createTextNode(text));
    return;
  }

  const span = document.createElement("span");

  span.className = classes.join(" ");
  if (state.color) {
    span.style.color = state.color;
  }
  span.textContent = text;
  container.append(span);
}

function readAnsiColor(codes, index) {
  if (codes[index + 1] === 5) {
    return {
      color: getAnsi256Color(codes[index + 2]),
      nextIndex: index + 2,
    };
  }

  if (codes[index + 1] === 2) {
    const red = Number(codes[index + 2]);
    const green = Number(codes[index + 3]);
    const blue = Number(codes[index + 4]);

    if ([red, green, blue].every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return {
        color: `rgb(${red}, ${green}, ${blue})`,
        nextIndex: index + 4,
      };
    }
  }

  return {
    color: "",
    nextIndex: index,
  };
}

function applyAnsiCodes(state, rawCodes = "") {
  const codes = rawCodes
    ? rawCodes.split(";").map((code) => Number(code) || 0)
    : [0];

  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];

    if (code === 0) {
      state.color = "";
      state.colorClass = "";
      state.bold = false;
      state.underline = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 22) {
      state.bold = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 38) {
      const color = readAnsiColor(codes, index);

      state.color = color.color;
      state.colorClass = "";
      index = color.nextIndex;
    } else if (code === 39) {
      state.color = "";
      state.colorClass = "";
    } else if (ANSI_COLORS[code]) {
      state.color = "";
      state.colorClass = ANSI_COLORS[code];
    }
  }
}

export function renderAnsiOutput(container, output = "") {
  if (!container) {
    return;
  }

  container.replaceChildren();

  const state = {
    color: "",
    colorClass: "",
    bold: false,
    underline: false,
  };
  const text = String(output || "").replace(/\r\n?/g, "\n");
  let lastIndex = 0;
  let match;

  while ((match = ANSI_PATTERN.exec(text))) {
    appendAnsiText(container, text.slice(lastIndex, match.index), state);

    if (match[2] === "m") {
      applyAnsiCodes(state, match[1]);
    }

    lastIndex = ANSI_PATTERN.lastIndex;
  }

  appendAnsiText(container, text.slice(lastIndex), state);
  container.scrollTop = container.scrollHeight;
}

function splitPatternInput(value = "") {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getTestDialogOptions() {
  return {
    flavor: testFlavor.value,
    pattern: splitPatternInput(testPattern.value),
    headless: testHeadless.checked,
  };
}

function setTestDialogBusy(busy) {
  testFlavor.disabled = busy;
  testPattern.disabled = busy;
  testHeadless.disabled = busy;
  testSubmit.disabled = busy;
  testClose.disabled = false;
}

function getTestSessionStatusText(session) {
  if (session.summary?.status === "not-run") {
    return "No tests to run.";
  }

  if (session.status === "running") {
    return session.message || "Tests running...";
  }

  if (session.status === "canceled") {
    return session.message || "Test run canceled.";
  }

  if (session.summary?.status === "failed") {
    const count = session.summary.failureCount || session.failures?.length || 0;

    return count ? `Tests failed: ${count} failure${count === 1 ? "" : "s"}.` : "Tests failed.";
  }

  if (session.status === "error") {
    return session.error || session.message || "Tests failed.";
  }

  return session.message || "Tests complete.";
}

function setTestCancelButton(session) {
  const button = document.querySelector(".mach-cancel");

  if (!button) {
    return;
  }

  const canCancel = Boolean(session && session.canCancel && session.status === "running");

  button.hidden = !canCancel;
  button.disabled = false;
  button.textContent = "Cancel Tests";
}

function showOnlyTestOutputTab() {
  if (!testOutputTab || !testOutputPanel) {
    return;
  }

  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  testOutputTab.hidden = false;
  testOutputTab.classList.add("active");
  testOutputPanel.hidden = false;
  testOutputPanel.classList.add("active");
}

export function showTestOutputTab() {
  showOnlyTestOutputTab();
}

function createSummaryCard(label, value, state = "") {
  const card = document.createElement("div");
  const labelElement = document.createElement("span");
  const valueElement = document.createElement("strong");

  card.className = `test-summary-card ${state}`.trim();
  labelElement.className = "test-summary-label";
  valueElement.className = "test-summary-value";
  labelElement.textContent = label;
  valueElement.textContent = value === null || value === undefined ? "-" : String(value);
  card.append(labelElement, valueElement);
  return card;
}

function getTestSummaryStatus(summary) {
  if (!summary) {
    return "Waiting";
  }

  if (summary.status === "passed") {
    return "Passed";
  }

  if (summary.status === "failed") {
    return "Failed";
  }

  if (summary.status === "running") {
    return "Running";
  }

  return "Not run";
}

function getTestSummaryState(summary) {
  if (summary?.status === "passed") {
    return "passed";
  }

  if (summary?.status === "failed") {
    return "failed";
  }

  return "neutral";
}

function renderTestSummary(summary) {
  testOutputSummary.replaceChildren();
  testOutputSummary.classList.toggle("empty", !summary);

  if (!summary) {
    testOutputSummary.textContent = "Final summary totals will appear here when the run finishes.";
    return;
  }

  const cards = [
    createSummaryCard("Status", getTestSummaryStatus(summary), getTestSummaryState(summary)),
    createSummaryCard("Targets", summary.targetCount, "neutral"),
  ];

  if (summary.passed !== null) {
    cards.push(createSummaryCard("Passed", summary.passed, "passed"));
  }

  if (summary.failureCount !== null) {
    cards.push(createSummaryCard("Failed", summary.failureCount, summary.failureCount ? "failed" : "passed"));
  }

  if (summary.skipped !== null) {
    cards.push(createSummaryCard("Skipped", summary.skipped, "neutral"));
  }

  if (summary.todo !== null) {
    cards.push(createSummaryCard("Todo", summary.todo, "neutral"));
  }

  if (summary.ran !== null) {
    cards.push(createSummaryCard("Checks", summary.ran, "neutral"));
  }

  testOutputSummary.append(...cards);
}

function renderTestTargets(session) {
  const targets = Array.isArray(session.targets) ? session.targets : [];
  const args = [
    ...(session.options?.headless ? ["--headless"] : []),
    ...targets,
  ];

  testOutputCommand.replaceChildren();

  testOutputCommand.textContent = args.length ? `mach test ${args.join(" ")}` : "mach test";
}

function createFailureButton(className, text, path) {
  const button = document.createElement("button");

  button.className = className;
  button.type = "button";
  button.dataset.path = path || "";
  button.textContent = text;
  return button;
}

function getFailedFilesFromSession(session) {
  if (Array.isArray(session.failedFiles) && session.failedFiles.length) {
    return session.failedFiles;
  }

  if (Array.isArray(session.summary?.failedFiles) && session.summary.failedFiles.length) {
    return session.summary.failedFiles;
  }

  const files = new Map();

  for (const failure of session.failures || []) {
    if (!failure.path) {
      continue;
    }

    const existing = files.get(failure.path);

    if (existing) {
      existing.failureCount += 1;
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

function createTestSectionTitle(text) {
  const title = document.createElement("p");

  title.className = "test-section-title";
  title.textContent = text;
  return title;
}

function createFailurePathLabel(failure) {
  const label = document.createElement("div");
  const suffix = failure.lineNumber ? `:${failure.lineNumber}` : "";

  label.className = "test-failure-path";
  label.textContent = failure.path ? `${failure.path}${suffix}` : "Path not parsed";
  label.title = label.textContent;
  return label;
}

function createOpenVscodeLink(item) {
  const link = document.createElement("a");

  link.className = "test-open-vscode";
  link.href = item.vscodeUrl || "#";
  link.textContent = "VS Code";
  link.rel = "noreferrer";
  return link;
}

function createFailureActions(item, session) {
  const actions = document.createElement("div");

  actions.className = "test-failure-actions";

  if (!item.path) {
    return actions;
  }

  actions.append(
    createFailureButton("test-copy-path", "Copy path", item.path),
    createOpenVscodeLink(item)
  );

  if (session.canRerunFailures) {
    const rerunButton = createFailureButton("test-rerun-file", "Rerun file", item.path);

    rerunButton.dataset.headless = session.options?.headless ? "true" : "false";
    actions.append(rerunButton);
  }

  return actions;
}

function renderFailedFiles(session) {
  const failedFiles = getFailedFilesFromSession(session);
  const wrapper = document.createElement("div");
  const list = document.createElement("div");

  wrapper.className = "test-failed-files";
  list.className = "test-failed-file-list";
  wrapper.append(createTestSectionTitle("Failed files"), list);

  for (const file of failedFiles) {
    const row = document.createElement("div");
    const fileInfo = document.createElement("div");
    const pathLabel = createFailurePathLabel(file);
    const count = document.createElement("span");

    row.className = "test-failed-file";
    fileInfo.className = "test-failed-file-info";
    pathLabel.className = "test-failed-file-path";
    count.className = "test-failed-file-count";
    count.textContent = `${file.failureCount || 1} failure${file.failureCount === 1 ? "" : "s"}`;
    fileInfo.append(pathLabel, count);
    row.append(fileInfo, createFailureActions(file, session));
    list.append(row);
  }

  return failedFiles.length ? wrapper : null;
}

function renderTestFailures(session) {
  const failures = Array.isArray(session.failures) ? session.failures : [];
  const failedFiles = getFailedFilesFromSession(session);

  testOutputFailures.replaceChildren();
  testOutputFailures.classList.toggle("empty", !failures.length && !failedFiles.length);

  if (!failures.length && !failedFiles.length) {
    if (session.status === "running") {
      testOutputFailures.textContent = session.summary?.failureCount
        ? "Waiting for file-level failure details from the test harness..."
        : "No failure lines parsed yet.";
    } else if (session.summary?.status === "passed") {
      testOutputFailures.textContent = "No failures.";
    } else if (session.summary?.status === "failed" || session.status === "error") {
      testOutputFailures.textContent = "No failure lines were found in the retained output.";
    } else {
      testOutputFailures.textContent = "Failure lines with copy, open, and rerun actions will appear here.";
    }
    return;
  }

  const fileList = renderFailedFiles(session);
  const list = document.createElement("div");

  list.className = "test-failure-list";

  for (const failure of failures) {
    const row = document.createElement("div");
    const meta = document.createElement("div");
    const line = document.createElement("code");

    row.className = "test-failure";
    meta.className = "test-failure-meta";
    line.className = "test-failure-line";
    line.textContent = failure.line || failure.path || "Test failure";

    meta.append(createFailurePathLabel(failure), createFailureActions(failure, session));
    row.append(meta, line);
    list.append(row);
  }

  if (fileList) {
    testOutputFailures.append(fileList);
  }

  if (failures.length) {
    testOutputFailures.append(createTestSectionTitle("Failure lines"), list);
  }
}

function getTestResultsStateText(session) {
  const failedFileCount = getFailedFilesFromSession(session).length;
  const parsedFailureCount = session.failures?.length || 0;
  const reportedFailureCount = session.summary?.failureCount || parsedFailureCount;

  if (session.status === "running") {
    if (parsedFailureCount) {
      return `Parsing live output: ${parsedFailureCount} failure line${parsedFailureCount === 1 ? "" : "s"} in ${failedFileCount} file${failedFileCount === 1 ? "" : "s"}`;
    }

    return reportedFailureCount
      ? `Waiting for failure details: ${reportedFailureCount} unexpected result${reportedFailureCount === 1 ? "" : "s"} reported`
      : "Parsing live output";
  }

  if (session.summary?.status === "passed") {
    return "Final summary: no failures";
  }

  if (session.summary?.status === "failed") {
    if (parsedFailureCount) {
      return `Final summary: ${parsedFailureCount} failure line${parsedFailureCount === 1 ? "" : "s"} in ${failedFileCount} file${failedFileCount === 1 ? "" : "s"}`;
    }

    return `Final summary: ${reportedFailureCount} unexpected result${reportedFailureCount === 1 ? "" : "s"}, no parsed failure lines`;
  }

  if (session.summary?.status === "not-run") {
    return "No tests were selected";
  }

  return "Waiting for a test run.";
}

function setTestRerunAllButton(session, active) {
  const targets = Array.isArray(session.targets) ? session.targets : [];

  testRerunAll.hidden = active || !targets.length;
  testRerunAll.disabled = active || !targets.length;
  testRerunAll.dataset.targets = JSON.stringify(targets);
  testRerunAll.dataset.flavor = session.options?.flavor || "all";
  testRerunAll.dataset.headless = session.options?.headless ? "true" : "false";
}

function renderGraphTestSession(session) {
  const active = session.status === "running";

  uiState.activeTestSession = active ? session : null;
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setMachCancelButton(null);
  setTestCancelButton(session);
  showOnlyTestOutputTab();
  renderTestTargets(session);
  renderTestSummary(session.summary);
  renderTestFailures(session);
  testResultsState.textContent = getTestResultsStateText(session);
  setTestRerunAllButton(session, active);
  renderAnsiOutput(testOutputLog, session.output || "");

  testOutputStatus.textContent = getTestSessionStatusText(session);
  testOutputStatus.classList.toggle("error", session.status === "error" || session.summary?.status === "failed");
  setUpdateStatus(getTestSessionStatusText(session), {
    error: session.status === "error" || session.summary?.status === "failed",
    busy: active,
  });

  if (!active) {
    setTestCancelButton(null);
  }
}

export function openTestDialog() {
  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  testStatus.classList.remove("error");
  testStatus.textContent = "Run modified tests or enter a path/glob pattern.";
  setTestDialogBusy(false);
  testDialog.showModal();
  testPattern.focus();
}

export async function pollGraphTestSession() {
  if (!uiState.activeTestSession) {
    return;
  }

  try {
    const response = await fetch(
      "/api/test/" + encodeURIComponent(uiState.activeTestSession.id) +
        "?token=" + encodeURIComponent(INTERACTIVE.token)
    );
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphTestSession(result);

    if (result.status === "running") {
      uiState.testPollTimer = window.setTimeout(pollGraphTestSession, 500);
    }
  } catch (error) {
    uiState.activeTestSession = null;
    setTestCancelButton(null);
    testOutputStatus.classList.add("error");
    testOutputStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  }
}

export async function startGraphTestSession(event, overrideOptions) {
  if (event) {
    event.preventDefault();
  }

  if (hasActiveCommandSession()) {
    alert("A command is already active.");
    return;
  }

  if (uiState.testPollTimer) {
    window.clearTimeout(uiState.testPollTimer);
    uiState.testPollTimer = null;
  }

  const options = overrideOptions || getTestDialogOptions();

  setTestDialogBusy(true);
  testStatus.classList.remove("error");
  testStatus.textContent = "Starting tests...";
  testOutputStatus.textContent = "Starting tests...";
  renderTestSummary(null);
  renderTestFailures({ status: "running", summary: null, failures: [] });
  testResultsState.textContent = "Starting tests...";
  testRerunAll.hidden = true;
  testRerunAll.disabled = true;
  renderAnsiOutput(testOutputLog, "");
  showOnlyTestOutputTab();
  uiState.lastMachSession = null;
  uiState.machOutputVisible = false;
  setMachOutputPanel(null);
  setUpdateStatus("Tests starting...", { busy: true });

  try {
    const response = await fetch("/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: INTERACTIVE.token,
        options,
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    if (testDialog.open) {
      testDialog.close();
    }

    renderGraphTestSession(result);

    if (result.status === "running") {
      uiState.testPollTimer = window.setTimeout(pollGraphTestSession, 500);
    }
  } catch (error) {
    testStatus.classList.add("error");
    testStatus.textContent = error && error.message ? error.message : String(error);
    testOutputStatus.classList.add("error");
    testOutputStatus.textContent = error && error.message ? error.message : String(error);
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    setTestDialogBusy(false);

    if (!hasActiveTestSession()) {
      setUpdateBusy(false);
    }
  }
}

export async function cancelGraphTestSession() {
  if (!uiState.activeTestSession) {
    return;
  }

  const sessionId = uiState.activeTestSession.id;
  const cancelButton = document.querySelector(".mach-cancel");

  if (cancelButton) {
    cancelButton.disabled = true;
  }

  setUpdateStatus("Canceling tests...", { busy: true });

  try {
    const response = await fetch("/api/test/" + encodeURIComponent(sessionId) + "/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: INTERACTIVE.token }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || response.statusText);
    }

    renderGraphTestSession(result);

    if (result.status === "running") {
      uiState.testPollTimer = window.setTimeout(pollGraphTestSession, 500);
    }
  } catch (error) {
    setUpdateStatus(error && error.message ? error.message : String(error), { error: true });
  } finally {
    if (!hasActiveTestSession()) {
      setUpdateBusy(false);
    }
  }
}

export function handleTestOutputClick(event) {
  const copyButton = event.target.closest(".test-copy-path");

  if (copyButton) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(copyButton.dataset.path);
    }
    return true;
  }

  const rerunButton = event.target.closest(".test-rerun-file");

  if (rerunButton) {
    startGraphTestSession(null, {
      flavor: "all",
      pattern: [rerunButton.dataset.path],
      headless: rerunButton.dataset.headless === "true",
    });
    return true;
  }

  const rerunAllButton = event.target.closest(".test-rerun-all");

  if (rerunAllButton) {
    let targets = [];

    try {
      targets = JSON.parse(rerunAllButton.dataset.targets || "[]");
    } catch {
      targets = [];
    }

    if (targets.length) {
      startGraphTestSession(null, {
        flavor: rerunAllButton.dataset.flavor || "all",
        pattern: targets,
        headless: rerunAllButton.dataset.headless === "true",
      });
    }
    return true;
  }

  return false;
}
