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
import { findFilesMappedToPage, getNotionPageMapping, isContainerIndexFile } from "./mapping";
import { pushFileToNotion, type PushFileResult } from "./push";
import { REVIEW_FOLDER_TITLE, isReviewPath, scanRemoteTree, type RemoteTreePage } from "./remoteTree";
import { CachedNotionClient, createSyncRunCache } from "./runCache";

export { REVIEW_FOLDER_TITLE };
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
  processed: number;
  total: number;
  durationMs: number;
  cancelled: boolean;
  details: string[];
}

export type SyncProgressPhase =
  | "local_scan"
  | "remote_scan"
  | "hierarchy_repair"
  | "note_sync"
  | "verification"
  | "review_check"
  | "complete"
  | "cancelled";

export interface SyncProgress {
  phase: SyncProgressPhase;
  phaseIndex: number;
  phaseTotal: number;
  processed?: number;
  total?: number;
  currentPath?: string;
  summary?: Partial<FolderSyncSummary>;
  message?: string;
  elapsedMs?: number;
}

export interface SyncCancelToken {
  cancelRequested: boolean;
}

const SYSTEM_OBSIDIAN_FOLDERS = new Set([".obsidian", "LLM Wiki Sync Pull", "LLM Wiki Sync Review"]);

export async function syncFolderWithNotion(options: {
  app: App;
  token: string;
  rootPageUrl: string;
  store: FolderSyncStore;
  folderPath: string;
  onProgress?: (progress: SyncProgress) => void;
  cancelToken?: SyncCancelToken;
  showResultModal?: boolean;
  verboseDebugLogging?: boolean;
}): Promise<FolderSyncSummary | null> {
  const startedAt = Date.now();
  const timings = new Map<string, number>();
  const emitProgress = (progress: Omit<SyncProgress, "elapsedMs" | "summary"> & { summary?: Partial<FolderSyncSummary> }) => {
    options.onProgress?.({
      ...progress,
      summary: progress.summary ?? summary,
      elapsedMs: Date.now() - startedAt
    });
  };
  const markTiming = (label: string, phaseStartedAt: number) => {
    timings.set(label, Date.now() - phaseStartedAt);
  };
  const token = options.token.trim();
  const scopePath = normalizeVaultFolderPath(options.folderPath);
  const summary = createSummary(scopePath);
  const finish = (phase: "complete" | "cancelled") => {
    summary.durationMs = Date.now() - startedAt;
    emitProgress({
      phase,
      phaseIndex: 6,
      phaseTotal: 6,
      processed: summary.processed,
      total: summary.total,
      message: phase === "cancelled" ? "Sync cancelled" : "Sync complete"
    });
    logPerfTimings(timings, summary.durationMs, options.verboseDebugLogging === true);
  };

  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return null;
  }
  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return null;
  }

  let phaseStartedAt = Date.now();
  emitProgress({
    phase: "local_scan",
    phaseIndex: 1,
    phaseTotal: 6,
    message: "Scanning Obsidian"
  });
  const files = selectBulkPushMarkdownFiles(options.app, scopePath);
  summary.total = files.length;
  markTiming("local scan", phaseStartedAt);
  const runCache = createSyncRunCache();
  const client = new CachedNotionClient({ token, cache: runCache });
  const protectedFromQuarantinePageIds = new Set<string>();

  try {
    await client.getPageDetails(rootPageId);
  } catch (error) {
    reportSyncFailure(error);
    return null;
  }

  phaseStartedAt = Date.now();
  emitProgress({
    phase: "remote_scan",
    phaseIndex: 2,
    phaseTotal: 6,
    total: files.length,
    message: "Scanning Notion"
  });
  const firstSnapshot = await scanRemoteTree(client, rootPageId);
  markTiming("first remote scan", phaseStartedAt);
  if (shouldCancel(options.cancelToken, summary, finish)) return summary;

  phaseStartedAt = Date.now();
  emitProgress({
    phase: "hierarchy_repair",
    phaseIndex: 3,
    phaseTotal: 6,
    total: files.length,
    message: "Repairing folder hierarchy"
  });
  const repair = await repairWorkspaceHierarchy({
    app: options.app,
    token,
    rootPageUrl: options.rootPageUrl,
    store: options.store,
    scope: "folder",
    folderPath: scopePath,
    client,
    runCache,
    onFolderProgress: (folderPath) => emitProgress({
      phase: "hierarchy_repair",
      phaseIndex: 3,
      phaseTotal: 6,
      total: files.length,
      currentPath: folderPath,
      message: "Checking folder"
    })
  });
  if (repair) {
    summary.foldersCreated += repair.foldersCreated;
    summary.moved += repair.pagesMoved;
    summary.failed += repair.failed;
    if (repair.folderMappingsRepaired) {
      summary.details.push(`MAPPING_REPAIRED folder mappings repaired ${repair.folderMappingsRepaired}`);
    }
  }
  markTiming("hierarchy repair", phaseStartedAt);
  if (shouldCancel(options.cancelToken, summary, finish)) return summary;

  phaseStartedAt = Date.now();
  const init = await initializeWorkspaceMappings({
    app: options.app,
    token,
    rootPageUrl: options.rootPageUrl,
    store: options.store,
    scope: "folder",
    folderPath: scopePath,
    client,
    runCache
  });
  if (init?.ambiguous) {
    summary.ambiguous += init.ambiguous;
    summary.details.push(`AMBIGUOUS ${init.ambiguous} mapping initialization candidates skipped`);
  }
  if (init?.uninitializedDivergence) {
    summary.uninitializedDivergence += init.uninitializedDivergence;
    summary.details.push(`UNINITIALIZED_DIVERGENCE ${init.uninitializedDivergence} mapped notes skipped`);
  }
  markTiming("mapping initialize", phaseStartedAt);
  if (shouldCancel(options.cancelToken, summary, finish)) return summary;

  phaseStartedAt = Date.now();
  emitProgress({
    phase: "note_sync",
    phaseIndex: 4,
    phaseTotal: 6,
    processed: 0,
    total: files.length,
    message: "Syncing notes"
  });
  for (const file of files) {
    if (shouldCancel(options.cancelToken, summary, finish)) return summary;
    if (await isContainerIndexFile(options.app, file)) {
      summary.failed += 1;
      summary.processed += 1;
      summary.details.push(`SKIPPED ${file.path} - container index files are excluded from normal Folder Sync`);
      continue;
    }
    emitProgress({
      phase: "note_sync",
      phaseIndex: 4,
      phaseTotal: 6,
      processed: summary.processed,
      total: files.length,
      currentPath: file.path,
      message: "Syncing note"
    });
    const parent = await resolveNotionParentForFile({
      app: options.app,
      token,
      rootPageUrl: options.rootPageUrl,
      store: options.store,
      file,
      client,
      runCache
    });
    if (!parent) {
      summary.failed += 1;
      summary.processed += 1;
      summary.details.push(`FAILED ${file.path} - could not resolve Notion folder parent`);
      emitProgress({
        phase: "note_sync",
        phaseIndex: 4,
        phaseTotal: 6,
        processed: summary.processed,
        total: files.length,
        currentPath: file.path
      });
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
    summary.processed += 1;
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
    emitProgress({
      phase: "note_sync",
      phaseIndex: 4,
      phaseTotal: 6,
      processed: summary.processed,
      total: files.length,
      currentPath: file.path
    });
  }
  markTiming("note sync", phaseStartedAt);
  if (shouldCancel(options.cancelToken, summary, finish)) return summary;

  phaseStartedAt = Date.now();
  emitProgress({
    phase: "verification",
    phaseIndex: 5,
    phaseTotal: 6,
    processed: summary.processed,
    total: files.length,
    message: "Verifying Notion hierarchy"
  });
  const secondSnapshot = await scanRemoteTree(client, rootPageId);
  markTiming("second remote scan", phaseStartedAt);
  if (shouldCancel(options.cancelToken, summary, finish)) return summary;

  phaseStartedAt = Date.now();
  emitProgress({
    phase: "review_check",
    phaseIndex: 6,
    phaseTotal: 6,
    processed: summary.processed,
    total: files.length,
    message: "Checking Review candidates"
  });
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
  markTiming("orphan verification", phaseStartedAt);

  finish("complete");
  if (options.showResultModal !== false) {
    new FolderSyncResultModal(options.app, summary).open();
  }
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
    processed: 0,
    total: 0,
    durationMs: 0,
    cancelled: false,
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
    `Duration:             ${formatDuration(summary.durationMs)}`,
    summary.cancelled ? "Cancelled:            yes" : "",
    "",
    ...summary.details
  ].join("\n");
}

function shouldCancel(cancelToken: SyncCancelToken | undefined, summary: FolderSyncSummary, finish: (phase: "complete" | "cancelled") => void): boolean {
  if (!cancelToken?.cancelRequested) {
    return false;
  }
  summary.cancelled = true;
  finish("cancelled");
  new Notice("LLM Wiki Sync: Sync cancelled");
  return true;
}

function logPerfTimings(timings: Map<string, number>, totalMs: number, enabled: boolean): void {
  if (!enabled) {
    return;
  }
  for (const [label, durationMs] of timings) {
    console.debug(`[LLM Wiki Sync][Perf] ${label}: ${durationMs}ms`);
  }
  console.debug(`[LLM Wiki Sync][Perf] total: ${totalMs}ms`);
}

function formatDuration(durationMs: number): string {
  if (!durationMs) {
    return "0s";
  }
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
