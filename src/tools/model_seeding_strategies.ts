import { JsonDatabase } from '../db.ts';
import type { Match } from '../types.ts';

interface SeedingSimulationResult {
  strategyName: string;
  totalCaptured: number;
  totalLost: number;
  totalCrawls: number;
  lossRatePercent: number;
  avgCrawlIntervalActiveDays: number; // Avg crawl interval for active players (>15 games/30d)
  avgCrawlIntervalInactiveDays: number; // Avg crawl interval for inactive players (<5 games/30d)
}

function runSeedingSimulation(
  playerMatches: Map<number, Match[]>,
  globalMatches: Match[], // Globally sorted matches
  candidatePlayerIds: number[], // Optimized candidate list
  bufferLimit: number, // 10 games
  cronIntervalHr: number, // 4 hours
  limitCount: number, // e.g. 250 players per run
  cooldownStrategy: (rolling30d: number) => number,
  seedingStrategy: (
    playerIds: number[],
    lastCrawlTimes: Map<number, number>,
    rolling30dCounts: Map<number, number>,
    nowSecs: number,
    limit: number
  ) => number[] // returns seeded queue
): Omit<SeedingSimulationResult, 'strategyName' | 'lossRatePercent'> {
  let totalCaptured = 0;
  let totalLost = 0;
  let totalCrawls = 0;

  const cronIntervalSec = cronIntervalHr * 60 * 60;
  const day30Sec = 30 * 24 * 60 * 60;

  // Initialize simulation states
  const lastCrawlTimes = new Map<number, number>();
  
  // Track crawl intervals to check for starvation
  const crawlIntervalsActive: number[] = [];
  const crawlIntervalsInactive: number[] = [];

  // Find global start and end times across all matches
  let globalStartSec = Infinity;
  let globalEndSec = 0;
  for (const matches of playerMatches.values()) {
    for (const m of matches) {
      if (m.startgametime < globalStartSec) globalStartSec = m.startgametime;
      if (m.startgametime > globalEndSec) globalEndSec = m.startgametime;
    }
  }

  // Seed initial crawl times to 30 days before global start (so they are stale and ready)
  for (const pid of candidatePlayerIds) {
    lastCrawlTimes.set(pid, globalStartSec - day30Sec);
  }

  const candidateSet = new Set(candidatePlayerIds);
  const rolling30dCounts = new Map<number, number>();
  let leftMatchIdx = 0;
  let rightMatchIdx = 0;

  // Step through time in 4-hour cron increments
  for (let nowSec = globalStartSec; nowSec <= globalEndSec; nowSec += cronIntervalSec) {
    const windowStartSec = nowSec - day30Sec;
    
    // Add matches that have entered the window
    while (rightMatchIdx < globalMatches.length && globalMatches[rightMatchIdx].startgametime < nowSec) {
      const m = globalMatches[rightMatchIdx];
      if (m.players) {
        for (const p of m.players) {
          if (candidateSet.has(p.profile_id)) {
            rolling30dCounts.set(p.profile_id, (rolling30dCounts.get(p.profile_id) || 0) + 1);
          }
        }
      }
      rightMatchIdx++;
    }
    
    // Remove matches that have exited the window
    while (leftMatchIdx < globalMatches.length && globalMatches[leftMatchIdx].startgametime < windowStartSec) {
      const m = globalMatches[leftMatchIdx];
      if (m.players) {
        for (const p of m.players) {
          if (candidateSet.has(p.profile_id)) {
            const cur = rolling30dCounts.get(p.profile_id) || 0;
            if (cur <= 1) {
              rolling30dCounts.delete(p.profile_id);
            } else {
              rolling30dCounts.set(p.profile_id, cur - 1);
            }
          }
        }
      }
      leftMatchIdx++;
    }

    // 2. Run the seeding strategy to get the priority queue
    const queue = seedingStrategy(candidatePlayerIds, lastCrawlTimes, rolling30dCounts, nowSec, limitCount);

    // 3. Process the queue up to limitCount crawled players
    let crawledThisCron = 0;
    for (const pid of queue) {
      if (crawledThisCron >= limitCount) break;

      const lastCrawlSec = lastCrawlTimes.get(pid) || 0;
      const activity = rolling30dCounts.get(pid) || 0;
      
      // Cooldown check
      const cooldownSec = cooldownStrategy(activity) / 1000;
      if (nowSec - lastCrawlSec >= cooldownSec) {
        // Perform crawl
        totalCrawls++;
        crawledThisCron++;

        // Track crawl interval for starvation metrics
        const intervalDays = (nowSec - lastCrawlSec) / (24 * 3600);
        if (activity >= 15) {
          crawlIntervalsActive.push(intervalDays);
        } else {
          crawlIntervalsInactive.push(intervalDays);
        }

        // Fetch matches played in interval
        const matches = playerMatches.get(pid) || [];
        const matchesInInterval = matches.filter(
          m => m.startgametime > lastCrawlSec && m.startgametime <= nowSec
        );

        if (matchesInInterval.length > 0) {
          if (matchesInInterval.length > bufferLimit) {
            totalCaptured += bufferLimit;
            totalLost += (matchesInInterval.length - bufferLimit);
          } else {
            totalCaptured += matchesInInterval.length;
          }
        }

        // Update crawl time
        lastCrawlTimes.set(pid, nowSec);
      }
    }
  }

  const avgCrawlIntervalActiveDays = crawlIntervalsActive.length > 0 
    ? crawlIntervalsActive.reduce((a, b) => a + b, 0) / crawlIntervalsActive.length 
    : 0;
  const avgCrawlIntervalInactiveDays = crawlIntervalsInactive.length > 0 
    ? crawlIntervalsInactive.reduce((a, b) => a + b, 0) / crawlIntervalsInactive.length 
    : 0;

  return { totalCaptured, totalLost, totalCrawls, avgCrawlIntervalActiveDays, avgCrawlIntervalInactiveDays };
}

async function main() {
  console.log('Loading database...');
  const db = new JsonDatabase();
  await db.load();

  const allMatches = db.getMatches();
  console.log(`Loaded ${allMatches.length} matches.`);

  // Globally sort all matches chronologically
  const globalMatches = [...allMatches].sort((a, b) => a.startgametime - b.startgametime);

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

  // Optimize candidatePlayerIds to only include players with >= 3 matches in DB
  const candidatePlayerIds = Array.from(playerMatches.entries())
    .filter(([_, matches]) => matches.length >= 3)
    .map(([pid]) => pid);
  console.log(`Filtered candidates with >= 3 matches: ${candidatePlayerIds.length} players (reduced from ${playerMatches.size}).`);

  const bufferLimit = 10;
  const cronIntervalHr = 4;
  const limitCount = 250; // Max players crawled per run

  // Cooldown strategy (our implemented dynamic cooldown)
  const cooldownStrategy = (count: number) => {
    if (count >= 80) return 2 * 60 * 60 * 1000;
    if (count >= 40) return 4 * 60 * 60 * 1000;
    if (count >= 15) return 8 * 60 * 60 * 1000;
    if (count >= 5)  return 24 * 60 * 60 * 1000;
    return 72 * 60 * 60 * 1000;
  };

  const strategies: {
    name: string;
    seeding: (
      playerIds: number[],
      lastCrawlTimes: Map<number, number>,
      rolling30d: Map<number, number>,
      nowSecs: number,
      limit: number
    ) => number[];
  }[] = [
    {
      name: 'Strategy 1: Current Seeding (Activity-only + Oldest 50)',
      seeding: (playerIds, lastCrawlTimes, rolling30d, nowSecs, limit) => {
        const activeIds = playerIds.map(pid => ({
          pid,
          act: rolling30d.get(pid) || 0
        }));
        activeIds.sort((a, b) => b.act - a.act);

        const oldestIds = playerIds.map(pid => ({
          pid,
          time: lastCrawlTimes.get(pid) || 0
        }));
        oldestIds.sort((a, b) => a.time - b.time);

        const seen = new Set<number>();
        const queue: number[] = [];

        // Add top active players (up to limit)
        for (const item of activeIds) {
          if (queue.length >= limit) break;
          seen.add(item.pid);
          queue.push(item.pid);
        }

        // Add 50 oldest to the back
        let oldestAdded = 0;
        for (const item of oldestIds) {
          if (oldestAdded >= 50) break;
          if (!seen.has(item.pid)) {
            seen.add(item.pid);
            queue.push(item.pid);
            oldestAdded++;
          }
        }

        return queue;
      }
    },
    {
      name: 'Strategy 2: Unified Priority Seeding (Activity * Staleness)',
      seeding: (playerIds, lastCrawlTimes, rolling30d, nowSecs, limit) => {
        // Priority = (Activity_30d + 0.5) * Staleness_Hours
        const scored = playerIds.map(pid => {
          const activity = rolling30d.get(pid) || 0;
          const lastCrawlSec = lastCrawlTimes.get(pid) || 0;
          const stalenessSec = Math.max(0, nowSecs - lastCrawlSec);
          const stalenessHours = stalenessSec / 3600;
          
          const score = (activity + 0.5) * stalenessHours;
          return { pid, score };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => s.pid);
      }
    },
    {
      name: 'Strategy 3: Strict Starvation-Preventing Priority Seeding',
      seeding: (playerIds, lastCrawlTimes, rolling30d, nowSecs, limit) => {
        // Priority = Activity_30d * 3 + (Staleness_Hours ^ 1.2)
        const scored = playerIds.map(pid => {
          const activity = rolling30d.get(pid) || 0;
          const lastCrawlSec = lastCrawlTimes.get(pid) || 0;
          const stalenessHours = (nowSecs - lastCrawlSec) / 3600;
          
          const score = (activity * 3) + Math.pow(stalenessHours, 1.2);
          return { pid, score };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => s.pid);
      }
    }
  ];

  console.log(`\nStarting seeding simulation (Limit: ${limitCount} players/run, Cron: ${cronIntervalHr}h, Buffer: ${bufferLimit})...`);

  const results: SeedingSimulationResult[] = [];
  for (const s of strategies) {
    const startSim = Date.now();
    const res = runSeedingSimulation(playerMatches, globalMatches, candidatePlayerIds, bufferLimit, cronIntervalHr, limitCount, cooldownStrategy, s.seeding);
    const lossRatePercent = (res.totalLost / totalPlayerMatchObservations) * 100;
    
    results.push({
      strategyName: s.name,
      ...res,
      lossRatePercent
    });
    console.log(`Finished ${s.name} in ${((Date.now() - startSim) / 1000).toFixed(2)}s`);
  }

  console.log('\n========================================================================================');
  console.log('SEEDING STRATEGY SIMULATION RESULTS');
  console.log('========================================================================================');
  console.log(
    'Strategy'.padEnd(52) + 
    ' | Crawls'.padStart(10) + 
    ' | Lost'.padStart(8) + 
    ' | Loss %'.padStart(10) + 
    ' | Active Crawl (d)'.padStart(19) + 
    ' | Inactive Crawl (d)'.padStart(21)
  );
  console.log('----------------------------------------------------------------------------------------');
  for (const r of results) {
    console.log(
      r.strategyName.padEnd(52) +
      ` | ${r.totalCrawls.toString().padStart(8)}` +
      ` | ${r.totalLost.toString().padStart(6)}` +
      ` | ${r.lossRatePercent.toFixed(4).padStart(8)}%` +
      ` | ${r.avgCrawlIntervalActiveDays.toFixed(2).padStart(17)}d` +
      ` | ${r.avgCrawlIntervalInactiveDays.toFixed(2).padStart(19)}d`
    );
  }
  console.log('========================================================================================');
}

main().catch(console.error);
