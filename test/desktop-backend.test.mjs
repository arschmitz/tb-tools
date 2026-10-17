import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopBackend } from "../desktop/backend-client.cjs";

test("backend work runs outside the parent and rejects pending requests when it exits", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.cjs");
  await writeFile(entry, `process.on("message", message => {
    if (message.action === "crash") process.exit(7);
    if (message.action === "busy") {
      process.send({ id: message.id, value: process.pid });
      const end = Date.now() + 300;
      while (Date.now() < end) {}
    } else process.send({ id: message.id, value: process.pid });
  });`);
  let exitCode;
  const backend = createDesktopBackend({ entry, onExit: code => { exitCode = code; } });
  t.after(() => backend.stop());
  const pid = await backend.call("busy");
  assert.notEqual(pid, process.pid);
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(Date.now() - started < 200, "the parent timer must run while the backend is busy");
  await assert.rejects(backend.call("crash"), /service exited/);
  assert.equal(exitCode, 7);
  await assert.rejects(backend.call("status"), /disconnected/);
});

test("backend uses standalone Node with an 8 GB heap and clears inherited Node flags", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-heap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "worker.cjs");
  await writeFile(entry, `process.on("message", message => process.send({ id: message.id, value: {
    executable: process.execPath, electron: process.versions.electron,
    heap: require("node:v8").getHeapStatistics().heap_size_limit,
    options: process.env.NODE_OPTIONS, electronNode: process.env.ELECTRON_RUN_AS_NODE,
  } }));`);
  const previous = { options: process.env.NODE_OPTIONS, electron: process.env.ELECTRON_RUN_AS_NODE };
  let backend;
  try {
    process.env.NODE_OPTIONS = "--max-old-space-size=256";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    backend = createDesktopBackend({ entry, nodeExecutable: process.execPath });
  } finally {
    if (previous.options === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous.options;
    if (previous.electron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous.electron;
  }
  t.after(() => backend.stop());
  const runtime = await backend.call("runtime");
  assert.equal(runtime.executable, process.execPath);
  assert.equal(runtime.electron, undefined);
  assert.equal(runtime.options, undefined);
  assert.equal(runtime.electronNode, undefined);
  assert.ok(runtime.heap >= 8192 * 1024 * 1024);
});

test("invalid backend heap settings fail before launching a child", () => {
  for (const heapMb of [NaN, 0, 1.5, 65537]) {
    assert.throws(() => createDesktopBackend({ heapMb }), /TB_DESKTOP_HEAP_MB/);
  }
});
