import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import branding from "./branding.cjs";

export const releaseTargets = [
  { platform: "darwin", arch: "arm64", os: "macos", format: "dmg" },
  { platform: "win32", arch: "x64", os: "windows", format: "nsis" },
  { platform: "linux", arch: "x64", os: "linux", format: "AppImage" },
];

export function releaseAsset({ platform, arch, version }) {
  const target = releaseTargets.find(item => item.platform === platform && item.arch === arch);
  if (!target) throw new Error(`Unsupported release target: ${platform}:${arch}.`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("A release needs a valid package version.");
  const extension = target.format === "nsis" ? "exe" : target.format;
  return `Thunderbird-Development-Dashboard-${version}-${target.os}-${arch}.${extension}`;
}

export function releasePlan({ root, platform, arch, version }) {
  const asset = releaseAsset({ platform, arch, version });
  const target = releaseTargets.find(item => item.platform === platform && item.arch === arch);
  const directory = path.join(root, "dist", "release-work", `${platform}-${arch}`);
  const packaged = path.join(directory, `${branding.APP_NAME}-${platform}-${arch}`);
  const prepackaged = platform === "darwin" ? path.join(packaged, `${branding.APP_NAME}.app`) : packaged;
  const output = path.join(directory, "installers");
  return { asset, directory, packaged, prepackaged, output,
    downloads: path.join(root, "dist", "downloads"),
    config: {
      appId: branding.APP_ID, productName: branding.APP_NAME,
      executableName: branding.EXECUTABLE_NAME, artifactName: asset,
      directories: { output }, npmRebuild: false, publish: null,
      mac: { target: ["dmg"], identity: null, icon: path.join(root, "assets", "branding", "app-icon.icns") },
      win: { target: ["nsis"], icon: path.join(root, "assets", "branding", "app-icon.ico") },
      nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
      linux: { target: ["AppImage"], category: "Development", executableName: branding.EXECUTABLE_NAME,
        icon: path.join(root, "assets", "branding", "thunderbird-development-dashboard-app-icon-v2.png") },
    },
    builderArgs: ["--prepackaged", prepackaged, "--publish", "never",
      { darwin: "--mac", win32: "--win", linux: "--linux" }[platform], target.format, `--${arch}`],
  };
}

export function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`${path.basename(executable)} failed (${signal || code}).`)));
  });
}

export async function checksum(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyMacInstaller(installer, { run = runProcess } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-dmg-verify-"));
  let mounted = false;
  try {
    await run("hdiutil", ["attach", installer, "-readonly", "-nobrowse", "-mountpoint", directory]);
    mounted = true;
    await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2",
      path.join(directory, `${branding.APP_NAME}.app`)]);
  } finally {
    if (mounted) await run("hdiutil", ["detach", directory]);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildRelease({ root = path.resolve(import.meta.dirname, ".."),
  platform = process.platform, arch = process.arch, run = runProcess } = {}) {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error("Build release downloads on a machine with the target operating system and architecture.");
  }
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const plan = releasePlan({ root, platform, arch, version });
  await mkdir(plan.directory, { recursive: true });
  const config = path.join(plan.directory, "builder.json");
  await writeFile(config, JSON.stringify(plan.config, null, 2));
  const env = { ...process.env, TB_DESKTOP_PACKAGE_OUT: plan.directory,
    CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  await run(process.execPath, [path.join(root, "desktop", "package.mjs"), `${platform}:${arch}`], { cwd: root, env });
  if (platform === "darwin") {
    await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", plan.prepackaged], { cwd: root, env });
  }
  const require = createRequire(path.join(root, "package.json"));
  await run(process.execPath, [require.resolve("electron-builder/cli.js"),
    ...plan.builderArgs, "--config", config], { cwd: root, env });
  const installer = path.join(plan.output, plan.asset);
  await access(installer);
  if (platform === "darwin") await verifyMacInstaller(installer, { run });
  // Test the packaged app before staging a download for upload.
  await run(process.execPath, [path.join(root, "desktop", "release-smoke.mjs"), plan.packaged], { cwd: root, env });
  await mkdir(plan.downloads, { recursive: true });
  const download = path.join(plan.downloads, plan.asset);
  await copyFile(installer, download);
  await writeFile(`${download}.sha256`, `${await checksum(download)}  ${plan.asset}\n`);
  console.log(`Download ready: ${download}`);
  return download;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRelease();
}
