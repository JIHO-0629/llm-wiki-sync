import { Modal, Notice, normalizePath, Setting, type App, type TFile } from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "../notionClient";
import type { SyncBaselineStore } from "./baseline";
import { isContainerIndexFile, isContainerIndexFileFromCache } from "./mapping";
import { pushFileToNotion, type PushFileResult } from "./push";

export interface FolderMapping {
  notionPageId: string;
  lastKnownPath: string;
  rootPageId: string;
}

export interface FolderMappingStore {
  getFolderMapping(mappingKey: string): FolderMapping | null;
  saveFolderMapping(mappingKey: string, mapping: FolderMapping): Promise<void>;
  removeFolderMapping(mappingKey: string): Promise<void>;
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
  ambiguous: number;
  misplaced: number;
  failed: number;
  foldersCreated: number;
  folderMappingsRepaired: number;
}

export interface BulkPushResult {
  counts: BulkPushCounts;
  files: PushFileResult[];
}

const PULL_FOLDER = "LLM Wiki Sync Pull";
const REVIEW_FOLDER = "LLM Wiki Sync Review";
const EXCLUDED_TOP_LEVEL_FOLDERS = new Set([".obsidian", PULL_FOLDER, REVIEW_FOLDER]);

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
    .filter((file) => !isContainerIndexFileFromCache(app, file))
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
  const normalizedRootPageId = normalizeNotionPageId(rootPageId);

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
      if (await isContainerIndexFile(options.app, file)) {
        const result = {
          status: "failed" as const,
          filePath: file.path,
          message: "Container index files are excluded from normal Bulk Push."
        };
        fileResults.push(result);
        counts.failed += 1;
        continue;
      }
      const folderPath = getFolderPath(file.path);
      const parentPageId = await ensureFolderPage({
        client,
        store: options.store,
        rootPageId,
        normalizedRootPageId,
        folderPath,
        counts,
        runId
      });
      const result = await pushFileToNotion({
        app: options.app,
        file,
        client,
        parentPageId,
        expectedParentPageId: parentPageId,
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
  new BulkPushResultModal(options.app, selection.label, { counts, files: fileResults }).open();
}

class BulkPushResultModal extends Modal {
  private readonly label: string;
  private readonly result: BulkPushResult;

  constructor(app: App, label: string, result: BulkPushResult) {
    super(app);
    this.label = label;
    this.result = result;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName(`Bulk push results: ${this.label}`)
      .setHeading();
    contentEl.createEl("pre", { text: formatBulkPushDetails(this.result) });
    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Close")
          .onClick(() => this.close());
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function ensureFolderPage(options: {
  client: NotionClient;
  store: FolderMappingStore;
  rootPageId: string;
  normalizedRootPageId: string;
  folderPath: string;
  counts: BulkPushCounts;
  runId: string;
}): Promise<string> {
  const normalizedFolderPath = normalizeVaultFolderPath(options.folderPath);
  if (!normalizedFolderPath) {
    return options.rootPageId;
  }

  const mappingKey = getFolderMappingKey(options.normalizedRootPageId, normalizedFolderPath);
  const parentFolderPath = getFolderPath(normalizedFolderPath);
  const parentPageId = await ensureFolderPage({
    ...options,
    folderPath: parentFolderPath
  });
  const expectedTitle = getBaseName(normalizedFolderPath);
  const storedMapping = getStoredFolderMapping(options.store, mappingKey, normalizedFolderPath, options.normalizedRootPageId);
  if (storedMapping) {
    const validation = await validateStoredFolderMapping({
      client: options.client,
      mapping: storedMapping,
      rootPageId: options.normalizedRootPageId,
      expectedParentPageId: parentPageId,
      expectedTitle
    });
    if (validation.status === "matched") {
      return storedMapping.notionPageId;
    }
    console.warn(
      `[LLM Wiki Sync][Bulk Push][${options.runId}] folder mapping hierarchy mismatch:`,
      normalizedFolderPath,
      validation.reason
    );
  }

  const pushedAt = new Date();
  const createdPage = await options.client.createChildPage({
    parentPageId,
    title: expectedTitle,
    markdown: "",
    pushedAt
  });

  await options.store.saveFolderMapping(mappingKey, {
    notionPageId: createdPage.id,
    lastKnownPath: normalizedFolderPath,
    rootPageId: options.normalizedRootPageId
  });
  if (storedMapping) {
    options.counts.folderMappingsRepaired += 1;
  }
  options.counts.foldersCreated += 1;
  console.debug(`[LLM Wiki Sync][Bulk Push][${options.runId}] folder created:`, normalizedFolderPath, createdPage.id);
  return createdPage.id;
}

type FolderMappingValidation =
  | { status: "matched" }
  | { status: "hierarchy_mismatch"; reason: string };

async function validateStoredFolderMapping(options: {
  client: NotionClient;
  mapping: FolderMapping;
  rootPageId: string;
  expectedParentPageId: string;
  expectedTitle: string;
}): Promise<FolderMappingValidation> {
  if (!isMappingForRoot(options.mapping, options.rootPageId)) {
    return { status: "hierarchy_mismatch", reason: "root page mismatch" };
  }

  try {
    const details = await options.client.getPageDetails(options.mapping.notionPageId);
    if (details.title !== options.expectedTitle) {
      return { status: "hierarchy_mismatch", reason: `title mismatch: expected ${options.expectedTitle}, got ${details.title || "untitled"}` };
    }
    if (
      details.parentType !== "page_id" ||
      normalizeNotionPageId(details.parentPageId) !== normalizeNotionPageId(options.expectedParentPageId)
    ) {
      return { status: "hierarchy_mismatch", reason: `parent mismatch: expected ${options.expectedParentPageId}, got ${details.parentPageId || details.parentType || "missing"}` };
    }
    return { status: "matched" };
  } catch (error) {
    return { status: "hierarchy_mismatch", reason: `inaccessible: ${getErrorMessage(error)}` };
  }
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

export function getFolderPath(path: string): string {
  const normalized = normalizeVaultFolderPath(path);
  const index = normalized.lastIndexOf("/");
  if (index === -1) {
    return "";
  }

  return normalized.slice(0, index);
}

export function getBaseName(path: string): string {
  const normalized = normalizeVaultFolderPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function getStoredFolderMapping(
  store: FolderMappingStore,
  mappingKey: string,
  folderPath: string,
  rootPageId: string
): FolderMapping | null {
  const scopedMapping = store.getFolderMapping(mappingKey);
  if (isMappingForRoot(scopedMapping, rootPageId)) {
    return scopedMapping;
  }

  const legacyMapping = store.getFolderMapping(folderPath);
  if (isMappingForRoot(legacyMapping, rootPageId)) {
    return legacyMapping;
  }

  return null;
}

function isMappingForRoot(mapping: FolderMapping | null, rootPageId: string): mapping is FolderMapping {
  return Boolean(mapping && normalizeNotionPageId(mapping.rootPageId) === rootPageId);
}

export function getFolderMappingKey(rootPageId: string, folderPath: string): string {
  return `${rootPageId}::${folderPath}`;
}

export function normalizeNotionPageId(pageId: string): string {
  return pageId.replace(/-/g, "").toLowerCase();
}

function applyFileResult(counts: BulkPushCounts, result: PushFileResult): void {
  if (result.status === "created") counts.created += 1;
  else if (result.status === "updated") counts.updated += 1;
  else if (result.status === "clean") counts.clean += 1;
  else if (result.status === "remote_changed") counts.remoteChanged += 1;
  else if (result.status === "conflict") counts.conflicts += 1;
  else if (result.status === "ambiguous") counts.ambiguous += 1;
  else if (result.status === "misplaced") counts.misplaced += 1;
  else counts.failed += 1;
}

function createEmptyCounts(): BulkPushCounts {
  return {
    created: 0,
    updated: 0,
    clean: 0,
    remoteChanged: 0,
    conflicts: 0,
    ambiguous: 0,
    misplaced: 0,
    failed: 0,
    foldersCreated: 0,
    folderMappingsRepaired: 0
  };
}

function formatBulkPushSummary(counts: BulkPushCounts): string {
  return `LLM Wiki Sync: Bulk push complete - created ${counts.created}, updated ${counts.updated}, clean ${counts.clean}, remote changed ${counts.remoteChanged}, conflicts ${counts.conflicts}, ambiguous ${counts.ambiguous}, misplaced ${counts.misplaced}, failed ${counts.failed}, folders created ${counts.foldersCreated}, folder mappings repaired ${counts.folderMappingsRepaired}.`;
}

function formatBulkPushDetails(result: BulkPushResult): string {
  const lines = [formatBulkPushSummary(result.counts), ""];
  for (const file of result.files) {
    lines.push(`${file.status.toUpperCase()} ${file.filePath}${file.message ? ` - ${file.message}` : ""}`);
  }
  return lines.join("\n");
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
