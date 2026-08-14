import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting
} from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "./notionClient";
import { pullPagesFromNotion } from "./sync/pull";
import { pushCurrentNoteToNotion } from "./sync/push";
import { debugActiveMapping } from "./sync/debug";
import { initializeSyncBaseline } from "./sync/initializeBaseline";
import { resolveConflict } from "./sync/resolveConflict";
import { syncCurrentNote } from "./sync/syncCurrentNote";
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
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: LlmWikiSyncSettings = {
  notionRootPageUrl: "",
  connectionStatus: "not-tested",
  verboseDebugLogging: false,
  syncStateVersion: SYNC_STATE_VERSION,
  syncStates: {}
};

const NOTION_TOKEN_SECRET_ID = "llm-wiki-sync-notion-api-token";
const VERSION_LABEL = "v0.6.0";

export default class LlmWikiSyncPlugin extends Plugin implements SyncBaselineStore {
  settings: LlmWikiSyncSettings = DEFAULT_SETTINGS;
  private originalConsoleDebug: typeof console.debug | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.configureDebugLogging();
    console.log("[LLM Wiki Sync] v0.6.0 loaded");

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
          baselineStore: this
        });
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
        baselineStore: this
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

  private ensureSyncStateContainer(): void {
    if (this.settings.syncStateVersion !== SYNC_STATE_VERSION) {
      this.settings.syncStateVersion = SYNC_STATE_VERSION;
    }
    if (!this.settings.syncStates || typeof this.settings.syncStates !== "object") {
      this.settings.syncStates = {};
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
        baselineStore: this
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
    action.addEventListener("click", callback);
    action.style.cursor = "pointer";
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
      baselineStore: this
    });
  }

  async pullPagesFromNotion(): Promise<void> {
    await pullPagesFromNotion({
      app: this.app,
      token: this.getNotionToken(),
      rootPageUrl: this.settings.notionRootPageUrl,
      baselineStore: this
    });
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
    containerEl.createEl("h2", { text: "LLM Wiki Sync" });
    containerEl.createEl("p", { text: "Notion ↔ Obsidian synchronization" });
    containerEl.createEl("p", { text: `Version: ${VERSION_LABEL}` });

    const savedToken = this.plugin.getNotionToken();

    containerEl.createEl("h3", { text: "Notion connection" });

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

    containerEl.createEl("h3", { text: "Sync" });
    containerEl.createEl("p", { text: "Normal use: 1. Open a note 2. Click Sync current note 3. If a conflict appears, choose which version to keep." });

    new Setting(containerEl)
      .setName("LLM Wiki Sync: Sync current note")
      .setDesc("Use Sync current note for normal synchronization.")
      .addButton((button) => {
        button
          .setButtonText("Sync current note")
          .onClick(() => {
            void syncCurrentNote({
              app: this.app,
              token: this.plugin.getNotionToken(),
              rootPageUrl: this.plugin.settings.notionRootPageUrl,
              baselineStore: this.plugin
            });
          });
      });

    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Troubleshooting tools")
      .setDesc("Push, Pull, baseline initialization, conflict resolution, and debug commands remain available from the command palette.");

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
