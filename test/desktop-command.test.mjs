import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import branding from "../desktop/branding.cjs";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopCommand } from "../commands/desktop.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const child = new EventEmitter(); child.pid = 123; child.unref = () => calls.push("unref");
  const launch = createDesktopCommand({ cwd: "/firefox/comm", projectRoot: "/commands",
    config: {}, exists: () => true, getElectron: () => "/electron",
    prepareRuntime: async ({ projectRoot, electronExecutable }) => ({ executable: electronExecutable, args: [projectRoot] }),
    env: { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" }, log: () => {},
    openLogs: () => ({ stdio: "ignore", close() {} }),
    spawnApp: (...args) => { calls.push(args); queueMicrotask(() => child.emit("spawn")); return child; },
    ...overrides,
  });
  return { launch, calls };
}

test("desktop starts separately, uses the current checkout, and removes Node mode", async () => {
  const { launch, calls } = fixture();
  assert.deepEqual(await launch(), { pid: 123, project: "/commands", comm: "/firefox/comm" });
  assert.deepEqual(calls, [["/electron", ["/commands", "--comm=/firefox/comm"], {
    cwd: "/commands", env: { PATH: "/bin" }, detached: true, stdio: "ignore",
  }], "unref"]);
});

test("desktop accepts explicit paths and uses the configured project", async () => {
  const { launch, calls } = fixture({ config: { desktop: { projectDirectory: "/desktop commands" } } });
  await launch({ comm: "../other comm" });
  assert.deepEqual(calls[0][1], ["/desktop commands", "--comm=/firefox/other comm"]);
  assert.equal((await launch({ project: "/override" })).project, "/override");
});

test("desktop captures native output and closes the parent log handle", async () => {
  let closed = false;
  const { launch, calls } = fixture({ openLogs: () => ({ stdio: ["ignore", 42, 42], close: () => { closed = true; } }) });
  await launch();
  assert.deepEqual(calls[0][2].stdio, ["ignore", 42, 42]);
  assert.equal(closed, true);
});

test("desktop leaves checkout selection to the app outside a comm checkout", async () => {
  const { launch, calls } = fixture({ cwd: "/elsewhere", exists: file => file === "/commands/desktop/main.cjs" });
  await launch();
  assert.deepEqual(calls[0][1], ["/commands"]);
  await assert.rejects(launch({ comm: "/missing" }), /Not a Thunderbird comm checkout/);
});

test("desktop reports missing source, missing Electron, and process launch errors", async () => {
  await assert.rejects(fixture({ exists: () => false }).launch(), /Desktop app source not found/);
  await assert.rejects(fixture({ getElectron: () => { throw new Error("missing"); } }).launch(), /Electron is not installed/);
  const { launch } = fixture({ spawnApp: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("cannot spawn")));
    return child;
  } });
  await assert.rejects(launch(), /cannot spawn/);
});

test("tb desktop dispatches outside comm and passes paths without shell expansion", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-desktop-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "commands with spaces");
  await mkdir(path.join(project, "desktop"), { recursive: true });
  await mkdir(path.join(project, "node_modules", "electron"), { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ main: "desktop/main.cjs" }));
  const output = path.join(root, "result.json");
  await writeFile(path.join(project, "desktop", "main.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  await writeFile(path.join(project, "node_modules", "electron", "index.js"), `module.exports = ${JSON.stringify(process.execPath)};`);
  const run = promisify(execFile);
  const help = await run(process.execPath, [path.resolve(import.meta.dirname, "..", "tb.mjs"), "help"], { cwd: root });
  assert.match(help.stdout, /Starts Thunderbird Development Dashboard/);
  await writeFile(path.join(project, "node_modules", "electron", "package.json"), JSON.stringify({ version: "44.5.1", main: "index.js" }));
  const cache = path.join(root, "runtime-cache");
  const key = createHash("sha256").update(JSON.stringify([project, "44.5.1", process.platform, process.arch, branding.APP_NAME, 5, process.version])).digest("hex").slice(0, 20);
  const executable = branding.packagedExecutable(path.join(cache, key));
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const { stdout } = await run(process.execPath, [path.resolve(import.meta.dirname, "..", "tb.mjs"), "desktop", "--project", project], { cwd: root, env: { ...process.env, TB_DESKTOP_RUNTIME_CACHE: cache } });
  assert.match(stdout, /Thunderbird Development Dashboard started/);
  let result;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { result = JSON.parse(await readFile(output, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.deepEqual(result, []);
});
