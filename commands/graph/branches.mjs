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
