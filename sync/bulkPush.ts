import { Notice, normalizePath, type App, type TFile } from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "../notionClient";
import type { SyncBaselineStore } from "./baseline";
import { pushFileToNotion, type PushFileResult } from "./push";

export interface FolderMapping {
  notionPageId: string;
  lastKnownPath: string;
}

export interface FolderMappingStore {
  getFolderMapping(folderPath: string): FolderMapping | null;
  saveFolderMapping(folderPath: string, mapping: FolderMapping): Promise<void>;
}

export interface BulkPushStore extends SyncBaselineStore, FolderMappingStore {}

export interface BulkPushOptions {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
}

export interface BulkPushCounts {
  created: number;
  updated: number;
  clean: number;
  remoteChanged: number;
  conflicts: number;
  failed: number;
  foldersCreated: number;
}

export interface BulkPushResult {
  counts: BulkPushCounts;
  files: PushFileResult[];
}

const PULL_FOLDER = "LLM Wiki Sync Pull";
const EXCLUDED_TOP_LEVEL_FOLDERS = new Set([".obsidian", PULL_FOLDER]);

export async function pushCurrentFolderToNotion(options: BulkPushOptions): Promise<void> {
  const activeFile = options.app.workspace.getActiveFile();
  if (!activeFile || activeFile.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file for folder push");
    return;
  }

  const folderPath = getFolderPath(activeFile.path);
  await pushSelectedFilesToNotion(options, {
    label: "current folder",
    files: selectBulkPushMarkdownFiles(options.app, folderPath)
  });
}

export async function pushEntireVaultToNotion(options: BulkPushOptions): Promise<void> {
  await pushSelectedFilesToNotion(options, {
    label: "entire vault",
    files: selectBulkPushMarkdownFiles(options.app, "")
  });
}

export function selectBulkPushMarkdownFiles(app: App, rootFolderPath: string): TFile[] {
  const normalizedRootFolderPath = normalizeVaultFolderPath(rootFolderPath);
  return app.vault.getMarkdownFiles()
    .filter((file) => isBulkPushMarkdownFile(file, normalizedRootFolderPath))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeVaultFolderPath(folderPath: string): string {
  const normalized = normalizePath(folderPath || "").replace(/^\/+|\/+$/g, "");
  if (normalized === "." || normalized === "/") {
    return "";
  }

  return normalized;
}

async function pushSelectedFilesToNotion(options: BulkPushOptions, selection: { label: string; files: TFile[] }): Promise<void> {
  const runId = createRunId();
  const logPrefix = `[LLM Wiki Sync][Bulk Push][${runId}]`;
  const counts = createEmptyCounts();
  const fileResults: PushFileResult[] = [];
  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return;
  }

  const rootPageId = extractNotionPageId(options.rootPageUrl);
  console.debug(`${logPrefix} root page id:`, rootPageId || "<invalid>");
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return;
  }

  const client = new NotionClient({ token });
  try {
    await client.getPage(rootPageId);
  } catch (error) {
    reportRootFailure(error);
    return;
  }

  console.debug(`${logPrefix} mode:`, selection.label);
  console.debug(`${logPrefix} file count:`, selection.files.length);

  for (const file of selection.files) {
    try {
      const folderPath = getFolderPath(file.path);
      const parentPageId = await ensureFolderPage({
        client,
        store: options.store,
        rootPageId,
        folderPath,
        counts,
        runId
      });
      const result = await pushFileToNotion({
        app: options.app,
        file,
        client,
        parentPageId,
        baselineStore: options.store,
        runId
      });
      fileResults.push(result);
      applyFileResult(counts, result);
      console.debug(`${logPrefix} file result:`, file.path, result.status, result.message);
    } catch (error) {
      counts.failed += 1;
      const result = {
        status: "failed" as const,
        filePath: file.path,
        message: getErrorMessage(error),
        error
      };
      fileResults.push(result);
      console.error(`${logPrefix} file failed`, file.path, getErrorMessage(error));
    }
  }

  new Notice(formatBulkPushSummary(counts));
}

async function ensureFolderPage(options: {
  client: NotionClient;
  store: FolderMappingStore;
  rootPageId: string;
  folderPath: string;
  counts: BulkPushCounts;
  runId: string;
}): Promise<string> {
  const normalizedFolderPath = normalizeVaultFolderPath(options.folderPath);
  if (!normalizedFolderPath) {
    return options.rootPageId;
  }

  const storedMapping = options.store.getFolderMapping(normalizedFolderPath);
  if (storedMapping) {
    try {
      await options.client.getPageDetails(storedMapping.notionPageId);
      return storedMapping.notionPageId;
    } catch (error) {
      throw new Error(`Stored folder mapping is inaccessible for ${normalizedFolderPath}: ${getErrorMessage(error)}`);
    }
  }

  const parentFolderPath = getFolderPath(normalizedFolderPath);
  const parentPageId = await ensureFolderPage({
    ...options,
    folderPath: parentFolderPath
  });
  const title = getBaseName(normalizedFolderPath);
  const pushedAt = new Date();
  const createdPage = await options.client.createChildPage({
    parentPageId,
    title,
    markdown: "",
    pushedAt
  });

  await options.store.saveFolderMapping(normalizedFolderPath, {
    notionPageId: createdPage.id,
    lastKnownPath: normalizedFolderPath
  });
  options.counts.foldersCreated += 1;
  console.debug(`[LLM Wiki Sync][Bulk Push][${options.runId}] folder created:`, normalizedFolderPath, createdPage.id);
  return createdPage.id;
}

function isBulkPushMarkdownFile(file: TFile, rootFolderPath: string): boolean {
  if (file.extension !== "md") {
    return false;
  }
  const normalizedFilePath = normalizePath(file.path);
  if (isExcludedPath(normalizedFilePath)) {
    return false;
  }
  if (!rootFolderPath) {
    return true;
  }

  const folderPath = getFolderPath(normalizedFilePath);
  return folderPath === rootFolderPath || folderPath.startsWith(`${rootFolderPath}/`);
}

function isExcludedPath(path: string): boolean {
  const topLevel = path.split("/")[0] ?? "";
  return EXCLUDED_TOP_LEVEL_FOLDERS.has(topLevel);
}

function getFolderPath(path: string): string {
  const normalized = normalizeVaultFolderPath(path);
  const index = normalized.lastIndexOf("/");
  if (index === -1) {
    return "";
  }

  return normalized.slice(0, index);
}

function getBaseName(path: string): string {
  const normalized = normalizeVaultFolderPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function applyFileResult(counts: BulkPushCounts, result: PushFileResult): void {
  if (result.status === "created") counts.created += 1;
  else if (result.status === "updated") counts.updated += 1;
  else if (result.status === "clean") counts.clean += 1;
  else if (result.status === "remote_changed") counts.remoteChanged += 1;
  else if (result.status === "conflict") counts.conflicts += 1;
  else counts.failed += 1;
}

function createEmptyCounts(): BulkPushCounts {
  return {
    created: 0,
    updated: 0,
    clean: 0,
    remoteChanged: 0,
    conflicts: 0,
    failed: 0,
    foldersCreated: 0
  };
}

function formatBulkPushSummary(counts: BulkPushCounts): string {
  return `LLM Wiki Sync: Bulk push complete - created ${counts.created}, updated ${counts.updated}, clean ${counts.clean}, remote changed ${counts.remoteChanged}, conflicts ${counts.conflicts}, failed ${counts.failed}, folders created ${counts.foldersCreated}.`;
}

function reportRootFailure(error: unknown): void {
  if (error instanceof NotionApiError) {
    new Notice(`LLM Wiki Sync: Bulk push failed (${error.status}) - ${error.message}`);
    return;
  }

  new Notice(`LLM Wiki Sync: Bulk push failed - ${getErrorMessage(error)}`);
}

function createRunId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
