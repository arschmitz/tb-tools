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
    (commit.tryRuns || []).map((run) => [run.id || run.url, run.status, run.checkedAt, run.updatedAt, run.activity, run.retryUrl, run.summary, run.error].join(":")).join(","),
    commit.tryFixup?.monitorId || "",
    JSON.stringify(commit.tryMonitor || null),
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


export function getTryResultLabel(status) {
  if (status === "passed") return "Pass";
  if (["patch-failed", "build-blocked", "failed-unclassified", "submission-failed"].includes(status)) return "Fail";
  if (["waiting", "analyzing", "repairing", "ready-to-submit", "submitting", "squashing", "needs-evidence"].includes(status)) return "Pending";
  return "Unknown";
}

export function getTryPillState(run) {
  const result = getTryResultLabel(run.status);
  let status = ({ Pass: "Passed", Fail: "Failed", Pending: "Pending", Unknown: "Not Determined" })[result];
  // Only legacy runs outside the monitor can be Not Determined.
  if (run.status === "failed-unclassified" || (result === "Unknown" && run.monitorId && !run.imported)) status = "Pending";
  let activity = "";
  if (run.status === "build-blocked") { status = "Failed"; activity = "No successful build"; }
  else if (result !== "Pass" && run.rustFailure) { status = "Failed"; activity = "Rust update needed"; }
  else if (result !== "Pass" && run.failureCategory === "comm-central") { status = "Failed"; activity = "Comm-Central Broken"; }
  else if (result !== "Pass" && run.phase === "paused") { activity = "Paused"; }
  else if (result !== "Pass" && run.workerRunning === false && ["analyzing", "needs-evidence", "repairing"].includes(run.phase)) {
    activity = run.error ? "Waiting to retry" : "Queued";
  }
  else if (status === "Pending" && run.phase !== "superseded" && /Fetching CI evidence/i.test(run.activity || "")) {
    activity = run.activity.replace(/Fetching CI evidence/i, "Collecting CI evidence");
  }
  else if (status === "Pending" && run.aiRunning === false && ["analyzing", "needs-evidence"].includes(run.phase)) {
    activity = "Preparing analysis";
  }
  else if (run.phase === "waiting-new-try") { activity = "Waiting for new run"; }
  else if (status === "Pending" && !run.imported && run.phase !== "superseded") {
    activity = run.statusComplete || ["analyzing", "needs-evidence", "failed-unclassified"].includes(run.status)
      ? "Analyzing Results" : "Waiting For Results";
  } else if (status === "Failed" && run.phase !== "superseded") {
    activity = run.status === "submission-failed" || ["ready-to-submit", "submitting"].includes(run.phase) || /Posting another Try/.test(run.activity || "")
      ? "Waiting for new run"
      : run.activity === "Running tests" ? "Running tests" : "Determining Fixes";
  }
  return { status, activity, color: ({ Passed: "pass", Failed: "fail", Pending: "pending", "Not Determined": "unknown" })[status],
    icon: ({ Passed: "✓", Failed: "✕", Pending: "◷", "Not Determined": "?" })[status] };
}

export function getTryStatusLabel(status) {
  return ({ passed: "Passed", waiting: "Waiting", analyzing: "Checking failures",
    repairing: "Fixing failures", "ready-to-submit": "Ready for Try", submitting: "Submitting",
    "failed-unclassified": "Run failed; cause not established", "build-blocked": "No successful build; patch not validated", "needs-evidence": "Needs investigation", "patch-failed": "Patch failures",
    "waiting-new-try": "Waiting for new run", "rust-blocked": "Failed due to Rust; waiting for origin update", "needs-rebase": "Needs a compatible current base", "submission-failed": "Push failed", squashing: "Amending", stale: "Earlier patch",
    superseded: "Superseded", paused: "Paused" })[status] || "Recorded";
}
