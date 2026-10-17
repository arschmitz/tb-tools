import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import branding from "./branding.cjs";
import { prepareNodeRuntime } from "./node-runtime.mjs";

export async function prepareDesktopRuntime({ projectRoot, env = process.env }) {
  const require = createRequire(path.join(projectRoot, "package.json"));
  const { version } = JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8"));
  const key = createHash("sha256").update(JSON.stringify([
    projectRoot, version, process.platform, process.arch, branding.APP_NAME, 5, process.version,
  ])).digest("hex").slice(0, 20);
  const cache = env.TB_DESKTOP_RUNTIME_CACHE || path.join(os.homedir(), ".tb-tools", "desktop-runtime");
  const destination = path.join(cache, key);
  const executable = branding.packagedExecutable(destination);
  if (existsSync(executable)) return { executable, args: [] };

  await mkdir(cache, { recursive: true });
  const stage = await mkdtemp(path.join(cache, "prepare-"));
  try {
    const source = path.join(stage, "source");
    await mkdir(source);
    await writeFile(path.join(source, "package.json"), JSON.stringify({
      name: "thunderbird-cli", productName: branding.APP_NAME, version: "1.0.0", main: "main.cjs",
    }));
    // The branded bundle loads current source on every launch.
    await writeFile(path.join(source, "main.cjs"),
      `require(${JSON.stringify(path.join(projectRoot, "desktop", "main.cjs"))});\n`);
    const { packager } = require("@electron/packager");
    const nodeRuntime = await prepareNodeRuntime(stage);
    const [output] = await packager({
      dir: source, out: path.join(stage, "output"), name: branding.APP_NAME,
      executableName: branding.EXECUTABLE_NAME, appBundleId: branding.APP_ID,
      extendInfo: { CFBundleName: branding.APP_NAME, CFBundleDisplayName: branding.APP_NAME },
      electronVersion: version, platform: process.platform, arch: process.arch,
      prune: false, quiet: true,
      extraResource: [nodeRuntime],
      icon: path.join(projectRoot, "assets", "branding", process.platform === "darwin"
        ? "app-icon.icns" : process.platform === "win32" ? "app-icon.ico"
          : "thunderbird-development-dashboard-app-icon-v2.png"),
      win32metadata: { ProductName: branding.APP_NAME, FileDescription: branding.APP_NAME },
    });
    try { await rename(output, destination); }
    catch (error) { if (!existsSync(executable)) throw error; }
    return { executable, args: [] };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
