// Baseline logs remain available on disk. Do not retain another copy of
// every excerpt while collecting 150 comparison pushes.
export function compactTryBaseline(push) {
  for (const failure of push.failures || []) {
    for (const log of failure.logs || []) {
      if (log.fullLogPath) delete log.text;
    }
  }
  return push;
}

export function compactTryEvidence(evidence) {
  for (const push of evidence.baseline || []) compactTryBaseline(push);
  return evidence;
}
