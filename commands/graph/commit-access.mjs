import { run } from "../../lib/utils.mjs";

export async function ensureGraphCommit(graph, hash, runCommand = run) {
  if (!graph) {
    throw new Error("Unknown graph checkout.");
  }
  if (graph.knownHashes?.has(hash)) {
    return;
  }

  // Display pages are not a complete list of commits in the checkout.
  // Accept only object IDs here so user input cannot become a Git option or ref.
  if (typeof hash !== "string" || !/^[a-f0-9]{4,64}$/i.test(hash)) {
    throw Object.assign(new Error("Invalid commit ID."), { statusCode: 400 });
  }
  try {
    await runCommand({
      cmd: "git",
      args: ["cat-file", "-e", `${hash}^{commit}`],
      cwd: graph.path,
      capture: true,
      silent: true,
    });
  } catch {
    throw Object.assign(new Error(`Commit ${hash} does not exist in ${graph.label || graph.path}.`), {
      statusCode: 404,
    });
  }
}
