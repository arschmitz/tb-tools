import { createHash } from "node:crypto";

export const SECTION_VERSION = 1;

export function sectionMetadata(record, text, context) {
  const paths = record.paths || [];
  const relevant = paths.length <= 8 ? paths : paths.filter(file => text.includes(file) || context.includes(file));
  const selected = relevant.slice(0, 8);
  return Object.fromEntries(Object.entries({
    repository: record.repository, component: record.component, paths: selected,
    ...(selected.length < paths.length ? { recordPathCount: paths.length } : {}),
    symbol: record.source.symbol, fileRole: record.source.fileRole,
    revision: record.source.revision,
  }).filter(([, value]) => value !== undefined));
}

// Offsets refer to UTF-16 characters in the immutable record text.
export function recordSections(record) {
  const text = record.text;
  const headings = [];
  const sections = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      headings.length = heading[1].length - 1;
      headings[heading[1].length - 1] = heading[2];
    }
    if (!sections.length || (heading && text.length > 1200) || offset - sections.at(-1).start + line.length > 1200) {
      sections.push({ start: offset, end: offset, headings: headings.filter(Boolean) });
    }
    // Long lines also need bounded inputs, including single-line symbol maps.
    for (let start = offset; start < offset + line.length;) {
      let section = sections.at(-1);
      if (section.end - section.start >= 1200) {
        section = { start, end: start, headings: headings.filter(Boolean) };
        sections.push(section);
      }
      const end = Math.min(offset + line.length, section.start + 1200);
      section.end = end;
      start = end;
    }
    offset += line.length;
  }
  return sections.map(section => {
    const context = [record.title, record.component, ...section.headings].filter(Boolean).join(" > ").slice(0, 400);
    const body = text.slice(section.start, section.end);
    const metadata = sectionMetadata(record, body, context);
    const input = `${context}\n${body}`;
    const id = createHash("sha256").update(JSON.stringify([SECTION_VERSION, record.id, section.start, section.end])).digest("hex");
    return { ...section, id, recordId: record.id, metadata, context, text: body, input };
  });
}
