export const FIELD_SEPARATOR = "\x1f";
export const RECORD_SEPARATOR = "\x1e";
export const DEFAULT_MAX_DIFF_BYTES = 200000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CLIENT_DISCONNECT_GRACE_MS = 4000;
export const DEFAULT_BROWSER_SHUTDOWN_GRACE_MS = 750;
export const DEFAULT_SUBMIT_OUTPUT_LIMIT = 160000;
export const DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS = 15 * 1000;
export const CHECKIN_NEEDED_KEYWORD = "checkin-needed-tb";
export const GRAPH_UPDATE_MODE_UPDATE = "update";
export const GRAPH_UPDATE_MODE_REBASE = "rebase";
export const GRAPH_UPDATE_MODES = new Set([
  GRAPH_UPDATE_MODE_UPDATE,
  GRAPH_UPDATE_MODE_REBASE,
]);
export const GRAPH_UPDATE_DIRTY_ACTIONS = new Set(["amend", "shelf"]);
export const GRAPH_SHELF_MESSAGE_PREFIX = "tb-tools graph update";
export const GRAPH_MACH_ACTION_BUILD = "build";
export const GRAPH_MACH_ACTION_RUN = "run";
export const GRAPH_MACH_ACTION_BUILD_RUN = "build-run";
export const GRAPH_TRY_STORE_FILE = "tb-tools-try-runs.json";
export const GRAPH_TRY_STORE_VERSION = 1;
export const GRAPH_WORKING_TREE_TRY_PREFIX = "working:";
export const GRAPH_CLIENT_STYLESHEETS = [
  { output: "graph-client/style.css", source: "style.css" },
];
export const GRAPH_CLIENT_SCRIPTS = [
  { output: "graph-client/config.js", source: "config.js" },
  { output: "graph-client/commit-model.js", source: "commit-model.js" },
  { output: "graph-client/dom.js", source: "dom.js" },
  { output: "graph-client/pane-resizer.js", source: "pane-resizer.js" },
  { output: "graph-client/lane-renderer.js", source: "lane-renderer.js" },
  { output: "graph-client/diff-viewer.js", source: "diff-viewer.js" },
  { output: "graph-client/command-sessions.js", source: "command-sessions.js" },
  { output: "graph-client/rebase-dialog.js", source: "rebase-dialog.js" },
  { output: "graph-client/interactive-rebase-dialog.js", source: "interactive-rebase-dialog.js" },
  { output: "graph-client/commit-actions.js", source: "commit-actions.js" },
  { output: "graph-client/commit-dialog.js", source: "commit-dialog.js" },
  { output: "graph-client/landing-dialog.js", source: "landing-dialog.js" },
  { output: "graph-client/new-patch-dialog.js", source: "new-patch-dialog.js" },
  { output: "graph-client/patch-dialog.js", source: "patch-dialog.js" },
  { output: "graph-client/test-dialog.js", source: "test-dialog.js" },
  { output: "graph-client/init.js", source: "init.js" },
];
export const GRAPH_MACH_ACTIONS = new Set([
  GRAPH_MACH_ACTION_BUILD,
  GRAPH_MACH_ACTION_RUN,
  GRAPH_MACH_ACTION_BUILD_RUN,
]);
export const GRAPH_MACH_TERMINAL_STATUSES = new Set([
  "complete",
  "error",
  "canceled",
]);
export const WORKING_TREE_CHANGES_HASH = "uncommitted-changes";
export const GRAPH_SUBMIT_OPTIONS = {
  artifact: true,
  flavor: "all",
  selector: "auto",
};
export const WORKING_TREE_AUTHOR = {
  name: "Working tree",
  email: "",
  timestamp: 0,
};
