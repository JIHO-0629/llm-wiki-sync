import { Notice, normalizePath, TFile, type App } from "obsidian";
import { extractNotionPageId, NotionApiError, NotionClient } from "../notionClient";
import { isSafeVisibleFileName, sanitizeFileName, sanitizeNotionTitleForFileName } from "../utils/fileName";
import {
  compareSnapshotsToBaseline,
  createSyncBaseline,
  getLocalSyncSnapshot,
  getRemoteSyncSnapshotFromFetched,
  logBaselineNotAdvanced,
  logConflictState,
  type RemoteSyncSnapshot,
  type SyncBaselineStore
} from "./baseline";
import {
  createFrontmatterForNotionPage,
  findFilesMappedToPage,
  getNotionPageMapping,
  normalizeNotionPageId,
  normalizePulledMarkdown,
  replaceMarkdownBodyPreservingFrontmatter
} from "./mapping";
import {
  getFolderMappingKey,
  normalizeVaultFolderPath,
  type FolderMapping,
  type FolderMappingStore
} from "./bulkPush";
import { isReviewPath, scanRemoteTree, type RemoteTreePage } from "./remoteTree";

export interface PullPagesFromNotionOptions {
  app: App;
  token: string;
  rootPageUrl: string;
  baselineStore: SyncBaselineStore;
  store?: PullStore;
}

export interface PullStore extends SyncBaselineStore, FolderMappingStore {
  getAllFolderMappings?(): FolderMapping[];
}

interface PullCounts { created: number; updated: number; skipped: number; failed: number; foldersCreated: number; }

const PULL_FOLDER = "LLM Wiki Sync Pull";

type StoredFolderPathResult =
  | { status: "none" }
  | { status: "matched"; folderPath: string }
  | { status: "ambiguous"; reason: string };

type FolderMappingPersistResult = "saved" | "matched" | "unavailable" | { status: "ambiguous"; reason: string };

export async function pullPagesFromNotion(options: PullPagesFromNotionOptions): Promise<void> {
  const runId = createRunId();
  const logPrefix = `[LLM Wiki Sync][Pull][${runId}]`;
  const counts: PullCounts = { created: 0, updated: 0, skipped: 0, failed: 0, foldersCreated: 0 };
  const token = options.token.trim();
  if (!token) { new Notice("LLM Wiki Sync: Notion API token is missing"); return; }

  const rootPageId = extractNotionPageId(options.rootPageUrl);
  console.debug(`${logPrefix} root page id:`, rootPageId || "<invalid>");
  if (!rootPageId) { new Notice("LLM Wiki Sync: Notion Root Page URL is invalid"); return; }

  const client = new NotionClient({ token });
  new Notice("LLM Wiki Sync: Pulling from Notion...");

  try {
    const remotePages = await scanRemoteTree(client, rootPageId);
    const normalizedRootPageId = normalizeNotionPageId(rootPageId);
    const store = options.store ?? asOptionalPullStore(options.baselineStore);
    const folderPathByPageId = new Map<string, string | null>([[normalizeNotionPageId(rootPageId), PULL_FOLDER]]);
    const blockedSubtreePageIds = new Set<string>();
    const pullFolderResult = await ensureLocalFolder(options.app, PULL_FOLDER);
    if (pullFolderResult === "created") counts.foldersCreated += 1;
    if (pullFolderResult !== "created" && pullFolderResult !== "exists") {
      new Notice("LLM Wiki Sync: Pull folder path is blocked by a file.");
      return;
    }

    for (const childPage of remotePages) {
      try {
        const pageLog = `${logPrefix}[${childPage.id}]`;
        if (isReviewPath(childPage.path)) {
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
          blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
          counts.skipped += 1;
          console.warn(`${pageLog} skipped: system Review path`, childPage.path);
          continue;
        }

        const parentFolderPath = folderPathByPageId.get(normalizeNotionPageId(childPage.parentPageId));
        if (parentFolderPath === null || isBlockedByAncestor(childPage, blockedSubtreePageIds)) {
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
          counts.skipped += 1;
          console.warn(`${pageLog} skipped: parent hierarchy is ambiguous`);
          continue;
        }
        if (parentFolderPath === undefined) {
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
          counts.skipped += 1;
          console.warn(`${pageLog} skipped: parent folder was not resolved`);
          continue;
        }

        console.debug(`${pageLog} notion_page_id:`, childPage.id);
        const mappedFiles = await findFilesMappedToPage(options.app, childPage.id);
        if (mappedFiles.length > 1) {
          console.error(`[LLM Wiki Sync][Mapping][${runId}] DUPLICATE notion_page_id conflict`, childPage.id);
          counts.skipped += 1;
          new Notice("LLM Wiki Sync: Duplicate local mapping conflict.");
          continue;
        }

        const storedFolderPath = getStoredFolderPathForRemotePage(store, childPage.id, normalizedRootPageId);
        if (storedFolderPath.status === "ambiguous") {
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
          blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
          counts.skipped += 1;
          console.warn(`${pageLog} skipped: ambiguous folder mapping`, storedFolderPath.reason);
          new Notice("LLM Wiki Sync: Ambiguous folder mapping skipped.");
          continue;
        }

        const pageDetails = await client.getPageDetails(childPage.id);
        const rawTitle = pageDetails.title || childPage.title;
        const pageMarkdown = await client.retrievePageMarkdown(childPage.id);
        const remoteSnapshot = getRemoteSyncSnapshotFromFetched(pageDetails, pageMarkdown);
        const cleanMarkdown = normalizePulledMarkdown(pageMarkdown.markdown);
        if (pageMarkdown.truncated) {
          console.warn(`${pageLog} Notion content truncated:`, pageMarkdown.unknownBlockIds);
          new Notice("LLM Wiki Sync: Warning - Notion page content was truncated");
        }

        if (storedFolderPath.status === "matched" && mappedFiles.length === 1) {
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
          blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
          counts.skipped += 1;
          console.warn(`${pageLog} skipped: page has both note mapping and folder mapping`);
          new Notice("LLM Wiki Sync: Ambiguous note/folder mapping skipped.");
          continue;
        }

        if (storedFolderPath.status === "matched") {
          const folderPath = storedFolderPath.folderPath;
          const expectedFolderPath = getExpectedMappedFolderPath(childPage, parentFolderPath, rootPageId, folderPath, rawTitle);
          if (normalizeVaultFolderPath(folderPath) !== normalizeVaultFolderPath(expectedFolderPath)) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: stale folder mapping path`, { stored: folderPath, expected: expectedFolderPath });
            new Notice("LLM Wiki Sync: Stale folder mapping skipped.");
            continue;
          }
          if (!childPage.hasChildren || pageMarkdown.truncated || !isOwnContentEmpty(pageMarkdown.markdown, childPage.directChildren)) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: mapped folder has content, no children, or truncated markdown`);
            new Notice("LLM Wiki Sync: Ambiguous mapped folder skipped.");
            continue;
          }
          const folderResult = await ensureLocalFolder(options.app, folderPath);
          if (folderResult === "created") counts.foldersCreated += 1;
          if (folderResult === "file_collision" || folderResult === "failed") {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: stored folder mapping path is blocked`, folderPath);
            continue;
          }
          const persistResult = await persistFolderMappingIfPossible(store, normalizedRootPageId, folderPath, childPage.id);
          if (isAmbiguousPersistResult(persistResult)) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: ambiguous folder mapping`, persistResult.reason);
            new Notice("LLM Wiki Sync: Ambiguous folder mapping skipped.");
            continue;
          }
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), folderPath);
          counts.skipped += 1;
          continue;
        }

        if (mappedFiles.length === 1) {
          if (childPage.hasChildren) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: mapped notes with children are ambiguous`);
            new Notice("LLM Wiki Sync: Ambiguous mapped note with children skipped.");
            continue;
          }

          const mappedFile = mappedFiles[0];
          let baseline;
          try {
            baseline = options.baselineStore.getSyncBaseline(childPage.id);
          } catch (error) {
            console.error(`[LLM Wiki Sync][Baseline][${runId}] load failed`, getErrorMessage(error));
            counts.failed += 1;
            new Notice("LLM Wiki Sync: Baseline error. Operation aborted.");
            continue;
          }
          console.debug(`[LLM Wiki Sync][Baseline][${runId}] loaded`, Boolean(baseline));
          if (!baseline) {
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: No sync baseline exists for this note. Initialize the baseline first.");
            continue;
          }

          const localSnapshot = await getLocalSyncSnapshot(options.app, mappedFile);
          const change = compareSnapshotsToBaseline(baseline, localSnapshot, remoteSnapshot);
          logConflictState(runId, change.localChanged, change.remoteChanged, change.state);
          if (change.state === "CLEAN") {
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: Already in sync.");
            continue;
          }
          if (change.state === "LOCAL_ONLY_CHANGED") {
            counts.skipped += 1;
            console.warn(`${pageLog} stale Pull protection: Obsidian changed since baseline`);
            new Notice("LLM Wiki Sync: Obsidian changed since the last sync. Push first.");
            continue;
          }
          if (change.state === "CONFLICT") {
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: Conflict detected. Both Obsidian and Notion changed.");
            continue;
          }

          console.debug(`${pageLog} raw Notion title:`, rawTitle);
          console.debug(`${pageLog} current local path:`, mappedFile.path);
          console.debug(`${pageLog} body update start`);
          await options.app.vault.process(mappedFile, (existingMarkdown) =>
            replaceMarkdownBodyPreservingFrontmatter(existingMarkdown, cleanMarkdown, childPage.id)
          );
          console.debug(`${pageLog} body update result: success`);
          counts.updated += 1;

          const renameResult = await renameMappedFileAfterPull(options.app, mappedFile, childPage.id, rawTitle, runId);
          if (renameResult === "renamed" || renameResult === "noop") {
            await advancePullBaselineAfterSuccess(options.app, options.baselineStore, childPage.id, remoteSnapshot, runId, "advanced");
            new Notice(renameResult === "renamed" ? "LLM Wiki Sync: Updated content and filename." : "LLM Wiki Sync: Updated content.");
          } else {
            logBaselineNotAdvanced(runId, `rename result: ${renameResult}`);
            new Notice(renameResult === "collision"
              ? "LLM Wiki Sync: Content updated; rename skipped due to filename collision."
              : "LLM Wiki Sync: Content updated; rename failed or skipped. Check console.");
          }
          continue;
        }

        if (childPage.hasChildren) {
          if (pageMarkdown.truncated) {
            console.warn(`${pageLog} skipped: container markdown truncated`);
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            new Notice("LLM Wiki Sync: Ambiguous truncated container skipped.");
            continue;
          }
          if (isOwnContentEmpty(pageMarkdown.markdown, childPage.directChildren)) {
            const folderPath = getExpectedFolderPath(parentFolderPath, rawTitle);
            if (!isSafeVisibleFileName(getLastPathSegment(folderPath))) {
              console.error(`${pageLog} sanitizer error: unsafe folder target`, folderPath || "<invalid>");
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
              blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
              counts.failed += 1;
              continue;
            }
            const mappingAmbiguity = getFolderMappingAmbiguity(store, normalizedRootPageId, folderPath, childPage.id);
            if (mappingAmbiguity) {
              console.warn(`${pageLog} skipped: ambiguous folder mapping`, mappingAmbiguity.reason);
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
              blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
              counts.skipped += 1;
              new Notice("LLM Wiki Sync: Ambiguous folder mapping skipped.");
              continue;
            }
            const folderResult = await ensureLocalFolder(options.app, folderPath);
            if (folderResult === "created") counts.foldersCreated += 1;
            if (folderResult === "file_collision" || folderResult === "failed") {
              console.warn(`${pageLog} folder create skipped: target collision or failure`, folderPath);
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
              blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
              counts.skipped += 1;
              continue;
            }
            const persistResult = await persistFolderMappingIfPossible(store, normalizedRootPageId, folderPath, childPage.id);
            if (isAmbiguousPersistResult(persistResult)) {
              console.warn(`${pageLog} skipped: ambiguous folder mapping`, persistResult.reason);
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
              blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
              counts.skipped += 1;
              new Notice("LLM Wiki Sync: Ambiguous folder mapping skipped.");
              continue;
            }
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), folderPath);
            counts.skipped += 1;
            continue;
          }

          console.warn(`${pageLog} skipped: remote page has both note content and child pages`, childPage.path);
          folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
          blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
          counts.skipped += 1;
          new Notice("LLM Wiki Sync: Ambiguous remote page with content and children skipped.");
          continue;
        }

        const fileName = sanitizeNotionTitleForFileName(rawTitle);
        if (!fileName || !isSafeVisibleFileName(fileName)) {
          console.error(`${pageLog} sanitizer error: unsafe create target basename`, fileName || "<invalid>");
          counts.failed += 1;
          continue;
        }
        const filePath = normalizePath(`${parentFolderPath}/${fileName}`);
        if (options.app.vault.getAbstractFileByPath(filePath)) {
          console.warn(`${pageLog} create skipped: target already exists`, filePath);
          counts.skipped += 1;
          continue;
        }
        console.debug(`${pageLog} Mode: create`, filePath);
        await options.app.vault.create(filePath, createFrontmatterForNotionPage(childPage.id) + cleanMarkdown);
        await advancePullBaselineAfterSuccess(options.app, options.baselineStore, childPage.id, remoteSnapshot, runId, "initialized");
        counts.created += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(`${logPrefix} child page failed`, childPage.id, getErrorMessage(error));
      }
    }
  } catch (error) {
    reportPullFailure(error);
    return;
  }

  new Notice(`LLM Wiki Sync: Created ${counts.created}, updated ${counts.updated}, skipped ${counts.skipped}, failed ${counts.failed}, folders created ${counts.foldersCreated}.`);
}

function asOptionalPullStore(store: SyncBaselineStore): PullStore | undefined {
  const candidate = store as Partial<PullStore>;
  if (typeof candidate.getFolderMapping === "function" && typeof candidate.saveFolderMapping === "function") {
    return candidate as PullStore;
  }
  return undefined;
}

function getStoredFolderPathForRemotePage(store: PullStore | undefined, pageId: string, normalizedRootPageId: string): StoredFolderPathResult {
  const normalizedPageId = normalizeNotionPageId(pageId);
  const mappings = typeof store?.getAllFolderMappings === "function" ? store.getAllFolderMappings() : [];
  const matches = mappings.filter((mapping) =>
    normalizeNotionPageId(mapping.rootPageId) === normalizedRootPageId &&
    normalizeNotionPageId(mapping.notionPageId) === normalizedPageId
  );
  if (matches.length === 0) {
    return { status: "none" };
  }
  const uniquePaths = new Set(matches.map((mapping) => normalizeVaultFolderPath(mapping.lastKnownPath)));
  if (uniquePaths.size > 1) {
    return { status: "ambiguous", reason: `remote page is mapped to multiple local folders: ${Array.from(uniquePaths).join(", ")}` };
  }
  return { status: "matched", folderPath: Array.from(uniquePaths)[0] ?? "" };
}

function getFolderMappingAmbiguity(
  store: PullStore | undefined,
  normalizedRootPageId: string,
  folderPath: string,
  pageId: string
): { status: "ambiguous"; reason: string } | null {
  if (!store) {
    return null;
  }
  const normalizedFolderPath = normalizeVaultFolderPath(folderPath);
  const mappingKey = getFolderMappingKey(normalizedRootPageId, normalizedFolderPath);
  const existing = store.getFolderMapping(mappingKey);
  if (
    existing &&
    normalizeNotionPageId(existing.rootPageId) === normalizedRootPageId &&
    normalizeNotionPageId(existing.notionPageId) !== normalizeNotionPageId(pageId)
  ) {
    return {
      status: "ambiguous",
      reason: `${normalizedFolderPath} is already mapped to ${existing.notionPageId}, not ${pageId}`
    };
  }

  const inverse = getStoredFolderPathForRemotePage(store, pageId, normalizedRootPageId);
  if (inverse.status === "ambiguous") {
    return inverse;
  }
  if (inverse.status === "matched" && normalizeVaultFolderPath(inverse.folderPath) !== normalizedFolderPath) {
    return {
      status: "ambiguous",
      reason: `${pageId} is already mapped to ${inverse.folderPath}, not ${normalizedFolderPath}`
    };
  }
  return null;
}

async function persistFolderMappingIfPossible(
  store: PullStore | undefined,
  normalizedRootPageId: string,
  folderPath: string,
  pageId: string
): Promise<FolderMappingPersistResult> {
  if (!store) {
    return "unavailable";
  }
  const normalizedFolderPath = normalizeVaultFolderPath(folderPath);
  const mappingKey = getFolderMappingKey(normalizedRootPageId, normalizedFolderPath);
  const existing = store.getFolderMapping(mappingKey);
  if (
    existing &&
    normalizeNotionPageId(existing.rootPageId) === normalizedRootPageId &&
    normalizeNotionPageId(existing.notionPageId) === normalizeNotionPageId(pageId)
  ) {
    return "matched";
  }
  const ambiguity = getFolderMappingAmbiguity(store, normalizedRootPageId, normalizedFolderPath, pageId);
  if (ambiguity) {
    return ambiguity;
  }
  await store.saveFolderMapping(mappingKey, {
    notionPageId: pageId,
    lastKnownPath: normalizedFolderPath,
    rootPageId: normalizedRootPageId
  });
  return "saved";
}

function isAmbiguousPersistResult(result: FolderMappingPersistResult): result is { status: "ambiguous"; reason: string } {
  return typeof result === "object" && result.status === "ambiguous";
}

async function ensureLocalFolder(app: App, folderPath: string): Promise<"created" | "exists" | "file_collision" | "failed"> {
  const normalizedFolderPath = normalizeVaultFolderPath(folderPath);
  if (!normalizedFolderPath) {
    return "exists";
  }
  const segments = normalizedFolderPath.split("/");
  let created = false;
  for (let index = 0; index < segments.length; index += 1) {
    const currentPath = segments.slice(0, index + 1).join("/");
    const existing = app.vault.getAbstractFileByPath(currentPath);
    if (existing) {
      if (existing instanceof TFile) {
        return "file_collision";
      }
      continue;
    }
    try {
      await app.vault.createFolder(currentPath);
      created = true;
    } catch (error) {
      console.error("[LLM Wiki Sync][Pull] folder create failed", currentPath, getErrorMessage(error));
      return "failed";
    }
  }
  return created ? "created" : "exists";
}

function isBlockedByAncestor(page: RemoteTreePage, blockedPageIds: Set<string>): boolean {
  return blockedPageIds.has(normalizeNotionPageId(page.parentPageId));
}

function isOwnContentEmpty(markdown: string, directChildren: Array<{ id: string; title: string }>): boolean {
  return stripDirectChildPageReferences(markdown, directChildren).replace(/\s+/g, "").length === 0;
}

export function stripDirectChildPageReferences(markdown: string, directChildren: Array<{ id: string; title: string }>): string {
  return markdown
    .replace(/^[ \t]*<empty-block\/>[ \t]*$/gm, "")
    .replace(/^[ \t]*<page\b([^>]*)>([^<]*)<\/page>[ \t]*$/gm, (line, attrs: string, title: string) => {
      const normalizedTitle = decodeHtmlEntities(title.trim());
      const normalizedAttrs = normalizeNotionPageId(attrs);
      for (const child of directChildren) {
        if (normalizedTitle === child.title && normalizedAttrs.includes(normalizeNotionPageId(child.id))) {
          return "";
        }
      }
      return line;
    });
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getLastPathSegment(path: string): string {
  const normalized = normalizeVaultFolderPath(path);
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? "";
}

function getExpectedFolderPath(parentFolderPath: string, rawTitle: string): string {
  return normalizePath(`${parentFolderPath}/${sanitizeFileName(rawTitle)}`);
}

function getExpectedMappedFolderPath(
  childPage: RemoteTreePage,
  parentFolderPath: string,
  rootPageId: string,
  storedFolderPath: string,
  rawTitle: string
): string {
  const normalizedStoredFolderPath = normalizeVaultFolderPath(storedFolderPath);
  const expectedParentPath = normalizeNotionPageId(childPage.parentPageId) !== normalizeNotionPageId(rootPageId)
    ? parentFolderPath
    : normalizedStoredFolderPath.startsWith(`${PULL_FOLDER}/`)
      ? PULL_FOLDER
      : "";
  return getExpectedFolderPath(expectedParentPath, rawTitle);
}

async function advancePullBaselineAfterSuccess(
  app: App,
  baselineStore: SyncBaselineStore,
  pageId: string,
  remoteSnapshot: RemoteSyncSnapshot,
  runId: string,
  action: "advanced" | "initialized"
): Promise<void> {
  try {
    const mappedFiles = await findFilesMappedToPage(app, pageId);
    if (mappedFiles.length !== 1) {
      logBaselineNotAdvanced(runId, `expected exactly one mapped file after Pull, found ${mappedFiles.length}`);
      return;
    }

    const localSnapshot = await getLocalSyncSnapshot(app, mappedFiles[0]);
    await baselineStore.saveSyncBaseline(pageId, createSyncBaseline(pageId, localSnapshot, remoteSnapshot));
    console.debug(`[LLM Wiki Sync][Baseline][${runId}] ${action}`, pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${runId}] ${action} failed`, getErrorMessage(error));
    logBaselineNotAdvanced(runId, "baseline save failed after Pull");
  }
}

export async function renameMappedFileAfterPull(app: App, file: TFile, pageId: string, rawTitle: string, runId: string): Promise<"renamed" | "noop" | "collision" | "failed"> {
  const logPrefix = `[LLM Wiki Sync][Rename][${runId}]`;
  const targetBaseName = sanitizeNotionTitleForFileName(rawTitle);
  console.debug(`${logPrefix} raw Notion title:`, rawTitle);
  console.debug(`${logPrefix} sanitized target basename:`, targetBaseName || "<invalid>");
  if (!targetBaseName) return "failed";
  if (!isSafeVisibleFileName(targetBaseName)) {
    console.error(`${logPrefix} sanitizer error: unsafe rename target basename`, targetBaseName);
    return "failed";
  }

  const folderPath = file.parent?.path ?? "";
  const targetPath = normalizePath(folderPath ? `${folderPath}/${targetBaseName}` : targetBaseName);
  const currentPath = file.path;
  const targetExisting = app.vault.getAbstractFileByPath(targetPath);
  console.debug(`${logPrefix} current:`, currentPath);
  console.debug(`${logPrefix} target:`, targetPath);
  console.debug(`${logPrefix} target exists:`, Boolean(targetExisting));
  if (targetPath === currentPath) return "noop";
  if (targetExisting && targetExisting !== file) {
    console.warn(`${logPrefix} COLLISION`);
    console.warn(`${logPrefix} current:`, currentPath);
    console.warn(`${logPrefix} target:`, targetPath);
    return "collision";
  }

  try {
    console.debug(`${logPrefix} rename start`);
    await app.fileManager.renameFile(file, targetPath);
  } catch (error) {
    if (!isCaseOnlyRename(currentPath, targetPath)) {
      console.error(`${logPrefix} rename failed:`, getErrorMessage(error));
      return "failed";
    }
    try {
      await renameCaseOnlyViaTemporaryPath(app, file, currentPath, targetPath, runId);
    } catch (temporaryError) {
      console.error(`${logPrefix} case-only rename failed:`, getErrorMessage(temporaryError));
      return "failed";
    }
  }

  const renamedFile = app.vault.getAbstractFileByPath(targetPath);
  if (!(renamedFile instanceof TFile) || renamedFile.path !== targetPath) {
    console.error(`${logPrefix} verification failed: target does not exist`, targetPath);
    return "failed";
  }
  const mapping = await getNotionPageMapping(app, renamedFile);
  const oldPathFile = app.vault.getAbstractFileByPath(currentPath);
  const mappingMatches = mapping.pageId && normalizeNotionPageId(mapping.pageId) === normalizeNotionPageId(pageId);
  console.debug(`${logPrefix} mapping verification result:`, Boolean(mappingMatches));
  if (!mappingMatches || (oldPathFile instanceof TFile && oldPathFile !== renamedFile)) {
    console.error(`${logPrefix} HIGH SEVERITY: rename mapping verification failed`);
    return "failed";
  }
  console.debug(`${logPrefix} rename result: success`);
  return "renamed";
}

async function renameCaseOnlyViaTemporaryPath(app: App, file: TFile, currentPath: string, targetPath: string, runId: string): Promise<void> {
  const folderPath = file.parent?.path ?? "";
  const tempPath = normalizePath(folderPath ? `${folderPath}/.llm-wiki-sync-${runId}-${Date.now()}.md` : `.llm-wiki-sync-${runId}-${Date.now()}.md`);
  if (app.vault.getAbstractFileByPath(tempPath)) throw new Error("Temporary rename path already exists");
  await app.fileManager.renameFile(file, tempPath);
  const tempFile = app.vault.getAbstractFileByPath(tempPath);
  if (!(tempFile instanceof TFile)) throw new Error("Temporary rename did not produce a file");
  try {
    await app.fileManager.renameFile(tempFile, targetPath);
  } catch (error) {
    try { await app.fileManager.renameFile(tempFile, currentPath); } catch (restoreError) {
      console.error(`[LLM Wiki Sync][Rename][${runId}] HIGH SEVERITY: could not restore temporary file`, getErrorMessage(restoreError));
    }
    throw error;
  }
}

function isCaseOnlyRename(currentPath: string, targetPath: string): boolean { return currentPath.toLocaleLowerCase() === targetPath.toLocaleLowerCase(); }
function createRunId(): string { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function getErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function reportPullFailure(error: unknown): void {
  if (error instanceof NotionApiError) new Notice(`LLM Wiki Sync: Pull failed (${error.status}) - ${error.message}`);
  else new Notice(`LLM Wiki Sync: Pull failed - ${getErrorMessage(error)}`);
}
