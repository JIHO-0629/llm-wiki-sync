import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
class TFile { constructor(path, bytes = new Uint8Array([1])) { this.path = path; this.name = path.split("/").pop(); this.extension = this.name.split(".").pop(); this.bytes = bytes.buffer; } }
function load(entry) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(entry)], bundle: true, platform: "node", format: "cjs", external: ["obsidian"], write: false });
  const module = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(module, module.exports, (name) => name === "obsidian" ? { TFile } : require(name));
  return module.exports;
}
const media = load("sync/mediaPush.ts");
const identity = load("sync/mediaIdentity.ts");
const test = media.__mediaPushTest;

// Fence boundary contract: literal examples must never be visible to the image matcher.
for (const source of [
  "```\n![](99_Attachments/a.png)\n````\n",
  "~~~\n![](99_Attachments/a.png)\n~~~~\n",
  "````\n```\n![](99_Attachments/a.png)\n````\n"
]) assert.doesNotMatch(test.maskLiterals(source), /!\[/);
assert.match(test.maskLiterals("```\n![](99_Attachments/a.png)\n````\n\n![](99_Attachments/b.png)"), /b\.png/);

// Table preflight catches real media, while literal code remains masked first.
const table = "| A |\n| --- |\n| ![x](99_Attachments/a.png) |";
assert.equal(test.isMarkdownTableCell(table, table.indexOf("![")), true);
assert.equal(test.isMarkdownTableCell("plain ![x](a.png)", 6), false);

// Sentinels are alphanumeric, collision-resistant, and unique after image indexing.
const first = test.createSentinelNamespace("LLMWIKISENTINELoldX");
const second = test.createSentinelNamespace(first);
assert.match(first, /^[A-Za-z0-9]+$/);
assert.notEqual(first, second);
assert.notEqual(`${first}0`, `${first}1`);

assert.equal(test.stableId("그림 1--11111111-1111-1111-1111-111111111111.png"), "11111111-1111-1111-1111-111111111111");
assert.equal(decodeURIComponent("%EA%B7%B8%EB%A6%BC%201.png"), "그림 1.png");

const remoteFileId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const remoteUrl = `https://prod-files-secure.s3.us-west-2.amazonaws.com/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/${remoteFileId}/step3test.png?X-Amz-Signature=one`;
assert.equal(identity.extractNotionMediaStableId(remoteUrl), remoteFileId);
assert.equal(identity.extractNotionMediaStableId(`https://prod-files-secure.s3.us-west-2.amazonaws.com/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/${remoteFileId}/name--cccccccc-cccc-cccc-cccc-cccccccccccc.png`), remoteFileId);
assert.equal(identity.extractNotionMediaStableId("https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/not-a-uuid/image.png"), null);
assert.equal(test.collectRemoteImages(`![caption](${remoteUrl})`)[0].stableId, remoteFileId);
assert.throws(() => test.collectRemoteImages("![caption](https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/not-a-uuid/image.png)"), /does not expose a stable media id/i);

const authoredImage = new TFile("99_Attachments/step3test.png");
const authoredSource = "before changed\n![caption](99_Attachments/step3test.png)\nafter";
const remoteBody = `before\n![caption](${remoteUrl})\nafter`;
function mappedClient() {
  const calls = [];
  return { calls,
    updatePageMarkdownContent: async (_pageId, updates) => { calls.push(["update_content", updates]); },
    retrievePageMarkdown: async () => ({ truncated: false, markdown: `before changed\n![caption](${remoteUrl})\nafter` })
  };
}
{
  const { app, note } = appFor(authoredSource, new Map([[authoredImage.path, authoredImage]])); const client = mappedClient();
  await media.updateMappedPageTextWithUnchangedImages({ app, file: note, localBody: authoredSource, remoteBody, client, pageId: "page", baselineImages: [{ localPath: authoredImage.path, contentHash: "hash", remoteStableId: remoteFileId, caption: "caption" }] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0][0], "update_content");
}
{
  const { app, note } = appFor(authoredSource, new Map([[authoredImage.path, authoredImage]])); const client = mappedClient();
  await assert.rejects(() => media.updateMappedPageTextWithUnchangedImages({ app, file: note, localBody: authoredSource, remoteBody, client, pageId: "page" }), /Step 3b-2/);
  assert.deepEqual(client.calls, []);
}
{
  const moved = new TFile("99_Attachments/moved-step3test.png"); const movedSource = "before changed\n![caption](99_Attachments/moved-step3test.png)\nafter";
  const { app, note } = appFor(movedSource, new Map([[moved.path, moved]])); const client = mappedClient();
  await assert.rejects(() => media.updateMappedPageTextWithUnchangedImages({ app, file: note, localBody: movedSource, remoteBody, client, pageId: "page", baselineImages: [{ localPath: authoredImage.path, contentHash: "hash", remoteStableId: remoteFileId, caption: "caption" }] }), /Step 3b-2/);
  assert.deepEqual(client.calls, []);
}

const images = [
  { source: "![a](https://prod-files-secure.s3.us-west-2.amazonaws.com/x/a--11111111-1111-1111-1111-111111111111.png)", caption: "a", stableId: "11111111-1111-1111-1111-111111111111" },
  { source: "![b](https://prod-files-secure.s3.us-west-2.amazonaws.com/x/b--22222222-2222-2222-2222-222222222222.png)", caption: "b", stableId: "22222222-2222-2222-2222-222222222222" }
];
const remote = `before ${images[0].source} middle ${images[1].source} after`;
const desired = `before changed ${images[0].source} middle changed ${images[1].source} after changed`;
const updates = test.imageSafeUpdates(remote, desired, images);
assert.equal(updates.length, 3);
for (const update of updates) { assert.doesNotMatch(update.old, /!\[/); assert.doesNotMatch(update.next, /!\[/); }
assert.throws(() => test.imageSafeUpdates(remote, `before ${images[0].source} after`, images), /lost|image-safe/i);

function appFor(markdown, files) {
  const note = new TFile("Note.md");
  return { note, app: { metadataCache: { getFirstLinkpathDest: (link) => files.get(link) ?? null }, vault: {
    getAbstractFileByPath: (value) => files.get(value) ?? null,
    readBinary: async (file) => file.bytes
  } } };
}
function clientFor({ attachFails = false, truncated = false, cleanupFails = false } = {}) {
  const calls = []; let sentinel = "";
  return { calls,
    getWorkspaceFileUploadLimit: async () => 1000,
    createSinglePartFileUpload: async () => ({ id: "upload", uploadUrl: "send", status: "pending", contentType: "image/png", contentLength: null }),
    sendFileUpload: async () => ({ id: "upload", uploadUrl: "send", status: "uploaded", contentType: "image/png", contentLength: 1 }),
    getFileUpload: async () => ({ id: "upload", uploadUrl: "send", status: "uploaded", contentType: "image/png", contentLength: 1 }),
    createChildPage: async (value) => { calls.push(["create", value.markdown]); sentinel = value.markdown.match(/LLMWIKISENTINEL\w+/)?.[0] ?? ""; return { id: "PLUGIN_CREATED_PAGE", url: "https://notion/PLUGIN_CREATED_PAGE", title: value.title, parentPageId: value.parentPageId, createdTime: "now" }; },
    listBlockChildren: async () => [{ id: "STEP3_SENTINEL_BLOCK", type: "paragraph", body: { text: sentinel } }, { id: "PREEXISTING_USER_BLOCK", type: "paragraph", body: { text: "user" } }],
    appendImageBlock: async () => { calls.push(["attach"]); if (attachFails) throw new Error("attach failed"); return { id: "image", type: "image", body: {} }; },
    trashBlock: async (id) => { calls.push(["trashBlock", id]); },
    retrievePageMarkdown: async () => truncated ? { truncated: true, markdown: "" } : { truncated: false, markdown: "before\n![caption](https://prod-files-secure.s3.us-west-2.amazonaws.com/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/11111111-1111-1111-1111-111111111111/step3test.png)\nafter" },
    trashPage: async (id) => { calls.push(["trashPage", id]); if (cleanupFails) throw new Error("trash denied"); }
  };
}
const file = new TFile("99_Attachments/그림 1--11111111-1111-1111-1111-111111111111.png");
const source = "before\n![caption](99_Attachments/%EA%B7%B8%EB%A6%BC%201--11111111-1111-1111-1111-111111111111.png)\nafter";
{
  const { app, note } = appFor(source, new Map([[file.path, file]]));
  const plan = await media.createMediaPushDryRun({ app, file: note, localBody: source });
  assert.equal(plan.operation, "create-page-with-images");
  assert.equal(plan.remoteMutationPlanned, false);
  assert.deepEqual(plan.hunks, []);
  assert.equal(plan.images[0].path, file.path);
  assert.match(plan.images[0].sha256, /^[0-9a-f]{64}$/);
}
{
  const { app, note } = appFor(source, new Map([[file.path, file]])); const client = clientFor();
  const created = await media.createPageWithImages({ app, file: note, body: source, client, parentPageId: "root", title: "new", pushedAt: new Date() });
  assert.equal(client.calls[0][0], "create");
  assert.deepEqual(created.imageIdentities.map((image) => ({ localPath: image.localPath, remoteStableId: image.remoteStableId, caption: image.caption })), [{ localPath: file.path, remoteStableId: "11111111-1111-1111-1111-111111111111", caption: "caption" }]);
  assert.match(created.imageIdentities[0].contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(client.calls.filter((call) => call[0] === "trashBlock"), [["trashBlock", "STEP3_SENTINEL_BLOCK"]]);
  assert.equal(client.calls.some((call) => call[1] === "PREEXISTING_USER_BLOCK" || call[1] === "PREEXISTING_USER_PAGE"), false);
}
{
  const { app, note } = appFor(source, new Map([[file.path, file]])); const client = clientFor({ attachFails: true });
  await assert.rejects(() => media.createPageWithImages({ app, file: note, body: source, client, parentPageId: "root", title: "new", pushedAt: new Date() }), /attach failed/);
  assert.deepEqual(client.calls.filter((call) => call[0] === "trashPage"), [["trashPage", "PLUGIN_CREATED_PAGE"]]);
}
{
  const { app, note } = appFor(source, new Map([[file.path, file]])); const client = clientFor({ truncated: true });
  await assert.rejects(() => media.createPageWithImages({ app, file: note, body: source, client, parentPageId: "root", title: "new", pushedAt: new Date() }), /verification/i);
  assert.deepEqual(client.calls.filter((call) => call[0] === "trashPage"), [["trashPage", "PLUGIN_CREATED_PAGE"]]);
}
{
  const { app, note } = appFor(source, new Map([[file.path, file]])); const client = clientFor({ attachFails: true, cleanupFails: true });
  await assert.rejects(() => media.createPageWithImages({ app, file: note, body: source, client, parentPageId: "root", title: "new", pushedAt: new Date() }), /orphan plugin-created page PLUGIN_CREATED_PAGE/i);
}

console.log("media push safety checks passed");
