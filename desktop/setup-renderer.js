/* global document, window */
const get = id => document.getElementById(id);
let page = "welcome";
let pending = false;
let state;
let draft;

function show(next) {
  page = next;
  get("intro").hidden = next !== "welcome";
  for (const id of ["welcome", "configure", "progress", "credentials", "submission"]) get(id).hidden = id !== next;
}

function render(result) {
  if (result.completed) {
    get("phabricator-token").value = "";
    get("bugzilla-key").value = "";
    return;
  }
  if (result.reset) {
    draft = undefined;
    get("folder").hidden = false;
    get("mode-options").hidden = false;
    get("configure-title").textContent = "Set up a new environment";
    get("configure-note").textContent = "Choose a parent folder. Setup creates a thunderbird folder with both source checkouts, installs tools, builds Thunderbird, and checks its window.";
    get("destination").textContent = "No folder selected";
    get("start").disabled = true;
  }
  if (result.tools) {
    get("tool-checks").textContent = result.tools.checks.map(check => `${check.ready ? "✓" : "Missing:"} ${check.label}`).join("\n");
    get("install-tools").hidden = result.tools.ready || !result.tools.canInstall;
    get("tools-note").textContent = result.tools.ready ? "Required tools are available." : "Install the missing tools. System installers may ask for your password. Then select Recheck tools.";
  }
  if (result.identity) {
    get("git-name").value = result.identity.name;
    get("git-email").value = result.identity.email;
  }
  if (result.draft) {
    draft = result.draft;
    get("destination").textContent = draft.destination;
    get("configure-title").textContent = draft.existing ? "Prepare your existing checkout" : "Set up a new environment";
    get("folder").hidden = !!draft.existing;
    get("mode-options").hidden = !!draft.existing;
    get("configure-note").textContent = draft.existing ? "Setup keeps your source files and build settings. It installs development tools, builds Thunderbird, and checks its window in a separate profile." : "Choose a parent folder. Setup creates a thunderbird folder with both source checkouts, installs tools, builds Thunderbird, and checks its window.";
    get("start").disabled = false;
  }
  if (result.stage === "submission") {
    get("phabricator-token").value = "";
    get("bugzilla-key").value = "";
    get("submission-note").textContent = result.submissionVerified ? "Your patch submission account is verified." : "Install moz-phab and follow the terminal prompts to connect your Phabricator account. Setup only reads your review list to check the connection.";
    get("submission").hidden = false;
    get("submission-start").hidden = !!result.submissionVerified;
    show("submission");
    return;
  }
  if (result.stage === "configure") { show("configure"); return; }
  if (result.checkout && result.stage !== "progress") {
    const credentials = result.credentials || {};
    get("phabricator-user").value = credentials.phabricatorUser || "";
    get("phabricator-saved").textContent = credentials.hasPhabricatorToken ? "An API token is already saved. Leave this field blank to keep it." : "";
    get("bugzilla-saved").textContent = credentials.hasBugzillaKey ? "An API key is already saved. Leave this field blank to keep it." : "";
    get("credentials-error").textContent = credentials.error || "";
    show("credentials");
    return;
  }
  if (["credentials", "submission"].includes(page) && result.stage !== "progress") return;
  if (result.draft) {
    get("destination").textContent = result.draft.destination;
    get("start").disabled = false;
  }
  state = result.state ?? state;
  if (!state || page === "configure") return;
  show("progress");
  const complete = state.status === "complete";
  const failed = ["failed", "interrupted"].includes(state.status);
  get("progress-title").textContent = complete ? (state.task ? "This step is complete" : "Your environment is ready") : failed ? "Setup needs attention" : "Setting up your environment";
  get("step").textContent = state.step;
  get("progress-path").textContent = state.destination;
  get("setup-error").textContent = state.error || "";
  get("terminal-note").textContent = complete
    ? state.task === "prerequisites" ? "Return to preparation and recheck the tools." : state.task === "submission" ? "Your patch submission account is verified. Continue to the dashboard." : "Thunderbird built successfully and opened with a separate development profile. Continue to add your service keys."
    : "Follow any prompts in the setup terminal. Downloads can take a while. You can close this window and return later; setup continues in the terminal.";
  get("prepare").hidden = state.task !== "prerequisites" || (!failed && !complete);
  get("defer-submission").hidden = state.task !== "submission" || !failed;
  get("retry").hidden = !failed;
  get("another").hidden = !!state.task || (!failed && !complete);
  get("finish").hidden = !complete;
}

async function request(action, value) {
  if (pending) return;
  pending = true;
  get("error").textContent = "";
  try {
    const result = await window.commandsSetup.request(action, value);
    if (result.error) throw new Error(result.error);
    if (["start", "retry", "install-tools", "submission"].includes(action)) show("progress");
    render(result);
  } catch (error) { get("error").textContent = error.message; }
  finally { pending = false; }
}

for (const action of ["existing", "folder", "retry", "finish", "prerequisites",
  "skip-credentials", "phabricator-settings", "bugzilla-settings", "check-tools", "install-tools", "open-dashboard", "prepare"]) {
  get(action).addEventListener("click", () => { void request(action); });
}
get("new").addEventListener("click", () => { show("configure"); void request("new"); });
get("defer-submission").addEventListener("click", () => { void request("open-dashboard"); });
get("submission-start").addEventListener("click", () => { void request("submission"); });
get("another").addEventListener("click", () => { void request("new"); });
get("back").addEventListener("click", () => { state = null; show("welcome"); });
get("start").addEventListener("click", () => {
  void request("start", { mode: document.querySelector('input[name="mode"]:checked').value, identity: { name: get("git-name").value, email: get("git-email").value } });
});
get("credentials-form").addEventListener("submit", event => {
  event.preventDefault();
  void request("save-credentials", { phabricatorUser: get("phabricator-user").value,
    phabricatorToken: get("phabricator-token").value, bugzillaKey: get("bugzilla-key").value });
});
void request("status");
window.setInterval(() => {
  if (!pending && page === "progress") void request("status");
}, 1500);
