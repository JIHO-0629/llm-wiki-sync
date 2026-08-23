import type { NotionClient } from "../notionClient";
import { normalizeNotionPageId } from "./mapping";

export const REVIEW_FOLDER_TITLE = "LLM Wiki Sync Review";

export interface RemoteTreePage {
  id: string;
  title: string;
  parentPageId: string;
  path: string;
  hasChildren: boolean;
  directChildren: Array<{ id: string; title: string }>;
}

export async function scanRemoteTree(client: NotionClient, rootPageId: string): Promise<RemoteTreePage[]> {
  const pages: RemoteTreePage[] = [];
  await scanRemoteChildren(client, rootPageId, "", pages, new Set([normalizeNotionPageId(rootPageId)]));
  return pages;
}

async function scanRemoteChildren(
  client: NotionClient,
  parentPageId: string,
  parentPath: string,
  pages: RemoteTreePage[],
  visitedPageIds: Set<string>
): Promise<void> {
  const children = await client.listChildPages(parentPageId, "Hierarchy");
  for (const child of children) {
    const normalizedChildId = normalizeNotionPageId(child.id);
    if (visitedPageIds.has(normalizedChildId)) {
      continue;
    }
    visitedPageIds.add(normalizedChildId);
    const path = parentPath ? `${parentPath}/${child.title}` : child.title;
    const childPages = isReviewPath(path) ? [] : await client.listChildPages(child.id, "Hierarchy");
    const page = { id: child.id, title: child.title, parentPageId, path, hasChildren: childPages.length > 0, directChildren: childPages };
    pages.push(page);
    if (!isReviewPath(path)) {
      await scanRemoteChildrenFromKnownChildren(client, child.id, path, childPages, pages, visitedPageIds);
    }
  }
}

async function scanRemoteChildrenFromKnownChildren(
  client: NotionClient,
  parentPageId: string,
  parentPath: string,
  children: Array<{ id: string; title: string }>,
  pages: RemoteTreePage[],
  visitedPageIds: Set<string>
): Promise<void> {
  for (const child of children) {
    const normalizedChildId = normalizeNotionPageId(child.id);
    if (visitedPageIds.has(normalizedChildId)) {
      continue;
    }
    visitedPageIds.add(normalizedChildId);
    const path = parentPath ? `${parentPath}/${child.title}` : child.title;
    const childPages = isReviewPath(path) ? [] : await client.listChildPages(child.id, "Hierarchy");
    pages.push({ id: child.id, title: child.title, parentPageId, path, hasChildren: childPages.length > 0, directChildren: childPages });
    if (!isReviewPath(path)) {
      await scanRemoteChildrenFromKnownChildren(client, child.id, path, childPages, pages, visitedPageIds);
    }
  }
}

export function isReviewPath(path: string): boolean {
  return path === REVIEW_FOLDER_TITLE || path.startsWith(`${REVIEW_FOLDER_TITLE}/`);
}
