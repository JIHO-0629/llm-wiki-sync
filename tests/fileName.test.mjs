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

const result = esbuild.buildSync({
  entryPoints: [path.resolve("utils/fileName.ts")], bundle: true, platform: "node", format: "cjs", write: false
});
const module = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
const { sanitizeNotionTitleForFileName } = module.exports;

for (const title of ["../danger", "..\\danger", "...danger", " ../danger "]) {
  const output = sanitizeNotionTitleForFileName(title);
  assert.ok(output && !output.startsWith("."), `${title} must produce a visible filename`);
}
assert.equal(sanitizeNotionTitleForFileName("../danger").startsWith("."), false);
assert.equal(sanitizeNotionTitleForFileName("..\\danger").startsWith("."), false);
assert.equal(sanitizeNotionTitleForFileName("...danger").startsWith("."), false);
assert.equal(sanitizeNotionTitleForFileName("."), null);
assert.equal(sanitizeNotionTitleForFileName(".."), null);
assert.equal(sanitizeNotionTitleForFileName("normal.file"), "normal.file.md");
assert.equal(sanitizeNotionTitleForFileName("심계항진.md"), "심계항진.md");
const windowsSafe = sanitizeNotionTitleForFileName("Test: A/B?");
assert.ok(windowsSafe && !/[<>:"/\\|?*]/.test(windowsSafe) && windowsSafe.endsWith(".md"));
console.log("fileName sanitizer checks passed");
