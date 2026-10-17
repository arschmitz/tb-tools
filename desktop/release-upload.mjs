import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { releaseAsset, releaseTargets, checksum } from "./release.mjs";
import branding from "./branding.cjs";

export function validateReleaseTag(tag, version) {
  if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Release tag must match package.json: v${version}.`);
  }
}

export async function updateDraft({ action, tag, version, repository, root = path.resolve(import.meta.dirname, ".."),
  platform = process.platform, arch = process.arch, execute = promisify(execFile) }) {
  validateReleaseTag(tag, version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) throw new Error("Set GH_REPO to the owner/repository.");
  const gh = args => execute("gh", [...args, "--repo", repository], { cwd: root, maxBuffer: 1024 * 1024 });
  const draft = async () => {
    const { stdout } = await gh(["release", "view", tag, "--json", "isDraft,assets"]);
    const release = JSON.parse(stdout);
    if (!release.isDraft) throw new Error("This release is already published. Use a new version; published downloads are not replaced.");
    return release;
  };
  if (action === "prepare") {
    await execute("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`], { cwd: root, maxBuffer: 1024 * 1024 });
    try {
      await draft();
    } catch (error) {
      if (!/release not found|HTTP 404/i.test(error.stderr || error.message)) throw error;
      await gh(["release", "create", tag, "--draft", "--verify-tag", "--title", `${branding.APP_NAME} ${tag} — building`,
        "--notes", "Build incomplete. Do not publish this draft until all three platform builds and startup checks pass."]);
      return;
    }
    await gh(["release", "edit", tag, "--title", `${branding.APP_NAME} ${tag} — building`,
      "--notes", "Build incomplete. A rebuild is in progress. Do not publish until all three platform checks pass."]);
    return;
  }
  if (action === "upload") {
    const asset = releaseAsset({ platform, arch, version });
    const download = path.join(root, "dist", "downloads", asset);
    const expected = `${await checksum(download)}  ${asset}\n`;
    if (await readFile(`${download}.sha256`, "utf8") !== expected) throw new Error("The download checksum did not match.");
    await draft();
    await gh(["release", "upload", tag, download, `${download}.sha256`, "--clobber"]);
    return;
  }
  if (action !== "finish") throw new Error("Unknown draft-release action.");
  const release = await draft();
  const expected = releaseTargets.flatMap(target => {
    const asset = releaseAsset({ ...target, version });
    return [asset, `${asset}.sha256`];
  });
  if (expected.some(name => !release.assets.some(asset => asset.name === name && asset.size > 0))) {
    throw new Error("The draft is missing a platform download or checksum. Keep it unpublished.");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tb-release-notes-"));
  try {
    const notes = path.join(temporary, "notes.txt");
    await writeFile(notes, `All three native package builds and first-run startup checks passed. Ready for review.\n\n` +
      `Downloads\n\n` +
      `- macOS Apple Silicon (arm64): open the DMG and drag the app to Applications. Intel Macs are not supported by this release.\n` +
      `- Windows x64: run the EXE installer.\n` +
      `- Linux x64: make the AppImage executable, then open it.\n\n` +
      `Each download includes its own SHA-256 checksum file.\n\n` +
      `These builds are unsigned and are not notarized. macOS or Windows may block them or show a security prompt.\n` +
      `The app bundles Node.js. Developing Thunderbird still requires Git, Python 3, and the platform prerequisites shown by setup.\n\n` +
      `Validation covers packaging, bundled native vector search, and first-run UI startup. It does not run a full Thunderbird checkout download, bootstrap, or build.\n`);
    await gh(["release", "edit", tag, "--title", `${branding.APP_NAME} ${tag}`, "--notes-file", notes]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await updateDraft({ action: process.argv[2], tag: process.env.RELEASE_TAG,
    repository: process.env.GH_REPO || process.env.GITHUB_REPOSITORY, version });
}
