import { App, Notice, base64ToArrayBuffer, requestUrl, type RequestUrlResponse } from "obsidian";
import { NOTION_VERSION, extractNotionPageId } from "../notionClient";

const LABEL = "[LLM Wiki Sync][Media Probe]";
const REPORT = "media-capability-probe.md";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_FILENAME = "llm-wiki-sync-probe-1x1.png";
const PNG_CONTENT_TYPE = "image/png";

interface Step { name: string; request: string; status: number | null; body: string; error?: string }
interface Context {
  steps: Step[]; uploadSizeLimit: number | null; fileUploadId: string | null; sendUrl: string | null;
  disposablePageId: string | null; disposablePageUrl: string | null; attachedBlockId: string | null;
  markdownFirst: string | null; markdownSecond: string | null; blockFirst: string | null; blockSecond: string | null;
  declaredContentType: string | null; observedContentType: string | null;
}

function createContext(): Context {
  return { steps: [], uploadSizeLimit: null, fileUploadId: null, sendUrl: null, disposablePageId: null,
    disposablePageUrl: null, attachedBlockId: null, markdownFirst: null, markdownSecond: null,
    blockFirst: null, blockSecond: null, declaredContentType: null, observedContentType: null };
}

function rawResponse(response: RequestUrlResponse): string {
  if (response.json !== undefined && response.json !== null) {
    try { return JSON.stringify(response.json, null, 2); } catch (error) { console.debug(`${LABEL} JSON stringify failed`, error); }
  }
  return typeof response.text === "string" ? response.text : "";
}
function record(context: Context, step: Step): void { context.steps.push(step); console.debug(`${LABEL} ${step.name}`, step.status, step.error ?? ""); }
function success(status: number | null): boolean { return status !== null && status >= 200 && status < 300; }
function readString(source: unknown, key: string): string | null {
  return source && typeof source === "object" && typeof (source as Record<string, unknown>)[key] === "string"
    ? (source as Record<string, string>)[key] : null;
}
function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  const value = source && typeof source === "object" ? (source as Record<string, unknown>)[key] : null;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function uploadSizeLimit(source: unknown): number | null {
  const bot = readRecord(source, "bot"); const limits = bot ? readRecord(bot, "workspace_limits") : null;
  const value = limits?.max_file_upload_size_in_bytes;
  return typeof value === "number" ? value : null;
}

async function callJson(context: Context, name: string, options: { url: string; method: string; token: string; body?: string }): Promise<{ status: number | null; json: unknown; raw: string }> {
  const request = `${options.method} ${options.url}`;
  try {
    const response = await requestUrl({ url: options.url, method: options.method, body: options.body, throw: false,
      headers: { Authorization: `Bearer ${options.token}`, "Notion-Version": NOTION_VERSION, Accept: "application/json", "Content-Type": "application/json" } });
    const raw = rawResponse(response); record(context, { name, request, status: response.status, body: raw });
    return { status: response.status, json: response.json, raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(context, { name, request, status: null, body: "", error: message }); return { status: null, json: null, raw: "" };
  }
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged.buffer;
}

function buildMultipartBody(bytes: Uint8Array, boundary: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${PNG_FILENAME}"\r\n` +
    `Content-Type: ${PNG_CONTENT_TYPE}\r\n\r\n`
  );
  const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
  return concatBytes([header, bytes, footer]);
}

async function sendFile(context: Context, token: string, sendUrl: string, bytes: Uint8Array): Promise<number | null> {
  const boundary = `----LlmWikiSyncProbe${Date.now().toString(16)}`;
  const request = `POST ${sendUrl} (requestUrl multipart, ${bytes.length} bytes)`;
  try {
    const response = await requestUrl({
      url: sendUrl,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body: buildMultipartBody(bytes, boundary),
      throw: false
    });
    record(context, { name: "C. Send file bytes", request, status: response.status, body: rawResponse(response) });
    return response.status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(context, { name: "C. Send file bytes", request, status: null, body: "", error: message });
    return null;
  }
}

function fence(value: string | null, language = "json"): string { return value ? `\`\`\`${language}\n${value}\n\`\`\`\n` : "_(not captured)_\n"; }
function urls(raw: string | null): string[] { return raw ? Array.from(raw.matchAll(/"url"\s*:\s*"([^"]+)"/g), match => match[1]) : []; }
function expiries(raw: string | null): string[] { return raw ? Array.from(raw.matchAll(/"expiry_time"\s*:\s*"([^"]+)"/g), match => match[1]) : []; }
function buildReport(context: Context, abortReason: string | null): string {
  const firstUrls = urls(context.blockFirst); const secondUrls = urls(context.blockSecond);
  const lines = [abortReason ? "# LLM Wiki Sync — Media Capability Probe Report (ABORTED)" : "# LLM Wiki Sync — Media Capability Probe Report", "",
    ...(abortReason ? [`> Aborted: ${abortReason}`, ""] : []), `- Generated: ${new Date().toISOString()}`, `- Notion-Version header: \`${NOTION_VERSION}\``,
    `- Workspace upload size limit: ${context.uploadSizeLimit ?? "not reported"}`, `- File Upload id: ${context.fileUploadId ?? "not created"}`,
    `- Disposable page url: ${context.disposablePageUrl ?? "not created"}`, `- Attached block id: ${context.attachedBlockId ?? "not attached"}`,
    `- Declared content_type: ${context.declaredContentType ?? "unknown"}`, `- Observed content_type: ${context.observedContentType ?? "unknown"}`, "",
    "## Automated observations", "", context.observedContentType === PNG_CONTENT_TYPE ? "- Content-type verification: PASS." : "- Content-type verification: FAIL or UNKNOWN.",
    `- Media URLs in first block response: ${firstUrls.length}`, ...firstUrls.map((url, index) => `  - [${index}] ${url}`),
    `- Media URLs in second block response: ${secondUrls.length}`, ...secondUrls.map((url, index) => `  - [${index}] ${url}`),
    firstUrls.length && secondUrls.length ? (firstUrls[0] === secondUrls[0] ? "- Two reads returned identical URL strings." : "- Two reads returned different URL strings.") : "",
    expiries(context.blockFirst).length ? `- expiry_time: ${expiries(context.blockFirst).join(", ")}` : "- No expiry_time found.", "",
    "## Raw step log", "", ...context.steps.flatMap(step => [`### ${step.name}`, "", `- Request: \`${step.request}\``, `- HTTP status: ${step.status ?? "transport error"}`,
      ...(step.error ? [`- Error: ${step.error}`] : []), "", fence(step.body)]), "## First Markdown read (raw)", "", fence(context.markdownFirst, "markdown"),
    "## Second Markdown read (raw)", "", fence(context.markdownSecond, "markdown"), "## Cleanup", "",
    `The disposable page remains for inspection. Delete it manually: ${context.disposablePageUrl ?? "(page was not created)"}`, ""];
  return lines.filter((line, index, values) => line !== "" || index === 0 || values[index - 1] !== "").join("\n");
}
async function finish(app: App, pluginDir: string, context: Context, abortReason: string | null): Promise<void> {
  try { await app.vault.adapter.write(`${pluginDir}/${REPORT}`, buildReport(context, abortReason));
    new Notice(abortReason ? `LLM Wiki Sync: Probe aborted. Report written to ${REPORT}` : `LLM Wiki Sync: Probe complete. Report written to ${REPORT}`);
  } catch (error) { console.error(`${LABEL} report write failed`, error); new Notice("LLM Wiki Sync: Probe finished but the report could not be written. See console."); }
}

export interface MediaCapabilityProbeOptions { app: App; token: string; rootPageUrl: string; pluginDir: string }
export async function runMediaCapabilityProbe(options: MediaCapabilityProbeOptions): Promise<void> {
  const token = options.token.trim(); const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!token) { new Notice("LLM Wiki Sync: Notion token is missing."); return; }
  if (!rootPageId) { new Notice("LLM Wiki Sync: Configure a valid Notion root page URL first."); return; }
  new Notice("LLM Wiki Sync: Media capability probe started.");
  const context = createContext();
  const me = await callJson(context, "A. Retrieve bot user", { url: "https://api.notion.com/v1/users/me", method: "GET", token }); context.uploadSizeLimit = uploadSizeLimit(me.json);
  const created = await callJson(context, "B. Create File Upload", { url: "https://api.notion.com/v1/file_uploads", method: "POST", token,
    body: JSON.stringify({ mode: "single_part", filename: PNG_FILENAME, content_type: PNG_CONTENT_TYPE }) });
  context.fileUploadId = readString(created.json, "id"); context.declaredContentType = readString(created.json, "content_type");
  context.sendUrl = readString(created.json, "upload_url") ?? (context.fileUploadId ? `https://api.notion.com/v1/file_uploads/${context.fileUploadId}/send` : null);
  if (!context.fileUploadId || !context.sendUrl) { await finish(options.app, options.pluginDir, context, "File Upload could not be created."); return; }
  if (!success(await sendFile(context, token, context.sendUrl, new Uint8Array(base64ToArrayBuffer(PNG_BASE64))))) { await finish(options.app, options.pluginDir, context, "File Upload send failed."); return; }
  const upload = await callJson(context, "D. Retrieve File Upload state", { url: `https://api.notion.com/v1/file_uploads/${context.fileUploadId}`, method: "GET", token });
  const status = readString(upload.json, "status"); context.observedContentType = readString(upload.json, "content_type");
  if (status !== "uploaded") { record(context, { name: "D. Upload state check", request: "(local assertion)", status: null, body: "", error: `Expected uploaded, observed ${status ?? "unknown"}.` }); await finish(options.app, options.pluginDir, context, "File Upload did not reach uploaded state."); return; }
  if (context.observedContentType !== PNG_CONTENT_TYPE) { record(context, { name: "D. Content-type verification", request: "(local assertion)", status: null, body: "", error: `Expected ${PNG_CONTENT_TYPE}, observed ${context.observedContentType ?? "not reported"}.` }); await finish(options.app, options.pluginDir, context, "Uploaded content_type did not verify as image/png."); return; }
  const page = await callJson(context, "E. Create disposable page", { url: "https://api.notion.com/v1/pages", method: "POST", token, body: JSON.stringify({ parent: { type: "page_id", page_id: rootPageId }, properties: { title: { title: [{ type: "text", text: { content: `LLM Wiki Sync media probe ${new Date().toISOString()}` } }] } } }) });
  context.disposablePageId = readString(page.json, "id"); context.disposablePageUrl = readString(page.json, "url");
  if (!context.disposablePageId) { await finish(options.app, options.pluginDir, context, "Disposable page could not be created."); return; }
  const attached = await callJson(context, "F. Attach image block", { url: `https://api.notion.com/v1/blocks/${context.disposablePageId}/children`, method: "PATCH", token, body: JSON.stringify({ children: [{ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: context.fileUploadId }, caption: [{ type: "text", text: { content: "llm-wiki-sync probe caption {w=640}" } }] } }] }) });
  const results = attached.json && typeof attached.json === "object" ? (attached.json as Record<string, unknown>).results : null;
  if (Array.isArray(results) && results.length) context.attachedBlockId = readString(results[0], "id");
  if (!context.attachedBlockId) { await finish(options.app, options.pluginDir, context, "Image block was not attached."); return; }
  const block1 = await callJson(context, "G. Retrieve block (read 1)", { url: `https://api.notion.com/v1/blocks/${context.attachedBlockId}`, method: "GET", token }); context.blockFirst = block1.raw;
  const markdown1 = await callJson(context, "H. Retrieve page Markdown (read 1)", { url: `https://api.notion.com/v1/pages/${context.disposablePageId}/markdown`, method: "GET", token }); context.markdownFirst = markdown1.raw;
  const block2 = await callJson(context, "I-1. Retrieve block (read 2)", { url: `https://api.notion.com/v1/blocks/${context.attachedBlockId}`, method: "GET", token }); context.blockSecond = block2.raw;
  const markdown2 = await callJson(context, "I-2. Retrieve page Markdown (read 2)", { url: `https://api.notion.com/v1/pages/${context.disposablePageId}/markdown`, method: "GET", token }); context.markdownSecond = markdown2.raw;
  await finish(options.app, options.pluginDir, context, null);
}
