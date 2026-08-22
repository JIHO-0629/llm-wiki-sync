# Changelog

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
