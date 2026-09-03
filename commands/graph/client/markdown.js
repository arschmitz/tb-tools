const FENCED_CODE_PATTERN = /^```([^`]*)\s*$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HORIZONTAL_RULE_PATTERN = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const ORDERED_LIST_PATTERN = /^\s*(\d+)[.)]\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^\s*[-+*]\s+(.+)$/;
const BLOCK_QUOTE_PATTERN = /^>\s?(.*)$/;
const TABLE_DIVIDER_CELL_PATTERN = /^:?-{3,}:?$/;
const INLINE_MARKUP_PATTERN = /`(?<code>[^`\r\n]+)`|\[(?<linkText>[^\]\r\n]+)\]\((?<linkUrl>[^)\s]+)(?:\s+"[^"]*")?\)|(?<strongMarker>\*\*|__)(?<strongText>[^\r\n]+?)\k<strongMarker>|~~(?<strikeText>[^~\r\n]+)~~|(?<emphasisMarker>\*|_)(?<emphasisText>[^*_\r\n]+?)\k<emphasisMarker>|<(?<autoLink>https?:\/\/[^>\s]+)>|(?<url>https?:\/\/[^\s<]+)/g;

function getSafeUrl(value) {
  try {
    const url = new URL(value, window.location.origin);

    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function appendLink(container, href, text) {
  const url = getSafeUrl(href);

  if (!url) {
    return false;
  }

  const link = document.createElement("a");

  link.href = url.href;
  link.rel = "noreferrer";
  link.target = "_blank";
  link.textContent = text;
  container.append(link);
  return true;
}

function appendInlineMarkdown(container, source = "") {
  const text = String(source);
  const pattern = new RegExp(INLINE_MARKUP_PATTERN.source, "g");
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    const groups = match.groups || {};

    container.append(document.createTextNode(text.slice(lastIndex, match.index)));
    if (groups.code !== undefined) {
      const code = document.createElement("code");

      code.className = "markdown-inline-code";
      code.textContent = groups.code;
      container.append(code);
    } else if (groups.linkText !== undefined) {
      if (!appendLink(container, groups.linkUrl, groups.linkText)) {
        container.append(document.createTextNode(match[0]));
      }
    } else if (groups.strongText !== undefined) {
      const strong = document.createElement("strong");

      appendInlineMarkdown(strong, groups.strongText);
      container.append(strong);
    } else if (groups.strikeText !== undefined) {
      const deleted = document.createElement("del");

      appendInlineMarkdown(deleted, groups.strikeText);
      container.append(deleted);
    } else if (groups.emphasisText !== undefined) {
      const emphasis = document.createElement("em");

      appendInlineMarkdown(emphasis, groups.emphasisText);
      container.append(emphasis);
    } else {
      const href = groups.autoLink || groups.url;

      if (!appendLink(container, href, href)) {
        container.append(document.createTextNode(match[0]));
      }
    }
    lastIndex = match.index + match[0].length;
  }

  container.append(document.createTextNode(text.slice(lastIndex)));
}

function getListItem(line) {
  const ordered = line.match(ORDERED_LIST_PATTERN);

  if (ordered) {
    return { content: ordered[2], ordered: true, start: ordered[1] };
  }

  const unordered = line.match(UNORDERED_LIST_PATTERN);

  return unordered ? { content: unordered[1], ordered: false } : null;
}

function getTableCells(line) {
  const content = line.trim().replace(/^\|/, "").replace(/\|$/, "");

  return content.split("|").map((cell) => cell.trim());
}

function isTableAt(lines, index) {
  const header = lines[index];
  const divider = lines[index + 1];

  if (!header?.includes("|") || !divider?.includes("|")) {
    return false;
  }

  const headers = getTableCells(header);
  const dividers = getTableCells(divider);

  return headers.length === dividers.length && dividers.every((cell) => (
    TABLE_DIVIDER_CELL_PATTERN.test(cell)
  ));
}

function appendParagraph(container, lines) {
  const paragraph = document.createElement("p");

  lines.forEach((line, index) => {
    appendInlineMarkdown(paragraph, line);
    if (index < lines.length - 1) {
      paragraph.append(document.createElement("br"));
    }
  });
  container.append(paragraph);
}

function appendCodeBlock(container, lines, language) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");

  pre.className = "markdown-code-block";
  if (language) {
    code.dataset.language = language;
  }
  code.textContent = lines.join("\n");
  pre.append(code);
  container.append(pre);
}

function appendList(container, lines, index) {
  const firstItem = getListItem(lines[index]);
  const list = document.createElement(firstItem.ordered ? "ol" : "ul");

  if (firstItem.ordered && firstItem.start !== "1") {
    list.start = Number(firstItem.start);
  }

  while (index < lines.length) {
    const item = getListItem(lines[index]);

    if (!item || item.ordered !== firstItem.ordered) {
      break;
    }

    const element = document.createElement("li");

    appendInlineMarkdown(element, item.content);
    list.append(element);
    index += 1;
  }

  container.append(list);
  return index;
}

function appendBlockQuote(container, lines, index) {
  const quote = document.createElement("blockquote");
  const quoteLines = [];

  while (index < lines.length) {
    const match = lines[index].match(BLOCK_QUOTE_PATTERN);

    if (!match) {
      break;
    }
    quoteLines.push(match[1]);
    index += 1;
  }

  appendParagraph(quote, quoteLines);
  container.append(quote);
  return index;
}

function appendTable(container, lines, index) {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const body = document.createElement("tbody");
  const headers = getTableCells(lines[index]);

  headers.forEach((header) => {
    const cell = document.createElement("th");

    appendInlineMarkdown(cell, header);
    headerRow.append(cell);
  });
  head.append(headerRow);
  index += 2;

  while (index < lines.length && lines[index].includes("|")) {
    const row = document.createElement("tr");
    const cells = getTableCells(lines[index]);

    headers.forEach((_, cellIndex) => {
      const cell = document.createElement("td");

      appendInlineMarkdown(cell, cells[cellIndex] || "");
      row.append(cell);
    });
    body.append(row);
    index += 1;
  }

  table.append(head, body);
  container.append(table);
  return index;
}

function isBlockStart(lines, index) {
  const line = lines[index] || "";

  return !line.trim() ||
    FENCED_CODE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    HORIZONTAL_RULE_PATTERN.test(line) ||
    BLOCK_QUOTE_PATTERN.test(line) ||
    Boolean(getListItem(line)) ||
    isTableAt(lines, index);
}

export function renderMarkdown(container, source = "") {
  if (!container) {
    return;
  }

  container.replaceChildren();
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");

  if (!String(source).trim()) {
    const empty = document.createElement("p");

    empty.className = "markdown-empty";
    empty.textContent = "No description.";
    container.append(empty);
    return;
  }

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const fence = line.match(FENCED_CODE_PATTERN);
    const heading = line.match(HEADING_PATTERN);

    if (!line.trim()) {
      index += 1;
    } else if (fence) {
      const code = [];

      index += 1;
      while (index < lines.length && !FENCED_CODE_PATTERN.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      appendCodeBlock(container, code, fence[1].trim());
    } else if (heading) {
      const element = document.createElement(`h${heading[1].length}`);

      appendInlineMarkdown(element, heading[2]);
      container.append(element);
      index += 1;
    } else if (HORIZONTAL_RULE_PATTERN.test(line)) {
      container.append(document.createElement("hr"));
      index += 1;
    } else if (BLOCK_QUOTE_PATTERN.test(line)) {
      index = appendBlockQuote(container, lines, index);
    } else if (getListItem(line)) {
      index = appendList(container, lines, index);
    } else if (isTableAt(lines, index)) {
      index = appendTable(container, lines, index);
    } else {
      const paragraph = [];

      while (index < lines.length && !isBlockStart(lines, index)) {
        paragraph.push(lines[index]);
        index += 1;
      }
      appendParagraph(container, paragraph);
    }
  }
}
