import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Extract evidence, not verdicts. AI still checks ambiguous and additional errors.
export async function getTrySignatures(job, cache = new Map()) {
  const signatures = new Set();
  for (const log of job.logs || []) {
    if (!["errorsummary_json", "live_backing_log"].includes(log.name)) continue;
    const key = log.fullLogPath || log;
    if (!cache.has(key)) cache.set(key, (async () => {
      let lines = (log.text || "").split("\n");
      if (log.fullLogPath) {
        try {
          await access(log.fullLogPath);
          lines = createInterface({ input: createReadStream(log.fullLogPath), crlfDelay: Infinity });
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const found = new Set();
      for await (const line of lines) {
        if (log.name === "errorsummary_json") {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (!record || typeof record !== "object") continue;
          if (record.action === "test_result" && record.expected !== undefined && record.status !== record.expected) {
            found.add(JSON.stringify({ test: record.test, subtest: record.subtest, status: record.status, expected: record.expected, message: record.message }));
          } else if (record.action === "log" && ["ERROR", "CRITICAL"].includes(record.level)) {
            found.add(String(record.message || "").trim());
          }
        } else if (/TEST-UNEXPECTED-|\bfatal error:|\berror:|Rust dependencies are out of sync/i.test(line)) {
          // Remove only the log clock and severity prefix. Keep error details exact.
          found.add(line.replace(/^\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*[- ]\s*(?:INFO|ERROR|WARNING)?\s*[- ]?\s*/, "").trim());
        }
      }
      return [...found].filter(Boolean);
    })());
    for (const signature of await cache.get(key)) signatures.add(signature);
  }
  return [...signatures];
}
