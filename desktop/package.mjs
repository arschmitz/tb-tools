import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import branding from "./branding.cjs";
import { prepareNodeRuntime } from "./node-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);
const electronVersion = JSON.parse(await readFile(path.join(root, "node_modules", "electron",
  "package.json"), "utf8")).version;
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const targets = direct ? (process.argv.slice(2).length ? process.argv.slice(2)
  : [`${process.platform}:${process.arch}`]) : [];

export async function verifyPackagedVectorSearch(resources, { platform, arch, execute = run }) {
  // USearch does not ship a Windows ARM64 binary; that target keeps exact search.
  if (platform === "win32" && arch === "arm64") return { supported: false };
  const target = platform === "darwin" ? "darwin-arm64+x64" : `${platform}-${arch}`;
  const application = path.join(resources, "app.asar.unpacked");
  await access(path.join(application, "node_modules", "usearch", "prebuilds", target, "usearch.node"));
  if (platform !== process.platform || arch !== process.arch) return { supported: true, executed: false };
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-vector-package-"));
  const script = `import { Index } from "usearch";
    const options = { dimensions: 384, metric: "ip", quantization: "f32", connectivity: 32, expansion_add: 200, expansion_search: 400 };
    const index = new Index(options);
    const vector = Float32Array.from({ length: 384 }, (_, position) => Number(position === 0));
    index.add(1n, vector);
    if (index.search(vector, 1).keys[0] !== 1n) throw new Error("Packaged vector search did not return its indexed source.");
    index.save(process.argv[1]);
    const mapped = new Index(options);
    mapped.view(process.argv[1]);
    if (mapped.size() !== 1 || mapped.dimensions() !== 384 || mapped.search(vector, 1).keys[0] !== 1n) {
      throw new Error("Packaged vector search did not reload its saved source.");
    }`;
  try {
    await execute(path.join(resources, "node-runtime", platform === "win32" ? "node.exe" : "node"),
      ["--input-type=module", "--eval", script, path.join(directory, "index.usearch")],
      { cwd: application, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } finally {
    // The child has exited and released its native file mapping before cleanup.
    await rm(directory, { recursive: true, force: true });
  }
  return { supported: true, executed: true };
}
for (const target of targets) {
  const [platform, arch] = target.split(":");
  if (!["darwin", "win32", "linux"].includes(platform) ||
      !["x64", "arm64"].includes(arch) || target !== `${platform}:${arch}`) {
    throw new Error(`Invalid desktop target: ${target}. Use darwin:x64, darwin:arm64, win32:x64, win32:arm64, linux:x64, or linux:arm64.`);
  }
  const crossTarget = platform !== process.platform || arch !== process.arch;
  const stage = crossTarget ? await mkdtemp(path.join(os.tmpdir(), "tb-desktop-package-")) : null;
  const runtimeStage = await mkdtemp(path.join(os.tmpdir(), "tb-desktop-node-"));
  try {
    const nodeRuntime = await prepareNodeRuntime(runtimeStage, { platform, arch });
    if (stage) {
      const excluded = new Set([".git", "node_modules", "dist", "test"]);
      await cp(root, stage, { recursive: true, filter: source =>
        !path.relative(root, source).split(path.sep).some(segment => excluded.has(segment)) });
      await run("npm", ["ci", "--omit=dev", "--ignore-scripts",
        `--os=${platform}`, `--cpu=${arch}`,
        ...(platform === "linux" ? ["--libc=glibc"] : [])],
      { cwd: stage, maxBuffer: 1024 * 1024 });
      const sharp = `sharp-${platform === "win32" ? "win32" : platform}-${arch}`;
      await access(path.join(stage, "node_modules", "@img", sharp));
      await access(path.join(stage, "node_modules", "onnxruntime-node", "bin", "napi-v6",
        platform, arch, "onnxruntime_binding.node"));
    }
    const output = await packager({
      dir: stage || root,
      name: branding.APP_NAME,
      executableName: branding.EXECUTABLE_NAME,
      appBundleId: branding.APP_ID,
      extendInfo: { CFBundleName: branding.APP_NAME, CFBundleDisplayName: branding.APP_NAME },
      win32metadata: { ProductName: branding.APP_NAME, FileDescription: branding.APP_NAME },
      platform,
      arch,
      electronVersion,
      out: process.env.TB_DESKTOP_PACKAGE_OUT || path.join(root, "dist"),
      overwrite: true,
      // The standalone backend needs ordinary files, including its dependencies.
      asar: { unpack: "**/*" },
      extraResource: [nodeRuntime],
      prune: !crossTarget,
      icon: platform === "darwin" ? path.join(root, "assets", "branding", "app-icon.icns")
        : platform === "win32" ? path.join(root, "assets", "branding", "app-icon.ico") : undefined,
      ignore: [
        /^\/test(?:\/|$)/,
        /^\/dist(?:\/|$)/,
        /^\/(?:AGENTS|AI_USAGE_AUDIT|TRY_STATUS_AUDIT)\.md$/,
        /^\/\.env(?:$|\.)/,
      ],
    });
    const resources = path.join(output[0], ...(platform === "darwin"
      ? [`${branding.APP_NAME}.app`, "Contents", "Resources"] : ["resources"]));
    const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
    const sharp = `sharp-${platform}-${arch}`;
    const sharpFiles = await readdir(path.join(unpacked, "@img", sharp, "lib"));
    if (!sharpFiles.some(file => file.endsWith(".node"))) {
      throw new Error(`Missing ${sharp} native module in ${target} package.`);
    }
    const ort = path.join(unpacked, "onnxruntime-node", "bin", "napi-v6", platform, arch);
    await access(path.join(ort, "onnxruntime_binding.node"));
    await access(path.join(ort, platform === "win32" ? "onnxruntime.dll"
      : platform === "linux" ? "libonnxruntime.so.1" : "libonnxruntime.1.dylib"));
    await verifyPackagedVectorSearch(resources, { platform, arch });
    process.stdout.write(`${output.join("\n")}\n`);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(runtimeStage, { recursive: true, force: true });
  }
}
