import {
  NotionClient,
  type CreateChildPageOptions,
  type CreatedNotionPage,
  type NotionChildPage,
  type NotionPageDetails
} from "../notionClient";
import type { RequestUrlResponse } from "obsidian";
import { normalizeNotionPageId } from "./bulkPush";

export interface SyncRunCacheStats {
  pageDetailsHits: number;
  pageDetailsMisses: number;
  childPagesHits: number;
  childPagesMisses: number;
}

export interface SyncRunCache {
  pageDetails: Map<string, NotionPageDetails>;
  childPages: Map<string, NotionChildPage[]>;
  resolvedFolderParents: Map<string, string>;
  stats: SyncRunCacheStats;
}

export function createSyncRunCache(): SyncRunCache {
  return {
    pageDetails: new Map(),
    childPages: new Map(),
    resolvedFolderParents: new Map(),
    stats: {
      pageDetailsHits: 0,
      pageDetailsMisses: 0,
      childPagesHits: 0,
      childPagesMisses: 0
    }
  };
}

export class CachedNotionClient extends NotionClient {
  private readonly cache: SyncRunCache;

  constructor(options: { token: string; cache: SyncRunCache }) {
    super({ token: options.token });
    this.cache = options.cache;
  }

  override async getPageDetails(pageId: string): Promise<NotionPageDetails> {
    const key = normalizeNotionPageId(pageId);
    const cached = this.cache.pageDetails.get(key);
    if (cached) {
      this.cache.stats.pageDetailsHits += 1;
      return cached;
    }

    this.cache.stats.pageDetailsMisses += 1;
    const details = await super.getPageDetails(pageId);
    this.cache.pageDetails.set(key, details);
    return details;
  }

  override async listChildPages(parentPageId: string, label: "Pull" | "Hierarchy" = "Hierarchy"): Promise<NotionChildPage[]> {
    const key = normalizeNotionPageId(parentPageId);
    const cached = this.cache.childPages.get(key);
    if (cached) {
      this.cache.stats.childPagesHits += 1;
      return cached;
    }

    this.cache.stats.childPagesMisses += 1;
    const children = await super.listChildPages(parentPageId, label);
    this.cache.childPages.set(key, children);
    return children;
  }

  override async createChildPage(options: CreateChildPageOptions): Promise<CreatedNotionPage> {
    const created = await super.createChildPage(options);
    this.invalidateChildPages(options.parentPageId);
    this.cache.pageDetails.set(normalizeNotionPageId(created.id), {
      id: created.id,
      object: "page",
      title: created.title,
      parentType: "page_id",
      parentPageId: created.parentPageId,
      lastEditedTime: created.createdTime,
      response: created.response
    });
    return created;
  }

  override async movePageToPage(pageId: string, parentPageId: string): Promise<NotionPageDetails> {
    let previousParentPageId: string | null = null;
    try {
      const current = await this.getPageDetails(pageId);
      previousParentPageId = current.parentPageId;
    } catch {
      previousParentPageId = null;
    }

    const details = await super.movePageToPage(pageId, parentPageId);
    this.cache.pageDetails.set(normalizeNotionPageId(pageId), details);
    this.invalidateChildPages(parentPageId);
    if (previousParentPageId) {
      this.invalidateChildPages(previousParentPageId);
    }
    return details;
  }

  override async updatePageTitle(pageId: string, title: string): Promise<NotionPageDetails> {
    const details = await super.updatePageTitle(pageId, title);
    this.cache.pageDetails.set(normalizeNotionPageId(pageId), details);
    if (details.parentPageId) {
      this.invalidateChildPages(details.parentPageId);
    }
    return details;
  }

  override async updatePageMarkdown(pageId: string, markdown: string): Promise<RequestUrlResponse> {
    const response = await super.updatePageMarkdown(pageId, markdown);
    this.cache.pageDetails.delete(normalizeNotionPageId(pageId));
    return response;
  }

  invalidateChildPages(parentPageId: string): void {
    this.cache.childPages.delete(normalizeNotionPageId(parentPageId));
  }
}
