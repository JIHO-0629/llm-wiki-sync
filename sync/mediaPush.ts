import { createHash } from "crypto";
import { TFile, type App } from "obsidian";
import { NotionApiError, type CreatedNotionPage, NotionClient } from "../notionClient";
import type { SyncBaselineImage } from "./baseline";
import { assertSuccessfulConversion, prepareNotionMarkdownForWrite } from "./markdownConversion";
import { extractNotionMediaStableId } from "./mediaIdentity";

const IMAGE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\s)]+))\)|!\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
const REMOTE = /!\[([^\]\n]*)\]\((https:\/\/prod-files-secure\.s3\.us-west-2\.amazonaws\.com\/[^\s)]+)\)/g;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

interface LocalImage { source: string; caption: string; file: TFile; stableId: string | null; sentinel: string; uploadId?: string; contentHash?: string; }
interface RemoteImage { source: string; caption: string; stableId: string; }

export interface CreatedNotionPageWithImages extends CreatedNotionPage {
  imageIdentities: SyncBaselineImage[];
}

export interface MediaPushDryRunPlan {
  operation: "create-page-with-images" | "update-existing-images-unchanged" | "refuse-step-3b-2" | "no-local-images";
  images: Array<{ path: string; caption: string; contentType: string; bytes: number; sha256: string; stableId: string | null }>;
  imageSet: "not-applicable" | "unchanged" | "changed";
  hunks: Array<{ old: string; next: string }>;
  remoteMutationPlanned: false;
}

export function containsLocalImage(markdown: string): boolean { IMAGE.lastIndex = 0; return IMAGE.test(maskLiterals(markdown)); }

export async function createPageWithImages(options: { app: App; file: TFile; body: string; client: NotionClient; parentPageId: string; title: string; pushedAt: Date }): Promise<CreatedNotionPageWithImages> {
  const images = await collectLocalImages(options.app, options.file, options.body);
  await uploadAll(options.app, options.client, images);
  const tokenized = replaceSources(options.body, images, (image) => image.sentinel);
  const markdown = assertSuccessfulConversion(prepareNotionMarkdownForWrite(tokenized), "Obsidian → Notion");
  let page: CreatedNotionPage | null = null;
  try {
    page = await options.client.createChildPage({ parentPageId: options.parentPageId, title: options.title, markdown, pushedAt: options.pushedAt });
    await materializeSentinels(options.client, page.id, images);
    const remote = await verifyFinal(options.client, page.id, images);
    return { ...page, imageIdentities: toBaselineImages(images, remote) };
  } catch (error) {
    if (page) {
      try { await options.client.trashPage(page.id); }
      catch (cleanup) {
        console.error("[LLM Wiki Sync][Media Push] failed page cleanup", cleanup);
        const reason = cleanup instanceof Error ? cleanup.message : String(cleanup);
        throw new Error(`Media Push failed and left orphan plugin-created page ${page.id} (${page.url}): ${reason}`);
      }
    }
    throw error;
  }
}

export async function updateMappedPageTextWithUnchangedImages(options: { app: App; file: TFile; localBody: string; remoteBody: string; client: NotionClient; pageId: string; baselineImages?: SyncBaselineImage[] }): Promise<boolean> {
  const local = await collectLocalImages(options.app, options.file, options.localBody, options.baselineImages);
  if (!local.length) return false;
  const remote = collectRemoteImages(options.remoteBody);
  if (!sameInventory(local, remote)) throw new Error("Adding, removing, reordering, or changing captions of images on an existing Notion page is not supported yet (Step 3b-2).");
  const desiredSource = replaceSources(options.localBody, local, (_, index) => remote[index].source);
  const protectedText = replaceRemoteSources(desiredSource, remote, (_, index) => `LLMWIKIMEDIA${index}TOKEN`);
  const converted = assertSuccessfulConversion(prepareNotionMarkdownForWrite(protectedText), "Obsidian → Notion");
  const desired = remote.reduce((value, image, index) => value.split(`LLMWIKIMEDIA${index}TOKEN`).join(image.source), converted);
  const updates = imageSafeUpdates(options.remoteBody, desired, remote);
  if (!updates.length) return true;
  await options.client.updatePageMarkdownContent(options.pageId, updates);
  const final = await options.client.retrievePageMarkdown(options.pageId);
  if (final.truncated || /LLMWIKIMEDIA|99_Attachments\/|!\[\[/.test(final.markdown) || !sameInventory(local, collectRemoteImages(final.markdown))) throw new Error("Media text update verification failed; baseline was not advanced.");
  return true;
}

/** Read-only preflight for the Advanced dry-run command. */
export async function createMediaPushDryRun(options: { app: App; file: TFile; localBody: string; remoteBody?: string; baselineImages?: SyncBaselineImage[] }): Promise<MediaPushDryRunPlan> {
  const local = await collectLocalImages(options.app, options.file, options.localBody, options.baselineImages);
  const images = await Promise.all(local.map(async (image) => {
    const bytes = await options.app.vault.readBinary(image.file);
    return {
      path: image.file.path,
      caption: image.caption,
      contentType: TYPES[image.file.extension.toLowerCase()],
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      stableId: image.stableId
    };
  }));
  if (!local.length) return { operation: "no-local-images", images, imageSet: "not-applicable", hunks: [], remoteMutationPlanned: false };
  if (options.remoteBody === undefined) return { operation: "create-page-with-images", images, imageSet: "not-applicable", hunks: [], remoteMutationPlanned: false };

  const remote = collectRemoteImages(options.remoteBody);
  if (!sameInventory(local, remote)) return { operation: "refuse-step-3b-2", images, imageSet: "changed", hunks: [], remoteMutationPlanned: false };
  const desiredSource = replaceSources(options.localBody, local, (_, index) => remote[index].source);
  const protectedText = replaceRemoteSources(desiredSource, remote, (_, index) => `LLMWIKIMEDIA${index}TOKEN`);
  const converted = assertSuccessfulConversion(prepareNotionMarkdownForWrite(protectedText), "Obsidian → Notion");
  const desired = remote.reduce((value, image, index) => value.split(`LLMWIKIMEDIA${index}TOKEN`).join(image.source), converted);
  return { operation: "update-existing-images-unchanged", images, imageSet: "unchanged", hunks: imageSafeUpdates(options.remoteBody, desired, remote), remoteMutationPlanned: false };
}

async function collectLocalImages(app: App, note: TFile, markdown: string, baselineImages: SyncBaselineImage[] = []): Promise<LocalImage[]> {
  const scan = maskLiterals(markdown); IMAGE.lastIndex = 0; const images: LocalImage[] = []; let match: RegExpExecArray | null; let index = 0;
  const namespace = createSentinelNamespace(markdown);
  while ((match = IMAGE.exec(scan)) !== null) {
    if (isMarkdownTableCell(markdown, match.index)) throw new Error("Images inside Markdown tables are not supported yet (Step 3 scope).");
    if (match[5]) throw new Error("Image width or alias modifiers are not supported yet (Step 3 scope).");
    const wiki = match[4]; const destination = match[2] ?? match[3]; let file: TFile | null = null;
    if (wiki) file = app.metadataCache.getFirstLinkpathDest(wiki, note.path);
    else if (destination && !/^https:\/\//i.test(destination)) file = app.vault.getAbstractFileByPath(decodePath(destination)) as TFile | null;
    else throw new Error("External images are not supported by Step 3 image Push.");
    if (!file || !(file instanceof TFile)) throw new Error(`Referenced local image was not found: ${wiki ?? destination ?? "unknown"}`);
    const extension = file.extension.toLowerCase(); if (!TYPES[extension]) throw new Error(`Unsupported local image type: ${file.name}`);
    const bytes = await app.vault.readBinary(file); if (!bytes.byteLength) throw new Error(`Local image is empty: ${file.name}`);
    const mapped = baselineImages.find((image) => image.localPath === file.path);
    images.push({ source: markdown.slice(match.index, match.index + match[0].length), caption: match[1] ?? "", file, stableId: stableId(file.name) ?? mapped?.remoteStableId ?? null, sentinel: `${namespace}${index++}` });
  }
  return images;
}

async function uploadAll(app: App, client: NotionClient, images: LocalImage[]): Promise<void> {
  const limit = await retryPreparation(() => client.getWorkspaceFileUploadLimit()); const cache = new Map<string, string>();
  for (const image of images) {
    const bytes = await app.vault.readBinary(image.file); const hash = createHash("sha256").update(new Uint8Array(bytes)).digest("hex"); image.contentHash = hash;
    if (limit !== null && bytes.byteLength > limit) throw new Error(`Image exceeds workspace upload limit: ${image.file.name}`);
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(`Image requires multipart upload and is not supported yet: ${image.file.name}`);
    const reused = cache.get(hash); if (reused) { image.uploadId = reused; continue; }
    const upload = await retryPreparation(() => client.createSinglePartFileUpload(image.file.name, TYPES[image.file.extension.toLowerCase()]));
    const sent = await retryPreparation(() => client.sendFileUpload(upload, bytes, image.file.name, TYPES[image.file.extension.toLowerCase()]));
    const state = sent.status === "uploaded" ? sent : await retryPreparation(() => client.getFileUpload(sent.id));
    if (state.status !== "uploaded") throw new Error(`Image upload did not complete: ${image.file.name}`);
    image.uploadId = state.id; cache.set(hash, state.id);
  }
}
async function retryPreparation<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); } catch (error) {
      last = error;
      if (!(error instanceof NotionApiError) || (error.status !== 429 && error.status < 500)) throw error;
      if (attempt === 2) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw last;
}

async function materializeSentinels(client: NotionClient, pageId: string, images: LocalImage[]): Promise<void> {
  const blocks = await client.listBlockChildren(pageId);
  for (const image of images) {
    const anchor = blocks.find((block) => JSON.stringify(block.body).includes(image.sentinel));
    if (!anchor || !image.uploadId) throw new Error("Image sentinel did not survive Notion Markdown ingestion.");
    await client.appendImageBlock(pageId, image.uploadId, image.caption, anchor.id);
    await client.trashBlock(anchor.id);
  }
}

async function verifyFinal(client: NotionClient, pageId: string, images: LocalImage[]): Promise<RemoteImage[]> {
  const final = await client.retrievePageMarkdown(pageId);
  const remote = collectRemoteImages(final.markdown);
  if (final.truncated || /LLMWIKISENTINEL|99_Attachments\/|!\[\[/.test(final.markdown) || remote.length !== images.length || !remote.every((image, index) => image.caption === images[index].caption)) throw new Error("Final Notion media verification failed.");
  return remote;
}
function toBaselineImages(local: LocalImage[], remote: RemoteImage[]): SyncBaselineImage[] { return local.map((image, index) => { if (!image.contentHash) throw new Error("Image hash was missing after upload."); return { localPath: image.file.path, contentHash: image.contentHash, remoteStableId: remote[index].stableId, caption: image.caption }; }); }
function collectRemoteImages(markdown: string): RemoteImage[] { REMOTE.lastIndex = 0; const found: RemoteImage[] = []; let match: RegExpExecArray | null; while ((match = REMOTE.exec(markdown)) !== null) { const id = extractNotionMediaStableId(match[2]); if (!id) throw new Error("Remote image does not expose a stable media id."); found.push({ source: match[0], caption: match[1], stableId: id }); } return found; }
function sameInventory(local: LocalImage[], remote: RemoteImage[]): boolean { return local.length === remote.length && local.every((image, index) => Boolean(image.stableId) && image.stableId === remote[index].stableId && image.caption === remote[index].caption); }
function imageSafeUpdates(remote: string, desired: string, images: RemoteImage[]): Array<{ old: string; next: string }> { const oldParts = splitByImages(remote, images); const newParts = splitByImages(desired, images); if (oldParts.length !== newParts.length) throw new Error("Image-safe text diff failed."); const updates: Array<{ old: string; next: string }> = []; for (let i = 0; i < oldParts.length; i += 1) { if (oldParts[i] === newParts[i]) continue; if (!oldParts[i] || !newParts[i]) throw new Error("Text insertion or deletion adjacent to an image is not supported yet (Step 3b-1)."); updates.push({ old: oldParts[i], next: newParts[i] }); } return updates; }
function splitByImages(markdown: string, images: RemoteImage[]): string[] { let rest = markdown; const parts: string[] = []; for (const image of images) { const index = rest.indexOf(image.source); if (index < 0) throw new Error("Image-safe text diff lost a remote image."); parts.push(rest.slice(0, index)); rest = rest.slice(index + image.source.length); } parts.push(rest); return parts; }
function replaceSources(markdown: string, images: LocalImage[], value: (image: LocalImage, index: number) => string): string { let result = markdown; images.forEach((image, index) => { result = result.replace(image.source, value(image, index)); }); return result; }
function replaceRemoteSources(markdown: string, images: RemoteImage[], value: (image: RemoteImage, index: number) => string): string { let result = markdown; images.forEach((image, index) => { result = result.replace(image.source, value(image, index)); }); return result; }
function stableId(name: string): string | null { const match = name.match(/--([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.[^.]+$/i); return match?.[1].toLowerCase() ?? null; }
function decodePath(value: string): string { return value.split("/").map((part) => decodeURIComponent(part)).join("/"); }
function createSentinelNamespace(markdown: string): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `LLMWIKISENTINEL${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}X`;
    if (!markdown.includes(candidate)) return candidate;
  }
  throw new Error("Could not generate a collision-free media sentinel namespace.");
}

function isMarkdownTableCell(markdown: string, offset: number): boolean {
  const lineStart = markdown.lastIndexOf("\n", offset) + 1;
  const lineEnd = markdown.indexOf("\n", offset);
  const line = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
  if (!line.includes("|")) return false;
  const previousStart = markdown.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
  const previous = markdown.slice(previousStart, lineStart - 1);
  const nextStart = lineEnd < 0 ? markdown.length : lineEnd + 1;
  const nextEnd = markdown.indexOf("\n", nextStart);
  const next = markdown.slice(nextStart, nextEnd < 0 ? markdown.length : nextEnd);
  const divider = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  return divider.test(previous) || divider.test(next) || /^\s*\|/.test(line);
}

function maskLiterals(markdown: string): string {
  const masked = markdown.split("");
  const lines = markdown.matchAll(/.*(?:\n|$)/g);
  let fence: { char: string; length: number; start: number } | null = null;
  let offset = 0;
  for (const entry of lines) {
    const line = entry[0]; if (!line) continue;
    const text = line.replace(/\n$/, "");
    if (!fence) {
      const open = text.match(/^ {0,3}(`{3,}|~{3,})[^`~]*$/);
      if (open) fence = { char: open[1][0], length: open[1].length, start: offset };
    } else {
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(text);
      if (close) { for (let i = fence.start; i < offset + line.length; i += 1) if (masked[i] !== "\n") masked[i] = " "; fence = null; }
    }
    offset += line.length;
  }
  return masked.join("").replace(/`[^`\n]+`/g, (value) => " ".repeat(value.length));
}

export const __mediaPushTest = { maskLiterals, isMarkdownTableCell, createSentinelNamespace, stableId, collectRemoteImages, imageSafeUpdates, splitByImages };
