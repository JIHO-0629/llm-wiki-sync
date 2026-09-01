import { Modal, Notice, Setting, normalizePath, type App, type TFile } from "obsidian";
import { extractNotionPageId, NotionClient } from "../notionClient";
import { createSyncBaseline, getLocalSyncSnapshot, getRemoteSyncSnapshot, type SyncBaselineStore } from "./baseline";
import {
  getFolderMappingKey,
  getFolderName,
  getFolderPath,
  normalizeNotionPageId,
  normalizeVaultFolderPath,
  selectBulkPushMarkdownFiles,
  type BulkPushStore
} from "./bulkPush";
import { getNotionPageMapping } from "./mapping";
import type { SyncRunCache } from "./runCache";

export type HierarchyScope = "current-folder" | "entire-vault" | "folder";

export interface HierarchyStore extends BulkPushStore, SyncBaselineStore {}

export interface HierarchyAuditResult {
  scope: string;
  checked: number;
  missingFolderMappings: number;
  invalidFolderMappings: number;
  details: string[];
}

export interface HierarchyRepairSummary {
  foldersCreated: number;
  folderMappingsRepaired: number;
  pagesMoved: number;
  alreadyCorrect: number;
  failed: number;
  skipped: number;
}

export interface MappingInitializationSummary {
  baselinesInitialized: number;
  alreadyInitialized: number;
  uninitializedDivergence: number;
  unmapped: number;
  ambiguous: number;
  failed: number;
}

export class HierarchyAuditModal extends Modal {
  private readonly result: HierarchyAuditResult;
  private readonly onRepair: () => void;

  constructor(app: App, result: HierarchyAuditResult, onRepair: () => void) {
    super(app);
    this.result = result;
    this.onRepair = onRepair;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("Hierarchy audit")
      .setHeading();
    contentEl.createEl("pre", { text: formatAuditResult(this.result) });
    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("Close")
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText("Repair hierarchy")
        .setCta()
        .onClick(() => {
          this.close();
          this.onRepair();
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export async function resolveNotionParentForFile(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: HierarchyStore;
  file: TFile;
  client?: NotionClient;
  runCache?: SyncRunCache;
}): Promise<{ parentPageId: string; foldersCreated: number } | null> {
  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!rootPageId) {
    return null;
  }
  const client = options.client ?? new NotionClient({ token: options.token });
  const folderPath = getFolderPath(normalizePath(options.file.path));
  const result = await ensureFolderPath({
    client,
    store: options.store,
    rootPageId,
    folderPath
  });
  return result;
}

export async function auditWorkspaceHierarchy(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: HierarchyStore;
  scope: HierarchyScope;
  folderPath?: string;
}): Promise<HierarchyAuditResult | null> {
  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return null;
  }
  const scopePath = getScopePath(options);
  const files = selectBulkPushMarkdownFiles(options.app, scopePath);
  const result: HierarchyAuditResult = {
    scope: scopePath || "Vault root",
    checked: files.length,
    missingFolderMappings: 0,
    invalidFolderMappings: 0,
    details: []
  };
  for (const file of files) {
    const folderPath = getFolderPath(file.path);
    if (!folderPath) {
      continue;
    }
    const mapping = options.store.getFolderMapping(getFolderMappingKey(rootPageId, folderPath));
    if (!mapping) {
      result.missingFolderMappings += 1;
      result.details.push(`MISSING ${folderPath}`);
    } else if (normalizeNotionPageId(mapping.rootPageId) !== normalizeNotionPageId(rootPageId)) {
      result.invalidFolderMappings += 1;
      result.details.push(`INVALID ${folderPath}`);
    }
  }
  return result;
}

export async function repairWorkspaceHierarchy(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: HierarchyStore;
  scope: HierarchyScope;
  folderPath?: string;
  client?: NotionClient;
  runCache?: SyncRunCache;
  onFolderProgress?: (folderPath: string) => void;
}): Promise<HierarchyRepairSummary | null> {
  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return null;
  }
  const client = options.client ?? new NotionClient({ token: options.token });
  const scopePath = getScopePath(options);
  const folders = collectFolderPaths(options.app, scopePath);
  const summary: HierarchyRepairSummary = {
    foldersCreated: 0,
    folderMappingsRepaired: 0,
    pagesMoved: 0,
    alreadyCorrect: 0,
    failed: 0,
    skipped: 0
  };
  for (const folderPath of folders) {
    options.onFolderProgress?.(folderPath);
    try {
      const result = await ensureFolderPath({ client, store: options.store, rootPageId, folderPath });
      summary.foldersCreated += result.foldersCreated;
      summary.alreadyCorrect += result.foldersCreated === 0 ? 1 : 0;
    } catch (error) {
      console.error("[LLM Wiki Sync][Hierarchy] repair failed", folderPath, getErrorMessage(error));
      summary.failed += 1;
    }
  }
  return summary;
}

export async function initializeWorkspaceMappings(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: HierarchyStore;
  scope: HierarchyScope;
  folderPath?: string;
  client?: NotionClient;
  runCache?: SyncRunCache;
}): Promise<MappingInitializationSummary | null> {
  const client = options.client ?? new NotionClient({ token: options.token });
  const scopePath = getScopePath(options);
  const files = selectBulkPushMarkdownFiles(options.app, scopePath);
  const summary: MappingInitializationSummary = {
    baselinesInitialized: 0,
    alreadyInitialized: 0,
    uninitializedDivergence: 0,
    unmapped: 0,
    ambiguous: 0,
    failed: 0
  };
  for (const file of files) {
    const mapping = await getNotionPageMapping(options.app, file);
    if (!mapping.pageId) {
      summary.unmapped += 1;
      continue;
    }
    if (options.store.getSyncBaseline(mapping.pageId)) {
      summary.alreadyInitialized += 1;
      continue;
    }
    try {
      const localSnapshot = await getLocalSyncSnapshot(options.app, file);
      const remoteSnapshot = await getRemoteSyncSnapshot(client, mapping.pageId);
      await options.store.saveSyncBaseline(mapping.pageId, createSyncBaseline(mapping.pageId, localSnapshot, remoteSnapshot));
      summary.baselinesInitialized += 1;
    } catch (error) {
      console.error("[LLM Wiki Sync][Hierarchy] baseline initialization failed", file.path, getErrorMessage(error));
      summary.failed += 1;
    }
  }
  return summary;
}

async function ensureFolderPath(options: {
  client: NotionClient;
  store: HierarchyStore;
  rootPageId: string;
  folderPath: string;
}): Promise<{ parentPageId: string; foldersCreated: number }> {
  const normalizedFolderPath = normalizeVaultFolderPath(options.folderPath);
  if (!normalizedFolderPath) {
    return { parentPageId: options.rootPageId, foldersCreated: 0 };
  }

  let parentPageId = options.rootPageId;
  let foldersCreated = 0;
  const segments = normalizedFolderPath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const folderPath = segments.slice(0, index + 1).join("/");
    const mappingKey = getFolderMappingKey(options.rootPageId, folderPath);
    const mapping = options.store.getFolderMapping(mappingKey);
    if (mapping && normalizeNotionPageId(mapping.rootPageId) === normalizeNotionPageId(options.rootPageId)) {
      parentPageId = mapping.notionPageId;
      continue;
    }

    const title = getFolderName(folderPath);
    const matches = (await options.client.listChildPages(parentPageId, "Hierarchy")).filter((page) => page.title === title);
    const pageId = matches.length === 1
      ? matches[0].id
      : (await options.client.createChildPage({ parentPageId, title, children: [], pushedAt: new Date() })).id;
    if (matches.length === 0) {
      foldersCreated += 1;
    }
    await options.store.saveFolderMapping(mappingKey, {
      notionPageId: pageId,
      lastKnownPath: folderPath,
      rootPageId: normalizeNotionPageId(options.rootPageId)
    });
    parentPageId = pageId;
  }

  return { parentPageId, foldersCreated };
}

function getScopePath(options: { app: App; scope: HierarchyScope; folderPath?: string }): string {
  if (options.scope === "entire-vault") {
    return "";
  }
  if (options.scope === "folder") {
    return normalizeVaultFolderPath(options.folderPath ?? "");
  }
  const activeFile = options.app.workspace.getActiveFile();
  return activeFile ? getFolderPath(activeFile.path) : "";
}

function collectFolderPaths(app: App, scopePath: string): string[] {
  const folders = new Set<string>();
  for (const file of selectBulkPushMarkdownFiles(app, scopePath)) {
    const folderPath = getFolderPath(file.path);
    if (!folderPath) {
      continue;
    }
    const segments = folderPath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index + 1).join("/"));
    }
  }
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

function formatAuditResult(result: HierarchyAuditResult): string {
  return [
    `Scope: ${result.scope}`,
    `Checked notes: ${result.checked}`,
    `Missing folder mappings: ${result.missingFolderMappings}`,
    `Invalid folder mappings: ${result.invalidFolderMappings}`,
    "",
    ...result.details
  ].join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
