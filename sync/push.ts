import { Notice, type App, type TFile } from "obsidian";
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
import { findFilesMappedToPage, getNotionPageMapping, isContainerIndexFile, removeNotionPageMappingFromMarkdown, setNotionPageMapping } from "./mapping";

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

export interface PushFileToNotionOptions {
  app: App;
  file: TFile;
  client: NotionClient;
  parentPageId: string | null;
  expectedParentPageId?: string | null;
  repairMisplacedParent?: boolean;
  baselineStore: SyncBaselineStore;
  runId?: string;
}

export async function pushCurrentNoteToNotion(options: PushCurrentNoteOptions): Promise<void> {
  const runId = createRunId();
  const activeFile = options.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file to push");
    return;
  }

  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return;
  }
  if (await isContainerIndexFile(options.app, activeFile)) {
    new Notice("LLM Wiki Sync: Container index files are excluded from normal Push.");
    return;
  }

  const client = new NotionClient({ token });
  let parentPageId = extractNotionPageId(options.rootPageUrl);
  if (options.resolveParentPageId) {
    parentPageId = await options.resolveParentPageId(activeFile);
  }
  console.debug("[LLM Wiki Sync][Root check] extracted parent page id", parentPageId || "<invalid>");

  const result = await pushFileToNotion({
    app: options.app,
    file: activeFile,
    client,
    parentPageId,
    expectedParentPageId: parentPageId,
    baselineStore: options.baselineStore,
    runId
  });

  showSinglePushNotice(result);
}

export async function pushFileToNotion(options: PushFileToNotionOptions): Promise<PushFileResult> {
  const runId = options.runId ?? createRunId();
  const noteTitle = options.file.basename;
  const logPrefix = `[LLM Wiki Sync][Push][${runId}]`;
  console.debug(`${logPrefix} local current path:`, options.file.path);
  console.debug(`${logPrefix} derived Notion title:`, noteTitle);

  if (options.file.extension !== "md") {
    return fail(options.file, "Only Markdown files can be pushed");
  }
  if (!noteTitle.trim()) {
    return fail(options.file, "Push failed - local filename is empty");
  }

  const existingMapping = await getNotionPageMapping(options.app, options.file);
  if (existingMapping.hasMapping && await isContainerIndexFile(options.app, options.file)) {
    return fail(options.file, "Container index files are excluded from normal Push and Folder Sync.", existingMapping.pageId ?? undefined);
  }
  const markdown = await options.app.vault.read(options.file);
  const markdownBody = removeNotionPageMappingFromMarkdown(markdown);

  if (existingMapping.hasMapping) {
    return pushLinkedFileToNotion({
      ...options,
      runId,
      logPrefix,
      pageId: existingMapping.pageId,
      noteTitle
    });
  }

  return createFileInNotion({
    ...options,
    runId,
    markdownBody,
    noteTitle
  });
}

async function pushLinkedFileToNotion(options: PushFileToNotionOptions & {
  runId: string;
  logPrefix: string;
  pageId: string | null;
  noteTitle: string;
}): Promise<PushFileResult> {
  if (!options.pageId) {
    return fail(options.file, "Push failed - notion_page_id is empty");
  }

  const mappedFiles = await findFilesMappedToPage(options.app, options.pageId);
  console.debug(`${options.logPrefix} local mapping count:`, mappedFiles.length);
  if (mappedFiles.length !== 1) {
    console.error(`[LLM Wiki Sync][Mapping][${options.runId}] DUPLICATE notion_page_id conflict`, options.pageId);
    return fail(options.file, "Duplicate local mapping conflict.", options.pageId);
  }

  console.debug(`${options.logPrefix} Mode: update`);
  console.debug(`${options.logPrefix} notion_page_id:`, options.pageId);

  let hierarchyMoved = false;
  if (options.expectedParentPageId) {
    try {
      const pageDetails = await options.client.getPageDetails(options.pageId);
      if (
        pageDetails.parentType !== "page_id" ||
        normalizePageId(pageDetails.parentPageId) !== normalizePageId(options.expectedParentPageId)
      ) {
        if (options.repairMisplacedParent) {
          await options.client.movePageToPage(options.pageId, options.expectedParentPageId);
          hierarchyMoved = true;
        } else {
          return {
            status: "misplaced",
            filePath: options.file.path,
            pageId: options.pageId,
            message: `Notion page is under ${pageDetails.parentPageId || pageDetails.parentType || "unknown parent"} instead of ${options.expectedParentPageId}.`
          };
        }
      }
    } catch (error) {
      console.error(`${options.logPrefix} hierarchy parent check failed`, getErrorMessage(error));
      return fail(options.file, "Push aborted - could not verify Notion page hierarchy.", options.pageId, error);
    }
  }

  let baseline;
  try {
    baseline = options.baselineStore.getSyncBaseline(options.pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${options.runId}] load failed`, getErrorMessage(error));
    return fail(options.file, "Baseline error. Operation aborted.", options.pageId, error);
  }
  console.debug(`[LLM Wiki Sync][Baseline][${options.runId}] loaded`, Boolean(baseline));
  if (!baseline) {
    return fail(options.file, "No sync baseline exists for this note. Initialize the baseline first.", options.pageId);
  }

  let localSnapshot;
  let remoteSnapshot;
  try {
    localSnapshot = await getLocalSyncSnapshot(options.app, options.file);
    remoteSnapshot = await getRemoteSyncSnapshot(options.client, options.pageId);
  } catch (error) {
    console.error(`${options.logPrefix} preflight snapshot failed`, getErrorMessage(error));
    return fail(options.file, "Push aborted - could not verify sync baseline.", options.pageId, error);
  }

  const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
  logConflictState(options.runId, change.localChanged, change.remoteChanged, change.state);
  if (change.state === "CLEAN") {
    return {
      status: "clean",
      filePath: options.file.path,
      pageId: options.pageId,
      message: hierarchyMoved ? "Moved to the expected Notion folder. Already in sync." : "Already in sync.",
      hierarchyMoved
    };
  }
  if (change.state === "REMOTE_ONLY_CHANGED") {
    console.warn(`${options.logPrefix} stale Push protection: Notion changed since baseline`);
    return {
      status: "remote_changed",
      filePath: options.file.path,
      pageId: options.pageId,
      message: "Notion changed since the last sync. Pull first."
    };
  }
  if (change.state === "CONFLICT") {
    return {
      status: "conflict",
      filePath: options.file.path,
      pageId: options.pageId,
      message: "Conflict detected. Both Obsidian and Notion changed."
    };
  }

  try {
    console.debug(`${options.logPrefix} body update start`);
    await options.client.updatePageMarkdown(options.pageId, localSnapshot.body);
    console.debug(`${options.logPrefix} body update result: success`);
  } catch (error) {
    console.error(`${options.logPrefix} body update failed`, getErrorMessage(error));
    return fail(options.file, getUpdateErrorMessage(error), options.pageId, error);
  }

  try {
    const pageDetails = await options.client.getPageDetails(options.pageId);
    if (pageDetails.parentType === "data_source_id") {
      console.warn(`${options.logPrefix} title update skipped: data-source parent is outside RC scope`);
      logBaselineNotAdvanced(options.runId, "title sync skipped for data-source parent");
      return fail(options.file, "Content updated; title sync skipped for data-source page.", options.pageId);
    }

    console.debug(`${options.logPrefix} title update start`);
    const updatedPage = await options.client.updatePageTitle(options.pageId, options.noteTitle);
    console.debug(`${options.logPrefix} title update HTTP status:`, updatedPage.response.status);
    if (normalizePageId(updatedPage.id) !== normalizePageId(options.pageId)) {
      throw new Error("Notion title update returned a different page ID");
    }

    console.debug(`${options.logPrefix} final result: success`);
    try {
      const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, options.file);
      const nextRemoteSnapshot = await getRemoteSyncSnapshot(options.client, options.pageId);
      await options.baselineStore.saveSyncBaseline(
        options.pageId,
        createSyncBaseline(options.pageId, nextLocalSnapshot, nextRemoteSnapshot)
      );
      console.debug(`[LLM Wiki Sync][Baseline][${options.runId}] advanced`, options.pageId);
    } catch (baselineError) {
      console.error(`[LLM Wiki Sync][Baseline][${options.runId}] advance failed`, getErrorMessage(baselineError));
      logBaselineNotAdvanced(options.runId, "baseline refresh failed after full Push");
      return fail(options.file, "Updated Notion content and title; baseline update failed. Check console.", options.pageId, baselineError);
    }

    return {
      status: "updated",
      filePath: options.file.path,
      pageId: options.pageId,
      message: hierarchyMoved ? "Moved to the expected Notion folder and updated Notion content and title." : "Updated Notion content and title.",
      hierarchyMoved
    };
  } catch (error) {
    console.error(`${options.logPrefix} title update failed after content update`, getErrorMessage(error));
    logBaselineNotAdvanced(options.runId, "title update failed after body update");
    return fail(options.file, getTitleUpdateErrorMessage(error), options.pageId, error);
  }
}

async function createFileInNotion(options: PushFileToNotionOptions & {
  runId: string;
  markdownBody: string;
  noteTitle: string;
}): Promise<PushFileResult> {
  console.debug("[LLM Wiki Sync][Push] Mode: create");
  if (!options.parentPageId) {
    return fail(options.file, "Notion Root Page URL is invalid");
  }

  try {
    const adoption = await tryAdoptExistingChildPage(options);
    if (adoption) {
      return adoption;
    }

    const pushedAt = new Date();
    await options.client.getPage(options.parentPageId);
    const createdPage = await options.client.createChildPage({
      parentPageId: options.parentPageId,
      title: options.noteTitle,
      markdown: options.markdownBody,
      pushedAt
    });

    console.debug("[LLM Wiki Sync][Create page] endpoint", NOTION_CREATE_PAGE_ENDPOINT);
    console.debug("[LLM Wiki Sync][Create page] parent page id", options.parentPageId);
    console.debug("[LLM Wiki Sync][Create page] note title", options.noteTitle);
    console.debug("[LLM Wiki Sync][Create page] created page id", createdPage.id);
    console.debug("[LLM Wiki Sync][Create page] created page url", createdPage.url);

    await setNotionPageMapping(options.app, options.file, createdPage.id);
    try {
      const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, options.file);
      const nextRemoteSnapshot = await getRemoteSyncSnapshot(options.client, createdPage.id);
      await options.baselineStore.saveSyncBaseline(
        createdPage.id,
        createSyncBaseline(createdPage.id, nextLocalSnapshot, nextRemoteSnapshot)
      );
      console.debug(`[LLM Wiki Sync][Baseline][${options.runId}] initialized`, createdPage.id);
    } catch (baselineError) {
      console.error(`[LLM Wiki Sync][Baseline][${options.runId}] initialization failed`, getErrorMessage(baselineError));
      logBaselineNotAdvanced(options.runId, "baseline initialization failed after Push create");
      return fail(options.file, "Pushed and linked to Notion; baseline initialization failed. Check console.", createdPage.id, baselineError);
    }

    return {
      status: "created",
      filePath: options.file.path,
      pageId: createdPage.id,
      message: "Pushed and linked to Notion."
    };
  } catch (error) {
    return fail(options.file, getCreateErrorMessage(error), undefined, error);
  }
}

async function tryAdoptExistingChildPage(options: PushFileToNotionOptions & {
  runId: string;
  noteTitle: string;
}): Promise<PushFileResult | null> {
  const candidates = (await options.client.listChildPages(options.parentPageId ?? "", "Hierarchy"))
    .filter((page) => page.title === options.noteTitle);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    return ambiguous(options.file, "AMBIGUOUS - multiple same-title Notion pages exist under the expected parent.");
  }

  const localSnapshot = await getLocalSyncSnapshot(options.app, options.file);
  const remoteSnapshot = await getRemoteSyncSnapshot(options.client, candidates[0].id);
  if (localSnapshot.fingerprint !== remoteSnapshot.fingerprint) {
    return ambiguous(options.file, "AMBIGUOUS - same-title Notion page content differs from the local note.", candidates[0].id);
  }

  await setNotionPageMapping(options.app, options.file, candidates[0].id);
  const nextLocalSnapshot = await getLocalSyncSnapshot(options.app, options.file);
  await options.baselineStore.saveSyncBaseline(
    candidates[0].id,
    createSyncBaseline(candidates[0].id, nextLocalSnapshot, remoteSnapshot)
  );
  console.debug(`[LLM Wiki Sync][Baseline][${options.runId}] initialized from existing Notion page`, candidates[0].id);
  return {
    status: "clean",
    filePath: options.file.path,
    pageId: candidates[0].id,
    message: "Linked existing same-title Notion page with matching content."
  };
}

function showSinglePushNotice(result: PushFileResult): void {
  if (result.status === "clean") {
    new Notice("LLM Wiki Sync: Already in sync.");
    return;
  }
  if (result.status === "remote_changed") {
    new Notice("LLM Wiki Sync: Notion changed since the last sync. Pull first.");
    return;
  }
  if (result.status === "conflict") {
    new Notice("LLM Wiki Sync: Conflict detected. Both Obsidian and Notion changed.");
    return;
  }
  if (result.status === "created") {
    new Notice("LLM Wiki Sync: Pushed and linked to Notion.");
    return;
  }
  if (result.status === "updated") {
    new Notice("LLM Wiki Sync: Updated Notion content and title.");
    return;
  }

  new Notice(`LLM Wiki Sync: ${result.message}`);
}

function fail(file: TFile, message: string, pageId?: string, error?: unknown): PushFileResult {
  return {
    status: "failed",
    filePath: file.path,
    pageId,
    message,
    error
  };
}

function ambiguous(file: TFile, message: string, pageId?: string): PushFileResult {
  return {
    status: "ambiguous",
    filePath: file.path,
    pageId,
    message
  };
}

function getUpdateErrorMessage(error: unknown): string {
  if (error instanceof NotionApiError) {
    return `Update failed (${error.status}) - ${error.message}`;
  }

  return `Update failed - ${getErrorMessage(error)}`;
}

function getTitleUpdateErrorMessage(error: unknown): string {
  if (error instanceof NotionApiError) {
    return `Content updated; title update failed (${error.status}). Check console.`;
  }

  return "Content updated; title update failed. Check console.";
}

function getCreateErrorMessage(error: unknown): string {
  if (error instanceof NotionApiError) {
    return `Push failed (${error.status}) - ${error.message}`;
  }

  return `Push failed - ${getErrorMessage(error)}`;
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
