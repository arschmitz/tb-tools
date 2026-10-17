const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, WebContentsView, shell, clipboard,
  ipcMain } = require("electron");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { createDesktopBackend, backendNodeExecutable } = require("./backend-client.cjs");
const { toolEnvironment } = require("./setup-environment.cjs");
Object.assign(process.env, toolEnvironment());
const { chooseCheckout } = require("./setup.cjs");
const { APP_NAME, APP_ID } = require("./branding.cjs");

// Keep saved checkout, sign-in, and phone data in the existing directory.
app.setPath("userData", path.join(app.getPath("appData"), "thunderbird-cli"));
app.setName(APP_NAME);
process.title = APP_NAME;
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// sccache 0.18 can reuse stale headers across worktrees in direct mode.
process.env.SCCACHE_DIRECT = "false";

const projectRoot = path.resolve(__dirname, "..");
const appIconPath = path.join(projectRoot, "assets", "branding", "thunderbird-development-dashboard-app-icon-v2.png");
let consoleWindow;
let consoleView;
let activeView;
let activeTabId = "console";
let tabActivationOrder = 0;
let consoleServer;
let mobileGateway;
let mobileAddress;
let remoteAccess;
let backend;
let tray;
let quitting = false;
let restarting = false;
const browserTabs = new Map();
let browserHeaderHeight = 200;
let consoleDialogOpen = false;

if (process.env.TB_DESKTOP_TEST === "1" && process.env.TB_DESKTOP_TEST_USER_DATA) {
  app.setPath("userData", process.env.TB_DESKTOP_TEST_USER_DATA);
}

function createStandardWindow(options) {
  const window = new BrowserWindow({
    ...options,
    frame: true,
    titleBarStyle: "default",
    icon: process.platform === "linux" ? appIconPath : undefined,
    closable: true,
    minimizable: true,
    maximizable: true,
  });
  if (process.platform === "darwin") window.setWindowButtonVisibility(true);
  return window;
}

function webAddress(address) {
  try {
    const url = new URL(address);
    return ["https:", "http:"].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function installPageCommands(contents) {
  contents.on("before-input-event", (event, input) => {
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    const otherModifier = process.platform === "darwin" ? input.control : input.meta;
    if (input.type !== "keyDown" || !modifier || otherModifier || input.alt || input.isComposing) return;
    const key = input.key.toLowerCase();
    const action = input.shift ? { z: "redo", v: "pasteAndMatchStyle" }[key]
      : { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo",
        y: process.platform === "win32" ? "redo" : undefined }[key];
    if (!action) return;
    event.preventDefault();
    contents[action]();
  });
  contents.on("context-menu", (_event, params) => {
    const url = webAddress(params.linkURL);
    if (!consoleWindow || consoleWindow.isDestroyed()) return;
    const items = [];
    const flags = params.editFlags || {};
    const editItem = (label, action, enabled) => ({ label, enabled: Boolean(enabled),
      click: () => { if (!contents.isDestroyed()) contents[action](); } });
    if (params.isEditable) {
      items.push(editItem("Undo", "undo", flags.canUndo),
        editItem("Redo", "redo", flags.canRedo), { type: "separator" },
        editItem("Cut", "cut", flags.canCut), editItem("Copy", "copy", flags.canCopy),
        editItem("Paste", "paste", flags.canPaste), { type: "separator" },
        editItem("Select All", "selectAll", flags.canSelectAll));
    } else if (params.selectionText) {
      items.push(editItem("Copy", "copy", flags.canCopy));
    }
    if (url) {
      if (items.length) items.push({ type: "separator" });
      items.push(
        { label: "Open in New Tab", click: () => openManagedPage(url.href, { newTab: true }) },
        { label: "Open in Browser", click: () => { void shell.openExternal(url.href); } },
        { label: "Copy Link Address", click: () => clipboard.writeText(url.href) },
      );
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: consoleWindow });
  });
}

function browserState() {
  const active = browserTabs.get(activeTabId);
  const history = active?.view.webContents.navigationHistory;
  return {
    activeId: activeTabId,
    address: active?.view.webContents.getURL() || active?.url || "Console",
    canGoBack: Boolean(history?.canGoBack()),
    canGoForward: Boolean(history?.canGoForward()),
    canReload: Boolean(activeView && !activeView.webContents.isDestroyed()),
    tabs: [...browserTabs.values()].map(tab => ({ id: tab.id,
        title: tab.title || webAddress(tab.url)?.hostname || "Page", url: tab.url })),
  };
}

function sendBrowserState() {
  if (consoleWindow && !consoleWindow.isDestroyed() && !consoleWindow.webContents.isDestroyed()) {
    consoleView?.webContents.send("commands-browser-state", browserState());
  }
}

function layoutBrowser() {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  const { width, height } = consoleWindow.contentView.getBounds();
  consoleView?.setBounds({ x: 0, y: 0, width, height });
  if (activeView === consoleView) return;
  activeView?.setVisible(!consoleDialogOpen);
  activeView?.setBounds({ x: 0, y: browserHeaderHeight, width,
    height: Math.max(0, height - browserHeaderHeight) });
}

function focusActivePage() {
  const contents = (consoleDialogOpen ? consoleView : activeView)?.webContents;
  if (contents && !contents.isDestroyed()) contents.focus();
}

function activateTab(id) {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  const next = id === "console" ? consoleView : browserTabs.get(id)?.view;
  if (!next) return;
  if (activeView !== next) {
    if (activeView && activeView !== consoleView) consoleWindow.contentView.removeChildView(activeView);
    if (next !== consoleView) consoleWindow.contentView.addChildView(next);
    activeView = next;
  }
  activeTabId = id;
  const tab = browserTabs.get(id);
  if (tab) tab.lastActive = ++tabActivationOrder;
  layoutBrowser();
  sendBrowserState();
  if (process.env.TB_DESKTOP_TEST !== "1") focusActivePage();
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

function reloadActivePage() {
  const contents = activeView?.webContents;
  if (contents && !contents.isDestroyed()) contents.reload();
}

function showTabMenu(id) {
  if (!consoleWindow || consoleWindow.isDestroyed()) return;
  const tab = browserTabs.get(id);
  const contents = id === "console" ? consoleView?.webContents : tab?.view.webContents;
  if (!contents || contents.isDestroyed()) return;
  const url = webAddress(contents.getURL()) ||
    webAddress(id === "console" ? consoleServer.url : tab.url);
  if (!url) return;
  Menu.buildFromTemplate([
    { label: "Open in Browser", click: () => { void shell.openExternal(url.href); } },
  ]).popup({ window: consoleWindow });
}

function handleBrowserAction(event, { action, tabId } = {}) {
  if (event.sender !== consoleView?.webContents) return;
  if (action === "tab-menu") { showTabMenu(tabId); return; }
  if (action === "select") { activateTab(tabId); return; }
  if (action === "close") { closeTab(tabId || activeTabId); return; }
  if (action === "reload") { reloadActivePage(); return; }
  const tab = browserTabs.get(activeTabId);
  if (!tab) return;
  const contents = tab.view.webContents;
  const history = contents.navigationHistory;
  if (action === "back" && history.canGoBack()) history.goBack();
  else if (action === "forward" && history.canGoForward()) history.goForward();
}

ipcMain.on("commands-browser-action", handleBrowserAction);
ipcMain.on("commands-browser-focus", event => {
  if (event.sender !== consoleView?.webContents) return;
  showConsole();
});
ipcMain.on("commands-browser-ready", event => {
  if (event.sender === consoleView?.webContents) sendBrowserState();
});
ipcMain.on("commands-browser-overlay", (event, open) => {
  if (event.sender !== consoleView?.webContents || typeof open !== "boolean") return;
  consoleDialogOpen = open;
  layoutBrowser();
  focusActivePage();
});
ipcMain.on("commands-browser-layout", (event, height) => {
  if (event.sender !== consoleView?.webContents || !Number.isFinite(height)) return;
  browserHeaderHeight = Math.max(0, Math.round(height));
  layoutBrowser();
});

function showConsole() {
  if (!consoleServer) return;
  if (!consoleWindow || consoleWindow.isDestroyed()) {
    consoleWindow = createStandardWindow({ width: 1500, height: 980, minWidth: 780,
      title: APP_NAME, show: false,
      webPreferences: { preload: path.join(__dirname, "browser-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    consoleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    consoleWindow.webContents.on("did-finish-load", sendBrowserState);
    consoleWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
    installPageCommands(consoleWindow.webContents);
    consoleWindow.on("focus", focusActivePage);
    consoleWindow.on("resize", layoutBrowser);
    consoleWindow.contentView.on("bounds-changed", layoutBrowser);
    consoleWindow.on("enter-full-screen", layoutBrowser);
    consoleWindow.on("leave-full-screen", layoutBrowser);
    consoleWindow.on("closed", () => {
      consoleView?.webContents.close();
      for (const tab of browserTabs.values()) tab.view.webContents.close();
      browserTabs.clear();
      consoleDialogOpen = false;
      consoleView = undefined;
      activeView = undefined;
      activeTabId = "console";
      consoleWindow = undefined;
    });
    consoleView = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, "browser-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
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
    installPageCommands(consoleView.webContents);
    consoleWindow.contentView.addChildView(consoleView);
    consoleView.webContents.on("did-finish-load", sendBrowserState);
    activateTab("console");
    void consoleWindow.loadURL("about:blank");
    const window = consoleWindow;
    const view = consoleView;
    void view.webContents.loadURL(consoleServer.url).then(() => {
      if (window.isDestroyed()) return;
      layoutBrowser();
      if (process.env.TB_DESKTOP_TEST !== "1") {
        window.show();
        focusActivePage();
      }
    }).catch(error => {
      if (window.isDestroyed()) return;
      console.error("Could not load the dashboard:", error);
      void dialog.showMessageBox({ type: "error", message: "Could not load the dashboard",
        detail: error.message });
    });
  } else {
    if (consoleWindow.isMinimized()) consoleWindow.restore();
    activateTab("console");
    consoleWindow.show();
    consoleWindow.focus();
  }
}

function openManagedPage(address, { newTab = false } = {}) {
  try {
    const external = new URL(address);
    if (external.protocol === "vscode:" && external.hostname === "file") {
      void shell.openExternal(external.href);
      return;
    }
  } catch {
    return;
  }
  const url = webAddress(address);
  if (!url) return;
  if (!consoleWindow || consoleWindow.isDestroyed()) showConsole();
  const existing = !newTab && [...browserTabs.values()]
    .filter(tab => webAddress(tab.url)?.origin === url.origin)
    .sort((first, second) => second.lastActive - first.lastActive)[0];
  if (existing) {
    if (existing.url !== url.href) {
      existing.url = url.href;
      void existing.view.webContents.loadURL(url.href);
    }
    activateTab(existing.id);
    return;
  }
  const id = randomUUID();
  const view = new WebContentsView({ webPreferences: {
    partition: "persist:commands-browser", contextIsolation: true,
    nodeIntegration: false, sandbox: true } });
  const tab = { id, url: url.href, title: url.hostname, lastActive: 0, view };
  browserTabs.set(id, tab);
  view.webContents.setWindowOpenHandler(({ url: next }) => {
    openManagedPage(next);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, next) => {
    const nextUrl = webAddress(next);
    if (!nextUrl) event.preventDefault();
    else if (nextUrl.origin !== webAddress(tab.url)?.origin) {
      event.preventDefault();
      openManagedPage(nextUrl.href);
    }
  });
  view.webContents.on("page-title-updated", (_event, title) => {
    tab.title = title || webAddress(tab.url)?.hostname || "Page";
    sendBrowserState();
  });
  const update = () => { tab.url = view.webContents.getURL() || tab.url; sendBrowserState(); };
  view.webContents.on("did-navigate", update);
  view.webContents.on("did-navigate-in-page", update);
  view.webContents.on("did-stop-loading", update);
  installPageCommands(view.webContents);
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  activateTab(id);
  void view.webContents.loadURL(url.href);
}

function restoreAppWindow() {
  if (!consoleWindow || consoleWindow.isDestroyed()) showConsole();
  else {
    consoleWindow.show();
    consoleWindow.focus();
    focusActivePage();
  }
}

async function pairPhone() {
  if (!(await remoteAccess.status()).address) {
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
  const { code } = await mobileGateway.issuePairCode();
  const address = (await remoteAccess.status()).address;
  const result = await dialog.showMessageBox({ type: "info", title: "Pair phone",
    message: `Pairing code: ${code}`,
    detail: `Open ${address} on your phone. The code expires in 10 minutes. Add the page to your home screen for an app icon.`,
    buttons: ["Copy URL", "Close"] });
  if (result.response === 0) clipboard.writeText(address);
}

function restartApp() {
  if (restarting || quitting) return;
  restarting = true;
  app.relaunch();
  app.quit();
}

function installMenu() {
  const selectedPage = () => browserTabs.get(activeTabId);
  const menu = Menu.buildFromTemplate([
    { label: APP_NAME, submenu: [
      { role: "about" },
      { type: "separator" },
      { label: "Show Console", click: showConsole },
      { label: "Pair Phone", click: () => { void pairPhone(); } },
      { label: "Disable Phone Access", click: () => { void remoteAccess.disable().catch(error => {
        void dialog.showMessageBox({ type: "error", message: "Could not disable phone access", detail: error.message });
      }); } },
      { label: "Revoke Paired Phones", click: () => { void mobileGateway.revokeAll(); } },
      { label: "Restart", click: restartApp },
      { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "toggleDevTools" }] },
    { label: "Pages", submenu: [
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => { const page = selectedPage();
        const history = page?.view.webContents.navigationHistory;
        if (history?.canGoBack()) history.goBack(); } },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => { const page = selectedPage();
        const history = page?.view.webContents.navigationHistory;
        if (history?.canGoForward()) {
          history.goForward();
        } } },
      { label: "Reload Page", accelerator: "CmdOrCtrl+R", click: reloadActivePage },
      { label: "Close Page", click: () => closeTab() },
      { label: "Close All Pages", click: () => {
        for (const id of [...browserTabs.keys()]) closeTab(id);
      } },
    ] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" },
      { role: "togglefullscreen" },
      ...(process.platform === "darwin" ? [{ label: "Fill Entire Display", id: "fill-entire-display",
        accelerator: "Control+Command+Shift+F", click: () => {
          const window = BrowserWindow.getFocusedWindow() || consoleWindow;
          if (!window || window.isDestroyed()) return;
          const fill = () => {
            if (!window.isDestroyed()) window.setSimpleFullScreen(!window.isSimpleFullScreen());
          };
          if (window.isFullScreen()) {
            window.once("leave-full-screen", fill);
            window.setFullScreen(false);
          } else fill();
        } }] : []),
      { role: "close" }] },
  ]);
  Menu.setApplicationMenu(menu);
  const icon = nativeImage.createFromPath(appIconPath)
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Console", click: showConsole },
    { label: "Pair Phone", click: () => { void pairPhone(); } },
    { label: "Restart", click: restartApp },
    { role: "quit" },
  ]));
  tray.on("double-click", showConsole);
  if (process.platform === "darwin") {
    app.dock.setIcon(appIconPath);
  }
}

async function start() {
  const commPath = await chooseCheckout({ app, BrowserWindow, dialog, ipcMain, shell,
    nodeExecutable: backendNodeExecutable,
    option: process.argv.find(argument => argument.startsWith("--comm="))?.slice(7) });
  if (!commPath) { app.quit(); return; }
  backend = createDesktopBackend({
    onMainRequest: async (action, value) => {
      if (action !== "login") throw new Error("Unknown main process request.");
      app.setLoginItemSettings({ openAtLogin: value });
      return app.getLoginItemSettings().status || (app.getLoginItemSettings().openAtLogin ? "enabled" : "not-enabled");
    },
    onExit: () => {
      if (quitting) return;
      console.error("Dashboard service stopped. Window controls remain available.");
      void dialog.showMessageBox({ type: "error", message: "Dashboard service stopped",
        detail: "The window is still available. Use Restart to reconnect to saved tasks." });
    },
  });
  const ready = await backend.call("start", { commPath, userData: app.getPath("userData"), packaged: app.isPackaged });
  consoleServer = { url: ready.url };
  mobileAddress = ready.mobileAddress;
  const token = ready.token;
  remoteAccess = { status: () => backend.call("status"), enable: () => backend.call("enable"), disable: () => backend.call("disable") };
  mobileGateway = { issuePairCode: () => backend.call("pair"), revokeAll: () => backend.call("revoke") };
  if (process.argv.includes("--smoke-test")) {
    const page = await fetch(consoleServer.url);
    const status = await fetch(new URL(`/api/daily-build?token=${token}`, consoleServer.url));
    if (!page.ok || !status.ok) throw new Error("Desktop smoke test could not reach the console and daily build API.");
    process.stdout.write(`${JSON.stringify({ ok: true, taskWorktrees: true,
      console: consoleServer.url, mobile: mobileAddress.url,
      mainPid: process.pid, backendPid: ready.pid, runtime: ready.runtime })}\n`);
    app.quit();
    return;
  }
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: require("../package.json").version, iconPath: appIconPath });
  installMenu();
  showConsole();
}

if (process.env.TB_DESKTOP_TEST !== "1" && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showConsole());
  app.on("activate", restoreAppWindow);
  app.on("window-all-closed", () => { /* The service and tray stay available. */ });
  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await backend?.stop();
      } catch (error) {
        console.error("Could not finish desktop shutdown:", error);
      } finally { app.quit(); }
    })();
  });
  app.whenReady().then(start).catch(async error => {
    await dialog.showMessageBox({ type: "error", message: `${APP_NAME} could not start`, detail: error.message });
    app.quit();
  });
}
