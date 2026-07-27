import path from "node:path";
import hljs from "highlight.js";

const HIGHLIGHT_LANGUAGE_BY_EXTENSION = new Map([
  [".c", "c"],
  [".cc", "cpp"],
  [".cjs", "javascript"],
  [".cpp", "cpp"],
  [".css", "css"],
  [".ftl", "ini"],
  [".h", "cpp"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".html", "xml"],
  [".ini", "ini"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".md", "markdown"],
  [".mm", "objectivec"],
  [".mozbuild", "python"],
  [".py", "python"],
  [".rs", "rust"],
  [".scss", "scss"],
  [".sh", "bash"],
  [".toml", "ini"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".xml", "xml"],
  [".xhtml", "xml"],
  [".xul", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);
const HIGHLIGHT_LANGUAGE_BY_BASENAME = new Map([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["moz.build", "python"],
  ["moz.configure", "python"],
  ["package-lock.json", "json"],
  ["package.json", "json"],
]);

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function splitPrettyDiffFiles(diff) {
  const files = {};
  let filename;

  for (const line of diff.split("\n")) {
    if (!line || line.startsWith("*")) {
      continue;
    }

    if (line.startsWith("diff --")) {
      filename = line.replace(/^diff --(?:cc |git a\/)(\S+).*$/, "$1");
      files[filename] = [];
    }

    if (filename) {
      files[filename].push(line);
    }
  }

  return Object.keys(files).length ? files : null;
}

function parseDiffHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

  if (!match) {
    return null;
  }

  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function isOldFileMarker(line) {
  return /^--- /.test(line);
}

function isNewFileMarker(line) {
  return /^\+\+\+ /.test(line);
}

function isDiffMetadataLine(line) {
  return (
    line.startsWith("diff --") ||
    line.startsWith("index ") ||
    isOldFileMarker(line) ||
    isNewFileMarker(line) ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ")
  );
}

function getDiffLineNumbers(line, state) {
  const hunk = parseDiffHunkHeader(line);

  if (hunk) {
    state.oldLine = hunk.oldLine;
    state.newLine = hunk.newLine;
    return { oldLine: "", newLine: "" };
  }

  const inHunk = state.oldLine !== null && state.newLine !== null;

  if (!inHunk) {
    return { oldLine: "", newLine: "" };
  }

  if (line.startsWith("+")) {
    return { oldLine: "", newLine: state.newLine++ };
  }

  if (line.startsWith("-")) {
    return { oldLine: state.oldLine++, newLine: "" };
  }

  if (line.startsWith(" ")) {
    return {
      oldLine: state.oldLine++,
      newLine: state.newLine++,
    };
  }

  return { oldLine: "", newLine: "" };
}

function getDiffLineClass(line, state) {
  const inHunk = state.oldLine !== null && state.newLine !== null;

  if (!inHunk && isDiffMetadataLine(line)) {
    return "file";
  }

  if (line.startsWith("@@")) {
    return "info";
  }

  if (line.startsWith("+")) {
    return "insert";
  }

  if (line.startsWith("-")) {
    return "delete";
  }

  if (line.startsWith(" ")) {
    return "context";
  }

  return "file";
}

function shouldRenderDiffLine(line, state) {
  const inHunk = state.oldLine !== null && state.newLine !== null;

  return inHunk || line.startsWith("@@") || !isDiffMetadataLine(line);
}

function countDiffChanges(lines) {
  let inHunk = false;

  return lines.reduce((counts, line) => {
    if (parseDiffHunkHeader(line)) {
      inHunk = true;
    } else if (line.startsWith("+") && (inHunk || !isNewFileMarker(line))) {
      counts.insertions++;
    } else if (line.startsWith("-") && (inHunk || !isOldFileMarker(line))) {
      counts.deletions++;
    }

    return counts;
  }, { insertions: 0, deletions: 0 });
}

export function formatChangeCountLabel(insertions, deletions) {
  const additionLabel = insertions === 1 ? "addition" : "additions";
  const deletionLabel = deletions === 1 ? "deletion" : "deletions";

  return `${insertions} ${additionLabel} and ${deletions} ${deletionLabel}`;
}

export function getDiffChangeCounts(diff) {
  const files = splitPrettyDiffFiles(diff);

  if (!files) {
    return { insertions: 0, deletions: 0 };
  }

  return Object.values(files).reduce((totals, lines) => {
    const { insertions, deletions } = countDiffChanges(lines);

    totals.insertions += insertions;
    totals.deletions += deletions;

    return totals;
  }, { insertions: 0, deletions: 0 });
}

function getHighlightLanguage(file) {
  const normalized = String(file || "").toLowerCase();
  const basename = path.basename(normalized);

  if (HIGHLIGHT_LANGUAGE_BY_BASENAME.has(basename)) {
    return HIGHLIGHT_LANGUAGE_BY_BASENAME.get(basename);
  }

  if (basename.endsWith(".sys.mjs")) {
    return "javascript";
  }

  const extension = path.extname(basename);
  return HIGHLIGHT_LANGUAGE_BY_EXTENSION.get(extension) || "";
}

function highlightDiffCode(content, language) {
  if (!language || !content) {
    return escapeDiffHtml(content);
  }

  if (!hljs.getLanguage(language)) {
    return escapeDiffHtml(content);
  }

  try {
    return hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    }).value;
  } catch {
    return escapeDiffHtml(content);
  }
}

function formatDiffLineContent(line, className, language) {
  if (className === "insert" || className === "delete" || className === "context") {
    const marker = className === "context" ? " " : line.charAt(0);
    const content = line.slice(1);

    return `<span class="line-marker">${escapeDiffHtml(marker)}</span><span class="line-content">${highlightDiffCode(content, language)}</span>`;
  }

  return `<span class="line-marker"></span><span class="line-content">${escapeDiffHtml(line)}</span>`;
}

function escapeDiffHtml(value = "") {
  return String(value)
    .replace(/\$/g, "$$$$")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\t/g, "    ");
}

export function formatPrettyDiffHtml(diff) {
  const files = splitPrettyDiffFiles(diff);

  if (!files) {
    return "";
  }

  return Object.entries(files).map(([file, lines]) => {
    const { insertions, deletions } = countDiffChanges(lines);
    const changeCountLabel = formatChangeCountLabel(insertions, deletions);
    const language = getHighlightLanguage(file);
    const lineNumberState = { oldLine: null, newLine: null };
    const diffLines = lines.reduce((rendered, line) => {
      if (!shouldRenderDiffLine(line, lineNumberState)) {
        return rendered;
      }

      const { oldLine, newLine } = getDiffLineNumbers(line, lineNumberState);
      const className = getDiffLineClass(line, lineNumberState);

      rendered.push(`<tr class="diff-line ${className}">
          <td class="line-number old-line">${oldLine}</td>
          <td class="line-number new-line">${newLine}</td>
          <td class="line-code">${formatDiffLineContent(line, className, language)}</td>
        </tr>`);
      return rendered;
    }, []).join("\n");

    return `<section class="pretty-file">
      <h3>
        <span class="file-heading">
          <span class="file-icon" aria-hidden="true"></span>
          <span class="title">${escapeDiffHtml(file)}</span>
        </span>
        <span class="file-actions">
          <span class="file-stats" aria-label="${changeCountLabel}">
            <span class="stat-additions">+${insertions}</span>
            <span class="stat-deletions">-${deletions}</span>
          </span>
          <button class="copy-path" type="button" data-path="${escapeHtml(file)}">Copy path</button>
        </span>
      </h3>
      <div class="file-diff"><table class="diff-table"><tbody>${diffLines}</tbody></table></div>
    </section>`;
  }).join("\n");
}
