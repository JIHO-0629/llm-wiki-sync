import { Notice, type App } from "obsidian";
import { NotionApiError, NotionClient } from "../notionClient";
import {
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshot,
  type SyncBaselineStore
} from "./baseline";
import { findFilesMappedToPage, getNotionPageMapping, isContainerIndexFile } from "./mapping";

export async function initializeSyncBaseline(app: App, token: string, baselineStore: SyncBaselineStore): Promise<void> {
  const runId = createRunId();
  const logPrefix = `[LLM Wiki Sync][Baseline][${runId}]`;
  const file = app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file to initialize");
    return;
  }
  if (await isContainerIndexFile(app, file)) {
    new Notice("LLM Wiki Sync: Container index baseline initialization is not supported by normal note baseline initialization.");
    return;
  }

  const mapping = await getNotionPageMapping(app, file);
  if (!mapping.hasMapping || !mapping.pageId) {
    new Notice("LLM Wiki Sync: Active file has no notion_page_id mapping.");
    return;
  }

  const mappedFiles = await findFilesMappedToPage(app, mapping.pageId);
  console.debug(`${logPrefix} local mapping count:`, mappedFiles.length);
  if (mappedFiles.length !== 1) {
    console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, mapping.pageId);
    new Notice("LLM Wiki Sync: Duplicate local mapping conflict.");
    return;
  }

  const cleanToken = token.trim();
  if (!cleanToken) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return;
  }

  try {
    const client = new NotionClient({ token: cleanToken });
    const localSnapshot = await getLocalSyncSnapshot(app, file);
    const remoteSnapshot = await getRemoteSyncSnapshot(client, mapping.pageId);
    await baselineStore.saveSyncBaseline(mapping.pageId, createSyncBaseline(mapping.pageId, localSnapshot, remoteSnapshot));
    console.debug(`${logPrefix} initialized`, mapping.pageId);
    new Notice("LLM Wiki Sync: Sync baseline initialized. No content was changed.");
  } catch (error) {
    const reason = error instanceof NotionApiError ? `${error.status} - ${error.message}` : getErrorMessage(error);
    console.error(`${logPrefix} initialization failed:`, reason);
    new Notice(`LLM Wiki Sync: Baseline initialization failed (${reason}).`);
  }
}

function createRunId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
