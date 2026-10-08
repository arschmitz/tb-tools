import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import electronExecutable from "electron";

test("desktop Back and Forward navigate the active native browser view", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-native-history-"));
  const source = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const state = source.slice(source.indexOf("function browserState()"), source.indexOf("function sendBrowserState()"));
  const action = source.slice(source.indexOf("function handleBrowserAction("), source.indexOf('ipcMain.on("commands-browser-action"'));
  const script = path.join(directory, "main.cjs");
  const site = createServer((request, response) => response.end(`<title>${request.url}</title><p>Page</p>`));
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${site.address().port}`;
    await writeFile(script, `const {app, BrowserWindow, WebContentsView} = require('electron');
      const vm = require('node:vm');
      app.setPath('userData', ${JSON.stringify(directory)});
      app.whenReady().then(async () => {
        try {
          const window = new BrowserWindow({show:false});
          const view = new WebContentsView(); window.contentView.addChildView(view);
          const sender = {};
          const context = vm.createContext({browserTabs:new Map([['page',{id:'page',title:'Test',url:'',view}]]),
            activeTabId:'page',activeView:view,consoleView:{webContents:sender}});
          vm.runInContext(${JSON.stringify(state + action)},context);
          await view.webContents.loadURL(${JSON.stringify(base + "/first")});
          await view.webContents.loadURL(${JSON.stringify(base + "/second")});
          const navigate = async action => {
            const completed = new Promise(resolve => view.webContents.once('did-finish-load', resolve));
            context.handleBrowserAction({sender}, {action});
            await completed;
            return {url:view.webContents.getURL(),state:context.browserState()};
          };
          const back = await navigate('back');
          const forward = await navigate('forward');
          console.log(JSON.stringify({back,forward}));
          view.webContents.close(); window.destroy(); app.exit(0);
        } catch (error) { console.error(error); app.exit(1); }
      });`);
    const environment = {...process.env};
    delete environment.ELECTRON_RUN_AS_NODE;
    const {stdout} = await promisify(execFile)(electronExecutable, [script], {env:environment, timeout:20000});
    const {back,forward} = JSON.parse(stdout.trim());
    assert.equal(back.url, base + "/first");
    assert.equal(back.state.canGoForward, true);
    assert.equal(forward.url, base + "/second");
    assert.equal(forward.state.canGoBack, true);
    assert.equal(forward.state.canGoForward, false);
  } finally {
    await new Promise(resolve => site.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
