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
export const amendDialog = document.getElementById("amend-dialog");
export const amendForm = amendDialog.querySelector(".amend-form");
export const amendMessage = amendDialog.querySelector(".amend-message");
export const amendError = amendDialog.querySelector(".amend-error");
export const amendSubmit = amendDialog.querySelector(".amend-submit");
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
export const uiState = {
  contextMenuState: null,
  amendDialogState: null,
  submitDialogState: null,
  submitPollTimer: null,
  activeMachSession: null,
  activeTrySession: null,
  lastMachSession: null,
  machOutputVisible: false,
  machPollTimer: null,
  tryPollTimer: null,
  commandStatusStartedAt: 0,
  commandElapsedTimer: null,
  originMainStatusLoading: false,
  originMainStatusRetryTimer: null,
  rustUpstreamStatus: null,
  pendingPaneEnhancements: new Set(),
  loadObserver: null,
};
