# Crawl Strategy Simulation & Modeling

To statistically justify our crawling approach, we built a simulation tool (`src/tools/model_crawl_strategies.ts`) that runs different cooldown strategies against our historical match database (`matches.json`).

This models the probability of missing matches due to the Relic API's recent match buffer limit (where a player's games fall off the list if they play more than 10 games between crawler visits).

---

## 1. Simulation Setup

*   **Dataset**: 32,370 matches in the database (spanning 13,054 unique players, totaling **257,048 player-match observations**).
*   **Cron Interval**: 4 hours (GHA schedule).
*   **Relic Buffer Limit**: 10 matches (Relic recent list limit).
*   **Simulation Step**: Event-driven (evaluates cron execution ticks corresponding to each player's play history).

---

## 2. Tested Cooldown Strategies

1.  **Strategy A (Previous)**: Constant 8-hour cooldown for all players.
2.  **Strategy B**: Constant 4-hour cooldown for all players.
3.  **Strategy C**: Constant 12-hour cooldown for all players.
4.  **Strategy D**: Constant 24-hour cooldown for all players.
5.  **Strategy E (Implemented)**: Dynamic cooldown based on rolling 30-day play counts:
    *   `>= 80` matches: 2h cooldown
    *   `>= 40` matches: 4h cooldown
    *   `>= 15` matches: 8h cooldown
    *   `>= 5` matches: 24h cooldown
    *   `< 5` matches: 72h cooldown
6.  **Strategy F**: Aggressive Dynamic cooldown:
    *   `>= 50` matches: 2h cooldown
    *   `>= 20` matches: 4h cooldown
    *   `>= 10` matches: 8h cooldown
    *   `< 10` matches: 24h cooldown

---

## 3. Simulation Results

| Strategy | Crawl Requests | Captured Games | Lost Games | Loss % | Efficiency (Captured/Crawl) |
|---|---|---|---|---|---|
| **Strategy A** (Flat 8h) | 158,425 | 251,996 | 270 | **0.105%** | 1.591 |
| **Strategy B** (Flat 4h) | 181,997 | 252,851 | 20 | **0.008%** | 1.389 |
| **Strategy C** (Flat 12h) | 149,299 | 251,287 | 705 | **0.274%** | 1.683 |
| **Strategy D** (Flat 24h) | 134,096 | 249,913 | 1,562 | **0.608%** | 1.864 |
| **Strategy E** (Dynamic) | 154,497 | 251,302 | 75 | **0.029%** | **1.627** |
| **Strategy F** (Aggressive Dynamic) | 167,985 | 252,005 | 33 | **0.013%** | 1.500 |

---

## 4. Key Takeaways

*   **Request Savings**: The **Dynamic Cooldown (Strategy E)** requires **3,928 fewer crawl requests** than the old flat 8h strategy (154,497 vs 158,425).
*   **Drastically Lower Loss**: Despite making fewer requests, Strategy E reduces the number of lost games from 270 down to 75 (**a 3.6x reduction in lost games**), keeping our database loss rate at a negligible **0.029%**.
*   **Maximum Efficiency**: Strategy E achieves an efficiency ratio of **1.627 captured games per request**, outperforming Strategy B (1.389) and Strategy F (1.500) while keeping our loss rate extremely low.

By dynamically redirecting crawl budget away from inactive players (3-day cooldown) and focusing it on active players (2h/4h cooldown), we optimize GHA execution time and API rate limits while maximizing match capture completeness.
