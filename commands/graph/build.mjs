import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export async function prepareConsoleBuild({ graph, graphs = [], runCommand, log = () => {} }) {
  const paths = getArtifactBuildPaths(graph);
  const git = async (cwd, args) => String(await runCommand({
    cmd: "git", args, cwd, capture: true, silent: true,
  })).trim();
  let environment;
  let revisions;
  try {
    environment = JSON.parse(await runCommand({
      cmd: "./mach", args: ["environment", "--format", "json"],
      cwd: paths.root, capture: true, silent: true,
    }));
    if (!environment.topobjdir || !environment.mozconfig) throw new Error("Missing build environment");
    revisions = [];
    for (const cwd of [paths.root, graph.path]) {
      const base = await git(cwd, ["merge-base", "HEAD", "origin/main"]);
      if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Missing source base");
      const changed = await git(cwd, ["diff", "--name-only", "-z", base, "--"]);
      const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
      const files = `${changed}\0${untracked}`.split("\0").filter(Boolean);
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
  const key = createHash("sha256").update(JSON.stringify({
    revisions, args, originalText,
    resolvedConfig: { env: environment.mozconfig.env, vars: environment.mozconfig.vars, make_extra: environment.mozconfig.make_extra },
    artifactOverrides: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("MOZ_ARTIFACT_"))),
    platform: process.platform, arch: process.arch,
    state: process.env.MOZBUILD_STATE_PATH || path.join(os.homedir(), ".mozbuild"),
  })).digest("hex");
  await mkdir(paths.directory, { recursive: true });
  const config = [
    original ? `. ${shellQuote(original)}` : "ac_add_options --enable-project=comm/mail",
    "ac_add_options --enable-artifact-builds",
    `mk_add_options MOZ_OBJDIR=${shellQuote(paths.object)}`,
    "",
  ].join("\n");
  if (!await exists(paths.config) || await readFile(paths.config, "utf8") !== config) {
    await writeFile(paths.config, config);
  }
  log("Using an artifact build with the faster target.\n");
  const command = (commandArgs) => ({
    cmd: "./mach", args: commandArgs, cwd: paths.root, capture: true,
    env: { MOZCONFIG: paths.config },
  });
  const snapshot = path.join(paths.directory, `binaries-${key}`);
  let donor = "";
  // Check both directions, using only completed, immutable binary snapshots.
  // Never copy an object directory with paths or symlinks into another checkout.
  for (const candidate of [graph, ...graphs.filter((item) => item.repository === "comm")]) {
    const candidatePaths = getArtifactBuildPaths(candidate);
    const candidateSnapshot = path.join(candidatePaths.directory, `binaries-${key}`);
    if (await exists(path.join(candidateSnapshot, "complete"))) {
      donor = candidateSnapshot;
      log(`Reusing build artifacts from ${candidatePaths.root}.\n`);
      break;
    }
  }
  if (!donor) log("No matching checkout artifacts. Mach will use the shared download cache before downloading.\n");
  return { paths, key, command, snapshot, donor };
}

export async function executeConsoleArtifactBuild({ plan, execute, canceled = () => false, log = () => {} }) {
  const { paths, key, command } = plan;
  let active = {};
  try { active = JSON.parse(await readFile(paths.active, "utf8")); } catch { /* First build. */ }
  // Do not advertise a partially updated build to later test commands.
  await writeFile(paths.active, JSON.stringify({ artifact: false }));
  if (active.key !== key || active.root !== paths.root ||
      !await exists(path.join(paths.object, "faster", "Makefile")) ||
      !await exists(path.join(paths.object, "dist", "bin"))) {
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
  try {
    await execute(command(["build", "faster"]));
  } catch {
    if (canceled()) return;
    log("The faster target failed; retrying a complete artifact build.\n");
    await execute(command(["build"]));
  }
  if (!canceled()) await writeFile(paths.active, JSON.stringify({ artifact: true, key, root: paths.root }));
}
