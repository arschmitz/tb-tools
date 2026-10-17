import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Include standalone Node so direct app launches do not depend on shell PATH.
export async function prepareNodeRuntime(directory, { platform = process.platform, arch = process.arch } = {}) {
  const runtime = path.join(directory, "node-runtime");
  await mkdir(runtime, { recursive: true });
  const executable = path.join(runtime, platform === "win32" ? "node.exe" : "node");
  if (platform === process.platform && arch === process.arch && !process.versions.electron) {
    await copyFile(process.execPath, executable);
  } else {
    const version = process.version;
    const base = `https://nodejs.org/dist/${version}/`;
    const stem = `node-${version}-${platform}-${arch}`;
    const filename = platform === "win32" ? `${stem}/node.exe` : `${stem}.tar.gz`;
    const [manifest, download] = await Promise.all([fetch(`${base}SHASUMS256.txt`), fetch(base + filename)]);
    if (!manifest.ok || !download.ok) throw new Error(`Could not download Node.js for ${platform}:${arch}.`);
    const expected = (await manifest.text()).split("\n").find(line => line.endsWith(`  ${filename}`))?.split(" ")[0];
    const bytes = Buffer.from(await download.arrayBuffer());
    if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("Node.js download checksum did not match its release manifest.");
    }
    if (platform === "win32") await writeFile(executable, bytes);
    else {
      const archive = path.join(directory, `${stem}.tar.gz`);
      await writeFile(archive, bytes);
      await promisify(execFile)("tar", ["-xzf", archive, "-C", directory, `${stem}/bin/node`]);
      await copyFile(path.join(directory, stem, "bin", "node"), executable);
    }
  }
  await chmod(executable, 0o755);
  await writeFile(path.join(runtime, "version.json"), JSON.stringify({ version: process.version, platform, arch }));
  // Confirm the copied executable has content before handing it to the packager.
  if (!(await stat(executable)).size) throw new Error("The bundled Node.js executable is empty.");
  return runtime;
}
