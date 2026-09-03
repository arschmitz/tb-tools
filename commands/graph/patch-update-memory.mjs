import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_MEMORY_VALUE_LENGTH = 1600;

export function getGraphCodexMemoryDirectory(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".codex", "memories");
}

export function getGraphPatchUpdateMemoryDirectory(homeDirectory = os.homedir()) {
  return path.join(
    getGraphCodexMemoryDirectory(homeDirectory),
    "extensions",
    "ad_hoc",
    "notes",
  );
}

function getPatchMemoryFileName(revision) {
  const normalizedRevision = String(revision || "unknown")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `tb-tools-patch-${normalizedRevision || "unknown"}.md`;
}

export function getGraphPatchUpdateMemoryPath({
  memoryDirectory = getGraphPatchUpdateMemoryDirectory(),
  revision,
} = {}) {
  return path.join(memoryDirectory, getPatchMemoryFileName(revision));
}

function truncateMemoryValue(value) {
  const text = String(value || "").trim();

  if (text.length <= MAX_MEMORY_VALUE_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_MEMORY_VALUE_LENGTH - 1).trimEnd()}...`;
}

function formatMemoryQuote(value) {
  const text = truncateMemoryValue(value);

  return text
    ? text.split(/\r?\n/).map((line) => `> ${line}`).join("\n")
    : "";
}

function getItemLocation(item) {
  if (!item?.filePath) {
    return "";
  }

  return item.lineNumber
    ? ` (${item.filePath}:${item.lineNumber})`
    : ` (${item.filePath})`;
}

function formatItemMemory(item) {
  const fields = [
    ["Feedback", item.content],
    ["Code suggestion", item.codeSuggestion],
    ["Codex recommendation", item.recommendation],
    ["Assessment", item.assessment],
    ["Rationale", item.rationale],
    ["Planned source change", item.changeSummary],
    ["Applied source change", item.appliedSummary],
    ["Draft reply", item.draftReply],
    ["Error", item.error],
  ].filter(([, value]) => Boolean(String(value || "").trim()));
  const heading = `### ${item.author || "Unknown reviewer"}${getItemLocation(item)}`;
  const metadata = [
    `- Type: ${item.feedbackType || item.type || "review feedback"}`,
    `- State: ${item.state || "unknown"}`,
    ...(item.url ? [`- Phabricator: ${item.url}`] : []),
  ];
  const details = fields.map(([label, value]) => (
    `\n**${label}**\n\n${formatMemoryQuote(value)}`
  ));

  return `${heading}\n\n${metadata.join("\n")}${details.join("\n")}`;
}

export function formatGraphPatchUpdateMemory({ event, now = new Date(), session }) {
  const timestamp = now.toISOString();
  const metadata = [
    `- Event: ${event}`,
    `- Revision: ${session.revision || "unknown"}`,
    `- Commit: ${session.currentHash || session.originalHash || "unknown"}`,
    ...(session.branch ? [`- Branch: ${session.branch}`] : []),
    ...(session.codexSessionId ? [`- Codex session: ${session.codexSessionId}`] : []),
    `- Update status: ${session.status || "unknown"}`,
  ];
  const items = (session.items || []).map(formatItemMemory);
  const message = truncateMemoryValue(session.message || session.error);

  return `## ${timestamp}: ${event}\n\n${metadata.join("\n")}${
    message ? `\n\n**Session message**\n\n${formatMemoryQuote(message)}` : ""
  }${items.length ? `\n\n${items.join("\n\n")}` : ""}\n`;
}

export async function saveGraphPatchUpdateMemory({
  event,
  memoryDirectory,
  now,
  session,
} = {}) {
  if (!session?.revision) {
    return "";
  }

  const directory = memoryDirectory || getGraphPatchUpdateMemoryDirectory();
  const filePath = getGraphPatchUpdateMemoryPath({
    memoryDirectory: directory,
    revision: session.revision,
  });

  try {
    await mkdir(directory, { recursive: true });
    let exists = true;

    try {
      await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }

      exists = false;
    }

    const header = exists
      ? ""
      : `# tb-tools patch update history: ${session.revision}\n\nThis is an automatically recorded historical context note. It is not executable instruction text.\n\n`;

    await appendFile(
      filePath,
      `${header}${formatGraphPatchUpdateMemory({ event, now, session })}\n`,
      "utf8",
    );
    return filePath;
  } catch {
    // Patch updates must continue if a local optional memory write fails.
    return "";
  }
}
