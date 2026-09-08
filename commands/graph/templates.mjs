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

function getOriginMainDisplayLabel(graph = {}) {
  const normalized = String(graph.repository || graph.label || "").toLowerCase();

  if (normalized === "comm") {
    return "Thunderbird";
  }

  if (normalized === "firefox") {
    return "Firefox";
  }

  return graph.label || "origin/main";
}

function hasFullReviewCheckoutPair(graphs = []) {
  return ["working", "review"].every((checkout) => (
    ["firefox", "comm"].every((repository) => graphs.some((graph) => (
      (graph.checkout || "working") === checkout &&
      String(graph.repository || "").toLowerCase() === repository
    )))
  ));
}

export function buildInteractiveGraphLauncherHtml({
  consolePath,
  tabName,
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Opening Thunderbird Desktop Console</title>
</head>
<body class="graph-view-active">
  <p id="status">Opening Thunderbird Desktop Console...</p>
  <script>
    const consolePath = ${safeScriptJson(consolePath)};
    const tabName = ${safeScriptJson(tabName)};
    const consoleTab = window.open(consolePath, tabName);

    if (consoleTab) {
      consoleTab.focus();
      document.getElementById("status").textContent =
        "Thunderbird Desktop Console opened in a new tab.";
      window.setTimeout(() => window.close(), 100);
    } else {
      window.location.replace(consolePath);
    }
  </script>
</body>
</html>`;
}

export function buildGraphHtml({
  graphs,
  interactive = { enabled: false },
  stylesheetHref = DEFAULT_GRAPH_STYLESHEET_HREF,
  scriptSrcs = DEFAULT_GRAPH_SCRIPT_SRCS,
}) {
  const aiEnabled = interactive.aiEnabled === true;
  const checkoutModes = [...new Set(graphs.map((graph) => graph.checkout || "working"))];
  const hasCheckoutSwitch = interactive.enabled && checkoutModes.length > 1;
  const canSyncReview = interactive.enabled && hasFullReviewCheckoutPair(graphs);
  const initialCheckout = checkoutModes.includes("working")
    ? "working"
    : checkoutModes[0] || "working";
  const initialGraphs = graphs.filter(
    (graph) => !hasCheckoutSwitch || (graph.checkout || "working") === initialCheckout,
  );
  const tabButtons = initialGraphs.map((graph, index) => {
    const repository = graph.repository || graph.label;

    return `<button class="tab repository-button${index === 0 ? " active" : ""}" type="button" data-repository="${escapeHtml(repository)}" aria-pressed="${index === 0 ? "true" : "false"}">${escapeHtml(repository)}</button>`;
  }).join("\n");
  const checkoutSwitch = hasCheckoutSwitch
    ? `<div class="checkout-mode-switch" role="group" aria-label="Checkout mode">
        <button class="checkout-mode-button active" type="button" data-checkout="working" aria-pressed="true">Working</button>
        <button class="checkout-mode-button" type="button" data-checkout="review" aria-pressed="false">Review</button>
      </div>`
    : "";
  const dashboardTab = interactive.enabled
    ? `<button class="tab console-view-tab dashboard-tab" type="button">Dashboard</button>`
    : "";
  const metaBoardsTab = interactive.enabled
    ? `<button class="tab console-view-tab meta-boards-tab" type="button">Meta Boards</button>`
    : "";
  const graphViewTab = interactive.enabled
    ? `<button class="tab console-view-tab graph-view-tab active" type="button">Tree</button>`
    : "";
  const testOutputTab = `<button class="tab console-view-tab test-output-tab" type="button" hidden>Test Output</button>`;
  const consoleNavigation = interactive.enabled
    ? `<nav class="console-navigation" aria-label="Console views">
        ${graphViewTab}
        ${dashboardTab}
        ${metaBoardsTab}
        ${testOutputTab}
      </nav>`
    : "";
  const originMainStatus = interactive.enabled
    ? `<div class="origin-main-status" role="status" aria-label="origin/main freshness">
        ${graphs.length
          ? initialGraphs.map((graph) => (
            `<span class="origin-main-badge checking">${escapeHtml(getOriginMainDisplayLabel(graph))}: checking</span>`
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
          <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="phabricator-auth">Authenticate Phabricator...</button>
          <div class="graph-menu-submenu" role="none">
            <button class="graph-menu-command graph-submenu-trigger" type="button" role="menuitem" aria-haspopup="true" aria-expanded="false" data-menu-action="meta-boards">Meta Boards</button>
            <div class="graph-submenu" role="menu" aria-label="Meta board options">
              <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="meta-boards-add">Add Meta Bug Board...</button>
              <button class="graph-menu-command" type="button" role="menuitem" data-menu-action="meta-boards-manage">Manage Boards...</button>
            </div>
          </div>
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
          ${canSyncReview ? `<button class="graph-menu-command graph-menu-command-destructive" type="button" role="menuitem" data-menu-action="review-sync">Sync Review from Working...</button>` : ""}
        </div>
      </div>`
    : "";
  const updateActions = interactive.enabled
    ? `<div class="update-actions" role="toolbar" aria-label="Repository update actions">
        <button class="update-action" type="button" data-mode="update">Pull</button>
        <button class="update-action" type="button" data-mode="rebase">Rebase</button>
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
            ${aiEnabled ? `<button class="patch-update-commit" type="button" hidden>Update</button>` : ""}
            ${interactive.enabled ? `<button class="load-commit-review" type="button" hidden>Load Review</button>` : ""}
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
  const dashboardPanel = interactive.enabled
    ? `<section class="dashboard-panel" hidden aria-label="Patch and bug dashboard">
        <div class="dashboard-header">
          <div class="dashboard-heading">
            <p class="dashboard-eyebrow">Work queues</p>
            <h2>Patch Dashboard</h2>
            <p class="dashboard-status" role="status">Open the dashboard to load your open patches and assigned bugs.</p>
          </div>
          <div class="dashboard-header-actions">
            <div class="loading-indicator dashboard-loading" role="status" hidden>
              <span class="loading-spinner" aria-hidden="true"></span>
              <span class="dashboard-loading-text">Loading dashboard...</span>
            </div>
            <button class="dashboard-refresh" type="button">Refresh</button>
          </div>
        </div>
        <div class="dashboard-errors" role="alert" hidden></div>
        <div class="dashboard-workspace">
          <div class="dashboard-sections">
            <section class="dashboard-column">
              <h3 class="dashboard-column-heading">Your Patches</h3>
              <div class="dashboard-column-sections">
                <section class="dashboard-section dashboard-updates" data-dashboard-section="own-needs-revision">
                  <div class="dashboard-section-heading">
                    <div>
                      <p class="dashboard-section-kicker">Your patches</p>
                      <h3>Patches waiting for update</h3>
                      <p class="dashboard-section-description">Waiting the longest first</p>
                    </div>
                    <span class="dashboard-count"></span>
                  </div>
                  <div class="dashboard-rows"></div>
                </section>
                <section class="dashboard-section dashboard-awaiting-review" data-dashboard-section="own-needs-review">
                  <div class="dashboard-section-heading">
                    <div>
                      <p class="dashboard-section-kicker">Your patches</p>
                      <h3>Patches waiting for review</h3>
                      <p class="dashboard-section-description">Waiting the longest first</p>
                    </div>
                    <span class="dashboard-count"></span>
                  </div>
                  <div class="dashboard-rows"></div>
                </section>
              </div>
            </section>
            <section class="dashboard-column">
              <h3 class="dashboard-column-heading">Needs Review</h3>
              <div class="dashboard-column-sections">
                <section class="dashboard-section dashboard-direct-review" data-dashboard-section="direct-review">
                  <div class="dashboard-section-heading">
                    <div>
                      <p class="dashboard-section-kicker">Assigned directly to you</p>
                      <h3>Waiting for review</h3>
                      <p class="dashboard-section-description">Waiting the longest first</p>
                    </div>
                    <span class="dashboard-count"></span>
                  </div>
                  <div class="dashboard-rows"></div>
                </section>
                <section class="dashboard-section dashboard-group-review" data-dashboard-section="group-first-review">
                  <div class="dashboard-section-heading">
                    <div>
                      <p class="dashboard-section-kicker">Review group</p>
                      <h3>Waiting for review</h3>
                      <p class="dashboard-section-description">Waiting the longest first</p>
                    </div>
                    <span class="dashboard-count"></span>
                  </div>
                  <div class="dashboard-rows"></div>
                </section>
              </div>
            </section>
          </div>
          <aside class="dashboard-bug-sidebar" aria-label="Assigned bug queues">
            <h3 class="dashboard-column-heading">Bugzilla</h3>
            <div class="dashboard-bug-sections">
              <section class="dashboard-section dashboard-needinfo" data-dashboard-section="needinfo-bugs">
                <div class="dashboard-section-heading">
                  <div>
                    <p class="dashboard-section-kicker">Action required</p>
                    <h3>Need info bugs</h3>
                    <p class="dashboard-section-description">Oldest request first</p>
                  </div>
                  <span class="dashboard-count"></span>
                </div>
                <div class="dashboard-rows"></div>
              </section>
              <section class="dashboard-section dashboard-in-progress" data-dashboard-section="in-progress-bugs">
                <div class="dashboard-section-heading">
                  <div>
                    <p class="dashboard-section-kicker">Bugzilla</p>
                    <h3>In progress bugs</h3>
                    <p class="dashboard-section-description">Open bugs with patches</p>
                  </div>
                  <span class="dashboard-count"></span>
                </div>
                <div class="dashboard-rows"></div>
              </section>
              <section class="dashboard-section dashboard-bugs" data-dashboard-section="assigned-bugs">
                <div class="dashboard-section-heading">
                  <div>
                    <p class="dashboard-section-kicker">Bugzilla</p>
                    <h3>Assigned bugs without patches</h3>
                    <p class="dashboard-section-description">Newest bugs first</p>
                  </div>
                  <span class="dashboard-count"></span>
                </div>
                <div class="dashboard-rows"></div>
              </section>
            </div>
          </aside>
        </div>
      </section>`
    : "";
  const patchUpdateDialog = interactive.enabled
    ? `<dialog class="patch-update-dialog" id="patch-update-dialog">
        <div class="patch-update-panel">
          <header class="patch-update-header">
            <div>
              ${aiEnabled ? '<p class="patch-update-kicker">Patch update</p>' : ""}
              <h2 class="patch-update-title">Update patch</h2>
            </div>
            <button class="patch-update-close" type="button" aria-label="Close">&times;</button>
          </header>
          <details class="patch-update-progress" open>
            <summary class="patch-update-progress-summary">
              <span class="patch-update-progress-label">Codex activity</span>
              <span class="patch-update-progress-toggle" aria-hidden="true"></span>
              <span class="patch-update-status" role="status">Preparing update...</span>
            </summary>
            <section class="patch-update-activity" aria-label="Codex activity">
              <div class="patch-update-activity-status">
                <span class="patch-update-activity-latest" role="status">Waiting for Codex activity...</span>
              </div>
              <div class="patch-update-activity-heading">
                <h3>Codex activity</h3>
                <div class="patch-update-activity-filter" role="group" aria-label="Codex activity filter">
                  <button type="button" data-activity-filter="notes" aria-pressed="true">Notes</button>
                  <button type="button" data-activity-filter="all" aria-pressed="false">All</button>
                </div>
              </div>
              <ol class="patch-update-activity-list"></ol>
            </section>
          </details>
          ${aiEnabled ? `<form class="patch-update-steer" hidden>
            <label class="patch-update-steer-label" for="patch-update-steer-input">Guide Codex</label>
            <div>
              <textarea id="patch-update-steer-input" class="patch-update-steer-input" rows="2" placeholder="Add context, question an assumption, or change direction."></textarea>
              <button class="patch-update-steer-submit" type="submit">Send</button>
            </div>
          </form>` : ""}
          <pre class="patch-update-output" hidden aria-label="Patch update output"></pre>
          <section class="patch-update-workspace">
          ${aiEnabled ? `<section class="patch-update-review-column" aria-label="Patch and reviewer context">
            <section class="patch-update-context" hidden aria-label="Patch purpose">
              <h3 class="patch-update-context-heading">
                <button class="patch-update-context-toggle" type="button" aria-controls="patch-update-context-details" aria-expanded="false">
                  <span>Patch purpose</span>
                </button>
              </h3>
              <dl class="patch-update-context-details" id="patch-update-context-details" hidden>
                <div>
                  <dt>Purpose</dt>
                  <dd class="patch-update-context-purpose"></dd>
                </div>
                <div>
                  <dt>Behavior contract</dt>
                  <dd class="patch-update-context-contract"></dd>
                </div>
                <div class="patch-update-context-stack" hidden>
                  <dt>Stack context</dt>
                  <dd class="patch-update-context-stack-text"></dd>
                </div>
                <div class="patch-update-context-evidence" hidden>
                  <dt>Evidence</dt>
                  <dd class="patch-update-context-evidence-text"></dd>
                </div>
                <div class="patch-update-context-validation" hidden>
                  <dt>Validation</dt>
                  <dd class="patch-update-context-validation-text"></dd>
                </div>
              </dl>
            </section>
            <section class="patch-update-comment" hidden aria-label="Review comment">
              <div class="patch-update-comment-heading">
                <div>
                  <strong class="patch-update-comment-author"></strong>
                  <p class="patch-update-comment-kind"></p>
                </div>
                <a class="patch-update-comment-link" hidden>Open in Phabricator</a>
              </div>
              <div class="patch-update-reviewer-context">
                <p class="patch-update-comment-location" hidden></p>
                <section class="patch-update-reviewer-feedback">
                  <h3 class="patch-update-feedback-heading">Reviewer feedback</h3>
                  <pre class="patch-update-comment-content"></pre>
                </section>
                <section class="patch-update-suggestion" hidden>
                  <h3>Reviewer code suggestion</h3>
                  <pre class="patch-update-code-suggestion"></pre>
                </section>
                <section class="patch-update-comment-context" hidden aria-label="Review context">
                  <div class="patch-update-comment-context-heading">
                    <h3>Review context</h3>
                    <span class="patch-update-comment-context-location"></span>
                  </div>
                  <div class="patch-update-comment-context-diff"></div>
                </section>
              </div>
            </section>
          </section>
          <section class="patch-update-analysis" hidden aria-label="Codex assessment">
              <h3>Codex recommendation</h3>
              <p class="patch-update-recommendation"></p>
              <h4>What Codex found</h4>
              <p class="patch-update-assessment"></p>
              <section class="patch-update-rationale" hidden>
                <h4>Why</h4>
                <p class="patch-update-rationale-text"></p>
              </section>
              <section class="patch-update-validation" hidden>
                <h4>Evidence and verification</h4>
                <p class="patch-update-validation-text"></p>
              </section>
              <section class="patch-update-change-plan" hidden>
                <h4>Planned source change</h4>
                <p class="patch-update-change-summary"></p>
              </section>
              <section class="patch-update-proposed-diff" hidden>
                <div class="patch-update-proposed-diff-heading">
                  <h4>Working tree changes</h4>
                  <span>Actual uncommitted diff</span>
                </div>
                <div class="patch-update-proposed-diff-content"></div>
              </section>
              <label class="patch-update-reply-label">Reply
                <textarea class="patch-update-reply" rows="4"></textarea>
              </label>
          </section>
          </section>
          <div class="patch-update-actions">
            <button class="patch-update-output-toggle" type="button" hidden>Output</button>
            <button class="patch-update-keep" type="button" hidden>Keep and Amend</button>
            <button class="patch-update-revert" type="button" hidden>Revert Change</button>
            <button class="patch-update-post" type="button" hidden>Save Reply Draft</button>
            <button class="patch-update-handled" type="button" hidden>Mark Handled</button>
            <button class="patch-update-amend" type="button" hidden>Amend Patch</button>
            <button class="patch-update-submit" type="button" hidden>Submit Patch</button>
          </div>` : `<div class="patch-update-actions">
            <button class="patch-update-output-toggle" type="button" hidden>Output</button>
          </div>`}
        </div>
      </dialog>`
    : "";
  const patchReviewSteer = interactive.aiEnabled
    ? `<section class="patch-review-steer" hidden>
            <label class="patch-review-steer-label" for="patch-review-steer-input">Guide Codex</label>
            <div>
              <textarea class="patch-review-steer-input" id="patch-review-steer-input" rows="2" placeholder="Add context, question an assumption, or change direction."></textarea>
              <button class="patch-review-steer-submit" type="button">Send</button>
            </div>
          </section>`
    : "";
  const patchReviewDialog = interactive.enabled
    ? `<dialog class="patch-review-dialog" id="patch-review-dialog">
        <div class="patch-review-panel">
          <header class="patch-review-header">
            <div>
              <p class="patch-review-kicker">Phabricator patch review</p>
              <h2 class="patch-review-title">Review patch</h2>
            </div>
            <button class="patch-review-close" type="button" aria-label="Close">&times;</button>
          </header>
          <details class="patch-review-progress" open>
            <summary class="patch-review-progress-summary">
              <span class="patch-review-progress-label">Codex activity</span>
              <span class="patch-review-progress-toggle" aria-hidden="true"></span>
              <span class="patch-review-status" role="status">Preparing review...</span>
            </summary>
            <section class="patch-review-activity" aria-label="Codex review activity">
              <div class="patch-review-activity-status">
                <span class="patch-review-activity-latest">Waiting for Codex activity...</span>
              </div>
              <div class="patch-review-activity-heading">
                <h3>Codex activity</h3>
                <div class="patch-review-activity-filter" role="group" aria-label="Codex activity filter">
                  <button type="button" data-review-activity-filter="notes" aria-pressed="true">Notes</button>
                  <button type="button" data-review-activity-filter="all" aria-pressed="false">All</button>
                </div>
              </div>
              <ol class="patch-review-activity-list"></ol>
            </section>
          </details>
          ${patchReviewSteer}
          <pre class="patch-review-output" hidden aria-label="Patch review output"></pre>
          <section class="patch-review-workspace">
            <section class="patch-review-diff-column">
              <section class="patch-review-patch-context" hidden>
                <button class="patch-review-patch-context-toggle" type="button" aria-expanded="false">
                  <span>Patch context</span>
                </button>
                <dl class="patch-review-patch-context-details" hidden>
                  <div><dt>Purpose</dt><dd class="patch-review-patch-context-purpose"></dd></div>
                  <div><dt>Behavior contract</dt><dd class="patch-review-patch-context-contract"></dd></div>
                  <div class="patch-review-patch-context-stack"><dt>Stack context</dt><dd></dd></div>
                  <div class="patch-review-patch-context-evidence"><dt>Evidence</dt><dd></dd></div>
                  <div class="patch-review-patch-context-validation"><dt>Validation</dt><dd></dd></div>
                </dl>
              </section>
              <details class="patch-review-discussion" hidden>
                <summary>Phabricator discussion <span class="patch-review-discussion-count"></span></summary>
                <div class="patch-review-discussion-list"></div>
              </details>
              <section class="patch-review-context-diff" aria-label="Patch review context">
                <header class="patch-review-context-diff-heading">
                  <h3>Patch diff</h3>
                  <span class="patch-review-context-diff-location"></span>
                </header>
                <div class="patch-review-context-diff-content"></div>
              </section>
            </section>
            <section class="patch-review-analysis">
              <section class="patch-review-issue" hidden aria-label="Review issue">
                <header>
                  <span class="patch-review-severity"></span>
                  <h3 class="patch-review-issue-title"></h3>
                  <span class="patch-review-position"></span>
                </header>
                <section class="patch-review-rationale-section">
                  <h4>What Codex found</h4>
                  <p class="patch-review-rationale"></p>
                </section>
                <section class="patch-review-validation-section">
                  <h4>Evidence and validation</h4>
                  <p class="patch-review-validation"></p>
                </section>
                <label>Suggested inline comment
                  <textarea class="patch-review-comment" rows="5"></textarea>
                </label>
                <label class="patch-review-suggestion-field" hidden>Suggested code replacement
                  <textarea class="patch-review-suggestion" rows="5" spellcheck="false"></textarea>
                </label>
              </section>
              <details class="patch-review-coverage" hidden>
                <summary>Review coverage</summary>
                <dl>
                  <div><dt>Summary</dt><dd class="patch-review-summary"></dd></div>
                  <div><dt>Accessibility</dt><dd class="patch-review-accessibility"></dd></div>
                  <div><dt>CodeRabbit</dt><dd class="patch-review-coderabbit"></dd></div>
                  <div><dt>Static validation</dt><dd class="patch-review-static"></dd></div>
                  <div><dt>Runtime validation</dt><dd class="patch-review-runtime"></dd></div>
                  <div><dt>Codebase context</dt><dd class="patch-review-context"></dd></div>
                </dl>
              </details>
              <section class="patch-review-experiment-diff" hidden>
                <header class="patch-review-experiment-diff-heading">
                  <h3>Review checkout changes</h3>
                  <span>Local experiment diff</span>
                </header>
                <div class="patch-review-experiment-diff-content"></div>
              </section>
              <section class="patch-review-final" hidden aria-label="Final Phabricator review">
                <h3>Post final review</h3>
                <p>Pending inline comments publish with this review action.</p>
                <label>Optional overall comment
                  <textarea class="patch-review-final-message" rows="3"></textarea>
                </label>
              </section>
            </section>
          </section>
          <div class="patch-review-actions">
            <button class="patch-review-output-toggle" type="button" hidden>Output</button>
            <button class="patch-review-apply-suggestion" type="button" hidden>Apply in Review Checkout</button>
            <button class="patch-review-pending-comment" type="button" hidden>Add Comment as Pending</button>
            <button class="patch-review-pending-suggestion" type="button" hidden>Add Comment + Code Suggestion as Pending</button>
            <button class="patch-review-skip" type="button" hidden>Skip Issue</button>
            <button type="button" data-review-outcome="comment" hidden>Post Comment</button>
            <button type="button" data-review-outcome="accept" hidden>Accept</button>
            <button type="button" data-review-outcome="request-changes" hidden>Request Changes</button>
          </div>
        </div>
      </dialog>`
    : "";
  const metaBoardsPanel = interactive.enabled
    ? `<section class="meta-boards-panel" hidden aria-label="Meta bug boards">
        <div class="meta-boards-header">
          <div>
            <h2>Meta Bug Boards</h2>
            <p class="meta-boards-status" role="status">Create and manage boards from the Meta Boards menu.</p>
          </div>
          <div class="loading-indicator meta-boards-loading" role="status" hidden>
            <span class="loading-spinner" aria-hidden="true"></span>
            <span class="meta-boards-loading-text">Loading meta bug board...</span>
          </div>
        </div>
        <div class="meta-board-controls" hidden>
          <label>Board
            <select class="meta-board-select"></select>
          </label>
          <div class="meta-board-root-links"></div>
          <label>Assignee
            <select class="meta-board-assignee-filter"><option value="">All assignees</option></select>
          </label>
          <label>Child meta
            <select class="meta-board-meta-filter"><option value="">All child metas</option></select>
          </label>
          <div class="meta-board-control-actions">
            <label>Sprint
              <select class="meta-board-sprint-select"><option value="">Open a sprint...</option></select>
            </label>
            <button class="meta-board-new-sprint" type="button">New Sprint</button>
            <button class="meta-board-refresh" type="button">Refresh</button>
          </div>
        </div>
        <div class="meta-boards-error" role="alert" hidden></div>
        <div class="meta-board-empty">No meta bug boards yet. Add one from the Meta Boards menu.</div>
        <section class="meta-board-kanban" hidden aria-label="Meta bug story board">
          <section class="meta-board-column" data-meta-board-column="backlog"><header><h3>Backlog</h3><span class="meta-board-column-summary"><span class="meta-board-column-count"></span><span class="meta-board-column-points" hidden></span></span></header><div class="meta-board-cards"></div></section>
          <section class="meta-board-column" data-meta-board-column="ready"><header><h3>Ready</h3><span class="meta-board-column-summary"><span class="meta-board-column-count"></span><span class="meta-board-column-points"></span></span></header><div class="meta-board-cards"></div></section>
          <section class="meta-board-column" data-meta-board-column="assigned"><header><h3>Assigned</h3><span class="meta-board-column-summary"><span class="meta-board-column-count"></span><span class="meta-board-column-points"></span></span></header><div class="meta-board-cards"></div></section>
          <section class="meta-board-column" data-meta-board-column="in-progress"><header><h3>In Progress</h3><span class="meta-board-column-summary"><span class="meta-board-column-count"></span><span class="meta-board-column-points"></span></span></header><div class="meta-board-cards"></div></section>
          <section class="meta-board-column" data-meta-board-column="in-review"><header><h3>In Review</h3><span class="meta-board-column-summary"><span class="meta-board-column-count"></span><span class="meta-board-column-points"></span></span></header><div class="meta-board-cards"></div></section>
          <section class="meta-board-column" data-meta-board-column="complete"><header><h3>Complete</h3><span class="meta-board-column-summary"><span class="meta-board-column-count"></span><span class="meta-board-column-points"></span></span></header><div class="meta-board-cards"></div></section>
        </section>
      </section>`
    : "";
  const sprintPanel = interactive.enabled
    ? `<section class="sprint-panel" hidden aria-label="Sprint planning">
        <div class="sprint-header">
          <div class="sprint-heading">
            <button class="sprint-back-to-board" type="button">Meta Board</button>
            <p class="sprint-status" role="status">Loading sprint...</p>
          </div>
          <div class="sprint-header-actions">
            <button class="sprint-refresh" type="button">Refresh</button>
            <a class="sprint-bugzilla-link" target="_blank" rel="noreferrer" hidden>Bugzilla</a>
          </div>
        </div>
        <div class="sprint-error" role="alert" hidden></div>
        <section class="sprint-details" aria-label="Sprint details">
          <label>Sprint name
            <input class="sprint-name-input" required>
          </label>
          <label>Start date
            <output class="sprint-start-date"></output>
          </label>
          <label>End date
            <input class="sprint-deadline-input" type="date" required>
          </label>
          <button class="sprint-save-details" type="button">Save Sprint</button>
        </section>
        <nav class="sprint-view-tabs" aria-label="Sprint view">
          <button class="sprint-view-tab active" type="button" data-sprint-view="overview">Overview</button>
          <button class="sprint-view-tab" type="button" data-sprint-view="planning">Planning</button>
        </nav>
        <section class="sprint-overview" aria-label="Sprint overview">
          <div class="sprint-metrics">
            <section><span>Total points</span><strong class="sprint-total-points"></strong></section>
            <section><span>Remaining</span><strong class="sprint-remaining-points"></strong></section>
            <section><span>In progress</span><strong class="sprint-in-progress-points"></strong></section>
            <section><span>Complete</span><strong class="sprint-complete-points"></strong></section>
            <section><span>People</span><strong class="sprint-people-count"></strong></section>
            <section><span>Days left</span><strong class="sprint-days-remaining"></strong></section>
          </div>
          <section class="sprint-burndown-section">
            <header><h3>Burndown</h3><span class="sprint-burndown-caption"></span></header>
            <div class="sprint-burndown" role="img" aria-label="Sprint burndown chart"></div>
          </section>
          <section class="sprint-people-section">
            <h3>Assigned points</h3>
            <div class="sprint-people"></div>
          </section>
          <section class="sprint-overview-stories">
            <header><h3>Sprint stories</h3><span class="sprint-overview-story-points"></span></header>
            <div class="sprint-overview-story-groups"></div>
          </section>
        </section>
        <section class="sprint-planning" hidden aria-label="Sprint planning board">
          <div class="sprint-planning-filters">
            <label>Assignee
              <select class="sprint-assignee-filter"><option value="">All assignees</option></select>
            </label>
            <label>Child meta
              <select class="sprint-meta-filter"><option value="">All child metas</option></select>
            </label>
          </div>
          <div class="sprint-planning-columns">
            <section class="sprint-column" data-sprint-column="ready"><header><h3>Ready</h3><span></span></header><div class="sprint-cards"></div></section>
            <section class="sprint-column" data-sprint-column="backlog"><header><h3>Backlog</h3><span></span></header><div class="sprint-cards"></div></section>
            <section class="sprint-column" data-sprint-column="assigned"><header><h3>Assigned or Greater</h3><span></span></header><div class="sprint-cards"></div></section>
            <section class="sprint-column sprint-members-column" data-sprint-column="sprint"><header><h3>Sprint</h3><span></span></header><div class="sprint-cards"></div></section>
          </div>
        </section>
      </section>`
    : "";

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
      <div class="header-actions">
        ${updateActions}
        ${graphOptions}
      </div>
    </div>
    <div class="console-footer">
      ${consoleNavigation}
      <div class="toolbar-row graph-toolbar">
        <nav class="repository-navigation" aria-label="Checkout and repository">
          ${checkoutSwitch}
          <div class="repository-switch" role="group" aria-label="Repository">
            ${tabButtons}
          </div>
        </nav>
      </div>
    </div>
  </header>
  <main>${tabPanels}
    ${dashboardPanel}
    ${patchUpdateDialog}
    ${patchReviewDialog}
    ${metaBoardsPanel}
    ${sprintPanel}
    ${testOutputPanel}</main>
  <dialog class="update-scope-dialog" id="update-scope-dialog">
    <div class="update-scope-dialog-body">
      <header>
        <h2 class="update-scope-title">Update checkouts</h2>
        <button class="update-scope-close" type="button" aria-label="Close">&times;</button>
      </header>
      <p class="update-scope-description"></p>
      <div class="update-scope-actions">
        <button class="update-scope-current" type="button"></button>
        <button class="update-scope-both" type="button">Update both checkout pairs</button>
      </div>
    </div>
  </dialog>
  <dialog class="system-dialog" id="system-dialog" aria-labelledby="system-dialog-title">
    <div class="system-dialog-body">
      <header>
        <h2 class="system-dialog-title" id="system-dialog-title"></h2>
      </header>
      <p class="system-dialog-message"></p>
      <div class="system-dialog-choices"></div>
      <div class="system-dialog-actions">
        <button class="system-dialog-cancel" type="button" hidden>Cancel</button>
        <button class="system-dialog-confirm" type="button">OK</button>
      </div>
    </div>
  </dialog>
  <div class="context-menu" id="commit-context-menu" hidden role="menu" aria-label="Commit actions">
    <div class="context-menu-title"></div>
    <button type="button" role="menuitem" data-action="checkout">Checkout</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="selected">Rebase Selected</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="children">Rebase + Children</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="descendants">Rebase + Descendants</button>
    <button type="button" role="menuitem" data-action="rebase" data-rebase-mode="stack">Rebase Whole Stack</button>
    <button type="button" role="menuitem" data-action="interactive-rebase">Interactive Rebase</button>
    <button type="button" role="menuitem" data-action="branch">Branch</button>
    <button type="button" role="menuitem" data-action="copy">Copy to other checkout...</button>
    <button type="button" role="menuitem" data-action="prune">Prune</button>
  </div>
  <dialog class="checkout-transfer-dialog" id="checkout-transfer-dialog">
    <form class="checkout-transfer-form">
      <header>
        <div>
          <p class="checkout-transfer-kicker">Cross-checkout copy</p>
          <h2 class="checkout-transfer-title">Copy commit</h2>
        </div>
        <button class="checkout-transfer-close" type="button" aria-label="Close">&times;</button>
      </header>
      <p class="checkout-transfer-description"></p>
      <fieldset class="checkout-transfer-mode">
        <legend>Copy</legend>
        <label><input type="radio" name="checkout-transfer-mode" value="commit" checked> Selected commit</label>
        <label><input type="radio" name="checkout-transfer-mode" value="stack"> Stack ending at the selected commit</label>
      </fieldset>
      <label>Destination branch
        <input class="checkout-transfer-branch" type="text" autocomplete="off" placeholder="Use the selected commit branch">
      </label>
      <p class="checkout-transfer-status" role="status"></p>
      <div class="checkout-transfer-actions">
        <button class="checkout-transfer-discard" type="button" hidden>Discard destination changes</button>
        <button class="checkout-transfer-cancel" type="button">Cancel</button>
        <button class="checkout-transfer-submit" type="submit">Copy</button>
      </div>
    </form>
  </dialog>
  <dialog class="review-sync-dialog" id="review-sync-dialog">
    <form class="review-sync-form">
      <header>
        <div>
          <p class="review-sync-kicker">Destructive checkout replacement</p>
          <h2 class="review-sync-title">Sync Review from Working</h2>
        </div>
        <button class="review-sync-close" type="button" aria-label="Close">&times;</button>
      </header>
      <p class="review-sync-description">Replace the Review Firefox and comm clones with the Working clones’ Git refs, checked-out commits, and build configuration. Review-only commits, branches, changes, untracked files, and build artifacts will be removed.</p>
      <p class="review-sync-description">Working source changes are not copied. Build artifacts are copied from the Working Firefox clone after the Review clones are reset.</p>
      <label>Type <code>SYNC REVIEW</code> to confirm
        <input class="review-sync-confirmation" type="text" autocomplete="off" spellcheck="false" required>
      </label>
      <p class="review-sync-status" role="status"></p>
      <div class="review-sync-actions">
        <button class="review-sync-cancel" type="button">Cancel</button>
        <button class="review-sync-submit" type="submit" disabled>Sync Review</button>
      </div>
    </form>
  </dialog>
  <dialog class="meta-board-manager-dialog" id="meta-board-manager-dialog">
    <form class="meta-board-manager-form">
      <header class="meta-board-manager-header">
        <h2>Manage Meta Bug Boards</h2>
        <button class="meta-board-manager-close" type="button" aria-label="Close board management">&times;</button>
      </header>
      <label for="meta-board-manager-id">Meta bug
        <input id="meta-board-manager-id" class="meta-board-manager-id" inputmode="numeric" pattern="[0-9]{4,10}" placeholder="Bug ID" required>
      </label>
      <p class="meta-board-manager-status" role="status"></p>
      <div class="meta-board-manager-actions">
        <button class="meta-board-add" type="submit">Add Board</button>
      </div>
      <section class="meta-board-manager-list" aria-label="Saved meta bug boards"></section>
      <div class="meta-board-manager-actions">
        <button class="meta-board-manager-cancel" type="button">Close</button>
      </div>
    </form>
  </dialog>
  <dialog class="meta-board-dialog" id="meta-board-dialog">
    <form class="meta-board-detail-form">
      <header class="meta-board-detail-header">
        <div>
          <h2 class="meta-board-detail-title">Bug</h2>
          <div class="meta-board-detail-links"></div>
        </div>
        <div class="meta-board-detail-header-actions">
          <div class="meta-board-detail-bugzilla"></div>
          <button class="meta-board-detail-close" type="button" aria-label="Close bug details">&times;</button>
        </div>
      </header>
      <p class="meta-board-detail-status" role="status"></p>
      <div class="meta-board-detail-grid">
        <label>Title
          <input class="meta-board-detail-summary" required>
        </label>
        <label>Story points
          <input class="meta-board-detail-points" inputmode="decimal" type="number" step="0.5" min="0">
        </label>
        <label>Assignee
          <input class="meta-board-detail-assignee" type="email" list="meta-board-assignees" placeholder="name@example.com">
          <datalist id="meta-board-assignees"></datalist>
        </label>
      </div>
      <section class="meta-board-relations">
        <div>
          <h3>Blocked By</h3>
          <div class="meta-board-detail-depends-links"></div>
          <button class="meta-board-relation-add" type="button" data-relation="dependsOn">Add</button>
        </div>
        <div>
          <h3>Blocks</h3>
          <div class="meta-board-detail-blocks-links"></div>
          <button class="meta-board-relation-add" type="button" data-relation="blocks">Add</button>
        </div>
      </section>
      <section class="meta-board-description-section">
        <div class="meta-board-description-header">
          <h3>Description</h3>
          <button class="meta-board-description-edit" type="button" aria-controls="meta-board-detail-description" aria-label="Edit description" aria-pressed="false" title="Edit description">
            <span class="meta-board-description-edit-icon" data-mode="edit" aria-hidden="true">&#9998;</span>
            <span class="meta-board-description-edit-icon" data-mode="render" aria-hidden="true" hidden>&#128065;</span>
          </button>
        </div>
        <div class="meta-board-detail-description-rendered"></div>
        <textarea id="meta-board-detail-description" class="meta-board-detail-description" rows="12" hidden></textarea>
      </section>
      <details class="meta-board-detail-comments">
        <summary>
          <span>Bugzilla comments</span>
          <span class="meta-board-detail-comments-count"></span>
        </summary>
        <div class="meta-board-detail-comments-list"></div>
      </details>
      <p class="meta-board-detail-error" role="alert"></p>
      <footer class="meta-board-detail-actions">
        <button class="meta-board-detail-cancel" type="button">Cancel</button>
        <button class="meta-board-detail-save" type="submit">Save Changes</button>
      </footer>
    </form>
  </dialog>
  <dialog class="meta-board-relation-dialog" id="meta-board-relation-dialog">
    <form class="meta-board-relation-add-form">
      <header class="meta-board-relation-add-header">
        <h2 class="meta-board-relation-add-title">Add relation</h2>
        <button class="meta-board-relation-add-close" type="button" aria-label="Close add relation dialog">&times;</button>
      </header>
      <label>Bug number
        <input class="meta-board-relation-add-id" inputmode="numeric" pattern="[0-9]{4,10}" placeholder="123456" required>
      </label>
      <p class="meta-board-relation-add-error" role="alert"></p>
      <footer class="meta-board-relation-add-actions">
        <button class="meta-board-relation-add-cancel" type="button">Cancel</button>
        <button class="meta-board-relation-add-submit" type="submit">Add</button>
      </footer>
    </form>
  </dialog>
  <dialog class="sprint-create-dialog" id="sprint-create-dialog">
    <form class="sprint-create-form">
      <header class="sprint-dialog-header">
        <h2>New Sprint</h2>
        <button class="sprint-create-close" type="button" aria-label="Close new sprint dialog">&times;</button>
      </header>
      <label>Sprint name
        <input class="sprint-create-name" required autocomplete="off" placeholder="Sprint name">
      </label>
      <label>End date
        <input class="sprint-create-deadline" type="date" required>
      </label>
      <p class="sprint-create-error" role="alert"></p>
      <footer class="sprint-dialog-actions">
        <button class="sprint-create-cancel" type="button">Cancel</button>
        <button class="sprint-create-submit" type="submit">Create Sprint</button>
      </footer>
    </form>
  </dialog>
  <dialog class="sprint-rollover-dialog" id="sprint-rollover-dialog">
    <form class="sprint-rollover-form">
      <header class="sprint-dialog-header">
        <h2>Close Previous Sprint</h2>
        <button class="sprint-rollover-close" type="button" aria-label="Close sprint rollover dialog">&times;</button>
      </header>
      <p class="sprint-rollover-summary"></p>
      <fieldset class="sprint-rollover-options">
        <label><input type="radio" name="sprint-rollover" value="all" checked> Move all open stories to the new sprint</label>
        <label><input type="radio" name="sprint-rollover" value="selected"> Choose stories to move</label>
        <label><input type="radio" name="sprint-rollover" value="none"> Remove all open stories from the previous sprint</label>
      </fieldset>
      <div class="sprint-rollover-stories" hidden></div>
      <p class="sprint-rollover-error" role="alert"></p>
      <footer class="sprint-dialog-actions">
        <button class="sprint-rollover-cancel" type="button">Cancel</button>
        <button class="sprint-rollover-submit" type="submit">Close Previous Sprint</button>
      </footer>
    </form>
  </dialog>
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
  <dialog class="interactive-rebase-dialog" id="interactive-rebase-dialog">
    <form class="interactive-rebase-form">
      <h2 class="interactive-rebase-title">Interactive Rebase</h2>
      <p class="interactive-rebase-status" role="status"></p>
      <div class="interactive-rebase-range">
        <label>Editable range ends at
          <select class="interactive-rebase-end"></select>
        </label>
      </div>
      <div class="interactive-rebase-todo" aria-label="Interactive rebase todo"></div>
      <p class="interactive-rebase-help">Later descendants stay in order and replay as pick.</p>
      <p class="interactive-rebase-error" role="alert"></p>
      <div class="interactive-rebase-actions">
        <button class="interactive-rebase-close" type="button">Cancel</button>
        <button class="interactive-rebase-submit" type="submit">Start Rebase</button>
      </div>
    </form>
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
            placeholder="Enter a user or #group, then press Enter"
          >
        </div>
      </label>
      <p class="commit-status" role="status">Ready to commit changes.</p>
      <div class="commit-actions">
        <button class="commit-close" type="button">Close</button>
        <button class="commit-submit" type="submit">Commit</button>
      </div>
    </form>
  </dialog>
  <dialog class="phab-auth-dialog" id="phab-auth-dialog">
    <section class="phab-auth-panel" aria-labelledby="phab-auth-title">
      <h2 class="phab-auth-title" id="phab-auth-title">Phabricator Authentication</h2>
      <p class="phab-auth-status" role="status">Checking Phabricator authentication...</p>
      <p class="phab-auth-detail">Sign in through the dedicated browser window to load inline code suggestions. This is separate from your normal browser and Conduit login.</p>
      <p class="phab-auth-error" role="alert"></p>
      <div class="phab-auth-actions">
        <button class="phab-auth-close" type="button">Close</button>
        <button class="phab-auth-cancel" type="button" hidden>Cancel</button>
        <button class="phab-auth-sign-out" type="button" hidden>Sign Out</button>
        <button class="phab-auth-start" type="button">Authenticate</button>
      </div>
    </section>
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
        <button class="submit-cancel" type="button" hidden>Cancel</button>
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
      closeTabsOnShutdown: interactive.closeTabsOnShutdown !== false,
      aiEnabled: interactive.aiEnabled === true,
      token: interactive.token,
    },
    originMainStatusCacheMs: DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS,
  })}</script>
  ${scriptSrcs.map((scriptSrc) => `<script type="module" src="${escapeHtml(scriptSrc)}"></script>`).join("\n  ")}
</body>
</html>`;
}
