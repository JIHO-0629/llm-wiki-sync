import { App, Notice, base64ToArrayBuffer, requestUrl, type RequestUrlResponse } from "obsidian";
import { NOTION_VERSION, extractNotionPageId } from "../notionClient";

const LABEL = "[LLM Wiki Sync][Media Recovery Probe]";
const REPORT = "media-recovery-probe.md";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_FILENAME = "llm-wiki-sync-recovery-probe-1x1.png";
const PNG_CONTENT_TYPE = "image/png";
const TERMINAL_UPLOAD_STATES = new Set(["uploaded", "failed", "expired"]);

interface Step { name: string; route: "shared" | "A" | "B"; request: string; status: number | null; body: string; error?: string; }
interface RouteResult { id: string | null; status: string | null; contentType: string | null; attachedBlockId: string | null; elapsedMs: number | null; calls: number; }
interface Context {
  steps: Step[];
  pageId: string | null;
  pageUrl: string | null;
  sourceUploadId: string | null;
  sourceBlockId: string | null;
  sourceBlock: string | null;
  sourceUrl: string | null;
  sourceCaption: string | null;
  sourcePosition: number | null;
  workspaceLimit: number | null;
  finalMarkdown: string | null;
  routeA: RouteResult;
  routeB: RouteResult;
}

export interface MediaRecoveryProbeOptions { app: App; token: string; rootPageUrl: string; pluginDir: string; }

function emptyRoute(): RouteResult { return { id: null, status: null, contentType: null, attachedBlockId: null, elapsedMs: null, calls: 0 }; }
function createContext(): Context {
  return { steps: [], pageId: null, pageUrl: null, sourceUploadId: null, sourceBlockId: null, sourceBlock: null, sourceUrl: null, sourceCaption: null, sourcePosition: null, workspaceLimit: null, finalMarkdown: null, routeA: emptyRoute(), routeB: emptyRoute() };
}
function routeResult(context: Context, route: "A" | "B"): RouteResult { return route === "A" ? context.routeA : context.routeB; }
function raw(response: RequestUrlResponse): string {
  if (response.json !== undefined && response.json !== null) {
    try { return JSON.stringify(response.json, null, 2); } catch (error) { console.debug(`${LABEL} JSON stringify failed`, error); }
  }
  return response.text ?? "";
}
function record(context: Context, step: Step): void {
  context.steps.push(step);
  if (step.route === "A" || step.route === "B") routeResult(context, step.route).calls += 1;
  console.debug(`${LABEL} ${step.name}`, step.status, step.error ?? "");
}
function readString(value: unknown, key: string): string | null {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string" ? (value as Record<string, string>)[key] : null;
}
function readNumber(value: unknown, key: string): number | null {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "number" ? (value as Record<string, number>)[key] : null;
}
function success(status: number | null): boolean { return status !== null && status >= 200 && status < 300; }

async function callJson(context: Context, name: string, route: Step["route"], options: { url: string; method: string; token: string; body?: string }): Promise<{ status: number | null; json: unknown; body: string }> {
  const request = `${options.method} ${options.url}`;
  try {
    const response = await requestUrl({ url: options.url, method: options.method, body: options.body, throw: false, headers: { Authorization: `Bearer ${options.token}`, "Notion-Version": NOTION_VERSION, Accept: "application/json", "Content-Type": "application/json" } });
    const body = raw(response);
    record(context, { name, route, request, status: response.status, body });
    return { status: response.status, json: response.json, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(context, { name, route, request, status: null, body: "", error: message });
    return { status: null, json: null, body: "" };
  }
}
function concatBytes(parts: Uint8Array[]): ArrayBuffer {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Uint8Array(size); let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  return merged.buffer;
}
function multipart(bytes: Uint8Array, boundary: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return concatBytes([encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${PNG_FILENAME}"\r\nContent-Type: ${PNG_CONTENT_TYPE}\r\n\r\n`), bytes, encoder.encode(`\r\n--${boundary}--\r\n`)]);
}
async function sendBytes(context: Context, route: Step["route"], token: string, sendUrl: string, bytes: Uint8Array): Promise<number | null> {
  const boundary = `----LlmWikiSyncRecoveryProbe${Date.now().toString(16)}`;
  try {
    const response = await requestUrl({ url: sendUrl, method: "POST", throw: false, headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, Accept: "application/json", "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: multipart(bytes, boundary) });
    record(context, { name: "Send file bytes", route, request: `POST ${sendUrl} (requestUrl multipart, ${bytes.length} bytes)`, status: response.status, body: raw(response) });
    return response.status;
  } catch (error) {
    record(context, { name: "Send file bytes", route, request: `POST ${sendUrl}`, status: null, body: "", error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
async function waitForUpload(context: Context, route: Step["route"], token: string, id: string): Promise<{ status: string | null; contentType: string | null }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await callJson(context, `Retrieve File Upload state (${attempt + 1})`, route, { url: `https://api.notion.com/v1/file_uploads/${id}`, method: "GET", token });
    const status = readString(state.json, "status");
    const contentType = readString(state.json, "content_type");
    if (status && TERMINAL_UPLOAD_STATES.has(status)) return { status, contentType };
    await new Promise<void>(resolve => window.setTimeout(resolve, 1000));
  }
  return { status: "poll_timeout", contentType: null };
}
async function attach(context: Context, route: "A" | "B" | "shared", token: string, pageId: string, uploadId: string, caption: string): Promise<string | null> {
  const response = await callJson(context, "Attach image block", route, { url: `https://api.notion.com/v1/blocks/${pageId}/children`, method: "PATCH", token, body: JSON.stringify({ children: [{ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: uploadId }, caption: caption ? [{ type: "text", text: { content: caption } }] : [] } }] }) });
  const results = response.json && typeof response.json === "object" ? (response.json as Record<string, unknown>).results : null;
  return Array.isArray(results) && results.length ? readString(results[0], "id") : null;
}
function extractSourceImage(value: unknown): { url: string | null; caption: string | null } {
  if (!value || typeof value !== "object") return { url: null, caption: null };
  const image = (value as Record<string, unknown>).image;
  if (!image || typeof image !== "object") return { url: null, caption: null };
  const record = image as Record<string, unknown>;
  const file = record.file;
  const url = file && typeof file === "object" ? readString(file, "url") : null;
  const caption = Array.isArray(record.caption) && record.caption[0] && typeof record.caption[0] === "object"
    ? readString((record.caption[0] as Record<string, unknown>).text, "content") : null;
  return { url, caption };
}
function markdownFence(value: string | null): string { return value ? `\`\`\`json\n${value}\n\`\`\`` : "_(not captured)_"; }
function routeAnswer(route: RouteResult): string { return route.status === "uploaded" && route.attachedBlockId ? "PASS" : `NOT PROVEN (${route.status ?? "not created"})`; }
function report(context: Context, abort: string | null): string {
  const lines = [
    abort ? "# LLM Wiki Sync - Media Recovery Probe Report (ABORTED)" : "# LLM Wiki Sync - Media Recovery Probe Report",
    "", `- Generated: ${new Date().toISOString()}`, `- Notion-Version header: \`${NOTION_VERSION}\``, `- Disposable page: ${context.pageUrl ?? "not created"}`, `- Workspace per-file limit reported: ${context.workspaceLimit ?? "not reported"} bytes`, `- Source image block: ${context.sourceBlockId ?? "not attached"}`, `- Source image position: ${context.sourcePosition ?? "not captured"}`,
    "", "## Answers", "", `- Route A (Notion external_url import): ${routeAnswer(context.routeA)}`, `- Route B (download then single_part upload): ${routeAnswer(context.routeB)}`, `- Re-uploaded upload attachable as Notion image: ${Boolean(context.routeA.attachedBlockId || context.routeB.attachedBlockId)}`, `- Route A cost: ${context.routeA.calls} calls, ${context.routeA.elapsedMs ?? "not completed"} ms`, `- Route B cost: ${context.routeB.calls} calls, ${context.routeB.elapsedMs ?? "not completed"} ms`, "- Size-limit observation: both routes run in the same workspace; the returned upload states and raw content_length fields below are retained. This 69-byte probe cannot prove quota accounting beyond the documented per-file limit.",
    "", "## Route results", "", `### Route A\n- File Upload id: ${context.routeA.id ?? "not created"}\n- Final status: ${context.routeA.status ?? "not observed"}\n- Content-Type: ${context.routeA.contentType ?? "not observed"}\n- Attached block: ${context.routeA.attachedBlockId ?? "not attached"}`, "", `### Route B\n- File Upload id: ${context.routeB.id ?? "not created"}\n- Final status: ${context.routeB.status ?? "not observed"}\n- Content-Type: ${context.routeB.contentType ?? "not observed"}\n- Attached block: ${context.routeB.attachedBlockId ?? "not attached"}`,
    "", "## Captured source block", "", markdownFence(context.sourceBlock), "", "## Final page Markdown", "", markdownFence(context.finalMarkdown), "", "## Raw step log", "",
    ...context.steps.flatMap(step => [`### ${step.route} - ${step.name}`, "", `- Request: \`${step.request}\``, `- HTTP status: ${step.status ?? "transport error"}`, ...(step.error ? [`- Error: ${step.error}`] : []), "", markdownFence(step.body), ""]),
    "## Cleanup", "", `The disposable page remains for inspection. Delete it manually: ${context.pageUrl ?? "(page was not created)"}`, ""
  ];
  return lines.join("\n");
}
async function finish(options: MediaRecoveryProbeOptions, context: Context, abort: string | null): Promise<void> {
  try { await options.app.vault.adapter.write(`${options.pluginDir}/${REPORT}`, report(context, abort)); new Notice(abort ? `LLM Wiki Sync: Media recovery probe aborted. Report written to ${REPORT}` : `LLM Wiki Sync: Media recovery probe complete. Report written to ${REPORT}`); }
  catch (error) { console.error(`${LABEL} report write failed`, error); new Notice("LLM Wiki Sync: Media recovery probe finished but the report could not be written. See console."); }
}

export async function runMediaRecoveryProbe(options: MediaRecoveryProbeOptions): Promise<void> {
  const token = options.token.trim(); const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!token) { new Notice("LLM Wiki Sync: Notion token is missing."); return; }
  if (!rootPageId) { new Notice("LLM Wiki Sync: Configure a valid Notion root page URL first."); return; }
  new Notice("LLM Wiki Sync: Media recovery probe started.");
  const context = createContext(); const png = new Uint8Array(base64ToArrayBuffer(PNG_BASE64));
  const bot = await callJson(context, "Retrieve bot user", "shared", { url: "https://api.notion.com/v1/users/me", method: "GET", token });
  const botRecord = bot.json && typeof bot.json === "object" ? bot.json as Record<string, unknown> : null;
  const limits = botRecord?.bot && typeof botRecord.bot === "object" ? (botRecord.bot as Record<string, unknown>).workspace_limits : null;
  context.workspaceLimit = readNumber(limits, "max_file_upload_size_in_bytes");
  const source = await callJson(context, "Create source File Upload", "shared", { url: "https://api.notion.com/v1/file_uploads", method: "POST", token, body: JSON.stringify({ mode: "single_part", filename: PNG_FILENAME, content_type: PNG_CONTENT_TYPE }) });
  context.sourceUploadId = readString(source.json, "id"); const sourceSendUrl = readString(source.json, "upload_url") ?? (context.sourceUploadId ? `https://api.notion.com/v1/file_uploads/${context.sourceUploadId}/send` : null);
  if (!context.sourceUploadId || !sourceSendUrl || !success(await sendBytes(context, "shared", token, sourceSendUrl, png))) { await finish(options, context, "Source image upload could not be prepared."); return; }
  const sourceState = await waitForUpload(context, "shared", token, context.sourceUploadId);
  if (sourceState.status !== "uploaded") { await finish(options, context, "Source image upload did not reach uploaded state."); return; }
  const page = await callJson(context, "Create disposable page", "shared", { url: "https://api.notion.com/v1/pages", method: "POST", token, body: JSON.stringify({ parent: { type: "page_id", page_id: rootPageId }, properties: { title: { title: [{ type: "text", text: { content: `LLM Wiki Sync recovery probe ${new Date().toISOString()}` } }] } }, markdown: "Recovery probe source image follows.\n" }) });
  context.pageId = readString(page.json, "id"); context.pageUrl = readString(page.json, "url");
  if (!context.pageId) { await finish(options, context, "Disposable page could not be created."); return; }
  context.sourceBlockId = await attach(context, "shared", token, context.pageId, context.sourceUploadId, "recovery probe source");
  if (!context.sourceBlockId) { await finish(options, context, "Source image could not be attached."); return; }
  const sourceBlock = await callJson(context, "Retrieve source image block", "shared", { url: `https://api.notion.com/v1/blocks/${context.sourceBlockId}`, method: "GET", token });
  context.sourceBlock = sourceBlock.body; const sourceImage = extractSourceImage(sourceBlock.json); context.sourceUrl = sourceImage.url; context.sourceCaption = sourceImage.caption;
  const children = await callJson(context, "List disposable page children", "shared", { url: `https://api.notion.com/v1/blocks/${context.pageId}/children?page_size=100`, method: "GET", token });
  const childResults = children.json && typeof children.json === "object" ? (children.json as Record<string, unknown>).results : null;
  context.sourcePosition = Array.isArray(childResults) ? childResults.findIndex(item => readString(item, "id") === context.sourceBlockId) : null;
  if (!context.sourceUrl) { await finish(options, context, "Source image did not expose a signed URL."); return; }

  const startA = Date.now();
  const imported = await callJson(context, "Create external_url File Upload", "A", { url: "https://api.notion.com/v1/file_uploads", method: "POST", token, body: JSON.stringify({ mode: "external_url", external_url: context.sourceUrl, filename: PNG_FILENAME }) });
  context.routeA.id = readString(imported.json, "id");
  if (context.routeA.id) {
    const state = await waitForUpload(context, "A", token, context.routeA.id); context.routeA.status = state.status; context.routeA.contentType = state.contentType;
    if (state.status === "uploaded") context.routeA.attachedBlockId = await attach(context, "A", token, context.pageId, context.routeA.id, "recovery probe route A");
  }
  context.routeA.elapsedMs = Date.now() - startA;

  const startB = Date.now();
  let downloaded: ArrayBuffer | null = null;
  try {
    const response = await requestUrl({ url: context.sourceUrl, method: "GET", throw: false });
    record(context, { name: "Download source signed URL", route: "B", request: `GET ${context.sourceUrl}`, status: response.status, body: `content-type: ${response.headers["content-type"] ?? ""}\nbytes: ${response.arrayBuffer.byteLength}` });
    if (success(response.status) && response.arrayBuffer.byteLength > 0) downloaded = response.arrayBuffer;
  } catch (error) { record(context, { name: "Download source signed URL", route: "B", request: `GET ${context.sourceUrl}`, status: null, body: "", error: error instanceof Error ? error.message : String(error) }); }
  if (downloaded) {
    const created = await callJson(context, "Create single_part File Upload", "B", { url: "https://api.notion.com/v1/file_uploads", method: "POST", token, body: JSON.stringify({ mode: "single_part", filename: PNG_FILENAME, content_type: PNG_CONTENT_TYPE }) });
    context.routeB.id = readString(created.json, "id"); const sendUrl = readString(created.json, "upload_url") ?? (context.routeB.id ? `https://api.notion.com/v1/file_uploads/${context.routeB.id}/send` : null);
    if (context.routeB.id && sendUrl && success(await sendBytes(context, "B", token, sendUrl, new Uint8Array(downloaded)))) {
      const state = await waitForUpload(context, "B", token, context.routeB.id); context.routeB.status = state.status; context.routeB.contentType = state.contentType;
      if (state.status === "uploaded") context.routeB.attachedBlockId = await attach(context, "B", token, context.pageId, context.routeB.id, "recovery probe route B");
    }
  }
  context.routeB.elapsedMs = Date.now() - startB;
  const final = await callJson(context, "Retrieve final page Markdown", "shared", { url: `https://api.notion.com/v1/pages/${context.pageId}/markdown`, method: "GET", token }); context.finalMarkdown = final.body;
  await finish(options, context, null);
}
