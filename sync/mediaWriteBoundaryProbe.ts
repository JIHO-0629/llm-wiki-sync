import { App, Notice, base64ToArrayBuffer, requestUrl, type RequestUrlResponse } from "obsidian";
import { NOTION_VERSION, extractNotionPageId } from "../notionClient";

const LABEL = "[LLM Wiki Sync][Media Write Boundary Probe]";
const REPORT = "media-write-boundary-probe.md";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_FILENAME = "llm-wiki-sync-write-boundary-probe-1x1.png";
const PNG_CONTENT_TYPE = "image/png";
const ORIGINAL_SENTINEL = "LLM_WIKI_SYNC_WRITE_BOUNDARY_ORIGINAL";
const UPDATED_SENTINEL = "LLM_WIKI_SYNC_WRITE_BOUNDARY_UPDATED";

interface Step {
  name: string;
  request: string;
  status: number | null;
  body: string;
  error?: string;
}

interface Context {
  steps: Step[];
  fileUploadId: string | null;
  sendUrl: string | null;
  disposablePageId: string | null;
  disposablePageUrl: string | null;
  attachedBlockId: string | null;
  markdownBeforeUpdate: string | null;
  markdownAfterUpdate: string | null;
  blockAfterUpdate: string | null;
}

export interface MediaWriteBoundaryProbeOptions {
  app: App;
  token: string;
  rootPageUrl: string;
  pluginDir: string;
}

function createContext(): Context {
  return {
    steps: [],
    fileUploadId: null,
    sendUrl: null,
    disposablePageId: null,
    disposablePageUrl: null,
    attachedBlockId: null,
    markdownBeforeUpdate: null,
    markdownAfterUpdate: null,
    blockAfterUpdate: null
  };
}

function rawResponse(response: RequestUrlResponse): string {
  if (response.json !== undefined && response.json !== null) {
    try {
      return JSON.stringify(response.json, null, 2);
    } catch (error) {
      console.debug(`${LABEL} JSON stringify failed`, error);
    }
  }
  return typeof response.text === "string" ? response.text : "";
}

function record(context: Context, step: Step): void {
  context.steps.push(step);
  console.debug(`${LABEL} ${step.name}`, step.status, step.error ?? "");
}

function success(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function readString(source: unknown, key: string): string | null {
  return source && typeof source === "object" && typeof (source as Record<string, unknown>)[key] === "string"
    ? (source as Record<string, string>)[key]
    : null;
}

async function callJson(context: Context, name: string, options: { url: string; method: string; token: string; body?: string }): Promise<{ status: number | null; json: unknown; raw: string }> {
  const request = `${options.method} ${options.url}`;
  try {
    const response = await requestUrl({
      url: options.url,
      method: options.method,
      body: options.body,
      throw: false,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });
    const raw = rawResponse(response);
    record(context, { name, request, status: response.status, body: raw });
    return { status: response.status, json: response.json, raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(context, { name, request, status: null, body: "", error: message });
    return { status: null, json: null, raw: "" };
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
  const boundary = `----LlmWikiSyncWriteBoundaryProbe${Date.now().toString(16)}`;
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

function fence(value: string | null, language = "json"): string {
  return value ? `\`\`\`${language}\n${value}\n\`\`\`\n` : "_(not captured)_\n";
}

function buildReport(context: Context, abortReason: string | null): string {
  const before = context.markdownBeforeUpdate ?? "";
  const after = context.markdownAfterUpdate ?? "";
  const blockAfterUpdate = context.blockAfterUpdate ?? "";
  const textUpdated = after.includes(UPDATED_SENTINEL) && !after.includes(ORIGINAL_SENTINEL);
  const imageStillPresent = Boolean(context.attachedBlockId && blockAfterUpdate.includes(context.attachedBlockId));
  const signedUrlStillPresent = /https:\/\/prod-files-secure\.s3\.us-west-2\.amazonaws\.com\/[^)\s"]+/.test(after);
  const verdict = !abortReason && textUpdated && imageStillPresent
    ? "PASS: update_content changed text while the attached image block remained retrievable."
    : abortReason
      ? `ABORTED: ${abortReason}`
      : "REVIEW REQUIRED: update_content did not clearly preserve the image boundary.";

  const lines = [
    abortReason ? "# LLM Wiki Sync — Media Write Boundary Probe Report (ABORTED)" : "# LLM Wiki Sync — Media Write Boundary Probe Report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Notion-Version header: \`${NOTION_VERSION}\``,
    `- Disposable page url: ${context.disposablePageUrl ?? "not created"}`,
    `- Attached block id: ${context.attachedBlockId ?? "not attached"}`,
    `- Verdict: ${verdict}`,
    "",
    "## Automated observations",
    "",
    `- Targeted Markdown update type tested: \`update_content\``,
    `- Original sentinel present before update: ${before.includes(ORIGINAL_SENTINEL)}`,
    `- Updated sentinel present after update: ${after.includes(UPDATED_SENTINEL)}`,
    `- Original sentinel removed after update: ${!after.includes(ORIGINAL_SENTINEL)}`,
    `- Attached image block remained retrievable after update: ${imageStillPresent}`,
    `- Markdown after update contains signed Notion media URL: ${signedUrlStillPresent}`,
    "",
    "## Raw step log",
    "",
    ...context.steps.flatMap(step => [
      `### ${step.name}`,
      "",
      `- Request: \`${step.request}\``,
      `- HTTP status: ${step.status ?? "transport error"}`,
      ...(step.error ? [`- Error: ${step.error}`] : []),
      "",
      fence(step.body)
    ]),
    "## Markdown before update",
    "",
    fence(context.markdownBeforeUpdate, "markdown"),
    "## Markdown after update",
    "",
    fence(context.markdownAfterUpdate, "markdown"),
    "## Block after update",
    "",
    fence(context.blockAfterUpdate),
    "## Cleanup",
    "",
    `The disposable page remains for inspection. Delete it manually: ${context.disposablePageUrl ?? "(page was not created)"}`,
    ""
  ];

  return lines.filter((line, index, values) => line !== "" || index === 0 || values[index - 1] !== "").join("\n");
}

async function finish(app: App, pluginDir: string, context: Context, abortReason: string | null): Promise<void> {
  try {
    await app.vault.adapter.write(`${pluginDir}/${REPORT}`, buildReport(context, abortReason));
    new Notice(abortReason ? `LLM Wiki Sync: Write boundary probe aborted. Report written to ${REPORT}` : `LLM Wiki Sync: Write boundary probe complete. Report written to ${REPORT}`);
  } catch (error) {
    console.error(`${LABEL} report write failed`, error);
    new Notice("LLM Wiki Sync: Write boundary probe finished but the report could not be written. See console.");
  }
}

export async function runMediaWriteBoundaryProbe(options: MediaWriteBoundaryProbeOptions): Promise<void> {
  const token = options.token.trim();
  const rootPageId = extractNotionPageId(options.rootPageUrl);
  if (!token) {
    new Notice("LLM Wiki Sync: Notion token is missing.");
    return;
  }
  if (!rootPageId) {
    new Notice("LLM Wiki Sync: Configure a valid Notion root page URL first.");
    return;
  }

  new Notice("LLM Wiki Sync: Media write boundary probe started.");
  const context = createContext();
  const created = await callJson(context, "A. Create File Upload", {
    url: "https://api.notion.com/v1/file_uploads",
    method: "POST",
    token,
    body: JSON.stringify({ mode: "single_part", filename: PNG_FILENAME, content_type: PNG_CONTENT_TYPE })
  });
  context.fileUploadId = readString(created.json, "id");
  context.sendUrl = readString(created.json, "upload_url") ?? (context.fileUploadId ? `https://api.notion.com/v1/file_uploads/${context.fileUploadId}/send` : null);
  if (!context.fileUploadId || !context.sendUrl) {
    await finish(options.app, options.pluginDir, context, "File Upload could not be created.");
    return;
  }

  if (!success(await sendFile(context, token, context.sendUrl, new Uint8Array(base64ToArrayBuffer(PNG_BASE64))))) {
    await finish(options.app, options.pluginDir, context, "File Upload send failed.");
    return;
  }

  const upload = await callJson(context, "D. Retrieve File Upload state", {
    url: `https://api.notion.com/v1/file_uploads/${context.fileUploadId}`,
    method: "GET",
    token
  });
  if (readString(upload.json, "status") !== "uploaded") {
    await finish(options.app, options.pluginDir, context, "File Upload did not reach uploaded state.");
    return;
  }

  const page = await callJson(context, "E. Create disposable page with text", {
    url: "https://api.notion.com/v1/pages",
    method: "POST",
    token,
    body: JSON.stringify({
      parent: { type: "page_id", page_id: rootPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: `LLM Wiki Sync write boundary probe ${new Date().toISOString()}` } }]
        }
      },
      markdown: `# LLM Wiki Sync write boundary probe\n\n${ORIGINAL_SENTINEL}\n`
    })
  });
  context.disposablePageId = readString(page.json, "id");
  context.disposablePageUrl = readString(page.json, "url");
  if (!context.disposablePageId) {
    await finish(options.app, options.pluginDir, context, "Disposable page could not be created.");
    return;
  }

  const attached = await callJson(context, "F. Attach image block", {
    url: `https://api.notion.com/v1/blocks/${context.disposablePageId}/children`,
    method: "PATCH",
    token,
    body: JSON.stringify({
      children: [{
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: context.fileUploadId },
          caption: [{ type: "text", text: { content: "llm-wiki-sync write boundary probe image" } }]
        }
      }]
    })
  });
  const results = attached.json && typeof attached.json === "object" ? (attached.json as Record<string, unknown>).results : null;
  if (Array.isArray(results) && results.length) {
    context.attachedBlockId = readString(results[0], "id");
  }
  if (!context.attachedBlockId) {
    await finish(options.app, options.pluginDir, context, "Image block was not attached.");
    return;
  }

  const before = await callJson(context, "G. Retrieve Markdown before update", {
    url: `https://api.notion.com/v1/pages/${context.disposablePageId}/markdown`,
    method: "GET",
    token
  });
  context.markdownBeforeUpdate = before.raw;

  await callJson(context, "H. Targeted text update via update_content", {
    url: `https://api.notion.com/v1/pages/${context.disposablePageId}/markdown`,
    method: "PATCH",
    token,
    body: JSON.stringify({
      type: "update_content",
      update_content: {
        content_updates: [{
          old_str: ORIGINAL_SENTINEL,
          new_str: UPDATED_SENTINEL
        }]
      }
    })
  });

  const after = await callJson(context, "I. Retrieve Markdown after update", {
    url: `https://api.notion.com/v1/pages/${context.disposablePageId}/markdown`,
    method: "GET",
    token
  });
  context.markdownAfterUpdate = after.raw;

  const block = await callJson(context, "J. Retrieve image block after update", {
    url: `https://api.notion.com/v1/blocks/${context.attachedBlockId}`,
    method: "GET",
    token
  });
  context.blockAfterUpdate = block.raw;

  await finish(options.app, options.pluginDir, context, null);
}
