import { Notice, type App, type TFile } from "obsidian";
import { NotionApiError, NotionClient } from "../notionClient";
import {
  compareSnapshotsToBaseline,
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshot,
  logBaselineNotAdvanced,
  logConflictState,
  type LocalSyncSnapshot,
  type RemoteSyncSnapshot,
  type SyncBaseline,
  type SyncBaselineStore
} from "./baseline";
import {
  findFilesMappedToPage,
  getNotionPageMapping,
  normalizePulledMarkdown,
  replaceMarkdownBodyPreservingFrontmatter
} from "./mapping";
import { renameMappedFileAfterPull } from "./pull";

type ResolveStrategy = "KEEP_OBSIDIAN" | "KEEP_NOTION";

interface ResolveConflictOptions {
  app: App;
  token: string;
  baselineStore: SyncBaselineStore;
  strategy: ResolveStrategy;
}

interface ResolvePreflight {
  file: TFile;
  pageId: string;
  client: NotionClient;
  baseline: SyncBaseline;
  localSnapshot: LocalSyncSnapshot;
  remoteSnapshot: RemoteSyncSnapshot;
}

export async function resolveConflict(options: ResolveConflictOptions): Promise<void> {
  const runId = createRunId();
  const logPrefix = `[LLM Wiki Sync][Resolve][${runId}]`;
  console.debug(`${logPrefix} strategy:`, options.strategy);

  const preflight = await getResolvePreflight(options, runId);
  if (!preflight) return;

  const recheck = await recheckConflict(options.app, preflight, runId);
  if (!recheck) return;

  if (options.strategy === "KEEP_OBSIDIAN") {
    await resolveKeepObsidian(options, recheck, runId);
  } else {
    await resolveKeepNotion(options, recheck, runId);
  }
}

async function getResolvePreflight(options: ResolveConflictOptions, runId: string): Promise<ResolvePreflight | null> {
  const file = options.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file to resolve");
    return null;
  }

  const mapping = await getNotionPageMapping(options.app, file);
  if (!mapping.hasMapping || !mapping.pageId) {
    new Notice("LLM Wiki Sync: Active file has no notion_page_id mapping.");
    return null;
  }

  const mappedFiles = await findFilesMappedToPage(options.app, mapping.pageId);
  console.debug(`[LLM Wiki Sync][Resolve][${runId}] local mapping count:`, mappedFiles.length);
  if (mappedFiles.length !== 1 || mappedFiles[0] !== file) {
    console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, mapping.pageId);
    new Notice("LLM Wiki Sync: Duplicate local mapping conflict.");
    return null;
  }

  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return null;
  }

  let baseline;
  try {
    baseline = options.baselineStore.getSyncBaseline(mapping.pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
    new Notice("LLM Wiki Sync: Baseline error. Operation aborted.");
    return null;
  }
  console.debug(`[LLM Wiki Sync][Baseline][${runId}] loaded`, Boolean(baseline));
  if (!baseline) {
    new Notice("LLM Wiki Sync: No sync baseline exists for this note. Initialize the baseline first.");
    return null;
  }

  try {
    const client = new NotionClient({ token });
    const localSnapshot = await getLocalSyncSnapshot(options.app, file);
    const remoteSnapshot = await getRemoteSyncSnapshot(client, mapping.pageId);
    const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
    console.debug(`[LLM Wiki Sync][Resolve][${runId}] preflight state:`, change.state);
    logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
    if (change.state !== "CONFLICT") {
      new Notice("LLM Wiki Sync: No active conflict to resolve.");
      return null;
    }

    return { file, pageId: mapping.pageId, client, baseline, localSnapshot, remoteSnapshot };
  } catch (error) {
    console.error(`[LLM Wiki Sync][Resolve][${runId}] preflight failed`, getErrorMessage(error));
    new Notice("LLM Wiki Sync: Conflict resolution aborted - could not verify sync state.");
    return null;
  }
}

async function recheckConflict(app: App, preflight: ResolvePreflight, runId: string): Promise<ResolvePreflight | null> {
  try {
    const localSnapshot = await getLocalSyncSnapshot(app, preflight.file);
    const remoteSnapshot = await getRemoteSyncSnapshot(preflight.client, preflight.pageId);
    const change = compareSnapshotsToBaseline(preflight.baseline, localSnapshot, remoteSnapshot);
    console.debug(`[LLM Wiki Sync][Resolve][${runId}] recheck state:`, change.state);
    logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
    if (change.state !== "CONFLICT") {
      new Notice("LLM Wiki Sync: No active conflict to resolve.");
      return null;
    }

    return { ...preflight, localSnapshot, remoteSnapshot };
  } catch (error) {
    console.error(`[LLM Wiki Sync][Resolve][${runId}] recheck failed`, getErrorMessage(error));
    new Notice("LLM Wiki Sync: Conflict resolution aborted - could not recheck sync state.");
    return null;
  }
}

async function resolveKeepObsidian(options: ResolveConflictOptions, preflight: ResolvePreflight, runId: string): Promise<void> {
  const logPrefix = `[LLM Wiki Sync][Resolve][${runId}]`;
  try {
    const pageDetails = await preflight.client.getPageDetails(preflight.pageId);
    if (pageDetails.parentType === "data_source_id") {
      new Notice("LLM Wiki Sync: Conflict resolution failed - title sync is unavailable for this Notion parent.");
      return;
    }

    console.debug(`${logPrefix} write start`);
    await preflight.client.updatePageMarkdown(preflight.pageId, preflight.localSnapshot.body);
    await preflight.client.updatePageTitle(preflight.pageId, preflight.localSnapshot.title);
    console.debug(`${logPrefix} write success`);

    await advanceBaselineAndVerifyClean(options, preflight.file, preflight.pageId, preflight.client, runId);
    new Notice("LLM Wiki Sync: Conflict resolved using Obsidian.");
  } catch (error) {
    console.error(`${logPrefix} partial failure`, getErrorMessage(error));
    logBaselineNotAdvanced(runId, "Keep Obsidian did not complete");
    new Notice("LLM Wiki Sync: Conflict resolution partially failed. Baseline was not updated.");
  }
}

async function resolveKeepNotion(options: ResolveConflictOptions, preflight: ResolvePreflight, runId: string): Promise<void> {
  const logPrefix = `[LLM Wiki Sync][Resolve][${runId}]`;
  try {
    const pageDetails = await preflight.client.getPageDetails(preflight.pageId);
    const pageMarkdown = await preflight.client.retrievePageMarkdown(preflight.pageId);
    const nextBody = normalizePulledMarkdown(pageMarkdown.markdown);

    console.debug(`${logPrefix} write start`);
    const existingMarkdown = await options.app.vault.read(preflight.file);
    await options.app.vault.modify(preflight.file, replaceMarkdownBodyPreservingFrontmatter(existingMarkdown, nextBody, preflight.pageId));
    const renameResult = await renameMappedFileAfterPull(options.app, preflight.file, preflight.pageId, pageDetails.title, runId);
    if (renameResult !== "renamed" && renameResult !== "noop") {
      throw new Error(`rename result: ${renameResult}`);
    }
    console.debug(`${logPrefix} write success`);

    const mappedFiles = await findFilesMappedToPage(options.app, preflight.pageId);
    if (mappedFiles.length !== 1) throw new Error(`expected one mapped file after rename, found ${mappedFiles.length}`);
    await advanceBaselineAndVerifyClean(options, mappedFiles[0], preflight.pageId, preflight.client, runId);
    new Notice("LLM Wiki Sync: Conflict resolved using Notion.");
  } catch (error) {
    console.error(`${logPrefix} partial failure`, getErrorMessage(error));
    logBaselineNotAdvanced(runId, "Keep Notion did not complete");
    new Notice("LLM Wiki Sync: Conflict resolution partially failed. Baseline was not updated.");
  }
}

async function advanceBaselineAndVerifyClean(
  options: ResolveConflictOptions,
  file: TFile,
  pageId: string,
  client: NotionClient,
  runId: string
): Promise<void> {
  const localSnapshot = await getLocalSyncSnapshot(options.app, file);
  const remoteSnapshot = await getRemoteSyncSnapshot(client, pageId);
  const baseline = createSyncBaseline(pageId, localSnapshot, remoteSnapshot);
  await options.baselineStore.saveSyncBaseline(pageId, baseline);
  console.debug(`[LLM Wiki Sync][Baseline][${runId}] advanced`, pageId);

  const finalChange = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
  console.debug(`[LLM Wiki Sync][Resolve][${runId}] final state:`, finalChange.state);
  if (finalChange.state !== "CLEAN") {
    throw new Error(`final state was not CLEAN: ${finalChange.state}`);
  }
}

function createRunId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof NotionApiError) return `${error.status} - ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
