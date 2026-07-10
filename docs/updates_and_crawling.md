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

### Smart Seeding Design
On each run, the crawler seeds the crawl queue using a multi-tiered queue strategy:
* **Live Seeding**: Fetches active lobbies and live games from `aoe10x.com` APIs, queuing currently active players first for maximum freshness.
* **Active Player Seeding**: Appends the most active players in the database (top active from the last 3 days and 30 days) to keep active ranking brackets updated.
* **Background Refresh**: Appends the 20 oldest/never-crawled profiles in the database to the back of the queue.
* **Snowball Discovery**: Whenever a new 10x match is discovered, all players in that match are appended to the queue to trace their histories.

### Dynamic Cooldown Calibration
To ensure players' matches are never missed while avoiding unnecessary queries, the crawler employs a dynamic cooldown filter:
* **0-Hour Cooldown for Live Players**: Any players currently online and active in live lobbies are crawled **immediately**, bypassing any cooldowns.
* **8-Hour Cooldown for Others**: Other players are crawled at most once every 8 hours.

#### The Calibration Math
Our database statistics show:
* **Unique active players (last 3 days)**: ~350 players
* **Unique active players (last 7 days)**: ~800 players
* **Background refresh size**: 20 players per run
* **Cron frequency ($F$)**: 4 hours
* **Cooldown window ($C$)**: 8 hours

The maximum number of eligible players in any single cron run is calculated as:
$$\text{Eligible Players} \approx N_{\text{live}} + \left(N_{\text{active}} \times \frac{F}{C}\right) + N_{\text{refresh}}$$
$$\text{Eligible Players} \approx 20 + \left(350 \times \frac{4}{8}\right) + 20 \approx 215\text{ players}$$

A session limit of **150** is the sweet spot. It ensures that 100% of all live/active players are crawled within a safe 8-hour window without making redundant queries or pulling deeply inactive database records (e.g. if the limit was set to 1000).

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

#### A. Automated Recent Matches Crawl (`crawl:insights`)
Runs an automated snowball crawl session exactly like the Relic crawler, but fetches **Page 1** of recent games for eligible players via the headful scraper.
```bash
# Snowball crawl recent games from Insights (default limit: 10)
pnpm crawl:insights --limit 10
```

#### B. Targeted Scrape / Historical Backfill (`scrape:player`)
Backfills deep history for a specific profile ID across a page range, or crawls recent matches for active database players:
```bash
# Scrape pages 1 through 20 for Clean (profile 11783175)
pnpm scrape:player 11783175 --start-page 1 --end-page 20

# Scrape Page 1 for the top active database players
pnpm scrape:player active --start-page 1 --end-page 1
```

### Crawl Manifest & Overlap Boundaries
To avoid scraping unnecessarily, the AoE2Insights scraper consults `docs/data/crawl_manifest.json`. It tracks the `newest_match_id` and `oldest_match_id` found in our database for each player. Once the scraper encounters games already stored in the local database, it terminates the page fetch for that player immediately.
