import { normalizePath, requestUrl, TFile, type App } from "obsidian";
import { sanitizeFileName } from "../utils/fileName";
import { createHash } from "crypto";

const NOTION_MEDIA_HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";
const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MEDIA_URL_PATH = /^\/[0-9a-f-]{36}\/([0-9a-f-]{36})\/([^/?#]+)$/i;

interface RemoteImage { source: string; caption: string; url: URL; identity: string; filename: string; token: string; }

export async function prepareObsidianMarkdownWithPulledImages(app: App, markdown: string, convertText: (text: string) => string): Promise<string> {
  const images = collectRemoteImages(markdown);
  if (images.length === 0) return convertText(markdown);

  const namespace = createPlaceholderNamespace(markdown);
  images.forEach((image, index) => { image.token = `${namespace}${index}__`; });

  const created: TFile[] = [];
  try {
    const replacements = new Map<string, string>();
    for (const image of images) {
      if (replacements.has(image.token)) continue;
      const attachment = await materializeImage(app, image, created);
      replacements.set(image.token, `![${image.caption}](${encodeVaultPath(attachment.path)})`);
    }
    let protectedMarkdown = markdown;
    for (const image of images) protectedMarkdown = protectedMarkdown.replace(image.source, image.token);
    let converted = convertText(protectedMarkdown);
    for (const [token, replacement] of replacements) converted = converted.split(token).join(replacement);
    return converted;
  } catch (error) {
    await Promise.all(created.map((file) => app.vault.delete(file).catch(() => undefined)));
    throw error;
  }
}

function collectRemoteImages(markdown: string): RemoteImage[] {
  const images: RemoteImage[] = [];
  const pattern = /!\[([^\]\n]*)\]\((https:\/\/[^\s()<>]+)\)/g;
  const scannable = maskLiteralRegions(markdown);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scannable)) !== null) {
    let url: URL;
    try { url = new URL(match[2]); } catch { throw new Error("image not supported on this path yet (Step 2 scope): malformed image URL"); }
    const path = MEDIA_URL_PATH.exec(url.pathname);
    const extension = path?.[2].split(".").pop()?.toLowerCase() ?? "";
    if (url.protocol !== "https:" || url.hostname !== NOTION_MEDIA_HOST || !path || !SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error("image not supported on this path yet (Step 2 scope): unsupported image URL or type");
    }
    images.push({ source: markdown.slice(match.index, match.index + match[0].length), caption: match[1], url, identity: path[1].toLowerCase(), filename: path[2], token: "" });
  }
  return images;
}
function maskLiteralRegions(markdown: string): string {
  const mask = (value: string): string => value.replace(/[^\n]/g, " ");
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})(?:[^`~]*)$/.exec(lines[index]);
    if (!opening) continue;
    const character = opening[1][0];
    const length = opening[1].length;
    let close = index + 1;
    while (close < lines.length && !new RegExp(`^ {0,3}${character}{${length},}[ \\t]*$`).test(lines[close])) close += 1;
    if (close >= lines.length) continue;
    for (let masked = index; masked <= close; masked += 1) lines[masked] = mask(lines[masked]);
    index = close;
  }
  const fencedMasked = lines.map((line, index) => {
    if (!/^(?: {4}|\t)/.test(line)) return line;
    const previous = index > 0 ? lines[index - 1] : "";
    return /^\s*(?:[-*+] |\d+\. |- \[[ xX]\] )/.test(previous) ? line : mask(line);
  }).join("\n");
  return fencedMasked
    .replace(/\$\$[\s\S]*?\$\$/g, mask)
    .replace(/`[^`\n]+`/g, mask);
}

async function materializeImage(app: App, image: RemoteImage, created: TFile[]): Promise<TFile> {
  const folder = attachmentFolder(app);
  await ensureFolder(app, folder);
  const response = await requestUrl({ url: image.url.toString(), method: "GET", throw: false });
  const contentType = response.headers["content-type"]?.split(";", 1)[0].toLowerCase();
  if (response.status < 200 || response.status >= 300 || response.arrayBuffer.byteLength === 0 || !isSupportedImageContentType(contentType)) {
    throw new Error("image not supported on this path yet (Step 2 scope): image download failed validation");
  }
  const path = await resolveAttachmentPath(app, folder, image, response.arrayBuffer);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  if (existing) throw new Error("image not supported on this path yet (Step 2 scope): attachment path collision");
  const file = await app.vault.createBinary(path, response.arrayBuffer);
  created.push(file);
  return file;
}

function attachmentFolder(app: App): string {
  void app;
  return "99_Attachments";
}
async function ensureFolder(app: App, path: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(path)) return;
  await app.vault.createFolder(path);
}
async function resolveAttachmentPath(app: App, folder: string, image: RemoteImage, bytes: ArrayBuffer): Promise<string> {
  const safe = sanitizeFileName(decodeURIComponent(image.filename)) || "notion-image";
  const dot = safe.lastIndexOf(".");
  const name = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  const preferred = normalizePath(`${folder}/${name}--${image.identity.slice(0, 8)}${ext}`);
  const existing = app.vault.getAbstractFileByPath(preferred);
  if (!(existing instanceof TFile)) return preferred;
  if (arrayBuffersEqual(await app.vault.readBinary(existing), bytes)) return preferred;
  const alternate = normalizePath(`${folder}/${name}--${image.identity.slice(0, 8)}-${shortHash(bytes)}${ext}`);
  const alternateExisting = app.vault.getAbstractFileByPath(alternate);
  if (!(alternateExisting instanceof TFile)) return alternate;
  if (arrayBuffersEqual(await app.vault.readBinary(alternateExisting), bytes)) return alternate;
  throw new Error("image not supported on this path yet (Step 2 scope): deterministic attachment collision");
}
function createPlaceholderNamespace(markdown: string): string {
  let counter = 0;
  let namespace = "";
  do { namespace = `@@LLM_WIKI_IMAGE_${Date.now().toString(36)}_${counter++}_`; } while (markdown.includes(namespace));
  return namespace;
}
function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}
function shortHash(bytes: ArrayBuffer): string { return createHash("sha256").update(new Uint8Array(bytes)).digest("hex").slice(0, 12); }
function isSupportedImageContentType(value: string | undefined): boolean { return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp"; }
function encodeVaultPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
