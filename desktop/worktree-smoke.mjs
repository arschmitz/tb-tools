import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { run } from "../lib/utils.mjs";
import { createTaskWorktreeManager } from "../commands/graph/task-worktrees.mjs";
import { executeConsoleArtifactBuild, getConsoleBuildEnvironment, prepareConsoleBuild } from "../commands/graph/build.mjs";

const source = process.argv[2] || process.env.TB_COMM_PATH;
if (!source) throw new Error("Pass the Thunderbird comm checkout path.");
const comm = path.resolve(source);
const graphs = [{ checkout: "working", repository: "comm", path: comm },
  { checkout: "working", repository: "firefox", path: path.dirname(comm) }];
const git = (cwd, args) => run({ cmd: "git", args, cwd, capture: true, silent: true });
const original = await Promise.all(graphs.map(async graph => ({
  head: await git(graph.path, ["rev-parse", "HEAD"]),
  status: await git(graph.path, ["status", "--porcelain", "--untracked-files=no"]),
  unmerged: await git(graph.path, ["ls-files", "-u"]),
})));
const manager = createTaskWorktreeManager({ graphs, runCommand: run });
const sessions = [];
for (let index = 0; index < 2; index++) {
  const session = manager.configure({ id: (index === 0 ? process.env.TB_WORKTREE_SMOKE_ID : process.env.TB_WORKTREE_SMOKE_SECOND_ID) || randomUUID() }, "build-smoke");
  sessions.push(session);
  console.log(`Preparing ${session.graph.path}`);
  await manager.prepare(session);
  const messages = [];
  const plan = await prepareConsoleBuild({ graph: session.graph, runCommand: run,
    log: text => { messages.push(text); process.stdout.write(text); } });
  assert.ok(plan, "This frontend validation needs an artifact build");
  if (index === 1) assert.ok(plan.donor, "The second worktree must reuse completed binaries");
  const started = Date.now();
  await executeConsoleArtifactBuild({ plan, execute: command => run({ ...command,
    env: { ...command.env, AUTOCLOBBER: "1", MOZ_HEADLESS: "1" },
    onStdout: text => process.stdout.write(text), onStderr: text => process.stderr.write(text) }) });
  const env = { ...await getConsoleBuildEnvironment(session.graph), MOZ_HEADLESS: "1" };
  await run({ cmd: "./mach", args: ["xpcshell-test", "comm/mailnews/base/test/unit/test_mailServices.js"],
    cwd: path.dirname(session.graph.path), env,
    onStdout: text => process.stdout.write(text), onStderr: text => process.stderr.write(text) });
  session.buildMilliseconds = Date.now() - started;
  session.donor = plan.donor;
  session.buildConfig = await readFile(plan.paths.config, "utf8");
}
for (let index = 0; index < graphs.length; index++) {
  assert.equal(await git(graphs[index].path, ["rev-parse", "HEAD"]), original[index].head);
  assert.equal(await git(graphs[index].path, ["status", "--porcelain", "--untracked-files=no"]), original[index].status);
  assert.equal(await git(graphs[index].path, ["ls-files", "-u"]), original[index].unmerged);
}
const report = sessions.map(session => ({ path: session.graph.path, donor: session.donor,
  buildMilliseconds: session.buildMilliseconds }));
await writeFile(path.join(os.tmpdir(), "commands-worktree-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, report }));
