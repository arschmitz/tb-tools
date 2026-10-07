import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { packager } from "@electron/packager";

const root = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);
const electronVersion = JSON.parse(await readFile(path.join(root, "node_modules", "electron",
  "package.json"), "utf8")).version;
const targets = process.argv.slice(2).length ? process.argv.slice(2)
  : [`${process.platform}:${process.arch}`];
for (const target of targets) {
  const [platform, arch] = target.split(":");
  if (!["darwin", "win32", "linux"].includes(platform) ||
      !["x64", "arm64"].includes(arch) || target !== `${platform}:${arch}`) {
    throw new Error(`Invalid desktop target: ${target}. Use darwin:x64, darwin:arm64, win32:x64, win32:arm64, linux:x64, or linux:arm64.`);
  }
  const crossTarget = platform !== process.platform || arch !== process.arch;
  const stage = crossTarget ? await mkdtemp(path.join(os.tmpdir(), "tb-desktop-package-")) : null;
  try {
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
      name: "Thunderbird-Commands",
      platform,
      arch,
      electronVersion,
      out: process.env.TB_DESKTOP_PACKAGE_OUT || path.join(root, "dist"),
      overwrite: true,
      asar: { unpack: "**/*.{node,dll,dylib,so,so.*}" },
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
      ? ["Thunderbird-Commands.app", "Contents", "Resources"] : ["resources"]));
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
    process.stdout.write(`${output.join("\n")}\n`);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
