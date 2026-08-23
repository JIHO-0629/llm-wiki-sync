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
  new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const { normalizePulledMarkdown } = loadModule("sync/mapping.ts");

assert.equal(normalizePulledMarkdown("A\n<empty-block/>\nB\n"), "A\n\nB\n");
assert.equal(
  normalizePulledMarkdown('A\n<page url="https://app.notion.com/p/abc">Child</page>\nB\n'),
  'A\n<page url="https://app.notion.com/p/abc">Child</page>\nB\n'
);
assert.equal(
  normalizePulledMarkdown('A\n<page url="https://app.notion.com/p/abc" color="gray">One</page>\n<page color="blue" url="https://app.notion.com/p/def">Two</page>\nB\n'),
  'A\n<page url="https://app.notion.com/p/abc" color="gray">One</page>\n<page color="blue" url="https://app.notion.com/p/def">Two</page>\nB\n'
);
assert.equal(
  normalizePulledMarkdown('A\n<database url="https://app.notion.com/db/abc" inline="true" icon="📚" color="default">DB</database>\nB\n'),
  'A\n<database url="https://app.notion.com/db/abc" inline="true" icon="📚" color="default">DB</database>\nB\n'
);
assert.equal(normalizePulledMarkdown("A\n<div>hello</div>\nB\n"), "A\n<div>hello</div>\nB\n");
assert.equal(normalizePulledMarkdown('Keep inline <page url="x">Child</page> text\n'), 'Keep inline <page url="x">Child</page> text\n');
assert.equal(
  normalizePulledMarkdown("\\[[Page]]\n\\[[Page|Alias]]\n\\[[Page#Heading]]\n\\[[Page#^block]]\n"),
  "[[Page]]\n[[Page|Alias]]\n[[Page#Heading]]\n[[Page#^block]]\n"
);
assert.equal(normalizePulledMarkdown("\\[[나의 방향과 판단 원칙]]\n"), "[[나의 방향과 판단 원칙]]\n");
assert.equal(normalizePulledMarkdown("\\[\\[나의 방향과 판단 원칙\\]\\]\n"), "[[나의 방향과 판단 원칙]]\n");
assert.equal(normalizePulledMarkdown("\\[\\[Page|Alias\\]\\]\n\\[\\[Page#Heading\\]\\]\n\\[\\[Page#^block\\]\\]\n"), "[[Page|Alias]]\n[[Page#Heading]]\n[[Page#^block]]\n");
assert.equal(normalizePulledMarkdown("!\\[\\[image.png\\]\\]\n\\!\\[\\[image.png\\]\\]\n"), "![[image.png]]\n![[image.png]]\n");
assert.equal(normalizePulledMarkdown("!\\[[image.png]]\n\\![[image.png]]\n"), "![[image.png]]\n![[image.png]]\n");
assert.equal(normalizePulledMarkdown("[[Page]]\n![[image.png]]\n"), "[[Page]]\n![[image.png]]\n");
assert.equal(normalizePulledMarkdown("\\*not a wikilink\\*\n"), "\\*not a wikilink\\*\n");

console.log("mapping normalization checks passed");
