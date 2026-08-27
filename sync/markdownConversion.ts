export type ConversionStatus = "success" | "warning" | "unsafe" | "malformed";

export interface ConversionResult {
  status: ConversionStatus;
  markdown: string;
  warnings: string[];
  error?: string;
}

const CALLOUTS: Record<string, { icon: string; color: string }> = {
  note: { icon: "📝", color: "blue_bg" },
  abstract: { icon: "📋", color: "gray_bg" },
  info: { icon: "ℹ️", color: "blue_bg" },
  todo: { icon: "☑️", color: "blue_bg" },
  tip: { icon: "💡", color: "green_bg" },
  success: { icon: "✅", color: "green_bg" },
  question: { icon: "❓", color: "yellow_bg" },
  warning: { icon: "⚠️", color: "yellow_bg" },
  failure: { icon: "❌", color: "red_bg" },
  danger: { icon: "🚨", color: "red_bg" },
  bug: { icon: "🐛", color: "red_bg" },
  example: { icon: "🔎", color: "purple_bg" },
  quote: { icon: "💬", color: "gray_bg" }
};

const CALLOUT_ALIASES: Record<string, string> = { caution: "warning", attention: "warning", error: "failure" };
const NOTION_BACKGROUND_COLORS = new Set([
  "gray_bg", "brown_bg", "orange_bg", "yellow_bg", "green_bg", "blue_bg", "purple_bg", "pink_bg", "red_bg"
]);
const TABLE_MARKER = "<!-- llm-wiki-sync:table header-row=false -->";

export interface UnsupportedConstruct { construct: string; }

export function detectUnsupportedObsidianConstructs(markdown: string): UnsupportedConstruct | null {
  // Embeds must be found before heuristic inline-math protection, while true
  // literal regions (code, display math, frontmatter) remain opaque.
  const protectedInput = protectObsidianLiteralRegions(markdown, (value) => value, false);
  if (/!\[\[[^\]]+\]\]/.test(protectedInput.text)) return { construct: "Obsidian embed" };
  if (/!\[[^\]]*\]\([^)]*\)/.test(protectedInput.text)) return { construct: "Markdown image" };
  const noncanonicalList = /(?:^|\n)( +)(?=(?:[-*+] |\d+\. |- \[[ xX]\] ))/g;
  let indentation: RegExpExecArray | null;
  while ((indentation = noncanonicalList.exec(protectedInput.text)) !== null) {
    if (indentation[1].length % 4 !== 0) return { construct: "noncanonical nested list indentation" };
  }
  return null;
}

export function detectUnsupportedNotionConstructs(markdown: string): UnsupportedConstruct | null {
  const protectedInput = protectNotionLiteralRegions(markdown, (value) => value, false);
  const text = protectedInput.text;
  const unsafeCallout = detectUnsafeNotionCallout(text);
  if (unsafeCallout) return unsafeCallout;
  const patterns: Array<{ pattern: RegExp; construct: string }> = [
    { pattern: /<page\b/i, construct: "non-child Notion page reference" },
    { pattern: /<(?:folder|details|summary|meeting-notes|columns|column|tabs|tab|database|synced_block|synced_block_reference|table_of_contents|unknown|audio|video|file|pdf|embed|mention-[\w-]+)\b/i, construct: "unsupported Notion block" },
    { pattern: /!\[[^\]]*\]\([^)]*\)/, construct: "Notion image" },
    { pattern: /\[\^[^\]]+\]/, construct: "Notion citation" },
    { pattern: /:[A-Za-z0-9_-]+:/, construct: "Notion custom emoji" }
  ];
  for (const item of patterns) if (item.pattern.test(text)) return { construct: item.construct };
  if (/\{\s*toggle\s*=\s*["']true["'][^{}]*\}/i.test(text)) return { construct: "Notion toggle" };
  for (const line of text.split("\n")) {
    const match = line.match(/^(.*?)(?:\s+)?\{([^{}]+)\}\s*$/);
    if (!match) continue;
    const attributes = parseAttributes(match[2]);
    if (!attributes) return { construct: "malformed Notion block attributes" };
    if (attributes.toggle === "true") return { construct: "Notion toggle" };
    if (Object.keys(attributes).some((key) => key !== "color")) return { construct: "unsupported Notion block attributes" };
  }
  return null;
}

export function detectUnpreservableNotionFormatting(markdown: string): UnsupportedConstruct | null {
  const protectedInput = protectNotionLiteralRegions(markdown, (value) => value, false);
  if (/<table\b[^>]*(?:fit-page-width|header-column)|<(?:tr|td|col)\b[^>]*\bcolor=/i.test(protectedInput.text)) return { construct: "Notion table layout/color formatting" };
  if (/<span\b[^>]*\bcolor="(?!yellow_bg")/i.test(protectedInput.text)) return { construct: "Notion text/highlight color formatting" };
  if (/\{color="[^"]+"\}\s*$/m.test(protectedInput.text)) return { construct: "Notion block color formatting" };
  return null;
}

export function detectRemoteWriteBlocker(markdown: string): UnsupportedConstruct | null {
  return detectUnsupportedNotionConstructs(markdown) ?? detectUnpreservableNotionFormatting(markdown);
}

export function obsidianToNotionMarkdown(markdown: string): ConversionResult {
  const warnings: string[] = [];
  const unclosedFence = findUnclosedFence(markdown);
  if (unclosedFence) return malformedResult(markdown, `Unclosed ${unclosedFence} fenced code block.`);
  const unsupported = detectUnsupportedObsidianConstructs(markdown);
  if (unsupported) return unsafeResult(markdown, `Contains ${unsupported.construct}, which v0.9 cannot sync.`, warnings);
  // Until the live probe settles Notion's canonical inline-math dialect, preserve
  // outbound math bytes while still tokenizing it against unrelated formatting.
  const protectedInput = protectObsidianLiteralRegions(markdown);
  const lines = protectedInput.text.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;
  let tableCount = 0;
  let calloutCount = 0;

  while (index < lines.length) {
    const markedTable = lines[index].trim() === TABLE_MARKER ? readMarkdownTable(lines, index + 1) : null;
    if (lines[index].trim() === TABLE_MARKER && !markedTable) return unsafeResult(markdown, "Orphaned plugin table marker cannot be sent to Notion.", warnings);
    if (markedTable) {
      if (markedTable.error) return unsafeResult(markdown, markedTable.error, warnings);
      if (hasUnsupportedTableCell(markedTable.rows)) return unsafeResult(markdown, "Unsupported block content exists inside a Markdown table cell.", warnings);
      output.push('<table header-row="false">');
      for (const row of markedTable.rows) {
        output.push("\t<tr>");
        for (const cell of row) output.push(`\t\t<td>${cell}</td>`);
        output.push("\t</tr>");
      }
      output.push("</table>");
      tableCount += 1;
      index = markedTable.end;
      continue;
    }
    const callout = readObsidianCallout(lines, index);
    if (callout) {
      if (!CALLOUTS[callout.type]) {
        warnings.push(`Unsupported callout type '${callout.type}' preserved as ordinary text.`);
        output.push(...lines.slice(index, callout.end));
      } else {
        const mapping = CALLOUTS[callout.type];
        output.push(`<callout icon="${mapping.icon}" color="${mapping.color}">`);
        if (callout.title) output.push(`\t**${escapeGeneratedText(callout.title)}**`);
        output.push(...callout.body.map((line) => `\t${line}`));
        output.push("</callout>");
        calloutCount += 1;
      }
      index = callout.end;
      continue;
    }

    const table = readMarkdownTable(lines, index);
    if (table) {
      if (table.error) {
        return unsafeResult(markdown, table.error, warnings);
      }
      if (hasUnsupportedTableCell(table.rows)) {
        return unsafeResult(markdown, "Unsupported block content exists inside a Markdown table cell.", warnings);
      }
      if (!table.hasHeader) output.push(TABLE_MARKER);
      output.push(`<table header-row="${table.hasHeader ? "true" : "false"}">`);
      for (const row of table.rows) {
        output.push("\t<tr>");
        for (const cell of row) output.push(`\t\t<td>${cell}</td>`);
        output.push("\t</tr>");
      }
      output.push("</table>");
      tableCount += 1;
      index = table.end;
      continue;
    }

    output.push(lines[index]);
    index += 1;
  }

  const convertedBeforeRestore = applyOutboundInline(escapeLiteralNotionControlSyntax(convertObsidianListIndentation(output.join("\n"))));
  const validation = validateOutbound(protectedInput.text, convertedBeforeRestore, calloutCount, tableCount);
  if (!validation.ok) return unsafeResult(markdown, validation.error, warnings);
  const converted = restoreLiteralRegions(convertedBeforeRestore, protectedInput.values);
  return result(converted, warnings);
}

export function notionToObsidianMarkdown(markdown: string): ConversionResult {
  const warnings: string[] = [];
  const unclosedFence = findUnclosedFence(markdown);
  if (unclosedFence) return malformedResult(markdown, `Unclosed ${unclosedFence} fenced code block.`);
  const unsupported = detectUnsupportedNotionConstructs(markdown);
  if (unsupported) return unsafeResult(markdown, `Contains ${unsupported.construct}, which v0.9 cannot sync.`, warnings);
  const protectedInput = protectNotionLiteralRegions(markdown, convertInlineMathInbound);
  let text = protectedInput.text.replace(/\r\n?/g, "\n");
  text = text.replace(/<callout\b([^>]*)>\n([\s\S]*?)\n<\/callout>/gi, (_match, attrsText: string, inner: string) => {
    const attributes = parseAttributes(attrsText);
    const icon = attributes?.icon ?? "";
    const color = attributes?.color ?? "";
    if (!attributes || Object.keys(attributes).some((key) => key !== "icon" && key !== "color")) return _match;
    const type = Object.keys(CALLOUTS).find((key) => CALLOUTS[key].icon === icon && CALLOUTS[key].color === color);
    const lines = inner.split("\n").map((line) => line.replace(/^\t/, ""));
    let title = "";
    if (lines[0]?.match(/^\*\*(.+)\*\*$/)) title = lines.shift()!.replace(/^\*\*|\*\*$/g, "");
    if (!type) return _match;
    const header = `> [!${type}]${title ? ` ${title}` : ""}`;
    return [header, ...lines.map((line) => `> ${line}`)].join("\n");
  });
  const tableConversion = convertNotionTables(text, warnings);
  if (!tableConversion.ok) return unsafeResult(markdown, tableConversion.error, warnings);
  text = convertNotionListIndentation(applyInboundInline(stripNotionBlockMetadata(tableConversion.text, warnings)).replace(/\\(\{(?:color|toggle)="[^"]+"\})/g, "$1").replace(/[ \t]+$/gm, ""));
  if (/<callout\b|<table\b|<tr\b|<td\b|<colgroup\b|<col\b/i.test(text)) return unsafeResult(markdown, "Supported Notion structure was only partially converted.", warnings);
  const converted = restoreLiteralRegions(text, protectedInput.values);
  if (converted.includes(TABLE_MARKER) && !/<!-- llm-wiki-sync:table header-row=false -->\n\|/.test(converted)) {
    warnings.push("Orphaned plugin table marker preserved.");
  }
  return result(converted, warnings);
}

export function prepareNotionMarkdownForWrite(markdown: string): ConversionResult {
  return obsidianToNotionMarkdown(markdown);
}

export function prepareObsidianMarkdownFromNotion(markdown: string): ConversionResult {
  return notionToObsidianMarkdown(markdown);
}

export function areObsidianAndNotionBodiesEquivalent(obsidianBody: string, notionBody: string): boolean {
  if (detectUnsupportedObsidianConstructs(obsidianBody) || detectUnsupportedNotionConstructs(notionBody) || containsUnknownNotionConstruct(notionBody)) return false;
  const outbound = obsidianToNotionMarkdown(obsidianBody);
  const remoteAsObsidian = notionToObsidianMarkdown(notionBody);
  if (outbound.status === "unsafe" || outbound.status === "malformed" || remoteAsObsidian.status === "unsafe" || remoteAsObsidian.status === "malformed") return false;
  const canonicalRemote = obsidianToNotionMarkdown(remoteAsObsidian.markdown);
  if (canonicalRemote.status === "unsafe" || canonicalRemote.status === "malformed") return false;
  // Intended lossy equivalences: background/text/block colors, table alignment and
  // width metadata, and callout aliases are normalized by the conversion boundary.
  // Literal whitespace remains significant; unknown constructs are rejected above.
  return canonicalize(outbound.markdown) === canonicalize(canonicalRemote.markdown);
}

export function assertSuccessfulConversion(conversion: ConversionResult, direction: string): string {
  if (conversion.status === "unsafe" || conversion.status === "malformed") {
    throw new Error(`${direction} conversion failed: ${conversion.error ?? "unsupported or malformed Markdown"}`);
  }
  return conversion.markdown;
}

function readObsidianCallout(lines: string[], start: number): { type: string; title: string; body: string[]; end: number } | null {
  const match = lines[start].match(/^>\s*\[!([^\]]+)\](?:\s*(.*))?\s*$/i);
  if (!match) return null;
  const rawType = match[1].toLowerCase();
  const type = CALLOUT_ALIASES[rawType] ?? rawType;
  const body: string[] = [];
  let end = start + 1;
  while (end < lines.length && /^>/.test(lines[end]) && !/^>\s*\[![^\]]+\]/.test(lines[end])) {
    body.push(lines[end].replace(/^>\s?/, ""));
    end += 1;
  }
  return { type, title: match[2]?.trim() ?? "", body, end };
}

function hasUnsupportedTableCell(rows: string[][]): boolean {
  for (const row of rows) {
    for (const cell of row) {
      if (/!\[\[|!\[[^\]]+\]|^\s{0,3}(?:[-*+] |\d+\. |#{1,6} )|<callout|<table/i.test(cell)) return true;
    }
  }
  return false;
}

function parseAttributes(value: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const key = /^[A-Za-z][A-Za-z0-9_-]*/.exec(value.slice(index));
    if (!key) return null;
    index += key[0].length;
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (value[index] !== "=") return null;
    index += 1;
    while (/\s/.test(value[index] ?? "")) index += 1;
    const quote = value[index];
    if (quote !== '"' && quote !== "'") return null;
    index += 1;
    const end = value.indexOf(quote, index);
    if (end < 0) return null;
    attributes[key[0]] = value.slice(index, end);
    index = end + 1;
  }
  return attributes;
}

function convertNotionTables(text: string, warnings: string[]): { ok: true; text: string } | { ok: false; error: string } {
  const tablePattern = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(text)) !== null) {
    output += text.slice(cursor, match.index);
    const attributes = parseAttributes(match[1]);
    if (!attributes || (attributes["header-row"] !== undefined && attributes["header-row"] !== "true" && attributes["header-row"] !== "false")) return { ok: false, error: "Malformed Notion table attributes." };
    const inner = match[2].replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/gi, "");
    const rows: string[][] = [];
    const rowPattern = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    let innerCursor = 0;
    while ((rowMatch = rowPattern.exec(inner)) !== null) {
      if (inner.slice(innerCursor, rowMatch.index).trim()) return { ok: false, error: "Malformed Notion table row structure." };
      if (parseAttributes(rowMatch[1]) === null) return { ok: false, error: "Malformed Notion table row attributes." };
      const cells: string[] = [];
      const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
      let cellMatch: RegExpExecArray | null;
      let cellCursor = 0;
      while ((cellMatch = cellPattern.exec(rowMatch[2])) !== null) {
        if (rowMatch[2].slice(cellCursor, cellMatch.index).trim()) return { ok: false, error: "Malformed Notion table cell structure." };
        if (parseAttributes(cellMatch[1]) === null) return { ok: false, error: "Malformed Notion table cell attributes." };
        cells.push(escapeMarkdownTableCell(cellMatch[2]));
        cellCursor = cellPattern.lastIndex;
      }
      if (rowMatch[2].slice(cellCursor).trim() || cells.length === 0) return { ok: false, error: "Malformed Notion table row cells." };
      rows.push(cells);
      innerCursor = rowPattern.lastIndex;
    }
    if (inner.slice(innerCursor).trim() || rows.length === 0) return { ok: false, error: "Malformed Notion table rows." };
    const width = rows[0].length;
    if (rows.some((row) => row.length !== width)) return { ok: false, error: "Notion table rows have inconsistent cell counts." };
    const table = rows.map((row) => `| ${row.join(" | ")} |`);
    if (attributes["header-row"] === "true") table.splice(1, 0, `| ${rows[0].map(() => "---").join(" | ")} |`);
    else {
      table.splice(1, 0, `| ${rows[0].map(() => "---").join(" | ")} |`);
      table.unshift(TABLE_MARKER);
    }
    output += table.join("\n");
    cursor = tablePattern.lastIndex;
  }
  output += text.slice(cursor);
  if (output !== text) warnings.push("Notion table layout/color metadata was intentionally dropped.");
  return { ok: true, text: output };
}

function stripNotionBlockMetadata(text: string, warnings: string[]): string {
  return text.split("\n").map((line) => {
    const match = line.match(/^(.*)\s+\{([^{}]+)\}\s*$/);
    if (!match) return line;
    const attributes = parseAttributes(match[2]);
    if (!attributes) return line;
    const keys = Object.keys(attributes);
    if (keys.length !== 1 || attributes.color === undefined) return line;
    return match[1];
  }).join("\n");
}

function detectUnsafeNotionCallout(text: string): UnsupportedConstruct | null {
  const pattern = /<callout\b([^>]*)>[\s\S]*?<\/callout>/gi;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = pattern.exec(text)) !== null) {
    found = true;
    const attributes = parseAttributes(match[1]);
    if (!attributes || Object.keys(attributes).some((key) => key !== "icon" && key !== "color")) return { construct: "malformed Notion callout" };
    const icon = attributes.icon;
    const color = attributes.color;
    if (!icon || !color || !Object.values(CALLOUTS).some((value) => value.icon === icon && value.color === color)) return { construct: "unknown Notion callout" };
  }
  if (!found && /<callout\b/i.test(text)) return { construct: "malformed Notion callout" };
  return null;
}

function convertObsidianListIndentation(text: string): string {
  return text.replace(/^( {4})+(?=(?:[-*+] |\d+\. |- \[[ xX]\] ))/gm, (indent) => "\t".repeat(indent.length / 4));
}

function convertNotionListIndentation(text: string): string {
  return text.replace(/^\t+(?=(?:[-*+] |\d+\. |- \[[ xX]\] ))/gm, (indent) => "    ".repeat(indent.length));
}

function readMarkdownTable(lines: string[], start: number): { rows: string[][]; hasHeader: boolean; end: number; error?: string } | null {
  if (!/^\s*\|/.test(lines[start]) || start + 1 >= lines.length || !/^\s*\|/.test(lines[start + 1])) return null;
  if (!/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/.test(lines[start + 1])) {
    return /-{3,}/.test(lines[start + 1]) ? { rows: [], hasHeader: true, end: start + 2, error: "Malformed Markdown table separator." } : null;
  }
  const header = splitTableRow(lines[start]);
  const separator = splitTableRow(lines[start + 1]);
  if (header.length === 0 || separator.length !== header.length) return { rows: [], hasHeader: true, end: start + 2, error: "Malformed Markdown table separator." };
  const rows = [header];
  let end = start + 2;
  while (end < lines.length && /^\s*\|/.test(lines[end])) {
    const row = splitTableRow(lines[end]);
    if (row.length !== header.length) return { rows: [], hasHeader: true, end: end + 1, error: "Markdown table rows have inconsistent cell counts." };
    rows.push(row);
    end += 1;
  }
  return { rows, hasHeader: true, end };
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let wikilinkDepth = 0;
  for (const char of value) {
    if (char === "[" && !escaped && current.endsWith("[")) wikilinkDepth += 1;
    if (char === "]" && !escaped && current.endsWith("]") && wikilinkDepth > 0) wikilinkDepth -= 1;
    if (char === "|" && !escaped && wikilinkDepth === 0) { cells.push(current.trim()); current = ""; continue; }
    if (char === "\\" && !escaped) { escaped = true; current += char; continue; }
    escaped = false;
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function applyOutboundInline(text: string): string {
  return text
    .replace(/==<u>([\s\S]*?)<\/u>==/g, '<span color="yellow_bg" underline="true">$1</span>')
    .replace(/==([^=\n]+)==/g, '<span color="yellow_bg">$1</span>')
    .replace(/<u>([\s\S]*?)<\/u>/g, '<span underline="true">$1</span>');
}

function applyInboundInline(text: string): string {
  const spanPattern = /<span\s+([^>]*?)>([^<]*(?:<(?!span\b)[^>]*>[^<]*)*)<\/span>/gi;
  return text.replace(spanPattern, (match: string, attrsText: string, inner: string) => {
    const attributes = parseAttributes(attrsText);
    if (!attributes) return match;
    const keys = Object.keys(attributes);
    if (keys.some((key) => key !== "color" && key !== "underline")) return match;
    if (attributes.underline !== undefined && attributes.underline !== "true") return match;
    const background = attributes.color;
    if (background !== undefined && !NOTION_BACKGROUND_COLORS.has(background) && !/^((?:gray|brown|orange|yellow|green|blue|purple|pink|red))$/.test(background)) return match;
    let next = inner;
    if (attributes.underline === "true") next = `<u>${next}</u>`;
    if (background !== undefined && NOTION_BACKGROUND_COLORS.has(background)) next = `==${next}==`;
    return next;
  });
}

function protectObsidianLiteralRegions(markdown: string, inlineMathTransform: (value: string) => string = (value) => value, protectMath = true): { text: string; values: string[] } {
  const values: string[] = [];
  const token = (value: string): string => { const id = `\u0000LLM_LITERAL_${values.length}\u0000`; values.push(value); return id; };
  let text = markdown.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (value) => token(value));
  text = protectFencedCode(text, token);
  text = protectObsidianIndentedCode(text, token);
  text = text.replace(/\$\$[\s\S]*?\$\$/g, (value) => token(value));
  text = text.replace(/(?<!\$)`[^`\n]+`(?!\$)/g, (value) => token(value));
  if (protectMath) text = protectInlineMath(text, (value) => token(inlineMathTransform(value)));
  return { text, values };
}

function protectNotionLiteralRegions(markdown: string, inlineMathTransform: (value: string) => string = (value) => value, protectMath = true): { text: string; values: string[] } {
  const values: string[] = [];
  const token = (value: string): string => { const id = `\u0000LLM_LITERAL_${values.length}\u0000`; values.push(value); return id; };
  let text = markdown.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (value) => token(value));
  text = protectFencedCode(text, token);
  text = text.replace(/\$\$[\s\S]*?\$\$/g, (value) => token(value));
  text = text.replace(/(?<!\$)`[^`\n]+`(?!\$)/g, (value) => token(value));
  if (protectMath) text = protectInlineMath(text, (value) => token(inlineMathTransform(value)));
  return { text, values };
}

function protectFencedCode(text: string, token: (value: string) => string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/.exec(lines[index]);
    if (!opening) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const character = opening[1][0];
    const length = opening[1].length;
    let close = index + 1;
    while (close < lines.length && !new RegExp(`^ {0,3}${character}{${length},}[ \\t]*$`).test(lines[close])) close += 1;
    if (close >= lines.length) {
      output.push(...lines.slice(index));
      break;
    }
    output.push(token(lines.slice(index, close + 1).join("\n")));
    index = close + 1;
  }
  return output.join("\n");
}

function protectObsidianIndentedCode(text: string, token: (value: string) => string): string {
  const lines = text.split("\n");
  let insideCallout = false;
  let insideTable = false;
  let insideIndentedCode = false;
  return lines.map((line, index) => {
    if (/^<callout\b/.test(line)) insideCallout = true;
    if (/^<table\b/.test(line)) insideTable = true;
    const previous = index > 0 ? lines[index - 1] : "";
    const followsList = /^\s*(?:[-*+] |\d+\. |- \[[ xX]\] )/.test(previous);
    const followsParagraph = previous.trim() !== "" && !followsList;
    const indented = /^(?: {4}|\t)/.test(line);
    if (insideIndentedCode && !indented && line.trim() !== "") insideIndentedCode = false;
    const startsIndentedCode = !insideIndentedCode && !insideCallout && !insideTable && indented && !followsList && !followsParagraph;
    if (startsIndentedCode) insideIndentedCode = true;
    const shouldProtect = insideIndentedCode && indented;
    const next = shouldProtect ? token(line) : line;
    if (/<\/callout>\s*$/.test(line)) insideCallout = false;
    if (/<\/table>\s*$/.test(line)) insideTable = false;
    return next;
  }).join("\n");
}

function protectInlineMath(text: string, token: (value: string) => string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "$" || text[index + 1] === "$" || isEscapedDollar(text, index)) {
      output += text[index++];
      continue;
    }
    const end = findUnescapedClosingDollar(text, index + 1);
    if (end <= index + 1 || text[end + 1] === "$" || !isMathClosingBoundary(text, end)) {
      output += text[index++];
      continue;
    }
    const value = text.slice(index, end + 1);
    if (!isLikelyInlineMath(value.slice(1, -1))) {
      output += text[index++];
      continue;
    }
    output += token(value);
    index = end + 1;
  }
  return output;
}

function findUnescapedClosingDollar(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "$" && !isEscapedDollar(text, index)) return index;
  }
  return -1;
}

function isMathClosingBoundary(text: string, dollarIndex: number): boolean {
  const next = text[dollarIndex + 1];
  return next === undefined || /[\s.,;:!?)}\]]/.test(next);
}

function isEscapedDollar(text: string, dollarIndex: number): boolean {
  let slashCount = 0;
  for (let index = dollarIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function isLikelyInlineMath(body: string): boolean {
  if (!body || /\n/.test(body)) return false;
  const canonical = /^`[^`\n]+`$/.test(body) ? body.slice(1, -1) : body;
  if (/^\s|\s$/.test(canonical)) return false;
  if (/\s/.test(canonical)) return /[=+*/^_\\<>|]/.test(canonical);
  return /^[A-Za-z0-9()[\]{}.,:+*/^_\\<>|=\-$]+$/.test(canonical);
}

function restoreLiteralRegions(text: string, values: string[]): string {
  return text.replace(/\u0000LLM_LITERAL_(\d+)\u0000/g, (_match, index: string) => values[Number(index)] ?? _match);
}

function validateOutbound(input: string, output: string, callouts: number, tables: number): { ok: true } | { ok: false; error: string } {
  if ((output.match(/<callout\b/g) ?? []).length !== callouts || (output.match(/<table\b/g) ?? []).length !== tables) return { ok: false, error: "Converted structure count changed during validation." };
  if ((input.match(/(^|\n)>\s*\[![^\]]+\]/g) ?? []).length !== callouts) return { ok: false, error: "Callout conversion validation failed." };
  if (/<callout\b[^>]*>(?![\s\S]*<\/callout>)/.test(output) || /<table\b[^>]*>(?![\s\S]*<\/table>)/.test(output)) return { ok: false, error: "Converted structure is not closed." };
  const calloutChildren = output.match(/<callout\b[^>]*>\n([\s\S]*?)\n<\/callout>/g) ?? [];
  if (calloutChildren.some((block) => block.split("\n").slice(1, -1).some((line) => line.length > 0 && !/^\t/.test(line)))) return { ok: false, error: "Callout children are not exactly one tab-indented level." };
  const recovered = notionToObsidianMarkdown(output);
  if (recovered.status === "unsafe" || recovered.status === "malformed") return { ok: false, error: "Generated Notion Markdown failed inbound structural re-parse." };
  if (countCallouts(recovered.markdown) !== callouts || countMarkdownTables(recovered.markdown) !== tables) return { ok: false, error: "Generated structure disappeared during re-parse validation." };
  if (countFencedBlocks(input) !== countFencedBlocks(output)) return { ok: false, error: "Fenced-code structure changed during conversion." };
  return { ok: true };
}

function countCallouts(markdown: string): number { return (markdown.match(/(^|\n)>\s*\[![^\]]+\]/g) ?? []).length; }
function countMarkdownTables(markdown: string): number { return markdown.split("\n").reduce((count, line, index, lines) => count + (/^\s*\|/.test(line) && index + 1 < lines.length && /-{3,}/.test(lines[index + 1]) ? 1 : 0), 0); }
function countFencedBlocks(markdown: string): number { return (markdown.match(/(^|\n) {0,3}(?:`{3,}|~{3,})[^\n]*\n/g) ?? []).length; }
function containsUnknownNotionConstruct(markdown: string): boolean {
  if (/<(?:columns|column|tabs|tab|database|mention-|table_of_contents|synced_block|synced_block_reference|audio|video|file|pdf|embed|unknown)\b/i.test(markdown)) return true;
  const spans = /<span\s+([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = spans.exec(markdown)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (!attributes || Object.keys(attributes).some((key) => key !== "color" && key !== "underline")) return true;
  }
  return false;
}

function escapeGeneratedText(value: string): string { return value.replace(/([\\*`])/g, "\\$1"); }
function escapeMarkdownTableCell(value: string): string {
  let output = "";
  let wikilinkDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "[" && value[index + 1] === "[") wikilinkDepth += 1;
    if (value[index] === "]" && value[index + 1] === "]" && wikilinkDepth > 0) wikilinkDepth -= 1;
    if (value[index] === "|" && wikilinkDepth === 0 && (index === 0 || value[index - 1] !== "\\")) output += "\\|";
    else output += value[index];
  }
  return output.replace(/\n/g, "<br>");
}
function findUnclosedFence(markdown: string): "backtick" | "tilde" | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let fence: { character: string; length: number } | null = null;
  for (const line of lines) {
    if (!fence) {
      const opening = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/.exec(line);
      if (opening) fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
  }
  return fence ? (fence.character === "`" ? "backtick" : "tilde") : null;
}

function convertInlineMathInbound(text: string): string {
  return text.replace(/\$`([^`\n]+)`\$/g, "$$$1$");
}

function escapeLiteralNotionControlSyntax(text: string): string {
  return text.replace(/(\s)\{(?:color|toggle)="[^"]+"\}(?=\s*(?:\n|$))/g, (value) => value.replace("{", "\\{"));
}

function canonicalize(value: string): string { return value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }
function result(markdown: string, warnings: string[]): ConversionResult { return { status: warnings.length ? "warning" : "success", markdown, warnings }; }
function unsafeResult(markdown: string, error: string, warnings: string[]): ConversionResult { return { status: "unsafe", markdown, warnings, error }; }
function malformedResult(markdown: string, error: string): ConversionResult { return { status: "malformed", markdown, warnings: [], error }; }
