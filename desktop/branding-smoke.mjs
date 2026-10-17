import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron } from "playwright";
import branding from "./branding.cjs";
import { prepareDesktopRuntime } from "./launch-runtime.mjs";

const comm = process.argv[2] || process.env.TB_COMM_PATH;
if (!comm) throw new Error("Pass the Thunderbird comm checkout path.");
const runtime = await prepareDesktopRuntime({ projectRoot: path.resolve(import.meta.dirname, "..") });
const data = await mkdtemp(path.join(os.tmpdir(), "tb-branding-check-"));
let application;
try {
  application = await _electron.launch({ executablePath: runtime.executable, args: [`--comm=${comm}`],
    env: { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: data }, timeout: 60000 });
  let identity;
  for (let attempt = 0; attempt < 300; attempt++) {
    identity = await application.evaluate(({ app, Menu, BrowserWindow }) => ({
      name: app.getName(), data: app.getPath("userData"),
      menus: Menu.getApplicationMenu()?.items.map(item => ({ label: item.label,
        children: item.submenu?.items.map(child => child.label) })),
      title: BrowserWindow.getAllWindows()[0]?.getTitle(),
      visible: BrowserWindow.getAllWindows().some(window => window.isVisible()),
    }));
    if (identity.title && identity.menus?.[0].children?.includes("Show Console")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(identity.name, branding.APP_NAME);
  assert.equal(identity.data, data);
  assert.equal(identity.menus[0].label, branding.APP_NAME);
  assert.equal(identity.title, branding.APP_NAME);
  assert.equal(identity.visible, false);
  if (process.platform === "darwin") {
    assert.ok(identity.menus[0].children.includes(`About ${branding.APP_NAME}`));
    assert.ok(identity.menus[0].children.includes(`Quit ${branding.APP_NAME}`));
    const plist = path.resolve(path.dirname(runtime.executable), "..", "Info.plist");
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      const { stdout } = await promisify(execFile)("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
      assert.equal(stdout.trim(), branding.APP_NAME);
    }
  }
  console.log("App name, native menu, About and Quit labels, window title, saved-data path, and bundle branding passed.");
} finally {
  await application?.close();
  await rm(data, { recursive: true, force: true });
}
