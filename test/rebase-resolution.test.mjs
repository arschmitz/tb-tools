import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { proposeRebaseResolution, applyRebaseResolution } from "../commands/graph/rebase-resolution.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "resolution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a"), "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> topic\n");
  await writeFile(path.join(root, "b"), "second conflict\n");
  const session = { graph: { path: root }, conflictCommit: "abcdef", conflictFiles: ["a", "b"] };
  return { session, runCommand: async () => "unchanged", root };
}

test("incomplete, duplicate, out-of-scope and marker results change no files", async t => {
  const options = await fixture(t);
  const before = await readFile(path.join(options.root, "a"), "utf8");
  for (const files of [
    [{ path: "a", content: "ok" }],
    [{ path: "a", content: "ok" }, { path: "a", content: "ok" }],
    [{ path: "a", content: "ok" }, { path: "../other", content: "ok" }],
    [{ path: "a", content: before }, { path: "b", content: "ok" }],
  ]) {
    await assert.rejects(proposeRebaseResolution({ ...options, generate: async () => JSON.stringify({ files }) }));
    assert.equal(await readFile(path.join(options.root, "a"), "utf8"), before);
    assert.equal(options.session.resolutionBusy, false);
  }
});

test("manual edits after review prevent both continue and rollback", async t => {
  const options = await fixture(t);
  const proposal = await proposeRebaseResolution({ ...options, generate: async () => JSON.stringify({ files: [
    { path: "a", edits: [{ startLine: 1, endLine: 5, text: "resolved" }] }, { path: "b", delete: true },
  ] }) });
  await assert.rejects(readFile(path.join(options.root, "b")), { code: "ENOENT" });
  await writeFile(path.join(options.root, "a"), "manual change");
  for (const cancel of [false, true]) {
    await assert.rejects(applyRebaseResolution({ ...options, id: proposal.id, cancel }), /checkout changed/);
  }
  assert.equal(await readFile(path.join(options.root, "a"), "utf8"), "manual change");
});

test("targeted edits preserve surrounding text and cancel restores exact files", async t => {
  const options = await fixture(t);
  const original = "prefix\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> topic\nsuffix without newline";
  await writeFile(path.join(options.root, "a"), original);
  const progress = [];
  const proposal = await proposeRebaseResolution({ ...options, onProgress: event => progress.push(event),
    generate: async prompt => {
      assert.match(prompt, /never complete file contents/);
      return JSON.stringify({ files: [
        { path: "a", edits: [{ startLine: 2, endLine: 6, text: "left and right\n" }] },
        { path: "b", edits: [{ startLine: 1, endLine: 0, text: "inserted\n" }] },
      ] });
    } });
  assert.equal(await readFile(path.join(options.root, "a"), "utf8"), "prefix\nleft and right\nsuffix without newline");
  assert.equal(await readFile(path.join(options.root, "b"), "utf8"), "inserted\nsecond conflict\n");
  assert.match(proposal.html, /class="pretty-file"/);
  assert.match(proposal.html, /class="diff-table"/);
  assert.ok(progress.some(event => /Checking/.test(event.message)));
  await applyRebaseResolution({ ...options, id: proposal.id, cancel: true });
  assert.equal(await readFile(path.join(options.root, "a"), "utf8"), original);
  assert.equal(await readFile(path.join(options.root, "b"), "utf8"), "second conflict\n");
});

test("bad ranges and remaining markers reject the entire proposal before writing", async t => {
  const options = await fixture(t);
  const original = await readFile(path.join(options.root, "a"), "utf8");
  for (const edits of [
    [{ startLine: 0, endLine: 5, text: "ok" }],
    [{ startLine: 1, endLine: 6, text: "ok" }],
    [{ startLine: 1, endLine: 5, text: "ok" }, { startLine: 4, endLine: 5, text: "overlap" }],
    [{ startLine: 1, endLine: 0, text: "x" }, { startLine: 1, endLine: 0, text: "y" }],
    [{ startLine: 3, endLine: 2, text: "still conflicted" }],
    [{ startLine: 1, endLine: 5, text: "<<<<<<< HEAD\n" }],
  ]) {
    await assert.rejects(proposeRebaseResolution({ ...options, generate: async () => JSON.stringify({ files: [
      { path: "b", delete: true }, { path: "a", edits },
    ] }) }));
    assert.equal(await readFile(path.join(options.root, "a"), "utf8"), original);
    assert.equal(await readFile(path.join(options.root, "b"), "utf8"), "second conflict\n");
  }
});

test("failed AI calls and overlapping requests leave conflict files intact", async t => {
  const options = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = proposeRebaseResolution({ ...options, generate: async () => {
    await gate;
    throw new Error("AI failed");
  } });
  await assert.rejects(proposeRebaseResolution(options), /already pending/);
  await assert.rejects(applyRebaseResolution(options), /still running/);
  release();
  await assert.rejects(pending, /AI failed/);
  assert.match(await readFile(path.join(options.root, "a"), "utf8"), /<<<<<<< HEAD/);
});
