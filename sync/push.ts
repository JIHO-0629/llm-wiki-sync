import { Notice, type App } from "obsidian";
import { markdownToNotionBlocks } from "../markdown/notionBlocks";
import type { TFile } from "obsidian";
import {
  extractNotionPageId,
  NotionApiError,
  NotionClient,
  NOTION_CREATE_PAGE_ENDPOINT
} from "../notionClient";
import {
  compareSnapshotsToBaseline,
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshot,
  logBaselineNotAdvanced,
  logConflictState,
  type SyncBaselineStore
} from "./baseline";
import { findFilesMappedToPage, getNotionPageMapping, removeNotionPageMappingFromMarkdown, setNotionPageMapping } from "./mapping";

export interface PushCurrentNoteOptions {
  app: App;
  token: string;
  rootPageUrl: string;
  baselineStore: SyncBaselineStore;
  resolveParentPageId?: (file: TFile) => Promise<string | null>;
}

export type PushFileStatus =
  | "created"
  | "updated"
  | "clean"
  | "remote_changed"
  | "conflict"
  | "ambiguous"
  | "misplaced"
  | "failed";

export interface PushFileResult {
  status: PushFileStatus;
  filePath: string;
  pageId?: string;
  message: string;
  hierarchyMoved?: boolean;
  error?: unknown;
}

export async function pushCurrentNoteToNotion(options: PushCurrentNoteOptions): Promise<void> {
  const runId = createRunId();
  const activeFile = options.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file to push");
    return;
  }

  const noteTitle = activeFile.basename;
  const logPrefix = `[LLM Wiki Sync][Push][${runId}]`;
  console.debug(`${logPrefix} local current path:`, activeFile.path);
  console.debug(`${logPrefix} derived Notion title:`, noteTitle);

  const existingMapping = await getNotionPageMapping(options.app, activeFile);
  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return;
  }

  const markdown = await options.app.vault.read(activeFile);
  const markdownBody = removeNotionPageMappingFromMarkdown(markdown);
  const client = new NotionClient({ token });

  if (existingMapping.hasMapping) {
    if (!existingMapping.pageId) {
      new Notice("LLM Wiki Sync: Push failed - notion_page_id is empty");
      return;
    }
    if (!noteTitle.trim()) {
      new Notice("LLM Wiki Sync: Push failed - local filename is empty");
      return;
    }

    const mappedFiles = await findFilesMappedToPage(options.app, existingMapping.pageId);
    console.debug(`${logPrefix} local mapping count:`, mappedFiles.length);
    if (mappedFiles.length !== 1) {
      console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, existingMapping.pageId);
      new Notice("LLM Wiki Sync: Duplicate local mapping conflict.");
      return;
    }

    console.debug(`${logPrefix} Mode: update`);
    console.debug(`${logPrefix} notion_page_id:`, existingMapping.pageId);

    let baseline;
    try {
      baseline = options.baselineStore.getSyncBaseline(existingMapping.pageId);
    } catch (error) {
      console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
      new Notice("LLM Wiki Sync: Baseline error. Operation aborted.");
      return;
    }
    console.debug(`[LLM Wiki Sync][Baseline][${runId}] loaded`, Boolean(baseline));
    if (!baseline) {
      new Notice("LLM Wiki Sync: No sync baseline exists for this note. Initialize the baseline first.");
      return;
    }

    let localSnapshot;
    let remoteSnapshot;
    try {
      localSnapshot = await getLocalSyncSnapshot(options.app, activeFile);
      remoteSnapshot = await getRemoteSyncSnapshot(client, existingMapping.pageId);
    } catch (error) {
      console.error(`${logPrefix} preflight snapshot failed`, getErrorMessage(error));
      new Notice("LLM Wiki Sync: Push aborted - could not verify sync baseline.");
      return;
    }

    const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
    logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
    if (change.state === "CLEAN") {
      new Notice("LLM Wiki Sync: Already in sync.");
      return;
    }
    if (change.state === "REMOTE_ONLY_CHANGED") {
      console.warn(`${logPrefix} stale Push protection: Notion changed since baseline`);
      new Notice("LLM Wiki Sync: Notion changed since the last sync. Pull first.");
      return;
    }
    if (change.state === "CONFLICT") {
      new Notice("LLM Wiki Sync: Conflict detected. Both Obsidian and Notion changed.");
      return;
    }

    new Notice("LLM Wiki Sync: Updating linked Notion page...");

    try {
      console.debug(`${logPrefix} body update start`);
      await client.updatePageMarkdown(existingMapping.pageId, localSnapshot.body);
      console.debug(`${logPrefix} body update result: success`);
    } catch (error) {
      reportPushFailure(logPrefix, error);
      return;
    }

    try {
      const pageDetails = await client.getPageDetails(existingMapping.pageId);
      if (pageDetails.parentType === "data_source_id") {
        console.warn(`${logPrefix} title update skipped: data-source parent is outside RC scope`);
        logBaselineNotAdvanced(runId, "title sync skipped for data-source parent");
        new Notice("LLM Wiki Sync: Content updated; title sync skipped for data-source page.");
        return;
      }

      console.debug(`${logPrefix} title update start`);
      const updatedPage = await client.updatePageTitle(existingMapping.pageId, noteTitle);
      console.debug(`${logPrefix} title update HTTP status:`, updatedPage.response.status);
      if (normalizePageId(updatedPage.id) !== normalizePageId(existingMapping.pageId)) {
        throw new Error("Notion title update returned a different page ID");
      }

      console.debug(`${logPrefix} final result: success`);
      try {
        const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, activeFile);
        const nextRemoteSnapshot = await getRemoteSyncSnapshot(client, existingMapping.pageId);
        await options.baselineStore.saveSyncBaseline(
          existingMapping.pageId,
          createSyncBaseline(existingMapping.pageId, nextLocalSnapshot, nextRemoteSnapshot)
        );
        console.debug(`[LLM Wiki Sync][Baseline][${runId}] advanced`, existingMapping.pageId);
      } catch (baselineError) {
        console.error(`[LLM Wiki Sync][Baseline][${runId}] advance failed`, getErrorMessage(baselineError));
        logBaselineNotAdvanced(runId, "baseline refresh failed after full Push");
        new Notice("LLM Wiki Sync: Updated Notion content and title; baseline update failed. Check console.");
        return;
      }
      new Notice("LLM Wiki Sync: Updated Notion content and title.");
    } catch (error) {
      if (error instanceof NotionApiError) {
        console.error(`${logPrefix} title update failed after content update`, error.status, error.message);
        logBaselineNotAdvanced(runId, "title update failed after body update");
        new Notice(`LLM Wiki Sync: Content updated; title update failed (${error.status}). Check console.`);
        return;
      }

      console.error(`${logPrefix} title update failed after content update`, getErrorMessage(error));
      logBaselineNotAdvanced(runId, "title update failed after body update");
      new Notice("LLM Wiki Sync: Content updated; title update failed. Check console.");
    }
    return;
  }

  console.debug("[LLM Wiki Sync][Push] Mode: create");

  const parentPageId = extractNotionPageId(options.rootPageUrl);
  console.debug("[LLM Wiki Sync][Root check] extracted root page id", parentPageId || "<invalid>");

  if (!parentPageId) {
    new Notice("LLM Wiki Sync: Notion Root Page URL is invalid");
    return;
  }

  try {
    const pushedAt = new Date();

    await client.getPage(parentPageId);

    const createdPage = await client.createChildPage({
      parentPageId,
      title: noteTitle,
      children: markdownToNotionBlocks(markdownBody),
      pushedAt
    });

    console.debug("[LLM Wiki Sync][Create page] endpoint", NOTION_CREATE_PAGE_ENDPOINT);
    console.debug("[LLM Wiki Sync][Create page] parent page id", parentPageId);
    console.debug("[LLM Wiki Sync][Create page] note title", noteTitle);
    console.debug("[LLM Wiki Sync][Create page] created page id", createdPage.id);
    console.debug("[LLM Wiki Sync][Create page] created page url", createdPage.url);

    await setNotionPageMapping(options.app, activeFile, createdPage.id);
    try {
      const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, activeFile);
      const nextRemoteSnapshot = await getRemoteSyncSnapshot(client, createdPage.id);
      await options.baselineStore.saveSyncBaseline(
        createdPage.id,
        createSyncBaseline(createdPage.id, nextLocalSnapshot, nextRemoteSnapshot)
      );
      console.debug(`[LLM Wiki Sync][Baseline][${runId}] initialized`, createdPage.id);
    } catch (baselineError) {
      console.error(`[LLM Wiki Sync][Baseline][${runId}] initialization failed`, getErrorMessage(baselineError));
      logBaselineNotAdvanced(runId, "baseline initialization failed after Push create");
      new Notice("LLM Wiki Sync: Pushed and linked to Notion; baseline initialization failed. Check console.");
      return;
    }

    new Notice("LLM Wiki Sync: Pushed and linked to Notion.");
  } catch (error) {
    if (error instanceof NotionApiError) {
      new Notice(`LLM Wiki Sync: Push failed (${error.status}) - ${error.message}`);
      return;
    }

    new Notice(`LLM Wiki Sync: Push failed - ${getErrorMessage(error)}`);
  }
}

export async function pushFileToNotion(options: {
  app: App;
  file: TFile;
  client: NotionClient;
  parentPageId: string;
  expectedParentPageId?: string;
  repairMisplacedParent?: boolean;
  baselineStore: SyncBaselineStore;
}): Promise<PushFileResult> {
  const runId = createRunId();
  const file = options.file;
  const noteTitle = file.basename;
  const logPrefix = `[LLM Wiki Sync][Push][${runId}]`;

  if (file.extension !== "md") {
    return createPushFileResult(file, "failed", "Only Markdown files can be pushed");
  }
  if (!noteTitle.trim()) {
    return createPushFileResult(file, "failed", "Push failed - local filename is empty");
  }

  const mapping = await getNotionPageMapping(options.app, file);
  if (mapping.hasMapping) {
    if (!mapping.pageId) {
      return createPushFileResult(file, "failed", "Push failed - notion_page_id is empty");
    }

    const mappedFiles = await findFilesMappedToPage(options.app, mapping.pageId);
    if (mappedFiles.length !== 1) {
      console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, mapping.pageId);
      return createPushFileResult(file, "ambiguous", "Duplicate local mapping conflict.", mapping.pageId);
    }

    let hierarchyMoved = false;
    if (options.expectedParentPageId) {
      try {
        const details = await options.client.getPageDetails(mapping.pageId);
        if (details.parentType !== "page_id" || normalizePageId(details.parentPageId ?? "") !== normalizePageId(options.expectedParentPageId)) {
          if (!options.repairMisplacedParent) {
            return createPushFileResult(file, "misplaced", "Notion page is not under the expected parent.", mapping.pageId);
          }
          await options.client.movePageToPage(mapping.pageId, options.expectedParentPageId);
          hierarchyMoved = true;
        }
      } catch (error) {
        console.error(`${logPrefix} hierarchy parent check failed`, getErrorMessage(error));
        return createPushFileResult(file, "failed", "Push aborted - could not verify Notion page hierarchy.", mapping.pageId, error);
      }
    }

    let baseline;
    try {
      baseline = options.baselineStore.getSyncBaseline(mapping.pageId);
    } catch (error) {
      console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
      return createPushFileResult(file, "failed", "Baseline error. Operation aborted.", mapping.pageId, error);
    }
    if (!baseline) {
      return createPushFileResult(file, "failed", "No sync baseline exists for this note. Initialize the baseline first.", mapping.pageId);
    }

    let localSnapshot;
    let remoteSnapshot;
    try {
      localSnapshot = await getLocalSyncSnapshot(options.app, file);
      remoteSnapshot = await getRemoteSyncSnapshot(options.client, mapping.pageId);
    } catch (error) {
      console.error(`${logPrefix} preflight snapshot failed`, getErrorMessage(error));
      return createPushFileResult(file, "failed", "Push aborted - could not verify sync baseline.", mapping.pageId, error);
    }

    const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
    logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
    if (change.state === "CLEAN") {
      return { ...createPushFileResult(file, "clean", hierarchyMoved ? "Moved to the expected Notion folder. Already in sync." : "Already in sync.", mapping.pageId), hierarchyMoved };
    }
    if (change.state === "REMOTE_ONLY_CHANGED") {
      return createPushFileResult(file, "remote_changed", "Notion changed since the last sync. Pull first.", mapping.pageId);
    }
    if (change.state === "CONFLICT") {
      return createPushFileResult(file, "conflict", "Conflict detected. Both Obsidian and Notion changed.", mapping.pageId);
    }

    try {
      await options.client.updatePageMarkdown(mapping.pageId, localSnapshot.body);
      const pageDetails = await options.client.getPageDetails(mapping.pageId);
      if (pageDetails.parentType === "data_source_id") {
        logBaselineNotAdvanced(runId, "title sync skipped for data-source parent");
        return createPushFileResult(file, "failed", "Content updated; title sync skipped for data-source page.", mapping.pageId);
      }
      await options.client.updatePageTitle(mapping.pageId, noteTitle);
      const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, file);
      const nextRemoteSnapshot = await getRemoteSyncSnapshot(options.client, mapping.pageId);
      await options.baselineStore.saveSyncBaseline(mapping.pageId, createSyncBaseline(mapping.pageId, nextLocalSnapshot, nextRemoteSnapshot));
      return { ...createPushFileResult(file, "updated", hierarchyMoved ? "Moved to the expected Notion folder and updated Notion content and title." : "Updated Notion content and title.", mapping.pageId), hierarchyMoved };
    } catch (error) {
      console.error(`${logPrefix} update failed`, getErrorMessage(error));
      return createPushFileResult(file, "failed", getPushFailureMessage(error), mapping.pageId, error);
    }
  }

  try {
    const markdown = await options.app.vault.read(file);
    const markdownBody = removeNotionPageMappingFromMarkdown(markdown);
    const createdPage = await options.client.createChildPage({
      parentPageId: options.parentPageId,
      title: noteTitle,
      children: markdownToNotionBlocks(markdownBody),
      pushedAt: new Date()
    });
    await setNotionPageMapping(options.app, file, createdPage.id);
    const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, file);
    const nextRemoteSnapshot = await getRemoteSyncSnapshot(options.client, createdPage.id);
    await options.baselineStore.saveSyncBaseline(createdPage.id, createSyncBaseline(createdPage.id, nextLocalSnapshot, nextRemoteSnapshot));
    return createPushFileResult(file, "created", "Pushed and linked to Notion.", createdPage.id);
  } catch (error) {
    return createPushFileResult(file, "failed", getPushFailureMessage(error), undefined, error);
  }
}

function createPushFileResult(file: TFile, status: PushFileStatus, message: string, pageId?: string, error?: unknown): PushFileResult {
  return {
    status,
    filePath: file.path,
    pageId,
    message,
    error
  };
}

function getPushFailureMessage(error: unknown): string {
  return error instanceof NotionApiError
    ? `Push failed (${error.status}) - ${error.message}`
    : `Push failed - ${getErrorMessage(error)}`;
}

function reportPushFailure(logPrefix: string, error: unknown): void {
  if (error instanceof NotionApiError) {
    console.error(`${logPrefix} body update failed`, error.status, error.message);
    new Notice(`LLM Wiki Sync: Update failed (${error.status}) - ${error.message}`);
    return;
  }

  console.error(`${logPrefix} body update failed`, getErrorMessage(error));
  new Notice(`LLM Wiki Sync: Update failed - ${getErrorMessage(error)}`);
}

function createRunId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function normalizePageId(pageId: string): string {
  return pageId.replace(/-/g, "").toLowerCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
