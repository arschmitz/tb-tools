import { spawn } from "node:child_process";

function processGit(args, options = {}) {
  const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-64000); });
  const timer = setTimeout(() => child.kill(), 30_000);
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Knowledge Git failed (${code}): ${errors}`)));
  }).finally(() => clearTimeout(timer));
  // stdout parsing can fail before the child completes.
  completed.catch(() => {});
  child.stdin.on("error", () => {});
  return { child, completed };
}

export async function gitInput(args, input, options = {}) {
  const { child, completed } = processGit(args, options);
  child.stdin.end(input);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > 8_000_000) throw new Error("Knowledge Git output is too large.");
      chunks.push(chunk);
    }
    await completed;
    return Buffer.concat(chunks).toString("utf8").trim();
  } catch (error) { child.kill(); await completed.catch(() => {}); throw error; }
}

export async function readGitBlobs(entries, consume, options = {}) {
  if (!entries.length) return;
  const prefix = options.gitDirectory ? ["--git-dir", options.gitDirectory] : [];
  const { child, completed } = processGit([...prefix, "cat-file", "--batch"], options);
  child.stdin.end(entries.map(entry => entry.oid + "\n").join(""));
  let buffer = Buffer.alloc(0), header = null, index = 0;
  try {
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (!header) {
          const newline = buffer.indexOf(10);
          if (newline < 0) break;
          const match = buffer.subarray(0, newline).toString("ascii").match(/^([a-f0-9]+) blob (\d+)$/);
          if (!match || match[1] !== entries[index]?.oid) throw new Error("Invalid knowledge Git blob response.");
          header = { size: Number(match[2]) };
          if (header.size > 4_000_000) throw new Error("Knowledge file is too large.");
          buffer = buffer.subarray(newline + 1);
        }
        if (buffer.length < header.size + 1) break;
        if (buffer[header.size] !== 10) throw new Error("Invalid knowledge Git blob boundary.");
        await consume(entries[index++], buffer.subarray(0, header.size).toString("utf8"));
        buffer = buffer.subarray(header.size + 1); header = null;
      }
    }
    await completed;
    if (header || buffer.length || index !== entries.length) throw new Error("Incomplete knowledge Git blob response.");
  } catch (error) { child.kill(); await completed.catch(() => {}); throw error; }
}

export async function addGitRecords(records, store, gitDirectory, env, nameFor) {
  for (const record of records) {
    // The immutable store has already validated these files during reconciliation.
    if (!store.get(record.id)) throw new Error("Unknown knowledge record.");
  }
  const blobs = (await gitInput(["--git-dir", gitDirectory, "hash-object", "-w", "--stdin-paths"],
    records.map(record => JSON.stringify(store.file(record))).join("\n") + "\n", { env })).split("\n");
  if (blobs.length !== records.length || blobs.some(oid => !/^[a-f0-9]{40,64}$/.test(oid))) throw new Error("Invalid knowledge blob IDs.");
  await gitInput(["--git-dir", gitDirectory, "update-index", "--index-info"],
    records.map((record, index) => `100644 ${blobs[index]}\t${nameFor(record)}\n`).join(""), { env });
}
