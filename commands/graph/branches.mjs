export function getNextBugBranchName(branches = [], bugId) {
  const name = `Bug-${bugId}`;

  if (!branches.includes(name)) {
    return name;
  }

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dupTest = new RegExp(`^${escapedName}_([0-9]{1,3})$`);
  const patchCount = branches.reduce((highest, branch) => {
    const match = branch.match(dupTest);

    if (!match) {
      return highest;
    }

    return Math.max(highest, Number(match[1]) || 0);
  }, 1);

  return `${name}_${patchCount + 1}`;
}
export const isPrivateGraphBranch = branch => /^(?:tb-task|tb-try-workspace)\//.test(branch);

export function scopedGraphBranchRefs(graph, output) {
  return String(output).split(/\r?\n/).filter(branch => branch &&
    (graph.branchNamespace || !isPrivateGraphBranch(branch))).join("\n");
}

export async function captureGraphPatchSource({ graph, hash, runCommand }) {
  const output = await runCommand({ cmd: "git", args: ["for-each-ref", "--format=%(refname:short)%00%(objectname)",
    "--contains", hash, "refs/heads"], cwd: graph.path, capture: true, silent: true });
  return String(output).split(/\r?\n/).filter(Boolean).map(line => {
    const [branch, tip] = line.split("\0");
    return { branch, hash: tip };
  }).filter(entry => entry.branch !== "main" && !isPrivateGraphBranch(entry.branch));
}
