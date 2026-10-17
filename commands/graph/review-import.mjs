import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePatch } from "diff";

function command(session, runCommand, args) {
  if (session.cancelled) throw Object.assign(new Error("Review import cancelled."), { code: "ABORT_ERR" });
  return runCommand({ cmd: "git", args, cwd: session.graph.path, capture: true, silent: true,
    signal: session.abortController?.signal });
}

function patchFiles(diff) {
  if (/GIT binary patch|^Binary files|^(?:old|new) mode |^new file mode (?!100644$)/m.test(diff)) {
    throw new Error("This patch needs manual import because it changes binary content or file permissions.");
  }
  const files = new Set();
  for (const patch of parsePatch(diff)) {
    for (const name of [patch.oldFileName, patch.newFileName]) {
      if (!name || name === "/dev/null") continue;
      const file = name.replace(/^[ab]\//, "");
      if (path.isAbsolute(file) || /[\0\r\n]/.test(file) || file.split(/[\\/]/).some(part =>
        !part || part === "." || part === ".." || part.toLowerCase() === ".git") || file.startsWith('"')) {
        throw new Error("This patch needs manual import because a file path cannot be resolved safely.");
      }
      files.add(file);
    }
  }
  if (!files.size) throw new Error("No text files were found in the review patch.");
  return [...files];
}

async function commitPatch(session, runCommand) {
  const patch = session.importPatches[session.importIndex];
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-review-message-"));
  try {
    const file = path.join(directory, "message");
    await writeFile(file, patch.body, { mode: 0o600 });
    await command(session, runCommand, ["commit", "--allow-empty", "-F", file,
      ...(patch.author ? [`--author=${patch.author}`] : []),
      ...(Number.isInteger(patch.date) ? [`--date=@${patch.date} +0000`] : [])]);
    session.currentHash = String(await command(session, runCommand, ["rev-parse", "HEAD"])).trim();
    session.importIndex++;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function importConflict(session, files, cause) {
  session.conflictCommit = session.importPatches[session.importIndex].revision;
  session.conflictFiles = files;
  const error = new Error(`Resolve ${session.conflictCommit} against current main.`, { cause });
  error.rebaseState = session;
  error.rebaseConflict = { type: "conflict", graphIndex: session.graphIndex,
    conflictCommit: session.conflictCommit, canContinue: true, label: session.graph.label,
    files: files.map(file => ({ path: file, absolutePath: path.join(session.graph.path, file) })),
    output: String(cause?.stderr || cause?.message || cause) };
  return error;
}

async function replay(session, runCommand) {
  while (session.importIndex < session.importPatches.length) {
    const patch = session.importPatches[session.importIndex];
    const files = patchFiles(patch.diff);
    const directory = await mkdtemp(path.join(os.tmpdir(), "tb-review-patch-"));
    try {
      const file = path.join(directory, "incoming.patch");
      await writeFile(file, patch.diff, { mode: 0o600 });
      try {
        await command(session, runCommand, ["apply", "--index", file]);
      } catch (error) {
        if (session.cancelled || error.code === "ABORT_ERR") throw error;
        throw importConflict(session, files, error);
      }
      await commitPatch(session, runCommand);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { currentHash: session.currentHash };
}

export async function startReviewImport({ session, patches, runCommand }) {
  if (!(session.graph.taskWorktree || session.graph.checkout === "review") ||
      String(session.graph.repository || "").toLowerCase() !== "comm" || !session.reviewMainHash) {
    throw new Error("Review import requires its configured Review comm checkout and pinned main.");
  }
  const requested = patches.findIndex(patch => patch.body?.match(/Differential Revision:\s*https?:\/\/[^/\s]+\/(D\d+)\b/)?.[1] === session.revision);
  if (requested < 0) throw new Error("The exported stack does not contain the requested revision.");
  const importPatches = patches.slice(0, requested + 1).map(patch => {
    if (typeof patch.diff !== "string" || typeof patch.body !== "string") throw new Error("Invalid exported review patch.");
    patchFiles(patch.diff);
    const revision = patch.body.match(/Differential Revision:\s*https?:\/\/[^/\s]+\/(D\d+)\b/)?.[1];
    if (!revision) throw new Error("An exported patch has no revision identity.");
    return { ...patch, revision };
  });
  for (const operation of ["rebase", "cherry-pick", "am"]) {
    await command(session, runCommand, [operation, "--abort"]).catch(error => {
      if (session.cancelled || error.code === "ABORT_ERR") throw error;
    });
  }
  await command(session, runCommand, ["reset", "--hard"]);
  await command(session, runCommand, ["switch", "--detach", session.reviewMainHash]);
  const state = { kind: "review-import", graph: session.graph, graphIndex: session.graphIndex,
    patchReviewSessionId: session.id, currentHash: session.reviewMainHash, importIndex: 0, importPatches,
    abortController: session.abortController };
  return replay(state, runCommand);
}

export async function continueReviewImport({ session, runCommand }) {
  const head = String(await command(session, runCommand, ["rev-parse", "HEAD"])).trim();
  if (head !== session.currentHash) throw new Error("The review checkout moved after this import paused.");
  for (const file of session.conflictFiles) {
    const content = await readFile(path.join(session.graph.path, file), "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (/^(?:<{7,}|={7,}|>{7,})(?: |$)/m.test(content)) throw new Error("Remove conflict markers before continuing the review import.");
  }
  await command(session, runCommand, ["add", "-A", "--", ...session.conflictFiles]);
  const staged = String(await command(session, runCommand, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  if (staged.some(file => !session.conflictFiles.includes(file))) throw new Error("The index contains changes outside the review patch.");
  await commitPatch(session, runCommand);
  delete session.conflictCommit;
  delete session.conflictFiles;
  return replay(session, runCommand);
}
