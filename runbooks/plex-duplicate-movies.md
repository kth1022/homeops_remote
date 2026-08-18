# Plex Duplicate Movie Reports

Use the read-only scanner to find movie titles where Plex sees more than one version or duplicate library item.

```powershell
node .\scripts\Find-PlexDuplicateMovies.js
```

From SocketAgent/HomeOps tools:

```powershell
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates scan
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates status
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates progress
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates preview
```

The scanner writes timestamped reports to `reports`:

- `plex-duplicate-movies-*.md` for review in a text editor
- `plex-duplicate-movies-*.html` for browser review
- `plex-duplicate-movies-*.csv` for sorting/filtering
- `plex-duplicate-movies-*.json` for automation

It also refreshes `plex-duplicate-movies-latest.*` copies.

## Safety

This scan is report-only. It does not delete, move, rename, or edit media files.

Review the `REMOVE CANDIDATE` paths before taking action. Cleanup is staged:

1. Mark individual rows `approved` or `ignored`.
   Use `swapped` when the files are duplicates but the listed remove candidate is the one to keep.
2. Preview the quarantine plan.
3. Run quarantine only with `confirm=QUARANTINE`.
4. Rescan Plex and verify playback/metadata.
   If playback fails, record an issue. Restore the quarantined duplicate only with `confirm=RESTORE`; this moves the failed kept file back into quarantine and requests another Plex rescan.
5. Final deletion remains separately gated with `DELETE`.

Cleanup plans list the source folders that removed files came from. During quarantine, those source folders are removed only when they are safely under the Plex media tree and no movie files remain in that folder tree.

Command examples:

```powershell
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates decision <rowId> approved
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates decision <rowId> swapped keep_candidate
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates decision <rowId> ignored not_same_movie
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates quarantine
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates issue-item <verificationKey> distorted image
node .\third-party\socketagent\server\tools\homeops-tools.js plex-duplicates restore-item <verificationKey> RESTORE distorted image
```

## Ranking

The keep candidate is ranked by resolution, HDR/dynamic-range metadata, video codec, bitrate, audio channels, file size, and Plex added date.

Rows marked `manual-review` should not be treated as obvious cleanup candidates. Common reasons are mixed editions, title/year-only matches, or very similar quality scores.
