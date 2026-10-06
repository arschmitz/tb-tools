import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isGeneratedWorktreeBuildConfig } from "./worktrees.mjs";

// Unknown files require a normal build. In particular, do not skip native code,
// interface definitions, generated files, or build configuration changes.
export function supportsArtifactBuild(files) {
  return files.every((file) => !/(?:^|\/)CMakeLists\.txt$/.test(file) && /\.(?:js|mjs|jsm|css|xhtml|html|xul|ftl|properties|dtd|svg|png|jpg|jpeg|gif|webp|ico|md|txt)$/.test(file));
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
  const source = originalText.replace(/(^|\n)mk_add_options MOZ_OBJDIR=[^\n]+/g,
    "$1mk_add_options MOZ_OBJDIR=<private>");
  const vars = JSON.parse(JSON.stringify(mozconfig.vars || {}), (key, value) =>
    key === "_mozconfig_opt" && typeof value === "string" && value.startsWith("MOZ_OBJDIR=")
      ? "MOZ_OBJDIR=<private>" : value);
  return { source, env: mozconfig.env, vars, make_extra: mozconfig.make_extra };
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
  cacheDirectory = getSharedBuildCacheDirectory() }) {
  const paths = getArtifactBuildPaths(graph);
  const git = async (cwd, args) => String(await runCommand({
    cmd: "git", args, cwd, capture: true, silent: true,
  })).trim();
  let environment;
  let revisions;
  try {
    const output = String(await runCommand({
      cmd: "./mach", args: ["environment", "--format", "json"],
      cwd: paths.root, capture: true, silent: true,
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
      const files = `${changed}\0${untracked}`.split("\0").filter(Boolean);
      if (cwd === paths.root && files.includes(".mozconfig")) {
        const config = path.join(cwd, ".mozconfig");
        if (isGeneratedWorktreeBuildConfig(await readFile(config, "utf8"))) {
          files.splice(files.indexOf(".mozconfig"), 1);
        }
      }
      if ((cwd === paths.root && files.length) || !supportsArtifactBuild(files)) {
        log("Native code or build settings changed; using a normal build.\n");
        await mkdir(paths.directory, { recursive: true });
        await writeFile(paths.active, JSON.stringify({ artifact: false }));
        return null;
      }
      revisions.push(base);
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
    const filtered = lines.map(line => /^\s*ac_add_options\s+--with-ccache(?:=|\s|$)/.test(line) ? ":" : line);
    if (filtered.every((line, index) => line === lines[index])) {
      log("The mozconfig sources a ccache option; using a normal build.\n");
      if (await exists(paths.active)) await writeFile(paths.active, JSON.stringify({ artifact: false }));
      return null;
    }
    sourceConfig = filtered.join("\n");
  }
  const key = createHash("sha256").update(JSON.stringify({
    revisions, args, resolvedConfig: cacheKeyBuildConfig(originalText, environment.mozconfig),
    artifactOverrides: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("MOZ_ARTIFACT_"))),
    platform: process.platform, arch: process.arch,
    state: process.env.MOZBUILD_STATE_PATH || path.join(os.homedir(), ".mozbuild"),
  })).digest("hex");
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
  log("Using an artifact build. Later builds use the faster target.\n");
  const command = (commandArgs) => ({
    cmd: "./mach", args: commandArgs, cwd: paths.root, capture: true,
    env: { MOZCONFIG: paths.config },
  });
  const snapshot = path.join(cacheDirectory, `binaries-${key}`);
  let donor = "";
  // Only completed snapshots can be shared. Writable object directories stay private.
  if (await exists(path.join(snapshot, "complete"))) {
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
  if (!donor) log("No matching build artifacts. Mach will use the shared download cache before downloading.\n");
  return { paths, key, command, snapshot, donor };
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
      await mkdir(staging, { recursive: true });
      try {
        await execute(command(["artifact", "install", "--distdir", path.join(staging, "dist")]));
        if (canceled()) return;
        await writeFile(path.join(staging, "complete"), key);
        try { await rename(staging, plan.snapshot); } catch (error) {
          if (!await exists(path.join(plan.snapshot, "complete"))) throw error;
        }
        donor = plan.snapshot;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    if (canceled()) return;
    await rm(path.join(paths.object, "dist"), { recursive: true, force: true });
    await cp(path.join(donor, "dist"), path.join(paths.object, "dist"), {
      recursive: true, force: true, mode: constants.COPYFILE_FICLONE,
    });
  }
  if (canceled()) return;
  // A new Thunderbird object directory needs its first full artifact build.
  // Its faster target can fail before the package files have been generated.
  if (needsSetup) {
    await execute(command(["build"]));
    if (!canceled()) await writeFile(paths.active, JSON.stringify({ artifact: true, key, root: paths.root }));
    return;
  }
  try {
    await execute(command(["build", "faster"]));
  } catch {
    if (canceled()) return;
    log("The faster target failed; retrying a complete artifact build.\n");
    await execute(command(["build"]));
  }
  if (!canceled()) await writeFile(paths.active, JSON.stringify({ artifact: true, key, root: paths.root }));
}
