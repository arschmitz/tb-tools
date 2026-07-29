import { DEFAULT_LANDO_REPO } from "../../lib/lando.mjs";

export { getGraphHtmlStyles } from "./assets.mjs";

const DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS = 15 * 1000;
const DEFAULT_GRAPH_SCRIPT_SRCS = [
  "graph-client/init.js",
];
const DEFAULT_GRAPH_STYLESHEET_HREF = "graph-client/style.css";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function getOriginMainDisplayLabel(label) {
  const normalized = String(label || "").toLowerCase();

  if (normalized === "comm") {
    return "Thunderbird";
  }

  if (normalized === "firefox") {
    return "Firefox";
  }

  return label || "origin/main";
}

export function buildGraphHtml({
  graphs,
  interactive = { enabled: false },
  stylesheetHref = DEFAULT_GRAPH_STYLESHEET_HREF,
  scriptSrcs = DEFAULT_GRAPH_SCRIPT_SRCS,
}) {
  const tabButtons = graphs.map((graph, index) => (
    `<button class="tab${index === 0 ? " active" : ""}" data-index="${index}">${escapeHtml(graph.label)}</button>`
  )).join("\n");
  const testOutputTab = `<button class="tab test-output-tab" type="button" hidden>Test Output</button>`;
  const originMainStatus = interactive.enabled
    ? `<div class="origin-main-status" role="status" aria-label="origin/main freshness">
        ${graphs.length
          ? graphs.map((graph) => (
            `<span class="origin-main-badge checking">${escapeHtml(getOriginMainDisplayLabel(graph.label))}: checking</span>`
          )).join("\n") + `\n<span class="origin-main-badge checking">Rust deps: checking</span>`
          : `<span class="origin-main-badge checking">origin/main: checking</span>
<span class="origin-main-badge checking">Rust deps: checking</span>`}
      </div>`
    : "";
  const graphOptions = interactive.enabled
    ? `<div class="graph-options">
        <button class="graph-menu-button" type="button" aria-label="More actions" aria-haspopup="true" aria-expanded="false" aria-controls="graph-options-menu"><span aria-hidden="true">&#9776;</span></button>
        <div class="graph-options-menu" id="graph-options-menu" role="menu" aria-label="More actions" hidden>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="build">Build</button>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="commit">Commit</button>
          <div class="graph-menu-submenu" role="none">
            <button class="graph-menu-command graph-submenu-trigger" type="button" role="menuitem" aria-haspopup="true" aria-expanded="false" data-menu-action="lint">Lint</button>
            <div class="graph-submenu" role="menu" aria-label="Lint options">
              <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="lint-all">All</button>
              <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="lint-outgoing">Outgoing</button>
            </div>
          </div>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="new-patch">New Patch</button>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="pull-patch">Pull patch</button>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="test">Test</button>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="try">Try</button>
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="land">Land Patches</button>
        </div>
      </div>`
    : "";
  const updateActions = interactive.enabled
    ? `<div class="update-actions" role="toolbar" aria-label="Repository update actions">
        <button class="update-action" type="button" data-mode="update">Update</button>
        <button class="update-action" type="button" data-mode="rebase">Update and Rebase</button>
        <button class="mach-action" type="button" data-action="run">Run</button>
      </div>
      <div class="command-status-bar" role="region" aria-label="Command status" hidden>
        <div class="command-status-primary">
          <span class="command-status-dot" aria-hidden="true"></span>
          <span class="update-status" role="status" hidden></span>
          <span class="command-elapsed" aria-label="Elapsed time"></span>
        </div>
        <div class="command-status-tools">
          <button class="mach-output-toggle" type="button" hidden aria-expanded="false">Output</button>
          <button class="mach-cancel" type="button" hidden>Cancel Build</button>
          <button class="command-status-close" type="button" hidden aria-label="Dismiss command status">&times;</button>
        </div>
        <div class="mach-output-panel" hidden>
          <pre class="mach-output" aria-live="polite"></pre>
        </div>
      </div>`
    : "";
  const tabPanels = graphs.map((graph, index) => (
    `<section class="panel${index === 0 ? " active" : ""}" data-index="${index}">
      <div class="summary" data-index="${index}">
        <strong>${escapeHtml(graph.label)}</strong>
        <span class="summary-path">${escapeHtml(graph.path)}</span>
        <span class="summary-branch">${escapeHtml(graph.branch || "")}</span>
        <span class="summary-count">${graph.commitCount} commit(s)</span>
        <span class="summary-working-tree"${graph.workingTreeCount ? "" : " hidden"}>${graph.workingTreeCount || 0} uncommitted change set</span>
      </div>
      <div class="workspace" data-index="${index}">
        <div class="graph" id="graph-${index}"></div>
        <div
          class="pane-resizer"
          role="separator"
          aria-label="Resize graph and diff panes"
          aria-orientation="vertical"
          aria-controls="graph-${index} diff-${index}"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="54"
          tabindex="0"
          data-index="${index}"
        ></div>
        <aside class="diff-viewer" id="diff-${index}">
          <div class="diff-header">
            <strong class="diff-title">No commit selected</strong>
            <span class="diff-meta"></span>
            <pre class="diff-message" hidden></pre>
            <div class="integration-status" hidden></div>
            <span class="diff-stats" hidden aria-label="">
              <span class="stat-additions"></span>
              <span class="stat-deletions"></span>
            </span>
            <button class="checkout-commit" type="button" hidden>Checkout</button>
            <button class="amend-commit" type="button" hidden>Amend</button>
            <button class="submit-commit" type="button" hidden>Submit</button>
            <span class="checkout-status"></span>
          </div>
          <div class="diff-body"><pre class="diff-placeholder">Select a commit in the graph.</pre></div>
        </aside>
      </div>
    </section>`
  )).join("\n");
  const testOutputPanel = `<section class="test-output-panel" hidden>
      <div class="test-output-header">
        <div>
          <strong>Test Output</strong>
          <p class="test-output-status" role="status">No test run yet.</p>
        </div>
        <div class="test-output-command-row">
          <span>Command</span>
          <code class="test-output-command">mach test</code>
        </div>
      </div>
      <section class="test-results-panel" aria-label="Parsed test results">
        <div class="test-results-header">
          <strong>Parsed Results</strong>
          <div class="test-results-header-actions">
            <span class="test-results-state">Waiting for a test run.</span>
            <button class="test-rerun-all" type="button" hidden>Rerun All</button>
          </div>
        </div>
        <div class="test-output-summary empty">Final summary totals will appear here when the run finishes.</div>
        <div class="test-output-failures empty">Failure lines with copy, open, and rerun actions will appear here.</div>
      </section>
      <pre class="test-output-log" aria-label="Test output"></pre>
    </section>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Thunderbird Desktop Console</title>
  <link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">
</head>
<body>
  <header>
    <div class="header-row">
      <div class="title-row">
        <h1>Thunderbird Desktop Console</h1>
        ${originMainStatus}
      </div>
      ${graphOptions}
    </div>
    <div class="toolbar-row">
      <nav class="tabs">${tabButtons}
${testOutputTab}</nav>
      ${updateActions}
    </div>
  </header>
  <main>${tabPanels}
    ${testOutputPanel}</main>
  <div class="context-menu" id="commit-context-menu" hidden role="menu" aria-label="Commit actions">
    <div class="context-menu-title"></div>
    <button type="button" role="menuitem" data-action="checkout">Checkout</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="selected">Rebase Selected</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="children">Rebase + Children</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="descendants">Rebase + Descendants</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="stack">Rebase Whole Stack</button>
    <button type="button" role="menuitem" data-action="branch">Branch</button>
    <button type="button" role="menuitem" data-action="prune">Prune</button>
  </div>
  <dialog class="rebase-dialog" id="rebase-dialog">
    <div class="rebase-dialog-body">
      <h2 class="rebase-title">Rebase Needs Attention</h2>
      <p class="rebase-status" role="status"></p>
      <p class="rebase-summary"></p>
      <section class="rebase-conflict-section">
        <h3>Conflicted Files</h3>
        <div class="rebase-conflict-files"></div>
      </section>
      <section class="rebase-output-section">
        <h3>Git Output</h3>
        <pre class="rebase-output"></pre>
      </section>
      <p class="rebase-error" role="alert"></p>
      <div class="rebase-actions">
        <button class="rebase-close" type="button">Close</button>
        <button class="rebase-continue" type="button">Continue Rebase</button>
      </div>
    </div>
  </dialog>
  <dialog class="amend-dialog" id="amend-dialog">
    <form class="amend-form">
      <h2 class="amend-title">Amend Commit</h2>
      <label for="amend-message">Commit message</label>
      <textarea id="amend-message" class="amend-message" rows="9" required></textarea>
      <p class="amend-error" role="alert"></p>
      <div class="amend-actions">
        <button class="amend-cancel" type="button">Cancel</button>
        <button class="amend-submit" type="submit">Amend</button>
      </div>
    </form>
  </dialog>
  <dialog class="commit-dialog" id="commit-dialog">
    <form class="commit-form">
      <h2 class="commit-title">Commit Changes</h2>
      <p class="commit-branch-status" role="status">Loading checkout...</p>
      <label class="commit-field commit-bug-field" hidden>Bugzilla bug ID
        <input class="commit-bug" name="bug-id" type="text" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}">
      </label>
      <label class="commit-field">Commit message
        <input class="commit-summary" name="summary" type="text" autocomplete="off" required>
      </label>
      <label class="commit-field">Reviewers and groups
        <div class="commit-reviewer-picker">
          <div class="commit-reviewer-pills" aria-label="Selected reviewers"></div>
          <input
            class="commit-reviewer-input"
            type="text"
            autocomplete="off"
            role="combobox"
            aria-expanded="false"
            aria-controls="commit-reviewer-list"
          >
          <div class="commit-reviewer-list" id="commit-reviewer-list" role="listbox" hidden></div>
        </div>
      </label>
      <p class="commit-status" role="status">Ready to commit changes.</p>
      <div class="commit-actions">
        <button class="commit-close" type="button">Close</button>
        <button class="commit-submit" type="submit">Commit</button>
      </div>
    </form>
  </dialog>
  <dialog class="submit-dialog" id="submit-dialog">
    <div class="submit-panel">
      <h2 class="submit-title">Submit Current Commit</h2>
      <p class="submit-status" role="status">Starting submit...</p>
      <div class="submit-prompt" hidden>
        <p class="submit-question"></p>
        <div class="submit-prompt-actions">
          <button class="submit-answer-yes" type="button" data-answer="true">Yes</button>
          <button class="submit-answer-no" type="button" data-answer="false">No</button>
        </div>
      </div>
      <div class="submit-links" hidden></div>
      <pre class="submit-output" aria-label="Submit output"></pre>
      <div class="submit-actions">
        <button class="submit-close" type="button">Close</button>
      </div>
    </div>
  </dialog>
  <dialog class="try-dialog" id="try-dialog">
    <form class="try-form">
      <h2 class="try-title">Start Try Run</h2>
      <div class="try-grid">
        <label class="try-field">Selector
          <select class="try-selector" name="selector">
            <option value="auto">auto</option>
            <option value="fuzzy">fuzzy</option>
            <option value="empty">empty</option>
            <option value="chooser">chooser</option>
          </select>
        </label>
        <label class="try-field">Preset
          <input class="try-preset" name="preset" type="text" autocomplete="off">
        </label>
        <label class="try-field full try-query-field" hidden>Fuzzy query
          <input class="try-query" name="query" type="text" autocomplete="off">
        </label>
        <label class="try-field full try-tasks-field">Tasks regex
          <input class="try-tasks-regex" name="tasks-regex" type="text" autocomplete="off">
        </label>
      </div>
      <div class="try-checkboxes">
        <label class="try-checkbox"><input class="try-artifact" name="artifact" type="checkbox" checked> Artifact builds where possible</label>
        <label class="try-checkbox"><input class="try-comment" name="comment" type="checkbox"> Post try link to Phabricator</label>
      </div>
      <p class="try-status" role="status"></p>
      <div class="try-actions">
        <button class="try-cancel" type="button">Cancel</button>
        <button class="try-submit" type="submit">Start Try</button>
      </div>
    </form>
  </dialog>
  <dialog class="test-dialog" id="test-dialog">
    <form class="test-form">
      <h2 class="test-title">Run Tests</h2>
      <label class="test-field">Flavor
        <select class="test-flavor" name="flavor">
          <option value="all">all</option>
          <option value="browser">browser</option>
          <option value="unit">unit</option>
        </select>
      </label>
      <label class="test-field">Path or glob pattern
        <textarea class="test-pattern" name="pattern" rows="4" placeholder="Leave blank to use modified tests"></textarea>
      </label>
      <label class="test-checkbox"><input class="test-headless" name="headless" type="checkbox"> Headless</label>
      <p class="test-status" role="status">Run modified tests or enter a path/glob pattern.</p>
      <div class="test-actions">
        <button class="test-close" type="button">Close</button>
        <button class="test-submit" type="submit">Run Tests</button>
      </div>
    </form>
  </dialog>
  <dialog class="new-patch-dialog" id="new-patch-dialog">
    <form class="new-patch-form">
      <h2 class="new-patch-title">New Patch</h2>
      <label class="new-patch-field">Bugzilla bug ID
        <input class="new-patch-bug" name="bug-id" type="text" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}" required>
      </label>
      <label class="new-patch-checkbox"><input class="new-patch-update" name="update" type="checkbox" checked> Update both checkouts first</label>
      <p class="new-patch-status" role="status">Ready to create a new patch branch.</p>
      <div class="new-patch-links" hidden></div>
      <pre class="new-patch-output" aria-label="New patch output"></pre>
      <div class="new-patch-actions">
        <button class="new-patch-close" type="button">Close</button>
        <button class="new-patch-submit" type="submit">Create Patch</button>
      </div>
    </form>
  </dialog>
  <dialog class="patch-dialog" id="patch-dialog">
    <form class="patch-form">
      <h2 class="patch-title">Pull Patch</h2>
      <div class="patch-grid">
        <label class="patch-field">Revision
          <input class="patch-revision" name="revision" type="text" placeholder="D123456" autocomplete="off" required>
        </label>
        <label class="patch-field">Bug branch
          <input class="patch-bug" name="bug" type="text" inputmode="numeric" autocomplete="off">
        </label>
        <label class="patch-field">Apply to
          <select class="patch-apply-to" name="apply-to">
            <option value="">moz-phab default</option>
            <option value="here">here</option>
            <option value="base">base</option>
            <option value="node">node</option>
          </select>
        </label>
        <label class="patch-field">Diff ID
          <input class="patch-diff-id" name="diff-id" type="text" inputmode="numeric" autocomplete="off">
        </label>
        <label class="patch-field full">Name
          <input class="patch-name" name="name" type="text" autocomplete="off">
        </label>
      </div>
      <details class="patch-options">
        <summary>Options</summary>
        <div class="patch-checkboxes">
          <label class="patch-checkbox"><input class="patch-checkpoint" name="checkpoint" type="checkbox" checked> Checkpoint before patching</label>
          <label class="patch-checkbox"><input class="patch-rollback" name="rollback" type="checkbox" checked> Prompt to roll back on failure</label>
          <label class="patch-checkbox"><input class="patch-raw" name="raw" type="checkbox"> Raw patch</label>
          <label class="patch-checkbox"><input class="patch-no-commit" name="no-commit" type="checkbox"> Do not commit</label>
          <label class="patch-checkbox"><input class="patch-no-bookmark" name="no-bookmark" type="checkbox"> No bookmark</label>
          <label class="patch-checkbox"><input class="patch-no-topic" name="no-topic" type="checkbox"> No topic</label>
          <label class="patch-checkbox"><input class="patch-no-branch" name="no-branch" type="checkbox"> No branch</label>
          <label class="patch-checkbox"><input class="patch-skip-dependencies" name="skip-dependencies" type="checkbox"> Skip dependencies</label>
          <label class="patch-checkbox"><input class="patch-include-abandoned" name="include-abandoned" type="checkbox"> Include abandoned</label>
          <label class="patch-checkbox"><input class="patch-safe-mode" name="safe-mode" type="checkbox"> Safe mode</label>
          <label class="patch-checkbox"><input class="patch-force-vcs" name="force-vcs" type="checkbox"> Force VCS</label>
        </div>
      </details>
      <p class="patch-status" role="status">Ready to pull a Phabricator patch.</p>
      <div class="patch-prompt" hidden>
        <p class="patch-question"></p>
        <div class="patch-prompt-actions">
          <button class="patch-answer-yes" type="button" data-answer="true">Yes</button>
          <button class="patch-answer-no" type="button" data-answer="false">No</button>
        </div>
      </div>
      <div class="patch-links" hidden></div>
      <pre class="patch-output" aria-label="Patch output"></pre>
      <div class="patch-actions">
        <button class="patch-close" type="button">Close</button>
        <button class="patch-submit" type="submit">Pull Patch</button>
      </div>
    </form>
  </dialog>
  <dialog class="land-dialog" id="land-dialog">
    <div class="land-panel">
      <h2 class="land-title">Land Patches</h2>
      <div class="land-options">
        <label class="land-field">Lando repository
          <input class="land-lando-repo" name="lando-repo" type="text" value="${escapeHtml(DEFAULT_LANDO_REPO)}" autocomplete="off">
        </label>
        <label class="land-field">Release branch
          <input class="land-relbranch" name="relbranch" type="text" autocomplete="off">
        </label>
      </div>
      <p class="land-status" role="status">Ready to land patches marked for checkin.</p>
      <div class="land-prompt" hidden>
        <p class="land-question"></p>
        <div class="land-links" hidden></div>
        <pre class="land-detail"></pre>
        <div class="land-choice-list"></div>
        <form class="land-input-form" hidden>
          <input class="land-input" type="text" autocomplete="off">
          <button class="land-input-submit" type="submit">Continue</button>
        </form>
      </div>
      <pre class="land-output" aria-label="Landing output"></pre>
      <div class="land-actions">
        <button class="land-start" type="button">Start Landing</button>
        <button class="land-close" type="button">Close</button>
      </div>
    </div>
  </dialog>
  <script type="application/json" id="graph-config">${safeScriptJson({
    graphs,
    interactive: {
      enabled: Boolean(interactive.enabled),
      pageSize: interactive.pageSize || 80,
      pollIntervalMs: interactive.pollIntervalMs || 3000,
      token: interactive.token,
    },
    originMainStatusCacheMs: DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  })}</script>
  ${scriptSrcs.map((scriptSrc) => `<script type="module" src="${escapeHtml(scriptSrc)}"></script>`).join("\n  ")}
</body>
</html>`;
}
