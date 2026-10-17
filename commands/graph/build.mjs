import { leaseStorage, pruneStorage, STORAGE_LIMITS } from "./storage-retention.mjs";
import { normalizeMachCommand } from "../../lib/mach-command.mjs";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isGeneratedWorktreeBuildConfig } from "./worktrees.mjs";

// Unknown files require a normal build. In particular, do not skip native code,
// interface definitions, generated files, or build configuration changes.
export function supportsArtifactBuild(files) {
  return files.every((file) => /(?:^|\/)(?:browser|xpcshell|mochitest|chrome|a11y)\.toml$/.test(file) || /(?:^|\/)jar(?:\.inc)?\.mn$/.test(file) || !/(?:^|\/)CMakeLists\.txt$/.test(file) && /\.(?:js|mjs|jsm|css|xhtml|html|xul|ftl|properties|dtd|svg|png|jpg|jpeg|gif|webp|ico|md|txt)$/.test(file));
}

export function supportsArtifactMozBuild(before, after) {
  const strip = text => text.replace(/^(?:(?:EXTRA_JS_MODULES|FINAL_TARGET_FILES|FINAL_TARGET_PP_FILES|TESTING_JS_MODULES)(?:\.[A-Za-z_][\w]*)*|MOZ_SRC_FILES)\s*\+=\s*\[([^\]]*)\]/gm, (block, contents) => {
    const strings = [...contents.matchAll(/(["'])([^"'\n]+)\1/g)];
    if (contents.replace(/(["'])([^"'\n]+)\1/g, "").replace(/[\s,]/g, "") ||
        !supportsArtifactBuild(strings.map(match => match[2]))) return block;
    return "";
  });
  // Only static resource lists may change. Conditions, native sources and
  // other build statements must stay exactly the same.
  return strip(before) === strip(after);
}

async function supportsArtifactSourceFiles(cwd, base, files, git) {
  const remaining = [];
  for (const file of files) {
    if (!/(?:^|\/)moz\.build$/.test(file)) { remaining.push(file); continue; }
    try {
      const before = await git(cwd, ["show", `${base}:${file}`]);
      const after = await readFile(path.join(cwd, file), "utf8");
      if (!supportsArtifactMozBuild(before, after.trim())) return false;
    } catch { return false; }
  }
  return supportsArtifactBuild(remaining);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function cacheKeyBuildConfig(originalText, mozconfig) {
  const source = originalText.replace(/^export SCCACHE_(?:BASEDIRS|DIR|SERVER_UDS|SERVER_PORT|IDLE_TIMEOUT)=[^\n]+\n/gm, "").replace(/(^|\n)mk_add_options MOZ_OBJDIR=[^\n]+/g,
    "$1mk_add_options MOZ_OBJDIR=<private>");
  const vars = JSON.parse(JSON.stringify(mozconfig.vars || {}), (key, value) =>
    key === "_mozconfig_opt" && typeof value === "string" && value.startsWith("MOZ_OBJDIR=")
      ? "MOZ_OBJDIR=<private>" : value);
  const env = JSON.parse(JSON.stringify(mozconfig.env || {}), (key, value) =>
    /^SCCACHE_(?:BASEDIRS|DIR|SERVER_UDS|SERVER_PORT|IDLE_TIMEOUT)$/.test(key) ? undefined : value);
  return { source, env, vars, make_extra: mozconfig.make_extra };
}

export function getArtifactBuildPaths(graph) {
  const root = path.resolve(graph.path, "..");
  const directory = path.join(root, "obj-tb-tools");
  return {
    root,
    directory,
    config: path.join(directory, "mozconfig-artifact"),
    object: path.join(directory, "artifact"),
    active: path.join(directory, "active-build.json"),
  };
}

export function getSharedBuildCacheDirectory() {
  return path.resolve(process.env.TB_BUILD_CACHE_PATH ||
    path.join(os.homedir(), ".tb-tools", "build-cache"));
}


function binaryCompatibilityKey(revisions, environment, originalText, env = {}) {
  return createHash("sha256").update(JSON.stringify({
    revisions, args: environment.mozconfig.configure_args || [],
    resolvedConfig: cacheKeyBuildConfig(originalText, environment.mozconfig),
    artifactOverrides: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([name]) => name.startsWith("MOZ_ARTIFACT_"))),
    platform: process.platform, arch: process.arch,
    state: env.MOZBUILD_STATE_PATH || process.env.MOZBUILD_STATE_PATH || path.join(os.homedir(), ".mozbuild"),
  })).digest("hex");
}

// Publish only portable installed files after a successful native build.
// Configure files, generated headers and compiler objects stay in their worktree.
export async function publishCompletedConsoleBuild({ graph, runCommand,
  env = {}, cacheDirectory = getSharedBuildCacheDirectory() }) {
  const root = path.dirname(graph.path);
  const git = async (cwd, args) => String(await runCommand({ cmd: "git", args, cwd, capture: true, silent: true })).trim();
  const changed = async cwd => {
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter(name => name && !(cwd === root && (name === ".mozconfig" || name.startsWith("comm/"))));
    return untracked.length || await git(cwd, ["diff", "HEAD", "--name-only"]);
  };
  const revisions = [];
  for (const cwd of [root, graph.path]) {
    if (await changed(cwd)) throw new Error("Cannot publish build binaries from changed source.");
    revisions.push(await git(cwd, ["rev-parse", "HEAD"]));
  }
  const output = String(await runCommand({ cmd: "./mach", args: ["environment", "--format", "json"],
    cwd: root, env, capture: true, silent: true }));
  const environment = JSON.parse(output.slice(output.indexOf("{")));
  if (environment.mozconfig.configure_args.includes("--enable-artifact-builds")) return null;
  const originalText = environment.mozconfig.path ? await readFile(environment.mozconfig.path, "utf8") : "";
  const compatibleRevisions = [...revisions];
  for (let index = 0; index < 2; index++) {
    const cwd = index === 0 ? root : graph.path;
    const base = await git(cwd, ["merge-base", "HEAD", "origin/main"]);
    const files = (await git(cwd, ["diff", "--name-only", "-z", base, "--"])).split("\0").filter(Boolean);
    if (/^[a-f0-9]{40}$/.test(base) && (index === 0 ? !files.length : await supportsArtifactSourceFiles(cwd, base, files, git))) {
      compatibleRevisions[index] = base;
    }
  }
  const key = binaryCompatibilityKey(compatibleRevisions, environment, originalText, env);
  const snapshot = path.join(cacheDirectory, `compiled-${key}`);
  if (await exists(path.join(snapshot, "complete"))) return snapshot;
  const staging = `${snapshot}-${randomUUID()}`;
  const releaseStorage = await leaseStorage(cacheDirectory, [staging, snapshot]);
  try {
    const dist = path.join(environment.topobjdir, "dist");
    if (!await exists(path.join(dist, "bin"))) throw new Error("Completed build has no installed binaries.");
    await mkdir(path.join(staging, "dist"), { recursive: true });
    for (const name of ["bin", "lib"]) {
      if (await exists(path.join(dist, name))) await cp(path.join(dist, name), path.join(staging, "dist", name),
        { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
    }
    // Recheck the source before making the snapshot visible to another task.
    for (let index = 0; index < 2; index++) {
      const cwd = index === 0 ? root : graph.path;
      if (await git(cwd, ["rev-parse", "HEAD"]) !== revisions[index] || await changed(cwd)) {
        throw new Error("Source changed while publishing completed build binaries.");
      }
    }
    await writeFile(path.join(staging, "complete"), key);
    try { await rename(staging, snapshot); }
    catch (error) { if (!await exists(path.join(snapshot, "complete"))) throw error; }
    await pruneStorage({ directory: cacheDirectory, ...STORAGE_LIMITS.buildSnapshots, keepPaths: [snapshot], select: name => /^(?:compiled|binaries)-[a-f0-9]{64}$/.test(name) });
    return snapshot;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await releaseStorage();
  }
}

export async function getConsoleBuildEnvironment(graph) {
  const paths = getArtifactBuildPaths(graph);
  try {
    const active = JSON.parse(await readFile(paths.active, "utf8"));
    if (active.artifact && active.root === paths.root && await exists(paths.config)) {
      return { MOZCONFIG: paths.config };
    }
  } catch {
    // A checkout with no console build uses its normal mozconfig.
  }
  return {};
}

export async function prepareConsoleBuild({ graph, graphs = [], runCommand, log = () => {},
  env = {}, cacheDirectory = getSharedBuildCacheDirectory() }) {
  const paths = getArtifactBuildPaths(graph);
  const git = async (cwd, args) => String(await runCommand({
    cmd: "git", args, cwd, capture: true, silent: true,
  })).trim();
  let environment;
  let revisions;
  let requiresCompiledSnapshot = false;
  try {
    const output = String(await runCommand({
      cmd: "./mach", args: ["environment", "--format", "json"],
      cwd: paths.root, env, capture: true, silent: true,
    }));
    const jsonStart = output.indexOf("{");
    environment = JSON.parse(output.slice(jsonStart));
    if (!environment.topobjdir || !environment.mozconfig) throw new Error("Missing build environment");
    revisions = [];
    for (const cwd of [paths.root, graph.path]) {
      const base = await git(cwd, ["merge-base", "HEAD", "origin/main"]);
      if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Missing source base");
      const changed = await git(cwd, ["diff", "--name-only", "-z", base, "--"]);
      const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
      const files = `${changed}\0${untracked}`.split("\0").filter(file => file &&
        !(cwd === paths.root && (file === "comm" || file.startsWith("comm/"))));
      if (cwd === paths.root && files.includes(".mozconfig")) {
        const config = path.join(cwd, ".mozconfig");
        if (isGeneratedWorktreeBuildConfig(await readFile(config, "utf8"))) {
          files.splice(files.indexOf(".mozconfig"), 1);
        }
      }
      if ((cwd === paths.root && files.length) || !await supportsArtifactSourceFiles(cwd, base, files, git)) {
        // A completed native build of this exact source can also supply binaries.
        // Local native edits still need compilation.
        const dirty = await git(cwd, ["diff", "HEAD", "--name-only", "-z"]);
        const localFiles = `${dirty}\0${untracked}`.split("\0").filter(file => file &&
          !(cwd === paths.root && (file === ".mozconfig" || file === "comm" || file.startsWith("comm/"))));
        if ((cwd === paths.root && localFiles.length) || !await supportsArtifactSourceFiles(cwd, "HEAD", localFiles, git)) {
          log(`Native code or build settings changed; using a normal build. Files: ${files.slice(0, 8).join(", ")}\n`);
          await mkdir(paths.directory, { recursive: true });
          await writeFile(paths.active, JSON.stringify({ artifact: false }));
          return null;
        }
        requiresCompiledSnapshot = true;
        const revision = await git(cwd, ["rev-parse", "HEAD"]);
        if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Missing native source revision");
        revisions.push(revision);
      } else {
        revisions.push(base);
      }
    }
  } catch (error) {
    log(`Cannot select artifact mode: ${error.message}. Using a normal build.\n`);
    // Clear a previous artifact selection when source checks cannot be completed.
    if (await exists(paths.active)) await writeFile(paths.active, JSON.stringify({ artifact: false }));
    return null;
  }

  const args = environment.mozconfig.configure_args || [];
  if (args.includes("--disable-artifact-builds")) {
    if (await exists(paths.active)) await writeFile(paths.active, JSON.stringify({ artifact: false }));
    log("The mozconfig disables artifact builds; using a normal build.\n");
    return null;
  }
  // Resolve the original config through mach, including MOZCONFIG and .mozconfig.
  // Keep user settings and put console artifact output in its own directory.
  const original = environment.mozconfig.path;
  const originalText = original ? await readFile(original, "utf8") : "";
  let sourceConfig = original ? `. ${shellQuote(original)}` : "ac_add_options --enable-project=comm/mail";
  // Artifact builds do not accept --with-ccache. Remove a direct mozconfig
  // option while keeping all other settings. A sourced option is too hard to
  // change safely, so use the normal build in that case.
  if (args.some(arg => arg.startsWith("--with-ccache"))) {
    const lines = originalText.split("\n");
    const filtered = lines.map(line => /^\s*ac_add_options\s+--with-ccache(?:=|\s|$)|^export SCCACHE_/.test(line) ? ":" : line);
    if (filtered.every((line, index) => line === lines[index])) {
      log("The mozconfig sources a ccache option; using a normal build.\n");
      if (await exists(paths.active)) await writeFile(paths.active, JSON.stringify({ artifact: false }));
      return null;
    }
    sourceConfig = filtered.join("\n");
  }
  const key = binaryCompatibilityKey(revisions, environment, originalText, env);
  if (requiresCompiledSnapshot && !await exists(path.join(cacheDirectory, `compiled-${key}`, "complete"))) {
    log("No completed local binaries for this native revision; using a normal build with the compiler cache.\n");
    if (await exists(paths.active)) await writeFile(paths.active, JSON.stringify({ artifact: false }));
    return null;
  }
  await mkdir(paths.directory, { recursive: true });
  const config = [
    sourceConfig,
    "export SCCACHE_DIRECT=false",
    "ac_add_options --enable-artifact-builds",
    `mk_add_options MOZ_OBJDIR=${shellQuote(paths.object)}`,
    "",
  ].join("\n");
  if (!await exists(paths.config) || await readFile(paths.config, "utf8") !== config) {
    await writeFile(paths.config, config);
  }
  log("Preparing compatible binaries for the faster resource target.\n");
  const command = (commandArgs) => normalizeMachCommand({
    cmd: "./mach", args: commandArgs, cwd: paths.root, capture: true,
    env: { ...env, MOZCONFIG: paths.config },
  });
  const snapshot = path.join(cacheDirectory, `binaries-${key}`);
  let donor = "";
  // Only completed snapshots can be shared. Writable object directories stay private.
  const compiled = path.join(cacheDirectory, `compiled-${key}`);
  if (await exists(path.join(compiled, "complete"))) {
    donor = compiled;
    log(`Reusing completed local binaries from ${compiled}.\n`);
  }
  if (!donor && await exists(path.join(snapshot, "complete"))) {
    donor = snapshot;
    log(`Reusing build artifacts from ${cacheDirectory}.\n`);
  }
  // Older checkout-local snapshots remain usable during migration.
  for (const candidate of donor ? [] : [graph, ...graphs.filter((item) => item.repository === "comm")]) {
    const candidatePaths = getArtifactBuildPaths(candidate);
    const candidateSnapshot = path.join(candidatePaths.directory, `binaries-${key}`);
    if (await exists(path.join(candidateSnapshot, "complete"))) {
      donor = candidateSnapshot;
      log(`Reusing build artifacts from ${candidatePaths.root}.\n`);
      break;
    }
  }
  if (!donor) log("No matching local binaries. Mach will check its download cache and available Thunderbird CI artifacts (Treeherder/Taskcluster).\n");
  return { paths, key, command, snapshot, donor, requiresCompiledSnapshot, nativeObject: environment.topobjdir };
}

export async function executeConsoleArtifactBuild({ plan, execute, canceled = () => false, log = () => {} }) {
  const { paths, key, command } = plan;
  let active = {};
  try { active = JSON.parse(await readFile(paths.active, "utf8")); } catch { /* First build. */ }
  // Do not advertise a partially updated build to later test commands.
  await writeFile(paths.active, JSON.stringify({ artifact: false }));
  const needsSetup = active.key !== key || active.root !== paths.root ||
      !await exists(path.join(paths.object, "faster", "Makefile")) ||
      !await exists(path.join(paths.object, "dist", "bin"));
  if (needsSetup) {
    await execute(command(["configure"]));
    if (canceled()) return;
    let donor = plan.donor;
    if (!donor) {
      const staging = `${plan.snapshot}-${randomUUID()}`;
      const releaseStorage = await leaseStorage(path.dirname(plan.snapshot), [staging, plan.snapshot]);
      try {
        await mkdir(staging, { recursive: true });
        await execute(command(["artifact", "install", "--distdir", path.join(staging, "dist")]));
        if (canceled()) return;
        if (!await exists(path.join(staging, "dist", "bin"))) throw new Error("The artifact lookup did not install usable binaries.");
        await writeFile(path.join(staging, "complete"), key);
        try { await rename(staging, plan.snapshot); } catch (error) {
          if (!await exists(path.join(plan.snapshot, "complete"))) throw error;
        }
        donor = plan.snapshot;
      } finally {
        await rm(staging, { recursive: true, force: true });
        await releaseStorage();
      }
    }
    if (canceled()) return;
    await rm(path.join(paths.object, "dist"), { recursive: true, force: true });
    const release = await leaseStorage(path.dirname(donor), [donor]);
    try {
      await cp(path.join(donor, "dist"), path.join(paths.object, "dist"), {
        recursive: true, force: true, mode: constants.COPYFILE_FICLONE,
      });
    } finally { await release(); }
  }
  if (canceled()) return;
  // Let the build system try its resource target even in a new object directory.
  // Missing generated files can require the complete artifact target once.
  try {
    await execute(command(["build", "faster"]));
  } catch {
    if (canceled()) return;
    if (plan.requiresCompiledSnapshot) throw new Error("The cached native binaries need a normal incremental build.");
    log("The faster target failed; retrying a complete artifact build.\n");
    await execute(command(["build"]));
  }
  if (!canceled()) await writeFile(paths.active, JSON.stringify({ artifact: true, key, root: paths.root }));
}

// All local build entry points use the same selection, reuse and fallback rules.
export async function runConsoleBuild({ graph, graphs = [], runCommand, execute,
  env = {}, log = () => {}, canceled = () => false,
  cacheDirectory = getSharedBuildCacheDirectory() }) {
  if (canceled()) return;
  const plan = await prepareConsoleBuild({ graph, graphs, runCommand, env, log, cacheDirectory });
  if (canceled()) return;
  if (plan) {
    let active = {};
    try { active = JSON.parse(await readFile(plan.paths.active, "utf8")); } catch { /* No completed local build. */ }
    const nativeReady = active.native && active.key === plan.key && active.root === plan.paths.root &&
      active.object === plan.nativeObject && await exists(path.join(active.object, "faster", "Makefile")) &&
      await exists(path.join(active.object, "dist", "bin"));
    try {
      if (nativeReady) {
        log("Reusing this checkout's completed native output with the faster target.\n");
        await writeFile(plan.paths.active, JSON.stringify({ artifact: false }));
        await execute(normalizeMachCommand({ cmd: "./mach", args: ["build", "faster"], cwd: plan.paths.root, env }));
        if (!canceled()) await writeFile(plan.paths.active, JSON.stringify(active));
        return canceled() ? undefined : { artifact: false, snapshot: active.snapshot };
      }
      await executeConsoleArtifactBuild({ plan, execute, log, canceled });
      if (!canceled()) return { artifact: true, snapshot: plan.donor || plan.snapshot };
      return;
    } catch (error) {
      if (canceled()) return;
      log(`${nativeReady ? "Faster native build" : "Artifact build"} failed: ${error.message}. Trying a normal build.\n`);
      await writeFile(plan.paths.active, JSON.stringify({ artifact: false }));
    }
  }
  if (canceled()) return;
  // Plain mach build keeps its existing object directory and decides what to compile.
  await execute(normalizeMachCommand({ cmd: "./mach", args: ["build"],
    cwd: path.dirname(graph.path), env }));
  if (canceled()) return;
  let snapshot;
  try { snapshot = await publishCompletedConsoleBuild({ graph, runCommand, env, cacheDirectory }); }
  catch (error) { log(`Build passed; binary snapshot was not saved: ${error.message}\n`); }
  if (snapshot && !canceled()) {
    try {
      const output = String(await runCommand({ cmd: "./mach", args: ["environment", "--format", "json"],
        cwd: path.dirname(graph.path), env, capture: true, silent: true }));
      const environment = JSON.parse(output.slice(output.indexOf("{")));
      const paths = getArtifactBuildPaths(graph);
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.active, JSON.stringify({ artifact: false, native: true,
        key: path.basename(snapshot).replace(/^compiled-/, ""), root: paths.root,
        object: environment.topobjdir, snapshot }));
    } catch (error) { log(`Native build passed; reuse state was not saved: ${error.message}\n`); }
  }
  return { artifact: false, snapshot };
}
