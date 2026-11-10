// Safe Markdown for report briefs and Obsidian notes. The text is parsed into
// a small block/inline tree and rendered as React elements: no HTML string is
// ever injected (no dangerouslySetInnerHTML), links are limited to http(s)
// and mailto, and images are never fetched (they show as a labelled
// placeholder, so a note cannot make the browser call another site).

const MAX_BLOCKS = 4000;

function isSafeHref(href) {
  return /^(https?:\/\/|mailto:)/i.test(String(href || "").trim());
}

/** Inline tokens: text, strong, em, code, del, mark, link, wikilink, image. */
export function parseInline(text = "") {
  const tokens = [];
  const source = String(text);
  const pattern =
    /(`+)([^`]+?)\1|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|==([^=]+)==|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) tokens.push({ type: "text", text: source.slice(last, match.index) });
    if (match[2] !== undefined) tokens.push({ type: "code", text: match[2] });
    else if (match[4] !== undefined) tokens.push({ type: "image", alt: match[3] || "image" });
    else if (match[5] !== undefined) tokens.push({ type: "wikilink", text: (match[6] || match[5]).trim() });
    else if (match[7] !== undefined) {
      tokens.push(
        isSafeHref(match[8])
          ? { type: "link", href: match[8], children: parseInline(match[7]) }
          : { type: "text", text: match[7] }
      );
    } else if (match[9] !== undefined || match[10] !== undefined) {
      tokens.push({ type: "strong", children: parseInline(match[9] ?? match[10]) });
    } else if (match[11] !== undefined) tokens.push({ type: "del", children: parseInline(match[11]) });
    else if (match[12] !== undefined) tokens.push({ type: "mark", children: parseInline(match[12]) });
    else if (match[13] !== undefined || match[14] !== undefined) {
      tokens.push({ type: "em", children: parseInline(match[13] ?? match[14]) });
    } else if (match[15] !== undefined) tokens.push({ type: "link", href: match[15], children: [{ type: "text", text: match[15] }] });
    last = pattern.lastIndex;
  }
  if (last < source.length) tokens.push({ type: "text", text: source.slice(last) });
  return tokens;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Block tree: heading, paragraph, list, quote, code, hr, table, properties. */
export function parseMarkdown(text = "") {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, lineIndex) => lineIndex > 0 && line.trim() === "---");
    if (end > 0) {
      blocks.push({ type: "properties", text: lines.slice(1, end).join("\n") });
      index = end + 1;
    }
  }

  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s*(```|~~~)\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", language: fence[2] || "", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n")) });
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitTableRow(line).map((cell) => parseInline(cell));
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]).map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /\d/.test(listItem.exec(line)[2]);
      const items = [];
      while (index < lines.length && listItem.test(lines[index])) {
        const [, , marker, content] = listItem.exec(lines[index]);
        if (/\d/.test(marker) !== ordered) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
        items.push(
          task
            ? { checked: task[1].toLowerCase() === "x", children: parseInline(task[2]) }
            : { checked: null, children: parseInline(content) }
        );
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s/.test(lines[index]) &&
      !/^\s*(```|~~~)/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !listItem.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

function renderInline(tokens, keyPrefix = "i") {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "code":
        return <code key={key}>{token.text}</code>;
      case "strong":
        return <strong key={key}>{renderInline(token.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(token.children, key)}</em>;
      case "del":
        return <del key={key}>{renderInline(token.children, key)}</del>;
      case "mark":
        return <mark key={key}>{renderInline(token.children, key)}</mark>;
      case "link":
        return (
          <a key={key} href={token.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(token.children, key)}
          </a>
        );
      case "wikilink":
        return (
          <span key={key} className="rpt-md__wikilink">
            {token.text}
          </span>
        );
      case "image":
        return (
          <span key={key} className="rpt-md__image">
            [image: {token.alt}]
          </span>
        );
      default: {
        const parts = String(token.text).split("\n");
        return parts.map((part, partIndex) =>
          partIndex === 0 ? (
            <span key={`${key}-${partIndex}`}>{part}</span>
          ) : (
            <span key={`${key}-${partIndex}`}>
              <br />
              {part}
            </span>
          )
        );
      }
    }
  });
}

function renderBlocks(blocks, keyPrefix = "b") {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case "heading": {
        // Brief headings sit below the page's h1/h2, so they start at h3.
        const Tag = `h${Math.min(6, block.level + 2)}`;
        return <Tag key={key}>{renderInline(block.children, key)}</Tag>;
      }
      case "code":
        return (
          <pre key={key}>
            <code>{block.text}</code>
          </pre>
        );
      case "properties":
        return (
          <pre key={key} className="rpt-md__properties" aria-label="Note properties">
            <code>{block.text}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} />;
      case "quote":
        return <blockquote key={key}>{renderBlocks(block.children, key)}</blockquote>;
      case "table":
        return (
          <div key={key} className="rpt-md__table-wrap">
            <table>
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th key={cellIndex} scope="col">
                      {renderInline(cell, `${key}-h${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{renderInline(cell, `${key}-${rowIndex}-${cellIndex}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag key={key}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className={item.checked === null ? undefined : "rpt-md__task"}>
                {item.checked === null ? null : (
                  <span className="rpt-md__checkbox" aria-label={item.checked ? "Done" : "Not done"}>
                    {item.checked ? "☑" : "☐"}
                  </span>
                )}
                {renderInline(item.children, `${key}-${itemIndex}`)}
              </li>
            ))}
          </ListTag>
        );
      }
      default:
        return <p key={key}>{renderInline(block.children, key)}</p>;
    }
  });
}

/** Renders Markdown text safely. */
export default function Markdown({ text, className = "" }) {
  const blocks = parseMarkdown(text);
  if (!blocks.length) return null;
  return <div className={`rpt-md${className ? ` ${className}` : ""}`}>{renderBlocks(blocks)}</div>;
}
