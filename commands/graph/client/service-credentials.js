import { INTERACTIVE } from "./config.js";

const dialog = document.querySelector(".console-settings-dialog");
const form = dialog?.querySelector(".service-credentials-settings");
const user = form?.querySelector(".service-phabricator-user");
const phabricatorToken = form?.querySelector(".service-phabricator-token");
const bugzillaKey = form?.querySelector(".service-bugzilla-key");
const save = form?.querySelector(".service-credentials-save");
const status = form?.querySelector(".service-credentials-status");
let generation = 0;
let saving = false;

async function request(credentials) {
  const response = await fetch(`/api/service-credentials${credentials ? "" : `?token=${encodeURIComponent(INTERACTIVE.token)}`}`, credentials ? {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: INTERACTIVE.token, credentials }),
  } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Could not save service keys.");
  return result;
}

function clearKeys() {
  phabricatorToken.value = "";
  bugzillaKey.value = "";
}

function render(credentials) {
  user.value = credentials.phabricatorUser || "";
  form.querySelector("#service-phabricator-saved").textContent = credentials.hasPhabricatorToken
    ? "An API token is saved. Leave the field blank to keep it." : "No API token saved.";
  form.querySelector("#service-bugzilla-saved").textContent = credentials.hasBugzillaKey
    ? "An API key is saved. Leave the field blank to keep it." : "No API key saved.";
  clearKeys();
}

export async function loadServiceCredentials() {
  if (!form || saving) return;
  const current = ++generation;
  clearKeys();
  save.disabled = true;
  status.textContent = "Loading service settings...";
  try {
    const result = await request();
    if (generation !== current) return;
    render(result.credentials);
    status.textContent = result.credentials.error || "";
    save.disabled = false;
  } catch (error) {
    if (generation === current) status.textContent = error.message;
  }
}

form?.addEventListener("submit", async event => {
  event.preventDefault();
  if (saving || save.disabled) return;
  const current = generation;
  const credentials = { phabricatorUser: user.value, phabricatorToken: phabricatorToken.value, bugzillaKey: bugzillaKey.value };
  saving = true;
  save.disabled = true;
  for (const input of form.querySelectorAll("input")) input.disabled = true;
  status.textContent = "Saving service keys...";
  try {
    const result = await request(credentials);
    if (generation === current) {
      render(result.credentials);
      status.textContent = "Saved. Restart the app or console to use changed credentials.";
    }
  } catch (error) {
    if (generation === current) status.textContent = error.message;
  } finally {
    saving = false;
    save.disabled = false;
    for (const input of form.querySelectorAll("input")) input.disabled = false;
    if (generation !== current && dialog.open) void loadServiceCredentials();
  }
});

dialog?.addEventListener("close", () => { generation++; if (form) clearKeys(); });
