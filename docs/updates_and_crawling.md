# Crawling & Data Updates

This document describes the design of the snowball crawler, the CDP scraper, and the dynamic update cycles that feed the AoE2 10x Elo database.

---

## 1. Relic Link API Crawler (Recent Games)

The primary data source is the public Relic Link API. The crawler runs periodically inside a GitHub Actions workflow (every 4 hours).

### Batch Request Strategy
Previously, the crawler queried the Relic API for one player profile at a time, sleeping `250ms` between each. With a limit of 50 players, this required 50 HTTP requests and took ~12.5 seconds.

The crawler now uses the batch endpoint:
```url
https://aoe-api.worldsedgelink.com/community/leaderboard/getRecentMatchHistory?title=age2&profile_ids=[ID1,ID2,...]
```
This allows requesting up to **40 profiles in a single HTTP request**. Consequently, a session limit of **150 players** requires only **4 API requests** and completes in under 5 seconds, reducing server load and avoiding rate limits.

> [!WARNING]
> **Relic API History Limits & Unreliability**:
> According to community observations (shared by Colonel Otto), the Relic API's match history buffer is highly restricted—often keeping only the **most recent 10 games per match type** (e.g. 1v1, Team Random Map)—and can be highly unreliable. This makes the Relic API unsuitable for deep historical backfills and highlights why the AoE2Insights page-by-page scraper is required to recover full player histories.

### Smart Seeding Design
On each run, the crawler seeds the crawl queue using a multi-tiered queue strategy:
* **Live Seeding**: Fetches active lobbies and live games from `aoe10x.com` APIs, queuing currently active players first for maximum freshness.
* **Active Player Seeding**: Appends the most active players in the database (top active from the last 3 days and 30 days) to keep active ranking brackets updated.
* **Background Refresh**: Appends the 20 oldest/never-crawled profiles in the database to the back of the queue.
* **Snowball Discovery**: Whenever a new 10x match is discovered, all players in that match are appended to the queue to trace their histories.

### Dynamic Activity-Based Cooldown Strategy
To ensure players' matches are never missed while avoiding unnecessary queries, the crawler employs a dynamic cooldown filter that scales with player activity in the last 30 days:
* **0-Hour Cooldown for Live Players**: Any players currently online in live lobbies are crawled **immediately** to capture live match finishes.
* **2-Hour Cooldown for Extremely Active Players (`>= 80` matches in last 30d)**: Captures games for power players before they fall off the Relic API's 10-game history buffer.
* **4-Hour Cooldown for Very Active Players (`>= 40` matches in last 30d)**.
* **8-Hour Cooldown for Moderately Active Players (`>= 15` matches in last 30d)**.
* **24-Hour Cooldown for Semi-Active Players (`>= 5` matches in last 30d)**.
* **72-Hour Cooldown for Inactive Players (`< 5` matches in last 30d)**.

This strategy uses the **8-Player Statistical Advantage**: because custom matches always have 8 players, crawling a single active "hub" player automatically captures the game data for the other 7 participants. 

#### Simulation & Calibration Math
A rigorous event-driven simulation (modeling 257,048 player-match observations) compared this dynamic approach against flat cooldown limits:

| Strategy | Crawl Requests | Captured Games | Lost Games | Loss % | Efficiency (Captured/Crawl) |
|---|---|---|---|---|---|
| **Flat 8h Cooldown** | 158,425 | 251,996 | 270 | **0.105%** | 1.591 |
| **Dynamic Cooldown (Implemented)** | 154,497 | 251,302 | 75 | **0.029%** | **1.627** |

The dynamic strategy requires **3,928 fewer crawl requests** than the old 8h flat limit, yet reduces database loss rate by **3.6x** down to a negligible **0.029%**. Consequently, the GHA cron limit of **250** ensures 100% of eligible active players are crawled on each run while saving API request budget.

### Match Data Merging (Enrichment)
Because the two crawlers fetch data from different sources with disjointed fields, the database uses a **smart merge** on duplicate match IDs instead of a flat skip:
* **Map Name Enrichment**: If a match was first crawled via the Relic Link API (which labels custom maps generically as `"my map"`), and is later scraped via AoE2Insights, the database updates the match record with the real custom map name (e.g. `Bamboo Nothing_Paren_V4`).
* **Civilization ID Enrichment**: If a match was first scraped via AoE2Insights (where civilization data is missing for ~90% of matches), and is later crawled via the Relic API, the database populates the missing `civ_id` values on the players.
When a merge occurs, the database updates the match's source flag to `'merged'`.

## 2. AoE2Insights Scraper & Crawler
For map names and deep historical backfills, the crawler includes a Chrome DevTools Protocol (CDP) scraper that pulls game histories directly from AoE2Insights.

### Headful Chrome & Cloudflare Detection
Instead of requiring a pre-running Chrome instance, the scraper **automatically launches a headful Chrome process** on port `19222` with a temporary, isolated user profile (`.chrome-user-data-scraper`).
* **Landing Page**: It starts at `https://rank.10xshared.com/`.
* **Automatic Detection**: It polls the local Chrome targets. As soon as the user navigates to `aoe2insights.com` and solves the Turnstile challenge, the script detects that the tab title contains `"AoE2 Insights"` (and doesn't contain `"Just a moment"` or `"Cloudflare"`). It then waits 3 seconds and attaches the WebSocket debugger session to begin scraping.

### Click-Shield Overlay
While active, the scraper injects a full-screen semi-transparent overlay saying: `"Scraping in progress... Please do not click!"` which captures all click events. Since the scraper performs background fetches on the tab, the overlay remains visible and prevents accidental user navigation during execution.

### Crawling Modes

#### A. Automated Recent Matches Crawl (`crawl`)
Runs an automated snowball crawl session exactly like the Relic crawler, but fetches **Page 1** of recent games for eligible players via the headful scraper.
```bash
# Snowball crawl recent games from Insights (default limit: 80)
elo10x crawl --engine insights --limit 80
```

#### B. Targeted Scrape / Historical Backfill (`scrape`)
Backfills deep history for a specific profile ID across a page range, or crawls recent matches for active database players:
```bash
# Scrape pages 1 through 20 for Clean (profile 11783175)
elo10x scrape 11783175 --start-page 1 --end-page 20

# Scrape Page 1 for the top active database players
elo10x scrape active --start-page 1 --end-page 1
```

### Crawl Manifest & Overlap Boundaries
To avoid scraping unnecessarily, the AoE2Insights scraper consults `docs/data/crawl_manifest.json`. It tracks the `newest_match_id` and `oldest_match_id` found in our database for each player. Once the scraper encounters games already stored in the local database, it terminates the page fetch for that player immediately.
