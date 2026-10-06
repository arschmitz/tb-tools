import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeConsoleArtifactBuild, getConsoleBuildEnvironment, prepareConsoleBuild, supportsArtifactBuild } from "../commands/graph/build.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graphs = ["working", "review"].map((checkout) => ({
    path: path.join(root, checkout, "comm"), repository: "comm", checkout,
  }));
  for (const graph of graphs) {
    await mkdir(graph.path, { recursive: true });
    await writeFile(path.join(graph.path, "..", "mozconfig"), "ac_add_options --enable-project=comm/mail\n");
  }
  const changes = new Map();
  const calls = [];
  const runCommand = async (command) => {
    calls.push(command);
    if (command.args[0] === "environment") return JSON.stringify({
      topobjdir: path.join(command.cwd, "obj-original"),
      mozconfig: { path: path.join(command.cwd, "mozconfig"), configure_args: ["--enable-project=comm/mail"] },
    });
    if (command.args[0] === "merge-base") return "a".repeat(40);
    if (command.args[0] === "diff") return changes.get(command.cwd) || "";
    return "";
  };
  const prepare = (graph) => prepareConsoleBuild({ graph, graphs, runCommand });
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
      ["configure"], ["artifact", "install"], ["build", "faster"],
    ]);
    const second = await fixtureData.prepare(graphs[1]);
    assert.equal(second.donor, first.snapshot);
    const secondCalls = [];
    await executeConsoleArtifactBuild({ plan: second, execute: executor(second, secondCalls) });
    assert.deepEqual(secondCalls.map((call) => call.args), [["configure"], ["build", "faster"]]);
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
  assert.deepEqual(calls.map((call) => call.args), [["configure"], ["build", "faster"]]);
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
