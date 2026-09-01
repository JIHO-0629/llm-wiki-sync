import { App, Notice } from "obsidian";
import { extractNotionPageId, NotionClient } from "../notionClient";
import { scanRemoteTree } from "./remoteTree";

const REPORT = "remote-tree-targets.json";
const TARGET_IDS = new Set([
  "3c43ae4a-a982-8168-b01e-c6e5e0eeef99",
  "3c43ae4a-a982-817d-a2a2-fbd8eb967772",
  "3c83ae4a-a982-8199-921e-de68abe5d2ce",
  "3c83ae4a-a982-8185-8f78-ce7bcf5cea93",
  "3c83ae4a-a982-81b9-bded-d780ebc69ec6",
  "3c93ae4a-a982-8166-bdd3-c984bcc7b5c3",
  "3c93ae4a-a982-814b-a48a-c14e238b72fc"
]);

export async function runRemoteTreeTargetsDiagnostic(options: { app: App; token: string; rootPageUrl: string; pluginId: string; pluginVersion: string }): Promise<void> {
  const reportPath = `${options.app.vault.configDir}/plugins/${options.pluginId}/${REPORT}`;
  let stage = -1;
  const write = async (value: Record<string, unknown>) => options.app.vault.adapter.write(reportPath, JSON.stringify(value, null, 2));
  try {
    stage = 0;
    try { await write({ stage, status: "command-entered" }); }
    catch (error) { console.error("[LLM Wiki Sync][Diagnostic] STAGE 0 write failed", error); new Notice(`LLM Wiki Sync diagnostic stage 0 write failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    console.warn("[LLM Wiki Sync][Diagnostic] STAGE 0 command entered");
    new Notice("LLM Wiki Sync diagnostic: stage 0");
    const runtimeRoot = extractNotionPageId(options.rootPageUrl);
    stage = 1;
    const adapter = options.app.vault.adapter as typeof options.app.vault.adapter & { getBasePath?: () => string };
    await write({ stage, status: "runtime-resolved", vaultName: options.app.vault.getName(), vaultBasePath: adapter.getBasePath?.(), pluginDirectory: `${options.app.vault.configDir}/plugins/${options.pluginId}`, pluginVersion: options.pluginVersion, configuredRootUrl: options.rootPageUrl, extractedRootPageId: runtimeRoot });
    if (!runtimeRoot || !options.token.trim()) { new Notice("LLM Wiki Sync: Missing Notion configuration."); return; }
    const client = new NotionClient({ token: options.token.trim() });
    stage = 2;
    await write({ stage, status: "client-created" });
    stage = 3;
    await write({ stage, status: "before-scan" });
    const tree = await scanRemoteTree(client, runtimeRoot);
    const targets = tree.map((page, index) => ({ ...page, index })).filter((page) => TARGET_IDS.has(page.id));
    const ids = new Set(targets.map((page) => page.id));
    stage = 4;
    const report = {
      stage,
      status: "scan-returned",
      runtimeRoot,
      totalRemoteTreePages: tree.length,
      targets,
      presence: {
        "10_projects": ids.has("3c43ae4a-a982-8168-b01e-c6e5e0eeef99"),
        "llm_wiki_parent": ids.has("3c43ae4a-a982-817d-a2a2-fbd8eb967772"),
        "09": ids.has("3c83ae4a-a982-8199-921e-de68abe5d2ce"),
        "10": ids.has("3c83ae4a-a982-8185-8f78-ce7bcf5cea93"),
        "11": ids.has("3c83ae4a-a982-81b9-bded-d780ebc69ec6"),
        "12": ids.has("3c93ae4a-a982-8166-bdd3-c984bcc7b5c3"),
        "13": ids.has("3c93ae4a-a982-814b-a48a-c14e238b72fc")
      }
    };
    console.info("[LLM Wiki Sync][Remote Tree Diagnostic]", report);
    await write(report);
    new Notice(`LLM Wiki Sync: Remote tree diagnostic written to ${REPORT}`);
  } catch (error) {
    console.error("[LLM Wiki Sync][Remote Tree Diagnostic] failed", error);
    try { await write({ stage, status: "error", errorName: error instanceof Error ? error.name : "Error", errorMessage: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }); } catch (writeError) { console.error("[LLM Wiki Sync][Diagnostic] error report write failed", writeError); }
    new Notice("LLM Wiki Sync: Remote tree diagnostic failed. Check the developer console.");
  }
}
