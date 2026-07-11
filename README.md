# AoE2 10x Elo Ranking System

This project calculates Elo rankings for the Age of Empires II 10x community (specifically players playing the popular **10x Shared Civ Bonus** mod). It features a snowball crawler to fetch matches from public servers, a Chrome-based CDP scraper to backfill histories from AoE2Insights, and an instantly-loaded pre-rendered static leaderboard website.

---

## Getting Started

### 1. Installation
Clone the repository, install dependencies, and link the CLI binary globally:
```bash
pnpm install
pnpm link --global
```

### 2. Crawling Match History

#### A. Relic Link API Crawler (Recent Games)
Crawls recent match histories for active players using the public Relic Link API.
```bash
# Crawl recent matches for active players (default limit: 150)
elo10x crawl --limit 150
```

#### B. AoE2Insights Scraper (Recent Crawl)
Crawls recent match histories for active players using the AoE2Insights scraper. It automatically launches a headful Chrome window, waits for you to solve the Cloudflare Turnstile verification, and then crawls page 1 of all eligible player matches.
```bash
# Crawl recent matches for active/live players (default limit: 80)
elo10x crawl --engine insights --limit 80
```

#### C. AoE2Insights Scraper (Targeted Scrape / Historical Backfill)
Backfills deep match history for players directly from AoE2Insights. Like the recent crawl, it launches a headful Chrome window automatically.
```bash
# Scrape pages 1 through 20 for Clean (profile ID 11783175)
elo10x scrape 11783175 --start-page 1 --end-page 20

# Scrape recent matches for top 80 active players in the database (default limit: 80)
elo10x scrape active --start-page 1 --end-page 1
```
*Note: The insights scraper uses a click-shield overlay to block accidental interaction while scraping, and a smart crawl manifest to automatically stop fetching pages once it overlaps with matches already stored in your database (see [docs/updates_and_crawling.md](file:///Users/paulirish/code/elo10x/docs/updates_and_crawling.md)).*

### 3. Compute Elo & Compile Static Site
Run the rating calculations and pre-render the entire leaderboard website:
```bash
elo10x elo
```
This script computes Elo ratings and compiles:
*   `docs/index.html` (10x 3x mode)
*   `docs/pure.html` (Pure 10x mode)
*   `docs/combined.html` (Combined mode)
*   `docs/data/players/[profile_id].json` (Downsampled historical data for the details panel charts)

### 4. Run the Leaderboard Dashboard Locally
Launch the lightweight HTTP server to inspect the compiled leaderboard pages:
```bash
pnpm run dev
```
Then open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## Database File Layout

Data is stored under `docs/data/` using line-formatted JSON files to keep Git diffs minimal and deterministic:
*   `matches.json`: Chronologically sorted matches (exactly one match object per line).
*   `profiles.json`: Player profiles containing aliases and countries (sorted by profile ID).
*   `crawl_state.json`: Crawl queue, transient crawl states, and match fingerprints.
*   `crawl_manifest.json`: Crawl boundaries (`newest_match_id`, `oldest_match_id`, and `has_reached_start` markers) used to optimize scraper requests.

---

## Elo Calculation Method

Multiplayer custom matches (such as 2v2, 3v3, and 4v4) are updated using a team Elo formula:
1.  **Chronological Sorting**: Matches are calculated in order of completion time.
2.  **Team Elo Averages**: For each match, the average rating of Team 1 ($R_{avg1}$) and Team 2 ($R_{avg2}$) is calculated.
3.  **Expected Outcome**: Expected scores for both teams are calculated:
    $$E_1 = \frac{1}{1 + 10^{(R_{avg2} - R_{avg1})/400}}$$
    $$E_2 = 1 - E_1$$
4.  **Rating Update**: Individual player ratings are updated using the team outcome:
    $$Rating_{new} = Rating_{old} + K \times (S - E)$$
    *Where $K = 32$, and $S$ is $1$ for a Win or $0$ for a Loss.*

---

## Running Tests

Verify code type safety and execute unit tests:
```bash
pnpm test
```
This runs type checking (`tsc --noEmit`) and the native Node.js test runner for unit tests.
