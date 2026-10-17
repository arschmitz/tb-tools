import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import executablePath from "electron";
/* global document, window */

async function setupEnvironment(directory) {
  const mozillaBuild = path.join(directory, "mozilla-build");
  await mkdir(mozillaBuild);
  await writeFile(path.join(mozillaBuild, "start-shell.bat"), "@echo off\r\nexit /b 99\r\n");
  const env = { ...process.env, MOZILLABUILD: mozillaBuild };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

test("first-run window guides setup and saves an existing checkout through the sandbox bridge", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tb-setup-ui-")));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const source = path.join(directory, "source");
  await mkdir(path.join(source, "comm", ".git"), { recursive: true });
  await mkdir(path.join(source, "comm", "mail", "config"), { recursive: true });
  await writeFile(path.join(source, "comm", "mail", "config", "version.txt"), "1");
  await writeFile(path.join(source, "mach"), "");
  const setup = path.resolve("desktop/setup.cjs");
  const entry = path.join(directory, "main.cjs");
  const configFile = path.join(directory, "settings.json");
  await writeFile(configFile, JSON.stringify({ lando: { repo: "keep-this-repository" } }));
  await writeFile(entry, `const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron');
    app.setPath('userData', ${JSON.stringify(directory)});
    shell.openExternal = async url => { globalThis.openedUrl = url; };
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[${JSON.stringify(source)}]});
    app.whenReady().then(async () => {
      const result = await require(${JSON.stringify(setup)}).chooseCheckout({app,BrowserWindow,dialog,ipcMain,shell,
        checkTools:()=>({checks:[{label:'Git and Python',ready:true}],ready:true}), readIdentity:()=>({name:'Setup Test',email:'test@example.invalid'}),
        nodeExecutable:() => ${JSON.stringify(process.execPath)},env:{},configFile:${JSON.stringify(configFile)},
        launchSetup:async()=>require(${JSON.stringify(path.resolve("desktop/setup-store.cjs"))}).writeJson(${JSON.stringify(path.join(directory,"setup.json"))},{destination:${JSON.stringify(source)},mode:'full',status:'complete',environmentVerified:true,step:'Window verified'})});
      globalThis.chosen = result;
    });
    app.on('window-all-closed', () => {});`);
  const env = await setupEnvironment(directory);
  application = await electron.launch({ executablePath, args: [entry], env });
  const page = await application.firstWindow();
  if (process.env.TB_SETUP_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TB_SETUP_SCREENSHOTS, "welcome.png") });
  await page.locator("#new").click();
  assert.equal(await page.locator("#configure").isVisible(), true, "New setup should show folder and build choices.");
  assert.equal(await page.locator("#start").isDisabled(), true, "Setup should require a folder before starting.");
  await page.locator("#folder").click();
  await page.waitForFunction(() => !document.getElementById("start").disabled);
  assert.equal(await page.locator("#destination").textContent(), path.join(source, "thunderbird"), "The setup preview should show the new folder.");
  if (process.env.TB_SETUP_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TB_SETUP_SCREENSHOTS, "configure.png") });
  const security = await application.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation };
  });
  assert.deepEqual(security, { sandbox: true, nodeIntegration: false, contextIsolation: true }, "The setup page should use a sandboxed renderer.");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined", "The setup page should not expose Node.js.");
  await page.locator("#back").click();
  await page.locator("#existing").click();
  await page.locator("#start").click();
  await page.locator("#finish").waitFor({ state: "visible" });
  await page.locator("#finish").click();
  await page.locator("#credentials").waitFor({ state: "visible" });
  assert.equal(await page.locator("#phabricator-token").getAttribute("type"), "password", "The Phabricator token should be masked.");
  assert.equal(await page.locator("#bugzilla-key").getAttribute("type"), "password", "The Bugzilla key should be masked.");
  await page.locator("#phabricator-user").fill("setup-test-user");
  await page.locator("#phabricator-token").fill("api-setup-test-token");
  await page.locator("#bugzilla-key").fill("setup-test-bugzilla-key");
  await page.locator("#phabricator-settings").click();
  assert.equal(await page.locator("#credentials").isVisible(), true, "Opening service settings should keep the credentials step visible.");
  assert.equal(await page.locator("#phabricator-token").inputValue(), "api-setup-test-token", "Opening service settings should preserve the entered token.");
  assert.equal(await application.evaluate(() => globalThis.openedUrl), "https://phabricator.services.mozilla.com/settings/",
    "The service link should open the fixed settings page without sending credentials.");
  if (process.env.TB_SETUP_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TB_SETUP_SCREENSHOTS, "credentials.png") });
  await page.locator("#save-credentials").click();
  await page.locator("#submission").waitFor({ state: "visible" });
  if (process.env.TB_SETUP_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TB_SETUP_SCREENSHOTS, "submission.png") });
  await page.locator("#open-dashboard").click();
  await application.evaluate(async () => {
    while (!globalThis.chosen) await new Promise(resolve => setTimeout(resolve, 10));
  });
  const saved = JSON.parse(await readFile(path.join(directory, "checkout.json"), "utf8"));
  assert.equal(saved.commPath, path.join(source, "comm"), "The existing checkout should be saved as an absolute comm path.");
  assert.equal(saved.credentialsSetupComplete, true, "Saving keys should complete setup for this checkout.");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.phabricator.user, "setup-test-user", "The existing checkout path should save the Phabricator username.");
  assert.equal(config.phabricator.token, "api-setup-test-token", "The existing checkout path should save the Phabricator token.");
  assert.equal(config.bugzilla.apiKey, "setup-test-bugzilla-key", "The existing checkout path should save the Bugzilla key.");
  assert.equal(config.lando.repo, "keep-this-repository", "Saving keys should preserve unrelated settings.");
});

test("new setup shows bootstrap failure, retries, and opens only the completed checkout", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tb-setup-flow-")));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const setup = path.resolve("desktop/setup.cjs");
  const store = path.resolve("desktop/setup-store.cjs");
  const entry = path.join(directory, "main.cjs");
  await writeFile(entry, `const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron');
    const fs = require('node:fs'); const path = require('node:path');
    const {readJson,writeJson} = require(${JSON.stringify(store)});
    app.setPath('userData', ${JSON.stringify(directory)});
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[${JSON.stringify(directory)}]});
    let attempts = 0;
    app.whenReady().then(async () => {
      globalThis.chosen = await require(${JSON.stringify(setup)}).chooseCheckout({app,BrowserWindow,dialog,ipcMain,shell,
        checkTools:()=>({checks:[{label:'Git and Python',ready:true}],ready:true}), readIdentity:()=>({name:'Setup Test',email:'test@example.invalid'}),
        nodeExecutable:() => ${JSON.stringify(process.execPath)},env:{},configFile:${JSON.stringify(path.join(directory, "settings.json"))}, launchSetup:async () => {
          const file = path.join(${JSON.stringify(directory)},'setup.json');
          const state = readJson(file); attempts++;
          if (state.task === 'submission') { writeJson(file,{...state,status:'failed',error:'Authentication failed in test',pid:null}); return; }
          if (attempts === 1) {
            writeJson(file,{...state,status:'failed',error:'Bootstrap failed in the test terminal',pid:null});
            writeJson(file+'.lock',{pid:2147483647}); return;
          }
          fs.mkdirSync(path.join(state.destination,'comm','.git'),{recursive:true});
          fs.mkdirSync(path.join(state.destination,'comm','mail','config'),{recursive:true});
          fs.writeFileSync(path.join(state.destination,'comm','mail','config','version.txt'),'1');
          fs.writeFileSync(path.join(state.destination,'mach'),'');
          writeJson(file,{...state,status:'complete',environmentVerified:true,step:'Window verified',error:'',pid:null});
        }});
    });
    app.on('window-all-closed', () => {});`);
  const env = await setupEnvironment(directory);
  application = await electron.launch({ executablePath, args: [entry], env });
  const page = await application.firstWindow();
  await page.locator("#new").click();
  await page.locator("#folder").click();
  await page.waitForFunction(() => !document.getElementById("start").disabled);
  await page.locator("#start").click();
  await page.locator("#retry").waitFor({ state: "visible" });
  assert.match(await page.locator("#setup-error").textContent(), /Bootstrap failed/, "A failed bootstrap should show its error.");
  assert.equal(await page.locator("#finish").isHidden(), true, "A failed setup should not offer to open the dashboard.");
  assert.equal(await readFile(path.join(directory, "checkout.json"), "utf8").catch(() => "missing"), "missing",
    "An incomplete setup should not become the saved checkout.");
  await page.locator("#retry").click();
  await page.locator("#finish").waitFor({ state: "visible" });
  assert.equal(await page.locator("#progress-title").textContent(), "Your environment is ready", "A successful retry should show the ready screen.");
  if (process.env.TB_SETUP_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TB_SETUP_SCREENSHOTS, "complete.png") });
  await page.locator("#finish").click();
  await page.locator("#credentials").waitFor({ state: "visible" });
  await page.locator("#skip-credentials").click();
  await page.locator("#submission").waitFor({ state: "visible" });
  await page.locator("#submission-start").click();
  await page.locator("#defer-submission").waitFor({ state: "visible" });
  assert.match(await page.locator("#setup-error").textContent(), /Authentication failed/, "An optional authentication failure should show its error.");
  await page.locator("#defer-submission").click();
  await application.evaluate(async () => {
    while (!globalThis.chosen) await new Promise(resolve => setTimeout(resolve, 10));
  });
  const saved = JSON.parse(await readFile(path.join(directory, "checkout.json"), "utf8"));
  assert.equal(saved.commPath, path.join(directory, "thunderbird", "comm"), "A completed setup should save the paired comm path.");
  assert.equal(saved.credentialsSetupComplete, true, "Skipping keys should complete setup for the new checkout.");
  assert.equal(await readFile(path.join(directory, "settings.json"), "utf8").catch(() => "missing"), "missing",
    "Skipping keys should not create or change the settings file.");
});

test("reopening an explicit checkout restores completed build progress and the optional submission step", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "tb-setup-restore-")));
  let application;
  t.after(async () => {
    await application?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const source = path.join(directory, "source");
  await mkdir(path.join(source, "comm", ".git"), { recursive: true });
  await mkdir(path.join(source, "comm", "mail", "config"), { recursive: true });
  await writeFile(path.join(source, "comm", "mail", "config", "version.txt"), "1");
  await writeFile(path.join(source, "mach"), "");
  await writeFile(path.join(directory, "setup.json"), JSON.stringify({ destination: source, mode: "full", existing: true, status: "complete", environmentVerified: true, step: "Thunderbird window verified" }));
  const entry = path.join(directory, "main.cjs");
  await writeFile(entry, `const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron');
    app.setPath('userData', ${JSON.stringify(directory)});
    app.whenReady().then(async()=>{globalThis.chosen=await require(${JSON.stringify(path.resolve("desktop/setup.cjs"))}).chooseCheckout({app,BrowserWindow,dialog,ipcMain,shell,option:${JSON.stringify(source)},env:{},configFile:${JSON.stringify(path.join(directory, "settings.json"))},nodeExecutable:()=>${JSON.stringify(process.execPath)}});});
    app.on('window-all-closed',()=>{});`);
  const env = await setupEnvironment(directory);
  application = await electron.launch({ executablePath, args: [entry], env });
  let page = await application.firstWindow();
  await page.locator("#finish").waitFor({ state: "visible" });
  assert.equal(await page.locator("#configure").isHidden(), true, "Reopening a completed build should restore progress instead of starting over.");
  await page.locator("#finish").click();
  await page.locator("#credentials").waitFor({ state: "visible" });
  await page.locator("#skip-credentials").click();
  await page.locator("#submission").waitFor({ state: "visible" });
  await application.close();
  application = await electron.launch({ executablePath, args: [entry], env });
  page = await application.firstWindow();
  await page.locator("#submission").waitFor({ state: "visible" });
  assert.equal(await page.locator("#credentials").isHidden(), true, "Restarting after skipped credentials should restore optional submission setup.");
  await page.locator("#open-dashboard").click();
  const saved = JSON.parse(await readFile(path.join(directory, "checkout.json"), "utf8"));
  assert.equal(saved.credentialsSetupComplete, true, "Opening the dashboard after restart should finish onboarding.");
});
