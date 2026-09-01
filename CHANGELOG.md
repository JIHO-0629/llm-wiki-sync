# Changelog

## 0.9.0

- Added the v0.9 Markdown conversion safety layer, including fail-closed handling for unsupported or malformed content.
- Added bidirectional Notion callout conversion and lossless Notion table-of-contents transport markers.
- Added conservative media identity, Pull, and Push support with regression coverage.
- Preserved hierarchy safety, folder mapping ambiguity protection, and baseline conflict checks during Pull and Push.

## 0.8.5

- Fixed legacy dual note/folder mappings that caused valid Notion container hierarchies to be skipped as ambiguous during Pull.

## 0.8.4

- Added Notion -> Obsidian vault-root hierarchy reconciliation.
- Represented hybrid Notion parent pages as `folder/_index.md`.
- Migrated legacy `LLM Wiki Sync Pull` paths into the canonical vault hierarchy.
- Added safe `container_index` handling across normal sync, push, folder sync, baseline initialization, and conflict resolution.
- Restored escaped Obsidian wikilinks from Notion Markdown.
- Kept Obsidian frontmatter local instead of pushing YAML metadata to Notion.

## 0.8.2

- Published in the official Obsidian Community Plugins directory.
- Added a live progress modal for folder and entire-vault sync with phases, current item, elapsed time, and running counters.
- Added a global sync execution lock so sync, push, repair, initialize, and audit entry points do not overlap with an active sync run.
- Added phase timing diagnostics for folder sync when verbose debug logging is enabled.
- Added run-scoped Notion API caching for page details, child page listings, and resolved folder parents, with invalidation after create, move, title, and body mutations.
- Reduced repeated folder parent resolution for many notes in the same folder while preserving second-pass Notion verification and v0.8.1 orphan safety checks.

## 0.8.1

- Added a safe `Sync folder with Notion` workflow that reconciles Obsidian folders and linked Notion page parents before syncing note content.
- Added a folder picker so folder sync can run without relying on the active note.
- Made single-note Push create new pages under the matching Notion folder hierarchy instead of always using the configured root page directly.
- Added hierarchy-aware linked-page movement for the folder sync workflow while preserving `notion_page_id` and sync baselines.
- Added conservative Review quarantine records for previously synced Notion pages that remain missing from the selected Obsidian scope after a second validation pass.
- Kept ambiguous remote/local identity cases read-only and reported instead of guessing or deleting.
- Added folder sync regression coverage for nested hierarchy, linked page moves, single-note parent resolution, Review behavior, duplicate mapping safety, and large workloads.

## 0.8.0

- Added safe bulk push from Obsidian to Notion for the current folder or entire vault.
- Preserved Obsidian folder hierarchy by creating folder pages in Notion from top to bottom.
- Added persistent folder-to-Notion page mappings in plugin data.
- Refactored single-note Push to use a reusable file-based push operation.
- Kept existing baseline conflict protection for linked notes during bulk push.
- Excluded non-Markdown files and `LLM Wiki Sync Pull/` from bulk push.
- Documented that recursive hierarchy support is currently Obsidian -> Notion only; Pull remains limited to existing behavior.
- Added bulk push regression coverage for hierarchy, exclusions, mappings, conflict safety, failure continuation, and native Markdown page creation.

## 0.7.1

- Updated the plugin manifest description to satisfy Obsidian Community automated review.
- Bumped release metadata from 0.7.0 to 0.7.1.

## 0.7.0

- Fixed new Notion page creation for Markdown documents with more than 100 blocks/sections.
- Replaced the legacy custom Markdown-to-block conversion path with Notion API 2026-03-11 native Markdown page creation.
- Preserved existing Notion page updates through `/v1/pages/{id}/markdown`.
- Added a regression test that verifies large Markdown documents are sent without silent truncation.
- Updated Obsidian Community Plugin metadata, including `minAppVersion` and `versions.json`.
- Replaced background note writes with `Vault.process()` where sync writes fetched Notion content into local Markdown files.
- Moved status bar cursor styling into `styles.css` and removed development-only production logging.

## 0.6.0

- Added bidirectional Notion/Obsidian synchronization.
- Added persistent `notion_page_id` mapping.
- Added existing document updates in both directions.
- Added title and filename synchronization.
- Added safe filename and path traversal protection.
- Added persisted baseline change detection.
- Added stale Push/Pull protection and conflict prevention.
- Added explicit conflict resolution with Keep Obsidian and Keep Notion.
- Added Sync current note automatic safe routing.
- Added settings, ribbon, status bar, and conflict UI improvements.
- Improved API/network and partial-operation failure safety.
