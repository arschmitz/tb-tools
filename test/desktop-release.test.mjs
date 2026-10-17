import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildRelease, releasePlan, releaseTargets, releaseAsset, checksum, verifyMacInstaller } from "../desktop/release.mjs";
import { updateDraft, validateReleaseTag } from "../desktop/release-upload.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const version = "1.2.3";
const tag = `v${version}`;
const repository = "example/dashboard";

test("release formats cover Apple Silicon, Windows, and Linux without implicit publishing", () => {
  const names = releaseTargets.map(target => releaseAsset({ ...target, version }));
  assert.equal(new Set(names).size, 3, "Each target should have a unique download name.");
  for (const target of releaseTargets) {
    const plan = releasePlan({ ...target, root: "/project", version });
    assert.ok(plan.builderArgs.includes("never"), "The installer builder should never publish downloads itself.");
    assert.equal(plan.config.publish, null, "The installer config should disable implicit publishing.");
    assert.ok(plan.prepackaged.endsWith(target.platform === "darwin" ? ".app" : `${target.platform}-${target.arch}`),
      "The installer should reuse the validated packaged app.");
    assert.match(plan.asset, target.platform === "darwin" ? /\.dmg$/ : target.platform === "win32" ? /\.exe$/ : /\.AppImage$/,
      "The target should produce its native download format.");
  }
  assert.throws(() => releaseAsset({ platform: "linux", arch: "arm64", version }), /Unsupported/, "Unsupported architectures should fail explicitly.");
  assert.throws(() => releaseAsset({ platform: "darwin", arch: "x64", version }), /Unsupported/, "Intel Macs should be excluded from this release.");
});

test("tag and version checks reject mismatches and shell metacharacters", () => {
  assert.doesNotThrow(() => validateReleaseTag(tag, version), "A matching version tag should be accepted.");
  assert.throws(() => validateReleaseTag("v2.0.0", version), /must match/, "A mismatched tag should fail before building or uploading.");
  assert.throws(() => validateReleaseTag("v1.2.3;echo bad", "1.2.3;echo bad"), /must match/,
    "A tag with shell metacharacters should be rejected.");
});

test("download staging follows successful packaging and startup and includes a checksum", async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const plan = releasePlan({ root, platform: process.platform, arch: process.arch, version });
  const calls = [];
  const download = await buildRelease({ root, run: async (_executable, args, options) => {
    calls.push(args);
    if (options) assert.equal(options.env.CSC_IDENTITY_AUTO_DISCOVERY, "false", "Release builds should not discover a local signing identity.");
    if (args.includes("--prepackaged")) {
      await mkdir(plan.output, { recursive: true });
      await writeFile(path.join(plan.output, plan.asset), "installer bytes");
    }
  } });
  assert.equal(calls.length, process.platform === "darwin" ? 7 : 3, "A release should complete all packaging and validation steps.");
  assert.ok(calls.at(-1)[0].endsWith("release-smoke.mjs"), "The last step before staging should exercise packaged startup.");
  assert.equal(await readFile(`${download}.sha256`, "utf8"), `${await checksum(download)}  ${plan.asset}\n`,
    "The staged checksum should match the download bytes.");
  await assert.rejects(buildRelease({ root, run: async () => { throw new Error("package failed"); } }), /package failed/,
    "A packaging failure should stop the release build.");
});

test("a damaged Mac installer fails verification and releases its temporary mount", async () => {
  const calls = [];
  let mount;
  await assert.rejects(verifyMacInstaller("/fixture/download.dmg", { run: async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "attach") mount = args.at(-1);
    if (command === "codesign") throw new Error("invalid bundle signature");
  } }), /invalid bundle signature/, "An invalid signature should reject the installer check.");
  assert.deepEqual(calls.at(-1), ["hdiutil", ["detach", mount]], "A failed signature check should detach the disk image.");
  await assert.rejects(readFile(mount), { code: "ENOENT" }, "A detached verification mount should be removed.");
});

test("an invalid Mac bundle signature stops the release before installer creation", { skip: process.platform !== "darwin" }, async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  const calls = [];
  await assert.rejects(buildRelease({ root, run: async (command, args) => {
    calls.push([command, args]);
    if (command === "codesign") throw new Error("invalid bundle signature");
  } }), /invalid bundle signature/, "An invalid package signature should stop the release.");
  assert.equal(calls.length, 2, "A failed signature check should prevent installer creation and startup.");
  await assert.rejects(readFile(path.join(root, "dist", "downloads")), { code: "ENOENT" },
    "An invalid package should not stage any downloads.");
});

test("release preparation creates only a draft and refuses published releases", async () => {
  const calls = [];
  const execute = async (_executable, args) => {
    calls.push(args);
    if (args[1] === "view") throw Object.assign(new Error("not found"), { stderr: "release not found" });
    return { stdout: "" };
  };
  await updateDraft({ action: "prepare", tag, version, repository, execute });
  assert.ok(calls[0].includes(`repos/${repository}/git/ref/tags/${tag}`), "Preparation should verify the remote tag even when a draft already exists.");
  assert.ok(calls[2].includes("--draft") && calls[2].includes("--verify-tag"), "Preparation should create an unpublished release for an existing tag.");
  for (const action of ["prepare", "finish"]) {
    await assert.rejects(updateDraft({ action, tag, version, repository,
      execute: async () => ({ stdout: JSON.stringify({ isDraft: false }) }) }), /already published/,
    "A published release should never be changed by preparation or finalization.");
  }
});

test("a missing remote tag stops preparation even if a draft could exist", async () => {
  const calls = [];
  await assert.rejects(updateDraft({ action: "prepare", tag, version, repository,
    execute: async (_executable, args) => {
      calls.push(args);
      if (args[0] === "api") throw new Error("HTTP 404: tag not found");
      return { stdout: JSON.stringify({ isDraft: true }) };
    } }), /tag not found/, "Preparation should require an actual Git tag before inspecting or changing a draft.");
  assert.equal(calls.length, 1, "A missing tag should prevent every release mutation.");
});

test("upload verifies download hashes and checks draft status before replacing assets", async t => {
  const root = await temporary(t);
  const asset = releaseAsset({ platform: process.platform, arch: process.arch, version });
  const downloads = path.join(root, "dist", "downloads");
  await mkdir(downloads, { recursive: true });
  const download = path.join(downloads, asset);
  await writeFile(download, "installer");
  await writeFile(`${download}.sha256`, `${await checksum(download)}  ${asset}\n`);
  const calls = [];
  const execute = async (_executable, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ isDraft: true, assets: [] }) };
  };
  await updateDraft({ action: "upload", tag, version, repository, root, execute });
  assert.equal(calls[0][1], "view", "Upload should check that the release is still a draft.");
  assert.equal(calls[1][1], "upload", "A checked draft should receive its target download and checksum.");
  await writeFile(download, "corrupted");
  await assert.rejects(updateDraft({ action: "upload", tag, version, repository, root, execute }), /checksum did not match/,
    "A changed download should fail before upload.");
});

test("finalization requires every platform download and keeps the release unpublished", async () => {
  const assets = releaseTargets.flatMap(target => {
    const name = releaseAsset({ ...target, version });
    return [{ name, size: 42 }, { name: `${name}.sha256`, size: 64 }];
  });
  const calls = [];
  let notes;
  const execute = async (_executable, args) => {
    calls.push(args);
    if (args.includes("--notes-file")) notes = await readFile(args[args.indexOf("--notes-file") + 1], "utf8");
    return { stdout: JSON.stringify({ isDraft: true, assets }) };
  };
  await updateDraft({ action: "finish", tag, version, repository, execute });
  assert.match(notes, /Ready for review/, "A complete draft should report that it is ready for review.");
  assert.match(notes, /unsigned/, "Release notes should state the signing limit.");
  assert.equal(calls.some(args => args.some(arg => arg === "--draft=false" || arg === "--publish")), false,
    "Finalization should leave publication to the user.");
  assets.pop();
  await assert.rejects(updateDraft({ action: "finish", tag, version, repository, execute }), /missing a platform/,
    "A missing download or checksum should keep the draft incomplete.");
});

test("workflow uses standard native runners and draft uploads without Actions artifact storage", async () => {
  const require = createRequire(import.meta.url);
  const yaml = require("js-yaml");
  const workflow = yaml.load(await readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(({ platform, arch }) => `${platform}:${arch}`),
    ["darwin:arm64", "win32:x64", "linux:x64"], "The workflow should build the three supported native targets.");
  assert.ok(workflow.jobs.finish.needs.includes("build"), "The ready state should require every matrix job to succeed.");
  assert.equal(workflow.jobs.prepare.steps[0].with.ref, "refs/tags/${{ env.RELEASE_TAG }}", "Preparation should check out a tag rather than a same-named branch.");
  assert.equal(workflow.jobs.build.steps[0].with.ref, "${{ needs.prepare.outputs.source }}", "All platform builds should use the same pinned source commit.");
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true, "Manual runs should require an existing release tag.");
  const actions = Object.values(workflow.jobs).flatMap(job => job.steps.map(step => step.uses || ""));
  assert.equal(actions.some(action => /upload-artifact|cache@/.test(action)), false, "Downloads should go directly to Releases without retained Actions artifacts.");
});
