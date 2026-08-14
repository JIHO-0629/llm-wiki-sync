import { Notice, normalizePath, type App } from "obsidian";
import { NotionApiError, NotionClient } from "../notionClient";
import { sanitizeNotionTitleForFileName } from "../utils/fileName";
import {
  compareSnapshotsToBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshot,
  logConflictState,
  shortFingerprint,
  type SyncBaselineStore
} from "./baseline";
import { findFilesMappedToPage, getNotionPageMapping } from "./mapping";

export async function debugActiveMapping(app: App, token: string, baselineStore: SyncBaselineStore): Promise<void> {
  const runId = createRunId();
  const file = app.workspace.getActiveFile();
  if (!file || file.extension !== "md") { new Notice("LLM Wiki Sync: No active Markdown file to debug"); return; }
  const mapping = await getNotionPageMapping(app, file);
  console.debug("[LLM Wiki Sync][Debug] run ID:", runId);
  console.debug("[LLM Wiki Sync][Debug] file path:", file.path);
  console.debug("[LLM Wiki Sync][Debug] basename:", file.basename);
  console.debug("[LLM Wiki Sync][Debug] notion_page_id:", mapping.pageId || "<none>");
  if (!mapping.hasMapping || !mapping.pageId) { new Notice("LLM Wiki Sync: Active file has no notion_page_id mapping."); return; }

  const mappingCount = (await findFilesMappedToPage(app, mapping.pageId)).length;
  console.debug("[LLM Wiki Sync][Debug] local mapping count:", mappingCount);
  let baseline;
  try {
    baseline = baselineStore.getSyncBaseline(mapping.pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
    new Notice("LLM Wiki Sync: Baseline error. Debug aborted.");
    return;
  }
  console.debug("[LLM Wiki Sync][Debug] baseline exists:", Boolean(baseline));
  if (baseline) {
    console.debug("[LLM Wiki Sync][Debug] baseline syncedAt:", baseline.syncedAt);
    console.debug("[LLM Wiki Sync][Debug] baseline local fingerprint:", shortFingerprint(baseline.localFingerprint));
    console.debug("[LLM Wiki Sync][Debug] baseline remote fingerprint:", shortFingerprint(baseline.remoteFingerprint));
  }

  const cleanToken = token.trim();
  if (!cleanToken) { new Notice("LLM Wiki Sync: Mapping logged; Notion token is missing for remote debug."); return; }
  try {
    const client = new NotionClient({ token: cleanToken });
    const page = await client.getPageDetails(mapping.pageId);
    const targetBaseName = sanitizeNotionTitleForFileName(page.title);
    const targetPath = targetBaseName ? normalizePath(file.parent?.path ? `${file.parent.path}/${targetBaseName}` : targetBaseName) : "<invalid>";
    const target = targetBaseName ? app.vault.getAbstractFileByPath(targetPath) : null;
    console.debug("[LLM Wiki Sync][Debug] corresponding Notion page ID:", mapping.pageId);
    console.debug("[LLM Wiki Sync][Debug] current Notion title:", page.title);
    console.debug("[LLM Wiki Sync][Debug] expected Pull target filename:", targetBaseName || "<invalid>");
    console.debug("[LLM Wiki Sync][Debug] target exists:", Boolean(target));
    console.debug("[LLM Wiki Sync][Debug] target is same file:", target === file);
    console.debug("[LLM Wiki Sync][Debug] parent type:", page.parentType || "<missing>");
    if (baseline && mappingCount === 1) {
      const localSnapshot = await getLocalSyncSnapshot(app, file);
      const remoteSnapshot = await getRemoteSyncSnapshot(client, mapping.pageId);
      const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
      console.debug("[LLM Wiki Sync][Debug] current local fingerprint:", shortFingerprint(localSnapshot.fingerprint));
      console.debug("[LLM Wiki Sync][Debug] current remote fingerprint:", shortFingerprint(remoteSnapshot.fingerprint));
      console.debug("[LLM Wiki Sync][Debug] local mtime:", localSnapshot.mtime);
      console.debug("[LLM Wiki Sync][Debug] Notion last_edited_time:", remoteSnapshot.lastEditedTime || "<missing>");
      console.debug("[LLM Wiki Sync][Debug] localChanged:", change.localChanged);
      console.debug("[LLM Wiki Sync][Debug] remoteChanged:", change.remoteChanged);
      console.debug("[LLM Wiki Sync][Debug] state:", change.state);
      logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
    }
    new Notice("LLM Wiki Sync: Active mapping details logged to console.");
  } catch (error) {
    const reason = error instanceof NotionApiError ? `${error.status} - ${error.message}` : getErrorMessage(error);
    console.error("[LLM Wiki Sync][Debug] remote lookup failed:", reason);
    new Notice(`LLM Wiki Sync: Mapping logged; Notion lookup failed (${reason}).`);
  }
}

function getErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function createRunId(): string { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
