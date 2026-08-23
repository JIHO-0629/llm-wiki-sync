import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type TFile
} from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "./notionClient";
import { pushCurrentFolderToNotion, pushEntireVaultToNotion, type FolderMapping } from "./sync/bulkPush";
import { pullPagesFromNotion } from "./sync/pull";
import { pushCurrentNoteToNotion } from "./sync/push";
import { debugActiveMapping } from "./sync/debug";
import { initializeSyncBaseline } from "./sync/initializeBaseline";
import { resolveConflict } from "./sync/resolveConflict";
import { syncCurrentNote } from "./sync/syncCurrentNote";
import {
  HierarchyAuditModal,
  auditWorkspaceHierarchy,
  initializeWorkspaceMappings,
  repairWorkspaceHierarchy,
  resolveNotionParentForFile,
  type HierarchyScope
} from "./sync/hierarchy";
import {
  getSelectableFolderPaths,
  syncFolderWithNotion,
  type FolderSyncStore,
  type ManagedPageRecord,
  type QuarantineRecord,
  type SyncCancelToken,
  type SyncProgress
} from "./sync/folderSync";
import {
  SYNC_STATE_VERSION,
  validateSyncBaseline,
  type SyncBaseline,
  type SyncBaselineStore
} from "./sync/baseline";
import { normalizeNotionPageId } from "./sync/mapping";
import { SyncExecutionLock } from "./sync/runLock";

interface LlmWikiSyncSettings {
  notionRootPageUrl: string;
  connectionStatus: "not-tested" | "connected" | "failed" | "missing";
  verboseDebugLogging: boolean;
  syncStateVersion: 1;
  syncStates: Record<string, SyncBaseline>;
  folderMappings: Record<string, FolderMapping>;
  managedPageRecords: Record<string, ManagedPageRecord>;
  quarantineRecords: Record<string, QuarantineRecord>;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: LlmWikiSyncSettings = {
  notionRootPageUrl: "",
  connectionStatus: "not-tested",
  verboseDebugLogging: false,
  syncStateVersion: SYNC_STATE_VERSION,
  syncStates: {},
  folderMappings: {},
  managedPageRecords: {},
  quarantineRecords: {}
};

const NOTION_TOKEN_SECRET_ID = "llm-wiki-sync-notion-api-token";
const VERSION_LABEL = "v0.8.4";

interface SyncRunState {
  type: string | null;
  scope: string | null;
  progressModal: SyncProgressModal | null;
  cancelToken: SyncCancelToken | null;
}

export default class LlmWikiSyncPlugin extends Plugin implements SyncBaselineStore, FolderSyncStore {
  settings: LlmWikiSyncSettings = DEFAULT_SETTINGS;
  private originalConsoleDebug: typeof console.debug | null = null;
  private syncExecutionLock = new SyncExecutionLock();
  private syncRunState: SyncRunState = {
    type: null,
    scope: null,
    progressModal: null,
    cancelToken: null
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.configureDebugLogging();
    console.debug("[LLM Wiki Sync] v0.8.4 loaded");

    this.addSettingTab(new LlmWikiSyncSettingTab(this.app, this));

    this.addCommand({
      id: "test-notion-connection",
      name: "Test Notion connection",
      callback: () => {
        void this.testNotionConnection();
      }
    });

    this.addCommand({
      id: "push-current-note-to-notion",
      name: "Push to Notion",
      callback: () => {
        void this.runExclusiveSync("push-current-note", "Current note", () => this.pushCurrentNoteToNotion());
      }
    });

    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      callback: () => {
        void this.syncCurrentNote();
      }
    });

    this.addCommand({
      id: "push-current-folder-to-notion",
      name: "LLM Wiki Sync: Push current folder to Notion",
      callback: () => {
        void this.runExclusiveSync("push-current-folder", "Current folder", () => this.pushCurrentFolderToNotion());
      }
    });

    this.addCommand({
      id: "push-entire-vault-to-notion",
      name: "LLM Wiki Sync: Push entire vault to Notion",
      callback: () => {
        this.confirmPushEntireVaultToNotion();
      }
    });

    this.addCommand({
      id: "sync-folder-with-notion",
      name: "LLM Wiki Sync: Sync folder with Notion",
      callback: () => {
        this.openFolderSyncPicker();
      }
    });

    this.addCommand({
      id: "sync-entire-vault-with-notion",
      name: "LLM Wiki Sync: Sync entire vault with Notion",
      callback: () => {
        void this.syncFolderWithNotion("");
      }
    });

    this.addCommand({
      id: "audit-current-folder-hierarchy",
      name: "LLM Wiki Sync: Audit current folder hierarchy",
      callback: () => {
        void this.runExclusiveSync("audit-current-folder", "Current folder", () => this.auditWorkspaceHierarchy("current-folder"));
      }
    });

    this.addCommand({
      id: "audit-entire-vault-hierarchy",
      name: "LLM Wiki Sync: Audit entire vault hierarchy",
      callback: () => {
        void this.runExclusiveSync("audit-entire-vault", "Vault root", () => this.auditWorkspaceHierarchy("entire-vault"));
      }
    });

    this.addCommand({
      id: "initialize-current-folder-mappings",
      name: "LLM Wiki Sync: Initialize current folder mappings",
      callback: () => {
        void this.runExclusiveSync("initialize-current-folder", "Current folder", () => this.initializeWorkspaceMappings("current-folder"));
      }
    });

    this.addCommand({
      id: "initialize-entire-vault-mappings",
      name: "LLM Wiki Sync: Initialize entire vault mappings",
      callback: () => {
        void this.runExclusiveSync("initialize-entire-vault", "Vault root", () => this.initializeWorkspaceMappings("entire-vault"));
      }
    });

    this.addCommand({
      id: "pull-pages-from-notion",
      name: "Pull from Notion",
      callback: () => {
        void this.runExclusiveSync("pull-pages-from-notion", "Notion Pull", () => this.pullPagesFromNotion());
      }
    });

    this.addCommand({
      id: "debug-active-mapping",
      name: "Debug active mapping",
      callback: () => { void debugActiveMapping(this.app, this.getNotionToken(), this); }
    });

    this.addCommand({
      id: "debug-sync-state",
      name: "Debug sync state",
      callback: () => { void debugActiveMapping(this.app, this.getNotionToken(), this); }
    });

    this.addCommand({
      id: "initialize-sync-baseline",
      name: "Initialize sync baseline",
      callback: () => { void initializeSyncBaseline(this.app, this.getNotionToken(), this); }
    });

    this.addCommand({
      id: "resolve-conflict-keep-obsidian",
      name: "Resolve conflict — Keep Obsidian",
      callback: () => {
        void resolveConflict({ app: this.app, token: this.getNotionToken(), baselineStore: this, strategy: "KEEP_OBSIDIAN" });
      }
    });

    this.addCommand({
      id: "resolve-conflict-keep-notion",
      name: "Resolve conflict — Keep Notion",
      callback: () => {
        void resolveConflict({ app: this.app, token: this.getNotionToken(), baselineStore: this, strategy: "KEEP_NOTION" });
      }
    });

    this.addRibbonIcon("refresh-cw", "LLM Wiki Sync: Sync current note", () => {
      void this.syncCurrentNote();
    });

    this.addRibbonIcon("arrow-up-circle", "LLM Wiki Sync: Keep Obsidian version", () => {
      void resolveConflict({ app: this.app, token: this.getNotionToken(), baselineStore: this, strategy: "KEEP_OBSIDIAN" });
    });

    this.addRibbonIcon("arrow-down-circle", "LLM Wiki Sync: Keep Notion version", () => {
      void resolveConflict({ app: this.app, token: this.getNotionToken(), baselineStore: this, strategy: "KEEP_NOTION" });
    });

    this.addPrimaryStatusBarActions();
  }

  onunload(): void {
    if (this.originalConsoleDebug) {
      console.debug = this.originalConsoleDebug;
      this.originalConsoleDebug = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.ensureSyncStateContainer();
  }

  async saveSettings(): Promise<void> {
    this.ensureSyncStateContainer();
    await this.saveData(this.settings);
  }

  getSyncBaseline(pageId: string): SyncBaseline | null {
    this.ensureSyncStateContainer();
    const key = normalizeNotionPageId(pageId);
    const rawBaseline = this.settings.syncStates[key];
    if (!rawBaseline) {
      return null;
    }

    const baseline = validateSyncBaseline(rawBaseline, pageId);
    if (!baseline) {
      console.error("[LLM Wiki Sync][Baseline] invalid baseline structure", pageId);
      throw new Error("Invalid sync baseline structure");
    }

    return baseline;
  }

  async saveSyncBaseline(pageId: string, baseline: SyncBaseline): Promise<void> {
    this.ensureSyncStateContainer();
    this.settings.syncStateVersion = SYNC_STATE_VERSION;
    this.settings.syncStates[normalizeNotionPageId(pageId)] = baseline;
    await this.saveSettings();
  }

  getFolderMapping(mappingKey: string): FolderMapping | null {
    this.ensureSyncStateContainer();
    const mapping = this.settings.folderMappings[mappingKey];
    if (!mapping || typeof mapping !== "object") {
      return null;
    }
    if (
      typeof mapping.notionPageId !== "string" ||
      typeof mapping.lastKnownPath !== "string" ||
      typeof mapping.rootPageId !== "string"
    ) {
      return null;
    }

    return mapping;
  }

  async saveFolderMapping(mappingKey: string, mapping: FolderMapping): Promise<void> {
    this.ensureSyncStateContainer();
    this.settings.folderMappings[mappingKey] = mapping;
    await this.saveSettings();
  }

  async removeFolderMapping(mappingKey: string): Promise<void> {
    this.ensureSyncStateContainer();
    delete this.settings.folderMappings[mappingKey];
    await this.saveSettings();
  }

  getAllSyncBaselinePageIds(): string[] {
    this.ensureSyncStateContainer();
    return Object.keys(this.settings.syncStates);
  }

  getAllFolderMappings(): FolderMapping[] {
    this.ensureSyncStateContainer();
    return Object.values(this.settings.folderMappings)
      .filter((mapping): mapping is FolderMapping => Boolean(
        mapping &&
        typeof mapping === "object" &&
        typeof mapping.notionPageId === "string" &&
        typeof mapping.lastKnownPath === "string" &&
        typeof mapping.rootPageId === "string"
      ));
  }

  getManagedPageRecord(pageId: string): ManagedPageRecord | null {
    this.ensureSyncStateContainer();
    const record = this.settings.managedPageRecords[normalizeNotionPageId(pageId)];
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.notionPageId !== "string" ||
      typeof record.rootPageId !== "string" ||
      typeof record.lastKnownObsidianPath !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      return null;
    }
    return record;
  }

  async saveManagedPageRecord(record: ManagedPageRecord): Promise<void> {
    this.ensureSyncStateContainer();
    this.settings.managedPageRecords[normalizeNotionPageId(record.notionPageId)] = record;
    await this.saveSettings();
  }

  async saveQuarantineRecord(record: QuarantineRecord): Promise<void> {
    this.ensureSyncStateContainer();
    this.settings.quarantineRecords[normalizeNotionPageId(record.notionPageId)] = record;
    await this.saveSettings();
  }

  private ensureSyncStateContainer(): void {
    if (this.settings.syncStateVersion !== SYNC_STATE_VERSION) {
      this.settings.syncStateVersion = SYNC_STATE_VERSION;
    }
    if (!this.settings.syncStates || typeof this.settings.syncStates !== "object") {
      this.settings.syncStates = {};
    }
    if (!this.settings.folderMappings || typeof this.settings.folderMappings !== "object") {
      this.settings.folderMappings = {};
    }
    if (!this.settings.managedPageRecords || typeof this.settings.managedPageRecords !== "object") {
      this.settings.managedPageRecords = {};
    }
    if (!this.settings.quarantineRecords || typeof this.settings.quarantineRecords !== "object") {
      this.settings.quarantineRecords = {};
    }
  }

  private addPrimaryStatusBarActions(): void {
    const item = this.addStatusBarItem();
    item.setText("LLM Wiki Sync: ");
    this.addStatusBarAction(item, "Sync", () => {
      void syncCurrentNote({
        app: this.app,
        token: this.getNotionToken(),
        rootPageUrl: this.settings.notionRootPageUrl,
        baselineStore: this,
        resolveParentPageId: this.resolveParentPageIdForFile
      });
    });
    item.appendText(" · ");
    this.addStatusBarAction(item, "Keep Obsidian", () => {
      void resolveConflict({ app: this.app, token: this.getNotionToken(), baselineStore: this, strategy: "KEEP_OBSIDIAN" });
    });
    item.appendText(" · ");
    this.addStatusBarAction(item, "Keep Notion", () => {
      void resolveConflict({ app: this.app, token: this.getNotionToken(), baselineStore: this, strategy: "KEEP_NOTION" });
    });
  }

  private addStatusBarAction(parent: HTMLElement, label: string, callback: () => void): void {
    const action = parent.createSpan({ text: label });
    action.addClass("llm-wiki-sync-status-action");
    action.addEventListener("click", callback);
  }

  configureDebugLogging(): void {
    if (!this.originalConsoleDebug) {
      this.originalConsoleDebug = console.debug.bind(console);
    }
    const originalDebug = this.originalConsoleDebug;
    console.debug = (...args: unknown[]) => {
      if (this.settings.verboseDebugLogging) {
        originalDebug(...args);
        return;
      }

      const first = args[0];
      if (typeof first === "string" && first.startsWith("[LLM Wiki Sync]")) {
        return;
      }
      originalDebug(...args);
    };
  }

  getNotionToken(): string {
    return this.app.secretStorage?.getSecret(NOTION_TOKEN_SECRET_ID) ?? "";
  }

  setNotionToken(token: string): void {
    if (!this.app.secretStorage) {
      new Notice("LLM Wiki Sync: Obsidian SecretStorage is not available in this Obsidian version");
      return;
    }

    this.app.secretStorage.setSecret(NOTION_TOKEN_SECRET_ID, token);
    this.settings.connectionStatus = "not-tested";
    void this.saveSettings();
  }

  async testNotionConnection(): Promise<void> {
    const token = this.getNotionToken().trim();
    const pageUrl = this.settings.notionRootPageUrl.trim();

    if (!token) {
      this.settings.connectionStatus = "missing";
      await this.saveSettings();
      new Notice("LLM Wiki Sync: Missing Notion configuration.");
      return;
    }

    const pageId = extractNotionPageId(pageUrl);
    if (!pageId) {
      this.settings.connectionStatus = "missing";
      await this.saveSettings();
      new Notice("LLM Wiki Sync: Missing Notion configuration.");
      return;
    }

    try {
      const client = new NotionClient({ token });
      await client.getPage(pageId);
      this.settings.connectionStatus = "connected";
      await this.saveSettings();
      new Notice("LLM Wiki Sync: Notion connection successful");
    } catch (error) {
      this.settings.connectionStatus = "failed";
      await this.saveSettings();
      if (error instanceof NotionApiError) {
        console.error("LLM Wiki Sync: Notion connection failed", error.status, error.message);
        new Notice("LLM Wiki Sync: Notion connection failed.");
        return;
      }

      console.error("LLM Wiki Sync: Notion connection failed", getErrorMessage(error));
      new Notice("LLM Wiki Sync: Notion connection failed.");
    }
  }

  async pushCurrentNoteToNotion(): Promise<void> {
    await pushCurrentNoteToNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      baselineStore: this,
      resolveParentPageId: this.resolveParentPageIdForFile
    });
  }

  resolveParentPageIdForFile = async (file: TFile): Promise<string | null> => {
    const parent = await resolveNotionParentForFile({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this,
      file
    });
    return parent?.parentPageId ?? null;
  };

  async syncCurrentNote(): Promise<void> {
    await this.runExclusiveSync("sync-current-note", "Current note", () => syncCurrentNote({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      baselineStore: this,
      resolveParentPageId: this.resolveParentPageIdForFile
    }));
  }

  async pullPagesFromNotion(): Promise<void> {
    await pullPagesFromNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      baselineStore: this,
      store: this
    });
  }

  async pushCurrentFolderToNotion(): Promise<void> {
    await pushCurrentFolderToNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this
    });
  }

  confirmPushEntireVaultToNotion(): void {
    if (this.isSyncRunning()) {
      new Notice("LLM Wiki Sync: A sync is already running.");
      this.syncRunState.progressModal?.open();
      return;
    }
    new PushEntireVaultModal(this).open();
  }

  async pushEntireVaultToNotion(): Promise<void> {
    await pushEntireVaultToNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this
    });
  }

  openFolderSyncPicker(): void {
    new FolderSyncPickerModal(this).open();
  }

  async syncFolderWithNotion(folderPath: string): Promise<void> {
    await this.runExclusiveSync(folderPath ? "sync-folder" : "sync-entire-vault", folderPath || "Vault root", async () => {
      const cancelToken: SyncCancelToken = { cancelRequested: false };
      this.syncRunState.cancelToken = cancelToken;
      const progressModal = new SyncProgressModal(this.app, folderPath || "Vault root", cancelToken);
      this.syncRunState.progressModal = progressModal;
      progressModal.open();
      await syncFolderWithNotion({
        app: this.app,
        token: this.getNotionToken(),
        rootPageUrl: this.settings.notionRootPageUrl,
        store: this,
        folderPath,
        cancelToken,
        showResultModal: false,
        verboseDebugLogging: this.settings.verboseDebugLogging,
        onProgress: (progress) => progressModal.update(progress)
      });
    });
  }

  async auditWorkspaceHierarchy(scope: HierarchyScope): Promise<void> {
    const result = await auditWorkspaceHierarchy({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this,
      scope
    });
    if (!result) {
      return;
    }
    new HierarchyAuditModal(this.app, result, () => {
      new RepairHierarchyModal(this, scope).open();
    }).open();
  }

  async repairWorkspaceHierarchy(scope: HierarchyScope): Promise<void> {
    const summary = await repairWorkspaceHierarchy({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this,
      scope
    });
    if (!summary) {
      return;
    }
    new Notice(`LLM Wiki Sync: Repair complete - folders created ${summary.foldersCreated}, folder mappings repaired ${summary.folderMappingsRepaired}, pages moved ${summary.pagesMoved}, already correct ${summary.alreadyCorrect}, failed ${summary.failed}, skipped ${summary.skipped}.`);
  }

  async initializeWorkspaceMappings(scope: HierarchyScope): Promise<void> {
    const summary = await initializeWorkspaceMappings({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this,
      scope
    });
    if (!summary) {
      return;
    }
    new Notice(`LLM Wiki Sync: Mapping initialization complete - baselines initialized ${summary.baselinesInitialized}, already initialized ${summary.alreadyInitialized}, uninitialized divergence ${summary.uninitializedDivergence}, unmapped ${summary.unmapped}, ambiguous ${summary.ambiguous}, failed ${summary.failed}.`);
  }

  isSyncRunning(): boolean {
    return this.syncExecutionLock.snapshot.running;
  }

  async runExclusivePublic(type: string, scope: string, run: () => Promise<void>): Promise<void> {
    await this.runExclusiveSync(type, scope, run);
  }

  private async runExclusiveSync(type: string, scope: string, run: () => Promise<void>): Promise<void> {
    const result = await this.syncExecutionLock.run(type, scope, async () => {
      this.syncRunState.type = type;
      this.syncRunState.scope = scope;
      try {
        await run();
      } finally {
        this.syncRunState.type = null;
        this.syncRunState.scope = null;
        this.syncRunState.cancelToken = null;
      }
    });
    if (!result.started) {
      new Notice("LLM Wiki Sync: A sync is already running.");
      this.syncRunState.progressModal?.open();
    }
  }
}

class SyncProgressModal extends Modal {
  private readonly scopeLabel: string;
  private readonly cancelToken: SyncCancelToken;
  private latestProgress: SyncProgress | null = null;
  private timerId: number | null = null;

  constructor(app: App, scopeLabel: string, cancelToken: SyncCancelToken) {
    super(app);
    this.scopeLabel = scopeLabel;
    this.cancelToken = cancelToken;
  }

  onOpen(): void {
    this.render();
    if (this.timerId === null) {
      this.timerId = window.setInterval(() => this.render(), 1000);
    }
  }

  onClose(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.contentEl.empty();
  }

  update(progress: SyncProgress): void {
    this.latestProgress = progress;
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    if (!contentEl) {
      return;
    }
    const progress = this.latestProgress;
    const summary = progress?.summary;
    const complete = progress?.phase === "complete" || progress?.phase === "cancelled";
    contentEl.empty();

    new Setting(contentEl)
      .setName(complete ? "Folder sync complete" : "LLM Wiki Sync")
      .setHeading();
    contentEl.createEl("p", { text: `${complete ? "Synced" : "Syncing"} ${this.scopeLabel}` });
    contentEl.createEl("p", { text: getProgressPhaseLabel(progress) });

    if (progress?.total !== undefined && progress.total > 0) {
      contentEl.createEl("p", { text: `${progress.processed ?? 0} of ${progress.total} notes processed` });
      const bar = contentEl.createDiv({ cls: "llm-wiki-sync-progress-bar" });
      const fill = bar.createDiv({ cls: "llm-wiki-sync-progress-bar-fill" });
      fill.style.width = `${Math.min(100, Math.round(((progress.processed ?? 0) / progress.total) * 100))}%`;
    } else {
      contentEl.createEl("p", { text: "Preparing..." });
    }

    if (progress?.currentPath) {
      contentEl.createEl("p", { text: `Current: ${progress.currentPath}` });
    }

    contentEl.createEl("p", { text: formatProgressCounters(summary) });
    contentEl.createEl("p", { text: complete ? `Completed in ${formatDuration(progress?.elapsedMs ?? summary?.durationMs ?? 0)}` : `Elapsed ${formatClock(progress?.elapsedMs ?? 0)}` });
    if (!complete) {
      contentEl.createEl("p", { text: "Please keep Obsidian open." });
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText(complete ? "Close" : "Cancel")
          .onClick(() => {
            if (complete) {
              this.close();
              return;
            }
            this.cancelToken.cancelRequested = true;
            this.render();
          });
        if (!complete) {
          button.setWarning();
        }
      });
  }
}

function getProgressPhaseLabel(progress: SyncProgress | null): string {
  if (!progress) {
    return "Preparing sync";
  }
  const phase = `Phase ${progress.phaseIndex} of ${progress.phaseTotal}`;
  const message = progress.message || getPhaseName(progress.phase);
  return `${phase}: ${message}`;
}

function getPhaseName(phase: SyncProgress["phase"]): string {
  if (phase === "local_scan") return "Scanning Obsidian";
  if (phase === "remote_scan") return "Scanning Notion";
  if (phase === "hierarchy_repair") return "Repairing folder hierarchy";
  if (phase === "note_sync") return "Syncing notes";
  if (phase === "verification") return "Verifying Notion hierarchy";
  if (phase === "review_check") return "Checking Review candidates";
  if (phase === "cancelled") return "Sync cancelled";
  return "Sync complete";
}

function formatProgressCounters(summary?: Partial<import("./sync/folderSync").FolderSyncSummary>): string {
  if (!summary) {
    return "Created 0 · Updated 0 · Moved 0 · Conflicts 0 · Ambiguous 0 · Failed 0";
  }
  return [
    `Created ${summary.created ?? 0}`,
    `Updated ${summary.updated ?? 0}`,
    `Moved ${summary.moved ?? 0}`,
    `Folders ${summary.foldersCreated ?? 0}`,
    `Clean ${summary.alreadyInSync ?? 0}`,
    `Remote changed ${summary.remoteChanged ?? 0}`,
    `Conflicts ${summary.conflicts ?? 0}`,
    `Ambiguous ${summary.ambiguous ?? 0}`,
    `Failed ${summary.failed ?? 0}`
  ].join(" · ");
}

function formatClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

class PushEntireVaultModal extends Modal {
  private plugin: LlmWikiSyncPlugin;

  constructor(plugin: LlmWikiSyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("Push entire vault")
      .setHeading();
    new Setting(contentEl)
      .setName("Create or update Notion pages for all Markdown notes in this vault.")
      .setDesc("Existing conflict protection will still apply.");
    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => {
            this.close();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Push entire vault")
          .setCta()
          .onClick(() => {
            this.close();
            void this.plugin.runExclusivePublic("push-entire-vault", "Vault root", () => this.plugin.pushEntireVaultToNotion());
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class FolderSyncPickerModal extends FuzzySuggestModal<string> {
  private plugin: LlmWikiSyncPlugin;
  private folders: string[];

  constructor(plugin: LlmWikiSyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.folders = getSelectableFolderPaths(plugin.app);
    this.setPlaceholder("Choose a folder to sync with Notion");
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(folderPath: string): string {
    return folderPath || "Vault root";
  }

  onChooseItem(folderPath: string): void {
    void this.plugin.syncFolderWithNotion(folderPath);
  }
}

class RepairHierarchyModal extends Modal {
  private plugin: LlmWikiSyncPlugin;
  private hierarchyScope: HierarchyScope;

  constructor(plugin: LlmWikiSyncPlugin, scope: HierarchyScope) {
    super(plugin.app);
    this.plugin = plugin;
    this.hierarchyScope = scope;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("Repair hierarchy")
      .setHeading();
    new Setting(contentEl)
      .setName("This will create missing Notion folder pages, repair folder mappings, and move linked Notion pages to their expected folder parents.")
      .setDesc("It will not overwrite note content, resolve conflicts, delete pages, or create duplicates for valid notion_page_id mappings.");
    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => this.close());
      })
      .addButton((button) => {
        button
          .setButtonText("Repair hierarchy")
          .setCta()
          .onClick(() => {
            this.close();
            void this.plugin.runExclusivePublic("repair-hierarchy", this.hierarchyScope, () => this.plugin.repairWorkspaceHierarchy(this.hierarchyScope));
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class LlmWikiSyncSettingTab extends PluginSettingTab {
  plugin: LlmWikiSyncPlugin;
  private isTestingConnection = false;

  constructor(app: App, plugin: LlmWikiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Version")
      .setDesc(VERSION_LABEL);

    const savedToken = this.plugin.getNotionToken();

    new Setting(containerEl)
      .setName("Notion connection")
      .setHeading();

    new Setting(containerEl)
      .setName("Notion API token")
      .setDesc("Create a Notion integration and paste its API token here. Stored securely, not in plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(savedToken ? "Token saved. Enter a new token to replace it." : "secret_...")
          .onChange((value) => {
            const nextToken = value.trim();
            if (nextToken) {
              this.plugin.setNotionToken(nextToken);
            }
          });
      });

    new Setting(containerEl)
      .setName("Notion root page")
      .setDesc("Pages created by LLM Wiki Sync will be placed under this page.")
      .addText((text) => {
        text
          .setPlaceholder("https://www.notion.so/...")
          .setValue(this.plugin.settings.notionRootPageUrl)
          .onChange(async (value) => {
            this.plugin.settings.notionRootPageUrl = value.trim();
            this.plugin.settings.connectionStatus = "not-tested";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Connection status")
      .setDesc(getConnectionStatusText(this.plugin.settings.connectionStatus));

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Checks whether the saved token can read the configured root Notion page.")
      .addButton((button) => {
        button
          .setButtonText(this.isTestingConnection ? "Testing..." : "Test Notion connection")
          .setCta()
          .setDisabled(this.isTestingConnection)
          .onClick(async () => {
            this.isTestingConnection = true;
            this.display();
            await this.plugin.testNotionConnection();
            this.isTestingConnection = false;
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Sync")
      .setHeading();

    new Setting(containerEl)
      .setName("Sync current note")
      .setDesc("Use Sync current note for normal synchronization.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isSyncRunning() ? "Sync in progress..." : "Sync current note")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.syncCurrentNote();
          });
      });

    new Setting(containerEl)
      .setName("Sync folder with Notion")
      .setDesc("Choose a folder and reconcile its Markdown notes and Notion hierarchy.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isSyncRunning() ? "Sync in progress..." : "Sync folder")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            this.plugin.openFolderSyncPicker();
          });
      });

    new Setting(containerEl)
      .setName("Sync entire vault")
      .setDesc("Reconcile all supported Markdown notes in this vault with Notion.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isSyncRunning() ? "Sync in progress..." : "Sync entire vault")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.syncFolderWithNotion("");
          });
      });

    new Setting(containerEl)
      .setName("Advanced")
      .setHeading();

    new Setting(containerEl)
      .setName("Legacy bulk push")
      .setDesc("One-way push tools remain available for testing.")
      .addButton((button) => {
        button
          .setButtonText("Push current folder")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.runExclusivePublic("push-current-folder", "Current folder", () => this.plugin.pushCurrentFolderToNotion());
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Push entire vault")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            this.plugin.confirmPushEntireVaultToNotion();
          });
      });

    new Setting(containerEl)
      .setName("Audit hierarchy")
      .setDesc("Read-only check for folder mappings and linked note parents.")
      .addButton((button) => {
        button
          .setButtonText("Audit current folder")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.runExclusivePublic("audit-current-folder", "Current folder", () => this.plugin.auditWorkspaceHierarchy("current-folder"));
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Audit entire vault")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.runExclusivePublic("audit-entire-vault", "Vault root", () => this.plugin.auditWorkspaceHierarchy("entire-vault"));
          });
      });

    new Setting(containerEl)
      .setName("Initialize mappings")
      .setDesc("Validate linked notes and initialize missing baselines without overwriting content.")
      .addButton((button) => {
        button
          .setButtonText("Initialize current folder")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.runExclusivePublic("initialize-current-folder", "Current folder", () => this.plugin.initializeWorkspaceMappings("current-folder"));
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Initialize entire vault")
          .setDisabled(this.plugin.isSyncRunning())
          .onClick(() => {
            void this.plugin.runExclusivePublic("initialize-entire-vault", "Vault root", () => this.plugin.initializeWorkspaceMappings("entire-vault"));
          });
      });

    new Setting(containerEl)
      .setName("Troubleshooting tools")
      .setDesc("Push, pull, baseline initialization, conflict resolution, and debug commands remain available from the command palette.");

    new Setting(containerEl)
      .setName("Verbose debug logging")
      .setDesc("Show detailed sync diagnostics in the developer console.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.verboseDebugLogging)
          .onChange(async (value) => {
            this.plugin.settings.verboseDebugLogging = value;
            await this.plugin.saveSettings();
            this.plugin.configureDebugLogging();
          });
      });
  }
}

function getConnectionStatusText(status: LlmWikiSyncSettings["connectionStatus"]): string {
  if (status === "connected") return "✓ Connected";
  if (status === "failed") return "✕ Connection failed";
  if (status === "missing") return "⚠ Missing configuration";
  return "⚠ Not tested";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

