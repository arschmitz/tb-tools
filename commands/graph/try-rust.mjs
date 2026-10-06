import path from "node:path";
import { readFile } from "node:fs/promises";
import { run } from "../../lib/utils.mjs";
import { getGraphRustUpstreamStatus } from "./actions.mjs";

// Match the dependency check failure, not ordinary Rust compiler output.
export async function findRustDependencyFailure(evidence) {
  for (const failure of evidence.failures || []) {
    for (const log of failure.logs || []) {
      const text = log.fullLogPath ? await readFile(log.fullLogPath, "utf8") : log.text || "";
      if (/Rust dependencies are out of sync|vendored-rust-check[^\n]*Error 88/i.test(text)) {
        return { jobId: failure.id, url: log.url, signature: "Rust dependencies are out of sync" };
      }
    }
  }
  return null;
}

export async function checkRustOriginUpdate(state, { runCommand = run, getStatus = getGraphRustUpstreamStatus } = {}) {
  const commGraph = { path: state.path };
  const firefoxGraph = { path: state.geckoPath || path.dirname(state.path) };
  const git = (cwd, args) => runCommand({ cmd: "git", args, cwd, capture: true, silent: true, timeoutMs: 30000 });
  // Update remote refs only. Never change the user's branch or working files.
  await git(state.path, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const status = await getStatus({ commGraph, firefoxGraph, runCommand });
  const newCommCommits = Number((await git(state.path, ["rev-list", "--count", `${state.sourceHash}..${status.commLocalHash}`])).trim());
  return { ...status, available: status.upToDate && (newCommCommits > 0 || Boolean(state.geckoHash && state.geckoHash !== status.firefoxRemoteHash)) };
}
