import { run } from "../../lib/utils.mjs";
import { getTbToolsIdFromCommitMessage } from "../../lib/commit-message.mjs";

// A rebase changes hashes. Require both the stable ID and the same changes.
export async function findTryFixupMonitor({ graph, hash, monitors, runCommand = run }) {
  const available = monitors.filter(state => state.fixupHash && state.phase !== "squashed");
  const exact = available.find(state => state.fixupHash === hash);
  if (exact || !available.length) return exact;
  const git = async (...args) => String(await runCommand({ cmd: "git", args, cwd: graph.path, capture: true, silent: true })).trim();
  const id = getTbToolsIdFromCommitMessage(await git("show", "-s", "--format=%B", hash));
  if (!id) return undefined;
  for (const state of available) {
    const oldId = getTbToolsIdFromCommitMessage(await git("show", "-s", "--format=%B", state.fixupHash));
    if (id === oldId && await sameCommitChanges(graph.path, hash, state.fixupHash, runCommand)) return state;
  }
  return undefined;
}

export async function sameCommitChanges(cwd, first, second, runCommand = run) {
  const patchId = async hash => String(await runCommand({ cmd: "sh", args: ["-c",
    'git show --format= --patch --find-renames --no-ext-diff --no-color "$1" | git patch-id --stable',
    "tb-tools-fixup-id", hash], cwd, capture: true, silent: true })).trim().split(/\s+/)[0];
  const firstId = await patchId(first);
  return Boolean(firstId) && firstId === await patchId(second);
}
