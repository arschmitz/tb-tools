import { INTERACTIVE } from "./config.js";

const dialog = document.querySelector(".console-settings-dialog");
const form = dialog?.querySelector("form");
const rows = dialog?.querySelector(".console-settings-rows");
const status = dialog?.querySelector(".console-settings-status");
const save = dialog?.querySelector(".console-settings-save");
let generation = 0;
let saving = false;

function option(value, text = value) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}

function renderSettings({ tasks, profiles, models }) {
  rows.replaceChildren();
  for (const task of tasks) {
    const row = document.createElement("fieldset");
    row.dataset.taskType = task.id;
    const title = document.createElement("legend");
    title.textContent = task.label;
    const description = document.createElement("p");
    description.textContent = task.description;
    const modelLabel = document.createElement("label");
    modelLabel.append("Model");
    const model = document.createElement("select");
    model.className = "console-settings-model";
    model.required = true;
    model.setAttribute("aria-label", "Model");
    for (const entry of models) model.append(option(entry.model || entry.id, entry.displayName || entry.model || entry.id));
    if (!models.some(entry => (entry.model || entry.id) === profiles[task.id].model)) {
      model.append(option(profiles[task.id].model, `${profiles[task.id].model} (unavailable)`));
    }
    model.value = profiles[task.id].model;
    modelLabel.append(model);
    const effortLabel = document.createElement("label");
    effortLabel.append("Reasoning");
    const effort = document.createElement("select");
    effort.className = "console-settings-effort";
    effort.required = true;
    effort.setAttribute("aria-label", "Reasoning");
    const updateEfforts = (value, keepUnavailable = false) => {
      const selected = models.find(entry => (entry.model || entry.id) === model.value);
      const supported = selected?.supportedReasoningEfforts?.map(entry => entry.reasoningEffort) || [];
      effort.replaceChildren(...supported.map(value => option(value)));
      if (keepUnavailable && !supported.includes(value)) effort.append(option(value, `${value} (unavailable)`));
      effort.value = supported.includes(value) || keepUnavailable ? value
        : supported.includes(selected?.defaultReasoningEffort) ? selected.defaultReasoningEffort : supported[0] || "";
    };
    updateEfforts(profiles[task.id].effort, true);
    model.addEventListener("change", () => updateEfforts(effort.value));
    effortLabel.append(effort);
    row.append(title, description, modelLabel, effortLabel);
    rows.append(row);
  }
}

async function requestSettings(body) {
  const response = await fetch(`/api/ai-settings${body ? "" : `?token=${encodeURIComponent(INTERACTIVE.token)}`}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: INTERACTIVE.token, ...body }),
  } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not load AI settings.");
  return result;
}

export async function openConsoleSettings() {
  if (!dialog || saving) return;
  const current = ++generation;
  if (!dialog.open) dialog.showModal();
  rows.replaceChildren();
  save.disabled = true;
  status.textContent = "Loading available models...";
  try {
    const result = await requestSettings();
    if (current !== generation) return;
    renderSettings(result);
    save.disabled = false;
    status.textContent = "";
  } catch (error) {
    if (current === generation) status.textContent = error.message;
  }
}

form?.addEventListener("submit", async event => {
  event.preventDefault();
  if (save.disabled || saving) return;
  const profiles = Object.fromEntries([...rows.children].map(row => [row.dataset.taskType, {
    model: row.querySelector(".console-settings-model").value,
    effort: row.querySelector(".console-settings-effort").value,
  }]));
  saving = true;
  save.disabled = true;
  rows.querySelectorAll("select").forEach(select => { select.disabled = true; });
  status.textContent = "Saving...";
  try {
    await requestSettings({ profiles });
    status.textContent = "Saved. These choices apply to the next AI turn.";
  } catch (error) { status.textContent = error.message; }
  finally {
    saving = false;
    save.disabled = false;
    rows.querySelectorAll("select").forEach(select => { select.disabled = false; });
  }
});
dialog?.querySelector(".console-settings-close").addEventListener("click", () => dialog.close());
dialog?.addEventListener("close", () => { generation++; });
