function isCommandActivity(entry) {
  return /\bcommand\b/i.test(String(entry?.title || ""));
}

function getActivityCommandPreview(detail) {
  const firstLine = String(detail || "").split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "Command details";

  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
}

function createCommandActivityDisclosure(entry, expandedActivityCommandIds) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const title = document.createElement("strong");
  const preview = document.createElement("span");
  const detail = document.createElement("code");

  details.className = "patch-update-activity-command-disclosure";
  details.open = expandedActivityCommandIds.has(entry.id);
  summary.className = "patch-update-activity-command-summary";
  title.textContent = entry.title || "Command";
  preview.className = "patch-update-activity-command-preview";
  preview.textContent = getActivityCommandPreview(entry.detail);
  detail.textContent = entry.detail;
  summary.append(title, preview);
  details.append(summary, detail);
  details.addEventListener("toggle", () => {
    if (details.open) {
      expandedActivityCommandIds.add(entry.id);
    } else {
      expandedActivityCommandIds.delete(entry.id);
    }
  });

  return details;
}

export function createActivityEntry(entry, expandedActivityCommandIds = new Set()) {
  const row = document.createElement("li");
  const title = document.createElement("strong");
  const command = isCommandActivity(entry);

  row.className = `patch-update-activity-entry patch-update-activity-${entry.kind || "status"}` +
    (command ? " patch-update-activity-command-row" : "");

  if (command && entry.detail) {
    row.append(createCommandActivityDisclosure(entry, expandedActivityCommandIds));
    return row;
  }

  title.textContent = entry.title || "Codex activity";
  row.append(title);

  if (entry.detail) {
    const detail = document.createElement("code");

    detail.textContent = entry.detail;
    row.append(detail);
  }

  return row;
}

export function bindAiFeedbackForm(form, { onSend, onInput = () => {}, onError = () => {} }) {
  if (!form) return;
  const input = form.querySelector(".patch-update-steer-input");
  const button = form.querySelector(".patch-update-steer-submit");
  let sending = false;
  const refresh = () => {
    onInput();
    if (sending || !input.value.trim()) button.disabled = true;
    button.textContent = sending ? "Sending..." : "Send";
  };
  input.addEventListener("input", refresh);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = input.value.trim();
    if (sending || !value || button.disabled) return;
    sending = true; refresh();
    try {
      if (await onSend(value) && input.value.trim() === value) input.value = "";
    } catch (error) { onError(error); }
    finally { sending = false; button.disabled = false; refresh(); }
  });
  refresh();
}
