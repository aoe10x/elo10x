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

  // Initialize simulation states using dense indices
  const M = candidatePlayerIds.length;
  const pidToIndex = new Map<number, number>();
  for (let i = 0; i < M; i++) {
    pidToIndex.set(candidatePlayerIds[i], i);
  }

  const lastCrawlTimes = new Float64Array(M);
  const capturedMatches: Match[][] = Array.from({ length: M }, () => []);
  const matchPointers = new Int32Array(M);
  const windowStartIdx = new Int32Array(M);
  const rolling30dCounts = new Int32Array(M);

  const initialLastCrawlTime = globalStartSec - day30Sec;
  for (let i = 0; i < M; i++) {
    lastCrawlTimes[i] = initialLastCrawlTime;
  }

  // Pre-sort player matches chronologically for pointer-based iteration
  const sortedPlayerMatches: Match[][] = Array.from({ length: M }, () => []);
  for (let i = 0; i < M; i++) {
    const pid = candidatePlayerIds[i];
    const matches = playerMatches.get(pid) || [];
    sortedPlayerMatches[i] = [...matches].sort((a, b) => a.startgametime - b.startgametime);
  }

  const crawlIntervalsActive: number[] = [];
  const crawlIntervalsInactive: number[] = [];

  // Pre-allocated array for queues
  const queue = new Int32Array(M);
  let queueLength = 0;

  // Step chronologically through 4-hour cron boundaries (No Match-Event-Driven time progression gaps)
  for (let nowSec = globalStartSec; nowSec <= globalEndSec; nowSec += cronIntervalSec) {
    const windowStartSec = nowSec - day30Sec;

    // 1. Calculate rolling 30d match count using CAPTURED (successfully crawled) history only (No Oracle Bias!)
    for (let i = 0; i < M; i++) {
      const capMatches = capturedMatches[i];
      let idx = windowStartIdx[i];
      while (idx < capMatches.length && capMatches[idx].startgametime < windowStartSec) {
        idx++;
      }
      windowStartIdx[i] = idx;
      rolling30dCounts[i] = capMatches.length - idx;
    }

    // 2. Queue seeding selection
    if (seedingStrategyName === 'current') {
      // Current Seeding (Activity-only + Oldest 50)
      const activeIndices = new Int32Array(M);
      const oldestIndices = new Int32Array(M);
      for (let i = 0; i < M; i++) {
        activeIndices[i] = i;
        oldestIndices[i] = i;
      }
      activeIndices.sort((a, b) => rolling30dCounts[b] - rolling30dCounts[a]);
      oldestIndices.sort((a, b) => lastCrawlTimes[a] - lastCrawlTimes[b]);

      const seen = new Uint8Array(M);
      let qPtr = 0;
      
      for (let i = 0; i < M; i++) {
        const idx = activeIndices[i];
        seen[idx] = 1;
        queue[qPtr++] = idx;
      }
      let oldestAdded = 0;
      for (let i = 0; i < M; i++) {
        if (oldestAdded >= 50) break;
        const idx = oldestIndices[i];
        if (seen[idx] === 0) {
          seen[idx] = 1;
          queue[qPtr++] = idx;
          oldestAdded++;
        }
      }
      queueLength = qPtr;
    } else if (seedingStrategyName === 'activity_staleness') {
      // Unified Priority Seeding: Priority = (Activity_30d + 0.5) * Staleness_Hours
      const scores = new Float64Array(M);
      const indices = new Int32Array(M);
      for (let i = 0; i < M; i++) {
        indices[i] = i;
        const activity = rolling30dCounts[i];
        const lastCrawlSec = lastCrawlTimes[i];
        const stalenessSec = Math.max(0, nowSec - lastCrawlSec);
        const stalenessHours = stalenessSec / 3600;
        scores[i] = (activity + 0.5) * stalenessHours;
      }
      indices.sort((a, b) => scores[b] - scores[a]);
      for (let i = 0; i < M; i++) {
        queue[i] = indices[i];
      }
      queueLength = M;
    } else if (seedingStrategyName === 'nop') {
      // Normalized Overdue Priority (NOP)
      const scores = new Float64Array(M);
      const indices = new Int32Array(M);
      let eligibleCount = 0;
      for (let i = 0; i < M; i++) {
        const lastCrawlSec = lastCrawlTimes[i];
        const activity = rolling30dCounts[i];
        const cooldownSec = cooldownStrategy(activity) / 1000;
        if (nowSec - lastCrawlSec >= cooldownSec) {
          indices[eligibleCount] = i;
          const stalenessSec = nowSec - lastCrawlSec;
          scores[i] = stalenessSec / cooldownSec;
          eligibleCount++;
        }
      }
      const eligibleIndices = indices.subarray(0, eligibleCount);
      eligibleIndices.sort((a, b) => scores[b] - scores[a]);
      for (let i = 0; i < eligibleCount; i++) {
        queue[i] = eligibleIndices[i];
      }
      queueLength = eligibleCount;
    }

    // 3. Process queue until we successfully perform limitCount crawls (Full Queue Capacity Utilization)
    let crawledThisCron = 0;
    for (let i = 0; i < queueLength; i++) {
      if (crawledThisCron >= limitCount) break;

      const idx = queue[i];
      const lastCrawlSec = lastCrawlTimes[idx];
      const activity = rolling30dCounts[idx];
      const cooldownSec = cooldownStrategy(activity) / 1000;

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
        const matches = sortedPlayerMatches[idx];
        let ptr = matchPointers[idx];
        const matchesInInterval: Match[] = [];

        while (ptr < matches.length && matches[ptr].startgametime <= nowSec) {
          if (matches[ptr].startgametime > lastCrawlSec) {
            matchesInInterval.push(matches[ptr]);
          }
          ptr++;
        }
        matchPointers[idx] = ptr;

        if (matchesInInterval.length > 0) {
          if (matchesInInterval.length > bufferLimit) {
            // Buffer keeps the 10 most recent matches
            matchesInInterval.sort((a, b) => b.startgametime - a.startgametime);
            const captured = matchesInInterval.slice(0, bufferLimit);
            capturedMatches[idx].push(...captured);
            totalCaptured += bufferLimit;
            totalLost += (matchesInInterval.length - bufferLimit);
          } else {
            capturedMatches[idx].push(...matchesInInterval);
            totalCaptured += matchesInInterval.length;
          }
          // Sort captured history for the next step's binary/sliding count
          capturedMatches[idx].sort((a, b) => a.startgametime - b.startgametime);
        }

        // Update crawl time
        lastCrawlTimes[idx] = nowSec;
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

  const allMatches = db.getMatches().filter(m => m.startgametime > 1000000000);
  console.log(`Loaded ${allMatches.length} valid matches (filtered out corrupted ones).`);

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
