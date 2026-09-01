import { createHash } from "crypto";
import type { App, TFile } from "obsidian";
import type { NotionClient, NotionPageDetails, NotionPageMarkdown } from "../notionClient";
import { normalizeNotionPageId, normalizePulledMarkdown, removeNotionPageMappingFromMarkdown } from "./mapping";
import { extractNotionMediaStableId } from "./mediaIdentity";

export const SYNC_STATE_VERSION = 1;

export class TruncatedNotionMarkdownError extends Error {
  constructor(public readonly unknownBlockIds: string[] = []) {
    super("Notion Markdown was truncated and cannot be used for sync state.");
    this.name = "TruncatedNotionMarkdownError";
  }
}

export type SyncChangeState = "CLEAN" | "LOCAL_ONLY_CHANGED" | "REMOTE_ONLY_CHANGED" | "CONFLICT";

export interface LocalSyncSnapshot {
  title: string;
  body: string;
  fingerprint: string;
  mtime: number;
}

export interface RemoteSyncSnapshot {
  title: string;
  body: string;
  fingerprint: string;
  lastEditedTime: string;
}

export interface SyncBaseline {
  notionPageId: string;
  localFingerprint: string;
  remoteFingerprint: string;
  localTitle: string;
  remoteTitle: string;
  localMtime: number;
  remoteLastEditedTime: string;
  syncedAt: string;
  schemaVersion: 1;
  images: SyncBaselineImage[];
}

export interface SyncBaselineImage {
  localPath: string;
  contentHash: string;
  remoteStableId: string;
  caption: string;
}

export interface SyncBaselineStore {
  getSyncBaseline(pageId: string): SyncBaseline | null;
  saveSyncBaseline(pageId: string, baseline: SyncBaseline): Promise<void>;
}

export async function getLocalSyncSnapshot(app: App, file: TFile): Promise<LocalSyncSnapshot> {
  const markdown = await app.vault.read(file);
  const title = normalizeSyncTitle(file.basename);
  const body = normalizeSyncBody(removeNotionPageMappingFromMarkdown(markdown));
  return {
    title,
    body,
    fingerprint: fingerprintSyncState(title, body),
    mtime: file.stat.mtime
  };
}

export async function getRemoteSyncSnapshot(client: NotionClient, pageId: string): Promise<RemoteSyncSnapshot> {
  const details = await client.getPageDetails(pageId);
  const markdown = await client.retrievePageMarkdown(pageId);
  return getRemoteSyncSnapshotFromFetched(details, markdown);
}

export function getRemoteSyncSnapshotFromFetched(details: NotionPageDetails, markdown: NotionPageMarkdown): RemoteSyncSnapshot {
  if (markdown.truncated) {
    throw new TruncatedNotionMarkdownError(markdown.unknownBlockIds);
  }
  const title = normalizeSyncTitle(details.title);
  const body = normalizeSyncBody(normalizePulledMarkdown(markdown.markdown));
  return {
    title,
    body,
    fingerprint: fingerprintSyncState(title, body),
    lastEditedTime: details.lastEditedTime
  };
}

export function createSyncBaseline(pageId: string, local: LocalSyncSnapshot, remote: RemoteSyncSnapshot, images: SyncBaselineImage[] = []): SyncBaseline {
  return {
    notionPageId: pageId,
    localFingerprint: local.fingerprint,
    remoteFingerprint: remote.fingerprint,
    localTitle: local.title,
    remoteTitle: remote.title,
    localMtime: local.mtime,
    remoteLastEditedTime: remote.lastEditedTime,
    syncedAt: new Date().toISOString(),
    schemaVersion: SYNC_STATE_VERSION,
    images: images.map((image) => ({ ...image }))
  };
}

export function getSyncChangeState(localChanged: boolean, remoteChanged: boolean): SyncChangeState {
  if (!localChanged && !remoteChanged) return "CLEAN";
  if (localChanged && !remoteChanged) return "LOCAL_ONLY_CHANGED";
  if (!localChanged && remoteChanged) return "REMOTE_ONLY_CHANGED";
  return "CONFLICT";
}

export function compareSnapshotsToBaseline(
  baseline: SyncBaseline,
  local: LocalSyncSnapshot,
  remote: RemoteSyncSnapshot
): { localChanged: boolean; remoteChanged: boolean; state: SyncChangeState } {
  const localChanged = local.fingerprint !== baseline.localFingerprint;
  const remoteChanged = remote.fingerprint !== baseline.remoteFingerprint;
  return {
    localChanged,
    remoteChanged,
    state: getSyncChangeState(localChanged, remoteChanged)
  };
}

export function validateSyncBaseline(value: unknown, pageId: string): SyncBaseline | null {
  if (!value || typeof value !== "object") return null;
  const baseline = value as Partial<SyncBaseline>;
  if (
    baseline.schemaVersion !== SYNC_STATE_VERSION ||
    typeof baseline.notionPageId !== "string" ||
    normalizeNotionPageId(baseline.notionPageId) !== normalizeNotionPageId(pageId) ||
    typeof baseline.localFingerprint !== "string" ||
    typeof baseline.remoteFingerprint !== "string" ||
    typeof baseline.localTitle !== "string" ||
    typeof baseline.remoteTitle !== "string" ||
    typeof baseline.localMtime !== "number" ||
    typeof baseline.remoteLastEditedTime !== "string" ||
    typeof baseline.syncedAt !== "string"
  ) {
    return null;
  }
  const images = baseline.images === undefined ? [] : baseline.images;
  if (!Array.isArray(images) || !images.every((image) => isSyncBaselineImage(image))) return null;
  return { ...baseline, images } as SyncBaseline;
}

function isSyncBaselineImage(value: unknown): value is SyncBaselineImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<SyncBaselineImage>;
  return typeof image.localPath === "string" && typeof image.contentHash === "string" && typeof image.remoteStableId === "string" && typeof image.caption === "string";
}

export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

export function logConflictState(
  runId: string,
  localChanged: boolean,
  remoteChanged: boolean,
  state: SyncChangeState
): void {
  const prefix = `[LLM Wiki Sync][Conflict][${runId}]`;
  console.debug(`${prefix} localChanged:`, localChanged);
  console.debug(`${prefix} remoteChanged:`, remoteChanged);
  console.debug(`${prefix} state:`, state);
}

export function logBaselineNotAdvanced(runId: string, reason: string): void {
  console.warn(`[LLM Wiki Sync][Baseline][${runId}] NOT advanced because operation was partial`, reason);
}

export function normalizeSyncBody(body: string): string {
  const normalized = body.replace(/\r\n?/g, "\n");
  return normalizeEphemeralNotionMediaUrlsForFingerprint(normalized.replace(/\n+$/g, "") + "\n");
}

const KNOWN_NOTION_MEDIA_HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";

/** Snapshot-only normalization for the signed S3 URLs verified by the media probe. */
export function normalizeEphemeralNotionMediaUrlsForFingerprint(markdown: string): string {
  return markdown.replace(/!\[[^\]\n]*\]\((https:\/\/[^\s()<>]+)\)/g, (match, destination: string) => {
    let url: URL;
    try {
      url = new URL(destination);
    } catch {
      return match;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== KNOWN_NOTION_MEDIA_HOST ||
      !extractNotionMediaStableId(destination) ||
      !url.searchParams.has("X-Amz-Algorithm") ||
      !url.searchParams.has("X-Amz-Credential") ||
      !url.searchParams.has("X-Amz-Date") ||
      !url.searchParams.has("X-Amz-Expires") ||
      !url.searchParams.has("X-Amz-Signature")
    ) {
      return match;
    }
    return match.replace(destination, `${url.protocol}//${url.hostname}${url.pathname}${url.hash}`);
  });
}

function normalizeSyncTitle(title: string): string {
  return title.replace(/\r\n?/g, "\n");
}

function fingerprintSyncState(title: string, body: string): string {
  return createHash("sha256")
    .update("title\0", "utf8")
    .update(title, "utf8")
    .update("\0body\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}
