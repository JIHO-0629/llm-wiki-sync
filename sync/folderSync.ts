import { Modal, Notice, Setting, normalizePath, type App, type TFile } from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "../notionClient";
import {
  getFolderPath,
  normalizeNotionPageId,
  normalizeVaultFolderPath,
  selectBulkPushMarkdownFiles,
  type BulkPushStore,
  type FolderMapping
} from "./bulkPush";
import {
  initializeWorkspaceMappings,
  repairWorkspaceHierarchy,
  resolveNotionParentForFile
} from "./hierarchy";
import { findFilesMappedToPage, getNotionPageMapping } from "./mapping";
import { pushFileToNotion, type PushFileResult } from "./push";

export const REVIEW_FOLDER_TITLE = "LLM Wiki Sync Review";
export const REVIEW_OBSIDIAN_MISSING_TITLE = "Obsidian missing";
export const REVIEW_AMBIGUOUS_TITLE = "Ambiguous";

export interface QuarantineRecord {
  notionPageId: string;
  rootPageId: string;
  reason: "MISSING_IN_OBSIDIAN";
  previousParentPageId: string;
  previousTitle: string;
  lastKnownObsidianPath?: string;
  previousNotionPath?: string;
  quarantinedAt: string;
}

export interface ManagedPageRecord {
  notionPageId: string;
  rootPageId: string;
  lastKnownObsidianPath: string;
  lastKnownParentPageId?: string;
  updatedAt: string;
}

export interface FolderSyncStore extends BulkPushStore {
  getAllSyncBaselinePageIds(): string[];
  getAllFolderMappings(): FolderMapping[];
  getManagedPageRecord(pageId: string): ManagedPageRecord | null;
  saveManagedPageRecord(record: ManagedPageRecord): Promise<void>;
  saveQuarantineRecord(record: QuarantineRecord): Promise<void>;
}

export interface FolderSyncSummary {
  scopePath: string;
  created: number;
  updated: number;
  moved: number;
  foldersCreated: number;
  alreadyInSync: number;
  remoteChanged: number;
  conflicts: number;
  ambiguous: number;
  remoteNew: number;
  legacyUnscoped: number;
  uninitializedDivergence: number;
  orphanCandidates: number;
  movedToReview: number;
  failed: number;
  details: string[];
}

interface RemoteTreePage {
  id: string;
  title: string;
  parentPageId: string;
  path: string;
}

const SYSTEM_OBSIDIAN_FOLDERS = new Set([".obsidian", "LLM Wiki Sync Pull", "LLM Wiki Sync Review"]);

export async function syncFolderWithNotion(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: FolderSyncStore;
  folderPath: string;
}): Promise<FolderSyncSummary | null> {
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

  const scopePath = normalizeVaultFolderPath(options.folderPath);
  const files = selectBulkPushMarkdownFiles(options.app, scopePath);
  const client = new NotionClient({ token });
  const summary = createSummary(scopePath);
  const protectedFromQuarantinePageIds = new Set<string>();

  try {
    await client.getPageDetails(rootPageId);
  } catch (error) {
    reportSyncFailure(error);
    return null;
  }

  const firstSnapshot = await scanRemoteTree(client, rootPageId);
  const repair = await repairWorkspaceHierarchy({
    app: options.app,
    token,
    rootPageUrl: options.rootPageUrl,
    store: options.store,
    scope: "folder",
    folderPath: scopePath
  });
  if (repair) {
    summary.foldersCreated += repair.foldersCreated;
    summary.moved += repair.pagesMoved;
    summary.failed += repair.failed;
    if (repair.folderMappingsRepaired) {
      summary.details.push(`MAPPING_REPAIRED folder mappings repaired ${repair.folderMappingsRepaired}`);
    }
  }

  const init = await initializeWorkspaceMappings({
    app: options.app,
    token,
    rootPageUrl: options.rootPageUrl,
    store: options.store,
    scope: "folder",
    folderPath: scopePath
  });
  if (init?.ambiguous) {
    summary.ambiguous += init.ambiguous;
    summary.details.push(`AMBIGUOUS ${init.ambiguous} mapping initialization candidates skipped`);
  }
  if (init?.uninitializedDivergence) {
    summary.uninitializedDivergence += init.uninitializedDivergence;
    summary.details.push(`UNINITIALIZED_DIVERGENCE ${init.uninitializedDivergence} mapped notes skipped`);
  }

  for (const file of files) {
    const parent = await resolveNotionParentForFile({
      app: options.app,
      token,
      rootPageUrl: options.rootPageUrl,
      store: options.store,
      file
    });
    if (!parent) {
      summary.failed += 1;
      summary.details.push(`FAILED ${file.path} - could not resolve Notion folder parent`);
      continue;
    }
    summary.foldersCreated += parent.foldersCreated;

    const result = await pushFileToNotion({
      app: options.app,
      file,
      client,
      parentPageId: parent.parentPageId,
      expectedParentPageId: parent.parentPageId,
      repairMisplacedParent: true,
      baselineStore: options.store
    });
    applyPushResult(summary, result);
    if (result.status === "ambiguous" && result.pageId) {
      protectedFromQuarantinePageIds.add(normalizeNotionPageId(result.pageId));
    }
    if (isSuccessfulSyncResult(result) && result.pageId) {
      await options.store.saveManagedPageRecord({
        notionPageId: result.pageId,
        rootPageId: normalizeNotionPageId(rootPageId),
        lastKnownObsidianPath: normalizePath(file.path),
        lastKnownParentPageId: parent.parentPageId,
        updatedAt: new Date().toISOString()
      });
    }
  }

  const secondSnapshot = await scanRemoteTree(client, rootPageId);
  await quarantineVerifiedOrphans({
    app: options.app,
    client,
    store: options.store,
    rootPageId,
    scopePath,
    localFiles: files,
    protectedFromQuarantinePageIds,
    firstSnapshot,
    secondSnapshot,
    summary
  });

  new FolderSyncResultModal(options.app, summary).open();
  new Notice("LLM Wiki Sync: Folder sync complete");
  return summary;
}

export class FolderSyncResultModal extends Modal {
  private readonly summary: FolderSyncSummary;

  constructor(app: App, summary: FolderSyncSummary) {
    super(app);
    this.summary = summary;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("Folder sync complete")
      .setHeading();
    contentEl.createEl("pre", { text: formatFolderSyncSummary(this.summary) });
    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("Close")
        .onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function quarantineVerifiedOrphans(options: {
  app: App;
  client: NotionClient;
  store: FolderSyncStore;
  rootPageId: string;
  scopePath: string;
  localFiles: TFile[];
  protectedFromQuarantinePageIds: Set<string>;
  firstSnapshot: RemoteTreePage[];
  secondSnapshot: RemoteTreePage[];
  summary: FolderSyncSummary;
}): Promise<void> {
  const selectedLocalPageIds = new Set<string>();
  const folderPageIds = new Set(options.store.getAllFolderMappings().map((mapping) => normalizeNotionPageId(mapping.notionPageId)));
  for (const file of options.localFiles) {
    const mapping = await getNotionPageMapping(options.app, file);
    if (mapping.pageId) {
      selectedLocalPageIds.add(normalizeNotionPageId(mapping.pageId));
    }
  }

  const baselineIds = new Set(options.store.getAllSyncBaselinePageIds().map(normalizeNotionPageId));
  const firstIds = new Set(options.firstSnapshot.map((page) => normalizeNotionPageId(page.id)));
  const secondById = new Map(options.secondSnapshot.map((page) => [normalizeNotionPageId(page.id), page]));
  let reviewPageIds: { reviewPageId: string; obsidianMissingPageId: string; ambiguousPageId: string } | null = null;

  for (const [normalizedPageId, page] of secondById) {
    if (isReviewPath(page.path)) {
      continue;
    }
    if (!baselineIds.has(normalizedPageId) || selectedLocalPageIds.has(normalizedPageId) || !firstIds.has(normalizedPageId)) {
      if (!baselineIds.has(normalizedPageId) && !folderPageIds.has(normalizedPageId) && !isReviewPath(page.path)) {
        options.summary.remoteNew += 1;
      }
      continue;
    }

    const managedRecord = options.store.getManagedPageRecord(page.id);
    if (
      !managedRecord ||
      normalizeNotionPageId(managedRecord.rootPageId) !== normalizeNotionPageId(options.rootPageId) ||
      !isPathInScope(managedRecord.lastKnownObsidianPath, options.scopePath)
    ) {
      options.summary.legacyUnscoped += 1;
      options.summary.ambiguous += 1;
      options.summary.details.push(`LEGACY_UNSCOPED ${page.path} - no selected-folder Obsidian path evidence; Review move skipped`);
      continue;
    }

    if (findSelectedLocalFileByPath(options.localFiles, managedRecord.lastKnownObsidianPath)) {
      options.summary.ambiguous += 1;
      options.summary.details.push(`MAPPING_LOST ${managedRecord.lastKnownObsidianPath} - local file still exists but notion_page_id mapping is missing or ambiguous; Review move skipped`);
      continue;
    }

    if (options.protectedFromQuarantinePageIds.has(normalizedPageId)) {
      options.summary.ambiguous += 1;
      options.summary.details.push(`AMBIGUOUS ${page.path} - protected from Review after ambiguous local reconciliation`);
      continue;
    }

    const localMatches = await findFilesMappedToPage(options.app, page.id);
    if (localMatches.length > 0) {
      options.summary.ambiguous += 1;
      options.summary.details.push(`AMBIGUOUS ${page.path} - local mapping still exists outside selected scan`);
      continue;
    }

    options.summary.orphanCandidates += 1;
    try {
      reviewPageIds = reviewPageIds ?? await ensureReviewPages(options.client, options.rootPageId);
      await options.client.movePageToPage(page.id, reviewPageIds.obsidianMissingPageId);
      await options.store.saveQuarantineRecord({
        notionPageId: page.id,
        rootPageId: normalizeNotionPageId(options.rootPageId),
        reason: "MISSING_IN_OBSIDIAN",
        previousParentPageId: page.parentPageId,
        previousTitle: page.title,
        lastKnownObsidianPath: managedRecord.lastKnownObsidianPath,
        previousNotionPath: page.path,
        quarantinedAt: new Date().toISOString()
      });
      options.summary.movedToReview += 1;
      options.summary.details.push(`REVIEW ${page.path} - previously synced but no local match`);
    } catch (error) {
      options.summary.failed += 1;
      options.summary.details.push(`FAILED ${page.path} - Review move failed: ${getErrorMessage(error)}`);
    }
  }
}

async function ensureReviewPages(client: NotionClient, rootPageId: string): Promise<{ reviewPageId: string; obsidianMissingPageId: string; ambiguousPageId: string }> {
  const reviewPageId = await ensureChildPageByTitle(client, rootPageId, REVIEW_FOLDER_TITLE);
  const obsidianMissingPageId = await ensureChildPageByTitle(client, reviewPageId, REVIEW_OBSIDIAN_MISSING_TITLE);
  const ambiguousPageId = await ensureChildPageByTitle(client, reviewPageId, REVIEW_AMBIGUOUS_TITLE);
  return { reviewPageId, obsidianMissingPageId, ambiguousPageId };
}

async function ensureChildPageByTitle(client: NotionClient, parentPageId: string, title: string): Promise<string> {
  const matches = (await client.listChildPages(parentPageId, "Hierarchy")).filter((page) => page.title === title);
  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous Review page: ${title}`);
  }
  const created = await client.createChildPage({ parentPageId, title, markdown: "", pushedAt: new Date() });
  return created.id;
}

async function scanRemoteTree(client: NotionClient, rootPageId: string): Promise<RemoteTreePage[]> {
  const pages: RemoteTreePage[] = [];
  await scanRemoteChildren(client, rootPageId, "", pages, new Set([normalizeNotionPageId(rootPageId)]));
  return pages;
}

async function scanRemoteChildren(
  client: NotionClient,
  parentPageId: string,
  parentPath: string,
  pages: RemoteTreePage[],
  visitedPageIds: Set<string>
): Promise<void> {
  const children = await client.listChildPages(parentPageId, "Hierarchy");
  for (const child of children) {
    const normalizedChildId = normalizeNotionPageId(child.id);
    if (visitedPageIds.has(normalizedChildId)) {
      continue;
    }
    visitedPageIds.add(normalizedChildId);
    const path = parentPath ? `${parentPath}/${child.title}` : child.title;
    const page = { id: child.id, title: child.title, parentPageId, path };
    pages.push(page);
    if (!isReviewPath(path)) {
      await scanRemoteChildren(client, child.id, path, pages, visitedPageIds);
    }
  }
}

export function getSelectableFolderPaths(app: App): string[] {
  const folders = new Set<string>([""]);
  for (const file of app.vault.getMarkdownFiles()) {
    const normalizedPath = normalizePath(file.path);
    if (isSystemObsidianPath(normalizedPath)) {
      continue;
    }
    const folderPath = getFolderPath(normalizedPath);
    const segments = folderPath ? folderPath.split("/") : [];
    for (let index = 0; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index + 1).join("/"));
    }
  }
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

function applyPushResult(summary: FolderSyncSummary, result: PushFileResult): void {
  if (result.hierarchyMoved) summary.moved += 1;
  if (result.status === "created") summary.created += 1;
  else if (result.status === "updated") summary.updated += 1;
  else if (result.status === "clean") summary.alreadyInSync += 1;
  else if (result.status === "remote_changed") summary.remoteChanged += 1;
  else if (result.status === "conflict") summary.conflicts += 1;
  else if (result.status === "misplaced" || result.status === "ambiguous") summary.ambiguous += 1;
  else summary.failed += 1;
  summary.details.push(`${result.status.toUpperCase()} ${result.filePath} - ${result.message}`);
}

function isSuccessfulSyncResult(result: PushFileResult): boolean {
  return result.status === "created" || result.status === "updated" || result.status === "clean";
}

function createSummary(scopePath: string): FolderSyncSummary {
  return {
    scopePath,
    created: 0,
    updated: 0,
    moved: 0,
    foldersCreated: 0,
    alreadyInSync: 0,
    remoteChanged: 0,
    conflicts: 0,
    ambiguous: 0,
    remoteNew: 0,
    legacyUnscoped: 0,
    uninitializedDivergence: 0,
    orphanCandidates: 0,
    movedToReview: 0,
    failed: 0,
    details: []
  };
}

function formatFolderSyncSummary(summary: FolderSyncSummary): string {
  return [
    "LLM Wiki Sync - Folder sync complete",
    "",
    `Scope: ${summary.scopePath || "Vault root"}`,
    "",
    `Created:              ${summary.created}`,
    `Updated:              ${summary.updated}`,
    `Moved:                ${summary.moved}`,
    `Folders created:      ${summary.foldersCreated}`,
    `Already in sync:      ${summary.alreadyInSync}`,
    "",
    `Remote changed:       ${summary.remoteChanged}`,
    `Conflicts:            ${summary.conflicts}`,
    `Ambiguous:            ${summary.ambiguous}`,
    `Remote new:           ${summary.remoteNew}`,
    `Legacy unscoped:      ${summary.legacyUnscoped}`,
    `Uninitialized divergence: ${summary.uninitializedDivergence}`,
    `Orphan candidates:    ${summary.orphanCandidates}`,
    `Moved to Review:      ${summary.movedToReview}`,
    `Failed:               ${summary.failed}`,
    "",
    ...summary.details
  ].join("\n");
}

function isReviewPath(path: string): boolean {
  return path === REVIEW_FOLDER_TITLE || path.startsWith(`${REVIEW_FOLDER_TITLE}/`);
}

function isPathInScope(path: string, scopePath: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedScope = normalizeVaultFolderPath(scopePath);
  if (!normalizedScope) {
    return !isSystemObsidianPath(normalizedPath);
  }
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function findSelectedLocalFileByPath(files: TFile[], path: string): TFile | null {
  const normalizedPath = normalizePath(path);
  return files.find((file) => normalizePath(file.path) === normalizedPath) ?? null;
}

function isSystemObsidianPath(path: string): boolean {
  const topLevel = path.split("/")[0] ?? "";
  return SYSTEM_OBSIDIAN_FOLDERS.has(topLevel);
}

function reportSyncFailure(error: unknown): void {
  if (error instanceof NotionApiError) {
    new Notice(`LLM Wiki Sync: Folder sync failed (${error.status}) - ${error.message}`);
    return;
  }
  new Notice(`LLM Wiki Sync: Folder sync failed - ${getErrorMessage(error)}`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
