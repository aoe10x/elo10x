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

---

## 2. AoE2Insights Chrome Scraper (Historical Backfill)

For deep historical backfills, the crawler includes a Chrome DevTools Protocol (CDP) scraper that pulls game history from AoE2Insights.

This requires running a local Chrome instance with debugging enabled:
```bash
# Launch Chrome with remote debugging on macOS:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Then, execute the scraper via the CLI:
```bash
# Scrape matches for top 20 active players
pnpm run crawl -- --scrape-insights active

# Scrape matches for a specific player ID
pnpm run crawl -- --scrape-insights 64605
```

### Crawl Manifest & Overlap Boundaries
To avoid scraping unnecessarily, the AoE2Insights scraper consults `docs/data/crawl_manifest.json`. It tracks the `newest_match_id` and `oldest_match_id` found in our database for each player. Once the scraper encounters games already stored in the local database, it terminates the page fetch for that player immediately.
