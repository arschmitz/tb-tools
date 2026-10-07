import { bindAiFeedbackForm, createActivityEntry } from "./ai-dialog-controls.js";
import { renderMarkdown } from "./markdown.js";
import { INTERACTIVE } from "./config.js";
import { trackAiTask, registerAiTaskDialog, enableTaskNotifications } from "./ai-task-tray.js";
import { createCodexRunStatus } from "./codex-run-status.js";

let timer, dialog, task, runStatus, selected, currentHash, bugId;
let loading = false;
let diffLoading = false;
const diffContent = new WeakMap();
const expandedCommands = new Set();
let activityFilter = "notes";
let renderedActivity = "";
let renderedReports = "";
const field = name => dialog.querySelector(`[data-implement="${name}"]`);
const busy = run => !run.error && !["complete", "cancelled"].includes(run.phase);

async function request(action = "", body) {
  const response = await fetch(`/api/implement${action}${body ? "" : "?token=" + encodeURIComponent(INTERACTIVE.token)}`, body ? {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, token: INTERACTIVE.token }),
  } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not load Implement.");
  return result;
}

function ensureDialog() {
  if (dialog) return;
  dialog = document.createElement("dialog");
  dialog.id = "implement-dialog";
  dialog.className = "patch-update-dialog implement-dialog";
  dialog.setAttribute("aria-labelledby", "implement-title");
  dialog.innerHTML = `<div class="patch-update-panel">
    <header class="patch-update-header"><h2 id="implement-title" data-implement="title">Implement</h2>
      <button type="button" class="patch-update-close" aria-label="Close">×</button></header>
    <p data-implement="error" role="alert" hidden></p>
    <form data-implement="setup">
      <p>Implement writes and tests the patch, commits it, verifies it, and posts Try. It monitors Try and repairs failures caused by the patch.</p>
      <label>Base <select class="patch-update-steer-input" data-implement="base"><option value="main">Latest main</option><option value="current">Current commit</option></select></label>
      <label>Instructions <textarea class="patch-update-steer-input" data-implement="instructions" maxlength="32000" rows="5" placeholder="Scope, requirements, and test instructions"></textarea></label>
      <p>Uses the newest available full model with medium reasoning.</p>
      <button class="patch-update-steer-submit" type="submit">Start Implement</button>
    </form>
    <section data-implement="workspace" class="patch-update-workspace" hidden>
      <section class="implement-context" aria-label="Progress and feedback">
        <div class="implement-conversation">
        <p data-implement="phase" role="status"></p><p data-implement="meta"></p>
        <a data-implement="try" target="_blank" rel="noopener noreferrer" hidden>View Try run</a>
        <section class="patch-update-activity" aria-label="Codex activity">
          <div class="patch-update-activity-heading"><h3>Codex activity</h3>
            <div class="patch-update-activity-filter" role="group" aria-label="Codex activity filter">
              <button type="button" data-activity-filter="notes" aria-pressed="true">Notes</button>
              <button type="button" data-activity-filter="all" aria-pressed="false">All</button>
            </div>
          </div>
          <ol class="patch-update-activity-list" data-implement="activity"></ol>
        </section>
        <div data-implement="reports"></div>
        <h3>Your instructions</h3><div data-implement="history"></div>
        </div>
        <form class="patch-update-steer" data-implement="feedback">
          <label class="patch-update-steer-label" for="implement-steer-input">Guide Codex</label>
          <div><textarea id="implement-steer-input" class="patch-update-steer-input" data-implement="message" maxlength="32000" rows="2" placeholder="Add context, question an assumption, or change direction."></textarea>
          <button class="patch-update-steer-submit" type="submit">Send</button></div>
          <p data-implement="delivery" role="status"></p>
        </form>
      </section>
      <section class="implement-diffs" aria-label="Patch changes"><h3>Working diff</h3>
        <p data-implement="diff-error" role="status"></p><div data-implement="working"></div>
        <h3>Committed patch</h3><div data-implement="committed"></div></section>
    </section>
    <footer data-implement="actions" hidden>
      <button type="button" data-action="retry">Resume</button>
      <button type="button" data-action="cancel">Cancel implementation</button>
      <button type="button" data-action="dismiss">Dismiss</button>
      <span>Cancellation keeps your branch and changes. An existing Try monitor keeps running.</span>
    </footer></div>`;
  document.body.append(dialog);
  dialog.querySelector(".patch-update-close").addEventListener("click", () => dialog.close());
  runStatus = createCodexRunStatus(dialog);
  task = registerAiTaskDialog({ kind: "implement", dialog, title: run => `Bug ${run.bugId} Implement`,
    endpoint: run => `/api/implement/${encodeURIComponent(run.id)}`,
    restore: value => openRun(value.id), recover: value => openRun(value.id), onUpdate: run => { if (selected?.id === run.id) updateRun(run); } });
  field("setup").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    try {
      const result = await request("", { bugId, base: field("base").value, expectedHead: currentHash, instructions: field("instructions").value });
      updateRun(result.run); void refreshImplementations();
    } catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });
  for (const button of dialog.querySelectorAll("[data-activity-filter]")) button.addEventListener("click", () => {
    activityFilter = button.dataset.activityFilter;
    updateRun(selected);
  });
  bindAiFeedbackForm(field("feedback"), {
    onInput: () => { field("feedback").querySelector("button").disabled = !field("message").value.trim(); },
    onError: error => showError(error.message),
    onSend: async text => {
      const id = selected.id;
      const { run } = await request(`/${encodeURIComponent(id)}/feedback`, { text });
      if (selected?.id !== id) return false;
      updateRun(run);
      field("delivery").textContent = "Feedback saved. The agent will check it before committing or posting Try.";
      return true;
    },
  });
  for (const button of field("actions").querySelectorAll("button")) button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const action = button.dataset.action;
      if (action === "dismiss") {
        if (!["complete", "cancelled"].includes(selected.phase)) updateRun((await request(`/${encodeURIComponent(selected.id)}/cancel`, {})).run);
        task.dismiss();
      } else updateRun((await request(`/${encodeURIComponent(selected.id)}/${action}`, {})).run);
    }
    catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });
}

function showError(message = "") { field("error").textContent = message; field("error").hidden = !message; }

async function refreshDiff() {
  if (!dialog?.open || !selected || diffLoading) return;
  const id = selected.id;
  diffLoading = true;
  try {
    const result = await request(`/${encodeURIComponent(id)}/diff`);
    if (selected?.id !== id) return;
    for (const [name, html] of [["working", result.workingHtml], ["committed", result.committedHtml]]) {
      const content = html || "<p>No changes yet.</p>";
      if (diffContent.get(field(name)) !== content) {
        field(name).innerHTML = content; diffContent.set(field(name), content);
      }
    }
    field("diff-error").textContent = "";
  } catch (error) { if (selected?.id === id) field("diff-error").textContent = error.message; }
  finally { diffLoading = false; }
}

function renderReports(run) {
  const key = JSON.stringify([run.id, run.reports]);
  if (key === renderedReports) return;
  renderedReports = key;
  const container = field("reports");
  const expanded = new Set([...container.querySelectorAll("details[open]")].map(node => node.dataset.reportKey));
  container.replaceChildren();
  const entries = run.reports || [];
  if (!entries.length) return;
  const disclosure = (key, title) => {
    const details = document.createElement("details");
    details.dataset.reportKey = `${run.id}:${key}`;
    details.open = expanded.has(details.dataset.reportKey);
    const summary = document.createElement("summary"); summary.textContent = title;
    details.append(summary);
    return details;
  };
  const history = disclosure("history", `Reports (${entries.length})`);
  history.className = "implement-reports";
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index], report = entry.report;
    const details = disclosure(index, `${entry.role === "verify" ? "Verification" : "Implementation"} ${index + 1} — ${report.complete ? "step finished" : "unfinished"}`);
    const summary = document.createElement("div"); renderMarkdown(summary, report.summary);
    details.append(summary);
    for (const [label, items] of [
      ["Tests", report.tests], ["Acceptance criteria", report.acceptanceCriteria],
      ["Accessibility", report.accessibility ? [report.accessibility] : []],
      ["Open findings", report.findings], ["Earlier test attempts", report.testHistory],
      ["Resolved findings", report.resolvedFindings],
    ]) {
      if (!items?.length) continue;
      const group = document.createElement("section");
      const heading = document.createElement("h4"); heading.textContent = label;
      const list = document.createElement("ul");
      for (const item of items) {
        const row = document.createElement("li");
        if (item.status) {
          const status = document.createElement("strong");
          status.className = "implement-report-status";
          status.dataset.status = item.status;
          status.textContent = item.status;
          row.append(status);
        }
        if (item.command) {
          const command = document.createElement("code"); command.textContent = item.command; row.append(command);
        } else if (item.criterion || item.description) {
          const title = document.createElement("div"); renderMarkdown(title, item.criterion || item.description); row.append(title);
        }
        for (const text of [item.evidence, item.resolution]) {
          if (!text) continue;
          const content = document.createElement("div"); renderMarkdown(content, text); row.append(content);
        }
        list.append(row);
      }
      group.append(heading, list); details.append(group);
    }
    history.append(details);
  }
  container.append(history);
}

function updateRun(run) {
  selected = run;
  dialog.dataset.setup = "false";
  field("title").textContent = `Implement Bug ${run.bugId}`;
  field("setup").hidden = true; field("workspace").hidden = false;
  field("phase").textContent = run.error ? (run.errorKind === "input-required" ? "Waiting for your answer" : "Paused") : run.phase;
  const tryActivity = ({ waiting: "Pending", analyzing: "Evaluating failures", "needs-evidence": "Evaluating failures",
    repairing: "Fixing patch failures", "rust-blocked": "Failed due to Rust; waiting for origin update", "needs-rebase": "Needs a compatible current base", "ready-to-submit": "Posting another Try", submitting: "Posting another Try", passed: "Passed" })[run.tryStatus] || run.tryStatus;
  const tryResult = run.tryResultStatus === "failed"
    ? `Try complete — ${Number.isInteger(run.tryFailedJobCount) ? `${run.tryFailedJobCount} failed jobs` : "jobs failed"}; ${tryActivity}`
    : run.tryStatus && `Try: ${tryActivity}`;
  field("meta").textContent = [run.branch, run.model, tryResult].filter(Boolean).join(" · ");
  const reportInvalid = run.errorKind === "report-invalid" || /^The agent has not confirmed all /.test(run.error || "");
  const legacyBlock = run.error?.startsWith("Implementation needs attention:");
  showError(legacyBlock
    ? `${run.error.slice("Implementation needs attention:".length).trim()}\n\nThe agent did not provide a clear question. Select Resume to ask it to finish or state exactly what it needs. You can also send instructions in Guide Codex.`
    : reportInvalid && !run.reportRecoveryVersion
      ? `${run.error}\n\nThe report needs reconciliation, not a decision from you. The workflow will check its saved evidence automatically when it resumes.`
      : run.error || run.tryError);
  const entries = run.activities || (run.activity && !/^\s*(?:\[|\{)/.test(run.activity) ? [{ id: "legacy", kind: "note", title: "Codex note", detail: run.activity }] : []);
  const activityKey = JSON.stringify([run.id, entries, activityFilter]);
  if (activityKey !== renderedActivity) {
    renderedActivity = activityKey;
    const list = field("activity");
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    const visible = activityFilter === "all" ? entries : entries.filter(entry => entry.kind === "note");
    list.replaceChildren(...visible.map(entry => createActivityEntry(entry, expandedCommands)));
    if (!visible.length) {
      const empty = document.createElement("li"); empty.className = "patch-update-activity-empty";
      empty.textContent = "No Codex notes yet. Select All to include other activity.";
      list.append(empty);
    }
    if (follow) list.scrollTop = list.scrollHeight;
  }
  for (const button of dialog.querySelectorAll("[data-activity-filter]")) button.setAttribute("aria-pressed", String(button.dataset.activityFilter === activityFilter));
  renderReports(run);
  field("history").replaceChildren(...(run.instructions || []).map(item => {
    const row = document.createElement("div"); renderMarkdown(row, item.text); return row;
  }));
  const canFeedback = ["preparing", "implementing", "verifying"].includes(run.phase);
  field("feedback").hidden = !canFeedback;
  field("actions").hidden = false;
  const finished = ["complete", "cancelled"].includes(run.phase);
  field("actions").querySelector('[data-action="retry"]').textContent = "Resume";
  field("actions").querySelector('[data-action="retry"]').hidden = !run.error || finished || run.cancelRequested;
  const cancel = field("actions").querySelector('[data-action="cancel"]');
  cancel.hidden = finished;
  cancel.disabled = Boolean(run.cancelRequested);
  cancel.textContent = run.cancelRequested ? "Cancelling…" : "Cancel implementation";
  field("actions").querySelector('[data-action="dismiss"]').hidden = !finished && !run.error;
  const link = field("try"); link.hidden = !/^https:\/\/treeherder\.mozilla\.org\//.test(run.tryUrl || "");
  if (!link.hidden) link.href = run.tryUrl;
  task.update(run, busy(run));
  runStatus.update({ ...run, activity: run.activities || [], aiEnabled: true, status: run.error ? (run.errorKind === "input-required" ? "input-required" : "paused") : run.phase, output: run.activity }, busy(run));
  void refreshDiff();
}

async function openRun(id) {
  ensureDialog();
  const run = await request(`/${encodeURIComponent(id)}`);
  if (selected?.id !== id) {
    field("message").value = ""; field("delivery").textContent = "";
    diffContent.delete(field("working")); diffContent.delete(field("committed"));
    field("working").textContent = "Loading changes…"; field("committed").textContent = "";
  }
  if (!dialog.open) dialog.showModal();
  updateRun(run);
}

export function createImplementButton(bug) {
  if (!INTERACTIVE.aiEnabled || bug.hasPatch) return null;
  ensureDialog();
  const button = document.createElement("button");
  button.type = "button"; button.className = "dashboard-implement"; button.textContent = "Implement";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      void enableTaskNotifications();
      const result = await request();
      const existing = result.runs?.find(run => String(run.bugId) === String(bug.id) && !["complete", "cancelled"].includes(run.phase));
      if (existing) { await openRun(existing.id); return; }
      selected = null; dialog.dataset.setup = "true"; field("instructions").value = "";
      dialog.querySelector(".codex-run-status").hidden = true;
      bugId = bug.id; currentHash = result.currentHash;
      field("title").textContent = `Implement Bug ${bug.id}`;
      field("base").querySelector('[value="current"]').textContent = `Current commit (${currentHash.slice(0, 12)})`;
      field("setup").hidden = false; field("workspace").hidden = true; field("actions").hidden = true; showError();
      dialog.showModal();
    } catch (error) { document.querySelector(".dashboard-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
  return button;
}

export async function refreshImplementations() {
  clearTimeout(timer);
  if (!INTERACTIVE.aiEnabled || document.querySelector(".dashboard-panel")?.hidden || loading) return;
  ensureDialog(); loading = true;
  try {
    const { runs = [] } = await request();
    for (const run of runs) {
      trackAiTask({ kind: "implement", session: run, title: `Bug ${run.bugId} Implement`, endpoint: `/api/implement/${encodeURIComponent(run.id)}` });
      if (dialog.open && selected?.id === run.id) updateRun(run);
    }
  } catch (error) { if (dialog.open) showError(error.message); }
  finally { loading = false; timer = setTimeout(refreshImplementations, 5000); }
}
