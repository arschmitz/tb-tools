import { INTERACTIVE } from "./config.js";

export function getBackgroundJobPhaseLabel(job) {
  if (job.kind === "Try repair" && ["analyzing", "needs-evidence"].includes(job.phase)) {
    if (job.aiRunning) return "AI analyzing failures";
    if (job.state === "waiting") return "waiting to retry";
    if (/Fetching CI evidence/i.test(job.detail || "")) return "collecting CI evidence";
    return "preparing analysis";
  }
  return job.phase.replaceAll("-", " ");
}

export function initializeBackgroundJobs() {
  const trigger = document.querySelector(".background-jobs-open");
  if (!trigger || trigger.dataset.initialized) return;
  trigger.dataset.initialized = "true";
  const dialog = document.createElement("dialog");
  dialog.className = "background-jobs-dialog";
  dialog.setAttribute("aria-labelledby", "background-jobs-title");
  dialog.innerHTML = `<header><h2 id="background-jobs-title">Background jobs</h2><button type="button" class="jobs-close">Close</button></header>
    <p class="jobs-summary" role="status"></p><p class="jobs-error" role="alert" hidden></p>
    <div class="jobs-controls"><label><input type="checkbox" class="jobs-finished"> Show finished jobs</label><button type="button" class="jobs-refresh">Refresh</button></div>
    <div class="jobs-list"></div>`;
  document.body.append(dialog);
  let timer, busy = false, snapshot;
  const list = dialog.querySelector(".jobs-list");
  const summary = dialog.querySelector(".jobs-summary");
  const error = dialog.querySelector(".jobs-error");
  function render() {
    if (!snapshot) return;
    const jobs = snapshot.jobs.filter(job => ["running", "waiting", "finished"].includes(job.state));
    summary.textContent = ["running", "waiting"].map(state => `${jobs.filter(job => job.state === state).length} ${state}`).join(" · ")
      + ` · ${jobs.filter(job => job.aiRunning).length} AI processes running`
      + (!snapshot.aiEnabled ? " · AI disabled" : snapshot.tryAiPaused ? " · Automatic Try AI paused" : " · Automatic Try AI enabled");
    list.replaceChildren();
    const visible = jobs.filter(job => dialog.querySelector(".jobs-finished").checked || job.state !== "finished")
      .sort((a, b) => ["running", "waiting", "finished"].indexOf(a.state) - ["running", "waiting", "finished"].indexOf(b.state));
    for (const job of visible) {
      const card = document.createElement("article"); card.className = "background-job"; card.dataset.state = job.state;
      const title = document.createElement("h3"); title.textContent = job.title;
      const status = document.createElement("p"); status.className = "jobs-state";
      status.textContent = `${job.kind} · ${job.state} · ${getBackgroundJobPhaseLabel(job)}${job.aiRunning ? " · AI running" : ""}`;
      card.append(title, status);
      for (const text of [job.repairTarget && `Repair target: ${job.repairTarget}`, job.detail, job.nextAction && `Next step: ${job.nextAction}`, job.checkout && `Checkout: ${job.checkout}`, job.revision && `Revision: ${job.revision.slice(0, 12)}`,
        job.createdAt && `Started: ${new Date(job.createdAt).toLocaleString()}`,
        job.updatedAt && `Last update: ${new Date(job.updatedAt).toLocaleString()}`,
        job.state === "waiting" && job.nextCheckAt && `Next check: ${new Date(job.nextCheckAt).toLocaleString()}`]) {
        if (!text) continue;
        const line = document.createElement("p"); line.textContent = text; card.append(line);
      }
      if (job.url) {
        try {
          const url = new URL(job.url);
          if (["https:", "http:"].includes(url.protocol)) {
            const link = document.createElement("a"); link.href = url.href; link.textContent = "Open Try run"; link.target = "_blank"; link.rel = "noreferrer"; card.append(link);
          }
        } catch { /* Invalid saved links do not prevent viewing the job. */ }
      }
      if (job.cancelUrl) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = job.phase === "running" ? "Close run" : "Cancel Build";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            const response = await fetch(job.cancelUrl, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ token: INTERACTIVE.token }),
            });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.error || "Could not cancel build.");
            await refresh();
          } catch (failure) {
            error.textContent = failure.message;
            error.hidden = false;
            cancel.disabled = false;
          }
        });
        card.append(cancel);
      }
      list.append(card);
    }
    if (!visible.length) list.textContent = "No active background jobs.";
  }
  async function refresh() {
    if (busy || !dialog.open) return;
    clearTimeout(timer); busy = true;
    try {
      const response = await fetch(`/api/background-jobs?token=${encodeURIComponent(INTERACTIVE.token)}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not load background jobs.");
      const changed = JSON.stringify(snapshot) !== JSON.stringify(result);
      snapshot = result; error.hidden = true; if (changed) render();
    } catch (failure) { error.textContent = `Status refresh failed: ${failure.message}. Displayed jobs may be out of date.`; error.hidden = false; }
    finally { busy = false; if (dialog.open) timer = setTimeout(refresh, 3000); }
  }
  trigger.addEventListener("click", () => { dialog.showModal(); void refresh(); });
  dialog.querySelector(".jobs-close").addEventListener("click", () => dialog.close());
  dialog.querySelector(".jobs-refresh").addEventListener("click", () => void refresh());
  dialog.querySelector(".jobs-finished").addEventListener("change", render);
  dialog.addEventListener("close", () => { clearTimeout(timer); (document.querySelector(".graph-menu-button") || trigger).focus(); });
}

// Keep open forms intact when the server connection fails.
export function showConnectionLost() {
  document.body.dataset.serverConnection = "lost";
  for (const parent of [document.body, ...document.querySelectorAll("dialog[open]")]) {
    if (parent.querySelector(":scope > .server-connection-alert")) continue;
    const alert = document.createElement("div");
    alert.className = "server-connection-alert";
    alert.setAttribute("role", "alert");
    alert.style.cssText = "position:sticky;top:0;z-index:10000;padding:12px;background:#742323;color:white;font-weight:bold";
    alert.textContent = "Console server disconnected. Displayed job status is out of date. ";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reconnect";
    reload.addEventListener("click", () => window.location.reload());
    alert.append(reload);
    parent.prepend(alert);
  }
}

export function clearConnectionLost() {
  delete document.body.dataset.serverConnection;
  for (const alert of document.querySelectorAll(".server-connection-alert")) alert.remove();
}
