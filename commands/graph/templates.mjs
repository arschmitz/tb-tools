import { DEFAULT_LANDO_REPO } from "../../lib/lando.mjs";

const DEFAULT_ORIGIN_MAIN_STATUS_CACHE_MS = 15 * 1000;
const DEFAULT_GRAPH_SCRIPT_SRCS = [
  "graph-client/init.js",
];

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

export function getGraphHtmlStyles() {
  return buildGraphHtml({ graphs: [] }).match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
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
  scriptSrcs = DEFAULT_GRAPH_SCRIPT_SRCS,
}) {
  const tabButtons = graphs.map((graph, index) => (
    `<button class="tab${index === 0 ? " active" : ""}" data-index="${index}">${escapeHtml(graph.label)}</button>`
  )).join("\n");
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

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Thunderbird Desktop Console</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --diff-border: #d0d7de;
      --diff-header-bg: #f6f8fa;
      --diff-bg: #ffffff;
      --diff-code: #24292f;
      --diff-muted: #57606a;
      --diff-gutter-bg: #f6f8fa;
      --diff-gutter-border: #d8dee4;
      --diff-file-line-bg: #f6f8fa;
      --diff-hunk-bg: #ddf4ff;
      --diff-hunk-code: #0969da;
      --diff-delete-bg: #ffebe9;
      --diff-delete-gutter: #ffd7d5;
      --diff-insert-bg: #e6ffec;
      --diff-insert-gutter: #ccffd8;
      --diff-hover-bg: #f6f8fa;
    }
    body { margin: 0; background: #f6f7f9; color: #20242a; }
    header { padding: 12px 16px 8px; border-bottom: 1px solid #d6dae1; background: #fff; position: sticky; top: 0; z-index: 1; }
    .header-row { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: space-between; margin-bottom: 8px; }
    .title-row { align-items: center; display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 8px; min-width: 260px; }
    h1 { font-size: 18px; margin: 0; }
    .toolbar-row { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: space-between; }
    .tabs { display: flex; flex: 1 1 auto; gap: 6px; flex-wrap: wrap; }
    .tab { border: 1px solid #b9c0cc; background: #fff; color: #20242a; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
    .tab.active { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    body.has-command-status main { padding-bottom: 52px; }
    .update-actions { align-items: center; display: flex; flex: 0 1 auto; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-left: auto; }
    .command-status-bar { align-items: center; background: #ffffff; border-top: 1px solid #d6dae1; bottom: 0; box-shadow: 0 -4px 14px rgba(27, 31, 36, 0.08); box-sizing: border-box; display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; left: 0; min-height: 34px; padding: 4px 12px; position: fixed; right: 0; z-index: 5; }
    .command-status-bar[hidden] { display: none; }
    .command-status-primary { align-items: center; display: flex; gap: 8px; min-width: 0; }
    .command-status-tools { align-items: center; display: flex; gap: 6px; justify-content: end; }
    .command-status-dot { background: #8c959f; border-radius: 50%; display: inline-block; flex: 0 0 auto; height: 8px; width: 8px; }
    .command-status-bar.busy .command-status-dot { background: #1f5f9f; box-shadow: 0 0 0 3px rgba(31, 95, 159, 0.12); }
    .command-status-bar.error .command-status-dot { background: #9b1c1c; box-shadow: 0 0 0 3px rgba(155, 28, 28, 0.12); }
    .update-action, .mach-action, .mach-cancel, .mach-output-toggle, .command-status-close, .graph-menu-button { background: #fff; border: 1px solid #1f5f9f; border-radius: 4px; color: #1f5f9f; cursor: pointer; font-size: 12px; padding: 5px 9px; }
    .update-action:hover, .update-action:focus, .mach-action:hover, .mach-action:focus, .mach-cancel:hover, .mach-cancel:focus, .mach-output-toggle:hover, .mach-output-toggle:focus, .command-status-close:hover, .command-status-close:focus, .graph-menu-button:hover, .graph-menu-button:focus { background: rgba(31, 95, 159, 0.08); outline: none; }
    .update-action:disabled, .mach-action:disabled, .mach-cancel:disabled, .graph-menu-command:disabled { cursor: wait; opacity: 0.65; }
    .graph-options { position: relative; }
    .graph-menu-button { align-items: center; display: inline-flex; height: 28px; justify-content: center; min-width: 30px; padding: 0 8px; }
    .graph-options-menu, .graph-submenu { background: #fff; border: 1px solid #b9c0cc; border-radius: 6px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.18); color: #20242a; min-width: 168px; padding: 4px; }
    .graph-options-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 6; }
    .graph-options-menu[hidden] { display: none; }
    .graph-menu-command { background: transparent; border: 0; border-radius: 4px; color: inherit; cursor: pointer; display: block; font: inherit; padding: 7px 8px; text-align: left; width: 100%; }
    .graph-menu-command:hover, .graph-menu-command:focus { background: rgba(31, 95, 159, 0.1); outline: none; }
    .graph-menu-submenu { position: relative; }
    .graph-submenu-trigger { padding-right: 24px; position: relative; }
    .graph-submenu-trigger::after { content: ">"; position: absolute; right: 8px; }
    .graph-submenu { display: none; position: absolute; right: calc(100% - 1px); top: 0; }
    .graph-menu-submenu:hover .graph-submenu, .graph-menu-submenu:focus-within .graph-submenu, .graph-menu-submenu.open .graph-submenu { display: block; }
    .mach-cancel, .mach-output-toggle { border-radius: 999px; font-size: 11px; line-height: 1.2; padding: 3px 8px; }
    .mach-cancel { border-color: #9b1c1c; color: #9b1c1c; }
    .command-status-close { align-items: center; border-color: #8c959f; border-radius: 50%; color: #59616d; display: inline-flex; font-size: 14px; height: 22px; justify-content: center; line-height: 1; padding: 0; width: 22px; }
    .mach-cancel[hidden], .mach-output-toggle[hidden], .command-status-close[hidden] { display: none; }
    .update-status { color: #59616d; font-size: 12px; min-height: 16px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .update-status[hidden] { display: none; }
    .update-status.error { color: #9b1c1c; }
    .command-elapsed { color: #59616d; flex: 0 0 auto; font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 4.5ch; text-align: right; }
    .origin-main-status { align-items: center; display: flex; flex-wrap: wrap; gap: 4px; }
    .origin-main-badge { border: 1px solid #d0d7de; border-radius: 999px; color: #59616d; display: inline-flex; font-size: 12px; line-height: 1.2; padding: 3px 8px; white-space: nowrap; }
    .origin-main-badge.current { background: #dafbe1; border-color: #2da44e; color: #116329; }
    .origin-main-badge.stale, .origin-main-badge.warning { background: #fff8c5; border-color: #bf8700; color: #7d4e00; }
    .origin-main-badge.error { background: #ffebe9; border-color: #f1a5a5; color: #9b1c1c; }
    .mach-output-panel { background: #ffffff; border: 1px solid #d6dae1; border-radius: 6px 6px 0 0; bottom: 100%; box-shadow: 0 -6px 18px rgba(27, 31, 36, 0.12); box-sizing: border-box; left: 12px; padding: 8px; position: absolute; right: 12px; }
    .mach-output-panel[hidden] { display: none; }
    .mach-output { background: #f6f8fa; border: 1px solid #d6dae1; border-radius: 4px; color: #20242a; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: min(32vh, 360px); overflow: auto; padding: 8px; white-space: pre-wrap; }
    main { padding: 12px; }
    .panel { display: none; }
    .panel.active { display: block; }
    .summary { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; padding: 8px 10px; margin-bottom: 10px; background: #fff; border: 1px solid #d6dae1; border-radius: 8px; }
    .summary span { color: #59616d; font-size: 12px; }
    .workspace { --graph-pane-width: 54%; display: grid; grid-template-columns: minmax(320px, var(--graph-pane-width)) 12px minmax(320px, 1fr); align-items: start; }
    .graph, .diff-viewer { background: #fff; border: 1px solid #d6dae1; border-radius: 8px; overflow: auto; }
    .graph { padding: 10px; min-height: 220px; }
    .diff-viewer { max-height: calc(100vh - 112px); position: sticky; top: 78px; }
    .pane-resizer { align-items: center; align-self: stretch; cursor: col-resize; display: flex; justify-content: center; min-height: 220px; position: sticky; top: 78px; touch-action: none; user-select: none; height: calc(100vh - 112px); }
    .pane-resizer::before { background: #c7ced9; border-radius: 999px; content: ""; display: block; height: 100%; max-height: calc(100vh - 132px); min-height: 140px; transition: background 120ms ease, box-shadow 120ms ease, width 120ms ease; width: 4px; }
    .pane-resizer:hover::before, .pane-resizer:focus-visible::before, .pane-resizer.dragging::before { background: #1f5f9f; box-shadow: 0 0 0 3px rgba(31, 95, 159, 0.14); width: 5px; }
    .pane-resizer:focus-visible { outline: none; }
    body.is-resizing-panes { cursor: col-resize; user-select: none; }
    .diff-header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid #d6dae1; }
    .diff-title { font-size: 13px; }
    .diff-meta { color: #59616d; font-size: 12px; }
    .diff-message { border-top: 1px solid #edf0f4; color: #20242a; flex: 0 0 100%; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2px 0 0; max-height: 220px; overflow: auto; padding: 8px 0 0; white-space: pre-wrap; }
    .diff-message a { color: #0969da; text-decoration: none; }
    .diff-message a:hover, .diff-message a:focus { text-decoration: underline; }
    .diff-message[hidden] { display: none; }
    .integration-status { align-items: center; color: #59616d; display: flex; flex: 0 0 100%; flex-wrap: wrap; font-size: 12px; gap: 6px; min-width: 0; }
    .integration-status[hidden] { display: none; }
    .status-badge { align-items: center; border: 1px solid #d0d7de; border-radius: 999px; color: #24292f; display: inline-flex; font-size: 12px; gap: 5px; line-height: 1.2; max-width: 100%; min-width: 0; padding: 3px 8px; text-decoration: none; }
    .status-badge:hover, .status-badge:focus { background: #f6f8fa; text-decoration: none; }
    .status-badge strong { font-weight: 600; white-space: nowrap; }
    .status-badge .status-value { color: #57606a; white-space: nowrap; }
    .status-badge .status-detail { color: #57606a; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-badge.open { border-color: #2da44e; background: #dafbe1; color: #116329; }
    .status-badge.closed, .status-badge.accepted { border-color: #8250df; background: #fbefff; color: #6639ba; }
    .status-badge.warning { border-color: #bf8700; background: #fff8c5; color: #7d4e00; }
    .status-badge.error { border-color: #f1a5a5; background: #ffebe9; color: #9b1c1c; }
    .status-badge.try { border-color: #1f5f9f; background: #ddf4ff; color: #0969da; }
    .status-badge.open .status-value, .status-badge.open .status-detail { color: #116329; }
    .status-badge.closed .status-value, .status-badge.closed .status-detail, .status-badge.accepted .status-value, .status-badge.accepted .status-detail { color: #6639ba; }
    .status-badge.warning .status-value, .status-badge.warning .status-detail { color: #7d4e00; }
    .status-badge.error .status-value, .status-badge.error .status-detail { color: #9b1c1c; }
    .status-badge.try .status-value, .status-badge.try .status-detail { color: #0969da; }
    .try-run-group { align-items: center; display: inline-flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
    .try-run-toggle { align-items: center; background: #fff; border: 1px solid #d0d7de; border-radius: 999px; color: #57606a; cursor: pointer; display: inline-flex; font-size: 12px; height: 22px; justify-content: center; line-height: 1; width: 22px; }
    .try-run-toggle:hover, .try-run-toggle:focus { background: #f6f8fa; outline: none; }
    .try-run-history { align-items: center; display: inline-flex; flex-wrap: wrap; gap: 5px; }
    .try-run-history[hidden] { display: none; }
    .checkin-needed-button { align-items: center; background: #1f883d; border: 1px solid #1f883d; border-radius: 999px; color: #fff; cursor: pointer; display: inline-flex; font-size: 12px; line-height: 1.2; padding: 3px 8px; white-space: nowrap; }
    .checkin-needed-button:hover, .checkin-needed-button:focus { background: #1a7f37; border-color: #1a7f37; }
    .checkin-needed-button:disabled { background: #dafbe1; border-color: #2da44e; color: #116329; cursor: default; }
    .diff-stats { display: flex; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; gap: 6px; white-space: nowrap; }
    .diff-stats[hidden] { display: none; }
    .checkout-commit, .amend-commit, .submit-commit, .load-more { border: 1px solid #1f5f9f; border-radius: 4px; background: #1f5f9f; color: #fff; cursor: pointer; font-size: 12px; padding: 4px 8px; }
    .checkout-commit:disabled, .amend-commit:disabled, .submit-commit:disabled, .load-more:disabled { cursor: wait; opacity: 0.65; }
    .checkout-status, .graph-status { color: #59616d; font-size: 12px; }
    .checkout-status.error, .graph-status.error { color: #9b1c1c; }
    .diff-body { margin: 0; padding: 10px; tab-size: 2; }
    .diff-placeholder, .error { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.38; margin: 0; white-space: pre-wrap; }
    .load-sentinel { block-size: 1px; inline-size: 100%; }
    .graph svg { overflow: visible; }
    .lane-path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .commit-dot { stroke: #ffffff; stroke-width: 2; }
    .commit-hash, .commit-message { dominant-baseline: central; font: normal 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; pointer-events: none; }
    .commit-hash { fill: #59616d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .branch-label-bg { stroke-width: 1; }
    .branch-label-text { dominant-baseline: central; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; pointer-events: none; }
    .commit-row, .commit-row * { cursor: pointer; }
    .commit-row:focus { outline: none; }
    .commit-row-hitbox { fill: transparent; pointer-events: all; transition: fill 120ms ease, stroke 120ms ease; }
    .commit-row.hover .commit-row-hitbox, .commit-row:focus-visible .commit-row-hitbox { fill: rgba(31, 95, 159, 0.08); }
    .commit-row.active .commit-row-hitbox { fill: rgba(31, 95, 159, 0.14); stroke: rgba(31, 95, 159, 0.35); stroke-width: 1; }
    .commit-row.active.hover .commit-row-hitbox { fill: rgba(31, 95, 159, 0.18); }
    .commit-row.working-tree .commit-row-hitbox { fill: rgba(31, 95, 159, 0.06); stroke: rgba(31, 95, 159, 0.2); stroke-width: 1; }
    .commit-row.working-tree.hover .commit-row-hitbox, .commit-row.working-tree:focus-visible .commit-row-hitbox { fill: rgba(31, 95, 159, 0.12); }
    .commit-row.working-tree.active .commit-row-hitbox { fill: rgba(31, 95, 159, 0.2); stroke: rgba(31, 95, 159, 0.44); }
    .commit-row.current .commit-row-hitbox { fill: rgba(245, 158, 11, 0.18); stroke: rgba(180, 83, 9, 0.35); stroke-width: 1; }
    .commit-row.current.hover .commit-row-hitbox { fill: rgba(245, 158, 11, 0.24); }
    .commit-row.current.active .commit-row-hitbox { fill: rgba(245, 158, 11, 0.3); stroke: rgba(31, 95, 159, 0.48); }
    .context-menu { background: #fff; border: 1px solid #b9c0cc; border-radius: 6px; box-shadow: 0 8px 28px rgba(15, 23, 42, 0.18); color: #20242a; min-width: 160px; padding: 4px; position: fixed; z-index: 5; }
    .context-menu[hidden] { display: none; }
    .context-menu-title { color: #59616d; font-size: 12px; max-width: 260px; overflow: hidden; padding: 6px 8px 4px; text-overflow: ellipsis; white-space: nowrap; }
    .context-menu button { background: transparent; border: 0; border-radius: 4px; color: inherit; cursor: pointer; display: block; font: inherit; padding: 7px 8px; text-align: left; width: 100%; }
    .context-menu button:hover, .context-menu button:focus { background: rgba(31, 95, 159, 0.1); outline: none; }
    .context-menu button[data-action="prune"] { color: #9b1c1c; }
    .amend-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(720px, calc(100vw - 32px)); padding: 0; width: 680px; }
    .amend-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .amend-form { display: grid; gap: 10px; margin: 0; padding: 16px; }
    .amend-title { font-size: 16px; margin: 0; }
    .amend-form label { color: #59616d; font-size: 12px; font-weight: 600; }
    .amend-message { border: 1px solid #b9c0cc; border-radius: 6px; box-sizing: border-box; color: #20242a; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; min-height: 160px; padding: 8px; resize: vertical; width: 100%; }
    .amend-error { color: #9b1c1c; font-size: 12px; margin: 0; min-height: 16px; }
    .amend-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .amend-actions button { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .amend-cancel { background: #fff; color: #20242a; }
    .amend-submit { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .amend-submit:disabled { cursor: wait; opacity: 0.65; }
    .submit-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(520px, calc(100vw - 32px)); padding: 0; width: 500px; }
    .submit-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .submit-panel { display: grid; gap: 12px; padding: 16px; }
    .submit-title { font-size: 16px; margin: 0; }
    .submit-status, .submit-question { margin: 0; }
    .submit-status { color: #59616d; font-size: 13px; }
    .submit-status.error { color: #9b1c1c; }
    .submit-prompt { border: 1px solid #d6dae1; border-radius: 6px; display: grid; gap: 10px; padding: 10px; }
    .submit-prompt[hidden], .submit-links[hidden] { display: none; }
    .submit-prompt-actions, .submit-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .submit-prompt-actions button, .submit-actions button { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .submit-answer-yes { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .submit-answer-no, .submit-close { background: #fff; color: #20242a; }
    .submit-close:disabled { cursor: wait; opacity: 0.65; }
    .submit-links { border-top: 1px solid #edf0f4; display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; }
    .submit-links a { border: 1px solid #d0d7de; border-radius: 999px; color: #0969da; font-size: 13px; padding: 5px 9px; text-decoration: none; }
    .submit-links a:hover, .submit-links a:focus { background: #f6f8fa; text-decoration: underline; }
    .submit-output { background: #f6f8fa; border: 1px solid #d6dae1; border-radius: 6px; color: #24292f; font: 12px/1.42 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: min(42vh, 360px); overflow: auto; padding: 10px; white-space: pre-wrap; }
    .try-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(560px, calc(100vw - 32px)); padding: 0; width: 540px; }
    .try-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .try-form { display: grid; gap: 12px; margin: 0; padding: 16px; }
    .try-title { font-size: 16px; margin: 0; }
    .try-grid { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
    .try-field { color: #59616d; display: grid; font-size: 12px; font-weight: 600; gap: 5px; }
    .try-field.full { grid-column: 1 / -1; }
    .try-field[hidden] { display: none; }
    .try-field input, .try-field select { border: 1px solid #b9c0cc; border-radius: 6px; box-sizing: border-box; color: #20242a; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 6px 8px; width: 100%; }
    .try-checkboxes { display: grid; gap: 8px; }
    .try-checkbox { align-items: center; color: #20242a; display: flex; font-size: 13px; gap: 8px; }
    .try-status { color: #59616d; font-size: 12px; margin: 0; min-height: 16px; }
    .try-status.error { color: #9b1c1c; }
    .try-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .try-actions button { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .try-cancel { background: #fff; color: #20242a; }
    .try-submit { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .try-submit:disabled { cursor: wait; opacity: 0.65; }
    .patch-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(760px, calc(100vw - 32px)); padding: 0; width: 720px; }
    .patch-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .patch-form { display: grid; gap: 12px; margin: 0; padding: 16px; }
    .patch-title { font-size: 16px; margin: 0; }
    .patch-grid { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
    .patch-field { color: #59616d; display: grid; font-size: 12px; font-weight: 600; gap: 5px; }
    .patch-field.full { grid-column: 1 / -1; }
    .patch-field input, .patch-field select { border: 1px solid #b9c0cc; border-radius: 6px; box-sizing: border-box; color: #20242a; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 6px 8px; width: 100%; }
    .patch-options { border: 1px solid #d6dae1; border-radius: 6px; padding: 8px 10px; }
    .patch-options summary { color: #59616d; cursor: pointer; font-size: 13px; font-weight: 600; }
    .patch-checkboxes { display: grid; gap: 7px 14px; grid-template-columns: 1fr 1fr; margin-top: 10px; }
    .patch-checkbox { align-items: center; color: #20242a; display: flex; font-size: 13px; gap: 8px; }
    .patch-status, .patch-question { margin: 0; }
    .patch-status { color: #59616d; font-size: 13px; }
    .patch-status.error { color: #9b1c1c; }
    .patch-prompt { border: 1px solid #d6dae1; border-radius: 6px; display: grid; gap: 10px; padding: 10px; }
    .patch-prompt[hidden], .patch-links[hidden] { display: none; }
    .patch-prompt-actions, .patch-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .patch-prompt-actions button, .patch-actions button { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .patch-answer-yes, .patch-submit { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .patch-answer-no, .patch-close { background: #fff; color: #20242a; }
    .patch-submit:disabled { cursor: wait; opacity: 0.65; }
    .patch-links { display: flex; flex-wrap: wrap; gap: 8px; }
    .patch-links a { border: 1px solid #d0d7de; border-radius: 999px; color: #0969da; font-size: 13px; padding: 5px 9px; text-decoration: none; }
    .patch-links a:hover, .patch-links a:focus { background: #f6f8fa; text-decoration: underline; }
    .patch-output { background: #f6f8fa; border: 1px solid #d6dae1; border-radius: 6px; color: #24292f; font: 12px/1.42 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: min(36vh, 300px); overflow: auto; padding: 10px; white-space: pre-wrap; }
    .land-dialog { border: 1px solid #b9c0cc; border-radius: 8px; box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28); color: #20242a; max-width: min(760px, calc(100vw - 32px)); padding: 0; width: 720px; }
    .land-dialog::backdrop { background: rgba(15, 23, 42, 0.36); }
    .land-panel { display: grid; gap: 12px; padding: 16px; }
    .land-title { font-size: 16px; margin: 0; }
    .land-options { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
    .land-field { color: #59616d; display: grid; font-size: 12px; font-weight: 600; gap: 5px; }
    .land-field input { border: 1px solid #b9c0cc; border-radius: 6px; box-sizing: border-box; color: #20242a; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 6px 8px; width: 100%; }
    .land-status, .land-question { margin: 0; }
    .land-status { color: #59616d; font-size: 13px; }
    .land-status.error { color: #9b1c1c; }
    .land-prompt { border: 1px solid #d6dae1; border-radius: 6px; display: grid; gap: 10px; padding: 10px; }
    .land-prompt[hidden], .land-links[hidden], .land-input-form[hidden] { display: none; }
    .land-detail { background: #f6f8fa; border: 1px solid #d6dae1; border-radius: 6px; color: #24292f; font: 12px/1.42 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: 180px; overflow: auto; padding: 8px; white-space: pre-wrap; }
    .land-detail:empty { display: none; }
    .land-choice-list { display: grid; gap: 6px; max-height: min(42vh, 360px); overflow: auto; }
    .land-choice-section { color: #59616d; font-size: 12px; font-weight: 700; padding: 8px 4px 2px; }
    .land-choice { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; color: #20242a; cursor: pointer; font-size: 13px; padding: 7px 9px; text-align: left; }
    .land-choice:hover, .land-choice:focus { background: #f6f8fa; outline: none; }
    .land-choice.accepted { border-color: #2da44e; }
    .land-choice.warning { border-color: #bf8700; }
    .land-choice.danger { border-color: #cf222e; color: #9b1c1c; }
    .land-links { display: flex; flex-wrap: wrap; gap: 8px; }
    .land-links a { border: 1px solid #d0d7de; border-radius: 999px; color: #0969da; font-size: 13px; padding: 5px 9px; text-decoration: none; }
    .land-links a:hover, .land-links a:focus { background: #f6f8fa; text-decoration: underline; }
    .land-input-form { display: flex; gap: 8px; }
    .land-input { border: 1px solid #b9c0cc; border-radius: 6px; box-sizing: border-box; color: #20242a; flex: 1; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 6px 8px; }
    .land-input-submit { background: #1f5f9f; border: 1px solid #1f5f9f; border-radius: 4px; color: #fff; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .land-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .land-actions button, .land-start { border: 1px solid #b9c0cc; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .land-start { background: #1f5f9f; border-color: #1f5f9f; color: #fff; }
    .land-close { background: #fff; color: #20242a; }
    .land-start:disabled, .land-input-submit:disabled { cursor: wait; opacity: 0.65; }
    .land-output { background: #f6f8fa; border: 1px solid #d6dae1; border-radius: 6px; color: #24292f; font: 12px/1.42 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; max-height: min(36vh, 300px); overflow: auto; padding: 10px; white-space: pre-wrap; }
    .pretty-file { background: var(--diff-bg); border: 1px solid var(--diff-border); border-radius: 6px; margin: 0 0 12px; overflow: hidden; }
    .pretty-file h3 { align-items: center; background: var(--diff-header-bg); border-bottom: 1px solid var(--diff-border); color: var(--diff-code); display: flex; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; gap: 12px; justify-content: space-between; margin: 0; min-height: 32px; overflow: hidden; padding: 8px 10px; }
    .file-heading { align-items: center; display: flex; gap: 8px; min-width: 0; }
    .file-icon { border: 1px solid var(--diff-muted); border-radius: 2px; box-sizing: border-box; flex: 0 0 auto; height: 14px; opacity: 0.72; position: relative; width: 11px; }
    .file-icon::after { border-top: 1px solid var(--diff-muted); content: ""; left: 2px; position: absolute; right: 2px; top: 4px; }
    .pretty-file .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-actions { align-items: center; display: flex; flex: 0 0 auto; gap: 8px; }
    .file-stats { display: flex; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; gap: 6px; white-space: nowrap; }
    .stat-additions { color: #1a7f37; }
    .stat-deletions { color: #cf222e; }
    .copy-path { background: var(--diff-header-bg); border: 1px solid var(--diff-border); border-radius: 6px; color: var(--diff-code); cursor: pointer; font-size: 12px; padding: 4px 8px; }
    .copy-path:hover, .copy-path:focus { background: var(--diff-hover-bg); outline: none; }
    .file-diff { background: var(--diff-bg); overflow: auto; }
    .diff-table { border-collapse: collapse; border-spacing: 0; table-layout: auto; width: max-content; min-width: 100%; }
    .diff-line { height: 24px; }
    .line-number { background: var(--diff-gutter-bg); box-sizing: border-box; color: var(--diff-muted); font: 12px/24px ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 44px; padding: 0 10px; text-align: right; user-select: none; vertical-align: top; white-space: nowrap; width: 44px; }
    .new-line { border-right: 1px solid var(--diff-gutter-border); }
    .line-code { background: var(--diff-bg); color: var(--diff-code); font: 14px/24px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 24px; vertical-align: top; white-space: pre; width: 100%; }
    .line-marker { display: inline-block; text-align: center; user-select: none; width: 1ch; }
    .line-content { display: inline; }
    .line-content .hljs-comment, .line-content .hljs-quote { color: #6e7781; }
    .line-content .hljs-keyword, .line-content .hljs-selector-tag, .line-content .hljs-subst { color: #cf222e; }
    .line-content .hljs-number, .line-content .hljs-literal, .line-content .hljs-variable, .line-content .hljs-template-variable { color: #0550ae; }
    .line-content .hljs-string, .line-content .hljs-doctag, .line-content .hljs-regexp { color: #0a3069; }
    .line-content .hljs-title, .line-content .hljs-section, .line-content .hljs-selector-id { color: #8250df; }
    .line-content .hljs-type, .line-content .hljs-class .hljs-title { color: #953800; }
    .line-content .hljs-tag, .line-content .hljs-name, .line-content .hljs-attribute { color: #116329; }
    .line-content .hljs-symbol, .line-content .hljs-bullet, .line-content .hljs-link { color: #0969da; }
    .line-content .hljs-built_in, .line-content .hljs-builtin-name { color: #953800; }
    .line-content .hljs-meta { color: #57606a; }
    .diff-line.file .line-number, .diff-line.file .line-code { background: var(--diff-file-line-bg); color: var(--diff-muted); }
    .diff-line.info .line-number, .diff-line.info .line-code { background: var(--diff-hunk-bg); color: var(--diff-hunk-code); }
    .diff-line.delete .line-marker { color: #cf222e; }
    .diff-line.delete .old-line { background: var(--diff-delete-gutter); }
    .diff-line.delete .new-line, .diff-line.delete .line-code { background: var(--diff-delete-bg); }
    .diff-line.insert .line-marker { color: #1a7f37; }
    .diff-line.insert .old-line, .diff-line.insert .new-line { background: var(--diff-insert-gutter); }
    .diff-line.insert .line-code { background: var(--diff-insert-bg); }
    .diff-line.context:hover .line-number, .diff-line.context:hover .line-code { background: var(--diff-hover-bg); }
    .diff-line.delete:hover .old-line { background: #ffc7c2; }
    .diff-line.delete:hover .new-line, .diff-line.delete:hover .line-code { background: #ffdfdc; }
    .diff-line.insert:hover .old-line, .diff-line.insert:hover .new-line { background: #bef5cb; }
    .diff-line.insert:hover .line-code { background: #dafbe1; }
    .file, .info, .delete, .insert { color: inherit; }
    .error { color: #9b1c1c; }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
      .pane-resizer { display: none; }
      .diff-viewer { position: static; max-height: none; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --diff-border: #30363d;
        --diff-header-bg: #161b22;
        --diff-bg: #0d1117;
        --diff-code: #e6edf3;
        --diff-muted: #7d8590;
        --diff-gutter-bg: #161b22;
        --diff-gutter-border: #30363d;
        --diff-file-line-bg: #161b22;
        --diff-hunk-bg: #112d4e;
        --diff-hunk-code: #79c0ff;
        --diff-delete-bg: #490202;
        --diff-delete-gutter: #67060c;
        --diff-insert-bg: #04260f;
        --diff-insert-gutter: #033a16;
        --diff-hover-bg: #161b22;
      }
      body { background: #111418; color: #f1f3f6; }
      header, .summary, .graph, .diff-viewer, .tab { background: #191d23; color: #f1f3f6; border-color: #323844; }
      .summary span, .diff-meta, .integration-status { color: #acb4c0; }
      .command-status-bar { background: #161b22; border-color: #323844; }
      .command-status-dot { background: #7d8590; }
      .command-status-bar.busy .command-status-dot { background: #79c0ff; box-shadow: 0 0 0 3px rgba(121, 192, 255, 0.14); }
      .command-status-bar.error .command-status-dot { background: #ff9f9f; box-shadow: 0 0 0 3px rgba(255, 159, 159, 0.14); }
      .command-elapsed { color: #acb4c0; }
      .update-action, .mach-action, .mach-output-toggle, .graph-menu-button { background: #191d23; border-color: #4b9eff; color: #79c0ff; }
      .mach-cancel { background: #191d23; border-color: #ff9f9f; color: #ff9f9f; }
      .command-status-close { background: #191d23; border-color: #6b7280; color: #acb4c0; }
      .update-action:hover, .update-action:focus, .mach-action:hover, .mach-action:focus, .mach-cancel:hover, .mach-cancel:focus, .mach-output-toggle:hover, .mach-output-toggle:focus, .command-status-close:hover, .command-status-close:focus, .graph-menu-button:hover, .graph-menu-button:focus { background: rgba(75, 158, 255, 0.16); }
      .update-status { color: #acb4c0; }
      .update-status.error { color: #ff9f9f; }
      .origin-main-badge { background: #191d23; border-color: #424b59; color: #acb4c0; }
      .origin-main-badge.current { background: #072b15; border-color: #2ea043; color: #7ee787; }
      .origin-main-badge.stale, .origin-main-badge.warning { background: #341a00; border-color: #9e6a03; color: #f2cc60; }
      .origin-main-badge.error { background: #3d1114; border-color: #da3633; color: #ff9f9f; }
      .mach-output-panel { background: #161b22; border-color: #323844; }
      .mach-output { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .diff-message { border-color: #323844; color: #f1f3f6; }
      .diff-message a { color: #79c0ff; }
      .status-badge { background: #191d23; border-color: #424b59; color: #e6edf3; }
      .status-badge:hover, .status-badge:focus { background: #161b22; }
      .status-badge .status-value, .status-badge .status-detail { color: #acb4c0; }
      .status-badge.open { background: #072b15; border-color: #2ea043; color: #7ee787; }
      .status-badge.closed, .status-badge.accepted { background: #28133f; border-color: #8957e5; color: #d2a8ff; }
      .status-badge.warning { background: #341a00; border-color: #9e6a03; color: #f2cc60; }
      .status-badge.error { background: #3d1114; border-color: #da3633; color: #ff9f9f; }
      .status-badge.try { background: #0b2538; border-color: #4b9eff; color: #79c0ff; }
      .status-badge.open .status-value, .status-badge.open .status-detail { color: #7ee787; }
      .status-badge.closed .status-value, .status-badge.closed .status-detail, .status-badge.accepted .status-value, .status-badge.accepted .status-detail { color: #d2a8ff; }
      .status-badge.warning .status-value, .status-badge.warning .status-detail { color: #f2cc60; }
      .status-badge.error .status-value, .status-badge.error .status-detail { color: #ff9f9f; }
      .status-badge.try .status-value, .status-badge.try .status-detail { color: #79c0ff; }
      .try-run-toggle { background: #191d23; border-color: #424b59; color: #acb4c0; }
      .try-run-toggle:hover, .try-run-toggle:focus { background: #161b22; }
      .checkin-needed-button { background: #238636; border-color: #238636; color: #fff; }
      .checkin-needed-button:hover, .checkin-needed-button:focus { background: #2ea043; border-color: #2ea043; }
      .checkin-needed-button:disabled { background: #072b15; border-color: #2ea043; color: #7ee787; }
      .pane-resizer::before { background: #424b59; }
      .pane-resizer:hover::before, .pane-resizer:focus-visible::before, .pane-resizer.dragging::before { background: #4b9eff; box-shadow: 0 0 0 3px rgba(75, 158, 255, 0.18); }
      .diff-header { border-color: #323844; }
      .stat-additions { color: #3fb950; }
      .stat-deletions { color: #f85149; }
      .copy-path { color: var(--diff-code); }
      .line-content .hljs-comment, .line-content .hljs-quote { color: #8b949e; }
      .line-content .hljs-keyword, .line-content .hljs-selector-tag, .line-content .hljs-subst { color: #ff7b72; }
      .line-content .hljs-number, .line-content .hljs-literal, .line-content .hljs-variable, .line-content .hljs-template-variable { color: #79c0ff; }
      .line-content .hljs-string, .line-content .hljs-doctag, .line-content .hljs-regexp { color: #a5d6ff; }
      .line-content .hljs-title, .line-content .hljs-section, .line-content .hljs-selector-id { color: #d2a8ff; }
      .line-content .hljs-type, .line-content .hljs-class .hljs-title { color: #ffa657; }
      .line-content .hljs-tag, .line-content .hljs-name, .line-content .hljs-attribute { color: #7ee787; }
      .line-content .hljs-symbol, .line-content .hljs-bullet, .line-content .hljs-link { color: #58a6ff; }
      .line-content .hljs-built_in, .line-content .hljs-builtin-name { color: #ffa657; }
      .line-content .hljs-meta { color: #8b949e; }
      .diff-line.delete .line-marker { color: #f85149; }
      .diff-line.insert .line-marker { color: #3fb950; }
      .checkout-commit, .amend-commit, .submit-commit, .load-more { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .checkout-status, .graph-status { color: #acb4c0; }
      .checkout-status.error, .graph-status.error { color: #ff9f9f; }
      .diff-line.delete:hover .old-line { background: #78191e; }
      .diff-line.delete:hover .new-line, .diff-line.delete:hover .line-code { background: #5c0b0f; }
      .diff-line.insert:hover .old-line, .diff-line.insert:hover .new-line { background: #0f5323; }
      .diff-line.insert:hover .line-code { background: #06361a; }
      .tab.active { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .commit-row.hover .commit-row-hitbox, .commit-row:focus-visible .commit-row-hitbox { fill: rgba(75, 158, 255, 0.12); }
      .commit-row.active .commit-row-hitbox { fill: rgba(75, 158, 255, 0.2); stroke: rgba(75, 158, 255, 0.42); }
      .commit-row.active.hover .commit-row-hitbox { fill: rgba(75, 158, 255, 0.26); }
      .commit-row.working-tree .commit-row-hitbox { fill: rgba(75, 158, 255, 0.12); stroke: rgba(75, 158, 255, 0.28); }
      .commit-row.working-tree.hover .commit-row-hitbox, .commit-row.working-tree:focus-visible .commit-row-hitbox { fill: rgba(75, 158, 255, 0.18); }
      .commit-row.working-tree.active .commit-row-hitbox { fill: rgba(75, 158, 255, 0.28); stroke: rgba(75, 158, 255, 0.52); }
      .commit-row.current .commit-row-hitbox { fill: rgba(251, 191, 36, 0.22); stroke: rgba(251, 191, 36, 0.42); }
      .commit-row.current.hover .commit-row-hitbox { fill: rgba(251, 191, 36, 0.28); }
      .commit-row.current.active .commit-row-hitbox { fill: rgba(251, 191, 36, 0.34); stroke: rgba(75, 158, 255, 0.55); }
      .context-menu { background: #191d23; border-color: #424b59; color: #f1f3f6; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42); }
      .context-menu-title { color: #acb4c0; }
      .context-menu button:hover, .context-menu button:focus { background: rgba(75, 158, 255, 0.16); }
      .context-menu button[data-action="prune"] { color: #ff9f9f; }
      .graph-options-menu, .graph-submenu { background: #191d23; border-color: #424b59; color: #f1f3f6; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42); }
      .graph-menu-command:hover, .graph-menu-command:focus { background: rgba(75, 158, 255, 0.16); }
      .amend-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .amend-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .amend-form label { color: #acb4c0; }
      .amend-message { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .amend-error { color: #ff9f9f; }
      .amend-cancel { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .amend-submit { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .submit-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .submit-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .submit-status { color: #acb4c0; }
      .submit-status.error { color: #ff9f9f; }
      .submit-prompt { border-color: #424b59; }
      .submit-prompt-actions button, .submit-actions button { border-color: #424b59; }
      .submit-answer-yes { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .submit-answer-no, .submit-close { background: #191d23; color: #f1f3f6; }
      .submit-links { border-color: #323844; }
      .submit-links a { border-color: #424b59; color: #79c0ff; }
      .submit-links a:hover, .submit-links a:focus { background: #161b22; }
      .submit-output { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .try-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .try-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .try-field { color: #acb4c0; }
      .try-field input, .try-field select { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .try-checkbox { color: #f1f3f6; }
      .try-status { color: #acb4c0; }
      .try-status.error { color: #ff9f9f; }
      .try-cancel { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .try-submit { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .patch-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .patch-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .patch-field, .patch-options summary { color: #acb4c0; }
      .patch-field input, .patch-field select { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .patch-options, .patch-prompt { border-color: #424b59; }
      .patch-checkbox { color: #f1f3f6; }
      .patch-status { color: #acb4c0; }
      .patch-status.error { color: #ff9f9f; }
      .patch-prompt-actions button, .patch-actions button { border-color: #424b59; }
      .patch-answer-yes, .patch-submit { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .patch-answer-no, .patch-close { background: #191d23; color: #f1f3f6; }
      .patch-links a { border-color: #424b59; color: #79c0ff; }
      .patch-links a:hover, .patch-links a:focus { background: #161b22; }
      .patch-output { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .land-dialog { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .land-dialog::backdrop { background: rgba(0, 0, 0, 0.58); }
      .land-field { color: #acb4c0; }
      .land-field input, .land-input { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .land-status { color: #acb4c0; }
      .land-status.error { color: #ff9f9f; }
      .land-prompt { border-color: #424b59; }
      .land-detail, .land-output { background: #0d1117; border-color: #424b59; color: #e6edf3; }
      .land-choice-section { color: #acb4c0; }
      .land-choice { background: #191d23; border-color: #424b59; color: #f1f3f6; }
      .land-choice:hover, .land-choice:focus { background: #161b22; }
      .land-choice.danger { color: #ff9f9f; }
      .land-links a { border-color: #424b59; color: #79c0ff; }
      .land-links a:hover, .land-links a:focus { background: #161b22; }
      .land-start, .land-input-submit { background: #4b9eff; border-color: #4b9eff; color: #07111f; }
      .land-close { background: #191d23; border-color: #424b59; color: #f1f3f6; }
    }
  </style>
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
      <nav class="tabs">${tabButtons}</nav>
      ${updateActions}
    </div>
  </header>
  <main>${tabPanels}</main>
  <div class="context-menu" id="commit-context-menu" hidden role="menu" aria-label="Commit actions">
    <div class="context-menu-title"></div>
    <button type="button" role="menuitem" data-action="checkout">Checkout</button>
    <button type="button" role="menuitem" data-action="rebase">Rebase</button>
    <button type="button" role="menuitem" data-action="prune">Prune</button>
  </div>
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
