import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { connect, verifyWindow, launchAndVerify } from "../desktop/setup-launch-check.cjs";

function profile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tb-launch-check-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function protocolServer(t, respond) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const send = value => {
      const body = Buffer.from(JSON.stringify(value));
      const message = Buffer.concat([Buffer.from(`${body.length}:`), body]);
      socket.write(message.subarray(0, 2));
      setImmediate(() => socket.write(message.subarray(2)));
    };
    send({ applicationType: "gecko", marionetteProtocol: 3 });
    let buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      const colon = buffer.indexOf(58);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) return;
      const [, id, name, args] = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
      buffer = buffer.subarray(colon + 1 + length);
      send([1, id, null, respond(name, args)]);
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("Marionette framing handles fragmented responses and verifies a Thunderbird chrome window", async t => {
  const directory = profile(t);
  const calls = [];
  const port = await protocolServer(t, name => {
    calls.push(name);
    if (name === "WebDriver:NewSession") return { capabilities: { "moz:profile": directory } };
    if (name === "WebDriver:GetWindowHandles") return ["main"];
    if (name === "WebDriver:ExecuteScript") return { value: { ready: "complete", url: "chrome://messenger/content/messenger.xhtml?test=é" } };
    return { value: null };
  });
  const client = await connect(port);
  t.after(() => client.close());
  await verifyWindow(client, directory);
  assert.ok(calls.includes("Marionette:SetContext"), "Verification should inspect the privileged Thunderbird window.");
  assert.equal(calls.at(-1), "WebDriver:DeleteSession", "Successful verification should release its automation session.");
});

test("a Gecko handshake alone cannot verify Firefox or a personal Thunderbird profile", async t => {
  const directory = profile(t);
  let wrongProfile = true;
  let url = "chrome://browser/content/browser.xhtml";
  const commands = [];
  const client = { command: async name => {
    commands.push(name);
    if (name === "WebDriver:NewSession") return { capabilities: { "moz:profile": wrongProfile ? os.tmpdir() : directory } };
    if (name === "WebDriver:GetWindowHandles") return ["main"];
    if (name === "WebDriver:ExecuteScript") return { value: { ready: "complete", url } };
  } };
  await assert.rejects(verifyWindow(client, directory), /separate development profile/, "The check should reject another profile before inspecting its windows.");
  assert.deepEqual(commands, ["WebDriver:NewSession"], "A personal profile should not receive window scripts.");
  wrongProfile = false;
  await assert.rejects(verifyWindow(client, directory), /main window/, "A Firefox window should not complete Thunderbird setup.");
  url = "chrome://messenger/content/systemIntegrationDialog.xhtml";
  await assert.rejects(verifyWindow(client, directory), /main window/, "A Thunderbird dialog should not count as its main window.");
});

test("a process that exits before opening its window leaves launch verification incomplete", async t => {
  const directory = profile(t);
  await assert.rejects(launchAndVerify({ directory, executable: process.execPath, args: ["-e", "process.exit(8)", "--"], timeout: 3000 }), /Could not verify/, "An early process exit should fail the launch check.");
  const profiles = fs.readdirSync(directory);
  assert.equal(profiles.length, 1, "The failed launch should keep only its own profile for diagnosis.");
  const preferences = fs.readFileSync(path.join(directory, profiles[0], "user.js"), "utf8");
  assert.match(preferences, /marionette.port/, "The separate profile should own its automation port.");
});
