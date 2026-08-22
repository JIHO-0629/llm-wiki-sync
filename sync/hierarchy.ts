import { Modal, Notice, normalizePath, Setting, type App, type TFile } from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient, type NotionPageDetails } from "../notionClient";
import {
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshot
} from "./baseline";
import {
  getBaseName,
  getFolderMappingKey,
  getFolderPath,
  normalizeNotionPageId,
  normalizeVaultFolderPath,
  selectBulkPushMarkdownFiles,
  type BulkPushStore,
  type FolderMapping
} from "./bulkPush";
import { findFilesMappedToPage, getNotionPageMapping } from "./mapping";

export type HierarchyScope = "current-folder" | "entire-vault" | "folder";

export type HierarchyStatus =
  | "MATCHED"
  | "MISSING_IN_NOTION"
  | "MISPLACED"
  | "INVALID_FOLDER_MAPPING"
  | "UNMAPPED"
  | "DUPLICATE_MAPPING"
  | "AMBIGUOUS"
  | "FAILED";

export interface HierarchyAuditItem {
  kind: "folder" | "note";
  status: HierarchyStatus;
  path: string;
  pageId?: string;
  currentParentPageId?: string;
  expectedParentPageId?: string;
  message: string;
}

export interface HierarchyAuditResult {
  scope: HierarchyScope;
  rootPageId: string;
  items: HierarchyAuditItem[];
  files: TFile[];
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
  unmapped: number;
  ambiguous: number;
  failed: number;
}

export interface HierarchyParentResult {
  parentPageId: string;
  foldersCreated: number;
  folderMappingsRepaired: number;
}

export async function auditWorkspaceHierarchy(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
  scope: HierarchyScope;
  folderPath?: string;
}): Promise<HierarchyAuditResult | null> {
  const context = await createHierarchyContext(options);
  if (!context) {
    return null;
  }

  return auditHierarchyWithContext(context);
}

export async function repairWorkspaceHierarchy(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
  scope: HierarchyScope;
  folderPath?: string;
}): Promise<HierarchyRepairSummary | null> {
  const context = await createHierarchyContext(options);
  if (!context) {
    return null;
  }

  const summary: HierarchyRepairSummary = {
    foldersCreated: 0,
    folderMappingsRepaired: 0,
    pagesMoved: 0,
    alreadyCorrect: 0,
    failed: 0,
    skipped: 0
  };
  const folderPaths = getFolderPathsFromFiles(context.files);

  for (const folderPath of folderPaths) {
    const result = await ensureHierarchyFolder(context, folderPath);
    if (result.action === "created") summary.foldersCreated += 1;
    else if (result.action === "repaired") summary.folderMappingsRepaired += 1;
    else if (result.action === "matched") summary.alreadyCorrect += 1;
    else if (result.action === "failed") summary.failed += 1;
    else summary.skipped += 1;
  }

  for (const file of context.files) {
    const mapping = await getNotionPageMapping(context.app, file);
    if (!mapping.hasMapping || !mapping.pageId) {
      summary.skipped += 1;
      continue;
    }
    const duplicateFiles = await findFilesMappedToPage(context.app, mapping.pageId);
    if (duplicateFiles.length !== 1) {
      summary.skipped += 1;
      continue;
    }
    const expectedParentPageId = await getExpectedParentForFile(context, file);
    if (!expectedParentPageId) {
      summary.failed += 1;
      continue;
    }
    try {
      const details = await context.client.getPageDetails(mapping.pageId);
      if (isPageUnderParent(details, expectedParentPageId)) {
        summary.alreadyCorrect += 1;
        continue;
      }
      await context.client.movePageToPage(mapping.pageId, expectedParentPageId);
      summary.pagesMoved += 1;
    } catch (error) {
      console.error("[LLM Wiki Sync][Hierarchy] repair move failed", file.path, getErrorMessage(error));
      summary.failed += 1;
    }
  }

  return summary;
}

export async function initializeWorkspaceMappings(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
  scope: HierarchyScope;
  folderPath?: string;
}): Promise<MappingInitializationSummary | null> {
  const context = await createHierarchyContext(options);
  if (!context) {
    return null;
  }

  const summary: MappingInitializationSummary = {
    baselinesInitialized: 0,
    alreadyInitialized: 0,
    unmapped: 0,
    ambiguous: 0,
    failed: 0
  };

  for (const folderPath of getFolderPathsFromFiles(context.files)) {
    await ensureHierarchyFolder(context, folderPath);
  }

  for (const file of context.files) {
    const mapping = await getNotionPageMapping(context.app, file);
    if (!mapping.hasMapping || !mapping.pageId) {
      const expectedParentPageId = await getExpectedParentForFile(context, file);
      if (expectedParentPageId) {
        const candidates = await findChildPagesByTitle(context.client, expectedParentPageId, file.basename);
        if (candidates.length > 1) {
          summary.ambiguous += 1;
          continue;
        }
      }
      summary.unmapped += 1;
      continue;
    }

    try {
      const duplicateFiles = await findFilesMappedToPage(context.app, mapping.pageId);
      if (duplicateFiles.length !== 1) {
        summary.ambiguous += 1;
        continue;
      }
      await context.client.getPageDetails(mapping.pageId);
      if (context.store.getSyncBaseline(mapping.pageId)) {
        summary.alreadyInitialized += 1;
        continue;
      }
      const localSnapshot = await getLocalSyncSnapshot(context.app, file);
      const remoteSnapshot = await getRemoteSyncSnapshot(context.client, mapping.pageId);
      await context.store.saveSyncBaseline(
        mapping.pageId,
        createSyncBaseline(mapping.pageId, localSnapshot, remoteSnapshot)
      );
      summary.baselinesInitialized += 1;
    } catch (error) {
      console.error("[LLM Wiki Sync][Hierarchy] mapping initialization failed", file.path, getErrorMessage(error));
      summary.failed += 1;
    }
  }

  return summary;
}

export async function resolveNotionParentForFile(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
  file: TFile;
}): Promise<HierarchyParentResult | null> {
  const context = await createHierarchyContext({
    app: options.app,
    token: options.token,
    rootPageUrl: options.rootPageUrl,
    store: options.store,
    scope: "entire-vault"
  });
  if (!context) {
    return null;
  }

  const counters = { foldersCreated: 0, folderMappingsRepaired: 0 };
  const parentPageId = await getExpectedParentForFile(context, options.file, counters);
  if (!parentPageId) {
    return null;
  }

  return {
    parentPageId,
    foldersCreated: counters.foldersCreated,
    folderMappingsRepaired: counters.folderMappingsRepaired
  };
}

export class HierarchyAuditModal extends Modal {
  private readonly result: HierarchyAuditResult;
  private readonly onRepair?: () => void;

  constructor(app: App, result: HierarchyAuditResult, onRepair?: () => void) {
    super(app);
    this.result = result;
    this.onRepair = onRepair;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("Workspace hierarchy audit")
      .setHeading();
    const report = this.result.items.map(formatAuditItem).join("\n");
    contentEl.createEl("pre", { text: report || "No Markdown files found in scope." });
    const footer = new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("Close")
        .onClick(() => this.close()));
    if (this.onRepair) {
      footer.addButton((button) => button
        .setButtonText("Repair hierarchy")
        .setCta()
        .onClick(() => {
          this.close();
          this.onRepair?.();
        }));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface HierarchyContext {
  app: App;
  client: NotionClient;
  store: BulkPushStore;
  rootPageId: string;
  normalizedRootPageId: string;
  files: TFile[];
  scope: HierarchyScope;
}

async function createHierarchyContext(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: BulkPushStore;
  scope: HierarchyScope;
  folderPath?: string;
}): Promise<HierarchyContext | null> {
  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return null;
  }

  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return null;
  }

  const activeFile = options.app.workspace.getActiveFile();
  const rootFolderPath = options.scope === "folder"
    ? normalizeVaultFolderPath(options.folderPath ?? "")
    : options.scope === "current-folder" && activeFile
      ? getFolderPath(activeFile.path)
      : "";
  const files = selectBulkPushMarkdownFiles(options.app, rootFolderPath);
  const client = new NotionClient({ token });
  try {
    await client.getPageDetails(rootPageId);
  } catch (error) {
    reportHierarchyFailure(error);
    return null;
  }

  return {
    app: options.app,
    client,
    store: options.store,
    rootPageId,
    normalizedRootPageId: normalizeNotionPageId(rootPageId),
    files,
    scope: options.scope
  };
}

async function auditHierarchyWithContext(context: HierarchyContext): Promise<HierarchyAuditResult> {
  const items: HierarchyAuditItem[] = [];
  for (const folderPath of getFolderPathsFromFiles(context.files)) {
    items.push(await auditFolder(context, folderPath));
  }
  for (const file of context.files) {
    items.push(await auditNote(context, file));
  }

  return {
    scope: context.scope,
    rootPageId: context.rootPageId,
    items,
    files: context.files
  };
}

async function auditFolder(context: HierarchyContext, folderPath: string): Promise<HierarchyAuditItem> {
  const expectedParentPageId = await resolveFolderParentReadOnly(context, folderPath);
  if (!expectedParentPageId) {
    return failed("folder", folderPath, "Could not resolve expected parent folder.");
  }

  const mappingKey = getFolderMappingKey(context.normalizedRootPageId, folderPath);
  const mapping = context.store.getFolderMapping(mappingKey) ?? context.store.getFolderMapping(folderPath);
  if (!mapping) {
    const candidates = await findChildPagesByTitle(context.client, expectedParentPageId, getBaseName(folderPath));
    if (candidates.length === 1) {
      return item("folder", "UNMAPPED", folderPath, "A matching Notion folder exists, but no folder mapping is stored.", {
        pageId: candidates[0].id,
        expectedParentPageId
      });
    }
    if (candidates.length > 1) {
      return item("folder", "DUPLICATE_MAPPING", folderPath, "Multiple matching Notion folder candidates exist.", {
        expectedParentPageId
      });
    }
    return item("folder", "MISSING_IN_NOTION", folderPath, "Folder page is missing in Notion.", { expectedParentPageId });
  }

  const validation = await validateFolderMapping(context, mapping, folderPath, expectedParentPageId);
  if (validation.status === "MATCHED") {
    return item("folder", "MATCHED", folderPath, "Folder mapping matches Notion hierarchy.", {
      pageId: mapping.notionPageId,
      expectedParentPageId
    });
  }
  return item("folder", validation.status, folderPath, validation.message, {
    pageId: mapping.notionPageId,
    currentParentPageId: validation.currentParentPageId,
    expectedParentPageId
  });
}

async function auditNote(context: HierarchyContext, file: TFile): Promise<HierarchyAuditItem> {
  const expectedParentPageId = await resolveFileParentReadOnly(context, file);
  if (!expectedParentPageId) {
    return failed("note", file.path, "Could not resolve expected parent folder.");
  }

  const mapping = await getNotionPageMapping(context.app, file);
  if (!mapping.hasMapping || !mapping.pageId) {
    const candidates = await findChildPagesByTitle(context.client, expectedParentPageId, file.basename);
    if (candidates.length > 1) {
      return item("note", "AMBIGUOUS", file.path, "Multiple matching Notion pages exist; not guessing.", { expectedParentPageId });
    }
    return item("note", "UNMAPPED", file.path, "No notion_page_id is stored for this note.", { expectedParentPageId });
  }

  const mappedFiles = await findFilesMappedToPage(context.app, mapping.pageId);
  if (mappedFiles.length !== 1) {
    return item("note", "DUPLICATE_MAPPING", file.path, "Multiple local notes share this notion_page_id.", {
      pageId: mapping.pageId,
      expectedParentPageId
    });
  }

  try {
    const details = await context.client.getPageDetails(mapping.pageId);
    if (!isPageUnderParent(details, expectedParentPageId)) {
      return item("note", "MISPLACED", file.path, "Linked Notion page is under the wrong parent.", {
        pageId: mapping.pageId,
        currentParentPageId: details.parentPageId,
        expectedParentPageId
      });
    }
    return item("note", "MATCHED", file.path, "Linked Notion page is under the expected parent.", {
      pageId: mapping.pageId,
      currentParentPageId: details.parentPageId,
      expectedParentPageId
    });
  } catch (error) {
    return failed("note", file.path, `Mapped page is inaccessible: ${getErrorMessage(error)}`, mapping.pageId, expectedParentPageId);
  }
}

async function ensureHierarchyFolder(
  context: HierarchyContext,
  folderPath: string,
  counters?: { foldersCreated: number; folderMappingsRepaired: number }
): Promise<{ action: "matched" | "created" | "repaired" | "skipped" | "failed"; pageId?: string }> {
  const normalizedFolderPath = normalizeVaultFolderPath(folderPath);
  if (!normalizedFolderPath) {
    return { action: "matched", pageId: context.rootPageId };
  }

  const parentPageId = await getExpectedParentForFolder(context, normalizedFolderPath, counters);
  if (!parentPageId) {
    return { action: "failed" };
  }
  const mappingKey = getFolderMappingKey(context.normalizedRootPageId, normalizedFolderPath);
  const mapping = context.store.getFolderMapping(mappingKey) ?? context.store.getFolderMapping(normalizedFolderPath);
  if (mapping) {
    const validation = await validateFolderMapping(context, mapping, normalizedFolderPath, parentPageId);
    if (validation.status === "MATCHED") {
      if (context.store.getFolderMapping(mappingKey) === null) {
        await context.store.saveFolderMapping(mappingKey, mapping);
        if (counters) counters.folderMappingsRepaired += 1;
        return { action: "repaired", pageId: mapping.notionPageId };
      }
      return { action: "matched", pageId: mapping.notionPageId };
    }
  }

  const existing = await findChildPagesByTitle(context.client, parentPageId, getBaseName(normalizedFolderPath));
  if (existing.length > 1) {
    return { action: "skipped" };
  }
  if (existing.length === 1) {
    await context.store.saveFolderMapping(mappingKey, {
      notionPageId: existing[0].id,
      lastKnownPath: normalizedFolderPath,
      rootPageId: context.normalizedRootPageId
    });
    if (counters) counters.folderMappingsRepaired += 1;
    return { action: "repaired", pageId: existing[0].id };
  }

  try {
    const created = await context.client.createChildPage({
      parentPageId,
      title: getBaseName(normalizedFolderPath),
      markdown: "",
      pushedAt: new Date()
    });
    await context.store.saveFolderMapping(mappingKey, {
      notionPageId: created.id,
      lastKnownPath: normalizedFolderPath,
      rootPageId: context.normalizedRootPageId
    });
    if (counters) {
      if (mapping) counters.folderMappingsRepaired += 1;
      else counters.foldersCreated += 1;
    }
    return { action: mapping ? "repaired" : "created", pageId: created.id };
  } catch (error) {
    console.error("[LLM Wiki Sync][Hierarchy] folder repair failed", normalizedFolderPath, getErrorMessage(error));
    return { action: "failed" };
  }
}

async function getExpectedParentForFile(
  context: HierarchyContext,
  file: TFile,
  counters?: { foldersCreated: number; folderMappingsRepaired: number }
): Promise<string | null> {
  const folderPath = getFolderPath(file.path);
  if (!folderPath) {
    return context.rootPageId;
  }
  const result = await ensureHierarchyFolder(context, folderPath, counters);
  return result.pageId ?? null;
}

async function getExpectedParentForFolder(
  context: HierarchyContext,
  folderPath: string,
  counters?: { foldersCreated: number; folderMappingsRepaired: number }
): Promise<string | null> {
  const parentFolderPath = getFolderPath(folderPath);
  if (!parentFolderPath) {
    return context.rootPageId;
  }
  const result = await ensureHierarchyFolder(context, parentFolderPath, counters);
  return result.pageId ?? null;
}

async function resolveFileParentReadOnly(context: HierarchyContext, file: TFile): Promise<string | null> {
  const folderPath = getFolderPath(file.path);
  if (!folderPath) {
    return context.rootPageId;
  }
  return resolveFolderPageReadOnly(context, folderPath);
}

async function resolveFolderParentReadOnly(context: HierarchyContext, folderPath: string): Promise<string | null> {
  const parentFolderPath = getFolderPath(folderPath);
  if (!parentFolderPath) {
    return context.rootPageId;
  }
  return resolveFolderPageReadOnly(context, parentFolderPath);
}

async function resolveFolderPageReadOnly(context: HierarchyContext, folderPath: string): Promise<string | null> {
  const normalizedFolderPath = normalizeVaultFolderPath(folderPath);
  if (!normalizedFolderPath) {
    return context.rootPageId;
  }
  const expectedParentPageId = await resolveFolderParentReadOnly(context, normalizedFolderPath);
  if (!expectedParentPageId) {
    return null;
  }
  const mappingKey = getFolderMappingKey(context.normalizedRootPageId, normalizedFolderPath);
  const mapping = context.store.getFolderMapping(mappingKey) ?? context.store.getFolderMapping(normalizedFolderPath);
  if (mapping) {
    const validation = await validateFolderMapping(context, mapping, normalizedFolderPath, expectedParentPageId);
    if (validation.status === "MATCHED") {
      return mapping.notionPageId;
    }
  }
  const candidates = await findChildPagesByTitle(context.client, expectedParentPageId, getBaseName(normalizedFolderPath));
  return candidates.length === 1 ? candidates[0].id : null;
}

async function validateFolderMapping(
  context: HierarchyContext,
  mapping: FolderMapping,
  folderPath: string,
  expectedParentPageId: string
): Promise<{ status: "MATCHED" | "INVALID_FOLDER_MAPPING"; message: string; currentParentPageId?: string }> {
  if (normalizeNotionPageId(mapping.rootPageId) !== context.normalizedRootPageId) {
    return { status: "INVALID_FOLDER_MAPPING", message: "Folder mapping belongs to a different Notion root." };
  }
  try {
    const details = await context.client.getPageDetails(mapping.notionPageId);
    if (details.title !== getBaseName(folderPath)) {
      return { status: "INVALID_FOLDER_MAPPING", message: "Mapped folder page title does not match folder name.", currentParentPageId: details.parentPageId };
    }
    if (!isPageUnderParent(details, expectedParentPageId)) {
      return { status: "INVALID_FOLDER_MAPPING", message: "Mapped folder page is under the wrong parent.", currentParentPageId: details.parentPageId };
    }
    return { status: "MATCHED", message: "Matched." };
  } catch (error) {
    return { status: "INVALID_FOLDER_MAPPING", message: `Mapped folder page is inaccessible: ${getErrorMessage(error)}` };
  }
}

async function findChildPagesByTitle(client: NotionClient, parentPageId: string, title: string): Promise<Array<{ id: string; title: string }>> {
  const children = await client.listChildPages(parentPageId, "Hierarchy");
  return children.filter((child) => child.title === title);
}

function getFolderPathsFromFiles(files: TFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const folderPath = getFolderPath(normalizePath(file.path));
    const segments = folderPath ? folderPath.split("/") : [];
    for (let index = 0; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index + 1).join("/"));
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}

function isPageUnderParent(details: NotionPageDetails, expectedParentPageId: string): boolean {
  return details.parentType === "page_id" && normalizeNotionPageId(details.parentPageId) === normalizeNotionPageId(expectedParentPageId);
}

function item(
  kind: "folder" | "note",
  status: HierarchyStatus,
  path: string,
  message: string,
  extra: Partial<HierarchyAuditItem> = {}
): HierarchyAuditItem {
  return { kind, status, path, message, ...extra };
}

function failed(kind: "folder" | "note", path: string, message: string, pageId?: string, expectedParentPageId?: string): HierarchyAuditItem {
  return item(kind, "FAILED", path, message, { pageId, expectedParentPageId });
}

function formatAuditItem(item: HierarchyAuditItem): string {
  const marker = getStatusMarker(item.status);
  const details = [
    `${marker} ${item.path}`,
    item.currentParentPageId ? `   current Notion parent: ${item.currentParentPageId}` : "",
    item.expectedParentPageId ? `   expected parent: ${item.expectedParentPageId}` : "",
    item.message ? `   ${item.message}` : ""
  ].filter(Boolean);
  return details.join("\n");
}

function getStatusMarker(status: HierarchyStatus): string {
  if (status === "MATCHED") return "MATCHED";
  if (status === "MISSING_IN_NOTION") return "+ MISSING_IN_NOTION";
  if (status === "MISPLACED") return "-> MISPLACED";
  return `! ${status}`;
}

function reportHierarchyFailure(error: unknown): void {
  if (error instanceof NotionApiError) {
    new Notice(`LLM Wiki Sync: Hierarchy check failed (${error.status}) - ${error.message}`);
    return;
  }
  new Notice(`LLM Wiki Sync: Hierarchy check failed - ${getErrorMessage(error)}`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
