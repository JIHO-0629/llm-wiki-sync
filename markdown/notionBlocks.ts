type RichText = {
  type: "text";
  text: {
    content: string;
  };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
  };
};

type NotionBlock = Record<string, unknown>;

const MAX_RICH_TEXT_LENGTH = 2000;
const MAX_BLOCK_CHILDREN = 100;

const KNOWN_CODE_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++",
  "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow",
  "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell",
  "html", "java", "javascript", "json", "julia", "kotlin", "latex", "less",
  "lisp", "livescript", "lua", "makefile", "markdown", "markup", "matlab",
  "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
  "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust",
  "sass", "scala", "scheme", "scss", "shell", "sql", "swift", "typescript",
  "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml", "java/c/c++/c#"
]);

export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    const text = paragraph.join(" ").trim();
    paragraph = [];

    if (text) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: parseInlineMarkdown(text)
        }
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const codeFence = trimmed.match(/^```(\S*)\s*$/);
    if (codeFence) {
      flushParagraph();
      const language = normalizeCodeLanguage(codeFence[1]);
      const codeLines: string[] = [];

      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }

      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: splitRichText(codeLines.join("\n")),
          language
        }
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const type = `heading_${heading[1].length}`;
      blocks.push({
        object: "block",
        type,
        [type]: {
          rich_text: parseInlineMarkdown(heading[2])
        }
      });
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: parseInlineMarkdown(bullet[1])
        }
      });
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: parseInlineMarkdown(numbered[1])
        }
      });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();

  if (blocks.length === 0) {
    return [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: []
        }
      }
    ];
  }

  return blocks.slice(0, MAX_BLOCK_CHILDREN);
}

function parseInlineMarkdown(input: string): RichText[] {
  const segments: RichText[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__|_[^_]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > cursor) {
      segments.push(...splitRichText(input.slice(cursor, match.index)));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      segments.push(...splitRichText(token.slice(1, -1), { code: true }));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      segments.push(...splitRichText(token.slice(2, -2), { bold: true }));
    } else {
      segments.push(...splitRichText(token.slice(1, -1), { italic: true }));
    }

    cursor = match.index + token.length;
  }

  if (cursor < input.length) {
    segments.push(...splitRichText(input.slice(cursor)));
  }

  return segments;
}

function splitRichText(text: string, annotations?: RichText["annotations"]): RichText[] {
  const chunks: RichText[] = [];

  for (let index = 0; index < text.length; index += MAX_RICH_TEXT_LENGTH) {
    chunks.push({
      type: "text",
      text: {
        content: text.slice(index, index + MAX_RICH_TEXT_LENGTH)
      },
      ...(annotations ? { annotations } : {})
    });
  }

  return chunks;
}

function normalizeCodeLanguage(language: string | undefined): string {
  const normalized = (language || "plain text").toLowerCase();
  return KNOWN_CODE_LANGUAGES.has(normalized) ? normalized : "plain text";
}
