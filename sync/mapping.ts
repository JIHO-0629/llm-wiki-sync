import type { App, TFile } from "obsidian";

export const NOTION_PAGE_ID_PROPERTY = "notion_page_id";

export interface NotionPageMapping {
  hasMapping: boolean;
  pageId: string | null;
}

export async function getNotionPageMapping(app: App, file: TFile): Promise<NotionPageMapping> {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;

  if (frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, NOTION_PAGE_ID_PROPERTY)) {
    const value = frontmatter[NOTION_PAGE_ID_PROPERTY];
    return {
      hasMapping: true,
      pageId: typeof value === "string" ? value : String(value ?? "")
    };
  }

  const markdown = await app.vault.read(file);
  const fallbackMapping = readNotionPageMappingFromMarkdown(markdown);
  if (fallbackMapping) {
    return fallbackMapping;
  }

  return {
    hasMapping: false,
    pageId: null
  };
}

function readNotionPageMappingFromMarkdown(markdown: string): NotionPageMapping | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return null;
  }

  const notionPageId = match[1].match(/^notion_page_id:\s*(?:"([^"]*)"|'([^']*)'|([^\n#]*))\s*(?:#.*)?$/m);
  if (!notionPageId) {
    return {
      hasMapping: false,
      pageId: null
    };
  }

  return {
    hasMapping: true,
    pageId: (notionPageId[1] ?? notionPageId[2] ?? notionPageId[3] ?? "").trim()
  };
}

export async function setNotionPageMapping(app: App, file: TFile, pageId: string): Promise<void> {
  console.debug("[LLM Wiki Sync][Mapping] Writing notion_page_id:", pageId);
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    frontmatter[NOTION_PAGE_ID_PROPERTY] = pageId;
  });
}

export function createFrontmatterForNotionPage(pageId: string): string {
  return `---\n${NOTION_PAGE_ID_PROPERTY}: "${escapeYamlDoubleQuotedValue(pageId)}"\n---\n\n`;
}

export function normalizePulledMarkdown(markdown: string): string {
  return markdown.replace(/^[ \t]*<empty-block\/>[ \t]*$/gm, "");
}

export function removeNotionPageMappingFromMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return markdown;
  }

  const frontmatter = match[1]
    .split("\n")
    .filter((line) => !/^notion_page_id:\s*/.test(line))
    .join("\n")
    .trim();
  const body = normalized.slice(match[0].length);

  return frontmatter ? `---\n${frontmatter}\n---\n${body}` : body;
}

export function replaceMarkdownBodyPreservingFrontmatter(markdown: string, nextBody: string, pageId: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const normalizedBody = nextBody.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return createFrontmatterForNotionPage(pageId) + normalizedBody;
  }

  return match[0] + normalizedBody;
}

export function normalizeNotionPageId(pageId: string): string {
  return pageId.replace(/-/g, "").toLowerCase();
}

export async function findFilesMappedToPage(app: App, pageId: string): Promise<TFile[]> {
  const normalizedPageId = normalizeNotionPageId(pageId);
  const matches: TFile[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    const mapping = await getNotionPageMapping(app, file);
    if (mapping.pageId && normalizeNotionPageId(mapping.pageId) === normalizedPageId) {
      matches.push(file);
    }
  }

  return matches;
}

function escapeYamlDoubleQuotedValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
