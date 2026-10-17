import { randomUUID } from "node:crypto";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
let consoleServer, dailyBuild, mobileGateway, mobileAddress, remoteAccess, dependencyUpdate;
let sequence = 0;
const requests = new Map();
function requestMain(action, value) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    process.send({ mainRequest: id, action, value });
  });
}
async function start({ commPath, userData, packaged }) {
  if (process.versions.electron) throw new Error("The dashboard backend requires standalone Node.js.");
  const runtime = { executable: process.execPath, node: process.version,
    heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1024 / 1024) };
  console.log("Dashboard backend runtime:", JSON.stringify(runtime));
  const [{ createGraphCommand }, { startInteractiveGraphServer },
    { createDailyBuildService }, { createMobileGateway }, { createRemoteAccessService },
    { default: savedConfig }] = await Promise.all([
    import("../commands/graph.mjs"), import("../commands/graph/server.mjs"),
    import("../commands/graph/daily-build.mjs"), import("./mobile-gateway.mjs"),
    import("./remote-access.mjs"),
    import("../lib/config.mjs"),
  ]);
  const appConfig = { ...savedConfig, taskWorktrees: true };
  dailyBuild = createDailyBuildService({ geckoSource: path.dirname(commPath), commSource: commPath,
    ...(process.env.TB_DESKTOP_TEST === "1" ? { directory: path.join(userData, "daily-build") } : {}),
    onSettingsSaved: async settings => {
      if (process.env.TB_DESKTOP_TEST !== "1" && packaged && !process.argv.includes("--smoke-test") &&
          ["darwin", "win32"].includes(process.platform)) {
        return await requestMain("login", settings.enabled);
      }
      return "app-must-stay-open";
    } });
  await dailyBuild.start();
  if (process.env.TB_DESKTOP_TEST !== "1") {
    const { createDependencyUpdateService } = await import("../commands/graph/dependency-update.mjs");
    dependencyUpdate = createDependencyUpdateService({ geckoSource: path.dirname(commPath), commSource: commPath });
    dependencyUpdate.start();
  }
  const token = randomUUID();
  let consoleHtml;
  const graphCommand = createGraphCommand({ cwd: commPath, forceInteractive: true, appConfig,
    makeToken: () => token, waitForClose: async () => "",
    startServer: async options => {
      consoleHtml = options.html;
      consoleServer = await startInteractiveGraphServer({ ...options, dailyBuild, dependencyUpdate,
        ...(process.env.TB_DESKTOP_TEST === "1" ? { implementationManager: null, tryMonitor: null,
          patchSessionDirectory: path.join(userData, "patch-sessions") } : {}) });
      return consoleServer;
    } });
  await graphCommand({ open: false, port: 0, closeTabs: false });
  mobileGateway = createMobileGateway({ targetUrl: consoleServer.url, desktopToken: token,
    html: consoleHtml, stateFile: path.join(userData, "mobile-sessions.json") });
  mobileAddress = await mobileGateway.start();
  remoteAccess = createRemoteAccessService({ gatewayUrl: mobileAddress.url,
    stateFile: path.join(userData, "remote-access.json") });
  await remoteAccess.start();
  return { url: consoleServer.url, mobileAddress, token, pid: process.pid, runtime };
}
process.on("message", async message => {
  if (message.mainReply) {
    const pending = requests.get(message.mainReply);
    requests.delete(message.mainReply);
    if (message.error) pending?.reject(new Error(message.error));
    else pending?.resolve(message.value);
    return;
  }
  if (!message.id) return;
  try {
    let value;
    switch (message.action) {
      case "start": value = await start(message.value); break;
      case "status": value = remoteAccess.status(); break;
      case "enable": value = await remoteAccess.enable(); break;
      case "disable": value = await remoteAccess.disable(); break;
      case "pair": value = mobileGateway.issuePairCode(); break;
      case "revoke": value = await mobileGateway.revokeAll(); break;
      case "stop":
        await dependencyUpdate?.stop();
        await dailyBuild?.stop();
        await mobileGateway?.close();
        consoleServer?.server.shutdown?.(0, "desktop app quit");
        break;
      default: throw new Error("Unknown desktop service request.");
    }
    process.send({ id: message.id, value }, () => {
      if (message.action === "stop") process.exit(0);
    });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
process.on("disconnect", () => process.exit(0));
