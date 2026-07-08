# AoE2 10x Elo Ranking System

This project calculates Elo rankings for the Age of Empires II 10x community (specifically players playing the popular **10x Shared Civ Bonus** mod). It features a snowball crawler to fetch matches from public servers, a Chrome-based CDP scraper to backfill histories from AoE2Insights, and an instantly-loaded pre-rendered static leaderboard website.

---

## Getting Started

### 1. Installation
Clone the repository and install dependencies:
```bash
pnpm install
```

### 2. Crawling Match History

#### A. Relic Link API Crawler (Recent Games)
Crawls recent match histories for active players using the public Relic Link API.
```bash
# Crawl recent matches for active players (default limit: 50)
pnpm run crawl -- --limit 50

# Custom months cutoff (e.g. last 6 months)
pnpm run crawl -- --limit 50 --months 6
```

#### B. AoE2Insights Chrome Scraper (Historical Backfill)
Backfills deep match history for players directly from AoE2Insights. This requires having a Chrome instance open with remote debugging enabled on port `9222`:
```bash
# Launch Chrome with remote debugging on macOS:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Scrape matches for top 20 active players
pnpm run crawl -- --scrape-insights active

# Scrape matches for a specific player ID
pnpm run crawl -- --scrape-insights 64605
```
*Note: The insights scraper uses a smart crawl manifest to automatically stop fetching pages once it overlaps with matches already stored in your database.*

### 3. Compute Elo & Compile Static Site
Run the rating calculations and pre-render the entire leaderboard website:
```bash
pnpm run elo
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
