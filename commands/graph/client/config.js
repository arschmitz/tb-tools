import { getCurrentCommitHash, placeWorkingTreeCommits } from "./commit-model.js";

const configElement = document.getElementById("graph-config");
const config = configElement ? JSON.parse(configElement.textContent || "{}") : {};
export const GRAPHS = Array.isArray(config.graphs) ? config.graphs : [];
export const INTERACTIVE = config.interactive || { enabled: false, pageSize: 80, pollIntervalMs: 3000 };
export const DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS = Number(config.originMainStatusCacheMs || 15000);

export const SVG_NS = "http://www.w3.org/2000/svg";
export const COMMIT_DOT_RADIUS = 10;
export const COMMIT_ROW_HEIGHT = 28;
export const COMMIT_ROW_HORIZONTAL_INSET = 4;
export const LANE_LEFT = 14;
export const LANE_TOP = 14;
export const LANE_SPACING = 20;
export const LANE_MESSAGE_GAP = 18;
export const LANE_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ca8a04", "#dc2626", "#0891b2", "#7c3aed", "#db2777", "#ea580c", "#0f766e"];
export const COMMIT_HASH_WIDTH = 116;
export const BRANCH_LABEL_HEIGHT = 18;
export const BRANCH_LABEL_GAP = 5;
export const BRANCH_LABEL_PADDING_X = 6;
export const BRANCH_LABEL_TEXT_WIDTH = 7.25;
export const COMMIT_SUBJECT_GAP = 8;
export const PANE_MIN_WIDTH = 320;
export const PANE_RESIZE_KEY_STEP = 32;
export const PANE_WIDTH_STORAGE_PREFIX = "branch-graph:pane-width:";
export const BUGZILLA_BUG_URL = "https://bugzilla.mozilla.org/show_bug.cgi?id=";
export const PHABRICATOR_REVISION_URL = "https://phabricator.services.mozilla.com/D";
export const COMMIT_MESSAGE_LINK_PATTERN = /(https?:\/\/[^\s<>"']+|\b[Bb]ug\s+#?\d{4,8}\b|\b(?:phab-)?D\d{4,}\b)/g;

export const graphStates = GRAPHS.map((graph) => {
  const commits = placeWorkingTreeCommits(graph.commits ? [...graph.commits] : []);
  graph.commits = commits;

  return {
    graph,
    commits,
    offset: commits.length,
    hasMore: Boolean(INTERACTIVE.enabled),
    loading: false,
    rendered: false,
    sentinelReady: true,
    lastScrollY: window.scrollY,
    scrolledTowardBottom: false,
    selectedHash: "",
    currentHash: getCurrentCommitHash(commits),
    workingTreeCount: graph.workingTreeCount || 0,
    snapshotSignature: "",
    refreshing: false,
    branchColors: new Map(),
    nextBranchColorIndex: 0,
  };
});
export const contextMenu = document.getElementById("commit-context-menu");
export const rebaseDialog = document.getElementById("rebase-dialog");
export const rebaseStatus = rebaseDialog.querySelector(".rebase-status");
export const rebaseSummary = rebaseDialog.querySelector(".rebase-summary");
export const rebaseConflictFiles = rebaseDialog.querySelector(".rebase-conflict-files");
export const rebaseOutput = rebaseDialog.querySelector(".rebase-output");
export const rebaseError = rebaseDialog.querySelector(".rebase-error");
export const rebaseClose = rebaseDialog.querySelector(".rebase-close");
export const rebaseContinue = rebaseDialog.querySelector(".rebase-continue");
export const interactiveRebaseDialog = document.getElementById("interactive-rebase-dialog");
export const interactiveRebaseForm = interactiveRebaseDialog.querySelector(".interactive-rebase-form");
export const interactiveRebaseStatus = interactiveRebaseDialog.querySelector(".interactive-rebase-status");
export const interactiveRebaseEnd = interactiveRebaseDialog.querySelector(".interactive-rebase-end");
export const interactiveRebaseTodo = interactiveRebaseDialog.querySelector(".interactive-rebase-todo");
export const interactiveRebaseError = interactiveRebaseDialog.querySelector(".interactive-rebase-error");
export const interactiveRebaseSubmit = interactiveRebaseDialog.querySelector(".interactive-rebase-submit");
export const amendDialog = document.getElementById("amend-dialog");
export const amendForm = amendDialog.querySelector(".amend-form");
export const amendMessage = amendDialog.querySelector(".amend-message");
export const amendError = amendDialog.querySelector(".amend-error");
export const amendSubmit = amendDialog.querySelector(".amend-submit");
export const commitDialog = document.getElementById("commit-dialog");
export const commitForm = commitDialog.querySelector(".commit-form");
export const commitBranchStatus = commitDialog.querySelector(".commit-branch-status");
export const commitBugField = commitDialog.querySelector(".commit-bug-field");
export const commitBug = commitDialog.querySelector(".commit-bug");
export const commitSummary = commitDialog.querySelector(".commit-summary");
export const commitReviewerPills = commitDialog.querySelector(".commit-reviewer-pills");
export const commitReviewerInput = commitDialog.querySelector(".commit-reviewer-input");
export const commitReviewerList = commitDialog.querySelector(".commit-reviewer-list");
export const commitStatus = commitDialog.querySelector(".commit-status");
export const commitClose = commitDialog.querySelector(".commit-close");
export const commitSubmit = commitDialog.querySelector(".commit-submit");
export const submitDialog = document.getElementById("submit-dialog");
export const submitTitle = submitDialog.querySelector(".submit-title");
export const submitStatus = submitDialog.querySelector(".submit-status");
export const submitPrompt = submitDialog.querySelector(".submit-prompt");
export const submitQuestion = submitDialog.querySelector(".submit-question");
export const submitLinks = submitDialog.querySelector(".submit-links");
export const submitOutput = submitDialog.querySelector(".submit-output");
export const submitClose = submitDialog.querySelector(".submit-close");
export const tryDialog = document.getElementById("try-dialog");
export const tryForm = tryDialog.querySelector(".try-form");
export const trySelector = tryDialog.querySelector(".try-selector");
export const tryQueryField = tryDialog.querySelector(".try-query-field");
export const tryTasksField = tryDialog.querySelector(".try-tasks-field");
export const tryStatus = tryDialog.querySelector(".try-status");
export const landDialog = document.getElementById("land-dialog");
export const landStatus = landDialog.querySelector(".land-status");
export const landPrompt = landDialog.querySelector(".land-prompt");
export const landQuestion = landDialog.querySelector(".land-question");
export const landChoiceList = landDialog.querySelector(".land-choice-list");
export const landLinks = landDialog.querySelector(".land-links");
export const landDetail = landDialog.querySelector(".land-detail");
export const landInputForm = landDialog.querySelector(".land-input-form");
export const landInput = landDialog.querySelector(".land-input");
export const landOutput = landDialog.querySelector(".land-output");
export const landStart = landDialog.querySelector(".land-start");
export const landClose = landDialog.querySelector(".land-close");
export const newPatchDialog = document.getElementById("new-patch-dialog");
export const newPatchForm = newPatchDialog.querySelector(".new-patch-form");
export const newPatchBug = newPatchDialog.querySelector(".new-patch-bug");
export const newPatchStatus = newPatchDialog.querySelector(".new-patch-status");
export const newPatchLinks = newPatchDialog.querySelector(".new-patch-links");
export const newPatchOutput = newPatchDialog.querySelector(".new-patch-output");
export const newPatchClose = newPatchDialog.querySelector(".new-patch-close");
export const newPatchSubmit = newPatchDialog.querySelector(".new-patch-submit");
export const patchDialog = document.getElementById("patch-dialog");
export const patchForm = patchDialog.querySelector(".patch-form");
export const patchRevision = patchDialog.querySelector(".patch-revision");
export const patchApplyTo = patchDialog.querySelector(".patch-apply-to");
export const patchRaw = patchDialog.querySelector(".patch-raw");
export const patchStatus = patchDialog.querySelector(".patch-status");
export const patchPrompt = patchDialog.querySelector(".patch-prompt");
export const patchQuestion = patchDialog.querySelector(".patch-question");
export const patchLinks = patchDialog.querySelector(".patch-links");
export const patchOutput = patchDialog.querySelector(".patch-output");
export const patchClose = patchDialog.querySelector(".patch-close");
export const patchSubmit = patchDialog.querySelector(".patch-submit");
export const testDialog = document.getElementById("test-dialog");
export const testForm = testDialog.querySelector(".test-form");
export const testFlavor = testDialog.querySelector(".test-flavor");
export const testPattern = testDialog.querySelector(".test-pattern");
export const testHeadless = testDialog.querySelector(".test-headless");
export const testStatus = testDialog.querySelector(".test-status");
export const testClose = testDialog.querySelector(".test-close");
export const testSubmit = testDialog.querySelector(".test-submit");
export const testOutputTab = document.querySelector(".test-output-tab");
export const testOutputPanel = document.querySelector(".test-output-panel");
export const testOutputStatus = testOutputPanel.querySelector(".test-output-status");
export const testOutputCommand = testOutputPanel.querySelector(".test-output-command");
export const testResultsState = testOutputPanel.querySelector(".test-results-state");
export const testRerunAll = testOutputPanel.querySelector(".test-rerun-all");
export const testOutputSummary = testOutputPanel.querySelector(".test-output-summary");
export const testOutputFailures = testOutputPanel.querySelector(".test-output-failures");
export const testOutputLog = testOutputPanel.querySelector(".test-output-log");
export const uiState = {
  contextMenuState: null,
  amendDialogState: null,
  commitDialogState: null,
  submitDialogState: null,
  submitPollTimer: null,
  landDialogState: null,
  landPollTimer: null,
  newPatchDialogState: null,
  newPatchPollTimer: null,
  activeMachSession: null,
  activeLintSession: null,
  activeNewPatchSession: null,
  activePatchSession: null,
  rebaseDialogState: null,
  activeTestSession: null,
  activeTrySession: null,
  activeLandSession: null,
  lastMachSession: null,
  machOutputVisible: false,
  machPollTimer: null,
  lintPollTimer: null,
  patchPollTimer: null,
  testPollTimer: null,
  tryPollTimer: null,
  interactiveRebaseDialogState: null,
  commandStatusStartedAt: 0,
  commandElapsedTimer: null,
  originMainStatusLoading: false,
  originMainStatusRetryTimer: null,
  rustUpstreamStatus: null,
  pendingPaneEnhancements: new Set(),
  loadObserver: null,
};
