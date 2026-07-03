# AoE2 10x ELO Ranking System

This project calculates ELO rankings for the Age of Empires II 10x community (specifically players playing the popular **10x Shared Civ Bonus** mod). It features a snowball crawler to fetch matches from public servers, a multiplayer ELO calculator, and an interactive local web dashboard.

Built using Node.js's native TypeScript execution capabilities (`--experimental-strip-types`), strict dependency checking, and the built-in Node test runner.

---

## Technical Stack

*   **Runtime**: Node.js (>= 22.20.0) with native TS stripping.
*   **Package Manager**: `pnpm`
*   **Type Checker**: TypeScript (using `tsc --noEmit` to keep development buildless).
*   **Test Runner**: Native Node.js test runner (`node --test`).
*   **Storage**: Portable, file-based database (`data/db.json`) for zero native build dependencies.

---

## Getting Started

### 1. Installation
Clone the repository and install dependencies:
```bash
pnpm install
```

### 2. Crawling Match History
The crawler uses a snowball methodology. It seeds player IDs from active lobbies on `aoe10x.com` and then queries player match histories on the Relic Link API, filtering for matches matching `description` regex `/10x/i` played in the last 3 months.
```bash
# Seed from active lobbies and crawl 50 players (default)
pnpm run crawl -- --seed

# Crawl another 100 players from the queue
pnpm run crawl -- --limit 100

# Custom months cutoff (e.g. last 6 months)
pnpm run crawl -- --limit 50 --months 6
```
*Note: The crawler implements a 250ms delay between requests (~4 requests/second) to respect Relic API rate limits.*

### 3. Compute ELO Ratings
Calculate rankings from the match database and generate a leaderboard:
```bash
# Standard calculation (min 5 games to show on leaderboard)
pnpm run elo

# Show all players, including provisional players (1+ games)
pnpm run elo -- --provisional --min-games 1
```
This prints the top rankings to the console and outputs `data/leaderboard.json` for the web dashboard.

### 4. Run the Leaderboard Dashboard
Launch the lightweight HTTP server to inspect player ratings in a browser:
```bash
pnpm run dev
```
Then open [http://localhost:3000](http://localhost:3000) in your web browser.
*   **Search**: Real-time client-side search filtering.
*   **Thresholds**: Adjust minimum games and toggle provisional players in real-time.
*   **Profile Details**: Click on any row to open details showing game counts, wins, losses, win-rate meters, and a deep link to their matches on `aoe2insights.com`.

---

## ELO Calculation Method

Multiplayer custom matches (such as 2v2, 3v3, and 4v4) are updated using a team ELO formula:
1.  **chronological sorting**: All crawled games are sorted by their start time.
2.  **Team ELO Averages**: For each match, the average ELO of Team 1 ($R_{avg1}$) and Team 2 ($R_{avg2}$) is calculated.
3.  **Expected Outcome**: Expected scores for both teams are calculated:
    $$E_1 = \frac{1}{1 + 10^{(R_{avg2} - R_{avg1})/400}}$$
    $$E_2 = 1 - E_1$$
4.  **Rating Update**: Individual player ratings are updated using the team outcome:
    $$Rating_{new} = Rating_{old} + K \times (S - E)$$
    *Where $K = 32$, and $S$ is $1$ for a Win or $0$ for a Loss.*

---

## Running Tests

Verify code typecheck and execute unit tests:
```bash
pnpm test
```
This runs `tsc --noEmit` and executes the unit tests in `test/elo.test.ts`.
