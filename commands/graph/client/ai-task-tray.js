import { INTERACTIVE } from "./config.js";

const tasks = new Map();
const adapters = new Map();
const storageKey = `tb-ai-tasks:${INTERACTIVE.token}`;
const labels = { thinking: "Thinking", working: "Working", waiting: "Waiting for input", complete: "Complete" };
let tray, list, permissionButton, permissionNote, timer;
let polling = false;
let collapsed = false;
const dismissed = new Set();

export function getAiTaskState(session = {}, busy) {
  const phase = session.status || session.phase;
  if (["complete", "cancelled", "canceled"].includes(phase)) return "complete";
  if (session.error || ["error", "paused", "needs-evidence"].includes(phase)) return "waiting";
  const running = busy ?? ["running", "preparing", "pulling", "reviewing", "applying", "amending", "posting", "implementing", "committing", "verifying", "submitting", "monitoring"].includes(phase);
  if (!running) return "waiting";
  if (["thinking", "working"].includes(session.aiTaskState)) return session.aiTaskState;
  const latest = session.activity?.findLast?.(entry => ["reasoning", "command", "tool", "edit", "research"].includes(entry.kind));
  if (latest) return latest.kind === "reasoning" ? "thinking" : "working";
  return ["reviewing", "implementing", "verifying"].includes(phase) ? "thinking" : "working";
}

function persist() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...tasks.values()].filter(task => task.endpoint).map(({ key, kind, id, title, state, revision, mode, graphIndex, endpoint }) =>
      ({ key, kind, id, title, state, revision, mode, graphIndex, endpoint }))));
  } catch { /* Task tracking still works when browser storage is unavailable. */ }
}

function permissionStatus() {
  if (!permissionButton) return;
  const permission = window.Notification?.permission;
  permissionButton.hidden = !window.Notification || permission === "granted" || permission === "denied";
  permissionNote.textContent = !window.Notification ? "System notifications are unavailable in this browser."
    : permission === "denied" ? "Notifications are blocked. Allow them in this site's browser settings."
    : permission === "granted" ? "System notifications enabled" : "Enable notifications to get task updates outside this tab.";
}

export async function enableTaskNotifications() {
  if (!INTERACTIVE.aiEnabled || !window.Notification || Notification.permission !== "default") return;
  try { await Notification.requestPermission(); } catch { /* Keep task status visible if the browser blocks permission. */ }
  permissionStatus();
}

function ensureTray() {
  if (tray || !INTERACTIVE.aiEnabled || !INTERACTIVE.enabled) return;
  tray = document.createElement("aside");
  tray.className = "ai-task-tray"; tray.setAttribute("aria-label", "AI tasks");
  const header = document.createElement("div"); header.className = "ai-task-tray-header";
  const title = document.createElement("strong"); title.textContent = "AI tasks";
  const collapse = document.createElement("button"); collapse.type = "button"; collapse.textContent = "Collapse";
  collapse.className = "ai-task-collapse"; collapse.setAttribute("aria-expanded", "true");
  collapse.addEventListener("click", () => {
    collapsed = !collapsed;
    tray.classList.toggle("collapsed", collapsed);
    collapse.textContent = collapsed ? "Show tasks" : "Collapse";
    collapse.setAttribute("aria-expanded", String(!collapsed));
  });
  permissionButton = document.createElement("button"); permissionButton.type = "button"; permissionButton.textContent = "Enable notifications";
  permissionButton.addEventListener("click", enableTaskNotifications);
  permissionNote = document.createElement("small"); permissionNote.className = "ai-task-notification-note";
  list = document.createElement("div"); list.className = "ai-task-list";
  header.append(title, collapse); tray.append(header, permissionButton, permissionNote, list); document.body.append(tray);
  permissionStatus();
}

function persistDismissed() {
  try { sessionStorage.setItem(`${storageKey}:dismissed`, JSON.stringify([...dismissed])); } catch { /* Optional browser storage. */ }
}

function dismissTask(key) {
  dismissed.add(key);
  persistDismissed();
  tasks.get(key)?.card?.remove();
  tasks.delete(key);
  persist();
  if (tray) tray.hidden = !tasks.size;
}

function render(task) {
  ensureTray(); if (!tray) return;
  let card = task.card;
  if (!card) {
    card = task.card = document.createElement("div"); card.className = "ai-task-toast"; card.dataset.taskKey = task.key;
    const open = document.createElement("button"); open.type = "button"; open.className = "ai-task-open";
    const title = document.createElement("strong"); title.className = "ai-task-title";
    const status = document.createElement("span"); status.className = "ai-task-state"; status.setAttribute("role", "status");
    open.append(title, status); open.addEventListener("click", () => void openTask(task.key));
    const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.className = "ai-task-dismiss"; dismiss.textContent = "×";
    dismiss.addEventListener("click", () => {
      dismissTask(task.key);
    });
    card.append(open, dismiss); list.append(card);
  }
  card.dataset.state = task.state;
  card.querySelector(".ai-task-title").textContent = task.title;
  const text = task.unavailable || task.session?.error ? `${labels[task.state]} — ${task.unavailable || task.session.error}` : labels[task.state];
  const status = card.querySelector(".ai-task-state");
  if (status.textContent !== text) status.textContent = text;
  card.querySelector(".ai-task-dismiss").hidden = task.state !== "complete" && !task.unavailable;
  card.querySelector(".ai-task-dismiss").setAttribute("aria-label", `Dismiss ${task.title}`);
  tray.hidden = false;
}

function notify(task) {
  if (!window.Notification || Notification.permission !== "granted") return;
  const state = task.state;
  const send = () => {
    const key = `${storageKey}:notification:${task.key}`;
    try {
      if (localStorage.getItem(key) === state) return;
      localStorage.setItem(key, state);
    } catch { /* Storage is optional. */ }
    try {
      const notification = new Notification(`${task.title}: ${labels[state]}`, {
        body: "Open this task in Thunderbird Desktop Console.", tag: `tb-task:${task.key}`,
      });
      notification.onclick = () => { window.focus(); void openTask(task.key); notification.close(); };
    } catch { permissionNote.textContent = "System notifications could not be shown. Task updates remain here."; }
  };
  if (navigator.locks) void navigator.locks.request(`${storageKey}:notifications`, send).catch(() => {});
  else send();
}

export function trackAiTask({ kind, session, title, endpoint, busy, open }) {
  if (!INTERACTIVE.aiEnabled || !session?.id) return;
  const key = `${kind}:${session.id}`;
  if (["cancelled", "canceled"].includes(session.status || session.phase)) { dismissTask(key); return; }
  const state = getAiTaskState(session, busy);
  if (dismissed.has(key)) return;
  let task = tasks.get(key);
  const previous = task?.state;
  if (!task) { task = { key, kind, id: session.id }; tasks.set(key, task); }
  Object.assign(task, { session, title, endpoint, open: open || task.open, revision: session.revision, mode: session.mode, graphIndex: session.graphIndex,
    unavailable: "", needsRefresh: false, state });
  task.version = (task.version || 0) + 1;
  render(task); persist();
  if (previous && previous !== task.state) notify(task);
  schedule();
  return task;
}

async function openTask(key) {
  const task = tasks.get(key); if (!task) return;
  for (const adapter of adapters.values()) if (adapter.dialog?.open) adapter.minimize();
  try {
    if (task.open) await task.open();
    else {
      const adapter = adapters.get(task.kind);
      if (!adapter) throw new Error("Open the console view for this task.");
      if (task.endpoint) {
        const response = await fetch(`${task.endpoint}?token=${encodeURIComponent(INTERACTIVE.token)}`, { cache: "no-store" });
        const session = await response.json();
        if (!response.ok || !session.ok) {
          if (response.status === 404 && adapter.recover) { await adapter.recover(task); return; }
          throw new Error(session.error || "Could not open the task. Try again.");
        }
        task.session = session;
      }
      await adapter.restore(task.session);
      if (adapter.dialog) restoreDraft(adapter.dialog, task.draft);
    }
  } catch (error) { task.unavailable = error.message; task.state = "waiting"; render(task); }
}

function captureDraft(dialog) {
  return [...dialog.querySelectorAll("textarea, input, select")].map(node => ({ key: fieldKey(node), value: node.value, checked: node.checked }));
}
function fieldKey(node) {
  const context = node.closest("[data-item-id], [data-issue-id]");
  return JSON.stringify([node.tagName, node.id, node.className, context?.dataset.itemId, context?.dataset.issueId]);
}
const draftObservers = new WeakMap();
function restoreDraft(dialog, draft = []) {
  draftObservers.get(dialog)?.disconnect();
  let pending = [...draft];
  const apply = () => { pending = pending.filter(item => {
    const node = [...dialog.querySelectorAll("textarea, input, select")].find(node => fieldKey(node) === item.key);
    if (!node) return true;
    node.value = item.value;
    if ("checked" in node) node.checked = item.checked;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return false;
  }); };
  apply();
  if (pending.length) {
    const observer = new MutationObserver(() => { apply(); if (!pending.length) observer.disconnect(); });
    observer.observe(dialog, { childList: true, subtree: true });
    draftObservers.set(dialog, observer);
  }
}

export function registerAiTaskDialog({ kind, dialog, title, restore, recover, onUpdate,
  endpoint = session => `/api/${kind === "update" ? "patch-update" : "review"}/${encodeURIComponent(session.id)}` }) {
  if (!dialog || !INTERACTIVE.aiEnabled) return { update() {}, background() {}, dismiss() { dialog?.close(); }, minimize() { dialog?.close(); } };
  const adapter = { kind, dialog, restore, recover, onUpdate, id: "" };
  const button = document.createElement("button"); button.type = "button"; button.className = "ai-task-minimize"; button.textContent = "Minimize";
  button.setAttribute("aria-label", "Minimize task and keep it running");
  const close = dialog.querySelector(".patch-update-close, .patch-review-close, .submit-close, .rebase-close");
  if (close) close.before(button);
  else (dialog.querySelector("header") || dialog).append(button);
  adapter.minimize = () => {
    draftObservers.get(dialog)?.disconnect();
    const task = tasks.get(`${kind}:${adapter.id}`);
    if (task) task.draft = captureDraft(dialog);
    dialog.close();
  };
  button.addEventListener("click", () => { void enableTaskNotifications(); adapter.minimize(); });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    const task = tasks.get(`${kind}:${adapter.id}`);
    if (task) task.draft = captureDraft(dialog);
  });
  adapters.set(kind, adapter);
  return {
    minimize: adapter.minimize,
    dismiss() {
      draftObservers.get(dialog)?.disconnect();
      dismissTask(`${kind}:${adapter.id}`);
      dialog.close();
    },
    background(session) {
      trackAiTask({ kind, session, title: title(session), endpoint: endpoint(session) });
    },
    update(session, busy) {
      adapter.id = session.id;
      // Opening a saved task makes it available in the tray again.
      if (dialog.open && !["cancelled", "canceled"].includes(session.status || session.phase)
          && dismissed.delete(`${kind}:${session.id}`)) {
        persistDismissed();
      }
      trackAiTask({ kind, session, title: title(session), endpoint: endpoint(session), busy });
    },
  };
}

export function registerAiTaskTarget(kind, restore) {
  adapters.set(kind, { restore, recover: restore });
}

function schedule() {
  if (!timer && !polling) timer = setTimeout(pollTasks, 1500);
}
async function pollTasks() {
  timer = undefined; polling = true;
  await Promise.all([...tasks.values()].filter(task => task.endpoint && (task.needsRefresh || task.state !== "complete")).map(async task => {
    const version = task.version;
    try {
      const response = await fetch(`${task.endpoint}?token=${encodeURIComponent(INTERACTIVE.token)}`, { cache: "no-store" });
      if (response.status === 404) { if (tasks.has(task.key) && task.version === version) dismissTask(task.key); return; }
      const session = await response.json();
      if (!response.ok || !session.ok) throw new Error(session.error || "Connection lost. Retrying.");
      if (!tasks.has(task.key) || task.version !== version) return;
      trackAiTask({ kind: task.kind, session, title: task.title, endpoint: task.endpoint });
      const adapter = adapters.get(task.kind);
      if (adapter?.dialog?.open && adapter.id === task.id) adapter.onUpdate(session);
    } catch (error) {
      if (!tasks.has(task.key) || task.version !== version) return;
      task.unavailable = error.message;
      const previous = task.state; task.state = "waiting"; render(task);
      if (previous !== task.state) notify(task);
    }
  }));
  polling = false;
  if ([...tasks.values()].some(task => task.endpoint && (task.needsRefresh || task.state !== "complete"))) schedule();
}

if (INTERACTIVE.aiEnabled && INTERACTIVE.enabled) {
  try {
    for (const key of JSON.parse(sessionStorage.getItem(`${storageKey}:dismissed`) || "[]")) dismissed.add(key);
    for (const task of JSON.parse(sessionStorage.getItem(storageKey) || "[]")) {
      if (!["update", "review", "implement", "submit"].includes(task.kind) || typeof task.id !== "string") continue;
      task.key = `${task.kind}:${task.id}`;
      task.endpoint = `/api/${task.kind === "update" ? "patch-update" : task.kind}/${encodeURIComponent(task.id)}`;
      if (dismissed.has(task.key)) continue;
      task.needsRefresh = true;
      tasks.set(task.key, task); render(task);
    }
  } catch { /* A fresh tray is safe if saved browser state cannot be read. */ }
  if (tasks.size) schedule();
}
