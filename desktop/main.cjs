const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, WebContentsView, shell, clipboard,
  ipcMain } = require("electron");
const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// sccache 0.18 can reuse stale headers across worktrees in direct mode.
process.env.SCCACHE_DIRECT = "false";

const projectRoot = path.resolve(__dirname, "..");
let consoleWindow;
let consoleView;
let activeView;
let activeTabId = "console";
let consoleServer;
let mobileGateway;
let mobileAddress;
let remoteAccess;
let dailyBuild;
let tray;
let quitting = false;
const browserTabs = new Map();
const browserHeaderHeight = 86;

if (process.env.TB_DESKTOP_TEST === "1" && process.env.TB_DESKTOP_TEST_USER_DATA) {
  app.setPath("userData", process.env.TB_DESKTOP_TEST_USER_DATA);
}

function createStandardWindow(options) {
  const window = new BrowserWindow({
    ...options,
    frame: true,
    titleBarStyle: "default",
    icon: process.platform === "linux" ? path.join(projectRoot, "desktop", "icon.png") : undefined,
    closable: true,
    minimizable: true,
    maximizable: true,
  });
  if (process.platform === "darwin") window.setWindowButtonVisibility(true);
  return window;
}

function savedCheckoutPath() {
  const file = path.join(app.getPath("userData"), "checkout.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")).commPath; }
  catch { return ""; }
}

function validCommPath(candidate) {
  return Boolean(candidate && fs.existsSync(path.join(candidate, ".git")) &&
    fs.existsSync(path.join(path.dirname(candidate), "mach")));
}

function rememberCheckout(commPath) {
  commPath = fs.realpathSync(commPath);
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(path.join(app.getPath("userData"), "checkout.json"),
    JSON.stringify({ commPath }), { mode: 0o600 });
  return commPath;
}

async function chooseCheckout() {
  const option = process.argv.find(argument => argument.startsWith("--comm="))?.slice(7);
  const configured = option || process.env.TB_COMM_PATH || savedCheckoutPath();
  if (validCommPath(configured)) return rememberCheckout(path.resolve(configured));
  if (validCommPath(process.cwd())) return rememberCheckout(process.cwd());
  const selected = await dialog.showOpenDialog({ title: "Choose the Thunderbird comm checkout",
    properties: ["openDirectory"] });
  const commPath = selected.filePaths[0];
  if (selected.canceled || !validCommPath(commPath)) {
    throw new Error("Choose a comm checkout inside a Firefox source checkout with mach.");
  }
  return rememberCheckout(commPath);
}

function webAddress(address) {
  try {
    const url = new URL(address);
    return ["https:", "http:"].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function showLinkMenu(contents) {
  contents.on("context-menu", (_event, params) => {
    const url = webAddress(params.linkURL);
    if (!url || !consoleWindow || consoleWindow.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: "Open in Browser", click: () => { void shell.openExternal(url.href); } },
      { label: "Copy Link Address", click: () => clipboard.writeText(url.href) },
    ]).popup({ window: consoleWindow });
  });
}

function browserState() {
  const active = browserTabs.get(activeTabId);
  const history = active?.view.webContents.navigationHistory;
  const index = history?.getActiveIndex() ?? -1;
  return {
    activeId: activeTabId,
    address: active?.view.webContents.getURL() || active?.url || "Console",
    canGoBack: index > 0,
    canGoForward: Boolean(history && index < history.length() - 1),
    tabs: [{ id: "console", title: "Console", url: "" },
      ...[...browserTabs.values()].map(tab => ({ id: tab.id,
        title: tab.title || webAddress(tab.url)?.hostname || "Page", url: tab.url }))],
  };
}

function sendBrowserState() {
  if (consoleWindow && !consoleWindow.isDestroyed() && !consoleWindow.webContents.isDestroyed()) {
    consoleWindow.webContents.send("commands-browser-state", browserState());
  }
}

function layoutBrowser() {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  const [width, height] = consoleWindow.getContentSize();
  activeView?.setBounds({ x: 0, y: browserHeaderHeight, width,
    height: Math.max(0, height - browserHeaderHeight) });
}

function activateTab(id) {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  const next = id === "console" ? consoleView : browserTabs.get(id)?.view;
  if (!next) return;
  if (activeView !== next) {
    if (activeView) consoleWindow.contentView.removeChildView(activeView);
    consoleWindow.contentView.addChildView(next);
    activeView = next;
  }
  activeTabId = id;
  layoutBrowser();
  sendBrowserState();
  if (process.env.TB_DESKTOP_TEST !== "1") next.webContents.focus();
}

function closeTab(id = activeTabId) {
  const tab = browserTabs.get(id);
  if (!tab) return;
  const ids = [...browserTabs.keys()];
  const next = ids[ids.indexOf(id) + 1] || ids[ids.indexOf(id) - 1] || "console";
  if (activeTabId === id) activateTab(next);
  browserTabs.delete(id);
  tab.view.webContents.close();
  sendBrowserState();
}

function handleBrowserAction(event, { action, tabId } = {}) {
  if (event.sender !== consoleWindow?.webContents) return;
  if (action === "select") { activateTab(tabId); return; }
  if (action === "close") { closeTab(tabId || activeTabId); return; }
  const tab = browserTabs.get(activeTabId);
  if (!tab) return;
  const contents = tab.view.webContents;
  const history = contents.navigationHistory;
  const index = history.getActiveIndex();
  if (action === "back" && index > 0) history.goToIndex(index - 1);
  else if (action === "forward" && index < history.length() - 1) history.goToIndex(index + 1);
  else if (action === "reload") contents.reload();
  else if (action === "open-browser") {
    const url = webAddress(contents.getURL());
    if (url) void shell.openExternal(url.href);
  }
}

ipcMain.on("commands-browser-action", handleBrowserAction);

function showConsole() {
  if (!consoleServer) return;
  if (!consoleWindow || consoleWindow.isDestroyed()) {
    consoleWindow = createStandardWindow({ width: 1500, height: 980, minWidth: 780,
      title: "Thunderbird Commands", show: false,
      webPreferences: { preload: path.join(__dirname, "browser-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    consoleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    consoleWindow.webContents.on("did-finish-load", sendBrowserState);
    consoleWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
    consoleWindow.on("resize", layoutBrowser);
    consoleWindow.on("closed", () => {
      consoleView?.webContents.close();
      for (const tab of browserTabs.values()) tab.view.webContents.close();
      browserTabs.clear();
      consoleView = undefined;
      activeView = undefined;
      activeTabId = "console";
      consoleWindow = undefined;
    });
    consoleView = new WebContentsView({ webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
    consoleView.webContents.setWindowOpenHandler(({ url }) => {
      openManagedPage(url);
      return { action: "deny" };
    });
    consoleView.webContents.on("will-navigate", (event, url) => {
      if (webAddress(url)?.origin !== new URL(consoleServer.url).origin) {
        event.preventDefault();
        openManagedPage(url);
      }
    });
    showLinkMenu(consoleView.webContents);
    activateTab("console");
    if (process.env.TB_DESKTOP_TEST !== "1") {
      consoleWindow.once("ready-to-show", () => consoleWindow.show());
    }
    void consoleWindow.loadFile(path.join(__dirname, "browser-shell.html"));
    void consoleView.webContents.loadURL(consoleServer.url);
  } else {
    activateTab("console");
    consoleWindow.show();
    consoleWindow.focus();
  }
}

function openManagedPage(address) {
  const url = webAddress(address);
  if (!url) return;
  if (!consoleWindow || consoleWindow.isDestroyed()) showConsole();
  const existing = [...browserTabs.values()].find(tab => tab.url === url.href);
  if (existing) { activateTab(existing.id); return; }
  const id = randomUUID();
  const view = new WebContentsView({ webPreferences: {
    partition: "persist:commands-browser", contextIsolation: true,
    nodeIntegration: false, sandbox: true } });
  const tab = { id, url: url.href, title: url.hostname, view };
  browserTabs.set(id, tab);
  view.webContents.setWindowOpenHandler(({ url: next }) => {
    openManagedPage(next);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, next) => {
    if (!webAddress(next)) event.preventDefault();
  });
  view.webContents.on("page-title-updated", (_event, title) => {
    tab.title = title || webAddress(tab.url)?.hostname || "Page";
    sendBrowserState();
  });
  const update = () => { tab.url = view.webContents.getURL() || tab.url; sendBrowserState(); };
  view.webContents.on("did-navigate", update);
  view.webContents.on("did-navigate-in-page", update);
  view.webContents.on("did-stop-loading", update);
  showLinkMenu(view.webContents);
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  activateTab(id);
  void view.webContents.loadURL(url.href);
}

async function pairPhone() {
  if (!remoteAccess.status().address) {
    try { await remoteAccess.enable(); }
    catch (error) {
      const result = await dialog.showMessageBox({ type: "warning", title: "Phone access needs Tailscale",
        message: "Phone access could not start",
        detail: `${error.message}\nInstall and sign in to Tailscale on this computer and your phone, then try Pair Phone again.`,
        buttons: ["Close", "Get Tailscale"] });
      if (result.response === 1) await shell.openExternal("https://tailscale.com/download");
      return;
    }
  }
  const { code } = mobileGateway.issuePairCode();
  const address = remoteAccess.status().address;
  const result = await dialog.showMessageBox({ type: "info", title: "Pair phone",
    message: `Pairing code: ${code}`,
    detail: `Open ${address} on your phone. The code expires in 10 minutes. Add the page to your home screen for an app icon.`,
    buttons: ["Copy URL", "Close"] });
  if (result.response === 0) clipboard.writeText(address);
}

function installMenu() {
  const selectedPage = () => browserTabs.get(activeTabId);
  const menu = Menu.buildFromTemplate([
    { label: "Commands", submenu: [
      { label: "Show Console", click: showConsole },
      { label: "Pair Phone", click: () => { void pairPhone(); } },
      { label: "Disable Phone Access", click: () => { void remoteAccess.disable().catch(error => {
        void dialog.showMessageBox({ type: "error", message: "Could not disable phone access", detail: error.message });
      }); } },
      { label: "Revoke Paired Phones", click: () => { void mobileGateway.revokeAll(); } },
      { role: "quit" },
    ] },
    { label: "View", submenu: [{ role: "toggleDevTools" }] },
    { label: "Pages", submenu: [
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => { const page = selectedPage();
        const history = page?.view.webContents.navigationHistory;
        if (history?.getActiveIndex() > 0) history.goToIndex(history.getActiveIndex() - 1); } },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => { const page = selectedPage();
        const history = page?.view.webContents.navigationHistory;
        if (history && history.getActiveIndex() < history.length() - 1) {
          history.goToIndex(history.getActiveIndex() + 1);
        } } },
      { label: "Reload Page", accelerator: "CmdOrCtrl+R", click: () => selectedPage()?.view.webContents.reload() },
      { label: "Close Page", click: () => closeTab() },
      { label: "Close All Pages", click: () => {
        for (const id of [...browserTabs.keys()]) closeTab(id);
      } },
    ] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" },
      { role: "togglefullscreen" }, { role: "close" }] },
  ]);
  Menu.setApplicationMenu(menu);
  const icon = nativeImage.createFromPath(path.join(projectRoot, "desktop", "icon.png"))
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Thunderbird Commands");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Console", click: showConsole },
    { label: "Pair Phone", click: () => { void pairPhone(); } },
    { role: "quit" },
  ]));
  tray.on("double-click", showConsole);
  if (process.platform === "darwin") {
    app.dock.setIcon(path.join(projectRoot, "desktop", "icon-512.png"));
  }
}

async function start() {
  const commPath = await chooseCheckout();
  const [{ createGraphCommand }, { startInteractiveGraphServer },
    { createDailyBuildService }, { createMobileGateway }, { createRemoteAccessService },
    { ensurePairedWorktrees, getWorktreeDirectory, writeWorktreeBuildConfig },
    { default: savedConfig }] = await Promise.all([
    import("../commands/graph.mjs"), import("../commands/graph/server.mjs"),
    import("../commands/graph/daily-build.mjs"), import("./mobile-gateway.mjs"),
    import("./remote-access.mjs"),
    import("../commands/graph/worktrees.mjs"), import("../lib/config.mjs"),
  ]);
  const checkoutId = createHash("sha256").update(commPath).digest("hex").slice(0, 8);
  const review = await ensurePairedWorktrees({ geckoSource: path.dirname(commPath),
    commSource: commPath, directory: getWorktreeDirectory(`review-${checkoutId}`) });
  await writeWorktreeBuildConfig({ gecko: review.gecko.path, name: "review" });
  const appConfig = { ...savedConfig, managedReviewWorktrees: checkoutId, reviewCheckout: {
    firefoxPath: review.gecko.path, commPath: review.comm.path,
  } };
  dailyBuild = createDailyBuildService({ geckoSource: path.dirname(commPath), commSource: commPath,
    onSettingsSaved: async settings => {
      if (app.isPackaged && !process.argv.includes("--smoke-test") &&
          ["darwin", "win32"].includes(process.platform)) {
        app.setLoginItemSettings({ openAtLogin: settings.enabled });
        return app.getLoginItemSettings().status ||
          (app.getLoginItemSettings().openAtLogin ? "enabled" : "not-enabled");
      }
      return "app-must-stay-open";
    } });
  await dailyBuild.start();
  const token = randomUUID();
  let consoleHtml;
  const graphCommand = createGraphCommand({ cwd: commPath, forceInteractive: true, appConfig,
    makeToken: () => token, waitForClose: async () => "",
    startServer: async options => {
      consoleHtml = options.html;
      consoleServer = await startInteractiveGraphServer({ ...options, dailyBuild });
      return consoleServer;
    } });
  await graphCommand({ open: false, port: 0, closeTabs: false });
  mobileGateway = createMobileGateway({ targetUrl: consoleServer.url, desktopToken: token,
    html: consoleHtml, stateFile: path.join(app.getPath("userData"), "mobile-sessions.json") });
  mobileAddress = await mobileGateway.start();
  remoteAccess = createRemoteAccessService({ gatewayUrl: mobileAddress.url,
    stateFile: path.join(app.getPath("userData"), "remote-access.json") });
  await remoteAccess.start();
  if (process.argv.includes("--smoke-test")) {
    const page = await fetch(consoleServer.url);
    const status = await fetch(new URL(`/api/daily-build?token=${token}`, consoleServer.url));
    if (!page.ok || !status.ok) throw new Error("Desktop smoke test could not reach the console and daily build API.");
    process.stdout.write(`${JSON.stringify({ ok: true, review: review.comm.path,
      console: consoleServer.url, mobile: mobileAddress.url })}\n`);
    app.quit();
    return;
  }
  installMenu();
  showConsole();
}

if (process.env.TB_DESKTOP_TEST !== "1" && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showConsole());
  app.on("activate", showConsole);
  app.on("window-all-closed", () => { /* The service and tray stay available. */ });
  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await dailyBuild?.stop();
        await mobileGateway?.close();
        consoleServer?.server.shutdown?.(0, "desktop app quit");
      } catch (error) {
        console.error("Could not finish desktop shutdown:", error);
      } finally { app.quit(); }
    })();
  });
  app.whenReady().then(start).catch(async error => {
    await dialog.showMessageBox({ type: "error", message: "Commands could not start", detail: error.message });
    app.quit();
  });
}
