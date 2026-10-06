import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODEX_MEMORY_ARGS } from "./instructions.mjs";

// Learning is a bounded, read-only call. It never creates a native memory input.
export async function generateKnowledge(prompt, { command = "codex", directory, signal } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "tb-knowledge-learning-"));
  const output = path.join(temporary, "answer.txt");
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(command, ["exec", ...CODEX_MEMORY_ARGS,
        "-c", "approval_policy=\"never\"", "--sandbox", "read-only",
        "--ephemeral", "--skip-git-repo-check", "--output-last-message", output, "-"],
      { cwd: directory, signal, timeout: 90_000, maxBuffer: 2_000_000 },
      error => error ? reject(error) : resolve());
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    return await readFile(output, "utf8");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
