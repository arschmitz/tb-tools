import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import branding from "./branding.cjs";

const comm = process.argv[2] || process.env.TB_COMM_PATH;
if (!comm) throw new Error("Pass the Thunderbird comm checkout path.");
const executable = process.env.TB_DESKTOP_EXECUTABLE || branding.packagedExecutable(path.resolve("dist",
  `${branding.APP_NAME}-${process.platform}-${process.arch}`));
const data = await mkdtemp(path.join(os.tmpdir(), "tb-backend-smoke-"));
try {
  const env = { ...process.env, TB_DESKTOP_TEST: "1", TB_DESKTOP_TEST_USER_DATA: data };
  delete env.TB_DESKTOP_NODE_EXECUTABLE;
  delete env.TB_DESKTOP_HEAP_MB;
  const { stdout } = await promisify(execFile)(executable, [`--comm=${comm}`, "--smoke-test"],
    { env, timeout: 120000, maxBuffer: 1024 * 1024 });
  const report = stdout.split("\n").filter(line => line.startsWith('{"ok":')).map(line => JSON.parse(line)).at(-1);
  assert.ok(report?.ok);
  assert.notEqual(report.mainPid, report.backendPid);
  assert.ok(report.runtime.executable.includes(`${path.sep}node-runtime${path.sep}`));
  assert.ok(report.runtime.heapLimitMb >= 8192);
  console.log(`Packaged backend and console APIs passed with bundled ${report.runtime.node}, heap limit ${report.runtime.heapLimitMb} MB.`);
} finally { await rm(data, { recursive: true, force: true }); }
