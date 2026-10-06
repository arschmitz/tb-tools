export function getCodexRunStatus({ busy, error, status, silenceSeconds = 0 }) {
  if (status === "paused") return { label: "Paused — see the next step below", state: "waiting" };
  if (status === "input-required") return { label: "Waiting for your answer", state: "waiting" };
  if (error || status === "error") return { label: "Failed - see the error below", state: "error" };
  if (busy) return {
    label: silenceSeconds >= 30
      ? `Working - no new output for ${silenceSeconds}s`
      : `Working - last output ${silenceSeconds}s ago`,
    state: "working",
  };
  if (status === "complete") return { label: "Finished", state: "complete" };
  if (status === "cancelled") return { label: "Stopped", state: "complete" };
  return { label: "Waiting for your input", state: "waiting" };
}

export function createCodexRunStatus(dialog) {
  if (!dialog) return { update() {}, disconnected() {} };
  const element = document.createElement("div");
  element.className = "codex-run-status";
  element.hidden = true;
  element.setAttribute("role", "status");
  dialog.querySelector(".patch-update-header, .patch-review-header")?.append(element);
  let current;
  let key = "";
  let lastOutput = Date.now();
  let disconnected = false;
  let timer;
  const render = () => {
    if (!current) return;
    const result = disconnected ? { label: "Connection lost - status is unknown", state: "error" }
      : getCodexRunStatus({ ...current, silenceSeconds: Math.floor((Date.now() - lastOutput) / 1000) });
    element.textContent = result.label;
    element.dataset.state = result.state;
  };
  dialog.addEventListener("close", () => window.clearInterval(timer));
  return {
    update(session, busy) {
      element.hidden = !session.aiEnabled;
      const latest = session.activity?.at(-1);
      const nextKey = JSON.stringify([session.id, latest?.id, latest?.detail, session.output, session.status]);
      if (key !== nextKey) { key = nextKey; lastOutput = Date.now(); }
      current = { status: session.status, error: session.error, busy };
      disconnected = false;
      window.clearInterval(timer);
      if (busy) timer = window.setInterval(render, 1000);
      render();
    },
    disconnected() { disconnected = true; render(); },
  };
}
