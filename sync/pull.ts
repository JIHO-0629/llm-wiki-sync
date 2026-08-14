import { Notice, normalizePath, TFile, type App } from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "../notionClient";
import { isSafeVisibleFileName, sanitizeNotionTitleForFileName } from "../utils/fileName";
import {
  compareSnapshotsToBaseline,
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshotFromFetched,
  logBaselineNotAdvanced,
  logConflictState,
  type RemoteSyncSnapshot,
  type SyncBaselineStore
} from "./baseline";
import {
  createFrontmatterForNotionPage,
  findFilesMappedToPage,
  getNotionPageMapping,
  normalizeNotionPageId,
  normalizePulledMarkdown,
  replaceMarkdownBodyPreservingFrontmatter
} from "./mapping";

export interface PullPagesFromNotionOptions {
  app: App;
  token: string;
  rootPageUrl: string;
  baselineStore: SyncBaselineStore;
}

interface PullCounts { created: number; updated: number; skipped: number; failed: number; }

const PULL_FOLDER = "LLM Wiki Sync Pull";

export async function pullPagesFromNotion(options: PullPagesFromNotionOptions): Promise<void> {
  const runId = createRunId();
  const logPrefix = `[LLM Wiki Sync][Pull][${runId}]`;
  const counts: PullCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const token = options.token.trim();
  if (!token) { new Notice("LLM Wiki Sync: Notion API token is missing"); return; }

  const rootPageId = extractNotionPageId(options.rootPageUrl);
  console.debug(`${logPrefix} root page id:`, rootPageId || "<invalid>");
  if (!rootPageId) { new Notice("LLM Wiki Sync: Notion Root Page URL is invalid"); return; }

  const client = new NotionClient({ token });
  new Notice("LLM Wiki Sync: Pulling from Notion...");

  try {
    const childPages = await client.listRootChildPages(rootPageId);
    if (!options.app.vault.getAbstractFileByPath(PULL_FOLDER)) await options.app.vault.createFolder(PULL_FOLDER);

    for (const childPage of childPages) {
      try {
        const pageLog = `${logPrefix}[${childPage.id}]`;
        console.debug(`${pageLog} notion_page_id:`, childPage.id);
        const mappedFiles = await findFilesMappedToPage(options.app, childPage.id);
        if (mappedFiles.length > 1) {
          console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, childPage.id);
          counts.skipped += 1;
          new Notice("LLM Wiki Sync: Duplicate local mapping conflict.");
          continue;
        }

        if (mappedFiles.length === 1) {
          const mappedFile = mappedFiles[0];
          let baseline;
          try {
            baseline = options.baselineStore.getSyncBaseline(childPage.id);
          } catch (error) {
            console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
            counts.failed += 1;
            new Notice("LLM Wiki Sync: Baseline error. Operation aborted.");
            continue;
          }
          console.debug(`[LLM Wiki Sync][Baseline][${runId}] loaded`, Boolean(baseline));
          if (!baseline) {
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: No sync baseline exists for this note. Initialize the baseline first.");
            continue;
          }

          const localSnapshot = await getLocalSyncSnapshot(options.app, mappedFile);
          const pageDetails = await client.getPageDetails(childPage.id);
          const rawTitle = pageDetails.title || childPage.title;
          const pageMarkdown = await client.retrievePageMarkdown(childPage.id);
          const remoteSnapshot = getRemoteSyncSnapshotFromFetched(pageDetails, pageMarkdown);
          const cleanMarkdown = normalizePulledMarkdown(pageMarkdown.markdown);
          if (pageMarkdown.truncated) {
            console.warn(`${pageLog} Notion content truncated:`, pageMarkdown.unknownBlockIds);
            new Notice("LLM Wiki Sync: Warning - Notion page content was truncated");
          }

          const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
          logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
          if (change.state === "CLEAN") {
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: Already in sync.");
            continue;
          }
          if (change.state === "LOCAL_ONLY_CHANGED") {
            counts.skipped += 1;
            console.warn(`${pageLog} stale Pull protection: Obsidian changed since baseline`);
            new Notice("LLM Wiki Sync: Obsidian changed since the last sync. Push first.");
            continue;
          }
          if (change.state === "CONFLICT") {
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: Conflict detected. Both Obsidian and Notion changed.");
            continue;
          }

          console.debug(`${pageLog} raw Notion title:`, rawTitle);
          console.debug(`${pageLog} current local path:`, mappedFile.path);
          console.debug(`${pageLog} body update start`);
          const existingMarkdown = await options.app.vault.read(mappedFile);
          await options.app.vault.modify(mappedFile, replaceMarkdownBodyPreservingFrontmatter(existingMarkdown, cleanMarkdown, childPage.id));
          console.debug(`${pageLog} body update result: success`);
          counts.updated += 1;

          const renameResult = await renameMappedFileAfterPull(options.app, mappedFile, childPage.id, rawTitle, runId);
          if (renameResult === "renamed" || renameResult === "noop") {
            await advancePullBaselineAfterSuccess(options.app, options.baselineStore, childPage.id, remoteSnapshot, runId, "advanced");
            new Notice(renameResult === "renamed" ? "LLM Wiki Sync: Updated content and filename." : "LLM Wiki Sync: Updated content.");
          } else {
            logBaselineNotAdvanced(runId, `rename result: ${renameResult}`);
            new Notice(renameResult === "collision"
              ? "LLM Wiki Sync: Content updated; rename skipped due to filename collision."
              : "LLM Wiki Sync: Content updated; rename failed or skipped. Check console.");
          }
          continue;
        }

        const pageDetails = await client.getPageDetails(childPage.id);
        const rawTitle = pageDetails.title || childPage.title;
        const pageMarkdown = await client.retrievePageMarkdown(childPage.id);
        const remoteSnapshot = getRemoteSyncSnapshotFromFetched(pageDetails, pageMarkdown);
        const cleanMarkdown = normalizePulledMarkdown(pageMarkdown.markdown);
        if (pageMarkdown.truncated) {
          console.warn(`${pageLog} Notion content truncated:`, pageMarkdown.unknownBlockIds);
          new Notice("LLM Wiki Sync: Warning - Notion page content was truncated");
        }

        const fileName = sanitizeNotionTitleForFileName(rawTitle);
        if (!fileName || !isSafeVisibleFileName(fileName)) {
          console.error(`${pageLog} sanitizer error: unsafe create target basename`, fileName || "<invalid>");
          counts.failed += 1;
          continue;
        }
        const filePath = normalizePath(`${PULL_FOLDER}/${fileName}`);
        if (options.app.vault.getAbstractFileByPath(filePath)) {
          console.warn(`${pageLog} create skipped: target already exists`, filePath);
          counts.skipped += 1;
          continue;
        }
        console.debug(`${pageLog} Mode: create`, filePath);
        await options.app.vault.create(filePath, createFrontmatterForNotionPage(childPage.id) + cleanMarkdown);
        await advancePullBaselineAfterSuccess(options.app, options.baselineStore, childPage.id, remoteSnapshot, runId, "initialized");
        counts.created += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`${logPrefix} child page failed`, childPage.id, getErrorMessage(error));
      }
    }
  } catch (error) {
    reportPullFailure(error);
    return;
  }

  new Notice(`LLM Wiki Sync: Created ${counts.created}, updated ${counts.updated}, skipped ${counts.skipped}, failed ${counts.failed}.`);
}

async function advancePullBaselineAfterSuccess(
  app: App,
  baselineStore: SyncBaselineStore,
  pageId: string,
  remoteSnapshot: RemoteSyncSnapshot,
  runId: string,
  action: "advanced" | "initialized"
): Promise<void> {
  try {
    const mappedFiles = await findFilesMappedToPage(app, pageId);
    if (mappedFiles.length !== 1) {
      logBaselineNotAdvanced(runId, `expected exactly one mapped file after Pull, found ${mappedFiles.length}`);
      return;
    }

    const localSnapshot = await getLocalSyncSnapshot(app, mappedFiles[0]);
    await baselineStore.saveSyncBaseline(pageId, createSyncBaseline(pageId, localSnapshot, remoteSnapshot));
    console.debug(`[LLM Wiki Sync][Baseline][${runId}] ${action}`, pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${runId}] ${action} failed`, getErrorMessage(error));
    logBaselineNotAdvanced(runId, "baseline save failed after Pull");
  }
}

export async function renameMappedFileAfterPull(app: App, file: TFile, pageId: string, rawTitle: string, runId: string): Promise<"renamed" | "noop" | "collision" | "failed"> {
  const logPrefix = `[LLM Wiki Sync][Rename][${runId}]`;
  const targetBaseName = sanitizeNotionTitleForFileName(rawTitle);
  console.debug(`${logPrefix} raw Notion title:`, rawTitle);
  console.debug(`${logPrefix} sanitized target basename:`, targetBaseName || "<invalid>");
  if (!targetBaseName) return "failed";
  if (!isSafeVisibleFileName(targetBaseName)) {
    console.error(`${logPrefix} sanitizer error: unsafe rename target basename`, targetBaseName);
    return "failed";
  }

  const folderPath = file.parent?.path ?? "";
  const targetPath = normalizePath(folderPath ? `${folderPath}/${targetBaseName}` : targetBaseName);
  const currentPath = file.path;
  const targetExisting = app.vault.getAbstractFileByPath(targetPath);
  console.debug(`${logPrefix} current:`, currentPath);
  console.debug(`${logPrefix} target:`, targetPath);
  console.debug(`${logPrefix} target exists:`, Boolean(targetExisting));
  if (targetPath === currentPath) return "noop";
  if (targetExisting && targetExisting !== file) {
    console.warn(`${logPrefix} COLLISION`);
    console.warn(`${logPrefix} current:`, currentPath);
    console.warn(`${logPrefix} target:`, targetPath);
    return "collision";
  }

  try {
    console.debug(`${logPrefix} rename start`);
    await app.fileManager.renameFile(file, targetPath);
  } catch (error) {
    if (!isCaseOnlyRename(currentPath, targetPath)) {
      console.error(`${logPrefix} rename failed:`, getErrorMessage(error));
      return "failed";
    }
    try {
      await renameCaseOnlyViaTemporaryPath(app, file, currentPath, targetPath, runId);
    } catch (temporaryError) {
      console.error(`${logPrefix} case-only rename failed:`, getErrorMessage(temporaryError));
      return "failed";
    }
  }

  const renamedFile = app.vault.getAbstractFileByPath(targetPath);
  if (!(renamedFile instanceof TFile) || renamedFile.path !== targetPath) {
    console.error(`${logPrefix} verification failed: target does not exist`, targetPath);
    return "failed";
  }
  const mapping = await getNotionPageMapping(app, renamedFile);
  const oldPathFile = app.vault.getAbstractFileByPath(currentPath);
  const mappingMatches = mapping.pageId && normalizeNotionPageId(mapping.pageId) === normalizeNotionPageId(pageId);
  console.debug(`${logPrefix} mapping verification result:`, Boolean(mappingMatches));
  if (!mappingMatches || (oldPathFile instanceof TFile && oldPathFile !== renamedFile)) {
    console.error(`${logPrefix} HIGH SEVERITY: rename mapping verification failed`);
    return "failed";
  }
  console.debug(`${logPrefix} rename result: success`);
  return "renamed";
}

async function renameCaseOnlyViaTemporaryPath(app: App, file: TFile, currentPath: string, targetPath: string, runId: string): Promise<void> {
  const folderPath = file.parent?.path ?? "";
  const tempPath = normalizePath(folderPath ? `${folderPath}/.llm-wiki-sync-${runId}-${Date.now()}.md` : `.llm-wiki-sync-${runId}-${Date.now()}.md`);
  if (app.vault.getAbstractFileByPath(tempPath)) throw new Error("Temporary rename path already exists");
  await app.fileManager.renameFile(file, tempPath);
  const tempFile = app.vault.getAbstractFileByPath(tempPath);
  if (!(tempFile instanceof TFile)) throw new Error("Temporary rename did not produce a file");
  try {
    await app.fileManager.renameFile(tempFile, targetPath);
  } catch (error) {
    try { await app.fileManager.renameFile(tempFile, currentPath); } catch (restoreError) {
      console.error(`[LLM Wiki Sync][Rename][${runId}] HIGH SEVERITY: could not restore temporary file`, getErrorMessage(restoreError));
    }
    throw error;
  }
}

function isCaseOnlyRename(currentPath: string, targetPath: string): boolean { return currentPath.toLocaleLowerCase() === targetPath.toLocaleLowerCase(); }
function createRunId(): string { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function getErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function reportPullFailure(error: unknown): void {
  if (error instanceof NotionApiError) new Notice(`LLM Wiki Sync: Pull failed (${error.status}) - ${error.message}`);
  else new Notice(`LLM Wiki Sync: Pull failed - ${getErrorMessage(error)}`);
}
