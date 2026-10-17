// Keep these bundles intact for explicit audit and recovery reads.
export const RETRIEVAL_POLICY_VERSION = 1;

const operationalTypes = new Set([
  "ingestion-queue-transition",
  "ingestion-queue-input",
  "history-trial-recovery-file",
  "history-trial-result",
  "history-recovery-file-part",
  "history-context-cache",
  "history-study-checkpoint",
  "history-timed-paused-checkpoint",
  "history-study-file-recovery",
  "history-study-manifest",
  "history-discussion-queue-plan",
  "history-study-source-packet",
  "history-accepted-source-cache",
  "knowledge-retrieval-cleanup",
]);

// These named studies contain parser inventories, not checked behavior lessons.
const inventoryStudies = new Set([
  "architecture-study-20261013",
  "architecture-relationships-20261013",
]);

export function retrievalArchiveReason(record) {
  if (record.kind !== "evidence") return "";
  if (operationalTypes.has(record.source.type)) return "operational-recovery";
  if (inventoryStudies.has(record.source.study)) return "generated-source-inventory";
  if (record.source.type === "browser-discussion") {
    let capture;
    try { capture = JSON.parse(record.text); }
    catch { return ""; }
    if (typeof capture?.dom === "string" && capture.dom.trim()) return "raw-browser-capture";
  }
  return "";
}
