const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { toolEnvironment } = require("./setup-environment.cjs");

function connect(port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let bytes = Buffer.alloc(0);
    let id = 0;
    const messages = [];
    const waiting = [];
    let failure;
    const fail = error => {
      failure = error;
      for (const waiter of waiting.splice(0)) waiter.reject(error);
      reject(error);
      socket.destroy();
    };
    socket.setTimeout(timeout, () => fail(new Error("Thunderbird stopped responding during its window check.")));
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Thunderbird closed during its window check.")));
    const next = () => failure ? Promise.reject(failure) : messages.length ? Promise.resolve(messages.shift()) : new Promise((yes, no) => waiting.push({ resolve: yes, reject: no }));
    socket.on("data", data => {
      bytes = Buffer.concat([bytes, data]);
      try {
        while (bytes.length) {
          const colon = bytes.indexOf(58);
          if (colon < 0) { if (bytes.length > 10) throw new Error("Invalid Marionette frame."); break; }
          const header = bytes.subarray(0, colon).toString("ascii");
          if (!/^\d+$/.test(header)) throw new Error("Invalid Marionette frame.");
          const length = Number(header);
          if (!length || length > 1024 * 1024) throw new Error("Invalid Marionette frame size.");
          if (bytes.length < colon + 1 + length) break;
          const message = JSON.parse(bytes.subarray(colon + 1, colon + 1 + length).toString("utf8"));
          bytes = bytes.subarray(colon + 1 + length);
          const waiter = waiting.shift();
          if (waiter) waiter.resolve(message); else messages.push(message);
        }
      } catch (error) { fail(error); }
    });
    void (async () => {
      const hello = await next();
      if (hello.applicationType !== "gecko" || hello.marionetteProtocol !== 3) throw new Error("Unsupported Thunderbird automation protocol.");
      resolve({
        async command(name, args = {}) {
          const requestId = ++id;
          const body = JSON.stringify([0, requestId, name, args]);
          socket.write(`${Buffer.byteLength(body)}:${body}`);
          const response = await next();
          if (!Array.isArray(response) || response[0] !== 1 || response[1] !== requestId) throw new Error("Unexpected Thunderbird response.");
          if (response[2]) throw new Error(response[2].message || "Thunderbird window check failed.");
          return response[3];
        },
        close() { socket.destroy(); },
      });
    })().catch(fail);
  });
}

async function verifyWindow(client, profile) {
  const session = await client.command("WebDriver:NewSession");
  const capabilities = session.capabilities;
  if (!capabilities || !capabilities["moz:profile"] || fs.realpathSync(capabilities["moz:profile"]) !== fs.realpathSync(profile)) {
    throw new Error("Thunderbird did not use the separate development profile.");
  }
  await client.command("Marionette:SetContext", { value: "chrome" });
  const handles = await client.command("WebDriver:GetWindowHandles");
  for (const handle of handles) {
    await client.command("WebDriver:SwitchToWindow", { handle });
    const result = await client.command("WebDriver:ExecuteScript", { script: "return {ready:document.readyState,url:window.location.href};", args: [], newSandbox: true, sandbox: "default" });
    const value = result.value;
    if (value?.ready === "complete" && /^chrome:\/\/messenger\/content\/messenger\.xhtml(?:[?#]|$)/.test(value.url)) {
      await client.command("WebDriver:DeleteSession");
      return;
    }
  }
  throw new Error("Thunderbird has not opened its main window yet.");
}

async function launchAndVerify({ directory, executable, args, cwd = directory, timeout = 120000, spawnProcess = spawn }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const profile = fs.mkdtempSync(path.join(directory, "development-profile-"));
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(profile, "user.js"), `user_pref("marionette.port", ${port});\nuser_pref("mail.shell.checkDefaultClient", false);\n`, { mode: 0o600 });
  const log = fs.openSync(path.join(profile, "launch.log"), "a", 0o600);
  let child;
  let client;
  let exited = false;
  let launchError;
  try {
    child = spawnProcess(executable, [...args, "-no-remote", "-profile", profile, "-marionette", "--remote-allow-system-access"],
      { detached: process.platform !== "win32", stdio: ["ignore", log, log], env: { ...toolEnvironment(), MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" }, cwd });
    child.once("error", error => { launchError = error; });
    child.once("exit", () => { exited = true; });
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline && !exited && !launchError) {
      try {
        client = await connect(port, Math.min(10000, Math.max(100, deadline - Date.now())));
        await verifyWindow(client, profile);
        client.close();
        child.unref();
        return { profile, pid: child.pid };
      } catch (error) {
        lastError = error;
        if (client) {
          await client.command("WebDriver:DeleteSession").catch(() => {});
          client.close();
          client = null;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw launchError || new Error(`Could not verify the Thunderbird window. ${lastError?.message || "The development process exited."} See ${path.join(profile, "launch.log")}`);
  } catch (error) {
    // This process was started with our own profile; never stop another Thunderbird instance.
    if (child?.pid && !exited) {
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* The development process may have already exited. */ }
    }
    throw error;
  } finally { client?.close(); fs.closeSync(log); }
}

if (require.main === module) {
  const [directory, cwd, python] = process.argv.slice(2);
  // Run Mach from the source root, while keeping profiles outside the source checkout.
  launchAndVerify({ directory, cwd, executable: python, args: [path.join(cwd, "mach"), "run", "--"] })
    .then(result => console.log(`Thunderbird window verified. Development profile: ${result.profile}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { connect, verifyWindow, launchAndVerify };
