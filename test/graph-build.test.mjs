import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeConsoleArtifactBuild, getConsoleBuildEnvironment, prepareConsoleBuild, publishCompletedConsoleBuild, supportsArtifactBuild } from "../commands/graph/build.mjs";
import { prepareTaskWorktreeBuild } from "../commands/graph/task-worktrees.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graphs = ["working", "review"].map((checkout) => ({
    path: path.join(root, checkout, "comm"), repository: "comm", checkout,
  }));
  for (const graph of graphs) {
    await mkdir(graph.path, { recursive: true });
    await writeFile(path.join(graph.path, "..", "mozconfig"),
      `ac_add_options --enable-project=comm/mail\nmk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-${graph.checkout}\n`);
  }
  const changes = new Map();
  const calls = [];
  const runCommand = async (command) => {
    calls.push(command);
    if (command.args[0] === "environment") return JSON.stringify({
      topobjdir: path.join(command.cwd, "obj-original"),
      mozconfig: { path: path.join(command.cwd, "mozconfig"), configure_args: ["--enable-project=comm/mail"],
        vars: { added: { _mozconfig_opt: `MOZ_OBJDIR=@TOPSRCDIR@/obj-${path.basename(command.cwd)}` } } },
    });
    if (command.args[0] === "merge-base") return "a".repeat(40);
    if (command.args[0] === "diff") return changes.get(command.cwd) || "";
    return "";
  };
  const cacheDirectory = path.join(root, "shared-build-cache");
  const prepare = (graph) => prepareConsoleBuild({ graph, graphs, runCommand, cacheDirectory });
  return { graphs, prepare, changes, calls, runCommand };
}

function executor(plan, calls) {
  return async (command) => {
    calls.push(command);
    assert.equal(command.cwd, plan.paths.root);
    assert.equal(command.env.MOZCONFIG, plan.paths.config);
    if (command.args[0] === "configure") {
      await mkdir(path.join(plan.paths.object, "faster"), { recursive: true });
      await writeFile(path.join(plan.paths.object, "faster", "Makefile"), "backend");
    }
    if (command.args[0] === "artifact") {
      const dist = command.args.at(-1);
      await mkdir(path.join(dist, "bin"), { recursive: true });
      await writeFile(path.join(dist, "bin", "binary"), "prebuilt");
    }
    return "";
  };
}

test("artifact mode accepts frontend changes and rejects native and build changes", () => {
  assert.equal(supportsArtifactBuild(["ui/file.mjs", "theme/style.css"]), true);
  for (const file of ["code.cpp", "code.rs", "interface.webidl", "moz.build", "Cargo.lock", "config.json"]) {
    assert.equal(supportsArtifactBuild([file]), false, file);
  }
});

test("artifact builds reuse the other checkout in both directions and use faster on repeat builds", async (t) => {
  for (const reverse of [false, true]) {
    const fixtureData = await fixture(t);
    const graphs = reverse ? fixtureData.graphs.toReversed() : fixtureData.graphs;
    const first = await fixtureData.prepare(graphs[0]);
    const firstCalls = [];
    await executeConsoleArtifactBuild({ plan: first, execute: executor(first, firstCalls) });
    assert.deepEqual(firstCalls.map((call) => call.args.slice(0, 2)), [
      ["configure"], ["artifact", "install"], ["build"],
    ]);
    const second = await fixtureData.prepare(graphs[1]);
    assert.equal(second.donor, first.snapshot);
    const secondCalls = [];
    await executeConsoleArtifactBuild({ plan: second, execute: executor(second, secondCalls) });
    assert.deepEqual(secondCalls.map((call) => call.args), [["configure"], ["build"]]);
    assert.equal(await readFile(path.join(second.paths.object, "dist", "bin", "binary"), "utf8"), "prebuilt");
    // Refreshing frontend files must not change the immutable donor snapshot.
    await writeFile(path.join(second.paths.object, "dist", "bin", "binary"), "local edit");
    assert.equal(await readFile(path.join(first.snapshot, "dist", "bin", "binary"), "utf8"), "prebuilt");
    secondCalls.length = 0;
    await executeConsoleArtifactBuild({ plan: second, execute: executor(second, secondCalls) });
    assert.deepEqual(secondCalls.map((call) => call.args), [["build", "faster"]]);
    assert.deepEqual(await getConsoleBuildEnvironment(graphs[1]), { MOZCONFIG: second.paths.config });
  }
});

test("a new worktree finds a completed snapshot without a checkout list", async (t) => {
  const { graphs, prepare, runCommand } = await fixture(t);
  const first = await prepare(graphs[0]);
  await executeConsoleArtifactBuild({ plan: first, execute: executor(first, []) });
  const next = await prepareConsoleBuild({ graph: graphs[1], graphs: [], runCommand,
    cacheDirectory: path.dirname(first.snapshot) });
  assert.equal(next.donor, first.snapshot);
  assert.equal(path.dirname(next.snapshot), path.dirname(first.snapshot));
});

test("different configurations do not share binaries; native changes clear artifact selection", async (t) => {
  const { graphs, prepare, changes } = await fixture(t);
  const first = await prepare(graphs[0]);
  await executeConsoleArtifactBuild({ plan: first, execute: executor(first, []) });
  await writeFile(path.join(graphs[1].path, "..", "mozconfig"), "ac_add_options --enable-debug\n");
  assert.equal((await prepare(graphs[1])).donor, "");
  changes.set(graphs[0].path, "mail/native.cpp\0");
  assert.equal(await prepare(graphs[0]), null);
  assert.deepEqual(await getConsoleBuildEnvironment(graphs[0]), {});
});

test("faster failure retries a complete artifact build", async (t) => {
  const { graphs, prepare } = await fixture(t);
  const plan = await prepare(graphs[0]);
  await executeConsoleArtifactBuild({ plan, execute: executor(plan, []) });
  const calls = [];
  const execute = executor(plan, calls);
  await executeConsoleArtifactBuild({ plan, execute: async (command) => {
    await execute(command);
    if (command.args[1] === "faster") throw new Error("Missing generated target");
  } });
  assert.deepEqual(calls.at(-1).args, ["build"]);
  assert.deepEqual(await getConsoleBuildEnvironment(graphs[0]), { MOZCONFIG: plan.paths.config });
});

test("cancellation does not publish partial artifacts or start the next command", async (t) => {
  const { graphs, prepare } = await fixture(t);
  const plan = await prepare(graphs[0]);
  let canceled = false;
  const calls = [];
  const execute = executor(plan, calls);
  await executeConsoleArtifactBuild({ plan, canceled: () => canceled, execute: async (command) => {
    await execute(command);
    if (command.args[0] === "artifact") canceled = true;
  } });
  assert.equal(calls.length, 2);
  assert.equal((await prepare(graphs[1])).donor, "");
  assert.deepEqual(await getConsoleBuildEnvironment(graphs[0]), {});
});

test("copied object directories are configured again for the destination root", async (t) => {
  const { graphs, prepare } = await fixture(t);
  const first = await prepare(graphs[0]);
  await executeConsoleArtifactBuild({ plan: first, execute: executor(first, []) });
  const second = await prepare(graphs[1]);
  await mkdir(path.join(second.paths.object, "faster"), { recursive: true });
  await writeFile(path.join(second.paths.object, "faster", "Makefile"), "old absolute paths");
  await writeFile(second.paths.active, await readFile(first.paths.active));
  assert.deepEqual(await getConsoleBuildEnvironment(graphs[1]), {});
  const calls = [];
  await executeConsoleArtifactBuild({ plan: second, execute: executor(second, calls) });
  assert.deepEqual(calls.map((call) => call.args), [["configure"], ["build"]]);
});

test("Gecko changes and untracked native files require a normal build", async (t) => {
  const { graphs, prepare, changes, runCommand } = await fixture(t);
  changes.set(path.dirname(graphs[0].path), "js/src/builtin/Array.js\0");
  assert.equal(await prepare(graphs[0]), null);
  changes.clear();
  const result = await prepareConsoleBuild({ graph: graphs[0], graphs, runCommand: (command) => {
    if (command.args[0] === "ls-files") return Promise.resolve("new source.cpp\0");
    return runCommand(command);
  } });
  assert.equal(result, null);
});

test("a generated worktree mozconfig does not block an artifact build", async (t) => {
  const { graphs, runCommand } = await fixture(t);
  await writeFile(path.join(path.dirname(graphs[0].path), ".mozconfig"),
    "export SCCACHE_DIRECT=false\nac_add_options --enable-project=comm/mail\nmk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-review\n");
  const plan = await prepareConsoleBuild({ graph: graphs[0], runCommand: command => {
    if (command.args[0] === "ls-files" && command.cwd === path.dirname(graphs[0].path)) {
      return Promise.resolve(".mozconfig\0");
    }
    return runCommand(command).then(result => command.args[0] === "environment"
      ? `Creating local state directory\n${result}` : result);
  } });
  assert.ok(plan);
});

test("explicitly disabled artifacts use the original build", async (t) => {
  const { graphs, runCommand } = await fixture(t);
  const plan = await prepareConsoleBuild({ graph: graphs[0], graphs, runCommand: async (command) => {
    const result = await runCommand(command);
    if (command.args[0] !== "environment") return result;
    const environment = JSON.parse(result);
    environment.mozconfig.configure_args.push("--disable-artifact-builds");
    return JSON.stringify(environment);
  } });
  assert.equal(plan, null);
});

test("artifact mode removes a direct ccache option and rejects a sourced one", async (t) => {
  const { graphs, runCommand } = await fixture(t);
  const original = path.join(path.dirname(graphs[0].path), "mozconfig");
  await writeFile(original, "ac_add_options --enable-project=comm/mail\nac_add_options --with-ccache=/tmp/sccache\n");
  const withCcache = async command => {
    const result = await runCommand(command);
    if (command.args[0] !== "environment") return result;
    const environment = JSON.parse(result);
    environment.mozconfig.configure_args.push("--with-ccache=/tmp/sccache");
    return JSON.stringify(environment);
  };
  const plan = await prepareConsoleBuild({ graph: graphs[0], runCommand: withCcache });
  assert.ok(plan);
  const config = await readFile(plan.paths.config, "utf8");
  assert.doesNotMatch(config, /--with-ccache/);
  assert.match(config, /ac_add_options --enable-artifact-builds/);
  await writeFile(original, ". /tmp/ccache-options\n");
  assert.equal(await prepareConsoleBuild({ graph: graphs[0], runCommand: withCcache }), null);
});

test("an artifact setup failure falls back to the original build and run configuration", async (t) => {
  const { runGraphMachActionSession } = await import("../commands/graph/actions.mjs");
  const { graphs, runCommand } = await fixture(t);
  const session = { status: "running", output: "", cancelRequested: false };
  const calls = [];
  await runGraphMachActionSession({ graph: graphs[0], graphs, action: "run", session, runCommand: async (command) => {
    calls.push(command);
    if (command.args[0] === "configure") throw new Error("Unsupported artifact configuration");
    return runCommand(command);
  } });
  assert.match(session.output, /Trying a normal build/);
  assert.equal(session.status, "complete");
  assert.deepEqual(calls.slice(-2).map(({ args }) => args), [["build"], ["run"]]);
  assert.deepEqual(calls.at(-1).env, {});
});

test("console test sessions use the successful artifact build", async (t) => {
  const { createGraphTestSession } = await import("../commands/graph/testing.mjs");
  const { graphs, prepare } = await fixture(t);
  const plan = await prepare(graphs[0]);
  await executeConsoleArtifactBuild({ plan, execute: executor(plan, []) });
  const calls = [];
  const session = createGraphTestSession({
    graph: graphs[0], graphIndex: 0,
    options: { pattern: ["mail/test/browser/example.js"] },
    runCommand: async (command) => { calls.push(command); return ""; },
  });
  for (let count = 0; count < 100 && session.status === "running"; count++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(session.status, "complete");
  assert.equal(calls.at(-1).env.MOZCONFIG, plan.paths.config);
});


test("a completed native build warms another worktree without sharing paths or writable output", async t => {
  const f = await fixture(t);
  const first = f.graphs[0];
  const root = path.dirname(first.path);
  const object = path.join(root, "obj-original");
  await mkdir(path.join(object, "dist", "bin"), { recursive: true });
  const target = path.join(root, "native-library");
  await writeFile(target, "native binary");
  await symlink(target, path.join(object, "dist", "bin", "library"));
  const environmentCommand = f.runCommand;
  const runCommand = async command => command.cmd === "git" && command.args[0] === "rev-parse"
    ? "a".repeat(40) : environmentCommand(command);
  const cacheDirectory = path.join(root, "native-shared-cache");
  const snapshot = await publishCompletedConsoleBuild({ graph: first, runCommand, cacheDirectory });
  await rm(target);
  assert.equal(await readFile(path.join(snapshot, "dist", "bin", "library"), "utf8"), "native binary");
  const second = await prepareConsoleBuild({ graph: f.graphs[1], runCommand, cacheDirectory });
  assert.equal(second.donor, snapshot);
  const calls = [];
  await executeConsoleArtifactBuild({ plan: second, execute: executor(second, calls) });
  assert.deepEqual(calls.map(call => call.args), [["configure"], ["build"]]);
  await writeFile(path.join(second.paths.object, "dist", "bin", "library"), "task changed");
  assert.equal(await readFile(path.join(snapshot, "dist", "bin", "library"), "utf8"), "native binary");
  f.changes.set(root, "source.cpp");
  await assert.rejects(publishCompletedConsoleBuild({ graph: first, runCommand, cacheDirectory }), /changed source/);
});

test("compiler server paths do not split compatible binary snapshots", async t => {
  const f = await fixture(t);
  const runCommand = async command => {
    const output = await f.runCommand(command);
    if (command.args[0] !== "environment") return output;
    const environment = JSON.parse(output);
    environment.mozconfig.env = { added: { SCCACHE_BASEDIRS: command.cwd, SCCACHE_SERVER_UDS: `${command.cwd}/server.sock` } };
    return JSON.stringify(environment);
  };
  const first = await prepareConsoleBuild({ graph: f.graphs[0], runCommand });
  const second = await prepareConsoleBuild({ graph: f.graphs[1], runCommand });
  assert.equal(first.key, second.key);
});

test("a task switches from artifact output to a native build after native source changes", async t => {
  const f = await fixture(t);
  const graph = f.graphs[0];
  const plan = await f.prepare(graph);
  await executeConsoleArtifactBuild({ plan, execute: executor(plan, []) });
  f.changes.set(graph.path, "mail/native.cpp\0");
  const calls = [];
  const session = { graph, output: "" };
  const runCommand = async command => {
    calls.push(command);
    return f.runCommand(command);
  };
  await prepareTaskWorktreeBuild(session, runCommand);
  assert.ok(calls.some(command => command.cmd === "./mach" && command.args.join(" ") === "build" && !command.env.MOZCONFIG));
  assert.deepEqual(await getConsoleBuildEnvironment(graph), {});
  assert.match(session.output, /using a normal build/);
  await assert.rejects(prepareTaskWorktreeBuild(session, async command => {
    if (command.args.join(" ") === "build") throw new Error("Native compiler failed");
    return f.runCommand(command);
  }), /Native compiler failed/);
});
