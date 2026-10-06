const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, WebContentsView, shell, clipboard } = require("electron");
const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// sccache 0.18 can reuse stale headers across worktrees in direct mode.
process.env.SCCACHE_DIRECT = "false";

const projectRoot = path.resolve(__dirname, "..");
let consoleWindow;
let consoleServer;
let mobileGateway;
let mobileAddress;
let remoteAccess;
let dailyBuild;
let tray;
let quitting = false;
const managedPages = new Map();

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

function showConsole() {
  if (!consoleServer) return;
  if (!consoleWindow || consoleWindow.isDestroyed()) {
    consoleWindow = new BrowserWindow({ width: 1500, height: 980, minWidth: 780,
      title: "Thunderbird Commands", show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    consoleWindow.webContents.setWindowOpenHandler(({ url }) => {
      openManagedPage(url);
      return { action: "deny" };
    });
    consoleWindow.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== new URL(consoleServer.url).origin) {
        event.preventDefault();
        openManagedPage(url);
      }
    });
    if (process.env.TB_DESKTOP_TEST !== "1") {
      consoleWindow.once("ready-to-show", () => consoleWindow.show());
    }
    void consoleWindow.loadURL(consoleServer.url);
  } else {
    consoleWindow.show();
    consoleWindow.focus();
  }
}

function openManagedPage(address) {
  let url;
  try { url = new URL(address); }
  catch { return; }
  if (!["https:", "http:"].includes(url.protocol)) return;
  const key = url.origin;
  const existing = managedPages.get(key);
  if (existing && !existing.window.isDestroyed()) {
    if (process.env.TB_DESKTOP_TEST !== "1") {
      existing.window.show();
      existing.window.focus();
    }
    void existing.view.webContents.loadURL(url.href);
    return;
  }
  const window = new BrowserWindow({ width: 1200, height: 850, minWidth: 500,
    title: url.hostname, backgroundColor: "#ffffff", show: process.env.TB_DESKTOP_TEST !== "1" });
  const partition = `persist:commands-page-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const view = new WebContentsView({ webPreferences: {
    partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.contentView.addChildView(view);
  const resize = () => { const [width, height] = window.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height }); };
  resize();
  window.on("resize", resize);
  window.on("closed", () => { managedPages.delete(key); view.webContents.close(); });
  view.webContents.on("page-title-updated", (_event, title) => window.setTitle(`${title} — ${key}`));
  view.webContents.setWindowOpenHandler(({ url: next }) => {
    openManagedPage(next);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, next) => {
    let destination;
    try { destination = new URL(next); }
    catch { event.preventDefault(); return; }
    if (!["https:", "http:"].includes(destination.protocol)) {
      event.preventDefault();
    } else if (destination.origin !== key) {
      event.preventDefault();
      openManagedPage(next);
    }
  });
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  managedPages.set(key, { window, view });
  void view.webContents.loadURL(url.href);
}

async function pairPhone() {
  if (!remoteAccess.status().address) {
    try { await remoteAccess.enable(); }
    catch (error) {
      const result = await dialog.showMessageBox({ type: "warning", title: "Phone access needs Tailscale",
        message: "Phone access could not start",
        detail: `${error.message}\nInstall and sign in to Tailscale on this Mac and your phone, then try Pair Phone again.`,
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
  const selectedPage = () => [...managedPages.values()].find(page => page.window.isFocused());
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
        if (page?.view.webContents.navigationHistory.canGoBack()) page.view.webContents.navigationHistory.goBack(); } },
      { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => { const page = selectedPage();
        if (page?.view.webContents.navigationHistory.canGoForward()) page.view.webContents.navigationHistory.goForward(); } },
      { label: "Reload Page", accelerator: "CmdOrCtrl+R", click: () => selectedPage()?.view.webContents.reload() },
      { label: "Close Page", click: () => selectedPage()?.window.close() },
      { label: "Close All Pages", click: () => {
        for (const page of managedPages.values()) page.window.close();
      } },
    ] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
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

if (!app.requestSingleInstanceLock()) app.quit();
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
