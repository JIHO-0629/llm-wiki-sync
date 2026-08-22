import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

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
const createRequests = [];
const markdownPatches = [];
const moveRequests = [];
let nextPageId = 1;
const ROOT_PAGE_ID = "11111111-1111-1111-1111-111111111111";
const ROOT_B_PAGE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

class Notice {
  constructor(message) {
    notices.push(message);
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = { empty() {}, createEl() {} };
  }
  open() {}
  close() {}
}

class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addButton() { return this; }
}

function normalizePath(input) {
  return String(input ?? "").replace(/\\/g, "/").replace(/\/+/g, "/");
}

async function requestUrl(request) {
  if (request.method === "GET" && request.url.includes("/v1/pages/") && request.url.endsWith("/markdown")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/]+)\/markdown$/)[1]);
    const page = getPageOrThrow(pageId);
    return ok({
      id: page.id,
      markdown: page.markdown,
      truncated: false,
      unknown_block_ids: []
    });
  }

  if (request.method === "GET" && request.url.includes("/v1/pages/")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/?]+)$/)[1]);
    const page = getPageOrThrow(pageId);
    return ok(pageDetails(page));
  }

  if (request.method === "GET" && request.url.includes("/v1/blocks/") && request.url.includes("/children")) {
    const parentPageId = decodeURIComponent(request.url.match(/\/v1\/blocks\/([^/?]+)\/children/)[1]);
    getPageOrThrow(parentPageId);
    const results = Array.from(pages.values())
      .filter((page) => page.parentPageId === parentPageId && page.parentType === "page_id")
      .map((page) => ({
        object: "block",
        id: page.id,
        type: "child_page",
        child_page: { title: page.title }
      }));
    return ok({ object: "list", results, has_more: false, next_cursor: null });
  }

  if (request.method === "POST" && request.url.endsWith("/v1/pages")) {
    const body = JSON.parse(request.body);
    const title = body.properties.title.title[0].text.content;
    if (title === "BadFolder" || title === "Failure") {
      return error(500, "simulated create failure");
    }
    const parentPageId = body.parent.page_id;
    getPageOrThrow(parentPageId);
    const id = `created-${nextPageId++}`;
    const page = {
      id,
      title,
      markdown: body.markdown,
      parentPageId,
      parentType: "page_id",
      createdTime: new Date().toISOString(),
      lastEditedTime: new Date().toISOString(),
      url: `https://www.notion.so/${id}`
    };
    pages.set(id, page);
    createRequests.push({ title, parentPageId, markdown: body.markdown, hasChildren: Object.prototype.hasOwnProperty.call(body, "children") });
    return ok(createdPageBody(page));
  }

  if (request.method === "POST" && request.url.includes("/v1/pages/") && request.url.endsWith("/move")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/]+)\/move$/)[1]);
    const page = getPageOrThrow(pageId);
    const body = JSON.parse(request.body);
    const parentPageId = body.parent.page_id;
    getPageOrThrow(parentPageId);
    page.parentPageId = parentPageId;
    page.lastEditedTime = new Date().toISOString();
    moveRequests.push({ pageId, parentPageId });
    return ok(pageDetails(page));
  }

  if (request.method === "PATCH" && request.url.endsWith("/markdown")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/]+)\/markdown$/)[1]);
    const page = getPageOrThrow(pageId);
    const body = JSON.parse(request.body);
    page.markdown = body.replace_content.new_str;
    page.lastEditedTime = new Date().toISOString();
    markdownPatches.push({ pageId, markdown: page.markdown });
    return ok({ object: "page", id: page.id });
  }

  if (request.method === "PATCH" && request.url.includes("/v1/pages/")) {
    const pageId = decodeURIComponent(request.url.match(/\/v1\/pages\/([^/?]+)$/)[1]);
    const page = getPageOrThrow(pageId);
    const body = JSON.parse(request.body);
    page.title = body.properties.title.title[0].text.content;
    page.lastEditedTime = new Date().toISOString();
    return ok(pageDetails(page));
  }

  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

function getPageOrThrow(pageId) {
  const page = pages.get(pageId);
  if (!page) {
    const response = error(404, "missing page");
    const thrown = new Error("missing page");
    thrown.response = response;
    throw thrown;
  }
  return page;
}

function ok(json) {
  return { status: 200, json, text: JSON.stringify(json) };
}

function error(status, message) {
  return { status, json: { message, code: "test_error" }, text: message };
}

function pageDetails(page) {
  return {
    object: "page",
    id: page.id,
    url: page.url,
    created_time: page.createdTime,
    last_edited_time: page.lastEditedTime,
    parent: {
      type: page.parentType,
      page_id: page.parentPageId
    },
    properties: {
      title: {
        title: [{ plain_text: page.title }]
      }
    }
  };
}

function createdPageBody(page) {
  return {
    ...pageDetails(page),
    created_time: page.createdTime
  };
}

const obsidianMock = { Notice, Modal, Setting, normalizePath, requestUrl };

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

const { pushEntireVaultToNotion, selectBulkPushMarkdownFiles } = loadModule("sync/bulkPush.ts");
const { pushCurrentNoteToNotion } = loadModule("sync/push.ts");
const { auditWorkspaceHierarchy, repairWorkspaceHierarchy, initializeWorkspaceMappings } = loadModule("sync/hierarchy.ts");

function makeFile(filePath, content) {
  const extension = filePath.includes(".") ? filePath.split(".").pop() : "";
  const basename = path.posix.basename(filePath, `.${extension}`);
  return {
    path: filePath,
    extension,
    basename,
    stat: { mtime: 1 },
    content
  };
}

function createApp(files, activePath = null) {
  const fileMap = new Map(files.map((file) => [file.path, file]));
  return {
    workspace: {
      getActiveFile() {
        return activePath ? fileMap.get(activePath) ?? null : null;
      }
    },
    vault: {
      getMarkdownFiles() {
        return files;
      },
      async read(file) {
        return file.content;
      }
    },
    metadataCache: {
      getFileCache(file) {
        return { frontmatter: parseFrontmatter(file.content) };
      }
    },
    fileManager: {
      async processFrontMatter(file, callback) {
        const frontmatter = parseFrontmatter(file.content) ?? {};
        callback(frontmatter);
        const body = stripFrontmatter(file.content);
        file.content = `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: "${String(value)}"`).join("\n")}\n---\n\n${body}`;
      }
    }
  };
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

function stripFrontmatter(markdown) {
  return markdown.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
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
    }
  };
}

function addPage(id, title, markdown, parentPageId = ROOT_PAGE_ID) {
  pages.set(id, {
    id,
    title,
    markdown,
    parentPageId,
    parentType: "page_id",
    createdTime: new Date().toISOString(),
    lastEditedTime: new Date().toISOString(),
    url: `https://www.notion.so/${id}`
  });
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

pages.clear();
notices.length = 0;
createRequests.length = 0;
markdownPatches.length = 0;
moveRequests.length = 0;
nextPageId = 1;
addPage(ROOT_PAGE_ID, "Root", "");
addPage("clean-page", "Clean", "clean\n");
addPage("local-page", "Local", "old\n");
addPage("remote-page", "Remote", "remote changed\n");
addPage("conflict-page", "Conflict", "remote changed\n");
addPage("duplicate-page", "Duplicate", "dup\n");

const largeMarkdown = Array.from({ length: 125 }, (_, index) => `## Section ${index + 1}\n\nContent ${index + 1}`).join("\n\n");
const files = [
  makeFile("Root note.md", "root\n"),
  makeFile("10_Projects/Project A.md", "project\n"),
  makeFile("20_Knowledge/Medicine/Heart.md", "heart\n"),
  makeFile("20_Knowledge/Medicine/Lung.md", "lung\n"),
  makeFile("Skip.yaml", "skip: true\n"),
  makeFile("Canvas.canvas", "{}"),
  makeFile("LLM Wiki Sync Pull/Pulled.md", "pulled\n"),
  makeFile("Clean.md", "---\nnotion_page_id: \"clean-page\"\n---\n\nclean\n"),
  makeFile("Local.md", "---\nnotion_page_id: \"local-page\"\n---\n\nnew local\n"),
  makeFile("Remote.md", "---\nnotion_page_id: \"remote-page\"\n---\n\nremote\n"),
  makeFile("Conflict.md", "---\nnotion_page_id: \"conflict-page\"\n---\n\nlocal changed\n"),
  makeFile("Duplicate A.md", "---\nnotion_page_id: \"duplicate-page\"\n---\n\ndup\n"),
  makeFile("Duplicate B.md", "---\nnotion_page_id: \"duplicate-page\"\n---\n\ndup\n"),
  makeFile("BadFolder/Note.md", "bad folder\n"),
  makeFile("Failure.md", "failure\n"),
  makeFile("After/Note.md", "after\n"),
  makeFile("Large.md", largeMarkdown)
];
const app = createApp(files);
const store = makeStore();
const rootAProjectsKey = mappingKey(ROOT_PAGE_ID, "10_Projects");
const rootAKnowledgeKey = mappingKey(ROOT_PAGE_ID, "20_Knowledge");
const rootAMedicineKey = mappingKey(ROOT_PAGE_ID, "20_Knowledge/Medicine");
const rootAAfterKey = mappingKey(ROOT_PAGE_ID, "After");
const rootABadFolderKey = mappingKey(ROOT_PAGE_ID, "BadFolder");
store.baselines[normalizePageId("clean-page")] = makeBaseline("clean-page", "Clean", "\nclean\n", "Clean", "clean\n");
store.baselines[normalizePageId("local-page")] = makeBaseline("local-page", "Local", "\nold\n", "Local", "old\n");
store.baselines[normalizePageId("remote-page")] = makeBaseline("remote-page", "Remote", "\nremote\n", "Remote", "remote\n");
store.baselines[normalizePageId("conflict-page")] = makeBaseline("conflict-page", "Conflict", "\nconflict\n", "Conflict", "conflict\n");
store.baselines[normalizePageId("duplicate-page")] = makeBaseline("duplicate-page", "Duplicate", "\ndup\n", "Duplicate", "dup\n");

const selected = selectBulkPushMarkdownFiles(app, "");
assert.equal(selected.some((file) => file.path === "Skip.yaml"), false);
assert.equal(selected.some((file) => file.path === "Canvas.canvas"), false);
assert.equal(selected.some((file) => file.path === "LLM Wiki Sync Pull/Pulled.md"), false);
const currentFolderSelected = selectBulkPushMarkdownFiles(app, "20_Knowledge");
assert.deepEqual(currentFolderSelected.map((file) => file.path), [
  "20_Knowledge/Medicine/Heart.md",
  "20_Knowledge/Medicine/Lung.md"
]);

await pushEntireVaultToNotion({
  app,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  store
});

const rootNoteCreate = createRequests.find((request) => request.title === "Root note");
assert.ok(rootNoteCreate);
assert.equal(rootNoteCreate.parentPageId, ROOT_PAGE_ID);

const projectsFolder = createRequests.find((request) => request.title === "10_Projects");
const projectA = createRequests.find((request) => request.title === "Project A");
assert.ok(projectsFolder);
assert.ok(projectA);
assert.equal(projectsFolder.parentPageId, ROOT_PAGE_ID);
assert.equal(projectA.parentPageId, store.folderMappings[rootAProjectsKey].notionPageId);
assert.equal(store.folderMappings[rootAProjectsKey].rootPageId, normalizePageId(ROOT_PAGE_ID));

assert.equal(createRequests.find((request) => request.title === "20_Knowledge").parentPageId, ROOT_PAGE_ID);
assert.equal(createRequests.find((request) => request.title === "Medicine").parentPageId, store.folderMappings[rootAKnowledgeKey].notionPageId);
assert.equal(createRequests.find((request) => request.title === "Heart").parentPageId, store.folderMappings[rootAMedicineKey].notionPageId);
assert.equal(createRequests.find((request) => request.title === "Lung").parentPageId, store.folderMappings[rootAMedicineKey].notionPageId);

const localPatch = markdownPatches.find((patch) => patch.pageId === "local-page");
assert.ok(localPatch);
assert.equal(localPatch.markdown, "\nnew local\n");
assert.equal(markdownPatches.some((patch) => patch.pageId === "remote-page"), false);
assert.equal(markdownPatches.some((patch) => patch.pageId === "conflict-page"), false);
assert.equal(markdownPatches.some((patch) => patch.pageId === "duplicate-page"), false);

assert.equal(store.folderMappings[rootABadFolderKey], undefined);
assert.ok(createRequests.some((request) => request.title === "After"));
assert.ok(createRequests.some((request) => request.title === "Note" && request.parentPageId === store.folderMappings[rootAAfterKey].notionPageId));

const largeCreate = createRequests.find((request) => request.title === "Large");
assert.ok(largeCreate);
assert.equal(largeCreate.hasChildren, false);
assert.equal(largeCreate.markdown.includes("## Section 125"), true);
assert.equal((largeCreate.markdown.match(/^## Section /gm) ?? []).length, 125);

assert.ok(files.find((file) => file.path === "Root note.md").content.includes("notion_page_id"));
assert.ok(notices.at(-1).includes("Bulk push complete"));
assert.ok(notices.at(-1).includes("remote changed 1"));
assert.ok(notices.at(-1).includes("conflicts 1"));
assert.ok(notices.at(-1).includes("failed 4"));

const rootAFolderCreates = createRequests.filter((request) => ["10_Projects", "20_Knowledge", "Medicine", "After"].includes(request.title)).length;
await pushEntireVaultToNotion({
  app,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  store
});
const rootAFolderCreatesAfterSecondPush = createRequests.filter((request) => ["10_Projects", "20_Knowledge", "Medicine", "After"].includes(request.title)).length;
assert.equal(rootAFolderCreatesAfterSecondPush, rootAFolderCreates);

addPage(ROOT_B_PAGE_ID, "Root B", "", ROOT_B_PAGE_ID);
await pushEntireVaultToNotion({
  app,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_B_PAGE_ID.replace(/-/g, "")}`,
  store
});
const rootBProjectsKey = mappingKey(ROOT_B_PAGE_ID, "10_Projects");
const rootBKnowledgeKey = mappingKey(ROOT_B_PAGE_ID, "20_Knowledge");
const rootBMedicineKey = mappingKey(ROOT_B_PAGE_ID, "20_Knowledge/Medicine");
assert.ok(store.folderMappings[rootBProjectsKey]);
assert.ok(store.folderMappings[rootBKnowledgeKey]);
assert.ok(store.folderMappings[rootBMedicineKey]);
assert.notEqual(store.folderMappings[rootBProjectsKey].notionPageId, store.folderMappings[rootAProjectsKey].notionPageId);
assert.equal(store.folderMappings[rootBProjectsKey].rootPageId, normalizePageId(ROOT_B_PAGE_ID));
const rootBProjectsFolder = createRequests.find((request) => request.title === "10_Projects" && request.parentPageId === ROOT_B_PAGE_ID);
assert.ok(rootBProjectsFolder);
assert.equal(createRequests.find((request) => request.title === "Medicine" && request.parentPageId === store.folderMappings[rootBKnowledgeKey].notionPageId).parentPageId, store.folderMappings[rootBKnowledgeKey].notionPageId);

pages.clear();
notices.length = 0;
createRequests.length = 0;
markdownPatches.length = 0;
moveRequests.length = 0;
nextPageId = 1;
addPage(ROOT_PAGE_ID, "Root", "");
addPage("test-folder", "test", "", ROOT_PAGE_ID);
addPage("correct-korean-folder", "시험의 시험", "", "test-folder");
addPage("wrong-korean-folder", "시험의 시험", "", ROOT_PAGE_ID);
addPage("wrong-title-folder", "틀린 제목", "", "test-folder");
addPage("misplaced-note", "시험", "linked body\n", ROOT_PAGE_ID);
addPage("ambiguous-a", "Ambiguous", "a\n", "correct-korean-folder");
addPage("ambiguous-b", "Ambiguous", "b\n", "correct-korean-folder");
const hierarchyFiles = [
  makeFile("test/시험의 시험/시험.md", "---\nnotion_page_id: \"misplaced-note\"\n---\n\nlinked body\n"),
  makeFile("test/시험의 시험의 시험/반갑습니다.md", "hello\n"),
  makeFile("test/시험의 시험/Ambiguous.md", "ambiguous local\n")
];
const hierarchyApp = createApp(hierarchyFiles, "test/시험의 시험/시험.md");
const hierarchyStore = makeStore();
hierarchyStore.folderMappings[mappingKey(ROOT_PAGE_ID, "test")] = {
  notionPageId: "test-folder",
  lastKnownPath: "test",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
hierarchyStore.folderMappings[mappingKey(ROOT_PAGE_ID, "test/시험의 시험")] = {
  notionPageId: "wrong-korean-folder",
  lastKnownPath: "test/시험의 시험",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
hierarchyStore.folderMappings[mappingKey(ROOT_PAGE_ID, "test/시험의 시험의 시험")] = {
  notionPageId: "wrong-title-folder",
  lastKnownPath: "test/시험의 시험의 시험",
  rootPageId: normalizePageId(ROOT_PAGE_ID)
};
const auditBeforeWrites = {
  creates: createRequests.length,
  patches: markdownPatches.length,
  moves: moveRequests.length,
  mappings: Object.keys(hierarchyStore.folderMappings).length,
  baselines: Object.keys(hierarchyStore.baselines).length
};
const audit = await auditWorkspaceHierarchy({
  app: hierarchyApp,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  store: hierarchyStore,
  scope: "entire-vault"
});
assert.ok(audit);
assert.ok(audit.items.some((item) => item.kind === "folder" && item.path === "test/시험의 시험" && item.status === "INVALID_FOLDER_MAPPING"));
assert.ok(audit.items.some((item) => item.kind === "folder" && item.path === "test/시험의 시험의 시험" && item.status === "INVALID_FOLDER_MAPPING"));
assert.ok(audit.items.some((item) => item.kind === "note" && item.path === "test/시험의 시험/시험.md" && item.status === "MISPLACED"));
assert.ok(audit.items.some((item) => item.kind === "note" && item.path === "test/시험의 시험/Ambiguous.md" && item.status === "AMBIGUOUS"));
assert.deepEqual({
  creates: createRequests.length,
  patches: markdownPatches.length,
  moves: moveRequests.length,
  mappings: Object.keys(hierarchyStore.folderMappings).length,
  baselines: Object.keys(hierarchyStore.baselines).length
}, auditBeforeWrites);

const repair = await repairWorkspaceHierarchy({
  app: hierarchyApp,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  store: hierarchyStore,
  scope: "entire-vault"
});
assert.ok(repair);
assert.equal(hierarchyStore.folderMappings[mappingKey(ROOT_PAGE_ID, "test/시험의 시험")].notionPageId, "correct-korean-folder");
assert.equal(pages.get("misplaced-note").parentPageId, "correct-korean-folder");
assert.equal(hierarchyFiles[0].content.includes("notion_page_id: \"misplaced-note\""), true);
assert.equal(moveRequests.length, 1);
assert.equal(moveRequests[0].pageId, "misplaced-note");
assert.ok(createRequests.some((request) => request.title === "시험의 시험의 시험" && request.parentPageId === "test-folder"));
const createCountAfterRepair = createRequests.length;
const moveCountAfterRepair = moveRequests.length;
const secondRepair = await repairWorkspaceHierarchy({
  app: hierarchyApp,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  store: hierarchyStore,
  scope: "entire-vault"
});
assert.ok(secondRepair);
assert.equal(createRequests.length, createCountAfterRepair);
assert.equal(moveRequests.length, moveCountAfterRepair);

const init = await initializeWorkspaceMappings({
  app: hierarchyApp,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  store: hierarchyStore,
  scope: "entire-vault"
});
assert.ok(init);
assert.equal(init.baselinesInitialized, 1);
assert.equal(init.ambiguous, 1);
assert.ok(hierarchyStore.baselines[normalizePageId("misplaced-note")]);

pages.clear();
notices.length = 0;
createRequests.length = 0;
markdownPatches.length = 0;
moveRequests.length = 0;
nextPageId = 1;
addPage(ROOT_PAGE_ID, "Root", "");
const singleFile = makeFile("Single.md", "single\n");
const singleApp = createApp([singleFile], "Single.md");
const singleStore = makeStore();
await pushCurrentNoteToNotion({
  app: singleApp,
  token: "secret_test",
  rootPageUrl: `https://www.notion.so/${ROOT_PAGE_ID.replace(/-/g, "")}`,
  baselineStore: singleStore
});
assert.equal(notices.at(-1), "LLM Wiki Sync: Pushed and linked to Notion.");
assert.ok(singleFile.content.includes("notion_page_id"));

console.log("bulk push checks passed");
