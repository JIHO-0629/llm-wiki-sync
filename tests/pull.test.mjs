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
        if (file.failProcessOnce === true) {
          file.failProcessOnce = false;
          throw new Error("simulated process failure");
        }
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
    async removeFolderMapping(mappingKey) {
      delete this.folderMappings[mappingKey];
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
assert.ok(rootApp.vault.getAbstractFileByPath("Root Note.md"));
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
assert.equal(reviewApp.vault.getAbstractFileByPath("LLM Wiki Sync Review.md"), null);
assert.equal(reviewApp.vault.getAbstractFileByPath("LLM Wiki Sync Review"), null);
assert.equal(reviewStore.baselines[normalizePageId("review-root")], undefined);
assert.equal(reviewStore.baselines[normalizePageId("review-page")], undefined);

resetRemote();
addPage("folder-a", "Folder A", "");
addPage("nested-note", "Nested Note", "nested body\n", "folder-a");
const nestedApp = createApp();
const nestedStore = makeStore();
await runPull(nestedApp, nestedStore);
assert.ok(nestedApp.vault.getAbstractFileByPath("Folder A"));
assert.ok(nestedApp.vault.getAbstractFileByPath("Folder A/Nested Note.md"));
assert.equal(nestedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Folder A")].notionPageId, "folder-a");

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
assert.ok(realisticNestedApp.vault.getAbstractFileByPath("Folder A/Nested Note.md"));
assert.equal(realisticNestedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Folder A")].notionPageId, "realistic-folder");

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
assert.equal(truncatedApp.vault.getAbstractFileByPath("Truncated Folder"), null);
assert.equal(truncatedApp.vault.getAbstractFileByPath("Truncated Folder/Child.md"), null);
assert.equal(truncatedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Truncated Folder")], undefined);

resetRemote();
addPage("level-one", "One", "");
addPage("level-two", "Two", "", "level-one");
addPage("level-three-note", "Three", "deep\n", "level-two");
const deepApp = createApp();
const deepStore = makeStore();
await runPull(deepApp, deepStore);
assert.ok(deepApp.vault.getAbstractFileByPath("One/Two/Three.md"));
assert.equal(deepStore.folderMappings[mappingKey(ROOT_PAGE_ID, "One")].notionPageId, "level-one");
assert.equal(deepStore.folderMappings[mappingKey(ROOT_PAGE_ID, "One/Two")].notionPageId, "level-two");

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
assert.ok(mappedApp.vault.getAbstractFileByPath("Remote Folder/Child.md"));
assert.equal(mappedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Remote Folder")].notionPageId, "mapped-folder");
assert.equal(mappedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Remote Folder")], undefined);

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
addPage("projects-folder", "10_Projects", '<page url="https://www.notion.so/dev-record">LLM Wiki Sync 개발 기록</page>\n');
addPage(
  "dev-record",
  "LLM Wiki Sync 개발 기록",
  'meaningful parent body\n<page url="https://www.notion.so/why-start">01_왜 시작했는가</page>\n<page url="https://www.notion.so/pre-release">02_첫 Release 전 검증과 준비</page>\n<page url="https://www.notion.so/post-release">03_첫 Release 이후 피드백과 개선</page>\n<page url="https://www.notion.so/retrospective">04_총평_우리가 만든 것과 배운 것</page>\n',
  "projects-folder"
);
addPage("why-start", "01_왜 시작했는가", "why\n", "dev-record");
addPage("pre-release", "02_첫 Release 전 검증과 준비", "pre\n", "dev-record");
addPage("post-release", "03_첫 Release 이후 피드백과 개선", "post\n", "dev-record");
addPage("retrospective", "04_총평_우리가 만든 것과 배운 것", "retro\n", "dev-record");
const legacyProjectsFile = makeFile("LLM Wiki Sync Pull/10_Projects.md", "---\nnotion_page_id: \"projects-folder\"\n---\n\n");
const realUseApp = createApp([legacyProjectsFile], ["10_Projects", "LLM Wiki Sync Pull"]);
const realUseStore = makeStore();
realUseStore.baselines[normalizePageId("projects-folder")] = makeBaseline("projects-folder", "10_Projects", "\n", "10_Projects", "\n");
realUseStore.folderMappings[mappingKey(ROOT_PAGE_ID, "10_Projects")] = {
  notionPageId: "projects-folder",
  lastKnownPath: "10_Projects",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(realUseApp, realUseStore);
const projectsIndexFile = realUseApp.vault.getAbstractFileByPath("10_Projects/_index.md");
const indexFile = realUseApp.vault.getAbstractFileByPath("10_Projects/LLM Wiki Sync 개발 기록/_index.md");
assert.ok(projectsIndexFile);
assert.equal(parseFrontmatter(projectsIndexFile.content).notion_page_id, "projects-folder");
assert.equal(parseFrontmatter(projectsIndexFile.content).notion_page_role, "container_index");
assert.ok(indexFile);
assert.ok(realUseApp.vault.getAbstractFileByPath("10_Projects/LLM Wiki Sync 개발 기록/01_왜 시작했는가.md"));
assert.ok(realUseApp.vault.getAbstractFileByPath("10_Projects/LLM Wiki Sync 개발 기록/02_첫 Release 전 검증과 준비.md"));
assert.ok(realUseApp.vault.getAbstractFileByPath("10_Projects/LLM Wiki Sync 개발 기록/03_첫 Release 이후 피드백과 개선.md"));
assert.ok(realUseApp.vault.getAbstractFileByPath("10_Projects/LLM Wiki Sync 개발 기록/04_총평_우리가 만든 것과 배운 것.md"));
assert.equal(realUseApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/10_Projects"), null);
assert.equal(realUseApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/10_Projects.md"), null);
assert.equal(realUseStore.folderMappings[mappingKey(ROOT_PAGE_ID, "10_Projects")].notionPageId, "projects-folder");
assert.equal(realUseStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/10_Projects")], undefined);
assert.equal(realUseStore.getAllFolderMappings().filter((mapping) => normalizePageId(mapping.notionPageId) === normalizePageId("projects-folder")).length, 1);
assert.equal(parseFrontmatter(indexFile.content).notion_page_id, "dev-record");
assert.equal(parseFrontmatter(indexFile.content).notion_page_role, "container_index");
assert.equal(indexFile.content.includes("meaningful parent body"), true);
assert.equal(indexFile.content.includes("<page "), false);
const realUseFiles = realUseApp._files.map((file) => [file.path, file.content]);
const realUseFolders = Array.from(realUseApp._folders).sort();
const realUseMappings = JSON.stringify(realUseStore.folderMappings);
const realUseBaselines = Object.keys(realUseStore.baselines).sort();
await runPull(realUseApp, realUseStore);
assert.deepEqual(realUseApp._files.map((file) => [file.path, file.content]), realUseFiles);
assert.deepEqual(Array.from(realUseApp._folders).sort(), realUseFolders);
assert.equal(JSON.stringify(realUseStore.folderMappings), realUseMappings);
assert.deepEqual(Object.keys(realUseStore.baselines).sort(), realUseBaselines);

resetRemote();
addPage("attachments-folder", "99_Attachments", '<page url="https://www.notion.so/attachment-child">Image</page>\n');
addPage("attachment-child", "Image", "image body\n", "attachments-folder");
const attachmentsLegacyFile = makeFile("LLM Wiki Sync Pull/99_Attachments.md", "---\nnotion_page_id: \"attachments-folder\"\n---\n\n");
const attachmentsApp = createApp([attachmentsLegacyFile], ["99_Attachments", "LLM Wiki Sync Pull"]);
const attachmentsStore = makeStore();
attachmentsStore.baselines[normalizePageId("attachments-folder")] = makeBaseline("attachments-folder", "99_Attachments", "\n", "99_Attachments", "\n");
attachmentsStore.folderMappings[mappingKey(ROOT_PAGE_ID, "99_Attachments")] = {
  notionPageId: "attachments-folder",
  lastKnownPath: "99_Attachments",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(attachmentsApp, attachmentsStore);
const attachmentsIndex = attachmentsApp.vault.getAbstractFileByPath("99_Attachments/_index.md");
assert.ok(attachmentsIndex);
assert.equal(parseFrontmatter(attachmentsIndex.content).notion_page_id, "attachments-folder");
assert.equal(parseFrontmatter(attachmentsIndex.content).notion_page_role, "container_index");
assert.ok(attachmentsApp.vault.getAbstractFileByPath("99_Attachments/Image.md"));
assert.equal(attachmentsApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/99_Attachments.md"), null);
assert.equal(attachmentsStore.getAllFolderMappings().filter((mapping) => normalizePageId(mapping.notionPageId) === normalizePageId("attachments-folder")).length, 1);
assert.equal(notices.some((message) => message === "LLM Wiki Sync: Ambiguous note/folder mapping skipped."), false);

resetRemote();
addPage("systems-prompts-folder", "60_Systems-Prompts", '<page url="https://www.notion.so/rules-page">Rules</page>\n<page url="https://www.notion.so/templates-page">Templates</page>\n');
addPage("rules-page", "Rules", "rules body\n", "systems-prompts-folder");
addPage("templates-page", "Templates", "templates body\n", "systems-prompts-folder");
const systemsPromptsLegacyFile = makeFile(
  "LLM Wiki Sync Pull/60_Systems-Prompts.md",
  "---\nnotion_page_id: \"systems-prompts-folder\"\n---\n\n<page url=\"https://www.notion.so/rules-page\">Rules</page>\n<page url=\"https://www.notion.so/templates-page\">Templates</page>\n"
);
const systemsPromptsApp = createApp([systemsPromptsLegacyFile], ["60_Systems-Prompts", "LLM Wiki Sync Pull"]);
const systemsPromptsStore = makeStore();
systemsPromptsStore.baselines[normalizePageId("systems-prompts-folder")] = makeBaseline("systems-prompts-folder", "60_Systems-Prompts", "\n", "60_Systems-Prompts", "\n");
systemsPromptsStore.folderMappings[mappingKey(ROOT_PAGE_ID, "60_Systems-Prompts")] = {
  notionPageId: "systems-prompts-folder",
  lastKnownPath: "60_Systems-Prompts",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(systemsPromptsApp, systemsPromptsStore);
const systemsPromptsIndex = systemsPromptsApp.vault.getAbstractFileByPath("60_Systems-Prompts/_index.md");
assert.ok(systemsPromptsIndex);
assert.equal(parseFrontmatter(systemsPromptsIndex.content).notion_page_id, "systems-prompts-folder");
assert.equal(parseFrontmatter(systemsPromptsIndex.content).notion_page_role, "container_index");
assert.equal(systemsPromptsIndex.content.includes("<page "), false);
assert.ok(systemsPromptsApp.vault.getAbstractFileByPath("60_Systems-Prompts/Rules.md"));
assert.ok(systemsPromptsApp.vault.getAbstractFileByPath("60_Systems-Prompts/Templates.md"));
assert.equal(systemsPromptsApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/60_Systems-Prompts.md"), null);
assert.equal(systemsPromptsStore.getAllFolderMappings().filter((mapping) => normalizePageId(mapping.notionPageId) === normalizePageId("systems-prompts-folder")).length, 1);

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
assert.ok(mappedFolderContentApp.vault.getAbstractFileByPath("Mapped Folder/_index.md"));
assert.ok(mappedFolderContentApp.vault.getAbstractFileByPath("Mapped Folder/Child.md"));
assert.equal(mappedFolderContentStore.folderMappings[mappingKey(ROOT_PAGE_ID, "LLM Wiki Sync Pull/Mapped Folder")], undefined);

resetRemote();
addPage("collision-container", "Collision Container", 'body\n<page url="https://www.notion.so/collision-child">Child</page>\n');
addPage("collision-child", "Child", "child\n", "collision-container");
const collisionLegacyFile = makeFile("LLM Wiki Sync Pull/Collision Container.md", "---\nnotion_page_id: \"collision-container\"\n---\n\nbody\n");
const collisionIndexFile = makeFile("Collision Container/_index.md", "existing\n");
const collisionMigrationApp = createApp([collisionLegacyFile, collisionIndexFile], ["LLM Wiki Sync Pull", "Collision Container"]);
const collisionMigrationStore = makeStore();
collisionMigrationStore.baselines[normalizePageId("collision-container")] = makeBaseline("collision-container", "Collision Container", "\nbody\n", "Collision Container", "body\n");
await runPull(collisionMigrationApp, collisionMigrationStore);
assert.equal(collisionMigrationApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Collision Container.md"), collisionLegacyFile);
assert.equal(collisionMigrationApp.vault.getAbstractFileByPath("Collision Container/_index.md").content, "existing\n");
assert.equal(collisionMigrationStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Collision Container")], undefined);

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
addPage("roleless-container", "Roleless", '<page url="https://www.notion.so/roleless-child">Child</page>\n');
addPage("roleless-child", "Child", "child\n", "roleless-container");
const rolelessIndex = makeFile("Roleless/_index.md", "---\nnotion_page_id: \"roleless-container\"\n---\n\n");
const rolelessApp = createApp([rolelessIndex], ["Roleless"]);
const rolelessStore = makeStore();
rolelessStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Roleless")] = {
  notionPageId: "roleless-container",
  lastKnownPath: "Roleless",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(rolelessApp, rolelessStore);
assert.equal(rolelessApp.vault.getAbstractFileByPath("Roleless/Child.md"), null);

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
assert.ok(staleApp.vault.getAbstractFileByPath("Remote Parent"));
assert.equal(staleApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Old Parent/Stale Folder"), null);
assert.equal(staleApp.vault.getAbstractFileByPath("Remote Parent/Stale Folder"), null);
assert.equal(staleApp.vault.getAbstractFileByPath("Remote Parent/Stale Folder/Child.md"), null);

resetRemote();
addPage("conflicting-folder", "Conflict Folder", '<page url="https://www.notion.so/conflicting-child">Child</page>\n');
addPage("conflicting-child", "Child", "child\n", "conflicting-folder");
const conflictFolderApp = createApp();
const conflictFolderStore = makeStore();
conflictFolderStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Conflict Folder")] = {
  notionPageId: "other-folder",
  lastKnownPath: "Conflict Folder",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
await runPull(conflictFolderApp, conflictFolderStore);
assert.equal(conflictFolderStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Conflict Folder")].notionPageId, "other-folder");
assert.equal(conflictFolderApp.vault.getAbstractFileByPath("Conflict Folder"), null);
assert.equal(conflictFolderApp.vault.getAbstractFileByPath("Conflict Folder/Child.md"), null);

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
assert.equal(multiPathApp.vault.getAbstractFileByPath("Multi Path/Child.md"), null);

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
addPage("frontmatter-pull", "Frontmatter Pull", "remote body\n");
const frontmatterPullFile = makeFile("Frontmatter Pull.md", "---\ntype: \"note\"\nstatus: \"draft\"\nnotion_page_id: \"frontmatter-pull\"\n---\n\nold body\n");
const frontmatterPullApp = createApp([frontmatterPullFile]);
const frontmatterPullStore = makeStore();
frontmatterPullStore.baselines[normalizePageId("frontmatter-pull")] = makeBaseline("frontmatter-pull", "Frontmatter Pull", "\nold body\n", "Frontmatter Pull", "old body\n");
await runPull(frontmatterPullApp, frontmatterPullStore);
assert.equal(frontmatterPullFile.content, "---\ntype: \"note\"\nstatus: \"draft\"\nnotion_page_id: \"frontmatter-pull\"\n---\nremote body\n");

resetRemote();
addPage("legacy-leaf-project", "Project", '<page url="https://www.notion.so/legacy-leaf-clean">Note</page>\n');
addPage("legacy-leaf-clean", "Note", "same\n", "legacy-leaf-project");
const legacyLeafCleanFile = makeFile("LLM Wiki Sync Pull/Project/Note.md", "---\ntype: \"note\"\nnotion_page_id: \"legacy-leaf-clean\"\n---\n\nsame\n");
const legacyLeafCleanApp = createApp([legacyLeafCleanFile], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Project"]);
const legacyLeafCleanStore = makeStore();
legacyLeafCleanStore.baselines[normalizePageId("legacy-leaf-clean")] = makeBaseline("legacy-leaf-clean", "Note", "\nsame\n", "Note", "same\n");
await runPull(legacyLeafCleanApp, legacyLeafCleanStore);
const migratedCleanLeaf = legacyLeafCleanApp.vault.getAbstractFileByPath("Project/Note.md");
assert.ok(migratedCleanLeaf);
assert.equal(legacyLeafCleanApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Project/Note.md"), null);
assert.equal(parseFrontmatter(migratedCleanLeaf.content).type, "note");
assert.equal(parseFrontmatter(migratedCleanLeaf.content).notion_page_id, "legacy-leaf-clean");
const legacyLeafCleanFiles = legacyLeafCleanApp._files.map((file) => [file.path, file.content]);
const legacyLeafCleanFolders = Array.from(legacyLeafCleanApp._folders).sort();
await runPull(legacyLeafCleanApp, legacyLeafCleanStore);
assert.deepEqual(legacyLeafCleanApp._files.map((file) => [file.path, file.content]), legacyLeafCleanFiles);
assert.deepEqual(Array.from(legacyLeafCleanApp._folders).sort(), legacyLeafCleanFolders);

resetRemote();
addPage("legacy-leaf-remote-project", "Project", '<page url="https://www.notion.so/legacy-leaf-remote">Note Renamed</page>\n');
addPage("legacy-leaf-remote", "Note Renamed", "remote changed\n", "legacy-leaf-remote-project");
const legacyLeafRemoteFile = makeFile("LLM Wiki Sync Pull/Project/Old Note.md", "---\nstatus: \"draft\"\nnotion_page_id: \"legacy-leaf-remote\"\n---\n\nold\n");
const legacyLeafRemoteApp = createApp([legacyLeafRemoteFile], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Project"]);
const legacyLeafRemoteStore = makeStore();
legacyLeafRemoteStore.baselines[normalizePageId("legacy-leaf-remote")] = makeBaseline("legacy-leaf-remote", "Old Note", "\nold\n", "Note Renamed", "old\n");
await runPull(legacyLeafRemoteApp, legacyLeafRemoteStore);
const migratedRemoteLeaf = legacyLeafRemoteApp.vault.getAbstractFileByPath("Project/Note Renamed.md");
assert.ok(migratedRemoteLeaf);
assert.equal(legacyLeafRemoteApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Project/Old Note.md"), null);
assert.equal(migratedRemoteLeaf.content, "---\nstatus: \"draft\"\nnotion_page_id: \"legacy-leaf-remote\"\n---\nremote changed\n");

resetRemote();
addPage("legacy-leaf-collision-project", "Project", '<page url="https://www.notion.so/legacy-leaf-collision">Note</page>\n');
addPage("legacy-leaf-collision", "Note", "remote changed\n", "legacy-leaf-collision-project");
const legacyLeafCollisionFile = makeFile("LLM Wiki Sync Pull/Project/Note.md", "---\nnotion_page_id: \"legacy-leaf-collision\"\n---\n\nold\n");
const canonicalLeafCollisionFile = makeFile("Project/Note.md", "existing\n");
const legacyLeafCollisionApp = createApp([legacyLeafCollisionFile, canonicalLeafCollisionFile], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Project", "Project"]);
const legacyLeafCollisionStore = makeStore();
legacyLeafCollisionStore.baselines[normalizePageId("legacy-leaf-collision")] = makeBaseline("legacy-leaf-collision", "Note", "\nold\n", "Note", "old\n");
await runPull(legacyLeafCollisionApp, legacyLeafCollisionStore);
assert.equal(legacyLeafCollisionApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Project/Note.md"), legacyLeafCollisionFile);
assert.equal(legacyLeafCollisionFile.content.includes("remote changed"), false);
assert.equal(canonicalLeafCollisionFile.content, "existing\n");

resetRemote();
addPage("legacy-leaf-local-project", "Project", '<page url="https://www.notion.so/legacy-leaf-local">Note</page>\n');
addPage("legacy-leaf-local", "Note", "old\n", "legacy-leaf-local-project");
const legacyLeafLocalFile = makeFile("LLM Wiki Sync Pull/Project/Note.md", "---\nnotion_page_id: \"legacy-leaf-local\"\n---\n\nlocal changed\n");
const legacyLeafLocalApp = createApp([legacyLeafLocalFile], ["LLM Wiki Sync Pull", "LLM Wiki Sync Pull/Project"]);
const legacyLeafLocalStore = makeStore();
legacyLeafLocalStore.baselines[normalizePageId("legacy-leaf-local")] = makeBaseline("legacy-leaf-local", "Note", "\nold\n", "Note", "old\n");
await runPull(legacyLeafLocalApp, legacyLeafLocalStore);
assert.equal(legacyLeafLocalApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Project/Note.md"), legacyLeafLocalFile);
assert.equal(legacyLeafLocalApp.vault.getAbstractFileByPath("Project/Note.md"), null);
assert.equal(legacyLeafLocalFile.content.includes("local changed"), true);

resetRemote();
addPage("mapped-with-child", "A", 'same own body\n<page url="https://www.notion.so/mapped-with-child-child">Child</page>\n');
addPage("mapped-with-child-child", "Child", "child\n", "mapped-with-child");
const mappedWithChildFile = makeFile("A.md", "---\nnotion_page_id: \"mapped-with-child\"\n---\n\nsame own body\n");
const mappedWithChildApp = createApp([mappedWithChildFile]);
const mappedWithChildStore = makeStore();
mappedWithChildStore.baselines[normalizePageId("mapped-with-child")] = makeBaseline("mapped-with-child", "A", "\nsame own body\n", "A", "same own body\n");
await runPull(mappedWithChildApp, mappedWithChildStore);
assert.equal(mappedWithChildApp.vault.getAbstractFileByPath("A.md"), null);
const mappedWithChildIndex = mappedWithChildApp.vault.getAbstractFileByPath("A/_index.md");
assert.ok(mappedWithChildIndex);
assert.equal(parseFrontmatter(mappedWithChildIndex.content).notion_page_id, "mapped-with-child");
assert.equal(parseFrontmatter(mappedWithChildIndex.content).notion_page_role, "container_index");
assert.ok(mappedWithChildApp.vault.getAbstractFileByPath("A/Child.md"));
assert.equal(mappedWithChildApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/A/Child.md"), null);
assert.notEqual(mappedWithChildStore.baselines[normalizePageId("mapped-with-child")].syncedAt, "2026-08-22T00:00:00.000Z");

resetRemote();
addPage("rollback-container", "Rollback", 'body\n<page url="https://www.notion.so/rollback-child">Child</page>\n');
addPage("rollback-child", "Child", "child\n", "rollback-container");
const rollbackFile = makeFile("LLM Wiki Sync Pull/Rollback.md", "---\nnotion_page_id: \"rollback-container\"\n---\n\nbody\n");
rollbackFile.failProcessOnce = true;
const rollbackApp = createApp([rollbackFile], ["LLM Wiki Sync Pull"]);
const rollbackStore = makeStore();
rollbackStore.baselines[normalizePageId("rollback-container")] = makeBaseline("rollback-container", "Rollback", "\nbody\n", "Rollback", "body\n");
await runPull(rollbackApp, rollbackStore);
assert.equal(rollbackApp.vault.getAbstractFileByPath("LLM Wiki Sync Pull/Rollback.md"), rollbackFile);
assert.equal(rollbackApp.vault.getAbstractFileByPath("Rollback/_index.md"), null);
assert.equal(rollbackFile.content, "---\nnotion_page_id: \"rollback-container\"\n---\n\nbody\n");
assert.equal(rollbackStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Rollback")], undefined);
assert.equal(rollbackStore.baselines[normalizePageId("rollback-container")].syncedAt, "2026-08-22T00:00:00.000Z");

resetRemote();
addPage("body-removal", "Body Removal", 'hello\n<page url="https://www.notion.so/body-removal-child">Child</page>\n');
addPage("body-removal-child", "Child", "child\n", "body-removal");
const bodyRemovalApp = createApp();
const bodyRemovalStore = makeStore();
await runPull(bodyRemovalApp, bodyRemovalStore);
const bodyRemovalIndex = bodyRemovalApp.vault.getAbstractFileByPath("Body Removal/_index.md");
assert.ok(bodyRemovalIndex);
assert.equal(bodyRemovalIndex.content.includes("hello"), true);
pages.get("body-removal").markdown = '<page url="https://www.notion.so/body-removal-child">Child</page>\n';
pages.get("body-removal").lastEditedTime = new Date(Date.now() + 1000).toISOString();
await runPull(bodyRemovalApp, bodyRemovalStore);
assert.equal(bodyRemovalIndex.content.includes("hello"), false);

resetRemote();
addPage("unmatched-page-ref", "Unmatched Page Ref", 'keep\n<page url="https://www.notion.so/not-a-child">Not A Child</page>\n<page url="https://www.notion.so/actual-child">Actual Child</page>\n');
addPage("actual-child", "Actual Child", "child\n", "unmatched-page-ref");
const unmatchedRefApp = createApp();
const unmatchedRefStore = makeStore();
await runPull(unmatchedRefApp, unmatchedRefStore);
const unmatchedRefIndex = unmatchedRefApp.vault.getAbstractFileByPath("Unmatched Page Ref/_index.md");
assert.equal(unmatchedRefIndex, null);

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
const collisionApp = createApp([makeFile("Collision.md", "existing\n")]);
const collisionStore = makeStore();
await runPull(collisionApp, collisionStore);
assert.equal(collisionApp.vault.getAbstractFileByPath("Collision.md").content, "existing\n");

resetRemote();
addPage("blocked-folder", "Blocked", "");
addPage("blocked-child", "Child", "child\n", "blocked-folder");
const blockedApp = createApp([makeFile("Blocked", "file collision\n")]);
const blockedStore = makeStore();
await runPull(blockedApp, blockedStore);
assert.equal(blockedApp.vault.getAbstractFileByPath("Blocked/Child.md"), null);
assert.equal(blockedStore.folderMappings[mappingKey(ROOT_PAGE_ID, "Blocked")], undefined);
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
