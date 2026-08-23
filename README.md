# LLM Wiki Sync

Bidirectional synchronization between Obsidian Markdown notes and Notion pages with explicit conflict protection.

## Overview

LLM Wiki Sync is an Obsidian desktop plugin for manual, safety-first synchronization between local Markdown notes and Notion pages. It is designed around stable page identity, persisted sync baselines, and explicit user decisions when both sides changed.

## Features

- Obsidian <-> Notion bidirectional note synchronization
- Persistent `notion_page_id` mapping
- Body synchronization
- Title and filename synchronization
- `Sync current note` automatic direction detection
- Sync folder with Notion using a folder picker
- Sync entire vault with Notion
- Obsidian folder hierarchy reconciliation to Notion pages
- Persisted synchronization baseline
- Conflict detection
- Explicit `Keep Obsidian` and `Keep Notion` resolution
- Filename and path safety checks
- Duplicate mapping protection
- Network and API failure safety

## How Synchronization Works

Each linked note stores a `notion_page_id` in local frontmatter. The plugin uses that ID as the stable identity for the Notion page, so local filename changes do not break the mapping.

After a successful full sync, the plugin stores a synchronization baseline in plugin data. The baseline contains independent local and remote fingerprints. Those fingerprints include both title and body content.

On the next sync, LLM Wiki Sync compares the current local state against the baseline local state, and the current Notion state against the baseline remote state. It uses one four-state model:

- `CLEAN`
- `LOCAL_ONLY_CHANGED`
- `REMOTE_ONLY_CHANGED`
- `CONFLICT`

`Sync current note` pushes or pulls only when one side changed. If both sides changed, it stops and asks the user to choose which version to keep.

## Installation

LLM Wiki Sync is available in the official Obsidian Community Plugins directory.

### Community Plugins

1. Open `Settings -> Community plugins`.
2. Select `Browse`.
3. Search for `LLM Wiki Sync`.
4. Click `Install`.
5. Click `Enable`.

Current public release: **v0.8.2**.

### Manual Installation

For development or manual testing, place the plugin folder at:

```text
<vault>/.obsidian/plugins/llm-wiki-sync

## Notion Setup

1. Create a Notion integration.
2. Give the integration access to the root page you want to sync under.
3. Copy the integration API token.
4. Copy the Notion root page URL or page ID.

Use a placeholder such as `YOUR_NOTION_TOKEN` in examples. Do not commit real tokens.

## First-Time Setup

1. Open Settings -> LLM Wiki Sync.
2. Paste the Notion API token.
3. Enter the Notion root page URL or ID.
4. Click `Test Notion connection`.

For old notes that already have `notion_page_id` but no v0.6 baseline, run `Initialize sync baseline` once before normal syncing.

## Normal Usage

1. Open an Obsidian note.
2. Click `Sync current note`.
3. Use `Sync folder with Notion` to choose a folder and reconcile that folder with Notion.
4. Use `Sync entire vault` to reconcile the vault root.
5. If a conflict appears, choose which version to keep:
   - `Keep Obsidian`
   - `Keep Notion`

Unlinked local notes are created under the matching Notion folder hierarchy. Linked notes sync in the safe direction determined by the baseline state.

## Folder Sync

Use `Sync folder with Notion` to choose the vault root or any nested folder. The selected folder and its subfolders become the sync scope.

Folder sync performs a conservative reconciliation workflow:

- Scans the local Obsidian Markdown tree.
- Scans the matching Notion tree recursively.
- Validates folder mappings and linked note parents.
- Creates missing Notion folder pages.
- Moves valid linked Notion pages to the expected folder parent when the target is unambiguous.
- Creates or updates notes using the existing baseline conflict model.
- Re-fetches Notion hierarchy before making any Review decision.

During folder and entire-vault sync, a progress modal shows the current phase, current note or folder, processed note count, elapsed time, and live counters. A global sync lock prevents overlapping sync, push, repair, initialize, and audit operations while a sync run is active.

It does not delete Obsidian files, trash Notion pages, or automatically resolve conflicts. Ambiguous identity cases are reported and skipped.

## Bulk Push

Use `Push current folder to Notion` to export the active Markdown note's folder and subfolders. If the active note is in the vault root, the vault root is used.

Use `Push entire vault to Notion` to export all supported Markdown notes in the vault after confirmation. Folder hierarchy is preserved by creating Notion pages for folders from top to bottom, then creating Markdown note pages under their corresponding folder pages.

Bulk push keeps the same baseline conflict protection as single-note push:

- Clean linked notes are skipped.
- Locally changed linked notes update Notion.
- Remotely changed linked notes are skipped.
- Conflicted linked notes are skipped.
- Unlinked Markdown notes are created in Notion, then receive local `notion_page_id` frontmatter and a normal sync baseline.

Folder-to-Notion page mappings are stored in plugin data, not in Markdown frontmatter. They are scoped to the configured Notion root page, so changing the root page creates or reuses a separate folder hierarchy. The vault root maps to the configured Notion root page and does not create an extra folder page.

## Review Area

Folder sync may create `LLM Wiki Sync Review` under the configured Notion root. A previously synced Notion page is moved to `LLM Wiki Sync Review/Obsidian missing` only when it has a sync baseline, has no local mapped note in the selected scope after mutation re-validation, and is not ambiguous. Unknown remote-only pages are reported, not moved.

## Conflict Handling

The plugin does not automatically merge or choose the newest version. If both Obsidian and Notion changed since the last baseline, sync is blocked.

Use:

- `Resolve conflict — Keep Obsidian`
- `Resolve conflict — Keep Notion`

After a successful resolution, the baseline is refreshed and the state returns to clean.

## Advanced Commands

Advanced commands remain available from the command palette:

- `Push to Notion`
- `LLM Wiki Sync: Sync folder with Notion`
- `LLM Wiki Sync: Sync entire vault with Notion`
- `LLM Wiki Sync: Push current folder to Notion`
- `LLM Wiki Sync: Push entire vault to Notion`
- `LLM Wiki Sync: Audit current folder hierarchy`
- `LLM Wiki Sync: Audit entire vault hierarchy`
- `LLM Wiki Sync: Initialize current folder mappings`
- `LLM Wiki Sync: Initialize entire vault mappings`
- `Pull from Notion`
- `Initialize sync baseline`
- `Debug active mapping`
- `Debug sync state`

These are intended for troubleshooting, migration, and explicit manual control. `Sync current note` is the recommended normal workflow.

## Safety Model

LLM Wiki Sync is designed to avoid silent overwrites:

- `notion_page_id` is the canonical mapping key.
- Duplicate local mappings are blocked.
- Current local and remote states are compared only against the persisted baseline.
- Conflict state never writes either side.
- Baselines advance only after complete successful operations.
- Rename collisions stop the rename and do not overwrite files.
- Filenames are sanitized for Windows/path safety and path traversal protection.
- Failed API calls do not create a fake clean state.
- Bulk push processes files sequentially and continues after individual file failures.
- Bulk push excludes `LLM Wiki Sync Pull/` and `LLM Wiki Sync Review/` by default to avoid pushing system copies as duplicate hierarchy.
- Folder and vault sync use a run-scoped Notion API cache only for the active sync run. The cache is discarded afterward and invalidated after relevant mutations.

## Known Limitations

- Sync is manual, not background or real-time.
- v0.8.2 folder sync focuses on safe Obsidian-to-Notion hierarchy reconciliation plus baseline-protected note sync, with progress display and run-scoped performance caching.
- Pull remains limited to its existing direct-child behavior and does not recreate recursive Notion hierarchy locally.
- Folder rename identity recovery is limited; a renamed folder with no stored mapping may be treated as a new folder.
- There is no standalone page numbering system in this repository; `notion_page_id` and sync baselines remain the identity mechanisms.
- Images and attachments are not synchronized.
- Notion database/data-source synchronization is not supported.
- Standalone `.yaml` and `.yml` files are not synchronized; Obsidian YAML frontmatter in Markdown notes is preserved for local mapping metadata.
- Deletion synchronization is not implemented.
- Conflict resolution selects one complete version rather than merging line-by-line.
- The plugin is desktop-only because it relies on desktop-compatible bundled code and Node.js hashing.

## Privacy / Network Access

The Notion token is stored through Obsidian SecretStorage when available. It is not stored in plugin `data.json`.

The plugin sends requests to the Notion API only when the user runs connection testing, sync, folder sync, pull, push, bulk push, baseline initialization, debug lookup, or conflict resolution commands. It does not use analytics or telemetry.

Plugin `data.json` may contain Notion page IDs, folder mappings, root page configuration, sync baselines, Review quarantine records, and fingerprints. Do not publish user-specific plugin data.

## Development / Build

From the plugin folder:

```bash
npm run build
```

The local Obsidian plugin needs `main.js` to run. Treat `main.js` as a generated release/build artifact according to the repository release workflow.

## Version

0.8.2

## License

LLM Wiki Sync is licensed under the GNU General Public License v3.0 (`GPL-3.0-only`).
