# Leaderboard Migration Plan: Line-Formatted JSON Arrays & Static Site Generation (SSG)

This document outlines the implementation plan for our high-performance ELO leaderboard.

---

## Phase 1: Database Migration to Line-Formatted JSON Arrays
Instead of a single monolithic JSON blob, we split the database into two separate files that are fully valid JSON arrays, but formatted with exactly one object per line (comma-separated).

### Target Files:
*   `data/matches.json`: Sorted chronological list of matches.
    ```json
    [
    {"id": 1, "startgametime": 1700000000, ...},
    {"id": 2, "startgametime": 1700000001, ...}
    ]
    ```
*   `data/profiles.json`: List of player profiles.
    ```json
    [
    {"profile_id": 123, "alias": "Dayman", ...},
    {"profile_id": 456, "alias": "Nightman", ...}
    ]
    ```

### Tasks:
1.  **JSON Array Generator Parser**: Implement an ES6 async generator in `src/db.ts` to stream-read files line-by-line, stripping array brackets and trailing commas to run `JSON.parse()`.
2.  **Line-by-Line Serializer**: Write a custom writer that saves arrays formatting each item on its own line.
3.  **Migration Script**: Write a script `src/tools/migrate_db_to_json_lines.ts` to convert `docs/data/db.json` to `data/matches.json` and `data/profiles.json`.
4.  **Refactor Crawler**: Update `src/db.ts` and `src/crawler.ts` to use the new file-based database model.

---

## Phase 2: Static Site Generation (SSG)
We pre-render the leaderboard HTML tables in GitHub Actions.

### Tasks:
1.  **Server-Side Compiler (`src/compile.ts`)**:
    *   Loads matches using the generator.
    *   Calculates ELO ratings and dynamic profile merges.
    *   Downsamples ELO rating history for each player to max 100 points.
    *   Generates pre-rendered SVG sparklines and table rows.
    *   Outputs the static pages: `docs/index.html` (10x3x), `docs/pure.html` (10x), and `docs/combined.html` (Combined).
2.  **On-Demand Player Details**:
    *   Write player-specific detailed histories into `docs/data/players/[profile_id].json` (~4KB each).
3.  **Lightweight Frontend**:
    *   Update template to use CSS display toggles for search bar filtering.
    *   Fetch player details JSON dynamically when a row is expanded.
