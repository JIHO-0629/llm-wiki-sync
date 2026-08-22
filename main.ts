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
  type QuarantineRecord
} from "./sync/folderSync";
import {
  SYNC_STATE_VERSION,
  validateSyncBaseline,
  type SyncBaseline,
  type SyncBaselineStore
} from "./sync/baseline";
import { normalizeNotionPageId } from "./sync/mapping";

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
const VERSION_LABEL = "v0.8.1";

export default class LlmWikiSyncPlugin extends Plugin implements SyncBaselineStore, FolderSyncStore {
  settings: LlmWikiSyncSettings = DEFAULT_SETTINGS;
  private originalConsoleDebug: typeof console.debug | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.configureDebugLogging();
    console.debug("[LLM Wiki Sync] v0.8.1 loaded");

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
        void this.pushCurrentNoteToNotion();
      }
    });

    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      callback: () => {
        void syncCurrentNote({
          app: this.app,
          token: this.getNotionToken(),
          rootPageUrl: this.settings.notionRootPageUrl,
          baselineStore: this,
          resolveParentPageId: this.resolveParentPageIdForFile
        });
      }
    });

    this.addCommand({
      id: "push-current-folder-to-notion",
      name: "LLM Wiki Sync: Push current folder to Notion",
      callback: () => {
        void this.pushCurrentFolderToNotion();
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
        void this.auditWorkspaceHierarchy("current-folder");
      }
    });

    this.addCommand({
      id: "audit-entire-vault-hierarchy",
      name: "LLM Wiki Sync: Audit entire vault hierarchy",
      callback: () => {
        void this.auditWorkspaceHierarchy("entire-vault");
      }
    });

    this.addCommand({
      id: "initialize-current-folder-mappings",
      name: "LLM Wiki Sync: Initialize current folder mappings",
      callback: () => {
        void this.initializeWorkspaceMappings("current-folder");
      }
    });

    this.addCommand({
      id: "initialize-entire-vault-mappings",
      name: "LLM Wiki Sync: Initialize entire vault mappings",
      callback: () => {
        void this.initializeWorkspaceMappings("entire-vault");
      }
    });

    this.addCommand({
      id: "pull-pages-from-notion",
      name: "Pull from Notion",
      callback: () => {
        void this.pullPagesFromNotion();
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
      void syncCurrentNote({
        app: this.app,
        token: this.getNotionToken(),
        rootPageUrl: this.settings.notionRootPageUrl,
        baselineStore: this,
        resolveParentPageId: this.resolveParentPageIdForFile
      });
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

  async pullPagesFromNotion(): Promise<void> {
    await pullPagesFromNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      baselineStore: this
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
    await syncFolderWithNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      store: this,
      folderPath
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
            void this.plugin.pushEntireVaultToNotion();
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
            void this.plugin.repairWorkspaceHierarchy(this.hierarchyScope);
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
          .setButtonText("Sync current note")
          .onClick(() => {
            void syncCurrentNote({
              app: this.app,
              token: this.plugin.getNotionToken(),
              rootPageUrl: this.plugin.settings.notionRootPageUrl,
              baselineStore: this.plugin,
              resolveParentPageId: this.plugin.resolveParentPageIdForFile
            });
          });
      });

    new Setting(containerEl)
      .setName("Sync folder with Notion")
      .setDesc("Choose a folder and reconcile its Markdown notes and Notion hierarchy.")
      .addButton((button) => {
        button
          .setButtonText("Sync folder")
          .onClick(() => {
            this.plugin.openFolderSyncPicker();
          });
      });

    new Setting(containerEl)
      .setName("Sync entire vault")
      .setDesc("Reconcile all supported Markdown notes in this vault with Notion.")
      .addButton((button) => {
        button
          .setButtonText("Sync entire vault")
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
          .onClick(() => {
            void this.plugin.pushCurrentFolderToNotion();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Push entire vault")
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
          .onClick(() => {
            void this.plugin.auditWorkspaceHierarchy("current-folder");
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Audit entire vault")
          .onClick(() => {
            void this.plugin.auditWorkspaceHierarchy("entire-vault");
          });
      });

    new Setting(containerEl)
      .setName("Initialize mappings")
      .setDesc("Validate linked notes and initialize missing baselines without overwriting content.")
      .addButton((button) => {
        button
          .setButtonText("Initialize current folder")
          .onClick(() => {
            void this.plugin.initializeWorkspaceMappings("current-folder");
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Initialize entire vault")
          .onClick(() => {
            void this.plugin.initializeWorkspaceMappings("entire-vault");
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
