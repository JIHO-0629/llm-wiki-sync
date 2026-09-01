import { NotionClient, type NotionChildPage, type NotionClientOptions, type NotionPageDetails } from "../notionClient";

export interface SyncRunCache {
  pageDetails: Map<string, NotionPageDetails>;
  childPages: Map<string, NotionChildPage[]>;
}

export function createSyncRunCache(): SyncRunCache {
  return {
    pageDetails: new Map(),
    childPages: new Map()
  };
}

export class CachedNotionClient extends NotionClient {
  private readonly cache: SyncRunCache;

  constructor(options: NotionClientOptions & { cache: SyncRunCache }) {
    super(options);
    this.cache = options.cache;
  }

  override async getPageDetails(pageId: string): Promise<NotionPageDetails> {
    const cached = this.cache.pageDetails.get(pageId);
    if (cached) {
      return cached;
    }
    const details = await super.getPageDetails(pageId);
    this.cache.pageDetails.set(pageId, details);
    return details;
  }

  override async listChildPages(parentPageId: string, label: "Pull" | "Hierarchy" = "Pull"): Promise<NotionChildPage[]> {
    const cached = this.cache.childPages.get(parentPageId);
    if (cached) {
      return cached;
    }
    const pages = await super.listChildPages(parentPageId, label);
    this.cache.childPages.set(parentPageId, pages);
    return pages;
  }

  override async movePageToPage(pageId: string, parentPageId: string): Promise<NotionPageDetails> {
    this.cache.pageDetails.delete(pageId);
    this.cache.childPages.clear();
    return super.movePageToPage(pageId, parentPageId);
  }
}
