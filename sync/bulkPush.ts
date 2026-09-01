import { Notice, normalizePath, type App, type TFile } from "obsidian";
import { extractNotionPageId, NotionClient } from "../notionClient";
import { type SyncBaselineStore } from "./baseline";
import { getNotionPageMapping } from "./mapping";
import { pushFileToNotion } from "./push";

export interface FolderMapping {
  notionPageId: string;
  lastKnownPath: string;
  rootPageId: string;
}

export interface BulkPushStore extends SyncBaselineStore {
  getFolderMapping(mappingKey: string): FolderMapping | null;
  saveFolderMapping(mappingKey: string, mapping: FolderMapping): Promise<void>;
}

export interface FolderMappingStore {
  getFolderMapping(mappingKey: string): FolderMapping | null;
  saveFolderMapping(mappingKey: string, mapping: FolderMapping): Promise<void>;
}

export function normalizeNotionPageId(pageId: string): string {
  return pageId.replace(/-/g, "").toLowerCase();
}

export function normalizeVaultFolderPath(path: string): string {
  return normalizePath(path || "").replace(/^\/+|\/+$/g, "");
}

export function getFolderPath(path: string): string {
  const normalizedPath = normalizeVaultFolderPath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");
  return slashIndex === -1 ? "" : normalizedPath.slice(0, slashIndex);
}

export function getFolderName(path: string): string {
  const normalizedPath = normalizeVaultFolderPath(path);
  const slashIndex = normalizedPath.lastIndexOf("/");
  return slashIndex === -1 ? normalizedPath : normalizedPath.slice(slashIndex + 1);
}

export function getFolderMappingKey(rootPageId: string, folderPath: string): string {
  return `${normalizeNotionPageId(rootPageId)}::${normalizeVaultFolderPath(folderPath)}`;
}

export function selectBulkPushMarkdownFiles(app: App, folderPath: string): TFile[] {
  const normalizedFolderPath = normalizeVaultFolderPath(folderPath);
  return app.vault.getMarkdownFiles()
    .filter((file) => isPathInScope(file.path, normalizedFolderPath))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function pushCurrentFolderToNotion(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
}): Promise<void> {
  const activeFile = options.app.workspace.getActiveFile();
  if (!activeFile || activeFile.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file for folder push");
    return;
  }
  await pushFilesToNotion(options, getFolderPath(activeFile.path), "current folder");
}

export async function pushEntireVaultToNotion(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
}): Promise<void> {
  await pushFilesToNotion(options, "", "entire vault");
}

async function pushFilesToNotion(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
}, folderPath: string, label: string): Promise<void> {
  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return;
  }
  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return;
  }

  const client = new NotionClient({ token });
  await client.getPage(rootPageId);
  const files = selectBulkPushMarkdownFiles(options.app, folderPath);
  const counts = { created: 0, updated: 0, clean: 0, remoteChanged: 0, conflicts: 0, ambiguous: 0, failed: 0 };

  for (const file of files) {
    const mapping = await getNotionPageMapping(options.app, file);
    const parentPageId = mapping.pageId ? rootPageId : rootPageId;
    const result = await pushFileToNotion({
      app: options.app,
      file,
      client,
      parentPageId,
      expectedParentPageId: parentPageId,
      baselineStore: options.store
    });
    if (result.status === "created") counts.created += 1;
    else if (result.status === "updated") counts.updated += 1;
    else if (result.status === "clean") counts.clean += 1;
    else if (result.status === "remote_changed") counts.remoteChanged += 1;
    else if (result.status === "conflict") counts.conflicts += 1;
    else if (result.status === "ambiguous" || result.status === "misplaced") counts.ambiguous += 1;
    else counts.failed += 1;
  }

  new Notice(`LLM Wiki Sync: Bulk push ${label} complete - created ${counts.created}, updated ${counts.updated}, clean ${counts.clean}, remote changed ${counts.remoteChanged}, conflicts ${counts.conflicts}, ambiguous ${counts.ambiguous}, failed ${counts.failed}.`);
}

function isPathInScope(path: string, folderPath: string): boolean {
  const normalizedPath = normalizePath(path);
  if (isSystemObsidianPath(normalizedPath)) {
    return false;
  }
  if (!folderPath) {
    return true;
  }
  const parentPath = getFolderPath(normalizedPath);
  return parentPath === folderPath || parentPath.startsWith(`${folderPath}/`);
}

function isSystemObsidianPath(path: string): boolean {
  const topLevel = path.split("/")[0] ?? "";
  return topLevel === ".obsidian" || topLevel === "LLM Wiki Sync Pull" || topLevel === "LLM Wiki Sync Review";
}
