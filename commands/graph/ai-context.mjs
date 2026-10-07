import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Store complete evidence outside the checkout. Stable paths survive resumed chats.
export async function saveAiContext(value, { directory = path.join(homedir(), ".tb-tools", "ai-context") } = {}) {
  const text = JSON.stringify(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(text).digest("hex");
  const file = path.join(directory, `${digest}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

export async function formatAiContext(value, { directory, maxChars = 12000 } = {}) {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  const file = await saveAiContext(value, { directory });
  return `Complete context: ${file}. Read the fields relevant to this turn in bounded sections. Reuse established findings from this conversation. Do not print the whole file or repeat unchanged research. No evidence has been removed.`;
}
