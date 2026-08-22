import { Modal, Notice, Setting, type App, type TFile } from "obsidian";
import { NotionApiError, NotionClient } from "../notionClient";
import {
  compareSnapshotsToBaseline,
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshot,
  logConflictState,
  type SyncBaselineStore
} from "./baseline";
import { findFilesMappedToPage, getNotionPageMapping, normalizePulledMarkdown, replaceMarkdownBodyPreservingFrontmatter } from "./mapping";
import { pushCurrentNoteToNotion } from "./push";
import { renameMappedFileAfterPull } from "./pull";
import { resolveConflict } from "./resolveConflict";

export interface SyncCurrentNoteOptions {
  app: App;
  token: string;
  rootPageUrl: string;
  baselineStore: SyncBaselineStore;
}

export async function syncCurrentNote(options: SyncCurrentNoteOptions): Promise<void> {
  const runId = createRunId();
  const logPrefix = `[LLM Wiki Sync][Sync][${runId}]`;
  console.debug(`${logPrefix} start`);

  const file = options.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    new Notice("LLM Wiki Sync: No active Markdown file to sync");
    return;
  }

  const mapping = await getNotionPageMapping(options.app, file);
  if (!mapping.hasMapping) {
    console.debug(`${logPrefix} state: UNLINKED`);
    console.debug(`${logPrefix} action: CREATE_REMOTE`);
    try {
      await pushCurrentNoteToNotion(options);
      const nextMapping = await getNotionPageMapping(options.app, file);
      if (!nextMapping.pageId || !options.baselineStore.getSyncBaseline(nextMapping.pageId)) {
        throw new Error("created page mapping or baseline was not confirmed");
      }
      new Notice("LLM Wiki Sync: Created and linked Notion page.");
    } catch (error) {
      console.error(`${logPrefix} create failed`, getErrorMessage(error));
      new Notice("LLM Wiki Sync: Sync failed. Check the connection and try again.");
    }
    return;
  }
  if (!mapping.pageId) {
    new Notice("LLM Wiki Sync: Push failed - notion_page_id is empty");
    return;
  }
  console.debug(`${logPrefix} notion_page_id:`, mapping.pageId);

  const mappedFiles = await findFilesMappedToPage(options.app, mapping.pageId);
  if (mappedFiles.length !== 1 || mappedFiles[0] !== file) {
    console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, mapping.pageId);
    new Notice("LLM Wiki Sync: Duplicate local mapping detected.");
    return;
  }

  let baseline;
  try {
    baseline = options.baselineStore.getSyncBaseline(mapping.pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
    new Notice("LLM Wiki Sync: Baseline error. Operation aborted.");
    return;
  }
  if (!baseline) {
    new Notice("LLM Wiki Sync: Initialize the sync baseline first.");
    return;
  }

  const token = options.token.trim();
  if (!token) {
    new Notice("LLM Wiki Sync: Notion API token is missing");
    return;
  }

  try {
    const client = new NotionClient({ token });
    const localSnapshot = await getLocalSyncSnapshot(options.app, file);
    const remoteSnapshot = await getRemoteSyncSnapshot(client, mapping.pageId);
    const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
    console.debug(`${logPrefix} state:`, change.state);
    logConflictState(runId, change.localChanged, change.remoteChanged, change.state);

    if (change.state === "CLEAN") {
      console.debug(`${logPrefix} action: NONE`);
      new Notice("LLM Wiki Sync: Already in sync.");
      return;
    }
    if (change.state === "CONFLICT") {
      console.debug(`${logPrefix} action: BLOCKED`);
      new Notice("LLM Wiki Sync: Conflict detected. Choose which version to keep.");
      new SyncConflictModal(options).open();
      return;
    }
    if (change.state === "LOCAL_ONLY_CHANGED") {
      console.debug(`${logPrefix} action: PUSH`);
      await pushCurrentNoteToNotion(options);
      await assertFinalClean(options.app, options.baselineStore, client, file, mapping.pageId, runId);
      new Notice("LLM Wiki Sync: Synced Obsidian → Notion.");
      return;
    }

    console.debug(`${logPrefix} action: PULL`);
    await pullActiveMappedNote(options.app, options.baselineStore, client, file, mapping.pageId, runId);
    const nextFile = await getOnlyMappedFile(options.app, mapping.pageId);
    await assertFinalClean(options.app, options.baselineStore, client, nextFile, mapping.pageId, runId);
    new Notice("LLM Wiki Sync: Synced Notion → Obsidian.");
  } catch (error) {
    console.error(`${logPrefix} failed`, getErrorMessage(error));
    new Notice("LLM Wiki Sync: Sync failed. Check the connection and try again.");
  }
}

async function pullActiveMappedNote(
  app: App,
  baselineStore: SyncBaselineStore,
  client: NotionClient,
  file: TFile,
  pageId: string,
  runId: string
): Promise<void> {
  const pageDetails = await client.getPageDetails(pageId);
  const pageMarkdown = await client.retrievePageMarkdown(pageId);
  const nextBody = normalizePulledMarkdown(pageMarkdown.markdown);
  await app.vault.process(file, (existingMarkdown) =>
    replaceMarkdownBodyPreservingFrontmatter(existingMarkdown, nextBody, pageId)
  );
  const renameResult = await renameMappedFileAfterPull(app, file, pageId, pageDetails.title, runId);
  if (renameResult !== "renamed" && renameResult !== "noop") {
    throw new Error(`Pull partial failure: rename result ${renameResult}`);
  }

  const nextFile = await getOnlyMappedFile(app, pageId);
  const localSnapshot = await getLocalSyncSnapshot(app, nextFile);
  const remoteSnapshot = await getRemoteSyncSnapshot(client, pageId);
  await baselineStore.saveSyncBaseline(pageId, createSyncBaseline(pageId, localSnapshot, remoteSnapshot));
  console.debug(`[LLM Wiki Sync][Baseline][${runId}] advanced`, pageId);
}

async function assertFinalClean(app: App, baselineStore: SyncBaselineStore, client: NotionClient, file: TFile, pageId: string, runId: string): Promise<void> {
  const baseline = baselineStore.getSyncBaseline(pageId);
  if (!baseline) throw new Error("final baseline missing");
  const localSnapshot = await getLocalSyncSnapshot(app, file);
  const remoteSnapshot = await getRemoteSyncSnapshot(client, pageId);
  const finalChange = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
  console.debug(`[LLM Wiki Sync][Sync][${runId}] final state:`, finalChange.state);
  if (finalChange.state !== "CLEAN") throw new Error(`final state was not CLEAN: ${finalChange.state}`);
}

async function getOnlyMappedFile(app: App, pageId: string): Promise<TFile> {
  const mappedFiles = await findFilesMappedToPage(app, pageId);
  if (mappedFiles.length !== 1) throw new Error(`Expected one mapped file, found ${mappedFiles.length}`);
  return mappedFiles[0];
}

function createRunId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof NotionApiError) return `${error.status} - ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

class SyncConflictModal extends Modal {
  private options: SyncCurrentNoteOptions;

  constructor(options: SyncCurrentNoteOptions) {
    super(options.app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "LLM Wiki Sync conflict" });
    contentEl.createEl("p", { text: "This note was changed in both Obsidian and Notion." });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Keep Obsidian")
          .setCta()
          .onClick(() => {
            this.close();
            void resolveConflict({ ...this.options, strategy: "KEEP_OBSIDIAN" });
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Keep Notion")
          .onClick(() => {
            this.close();
            void resolveConflict({ ...this.options, strategy: "KEEP_NOTION" });
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => {
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
