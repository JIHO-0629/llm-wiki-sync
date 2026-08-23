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
  CONTAINER_INDEX_ROLE,
  findFilesMappedToPage,
  getNotionPageMapping,
  isContainerIndexFile,
  normalizeNotionPageId,
  normalizePulledMarkdown,
  NOTION_PAGE_ID_PROPERTY,
  NOTION_PAGE_ROLE_PROPERTY,
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
const CONTAINER_INDEX_FILE = "_index.md";

type StoredFolderPathResult =
  | { status: "none" }
  | { status: "matched"; folderPath: string }
  | { status: "ambiguous"; reason: string };

type FolderMappingPersistResult = "saved" | "matched" | "unavailable" | { status: "ambiguous"; reason: string };

type ContainerIndexResult = "created" | "updated" | "clean" | "skipped" | "blocked";

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
    const folderPathByPageId = new Map<string, string | null>([[normalizeNotionPageId(rootPageId), ""]]);
    const blockedSubtreePageIds = new Set<string>();

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

        const pageDetails = await client.getPageDetails(childPage.id);
        const rawTitle = pageDetails.title || childPage.title;
        const pageMarkdown = await client.retrievePageMarkdown(childPage.id);
        const remoteSnapshot = getRemoteSyncSnapshotFromFetched(pageDetails, pageMarkdown);
        const cleanMarkdown = normalizePulledMarkdown(pageMarkdown.markdown);
        const ownMarkdown = normalizePulledMarkdown(stripDirectChildPageReferences(pageMarkdown.markdown, childPage.directChildren));
        const ownRemoteSnapshot = getRemoteSyncSnapshotFromFetched(pageDetails, { ...pageMarkdown, markdown: ownMarkdown });
        if (pageMarkdown.truncated) {
          console.warn(`${pageLog} Notion content truncated:`, pageMarkdown.unknownBlockIds);
          new Notice("LLM Wiki Sync: Warning - Notion page content was truncated");
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

        if (storedFolderPath.status === "matched" && mappedFiles.length === 1) {
          const expectedIndexPath = normalizePath(`${storedFolderPath.folderPath}/${CONTAINER_INDEX_FILE}`);
          if (!(await isMappedContainerIndexFile(options.app, mappedFiles[0], expectedIndexPath))) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: page has both note mapping and folder mapping`);
            new Notice("LLM Wiki Sync: Ambiguous note/folder mapping skipped.");
            continue;
          }
        }

        if (storedFolderPath.status === "matched") {
          const expectedFolderPath = getExpectedMappedFolderPath(childPage, parentFolderPath, rootPageId, storedFolderPath.folderPath, rawTitle);
          const folderPath = getMigratedLegacyPullPath(storedFolderPath.folderPath, expectedFolderPath);
          if (normalizeVaultFolderPath(folderPath) !== normalizeVaultFolderPath(expectedFolderPath)) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: stale folder mapping path`, { stored: storedFolderPath.folderPath, expected: expectedFolderPath });
            new Notice("LLM Wiki Sync: Stale folder mapping skipped.");
            continue;
          }
          if (!childPage.hasChildren || pageMarkdown.truncated) {
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.skipped += 1;
            console.warn(`${pageLog} skipped: mapped folder has no children or truncated markdown`);
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
          if (normalizeVaultFolderPath(storedFolderPath.folderPath) !== normalizeVaultFolderPath(folderPath)) {
            await migrateLegacyPullFolderMappingAfterSafePath(store, normalizedRootPageId, storedFolderPath.folderPath, folderPath, childPage.id);
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
          if (!isOwnContentEmpty(pageMarkdown.markdown, childPage.directChildren) || await hasValidContainerIndex(options.app, folderPath, childPage.id)) {
            const indexResult = await upsertContainerIndex({
              app: options.app,
              baselineStore: options.baselineStore,
              folderPath,
              pageId: childPage.id,
              ownMarkdown,
              remoteSnapshot: ownRemoteSnapshot,
              runId,
              counts,
              pageLog
            });
            if (indexResult === "blocked") {
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
              blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            }
          }
          counts.skipped += 1;
          continue;
        }

        if (mappedFiles.length === 1) {
          if (childPage.hasChildren) {
            const migrationResult = pageMarkdown.truncated ? "blocked" : await migrateMappedNoteToContainerIndex({
              app: options.app,
              baselineStore: options.baselineStore,
              mappedFile: mappedFiles[0],
              folderPath: getExpectedFolderPath(parentFolderPath, rawTitle),
              pageId: childPage.id,
              ownMarkdown,
              remoteSnapshot: ownRemoteSnapshot,
              normalizedRootPageId,
              store,
              runId,
              counts,
              pageLog
            });
            if (migrationResult !== "blocked") {
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), getExpectedFolderPath(parentFolderPath, rawTitle));
              counts.skipped += 1;
              continue;
            }

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
            if (isLegacyPullPath(mappedFile.path)) {
              const migration = await migrateLegacyLeafNote({
                app: options.app,
                file: mappedFile,
                pageId: childPage.id,
                parentFolderPath,
                rawTitle,
                runId
              });
              if (migration === "migrated") {
                counts.updated += 1;
              } else {
                counts.skipped += 1;
              }
              continue;
            }
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
          if (isLegacyPullPath(mappedFile.path)) {
            const targetPath = getLegacyLeafCanonicalPath(parentFolderPath, rawTitle);
            if (!targetPath || isPathCollision(options.app, targetPath, mappedFile)) {
              counts.skipped += 1;
              console.warn(`${pageLog} legacy leaf migration skipped: target collision`, targetPath);
              continue;
            }
          }
          console.debug(`${pageLog} body update start`);
          await options.app.vault.process(mappedFile, (existingMarkdown) =>
            replaceMarkdownBodyPreservingFrontmatter(existingMarkdown, cleanMarkdown, childPage.id)
          );
          console.debug(`${pageLog} body update result: success`);
          counts.updated += 1;

          const renameResult = isLegacyPullPath(mappedFile.path)
            ? await migrateLegacyLeafNote({
              app: options.app,
              file: mappedFile,
              pageId: childPage.id,
              parentFolderPath,
              rawTitle,
              runId
            })
            : await renameMappedFileAfterPull(options.app, mappedFile, childPage.id, rawTitle, runId);
          if (renameResult === "renamed" || renameResult === "noop" || renameResult === "migrated") {
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
          const ownContentEmpty = isOwnContentEmpty(pageMarkdown.markdown, childPage.directChildren);
          const folderPath = getExpectedFolderPath(parentFolderPath, rawTitle);
          if (!isSafeVisibleFileName(getLastPathSegment(folderPath))) {
            console.error(`${pageLog} sanitizer error: unsafe folder target`, folderPath || "<invalid>");
            folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
            blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            counts.failed += 1;
            continue;
          }
          const mappingAmbiguity = await getFolderMappingAmbiguity(store, normalizedRootPageId, folderPath, childPage.id);
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
          if (!ownContentEmpty || await hasValidContainerIndex(options.app, folderPath, childPage.id)) {
            const indexResult = await upsertContainerIndex({
              app: options.app,
              baselineStore: options.baselineStore,
              folderPath,
              pageId: childPage.id,
              ownMarkdown,
              remoteSnapshot: ownRemoteSnapshot,
              runId,
              counts,
              pageLog
            });
            if (indexResult === "blocked") {
              folderPathByPageId.set(normalizeNotionPageId(childPage.id), null);
              blockedSubtreePageIds.add(normalizeNotionPageId(childPage.id));
            }
          }
          counts.skipped += 1;
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

function getStoredFolderPathForRemotePage(
  store: PullStore | undefined,
  pageId: string,
  normalizedRootPageId: string
): StoredFolderPathResult {
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

function getMigratedLegacyPullPath(storedFolderPath: string, expectedFolderPath: string): string {
  const normalizedStoredPath = normalizeVaultFolderPath(storedFolderPath);
  if (!normalizedStoredPath.startsWith(`${PULL_FOLDER}/`)) {
    return normalizedStoredPath;
  }
  const canonicalPath = normalizeVaultFolderPath(normalizedStoredPath.slice(PULL_FOLDER.length + 1));
  return canonicalPath === normalizeVaultFolderPath(expectedFolderPath) ? canonicalPath : normalizedStoredPath;
}

async function migrateLegacyPullFolderMappingAfterSafePath(
  store: PullStore,
  normalizedRootPageId: string,
  oldFolderPath: string,
  newFolderPath: string,
  pageId: string
): Promise<void> {
  const normalizedPageId = normalizeNotionPageId(pageId);
  const legacyPath = normalizeVaultFolderPath(oldFolderPath);
  const canonicalPath = normalizeVaultFolderPath(newFolderPath);
  if (!legacyPath.startsWith(`${PULL_FOLDER}/`) || !canonicalPath) {
    return;
  }

  const legacyKey = getFolderMappingKey(normalizedRootPageId, legacyPath);
  const canonicalKey = getFolderMappingKey(normalizedRootPageId, canonicalPath);
  const canonicalExisting = store.getFolderMapping(canonicalKey);
  if (canonicalExisting && normalizeNotionPageId(canonicalExisting.notionPageId) !== normalizedPageId) {
    return;
  }

  if (!canonicalExisting) {
    await store.saveFolderMapping(canonicalKey, {
      notionPageId: pageId,
      lastKnownPath: canonicalPath,
      rootPageId: normalizedRootPageId
    });
  }
  await store.removeFolderMapping(legacyKey);
}

async function getFolderMappingAmbiguity(
  store: PullStore | undefined,
  normalizedRootPageId: string,
  folderPath: string,
  pageId: string
): Promise<{ status: "ambiguous"; reason: string } | null> {
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
  const ambiguity = await getFolderMappingAmbiguity(store, normalizedRootPageId, normalizedFolderPath, pageId);
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

async function upsertContainerIndex(options: {
  app: App;
  baselineStore: SyncBaselineStore;
  folderPath: string;
  pageId: string;
  ownMarkdown: string;
  remoteSnapshot: RemoteSyncSnapshot;
  runId: string;
  counts: PullCounts;
  pageLog: string;
}): Promise<ContainerIndexResult> {
  const indexPath = normalizePath(`${options.folderPath}/${CONTAINER_INDEX_FILE}`);
  const existing = options.app.vault.getAbstractFileByPath(indexPath);
  if (existing && !(existing instanceof TFile)) {
    console.warn(`${options.pageLog} index create skipped: folder collision`, indexPath);
    options.counts.skipped += 1;
    return "blocked";
  }

  if (!existing) {
    await options.app.vault.create(indexPath, createFrontmatterForContainerIndex(options.pageId) + options.ownMarkdown);
    await advancePullBaselineAfterSuccess(options.app, options.baselineStore, options.pageId, options.remoteSnapshot, options.runId, "initialized");
    options.counts.created += 1;
    return "created";
  }

  const mapping = await getNotionPageMapping(options.app, existing);
  if (
    !mapping.pageId ||
    normalizeNotionPageId(mapping.pageId) !== normalizeNotionPageId(options.pageId) ||
    !(await isContainerIndexFile(options.app, existing))
  ) {
    console.warn(`${options.pageLog} index update skipped: target exists without matching mapping`, indexPath);
    options.counts.skipped += 1;
    return "blocked";
  }

  let baseline;
  try {
    baseline = options.baselineStore.getSyncBaseline(options.pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${options.runId}] load failed`, getErrorMessage(error));
    options.counts.failed += 1;
    return "blocked";
  }
  if (!baseline) {
    options.counts.skipped += 1;
    new Notice("LLM Wiki Sync: No sync baseline exists for this note. Initialize the baseline first.");
    return "skipped";
  }

  const localSnapshot = await getLocalSyncSnapshot(options.app, existing);
  const change = compareSnapshotsToBaseline(baseline, localSnapshot, options.remoteSnapshot);
  logConflictState(options.runId, change.localChanged, change.remoteChanged, change.state);
  if (change.state === "CLEAN") {
    options.counts.skipped += 1;
    return "clean";
  }
  if (change.state === "LOCAL_ONLY_CHANGED") {
    options.counts.skipped += 1;
    console.warn(`${options.pageLog} stale Pull protection: Obsidian changed since baseline`);
    return "skipped";
  }
  if (change.state === "CONFLICT") {
    options.counts.skipped += 1;
    return "skipped";
  }

  await options.app.vault.process(existing, (existingMarkdown) =>
    replaceMarkdownBodyPreservingFrontmatter(existingMarkdown, options.ownMarkdown, options.pageId)
  );
  await advancePullBaselineAfterSuccess(options.app, options.baselineStore, options.pageId, options.remoteSnapshot, options.runId, "advanced");
  options.counts.updated += 1;
  return "updated";
}

async function migrateMappedNoteToContainerIndex(options: {
  app: App;
  baselineStore: SyncBaselineStore;
  mappedFile: TFile;
  folderPath: string;
  pageId: string;
  ownMarkdown: string;
  remoteSnapshot: RemoteSyncSnapshot;
  normalizedRootPageId: string;
  store: PullStore | undefined;
  runId: string;
  counts: PullCounts;
  pageLog: string;
}): Promise<ContainerIndexResult> {
  const normalizedFolderPath = normalizeVaultFolderPath(options.folderPath);
  const indexPath = normalizePath(`${normalizedFolderPath}/${CONTAINER_INDEX_FILE}`);
  const existingIndex = options.app.vault.getAbstractFileByPath(indexPath);
  if (existingIndex) {
    console.warn(`${options.pageLog} mapped-note migration skipped: target exists`, indexPath);
    return "blocked";
  }

  let baseline;
  try {
    baseline = options.baselineStore.getSyncBaseline(options.pageId);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Baseline][${options.runId}] load failed`, getErrorMessage(error));
    options.counts.failed += 1;
    return "blocked";
  }
  if (!baseline) {
    return "blocked";
  }

  const localSnapshot = await getLocalSyncSnapshot(options.app, options.mappedFile);
  const change = compareSnapshotsToBaseline(baseline, localSnapshot, options.remoteSnapshot);
  logConflictState(options.runId, change.localChanged, change.remoteChanged, change.state);
  if (change.state === "LOCAL_ONLY_CHANGED" || change.state === "CONFLICT") {
    console.warn(`${options.pageLog} mapped-note migration skipped: local content changed`);
    return "blocked";
  }

  const folderResult = await ensureLocalFolder(options.app, normalizedFolderPath);
  if (folderResult === "created") options.counts.foldersCreated += 1;
  if (folderResult === "file_collision" || folderResult === "failed") {
    return "blocked";
  }

  const mappingAmbiguity = await getFolderMappingAmbiguity(options.store, options.normalizedRootPageId, normalizedFolderPath, options.pageId);
  if (mappingAmbiguity) {
    console.warn(`${options.pageLog} mapped-note migration skipped: ambiguous folder mapping`, mappingAmbiguity.reason);
    return "blocked";
  }

  const originalPath = options.mappedFile.path;
  const originalContent = await options.app.vault.read(options.mappedFile);
  let movedFile: TFile | null = null;
  let mappingPersisted = false;
  try {
    await options.app.fileManager.renameFile(options.mappedFile, indexPath);
    const moved = options.app.vault.getAbstractFileByPath(indexPath);
    if (!(moved instanceof TFile)) {
      throw new Error("Container index move verification failed");
    }
    movedFile = moved;
    await options.app.vault.process(movedFile, (existingMarkdown) =>
      replaceMarkdownBodyAndSetContainerRole(existingMarkdown, options.ownMarkdown, options.pageId)
    );
    await persistFolderMappingIfPossible(options.store, options.normalizedRootPageId, normalizedFolderPath, options.pageId);
    mappingPersisted = true;
    await advancePullBaselineAfterSuccess(options.app, options.baselineStore, options.pageId, options.remoteSnapshot, options.runId, "advanced");
    options.counts.updated += 1;
    return "updated";
  } catch (error) {
    console.error(`${options.pageLog} mapped-note migration rollback after failure`, getErrorMessage(error));
    if (movedFile) {
      try {
        await options.app.vault.process(movedFile, () => originalContent);
        if (!options.app.vault.getAbstractFileByPath(originalPath)) {
          await options.app.fileManager.renameFile(movedFile, originalPath);
        }
      } catch (rollbackError) {
        console.error(`${options.pageLog} mapped-note migration rollback failed`, getErrorMessage(rollbackError));
      }
    }
    if (mappingPersisted && options.store) {
      await options.store.removeFolderMapping(getFolderMappingKey(options.normalizedRootPageId, normalizedFolderPath));
    }
    return "blocked";
  }
}

function createFrontmatterForContainerIndex(pageId: string): string {
  return createFrontmatterForNotionPage(pageId).replace("---\n\n", `${NOTION_PAGE_ROLE_PROPERTY}: "${CONTAINER_INDEX_ROLE}"\n---\n\n`);
}

function replaceMarkdownBodyAndSetContainerRole(markdown: string, nextBody: string, pageId: string): string {
  const withBody = replaceMarkdownBodyPreservingFrontmatter(markdown, nextBody, pageId);
  const normalized = withBody.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return createFrontmatterForContainerIndex(pageId) + nextBody.replace(/\r\n/g, "\n");
  }

  const lines = match[1].split("\n");
  if (!lines.some((line) => /^notion_page_id:\s*/.test(line))) {
    lines.push(`${NOTION_PAGE_ID_PROPERTY}: "${pageId}"`);
  }
  const roleIndex = lines.findIndex((line) => /^notion_page_role:\s*/.test(line));
  if (roleIndex >= 0) {
    lines[roleIndex] = `${NOTION_PAGE_ROLE_PROPERTY}: "${CONTAINER_INDEX_ROLE}"`;
  } else {
    lines.push(`${NOTION_PAGE_ROLE_PROPERTY}: "${CONTAINER_INDEX_ROLE}"`);
  }
  return `---\n${lines.join("\n")}\n---\n${normalized.slice(match[0].length)}`;
}

async function isMappedContainerIndexFile(app: App, file: TFile, expectedIndexPath: string): Promise<boolean> {
  return normalizePath(file.path) === normalizePath(expectedIndexPath) && await isContainerIndexFile(app, file);
}

async function hasValidContainerIndex(app: App, folderPath: string, pageId: string): Promise<boolean> {
  const indexPath = normalizePath(`${folderPath}/${CONTAINER_INDEX_FILE}`);
  const existing = app.vault.getAbstractFileByPath(indexPath);
  if (!(existing instanceof TFile) || !(await isContainerIndexFile(app, existing))) {
    return false;
  }
  const mapping = await getNotionPageMapping(app, existing);
  return Boolean(mapping.pageId && normalizeNotionPageId(mapping.pageId) === normalizeNotionPageId(pageId));
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

async function migrateLegacyLeafNote(options: {
  app: App;
  file: TFile;
  pageId: string;
  parentFolderPath: string;
  rawTitle: string;
  runId: string;
}): Promise<"migrated" | "noop" | "collision" | "failed"> {
  const targetPath = getLegacyLeafCanonicalPath(options.parentFolderPath, options.rawTitle);
  if (!targetPath) {
    return "failed";
  }
  if (normalizePath(options.file.path) === normalizePath(targetPath)) {
    return "noop";
  }
  if (isPathCollision(options.app, targetPath, options.file)) {
    return "collision";
  }

  try {
    await options.app.fileManager.renameFile(options.file, targetPath);
  } catch (error) {
    console.error(`[LLM Wiki Sync][Rename][${options.runId}] legacy leaf migration failed`, getErrorMessage(error));
    return "failed";
  }

  const movedFile = options.app.vault.getAbstractFileByPath(targetPath);
  if (!(movedFile instanceof TFile)) {
    return "failed";
  }
  const mapping = await getNotionPageMapping(options.app, movedFile);
  return mapping.pageId && normalizeNotionPageId(mapping.pageId) === normalizeNotionPageId(options.pageId)
    ? "migrated"
    : "failed";
}

function getLegacyLeafCanonicalPath(parentFolderPath: string, rawTitle: string): string | null {
  const targetBaseName = sanitizeNotionTitleForFileName(rawTitle);
  if (!targetBaseName || !isSafeVisibleFileName(targetBaseName)) {
    return null;
  }
  return normalizePath(parentFolderPath ? `${parentFolderPath}/${targetBaseName}` : targetBaseName);
}

function isLegacyPullPath(filePath: string): boolean {
  return normalizePath(filePath).startsWith(`${PULL_FOLDER}/`);
}

function isPathCollision(app: App, targetPath: string, file: TFile): boolean {
  const existing = app.vault.getAbstractFileByPath(targetPath);
  return Boolean(existing && existing !== file);
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
