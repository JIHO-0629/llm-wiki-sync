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
  entryPoints: [path.resolve("sync/baseline.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["obsidian"],
  write: false
});
const module = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, require);
const { compareSnapshotsToBaseline, getSyncChangeState, normalizeSyncBody } = module.exports;

assert.equal(getSyncChangeState(false, false), "CLEAN");
assert.equal(getSyncChangeState(true, false), "LOCAL_ONLY_CHANGED");
assert.equal(getSyncChangeState(false, true), "REMOTE_ONLY_CHANGED");
assert.equal(getSyncChangeState(true, true), "CONFLICT");

assert.equal(normalizeSyncBody("a\r\nb\n\n"), "a\nb\n");
assert.equal(normalizeSyncBody(""), "\n");

const baseline = {
  notionPageId: "page",
  localFingerprint: "local-a",
  remoteFingerprint: "remote-a",
  localTitle: "Local",
  remoteTitle: "Remote",
  localMtime: 1,
  remoteLastEditedTime: "2026-08-14T00:00:00.000Z",
  syncedAt: "2026-08-14T00:00:00.000Z",
  schemaVersion: 1
};
const localA = { title: "Local", body: "a\n", fingerprint: "local-a", mtime: 1 };
const localB = { title: "Local 2", body: "a\n", fingerprint: "local-b", mtime: 2 };
const remoteA = { title: "Remote", body: "a\n", fingerprint: "remote-a", lastEditedTime: "2026-08-14T00:00:00.000Z" };
const remoteB = { title: "Remote 2", body: "a\n", fingerprint: "remote-b", lastEditedTime: "2026-08-14T00:00:01.000Z" };

assert.equal(compareSnapshotsToBaseline(baseline, localA, remoteA).state, "CLEAN");
assert.equal(compareSnapshotsToBaseline(baseline, localB, remoteA).state, "LOCAL_ONLY_CHANGED");
assert.equal(compareSnapshotsToBaseline(baseline, localA, remoteB).state, "REMOTE_ONLY_CHANGED");
assert.equal(compareSnapshotsToBaseline(baseline, localB, remoteB).state, "CONFLICT");

console.log("baseline checks passed");
