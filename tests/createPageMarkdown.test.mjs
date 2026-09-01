import assert from "node:assert/strict";
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

let capturedRequest = null;
const requestUrl = async (request) => {
  capturedRequest = request;
  return {
    status: 200,
    text: "",
    json: {
      object: "page",
      id: "22222222-2222-2222-2222-222222222222",
      url: "https://www.notion.so/22222222222222222222222222222222",
      created_time: new Date().toISOString(),
      parent: {
        type: "page_id",
        page_id: "11111111-1111-1111-1111-111111111111"
      }
    }
  };
};

const result = esbuild.buildSync({
  entryPoints: [path.resolve("notionClient.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["obsidian"],
  write: false
});
const module = { exports: {} };
const testRequire = (specifier) => {
  if (specifier === "obsidian") {
    return { requestUrl };
  }
  return require(specifier);
};
new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, testRequire);
const { NotionClient, NOTION_CREATE_PAGE_ENDPOINT, NOTION_VERSION } = module.exports;

const markdown = Array.from({ length: 125 }, (_, index) => `## Section ${index + 1}\n\nContent ${index + 1}`).join("\n\n");
const client = new NotionClient({ token: "secret_test" });

await client.createChildPage({
  parentPageId: "11111111-1111-1111-1111-111111111111",
  title: "Large page",
  markdown,
  pushedAt: new Date(Date.now() - 1_000)
});

assert.ok(capturedRequest, "createChildPage should send a request");
assert.equal(capturedRequest.url, NOTION_CREATE_PAGE_ENDPOINT);
assert.equal(capturedRequest.method, "POST");
assert.equal(capturedRequest.headers["Notion-Version"], NOTION_VERSION);

const body = JSON.parse(capturedRequest.body);
assert.equal(body.markdown, markdown);
assert.equal(body.children, undefined);
assert.equal(body.markdown.includes("## Section 125"), true);
assert.equal((body.markdown.match(/^## Section /gm) ?? []).length, 125);

console.log("create page markdown checks passed");
