import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import { consoleKnowledgeDirectory as knowledgeDirectory } from "../knowledge-service.mjs";
import path from "node:path";
import { getDefaultKnowledgeService } from "../knowledge-service.mjs";

const MAX_MEMORY_VALUE_LENGTH = 1600;

// History events repeat every comment snapshot. Keep field changes in order,
// including reversals, and leave text outside the known record format intact.
export function compactGraphPatchUpdateHistory(text) {
  const previous = new Map();
  let omitted = 0;
  const compacted = String(text || "").split("\n\n---\n\n").map((section) =>
    section.split(/(?=^## \d{4}-\d{2}-\d{2}T[^\n]+\n)/m).map((event) => {
      if (!/^## \d{4}-\d{2}-\d{2}T/.test(event)) return event;
      const [header, ...items] = event.split(/(?=^### )/m);
      const changes = items.map((item) => {
        const parts = item.split(/^\*\*([^\n]+)\*\*\s*\n/m);
        const metadata = parts[0].trim();
        if (parts.length < 3 || !/^- State: /m.test(metadata)) return item;
        const fields = new Map();
        for (let index = 1; index < parts.length; index += 2) {
          const value = parts[index + 1].trim();
          if (!value.split("\n").every((line) => !line.trim() || line.startsWith(">"))) return item;
          if (fields.has(parts[index])) return item;
          fields.set(parts[index], value);
        }
        const identity = metadata.replace(/^- State: .*\n?/m, "").trim();
        const last = previous.get(identity);
        previous.set(identity, { metadata, fields });
        if (!last) return item;
        const changed = [...fields].filter(([key, value]) => last.fields.get(key) !== value);
        for (const key of last.fields.keys()) {
          if (!fields.has(key)) changed.push([key, "> (cleared in this record)"]);
        }
        omitted += [...fields].filter(([key, value]) => last.fields.get(key) === value).length;
        if (!changed.length && metadata === last.metadata) return "";
        return `${metadata}\n\n${changed.map(([key, value]) => `**${key}**\n\n${value}`).join("\n\n")}\n\n`;
      });
      return header + changes.join("");
    }).join(""),
  ).join("\n\n---\n\n");
  return omitted
    ? `[Repeated history fields removed: ${omitted}. Records below show changes in order. Unchanged fields retain their earlier values. Commit, event, and state changes remain.]\n\n${compacted}`
    : compacted;
}

// Review comments can each carry the same full patch. Store each distinct diff
// once in prompt data while retaining every comment, anchor, and suggestion.
export function compactGraphPatchReviewContext(review) {
  if (!review || typeof review !== "object") return review;
  const ids = new Map();
  const sharedDiffs = {};
  const reference = value => {
    if (typeof value !== "string" || !value) return value;
    if (!ids.has(value)) {
      const id = `diff-${ids.size + 1}`;
      ids.set(value, id);
      sharedDiffs[id] = value;
    }
    return { sharedDiff: ids.get(value) };
  };
  const compactComment = comment => ({ ...comment,
    ...(typeof comment.contextDiff === "string" ? { contextDiff: reference(comment.contextDiff) } : {}),
  });
  return { ...review,
    ...(typeof review.rawPatch === "string" ? { rawPatch: reference(review.rawPatch) } : {}),
    ...(Array.isArray(review.comments) ? { comments: review.comments.map(compactComment) } : {}),
    ...(Array.isArray(review.inlineComments) ? { inlineComments: review.inlineComments.map(compactComment) } : {}),
    sharedDiffs,
  };
}

export function getGraphPatchUpdateMemoryDirectory(homeDirectory = os.homedir()) {
  return path.join(knowledgeDirectory(undefined, homeDirectory), "private", "patch-history");
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
    ["Validation", item.validation],
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

  try { await (await getDefaultKnowledgeService())?.captureReview({ event, session }); }
  catch { /* Optional learning must not hide the patch update result. */ }

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
