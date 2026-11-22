// Strip only closed comments from the display copy. Do not interpret other HTML,
// and preserve an unmatched opener and all subsequent text verbatim.
export function visibleTavernMessage(content) {
  let start = content.indexOf('<!--');
  let cursor = 0;
  const pieces = [];
  while (start !== -1) {
    const end = content.indexOf('-->', start + 4);
    if (end === -1) break;
    pieces.push(content.slice(cursor, start));
    cursor = end + 3;
    start = content.indexOf('<!--', cursor);
  }
  return cursor ? pieces.join('') + content.slice(cursor) : content;
}

function statusFields(body) {
  const lines = body.trim().split(/\r?\n/);
  if (/^`{3}(?:text|plaintext)?$/i.test(lines[0].trim())) {
    if (lines.at(-1).trim() !== '```') return null;
    lines.shift();
    lines.pop();
  }
  const fields = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const pair of line.split(/\s+\|\s+/)) {
      const match = /^([^:：<>]{1,64})[:：](.+)$/u.exec(pair.trim());
      if (!match || !match[1].trim() || !match[2].trim() || fields.length >= 64) return null;
      fields.push({ label: match[1].trim(), value: match[2].trim() });
    }
  }
  return fields.length ? fields : null;
}

// Display-only convention used by RPG cards. Unrecognized text stays literal,
// including malformed tags, HTML, and text following the status panel.
export function splitTavernStatusBlocks(content) {
  if (!content.includes('<')) return null;
  const sections = [];
  const tags = /^[\t ]*<(\/?)stats>[\t ]*\r?$/gim;
  let opening = null;
  let consumed = 0;
  let panelCount = 0;
  for (const tag of content.matchAll(tags)) {
    if (!tag[1]) {
      opening = tag;
      continue;
    }
    if (!opening) continue;
    const start = opening.index, inner = start + opening[0].length;
    opening = null;
    if (tag.index - inner > 8192) continue;
    const fields = statusFields(content.slice(inner, tag.index));
    if (!fields) continue;
    if (start > consumed) sections.push({ text: content.slice(consumed, start) });
    sections.push({ fields });
    consumed = tag.index + tag[0].length;
    if (++panelCount === 8) break;
  }
  if (!panelCount) return null;
  if (consumed < content.length) sections.push({ text: content.slice(consumed) });
  return sections;
}
