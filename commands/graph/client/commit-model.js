export function pruneLoadedParents(commits) {
  const knownHashes = new Set(commits.map((commit) => commit.hash));

  return commits.map((commit) => ({
    ...commit,
    parents: commit.parents.filter((parent) => knownHashes.has(parent)),
  }));
}

export function getCommitSnapshotFingerprint(commit) {
  return [
    commit.hash,
    (commit.parents || []).join(","),
    (commit.refs || []).join(","),
    commit.subject || "",
    commit.workingTree ? "working" : "commit",
    commit.changeId || "",
    (commit.tryRuns || []).map((run) => run.id || run.url).join(","),
  ].join("\u001f");
}

export function getSnapshotFingerprint({ branch = "", workingTreeCount = 0, commits = [] } = {}) {
  return [
    branch,
    String(workingTreeCount || 0),
    commits.map(getCommitSnapshotFingerprint).join("\u001e"),
  ].join("\u001d");
}

export function getStateSnapshotFingerprint(state) {
  return getSnapshotFingerprint({
    branch: state.graph.branch,
    workingTreeCount: state.workingTreeCount,
    commits: state.commits,
  });
}


export function isCurrentCommit(commit) {
  return Array.isArray(commit.refs) && commit.refs.includes("HEAD");
}

export function isWorkingTreeCommit(commit) {
  return Boolean(commit && commit.workingTree);
}

export function placeWorkingTreeCommits(commits) {
  const orderedCommits = commits.filter((commit) => !isWorkingTreeCommit(commit));
  const workingTreeCommits = commits.filter(isWorkingTreeCommit);

  for (const commit of workingTreeCommits) {
    const parentHash = commit.parents && commit.parents[0];
    const parentIndex = orderedCommits.findIndex((item) => item.hash === parentHash);

    if (parentIndex === -1) {
      orderedCommits.unshift(commit);
    } else {
      orderedCommits.splice(parentIndex, 0, commit);
    }
  }

  return orderedCommits;
}

export function getCurrentCommitHash(commits) {
  return commits.find(isCurrentCommit)?.hash || "";
}

export function formatCommitTitle(commit) {
  if (isWorkingTreeCommit(commit)) {
    return commit.subject;
  }

  return commit.hash.substring(0, 12) + " " + commit.subject;
}

export function formatCommitMeta(commit) {
  if (isWorkingTreeCommit(commit)) {
    return "Current staged, unstaged, and untracked changes";
  }

  return commit.author.name + " <" + commit.author.email + ">";
}

