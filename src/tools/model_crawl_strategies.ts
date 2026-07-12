import { JsonDatabase } from '../db.ts';
import type { Match } from '../types.ts';

interface SimulationResult {
  strategyName: string;
  totalCaptured: number;
  totalLost: number;
  totalCrawls: number;
  lossRatePercent: number;
  efficiency: number; // captured per crawl
}

function runSimulation(
  playerMatches: Map<number, Match[]>,
  bufferLimit: number, // e.g. 10 games
  cronIntervalHr: number, // e.g. 4 hours
  cooldownStrategy: (profileId: number, rolling30dCount: number) => number // returns cooldown in milliseconds
): Omit<SimulationResult, 'strategyName' | 'lossRatePercent' | 'efficiency'> {
  let totalCaptured = 0;
  let totalLost = 0;
  let totalCrawls = 0;

  const cronIntervalSec = cronIntervalHr * 60 * 60;
  const day30Sec = 30 * 24 * 60 * 60;

  for (const [profileId, matches] of playerMatches.entries()) {
    if (matches.length === 0) continue;

    // Sort matches chronologically
    const sorted = [...matches].sort((a, b) => a.startgametime - b.startgametime);

    let lastCrawlTimeSec = 0;

    for (let i = 0; i < sorted.length; i++) {
      const match = sorted[i];
      const matchTimeSec = match.startgametime;

      // Find the next cron tick after this match
      const cronTickSec = Math.ceil(matchTimeSec / cronIntervalSec) * cronIntervalSec;

      // If we already crawled this match in a previous tick, skip
      if (matchTimeSec <= lastCrawlTimeSec) {
        continue;
      }

      // Calculate rolling 30-day match count at the current cron tick
      const windowStartSec = cronTickSec - day30Sec;
      
      let rolling30dCount = 0;
      for (let j = 0; j < sorted.length; j++) {
        const t = sorted[j].startgametime;
        if (t >= windowStartSec && t < cronTickSec) {
          rolling30dCount++;
        }
      }

      // Get cooldown
      const cooldownMs = cooldownStrategy(profileId, rolling30dCount);
      const cooldownSec = cooldownMs / 1000;

      // Check if we crawl at this tick
      if (lastCrawlTimeSec === 0 || (cronTickSec - lastCrawlTimeSec >= cooldownSec)) {
        totalCrawls++;

        // Find all matches played in the interval (lastCrawlTimeSec, cronTickSec]
        let matchesInInterval = 0;
        for (let j = 0; j < sorted.length; j++) {
          const t = sorted[j].startgametime;
          if (t > lastCrawlTimeSec && t <= cronTickSec) {
            matchesInInterval++;
          }
        }

        if (matchesInInterval > bufferLimit) {
          totalCaptured += bufferLimit;
          totalLost += (matchesInInterval - bufferLimit);
        } else {
          totalCaptured += matchesInInterval;
        }

        lastCrawlTimeSec = cronTickSec;
      }
    }
  }

  return { totalCaptured, totalLost, totalCrawls };
}

async function main() {
  console.log('Loading database...');
  const db = new JsonDatabase();
  await db.load();

  const allMatches = db.getMatches();
  console.log(`Loaded ${allMatches.length} matches.`);

  // Group matches by participant profile ID
  const playerMatches = new Map<number, Match[]>();
  let totalPlayerMatchObservations = 0;

  for (const m of allMatches) {
    if (!m.players) continue;
    for (const p of m.players) {
      if (!playerMatches.has(p.profile_id)) {
        playerMatches.set(p.profile_id, []);
      }
      playerMatches.get(p.profile_id)!.push(m);
      totalPlayerMatchObservations++;
    }
  }

  console.log(`Grouped matches for ${playerMatches.size} unique players.`);
  console.log(`Total player match observations: ${totalPlayerMatchObservations}`);

  // Define strategies to test (buffer limit is 10 games, cron runs every 4 hours)
  const bufferLimit = 10;
  const cronIntervalHr = 4;

  const strategies: { name: string; strategy: (profileId: number, rolling30d: number) => number }[] = [
    {
      name: 'Strategy A: Constant 8h cooldown (Previous)',
      strategy: () => 8 * 60 * 60 * 1000
    },
    {
      name: 'Strategy B: Constant 4h cooldown',
      strategy: () => 4 * 60 * 60 * 1000
    },
    {
      name: 'Strategy C: Constant 12h cooldown',
      strategy: () => 12 * 60 * 60 * 1000
    },
    {
      name: 'Strategy D: Constant 24h cooldown',
      strategy: () => 24 * 60 * 60 * 1000
    },
    {
      name: 'Strategy E: Dynamic cooldown (Implemented)',
      strategy: (_, count) => {
        if (count >= 80) return 2 * 60 * 60 * 1000;  // 2h
        if (count >= 40) return 4 * 60 * 60 * 1000;  // 4h
        if (count >= 15) return 8 * 60 * 60 * 1000;  // 8h
        if (count >= 5)  return 24 * 60 * 60 * 1000; // 24h
        return 72 * 60 * 60 * 1000;                  // 72h
      }
    },
    {
      name: 'Strategy F: Aggressive Dynamic cooldown',
      strategy: (_, count) => {
        if (count >= 50) return 2 * 60 * 60 * 1000;  // 2h
        if (count >= 20) return 4 * 60 * 60 * 1000;  // 4h
        if (count >= 10) return 8 * 60 * 60 * 1000;  // 8h
        return 24 * 60 * 60 * 1000;                  // 24h
      }
    }
  ];

  console.log(`\nStarting simulation (Cron interval: ${cronIntervalHr}h, Relic buffer limit: ${bufferLimit} games)...`);

  const results: SimulationResult[] = [];
  for (const s of strategies) {
    const startSim = Date.now();
    const res = runSimulation(playerMatches, bufferLimit, cronIntervalHr, s.strategy);
    const lossRatePercent = (res.totalLost / totalPlayerMatchObservations) * 100;
    const efficiency = res.totalCaptured / res.totalCrawls;
    results.push({
      strategyName: s.name,
      ...res,
      lossRatePercent,
      efficiency
    });
    console.log(`Finished ${s.name} in ${((Date.now() - startSim) / 1000).toFixed(2)}s`);
  }

  console.log('\n========================================================================================');
  console.log('CRAWL STRATEGY SIMULATION RESULTS');
  console.log('========================================================================================');
  console.log(
    'Strategy'.padEnd(42) + 
    ' | Crawls'.padStart(10) + 
    ' | Captured'.padStart(10) + 
    ' | Lost'.padStart(8) + 
    ' | Loss %'.padStart(10) + 
    ' | Efficiency'.padStart(12)
  );
  console.log('----------------------------------------------------------------------------------------');
  for (const r of results) {
    console.log(
      r.strategyName.padEnd(42) +
      ` | ${r.totalCrawls.toString().padStart(8)}` +
      ` | ${r.totalCaptured.toString().padStart(8)}` +
      ` | ${r.totalLost.toString().padStart(6)}` +
      ` | ${r.lossRatePercent.toFixed(3).padStart(8)}%` +
      ` | ${r.efficiency.toFixed(3).padStart(10)}`
    );
  }
  console.log('========================================================================================');
}

main().catch(console.error);
