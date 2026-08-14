import { requestUrl, type RequestUrlResponse } from "obsidian";

export const NOTION_VERSION = "2026-03-11";
export const NOTION_CREATE_PAGE_ENDPOINT = "https://api.notion.com/v1/pages";

export interface NotionClientOptions {
  token: string;
}

export interface CreateChildPageOptions {
  parentPageId: string;
  title: string;
  children: unknown[];
  pushedAt: Date;
}

export interface CreatedNotionPage {
  id: string;
  url: string;
  title: string;
  parentPageId: string;
  createdTime: string;
  response: RequestUrlResponse;
  body: Record<string, unknown>;
}

export interface NotionChildPage {
  id: string;
  title: string;
}

export interface NotionPageMarkdown {
  id: string;
  markdown: string;
  truncated: boolean;
  unknownBlockIds: string[];
  response: RequestUrlResponse;
  body: Record<string, unknown>;
}

export interface NotionPageDetails {
  id: string;
  object: string;
  title: string;
  parentType: string;
  lastEditedTime: string;
  response: RequestUrlResponse;
}

export class NotionApiError extends Error {
  status: number;
  body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.body = body;
  }
}

export class NotionClient {
  private token: string;

  constructor(options: NotionClientOptions) {
    this.token = options.token;
  }

  async getPage(pageId: string): Promise<RequestUrlResponse> {
    return this.request(
      {
        url: `https://api.notion.com/v1/pages/${pageId}`,
        method: "GET"
      },
      "Root check"
    );
  }

  async getPageDetails(pageId: string): Promise<NotionPageDetails> {
    const response = await this.getPage(pageId);
    return parsePageDetails(response, pageId);
  }

  async listRootChildPages(rootPageId: string): Promise<NotionChildPage[]> {
    console.debug("[LLM Wiki Sync][Pull] Root page id:", rootPageId);

    const childPages: NotionChildPage[] = [];
    let nextCursor: string | null = null;

    do {
      const searchParams = new URLSearchParams({ page_size: "100" });
      if (nextCursor) {
        searchParams.set("start_cursor", nextCursor);
      }

      const response = await this.request(
        {
          url: `https://api.notion.com/v1/blocks/${rootPageId}/children?${searchParams.toString()}`,
          method: "GET"
        },
        "Pull"
      );

      const body = response.json as Record<string, unknown>;
      const results = Array.isArray(body.results) ? body.results : [];

      for (const result of results) {
        if (!result || typeof result !== "object") {
          continue;
        }

        const block = result as Record<string, unknown>;
        if (block.type !== "child_page") {
          continue;
        }

        const childPage = block.child_page && typeof block.child_page === "object"
          ? block.child_page as Record<string, unknown>
          : null;
        const title = childPage && typeof childPage.title === "string" ? childPage.title : "Untitled";
        const id = typeof block.id === "string" ? block.id : "";

        if (!id) {
          continue;
        }

        console.debug("[LLM Wiki Sync][Pull] Found child page:");
        console.debug("[LLM Wiki Sync][Pull] title:", title);
        console.debug("[LLM Wiki Sync][Pull] page id:", id);
        childPages.push({ id, title });
      }

      const hasMore = body.has_more === true;
      nextCursor = hasMore && typeof body.next_cursor === "string" ? body.next_cursor : null;
    } while (nextCursor);

    return childPages;
  }

  async retrievePageMarkdown(pageId: string): Promise<NotionPageMarkdown> {
    const response = await this.request(
      {
        url: `https://api.notion.com/v1/pages/${pageId}/markdown`,
        method: "GET"
      },
      "Pull Markdown"
    );

    return parsePageMarkdownResponse(response, pageId);
  }

  async updatePageMarkdown(pageId: string, markdown: string): Promise<RequestUrlResponse> {
    console.debug("[LLM Wiki Sync][Push] Updating Notion page:", pageId);
    const response = await this.request(
      {
        url: `https://api.notion.com/v1/pages/${pageId}/markdown`,
        method: "PATCH",
        body: JSON.stringify({
          type: "replace_content",
          replace_content: {
            new_str: markdown
          }
        })
      },
      "Push Update"
    );
    console.debug("[LLM Wiki Sync][Push] Update success");
    return response;
  }

  async updatePageTitle(pageId: string, title: string): Promise<NotionPageDetails> {
    const response = await this.request(
      {
        url: `https://api.notion.com/v1/pages/${pageId}`,
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            title: {
              title: [{ type: "text", text: { content: title } }]
            }
          }
        })
      },
      "Push Title Update"
    );
    return parsePageDetails(response, pageId);
  }

  async createChildPage(options: CreateChildPageOptions): Promise<CreatedNotionPage> {
    const body = {
      parent: {
        type: "page_id",
        page_id: options.parentPageId
      },
      properties: {
        title: {
          title: [
            {
              type: "text",
              text: {
                content: options.title
              }
            }
          ]
        }
      },
      children: options.children
    };

    console.debug("[LLM Wiki Sync][Create page] HTTP method", "POST");
    console.debug("[LLM Wiki Sync][Create page] endpoint", NOTION_CREATE_PAGE_ENDPOINT);
    console.debug("[LLM Wiki Sync][Create page] parent page id", options.parentPageId);
    console.debug("[LLM Wiki Sync][Create page] note title", options.title);

    const response = await this.request(
      {
        url: NOTION_CREATE_PAGE_ENDPOINT,
        method: "POST",
        body: JSON.stringify(body)
      },
      "Create page"
    );

    return parseCreatedPageResponse(response, options.parentPageId, options.title, options.pushedAt);
  }

  private async request(
    options: { url: string; method: string; body?: string },
    label: "Root check" | "Create page" | "Pull" | "Pull Markdown" | "Push Update" | "Push Title Update"
  ): Promise<RequestUrlResponse> {
    console.debug(`[LLM Wiki Sync][${label}] HTTP method`, options.method);
    console.debug(`[LLM Wiki Sync][${label}] endpoint`, options.url);

    const response = await requestUrl({
      url: options.url,
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: options.body,
      throw: false
    });

    console.debug(`[LLM Wiki Sync][${label}] HTTP status`, response.status);
    if (label !== "Pull Markdown") {
      console.debug(`[LLM Wiki Sync][${label}] response body`, safeJsonForLog(response.json, response.text));
    }

    if (response.status < 200 || response.status >= 300) {
      throw new NotionApiError(response.status, getNotionErrorReason(response), response.json ?? response.text);
    }

    return response;
  }
}

export function extractNotionPageId(input: string): string | null {
  const normalized = input.trim();
  if (!normalized) {
    return null;
  }

  const compact = normalized.replace(/-/g, "");
  const pageIdMatch = compact.match(/[0-9a-fA-F]{32}/);
  if (!pageIdMatch) {
    return null;
  }

  const pageId = pageIdMatch[0].toLowerCase();
  return [
    pageId.slice(0, 8),
    pageId.slice(8, 12),
    pageId.slice(12, 16),
    pageId.slice(16, 20),
    pageId.slice(20)
  ].join("-");
}

export function getNotionErrorReason(response: { json?: unknown; text?: string }): string {
  if (response.json && typeof response.json === "object") {
    const body = response.json as { message?: unknown; code?: unknown };
    const message = typeof body.message === "string" ? body.message : "";
    const code = typeof body.code === "string" ? body.code : "";

    if (message && code) {
      return `${message} (${code})`;
    }

    if (message) {
      return message;
    }
  }

  return response.text || "No error details returned by Notion";
}

function parsePageMarkdownResponse(response: RequestUrlResponse, pageId: string): NotionPageMarkdown {
  if (!response.json || typeof response.json !== "object") {
    throw new NotionApiError(response.status, "Notion markdown response did not include a JSON body", response.text);
  }

  const body = response.json as Record<string, unknown>;
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  const truncated = body.truncated === true;
  const unknownBlockIds = Array.isArray(body.unknown_block_ids)
    ? body.unknown_block_ids.filter((value): value is string => typeof value === "string")
    : [];

  console.debug("[LLM Wiki Sync][Pull Markdown] page id:", pageId);
  console.debug("[LLM Wiki Sync][Pull Markdown] truncated:", truncated);
  console.debug("[LLM Wiki Sync][Pull Markdown] unknown_block_ids:", unknownBlockIds);

  return {
    id: typeof body.id === "string" ? body.id : pageId,
    markdown,
    truncated,
    unknownBlockIds,
    response,
    body
  };
}

function parsePageDetails(response: RequestUrlResponse, expectedPageId: string): NotionPageDetails {
  if (!response.json || typeof response.json !== "object") {
    throw new NotionApiError(response.status, "Notion page response did not include a JSON body", response.text);
  }

  const body = response.json as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  const object = typeof body.object === "string" ? body.object : "";
  const lastEditedTime = typeof body.last_edited_time === "string" ? body.last_edited_time : "";
  const parent = body.parent && typeof body.parent === "object" ? body.parent as Record<string, unknown> : null;
  const parentType = parent && typeof parent.type === "string" ? parent.type : "";
  const properties = body.properties && typeof body.properties === "object" ? body.properties as Record<string, unknown> : {};
  const titleProperty = properties.title && typeof properties.title === "object" ? properties.title as Record<string, unknown> : null;
  const titleItems = titleProperty && Array.isArray(titleProperty.title) ? titleProperty.title : [];
  const title = titleItems.map((item) => {
    if (!item || typeof item !== "object") return "";
    const plainText = (item as Record<string, unknown>).plain_text;
    return typeof plainText === "string" ? plainText : "";
  }).join("");

  if (object !== "page" || !id || normalizePageId(id) !== normalizePageId(expectedPageId)) {
    throw new NotionApiError(response.status, "Notion page response did not match the mapped page", body);
  }

  return { id, object, title, parentType, lastEditedTime, response };
}

function parseCreatedPageResponse(
  response: RequestUrlResponse,
  expectedParentPageId: string,
  title: string,
  pushedAt: Date
): CreatedNotionPage {
  if (response.status !== 200 && response.status !== 201) {
    throw new NotionApiError(response.status, `Notion create page returned unexpected success status: ${response.status}`, response.json ?? response.text);
  }

  if (!response.json || typeof response.json !== "object") {
    throw new NotionApiError(response.status, "Notion create page response did not include a JSON body", response.text);
  }

  const body = response.json as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  const url = typeof body.url === "string" ? body.url : "";
  const object = typeof body.object === "string" ? body.object : "";
  const createdTime = typeof body.created_time === "string" ? body.created_time : "";
  const parent = body.parent && typeof body.parent === "object" ? body.parent as Record<string, unknown> : null;
  const parentType = parent && typeof parent.type === "string" ? parent.type : "";
  const actualParentPageId = parent && typeof parent.page_id === "string" ? parent.page_id : "";

  console.debug("[LLM Wiki Sync][Create page] created page id", id || "<missing>");
  console.debug("[LLM Wiki Sync][Create page] created page url", url || "<missing>");

  if (object !== "page") {
    throw new NotionApiError(response.status, `Notion create page response object was not page: ${object || "missing"}`, body);
  }

  if (!id || !url) {
    throw new NotionApiError(response.status, "Notion create page response was missing created page id or url", body);
  }

  if (normalizePageId(id) === normalizePageId(expectedParentPageId)) {
    throw new NotionApiError(response.status, "Notion create page response returned the root page id instead of a new child page id", body);
  }

  if (parentType !== "page_id" || normalizePageId(actualParentPageId) !== normalizePageId(expectedParentPageId)) {
    throw new NotionApiError(
      response.status,
      `Notion created page parent mismatch: expected ${expectedParentPageId}, got ${actualParentPageId || parentType || "missing"}`,
      body
    );
  }

  if (!createdTime || !isCreatedDuringPush(createdTime, pushedAt)) {
    throw new NotionApiError(response.status, `Notion created_time does not match this push: ${createdTime || "missing"}`, body);
  }

  return {
    id,
    url,
    title,
    parentPageId: actualParentPageId,
    createdTime,
    response,
    body
  };
}

function isCreatedDuringPush(createdTime: string, pushedAt: Date): boolean {
  const createdAtMs = Date.parse(createdTime);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }

  const pushStartedMs = pushedAt.getTime();
  const nowMs = Date.now();
  const earlyToleranceMs = 60_000;
  const lateToleranceMs = 60_000;

  return createdAtMs >= pushStartedMs - earlyToleranceMs && createdAtMs <= nowMs + lateToleranceMs;
}

function normalizePageId(pageId: string): string {
  return pageId.replace(/-/g, "").toLowerCase();
}

function safeJsonForLog(json: unknown, text: string): unknown {
  if (json !== undefined && json !== null) {
    return json;
  }

  return text;
}
