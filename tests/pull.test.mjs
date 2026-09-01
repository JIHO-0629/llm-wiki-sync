import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

console.debug = () => {};

const require = createRequire(import.meta.url);
const fallbackRoot = process.env.LLM_WIKI_SYNC_DEPS_ROOT ?? "";
let esbuild;
try {
  esbuild = require("esbuild");
} catch (error) {
  if (!fallbackRoot) {
    throw new Error("Missing esbuild. Run npm install in the plugin folder, or set LLM_WIKI_SYNC_DEPS_ROOT to a folder where it is installed.");
  }
  esbuild = createRequire(path.join(fallbackRoot, "package.json"))("esbuild");
}

const notices = [];
const pages = new Map();
const forbiddenRequests = [];
const ROOT_PAGE_ID = "11111111-1111-1111-1111-111111111111";

class TFile {
  constructor(filePath, content) {
    this.path = normalizePath(filePath);
    this.extension = this.path.includes(".") ? this.path.split(".").pop() : "";
    this.basename = path.posix.basename(this.path, this.extension ? `.${this.extension}` : "");
    this.stat = { mtime: 1 };
    this.content = content;
    this.parent = null;
  }
}

class Notice {
  constructor(message) {
    notices.push(message);
  }
}

function normalizePath(input) {
  return String(input ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
}

async function requestUrl(request) {
  if (request.method === "DELETE" || request.url.toLowerCase().includes("trash")) {
    forbiddenRequests.push(request);
    throw new Error(`Forbidden destructive request: ${request.method} ${request.url}`);
  }

  if (request.method === "GET" && request.url.includes("/v1/pages/") && request.url.endsWith("/markdown")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/]+)\/markdown$/)[1]);
    const page = getPageOrThrow(pageId);
    return ok({
      id: page.id,
      markdown: page.markdown,
      truncated: page.truncated === true,
      unknown_block_ids: page.truncated === true ? ["truncated-block"] : []
    });
  }

  if (request.method === "GET" && request.url.includes("/v1/pages/")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/?]+)$/)[1]);
    return ok(pageDetails(getPageOrThrow(pageId)));
  }

  if (request.method === "GET" && request.url.includes("/v1/blocks/") && request.url.includes("/children")) {
    const parentPageId = decodeURIComponent(request.url.match(/\/v1\/blocks\/([^/?]+)\/children/)[1]);
    getPageOrThrow(parentPageId);
    const results = Array.from(pages.values())
      .filter((page) => page.id !== parentPageId && page.parentPageId === parentPageId)
      .map((page) => ({
        object: "block",
        id: page.id,
        type: "child_page",
        child_page: { title: page.title }
      }));
    return ok({ object: "list", results, has_more: false, next_cursor: null });
  }

  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

const obsidianMock = { Notice, normalizePath, requestUrl, TFile };

function loadModule(entryPoint) {
  const result = esbuild.buildSync({
    entryPoints: [path.resolve(entryPoint)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    write: false
  });
  const module = { exports: {} };
  const testRequire = (specifier) => specifier === "obsidian" ? obsidianMock : require(specifier);
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, testRequire);
  return module.exports;
}

const { pullPagesFromNotion } = loadModule("sync/pull.ts");

function createApp(initialFiles = [], initialFolders = []) {
  const files = [];
  const folders = new Set(initialFolders.map(normalizePath));
  const app = {
    workspace: { getActiveFile() { return null; } },
    vault: {
      getMarkdownFiles() {
        return files.filter((file) => file.extension === "md");
      },
      getAbstractFileByPath(targetPath) {
        const normalized = normalizePath(targetPath);
        return files.find((file) => file.path === normalized) ?? (folders.has(normalized) ? { path: normalized } : null);
      },
      async create(targetPath, content) {
        const normalized = normalizePath(targetPath);
        if (this.getAbstractFileByPath(normalized)) throw new Error(`Path already exists: ${normalized}`);
        const file = new TFile(normalized, content);
        files.push(file);
        refreshParents(files);
        return file;
      },
      async createFolder(targetPath) {
        const normalized = normalizePath(targetPath);
        if (this.getAbstractFileByPath(normalized)) throw new Error(`Path already exists: ${normalized}`);
        folders.add(normalized);
      },
      async read(file) {
        return file.content;
      },
      async process(file, callback) {
        file.content = callback(file.content);
        file.stat.mtime += 1;
      }
    },
    metadataCache: {
      getFileCache(file) {
        return { frontmatter: parseFrontmatter(file.content) };
      }
    },
    fileManager: {
      async renameFile(file, targetPath) {
        const normalized = normalizePath(targetPath);
        if (app.vault.getAbstractFileByPath(normalized)) throw new Error(`Path already exists: ${normalized}`);
        file.path = normalized;
        file.extension = normalized.includes(".") ? normalized.split(".").pop() : "";
        file.basename = path.posix.basename(normalized, file.extension ? `.${file.extension}` : "");
        file.stat.mtime += 1;
        refreshParents(files);
      }
    },
    _files: files,
    _folders: folders
  };
  for (const file of initialFiles) {
    files.push(file);
  }
  refreshParents(files);
  return app;
}

function refreshParents(files) {
  for (const file of files) {
    const folderPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    file.parent = { path: folderPath };
  }
}

function parseFrontmatter(markdown) {
  const match = markdown.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return undefined;
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const lineMatch = line.match(/^([^:]+):\s*(?:"([^"]*)"|'([^']*)'|(.+))$/);
    if (lineMatch) {
      frontmatter[lineMatch[1].trim()] = (lineMatch[2] ?? lineMatch[3] ?? lineMatch[4] ?? "").trim();
    }
  }
  return frontmatter;
}

function makeFile(filePath, content) {
  return new TFile(filePath, content);
}

function makeStore() {
  return {
    baselines: {},
    folderMappings: {},
    getSyncBaseline(pageId) {
      return this.baselines[normalizePageId(pageId)] ?? null;
    },
    async saveSyncBaseline(pageId, baseline) {
      this.baselines[normalizePageId(pageId)] = baseline;
    },
    getFolderMapping(mappingKey) {
      return this.folderMappings[mappingKey] ?? null;
    },
    async saveFolderMapping(mappingKey, mapping) {
      this.folderMappings[mappingKey] = mapping;
    },
    getAllFolderMappings() {
      return Object.values(this.folderMappings);
    }
  };
}

async function runPull(app, store) {
  await pullPagesFromNotion({
    app,
    token: "secret_test",
    rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
    baselineStore: store,
    store
  });
}

function resetRemote() {
  pages.clear();
  notices.length = 0;
  forbiddenRequests.length = 0;
  addPage(ROOT_PAGE_ID, "Root", "");
}

function addPage(id, title, markdown, parentPageId = ROOT_PAGE_ID, options = {}) {
  pages.set(id, {
    id,
    title,
    markdown,
    parentPageId,
    parentType: "page_id",
    truncated: options.truncated === true,
    createdTime: new Date().toISOString(),
    lastEditedTime: new Date().toISOString(),
    url: `https://www.notion.so/${id}`
  });
}

function getPageOrThrow(pageId) {
  const page = pages.get(pageId);
  if (!page) throw new Error(`missing page: ${pageId}`);
  return page;
}

function ok(json) {
  return { status: 200, json, text: JSON.stringify(json) };
}

function pageDetails(page) {
  return {
    object: "page",
    id: page.id,
    url: page.url,
    created_time: page.createdTime,
    last_edited_time: page.lastEditedTime,
    parent: { type: page.parentType, page_id: page.parentPageId },
    properties: { title: { title: [{ plain_text: page.title }] } }
  };
}

function makeBaseline(pageId, localTitle, localBody, remoteTitle, remoteBody) {
  return {
    notionPageId: pageId,
    localFingerprint: fingerprint(localTitle, normalizeBody(localBody)),
    remoteFingerprint: fingerprint(remoteTitle, normalizeBody(remoteBody)),
    localTitle,
    remoteTitle,
    localMtime: 1,
    remoteLastEditedTime: "2026-08-22T00:00:00.000Z",
    syncedAt: "2026-08-22T00:00:00.000Z",
    schemaVersion: 1
  };
}

function fingerprint(title, body) {
  return crypto.createHash("sha256")
    .update("title\0", "utf8")
    .update(title, "utf8")
    .update("\0body\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function normalizeBody(body) {
  return body.replace(/\r\n?/g, "\n").replace(/\n+$/g, "") + "\n";
}

function normalizePageId(pageId) {
  return pageId.replace(/-/g, "").toLowerCase();
}

function mappingKey(rootPageId, folderPath) {
  return `${normalizePageId(rootPageId)}::${folderPath}`;
}

resetRemote();
addPage("root-note", "Root Note", "root body\n");
const rootApp = createApp();
const rootStore = makeStore();
await runPull(rootApp, rootStore);
assert.ok(rootApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Root Note.md"));
assert.ok(rootStore.baselines[normalizePageId("root-note")]);

resetRemote();
addPage("review-root", "LLM Wiki Sync Review", "");
addPage("review-missing", "Obsidian missing", "", "review-root");
addPage("review-page", "Some Page", "should not import\n", "review-missing");
const reviewApp = createApp();
const reviewStore = makeStore();
await runPull(reviewApp, reviewStore);
assert.equal(reviewApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/LLM Wiki Sync Review.md"), null);
assert.equal(reviewApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/LLM Wiki Sync Review"), null);
assert.equal(reviewApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/LLM Wiki Sync Review/Obsidian missing/Some Page.md"), null);
assert.equal(reviewStore.baselines[normalizePageId("review-root")], undefined);
assert.equal(reviewStore.baselines[normalizePageId("review-page")], undefined);

resetRemote();
addPage("folder-a", "Folder A", "");
addPage("nested-note", "Nested Note", "nested body\n", "folder-a");
const nestedApp = createApp();
const nestedStore = makeStore();
await runPull(nestedApp, nestedStore);
assert.ok(nestedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Folder A"));
assert.ok(nestedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Folder A/Nested Note.md"));
assert.equal(nestedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Folder A")].notionPageId, "folder-a");

resetRemote();
addPage(
  "realistic-folder",
  "Folder A",
  '<empty-block/>\n<page url="https://www.notion.so/realistic-nested-note">Nested Note</page>\n<empty-block/>\n'
);
addPage("realistic-nested-note", "Nested Note", "nested body\n", "realistic-folder");
const realisticNestedApp = createApp();
const realisticNestedStore = makeStore();
await runPull(realisticNestedApp, realisticNestedStore);
assert.ok(realisticNestedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Folder A/Nested Note.md"));
assert.equal(realisticNestedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Folder A")].notionPageId, "realistic-folder");

resetRemote();
addPage(
  "truncated-folder",
  "Truncated Folder",
  '<empty-block/>\n<page url="https://www.notion.so/truncated-child">Child</page>\n',
  ROOT_PAGE_ID,
  { truncated: true }
);
addPage("truncated-child", "Child", "child\n", "truncated-folder");
const truncatedApp = createApp();
const truncatedStore = makeStore();
await runPull(truncatedApp, truncatedStore);
assert.equal(truncatedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Truncated Folder"), null);
assert.equal(truncatedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Truncated Folder/Child.md"), null);
assert.equal(truncatedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Truncated Folder")], undefined);

resetRemote();
addPage("level-one", "One", "");
addPage("level-two", "Two", "", "level-one");
addPage("level-three-note", "Three", "deep\n", "level-two");
const deepApp = createApp();
const deepStore = makeStore();
await runPull(deepApp, deepStore);
assert.ok(deepApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/One/Two/Three.md"));
assert.equal(deepStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/One")].notionPageId, "level-one");
assert.equal(deepStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/One/Two")].notionPageId, "level-two");

resetRemote();
addPage("mapped-folder", "Remote Folder", "");
addPage("mapped-child", "Child", "child\n", "mapped-folder");
const mappedApp = createApp([], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Remote Folder"]);
const mappedStore = makeStore();
mappedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Remote Folder")] = {
  notionPageId: "mapped-folder",
  lastKnownPath: "LLM Wiki Sync Pull/Remote Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(mappedApp, mappedStore);
assert.ok(mappedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Remote Folder/Child.md"));
assert.equal(mappedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Remote Folder")].notionPageId, "mapped-folder");

resetRemote();
addPage("existing-folder", "Existing Folder", '<page url="https://www.notion.so/new-folder">New Folder</page>\n');
addPage("new-folder", "New Folder", '<page url="https://www.notion.so/new-note">New Note</page>\n', "existing-folder");
addPage("new-note", "New Note", "new body\n", "new-folder");
const obsidianOriginApp = createApp([], ["Existing Folder"]);
const obsidianOriginStore = makeStore();
obsidianOriginStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Existing Folder")] = {
  notionPageId: "existing-folder",
  lastKnownPath: "Existing Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(obsidianOriginApp, obsidianOriginStore);
assert.ok(obsidianOriginApp.vault.getAbstractFileByPath("Existing Folder/New Folder/New Note.md"));
assert.equal(obsidianOriginApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Existing Folder/New Folder/New Note.md"), null);
assert.deepEqual(obsidianOriginStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Existing Folder")], {
  notionPageId: "existing-folder",
  lastKnownPath: "Existing Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
});
const obsidianOriginFiles = obsidianOriginApp._files.map((file) => [file.path, file.content]);
const obsidianOriginFolders = Array.from(obsidianOriginApp._folders).sort();
const obsidianOriginMappings = JSON.stringify(obsidianOriginStore.folderMappings);
const obsidianOriginBaselines = Object.keys(obsidianOriginStore.baselines).sort();
await runPull(obsidianOriginApp, obsidianOriginStore);
assert.deepEqual(obsidianOriginApp._files.map((file) => [file.path, file.content]), obsidianOriginFiles);
assert.deepEqual(Array.from(obsidianOriginApp._folders).sort(), obsidianOriginFolders);
assert.equal(JSON.stringify(obsidianOriginStore.folderMappings), obsidianOriginMappings);
assert.deepEqual(Object.keys(obsidianOriginStore.baselines).sort(), obsidianOriginBaselines);

resetRemote();
addPage("mapped-folder-content", "Mapped Folder", "real body\n<page url=\"https://www.notion.so/mapped-folder-content-child\">Child</page>\n");
addPage("mapped-folder-content-child", "Child", "child\n", "mapped-folder-content");
const mappedFolderContentApp = createApp([], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Mapped Folder"]);
const mappedFolderContentStore = makeStore();
mappedFolderContentStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Mapped Folder")] = {
  notionPageId: "mapped-folder-content",
  lastKnownPath: "LLM Wiki Sync Pull/Mapped Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(mappedFolderContentApp, mappedFolderContentStore);
assert.equal(mappedFolderContentApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Mapped Folder/Child.md"), null);

resetRemote();
addPage("dual-identity", "Dual", '<page url="https://www.notion.so/dual-child">Child</page>\n');
addPage("dual-child", "Child", "child\n", "dual-identity");
const dualFile = makeFile("Dual.md", "---\nnotion_page_id: \"dual-identity\"\n---\n\nlocal\n");
const dualApp = createApp([dualFile], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Dual"]);
const dualStore = makeStore();
dualStore.baselines[normalizePageId("dual-identity")] = makeBaseline("dual-identity", "Dual", "\nlocal\n", "Dual", "local\n");
dualStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Dual")] = {
  notionPageId: "dual-identity",
  lastKnownPath: "LLM Wiki Sync Pull/Dual",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(dualApp, dualStore);
assert.equal(dualFile.content, "---\nnotion_page_id: \"dual-identity\"\n---\n\nlocal\n");
assert.equal(dualApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Dual/Child.md"), null);

resetRemote();
addPage("remote-parent", "Remote Parent", '<page url="https://www.notion.so/stale-folder">Stale Folder</page>\n');
addPage("stale-folder", "Stale Folder", '<page url="https://www.notion.so/stale-child">Child</page>\n', "remote-parent");
addPage("stale-child", "Child", "child\n", "stale-folder");
const staleApp = createApp();
const staleStore = makeStore();
staleStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Old Parent/Stale Folder")] = {
  notionPageId: "stale-folder",
  lastKnownPath: "LLM Wiki Sync Pull/Old Parent/Stale Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(staleApp, staleStore);
assert.ok(staleApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Remote Parent"));
assert.equal(staleApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Old Parent/Stale Folder"), null);
assert.equal(staleApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Remote Parent/Stale Folder"), null);
assert.equal(staleApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Remote Parent/Stale Folder/Child.md"), null);

resetRemote();
addPage("conflicting-folder", "Conflict Folder", '<page url="https://www.notion.so/conflicting-child">Child</page>\n');
addPage("conflicting-child", "Child", "child\n", "conflicting-folder");
const conflictFolderApp = createApp();
const conflictFolderStore = makeStore();
conflictFolderStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Conflict Folder")] = {
  notionPageId: "other-folder",
  lastKnownPath: "LLM Wiki Sync Pull/Conflict Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(conflictFolderApp, conflictFolderStore);
assert.equal(conflictFolderStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Conflict Folder")].notionPageId, "other-folder");
assert.equal(conflictFolderApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Conflict Folder"), null);
assert.equal(conflictFolderApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Conflict Folder/Child.md"), null);

resetRemote();
addPage("multi-path-folder", "Multi Path", '<page url="https://www.notion.so/multi-path-child">Child</page>\n');
addPage("multi-path-child", "Child", "child\n", "multi-path-folder");
const multiPathApp = createApp();
const multiPathStore = makeStore();
multiPathStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Path A")] = {
  notionPageId: "multi-path-folder",
  lastKnownPath: "Path A",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
multiPathStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Path B")] = {
  notionPageId: "multi-path-folder",
  lastKnownPath: "Path B",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(multiPathApp, multiPathStore);
assert.equal(multiPathApp.vault.getAbstractFileByPath("Path A/Child.md"), null);
assert.equal(multiPathApp.vault.getAbstractFileByPath("Path B/Child.md"), null);
assert.equal(multiPathApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Multi Path/Child.md"), null);

resetRemote();
addPage("duplicate-page", "Duplicate", "remote\n");
const duplicateFiles = [
  makeFile("Duplicate A.md", "---\nnotion_page_id: \"duplicate-page\"\n---\n\nlocal\n"),
  makeFile("Duplicate B.md", "---\nnotion_page_id: \"duplicate-page\"\n---\n\nlocal\n")
];
const duplicateApp = createApp(duplicateFiles);
const duplicateStore = makeStore();
duplicateStore.baselines[normalizePageId("duplicate-page")] = makeBaseline("duplicate-page", "Duplicate A", "\nlocal\n", "Duplicate", "remote\n");
await runPull(duplicateApp, duplicateStore);
assert.equal(duplicateFiles[0].content.includes("remote"), false);
assert.equal(duplicateFiles[1].content.includes("remote"), false);

resetRemote();
addPage("mapped-update", "Mapped", "remote changed\n");
const updateFile = makeFile("Mapped.md", "---\nnotion_page_id: \"mapped-update\"\n---\n\nold\n");
const updateApp = createApp([updateFile]);
const updateStore = makeStore();
updateStore.baselines[normalizePageId("mapped-update")] = makeBaseline("mapped-update", "Mapped", "\nold\n", "Mapped", "old\n");
await runPull(updateApp, updateStore);
assert.equal(updateFile.content, "---\nnotion_page_id: \"mapped-update\"\n---\nremote changed\n");

resetRemote();
addPage("mapped-with-child", "A", 'same own body\n<page url="https://www.notion.so/mapped-with-child-child">Child</page>\n');
addPage("mapped-with-child-child", "Child", "child\n", "mapped-with-child");
const mappedWithChildFile = makeFile("A.md", "---\nnotion_page_id: \"mapped-with-child\"\n---\n\nsame own body\n");
const mappedWithChildApp = createApp([mappedWithChildFile]);
const mappedWithChildStore = makeStore();
mappedWithChildStore.baselines[normalizePageId("mapped-with-child")] = makeBaseline("mapped-with-child", "A", "\nsame own body\n", "A", "same own body\n");
await runPull(mappedWithChildApp, mappedWithChildStore);
assert.equal(mappedWithChildFile.content, "---\nnotion_page_id: \"mapped-with-child\"\n---\n\nsame own body\n");
assert.equal(mappedWithChildApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/A/Child.md"), null);
assert.equal(mappedWithChildStore.baselines[normalizePageId("mapped-with-child")].syncedAt, "2026-08-22T00:00:00.000Z");

resetRemote();
addPage("local-only", "Local Only", "old\n");
const localOnlyFile = makeFile("Local Only.md", "---\nnotion_page_id: \"local-only\"\n---\n\nlocal changed\n");
const localOnlyApp = createApp([localOnlyFile]);
const localOnlyStore = makeStore();
localOnlyStore.baselines[normalizePageId("local-only")] = makeBaseline("local-only", "Local Only", "\nold\n", "Local Only", "old\n");
await runPull(localOnlyApp, localOnlyStore);
assert.equal(localOnlyFile.content.includes("local changed"), true);

resetRemote();
addPage("conflict", "Conflict", "remote changed\n");
const conflictFile = makeFile("Conflict.md", "---\nnotion_page_id: \"conflict\"\n---\n\nlocal changed\n");
const conflictApp = createApp([conflictFile]);
const conflictStore = makeStore();
conflictStore.baselines[normalizePageId("conflict")] = makeBaseline("conflict", "Conflict", "\nold\n", "Conflict", "old\n");
await runPull(conflictApp, conflictStore);
assert.equal(conflictFile.content.includes("local changed"), true);

resetRemote();
addPage("collision-note", "Collision", "remote\n");
const collisionApp = createApp([makeFile("LLM Wiki Sync Pull/Collision.md", "existing\n")], ["LLM Wiki Sync Pull"]);
const collisionStore = makeStore();
await runPull(collisionApp, collisionStore);
assert.equal(collisionApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Collision.md").content, "existing\n");

resetRemote();
addPage("blocked-folder", "Blocked", "");
addPage("blocked-child", "Child", "child\n", "blocked-folder");
const blockedApp = createApp([makeFile("LLM Wiki Sync Pull/Blocked", "file collision\n")], ["LLM Wiki Sync Pull"]);
const blockedStore = makeStore();
await runPull(blockedApp, blockedStore);
assert.equal(blockedApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Blocked/Child.md"), null);
assert.equal(blockedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Blocked")], undefined);
assert.equal(forbiddenRequests.length, 0);

resetRemote();
addPage("idempotent-folder", "Idempotent Folder", '<page url="https://www.notion.so/idempotent-note">Idempotent Note</page>\n');
addPage("idempotent-note", "Idempotent Note", "body\n", "idempotent-folder");
const idempotentApp = createApp();
const idempotentStore = makeStore();
await runPull(idempotentApp, idempotentStore);
const firstFiles = idempotentApp._files.map((file) => [file.path, file.content]);
const firstFolders = Array.from(idempotentApp._folders).sort();
const firstMappings = JSON.stringify(idempotentStore.folderMappings);
const firstBaselines = Object.keys(idempotentStore.baselines).sort();
await runPull(idempotentApp, idempotentStore);
assert.deepEqual(idempotentApp._files.map((file) => [file.path, file.content]), firstFiles);
assert.deepEqual(Array.from(idempotentApp._folders).sort(), firstFolders);
assert.equal(JSON.stringify(idempotentStore.folderMappings), firstMappings);
assert.deepEqual(Object.keys(idempotentStore.baselines).sort(), firstBaselines);

console.log("pull checks passed");
