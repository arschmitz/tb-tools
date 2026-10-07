import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function recordAiUsage(record) {
  const directory = path.join(os.homedir(), ".tb-tools");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(path.join(directory, "ai-usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", { mode: 0o600 });
}

export function getAiUsageBlock(error, now = Date.now()) {
  if (error?.code !== "usage_limit_exceeded" && !/hit your usage limit|usage_limit_exceeded/i.test(error?.message || "")) return null;
  const reset = error.retryAt ?? Date.parse((error.message.match(/try again at (.+?)(?:\.|$)/i)?.[1] || "")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1"));
  return { retryAt: Number.isFinite(reset) && reset > now ? reset : null, message: error.message };
}
