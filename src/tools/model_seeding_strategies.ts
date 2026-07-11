import { JsonDatabase } from '../db.ts';
import type { Match } from '../types.ts';

interface SeedingSimulationResult {
  strategyName: string;
  totalCaptured: number;
  totalLost: number;
  totalCrawls: number;
  lossRatePercent: number;
  avgCrawlIntervalActiveDays: number; // Avg crawl interval for active players (>=15 games/30d)
  avgCrawlIntervalInactiveDays: number; // Avg crawl interval for inactive players (<5 games/30d)
}

function runSeedingSimulation(
  playerMatches: Map<number, Match[]>,
  globalMatches: Match[],
  candidatePlayerIds: number[],
  bufferLimit: number,
  cronIntervalHr: number,
  limitCount: number,
  cooldownStrategy: (rolling30d: number) => number,
  seedingStrategyName: 'current' | 'activity_staleness' | 'nop'
): Omit<SeedingSimulationResult, 'strategyName' | 'lossRatePercent'> {
  let totalCaptured = 0;
  let totalLost = 0;
  let totalCrawls = 0;

  const cronIntervalSec = cronIntervalHr * 60 * 60;
  const day30Sec = 30 * 24 * 60 * 60;

  let globalStartSec = Infinity;
  let globalEndSec = 0;
  for (const matches of playerMatches.values()) {
    for (const m of matches) {
      if (m.startgametime < globalStartSec) globalStartSec = m.startgametime;
      if (m.startgametime > globalEndSec) globalEndSec = m.startgametime;
    }
  }
  // Align global start to cron boundary
  globalStartSec = Math.floor(globalStartSec / cronIntervalSec) * cronIntervalSec;

  // Initialize simulation states
  const lastCrawlTimes = new Map<number, number>();
  const capturedMatches = new Map<number, Match[]>();
  const matchPointers = new Map<number, number>();
  const candidateSet = new Set(candidatePlayerIds);

  for (const pid of candidatePlayerIds) {
    lastCrawlTimes.set(pid, globalStartSec - day30Sec);
    capturedMatches.set(pid, []);
    matchPointers.set(pid, 0);
  }

  // Pre-sort player matches chronologically for pointer-based iteration
  const sortedPlayerMatches = new Map<number, Match[]>();
  for (const [pid, matches] of playerMatches.entries()) {
    sortedPlayerMatches.set(pid, [...matches].sort((a, b) => a.startgametime - b.startgametime));
  }

  const crawlIntervalsActive: number[] = [];
  const crawlIntervalsInactive: number[] = [];

  // Step chronologically through 4-hour cron boundaries (No Match-Event-Driven time progression gaps)
  for (let nowSec = globalStartSec; nowSec <= globalEndSec; nowSec += cronIntervalSec) {
    const windowStartSec = nowSec - day30Sec;

    // 1. Calculate rolling 30d match count using CAPTURED (successfully crawled) history only (No Oracle Bias!)
    const rolling30dCounts = new Map<number, number>();
    for (const pid of candidatePlayerIds) {
      const capMatches = capturedMatches.get(pid)!;
      let count = 0;
      for (let j = capMatches.length - 1; j >= 0; j--) {
        if (capMatches[j].startgametime >= windowStartSec) {
          count++;
        } else {
          break; // Since capturedMatches is kept sorted chronologically
        }
      }
      if (count > 0) {
        rolling30dCounts.set(pid, count);
      }
    }

    // 2. Queue seeding selection
    let queue: number[] = [];

    if (seedingStrategyName === 'current') {
      // Current Seeding (Activity-only + Oldest 50)
      const activeIds = [...candidatePlayerIds].sort((a, b) => {
        const actA = rolling30dCounts.get(a) || 0;
        const actB = rolling30dCounts.get(b) || 0;
        return actB - actA;
      });

      const oldestIds = [...candidatePlayerIds].sort((a, b) => {
        const timeA = lastCrawlTimes.get(a) || 0;
        const timeB = lastCrawlTimes.get(b) || 0;
        return timeA - timeB;
      });

      const seen = new Set<number>();
      
      for (const pid of activeIds) {
        seen.add(pid);
        queue.push(pid);
      }
      let oldestAdded = 0;
      for (const pid of oldestIds) {
        if (oldestAdded >= 50) break;
        if (!seen.has(pid)) {
          seen.add(pid);
          queue.push(pid);
          oldestAdded++;
        }
      }
    } else if (seedingStrategyName === 'activity_staleness') {
      // Unified Priority Seeding: Priority = (Activity_30d + 0.5) * Staleness_Hours
      const scored = candidatePlayerIds.map(pid => {
        const activity = rolling30dCounts.get(pid) || 0;
        const lastCrawlSec = lastCrawlTimes.get(pid) || 0;
        const stalenessSec = Math.max(0, nowSec - lastCrawlSec);
        const stalenessHours = stalenessSec / 3600;
        const score = (activity + 0.5) * stalenessHours;
        return { pid, score };
      });
      scored.sort((a, b) => b.score - a.score);
      queue = scored.map(s => s.pid);
    } else if (seedingStrategyName === 'nop') {
      // Normalized Overdue Priority (NOP)
      // 1. Pre-filter: Only score players whose cooldown has expired (prevents active players on cooldown from blocking queue)
      const eligible = candidatePlayerIds.filter(pid => {
        const lastCrawlSec = lastCrawlTimes.get(pid) || 0;
        const activity = rolling30dCounts.get(pid) || 0;
        const cooldownSec = cooldownStrategy(activity) / 1000;
        return (nowSec - lastCrawlSec >= cooldownSec);
      });

      const scored = eligible.map(pid => {
        const activity = rolling30dCounts.get(pid) || 0;
        const lastCrawlSec = lastCrawlTimes.get(pid) || 0;
        const stalenessSec = nowSec - lastCrawlSec;
        const cooldownSec = cooldownStrategy(activity) / 1000;
        const score = stalenessSec / cooldownSec; // NOP Formula
        return { pid, score };
      });

      scored.sort((a, b) => b.score - a.score);
      queue = scored.map(s => s.pid);
    }

    // 3. Process queue until we successfully perform limitCount crawls (Full Queue Capacity Utilization)
    let crawledThisCron = 0;
    for (const pid of queue) {
      if (crawledThisCron >= limitCount) break;

      const lastCrawlSec = lastCrawlTimes.get(pid)!;
      const activity = rolling30dCounts.get(pid) || 0;
      const cooldownSec = cooldownStrategy(activity) / 1000;

      // For Strategy 1 and 2, players on cooldown are in the queue, so we skip them here.
      // For NOP, they are already pre-filtered out of the queue entirely.
      if (nowSec - lastCrawlSec >= cooldownSec) {
        totalCrawls++;
        crawledThisCron++;

        // Track starvation metrics
        const intervalDays = (nowSec - lastCrawlSec) / (24 * 3600);
        if (activity >= 15) {
          crawlIntervalsActive.push(intervalDays);
        } else {
          crawlIntervalsInactive.push(intervalDays);
        }

        // Fetch matches from chronological pointer
        const matches = sortedPlayerMatches.get(pid)!;
        let ptr = matchPointers.get(pid)!;
        const matchesInInterval: Match[] = [];

        while (ptr < matches.length && matches[ptr].startgametime <= nowSec) {
          if (matches[ptr].startgametime > lastCrawlSec) {
            matchesInInterval.push(matches[ptr]);
          }
          ptr++;
        }
        matchPointers.set(pid, ptr);

        if (matchesInInterval.length > 0) {
          if (matchesInInterval.length > bufferLimit) {
            // Buffer keeps the 10 most recent matches
            matchesInInterval.sort((a, b) => b.startgametime - a.startgametime);
            const captured = matchesInInterval.slice(0, bufferLimit);
            capturedMatches.get(pid)!.push(...captured);
            totalCaptured += bufferLimit;
            totalLost += (matchesInInterval.length - bufferLimit);
          } else {
            capturedMatches.get(pid)!.push(...matchesInInterval);
            totalCaptured += matchesInInterval.length;
          }
          // Sort captured history for the next step's binary/sliding count
          capturedMatches.get(pid)!.sort((a, b) => a.startgametime - b.startgametime);
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

  const strategies: { name: string; key: 'current' | 'activity_staleness' | 'nop' }[] = [
    {
      name: 'Strategy 1: Current Seeding (Activity-only + Oldest 50)',
      key: 'current'
    },
    {
      name: 'Strategy 2: Unified Priority Seeding (Activity * Staleness)',
      key: 'activity_staleness'
    },
    {
      name: 'Strategy 3: Normalized Overdue Priority (NOP) Seeding',
      key: 'nop'
    }
  ];

  console.log(`\nStarting seeding simulation (Limit: ${limitCount} players/run, Cron: ${cronIntervalHr}h, Buffer: ${bufferLimit})...`);

  const results: SeedingSimulationResult[] = [];
  for (const s of strategies) {
    const startSim = Date.now();
    const res = runSeedingSimulation(
      playerMatches,
      globalMatches,
      candidatePlayerIds,
      bufferLimit,
      cronIntervalHr,
      limitCount,
      cooldownStrategy,
      s.key
    );
    const lossRatePercent = (res.totalLost / totalPlayerMatchObservations) * 100;
    
    results.push({
      strategyName: s.name,
      ...res,
      lossRatePercent
    });
    console.log(`Finished ${s.name} in ${((Date.now() - startSim) / 1000).toFixed(2)}s`);
  }

  console.log('\n========================================================================================');
  console.log('SEEDING STRATEGY SIMULATION RESULTS (BUGS RESOLVED & NO ORACLE BIAS)');
  console.log('========================================================================================');
  console.log(
    'Strategy'.padEnd(54) + 
    ' | Crawls'.padStart(10) + 
    ' | Lost'.padStart(8) + 
    ' | Loss %'.padStart(10) + 
    ' | Active Crawl (d)'.padStart(19) + 
    ' | Inactive Crawl (d)'.padStart(21)
  );
  console.log('----------------------------------------------------------------------------------------');
  for (const r of results) {
    console.log(
      r.strategyName.padEnd(54) +
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
