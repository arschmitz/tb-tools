import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKnowledge } from "../commands/knowledge/generate.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../commands/knowledge/", import.meta.url));

test("console knowledge helpers record, search, read, and sync in isolation", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-standalone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const copy = path.join(directory, "package"), data = path.join(directory, "data");
  await cp(root, copy, { recursive: true, filter: file => !["node_modules", ".git", "test"].includes(path.basename(file)) });
  const input = path.join(directory, "evidence.json");
  await writeFile(input, JSON.stringify({ repository: "thunderbird", title: "Focus review",
    text: "Wait for the attendee render before checking focus.", paths: ["calendar/dialog.js"],
    source: { type: "review-feedback", reference: "https://example.invalid/D123" } }));
  const run = async (...args) => JSON.parse((await execute(process.execPath,
    [path.join(copy, "cli.mjs"), ...args, "--directory", data], { cwd: directory })).stdout);
  const record = await run("record", "--file", input);
  assert.equal(record.visibility, "private");
  assert.equal((await run("show", record.id)).text, record.text);
  assert.ok((await run("search", "--repository", "thunderbird", "attendee focus")).ids.includes(record.id));
  assert.equal((await run("sync")).remote.localOnly, true);
  assert.equal((await run("status")).directory, data);
  assert.match(await readFile(path.join(data, "AGENTS.md"), "utf8"), /unique\nMarkdown note/);
  assert.equal((await execute("git", ["--git-dir", path.join(data, "history.git"), "ls-tree", "-r", "--name-only", "main"])).stdout.trim(),
    `private/records/${record.id}.json`);
});

test("console learning uses a temporary read-only session with native memory disabled", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tb-generator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "fake-codex");
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync('args.json', JSON.stringify(args));
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"lessons":[]}'));
`);
  await chmod(command, 0o700);
  await mkdir(path.join(directory, "work"));
  assert.equal(await generateKnowledge("Exact evidence", { command, directory: path.join(directory, "work") }), '{"lessons":[]}');
  const args = JSON.parse(await readFile(path.join(directory, "work/args.json"), "utf8"));
  assert.ok(args.includes("memories.generate_memories=false"));
  assert.ok(args.includes("memories.use_memories=false"));
  assert.ok(args.includes("--ephemeral"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});
