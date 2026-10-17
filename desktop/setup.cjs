const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { readJson, writeJson, rememberCheckout, configuredCheckout, setupStatus, processAlive, findCheckout } = require("./setup-store.cjs");
const { terminalPlan, launchTerminal } = require("./setup-launcher.cjs");
const { credentialStatus, saveCredentials } = require("./setup-credentials.cjs");

const { checkPrerequisites } = require("./setup-prerequisites.cjs");
const { gitIdentity, validateIdentity } = require("./setup-environment.cjs");

function prerequisitesUrl(platform = process.platform) {
  const page = { darwin: "macos", win32: "windows", linux: "linux" }[platform] || "linux";
  return `https://developer.thunderbird.net/thunderbird-development/building-thunderbird/${page}-build-prerequisites`;
}

async function chooseCheckout({ app, BrowserWindow, dialog, ipcMain, shell, nodeExecutable,
  option, env = process.env, launchSetup = launchTerminal,
  checkTools = checkPrerequisites, readIdentity = gitIdentity,
  configFile = path.join(os.homedir(), ".tb.json") }) {
  const userData = app.getPath("userData");
  const configured = configuredCheckout({ userData, option, env });
  if (configured) {
    const saved = readJson(path.join(userData, "checkout.json"));
    if (saved?.credentialsSetupComplete) return configured;
    const credentials = credentialStatus(configFile);
    if (credentials.phabricatorUser && credentials.hasPhabricatorToken && credentials.hasBugzillaKey) return configured;
  }
  const stateFile = path.join(userData, "setup.json");
  const window = new BrowserWindow({ width: 760, height: 720, minWidth: 600, minHeight: 600,
    title: "Set up Thunderbird development", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "setup-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  const channel = "commands-setup";
  const savedState = setupStatus(stateFile);
  const restored = savedState && (!configured || savedState.destination === path.dirname(configured) || savedState.draft?.destination === path.dirname(configured)) ? savedState : null;
  let draft = restored?.draft || (configured ? { destination: path.dirname(configured), existing: true } : undefined);
  if (!draft && restored?.destination && !restored.task) draft = { destination: restored.destination, existing: !!restored.existing };
  let stage = ["credentials", "submission"].includes(restored?.uiStage) ? restored.uiStage : restored ? "progress" : configured ? "configure" : "";
  let selectedCheckout = (restored?.task === "submission" || ["credentials", "submission"].includes(restored?.uiStage)) ? findCheckout(restored.destination) : "";
  const preparationTools = () => {
    const tools = checkTools();
    if (draft && !draft.existing) {
      const disk = fs.statfsSync(path.dirname(draft.destination));
      const gb = Math.floor(Number(disk.bavail) * Number(disk.bsize) / 1024 ** 3);
      tools.checks.push({ label: `${gb} GB free in the source location (40 GB minimum)`, ready: gb >= 40 });
      tools.ready = tools.ready && gb >= 40;
    }
    return tools;
  };
  let busy = false;
  let settled = false;
  let resolveChoice, rejectChoice;
  const choice = new Promise((resolve, reject) => { resolveChoice = resolve; rejectChoice = reject; });
  const finish = candidate => {
    const commPath = rememberCheckout(userData, candidate);
    writeJson(path.join(userData, "checkout.json"), { commPath, credentialsSetupComplete: true });
    settled = true;
    resolveChoice(commPath);
    setImmediate(() => { if (!window.isDestroyed()) window.close(); });
    return { commPath, completed: true };
  };
  const credentialsStep = candidate => {
    selectedCheckout = findCheckout(candidate);
    if (!selectedCheckout) throw new Error("Choose the Thunderbird comm folder or its Firefox parent. Both source checkouts must be present.");
    return { checkout: selectedCheckout, credentials: credentialStatus(configFile) };
  };
  const handle = async (_event, action, value) => {
    if (action === "status") return { state: setupStatus(stateFile), draft, stage,
      ...(stage === "configure" ? { tools: preparationTools(), identity: readIdentity(draft?.existing ? path.join(draft.destination, "comm") : undefined) } : {}),
      ...(selectedCheckout ? { checkout: selectedCheckout, credentials: credentialStatus(configFile) } : {}) };
    if (action === "new") {
      draft = undefined;
      selectedCheckout = "";
      stage = "configure";
      return { stage, reset: true, tools: preparationTools(), identity: readIdentity() };
    }
    if (action === "check-tools") return { tools: preparationTools() };
    if (action === "open-dashboard") {
      if (stage !== "submission" && !(setupStatus(stateFile)?.task === "submission" && ["complete", "failed", "interrupted"].includes(setupStatus(stateFile)?.status))) throw new Error("Complete the environment and credentials steps first.");
      return finish(selectedCheckout);
    }
    if (action === "prepare") {
      if (setupStatus(stateFile)?.task !== "prerequisites") throw new Error("This step is only for prerequisite checks.");
      stage = "configure";
      return { stage, draft, tools: preparationTools() };
    }
    if (action === "prerequisites") { await shell.openExternal(prerequisitesUrl()); return {}; }
    if (action === "phabricator-settings" || action === "bugzilla-settings") {
      await shell.openExternal(action === "phabricator-settings"
        ? "https://phabricator.services.mozilla.com/settings/"
        : "https://bugzilla.mozilla.org/userprefs.cgi?tab=apikey");
      return {};
    }
    if (action === "save-credentials" || action === "skip-credentials") {
      if (!findCheckout(selectedCheckout)) throw new Error("Choose a valid source checkout before finishing setup.");
      if (action === "save-credentials") saveCredentials(configFile, value);
      stage = "submission";
      writeJson(stateFile, { ...setupStatus(stateFile), destination: path.dirname(selectedCheckout), uiStage: stage });
      return { stage };
    }
    if (action === "existing") {
      const result = await dialog.showOpenDialog(window, { title: "Choose Thunderbird comm or its Firefox parent",
        properties: ["openDirectory"] });
      if (result.canceled) return {};
      const checkout = findCheckout(result.filePaths[0]);
      if (!checkout) throw new Error("Choose the Thunderbird comm folder or its Firefox parent. Both source checkouts must be present.");
      draft = { destination: path.dirname(checkout), existing: true };
      selectedCheckout = "";
      stage = "configure";
      return { draft, stage, identity: readIdentity(checkout), tools: preparationTools() };
    }
    if (action === "folder") {
      const result = await dialog.showOpenDialog(window, { title: "Choose a parent folder for the new environment",
        properties: ["openDirectory", "createDirectory"] });
      if (result.canceled) return {};
      const destination = path.join(fs.realpathSync(result.filePaths[0]), "thunderbird");
      if (/\s/.test(destination)) throw new Error("Choose a folder whose path has no spaces. Mozilla build tools need a path without spaces.");
      if (fs.existsSync(destination)) throw new Error(`${destination} already exists. Choose a different parent folder, or use the existing checkout option.`);
      draft = { destination };
      selectedCheckout = "";
      stage = "configure";
      return { draft, stage, identity: readIdentity(), tools: preparationTools() };
    }
    if (action === "finish") {
      const state = setupStatus(stateFile);
      if (state?.status !== "complete") throw new Error("Wait for setup to finish first.");
      if (state.task === "prerequisites") { stage = "configure"; return { tools: preparationTools(), stage, draft }; }
      if (state.task === "submission") { stage = "submission"; return { stage, submissionVerified: true }; }
      if (!state.environmentVerified) throw new Error("Build and verify Thunderbird before continuing.");
      stage = "credentials";
      writeJson(stateFile, { ...state, uiStage: stage });
      return { ...credentialsStep(path.join(state.destination, "comm")), stage };
    }
    if (["start", "retry", "install-tools", "submission"].includes(action)) {
      const previous = setupStatus(stateFile);
      if (["running", "opening"].includes(previous?.status)) throw new Error("Setup is already running. Check its terminal for prompts.");
      let state;
      if (action === "retry") {
        if (!previous || previous.status === "complete") throw new Error("There is no interrupted setup to retry.");
        state = previous;
      } else if (action === "install-tools") {
        state = { destination: userData, mode: "full", task: "prerequisites", draft, id: randomUUID() };
      } else if (action === "submission") {
        if (stage !== "submission" || !findCheckout(selectedCheckout)) throw new Error("Complete the environment and credentials steps first.");
        state = { destination: path.dirname(selectedCheckout), mode: "full", task: "submission", id: randomUUID() };
      } else {
        if (!preparationTools().ready) throw new Error("Install the missing tools, then select Recheck tools.");
        if (!draft || !["full", "artifact"].includes(value?.mode)) throw new Error("Choose a folder and build type first.");
        state = { ...draft, mode: value.mode, identity: validateIdentity(value.identity), id: randomUUID() };
      }
      const lock = `${stateFile}.lock`;
      if (fs.existsSync(lock)) {
        const owner = readJson(lock);
        if (!owner || processAlive(owner.pid)) throw new Error("The previous setup terminal still owns this setup. Close it before retrying.");
        // Only the single desktop controller recovers a dead runner's lock.
        fs.unlinkSync(lock);
      }
      const directory = path.join(userData, "setup", state.id);
      fs.mkdirSync(directory, { recursive: true });
      const plan = terminalPlan({ directory, node: nodeExecutable(),
        runner: path.join(__dirname, "setup-runner.cjs").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2"), stateFile, useMozillaBuild: state.task !== "prerequisites" });
      Object.assign(state, { status: "opening", pid: null, error: "", step: "Opening setup terminal", updatedAt: Date.now() });
      writeJson(stateFile, state);
      try { await launchSetup(plan, { openPath: file => shell.openPath(file) }); }
      catch (error) {
        writeJson(stateFile, { ...state, status: "failed", error: error.message });
        throw error;
      }
      stage = "progress";
      return { state: readJson(stateFile), stage };
    }
    throw new Error("Unknown setup action.");
  };
  ipcMain.handle(channel, async (event, action, value) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("Setup request did not come from the setup window.");
    }
    if (busy && action !== "status") return { error: "Wait for the current action to finish." };
    const mutation = action !== "status";
    if (mutation) busy = true;
    try { return await handle(event, action, value); }
    catch (error) { return { error: error.message }; }
    finally { if (mutation) busy = false; }
  });
  window.once("closed", () => {
    ipcMain.removeHandler(channel);
    if (!settled) resolveChoice(null);
  });
  window.webContents.once("did-fail-load", (_event, _code, description) => {
    rejectChoice(new Error(description));
    window.destroy();
  });
  try { await window.loadFile(path.join(__dirname, "setup.html")); }
  catch (error) { window.destroy(); throw error; }
  return choice;
}

module.exports = { chooseCheckout, prerequisitesUrl };
