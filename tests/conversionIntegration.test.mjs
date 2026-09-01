import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

function load(entryPoint, external = {}) {
  const built = esbuild.buildSync({ entryPoints: [path.resolve(entryPoint)], bundle: true, platform: "node", format: "cjs", external: ["obsidian"], write: false });
  const module = { exports: {} };
  const localRequire = (name) => external[name] ?? require(name);
  new Function("module", "exports", "require", built.outputFiles[0].text)(module, module.exports, localRequire);
  return module.exports;
}

const conversion = load("sync/markdownConversion.ts");
const baseline = load("sync/baseline.ts", { obsidian: {} });

const pushed = conversion.prepareNotionMarkdownForWrite("> [!warning] Check\n> ==body==");
assert.equal(pushed.status, "success");
assert.match(pushed.markdown, /<callout icon="⚠️" color="yellow_bg">/);
assert.match(pushed.markdown, /<span color="yellow_bg">body<\/span>/);

const unsafe = conversion.prepareNotionMarkdownForWrite("| Image |\n| --- |\n| ![[image.png]] |");
assert.equal(unsafe.status, "unsafe");
assert.equal(unsafe.markdown, "| Image |\n| --- |\n| ![[image.png]] |");

const pulled = conversion.prepareObsidianMarkdownFromNotion('<table fit-page-width="true" header-row="true"><tr color="blue_bg"><td>A</td></tr></table>');
assert.equal(pulled.status, "warning");
assert.match(pulled.markdown, /\| A \|\n\| --- \|/);

assert.equal(conversion.areObsidianAndNotionBodiesEquivalent("> [!caution] Same\n> Body", '<callout color="yellow_bg" icon="⚠️">\n\t**Same**\n\tBody\n</callout>'), true);
assert.equal(conversion.areObsidianAndNotionBodiesEquivalent("> [!warning] Same\n> Body", '<callout color="yellow_bg" icon="⚠️">\n\t**Same**\n\tChanged\n</callout>'), false);

assert.throws(() => baseline.getRemoteSyncSnapshotFromFetched(
  { id: "page", object: "page", title: "Page", parentType: "page_id", parentPageId: "root", lastEditedTime: "now", response: {} },
  { id: "page", markdown: "partial", truncated: true, unknownBlockIds: ["block"], response: {}, body: {} }
), /truncated/i);

console.log("conversion integration checks passed (6 assertions)");
