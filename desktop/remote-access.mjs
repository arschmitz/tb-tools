import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../lib/utils.mjs";

const HTTPS_PORT = 8443;

async function findTailscale() {
  const names = process.platform === "darwin"
    ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale"]
    : process.platform === "win32"
      ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe")]
      : ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
  for (const name of names) {
    try { await access(name); return name; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return "tailscale";
}

export function createRemoteAccessService({ gatewayUrl, stateFile = path.join(os.homedir(),
  ".tb-tools", "remote-access.json"), runCommand = run, executable = "", port = HTTPS_PORT } = {}) {
  if (!gatewayUrl) throw new Error("Remote access needs a running phone gateway.");
  let enabled = false;
  let address = "";
  let error = "";
  let previousGateway = "";

  async function tailscale(args) {
    const cmd = executable || await findTailscale();
    return String(await runCommand({ cmd, args, capture: true, silent: true,
      timeoutMs: 30_000, env: { PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin` } })).trim();
  }

  async function save() {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ enabled, gatewayUrl: enabled ? gatewayUrl : "" }), { mode: 0o600 });
  }

  async function assertServePortAvailable() {
    const config = JSON.parse(await tailscale(["serve", "status", "--json"])) || {};
    const onPort = host => new RegExp(`:${port}/?$`).test(host);
    if (Object.entries(config.AllowFunnel || {}).some(([host, allowed]) => onPort(host) && allowed) ||
        Object.values(config.Foreground || {}).some(entry =>
          entry.TCP?.[port] || Object.keys(entry.Web || {}).some(onPort) ||
          Object.entries(entry.AllowFunnel || {}).some(([host, allowed]) => onPort(host) && allowed))) {
      throw new Error(`Tailscale port ${port} is already used by another service.`);
    }
    const entries = Object.entries(config.Web || {}).filter(([host]) =>
      onPort(host));
    const portIsUsed = Boolean(config.TCP?.[port] || entries.length);
    if (!portIsUsed) return;
    const ownedTargets = new Set([gatewayUrl, previousGateway].filter(Boolean));
    const owned = entries.length > 0 && entries.every(([, web]) => {
      const handlers = Object.entries(web.Handlers || {});
      return handlers.length === 1 && handlers[0][0] === "/" &&
        ownedTargets.has(handlers[0][1]?.Proxy);
    });
    if (!owned) throw new Error(`Tailscale Serve port ${port} is already used by another service.`);
  }

  async function apply() {
    const status = JSON.parse(await tailscale(["status", "--json"]));
    if (status.BackendState !== "Running" || !status.Self?.DNSName) {
      throw new Error("Sign in to Tailscale on this Mac before enabling phone access.");
    }
    await assertServePortAvailable();
    await tailscale(["serve", "--bg", "--yes", `--https=${port}`, gatewayUrl]);
    address = `https://${status.Self.DNSName.replace(/\.$/, "")}:${port}/`;
    previousGateway = gatewayUrl;
    error = "";
    return address;
  }

  return {
    async start() {
      try {
        const saved = JSON.parse(await readFile(stateFile, "utf8"));
        enabled = saved.enabled === true;
        previousGateway = saved.gatewayUrl || "";
      }
      catch (cause) { if (cause.code !== "ENOENT") throw cause; }
      if (enabled) {
        try { await apply(); }
        catch (cause) { error = cause.message; }
      }
      return this.status();
    },
    async enable() {
      await apply();
      enabled = true;
      await save();
      return this.status();
    },
    async disable() {
      if (enabled) {
        await assertServePortAvailable();
        await tailscale(["serve", `--https=${port}`, "off"]);
      }
      enabled = false;
      address = "";
      error = "";
      previousGateway = "";
      await save();
      return this.status();
    },
    status() { return { enabled, address, error, localGateway: gatewayUrl }; },
  };
}
