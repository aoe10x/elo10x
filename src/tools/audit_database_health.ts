import { JsonDatabase } from '../db.ts';

async function main() {
  console.log('Analyzing database health...');
  const db = new JsonDatabase();
  await db.load();

  const matches = db.getMatches();
  const profiles = db.getAllProfiles();
  const manifest = db.crawlManifest;

  const nowSecs = Math.floor(Date.now() / 1000);
  const day30Sec = 30 * 24 * 60 * 60;
  const day30ago = nowSecs - day30Sec;

  console.log(`\n============================================================`);
  console.log(`DATABASE INTEGRITY & COALESCENCE REPORT`);
  console.log(`============================================================`);
  console.log(`Total Matches in DB  : ${matches.length}`);
  console.log(`Total Player Profiles: ${profiles.length}`);

  // 1. Profile Crawl Coverage Stats
  let relicCrawledCount = 0;
  let insightsCrawledCount = 0;
  let totalCrawledCount = 0;
  let neverCrawledCount = 0;

  for (const p of profiles) {
    const entry = db.getPlayerManifest(p.profile_id);
    const hasRelic = entry?.relic?.last_crawled_at && entry.relic.last_crawled_at > 0;
    const hasInsights = entry?.insights?.last_crawled_at && entry.insights.last_crawled_at > 0;

    if (hasRelic) relicCrawledCount++;
    if (hasInsights) insightsCrawledCount++;
    if (hasRelic || hasInsights) {
      totalCrawledCount++;
    } else {
      neverCrawledCount++;
    }
  }

  const crawlCoveragePct = ((totalCrawledCount / profiles.length) * 100).toFixed(1);
  console.log(`\n--- PROFILE COVERAGE ---`);
  console.log(`Ever Crawled Profiles : ${totalCrawledCount} (${crawlCoveragePct}%)`);
  console.log(`  - via Relic API     : ${relicCrawledCount}`);
  console.log(`  - via Insights HTML : ${insightsCrawledCount}`);
  console.log(`Discovered/Uncrawled  : ${neverCrawledCount} (${(100 - Number(crawlCoveragePct)).toFixed(1)}%)`);
  console.log(`> Uncrawled players represent "blind spots" where we only see matches they played with already-crawled players.`);

  // 2. Active Player Coverage (Activity in last 30 days)
  const activePids = new Set<number>();
  for (const m of matches) {
    if (m.startgametime >= day30ago && m.players) {
      for (const p of m.players) {
        activePids.add(p.profile_id);
      }
    }
  }

  let activeCrawled = 0;
  let activeNeverCrawled = 0;
  let activeStaleCrawled = 0; // last crawl > 7 days ago

  for (const pid of activePids) {
    const entry = db.getPlayerManifest(pid);
    const lastCrawlRelic = entry?.relic?.last_crawled_at || 0;
    const lastCrawlInsights = entry?.insights?.last_crawled_at || 0;
    const lastCrawl = Math.max(lastCrawlRelic, lastCrawlInsights);

    if (lastCrawl === 0) {
      activeNeverCrawled++;
    } else {
      activeCrawled++;
      const ageDays = (nowSecs - lastCrawl) / (24 * 3600);
      if (ageDays > 7) {
        activeStaleCrawled++;
      }
    }
  }

  console.log(`\n--- ACTIVE PLAYER COVERAGE (Last 30 Days) ---`);
  console.log(`Total Active Players in DB: ${activePids.size}`);
  console.log(`  - Crawled & Fresh (<=7d) : ${activeCrawled - activeStaleCrawled} (${((activeCrawled - activeStaleCrawled) / activePids.size * 100).toFixed(1)}%)`);
  console.log(`  - Crawled but Stale (>7d): ${activeStaleCrawled} (${(activeStaleCrawled / activePids.size * 100).toFixed(1)}%)`);
  console.log(`  - Never Crawled (Blind)  : ${activeNeverCrawled} (${(activeNeverCrawled / activePids.size * 100).toFixed(1)}%)`);

  // 3. Match Coverage Density (Exposure Index)
  // Exposure Index = Average percentage of players in a lobby who have been directly crawled.
  // High exposure = we have high certainty we did not miss matches around this lobby.
  let totalMatchExposure = 0;
  let lowExposureMatches = 0; // less than 2 players crawled

  for (const m of matches) {
    if (!m.players || m.players.length === 0) continue;
    let crawledPlayers = 0;
    for (const p of m.players) {
      const entry = db.getPlayerManifest(p.profile_id);
      const crawled = (entry?.relic?.last_crawled_at && entry.relic.last_crawled_at > 0) || 
                      (entry?.insights?.last_crawled_at && entry.insights.last_crawled_at > 0);
      if (crawled) crawledPlayers++;
    }
    const exposure = crawledPlayers / m.players.length;
    totalMatchExposure += exposure;
    if (crawledPlayers <= 1) {
      lowExposureMatches++;
    }
  }

  const avgExposure = ((totalMatchExposure / matches.length) * 100).toFixed(1);
  const lowExposurePct = ((lowExposureMatches / matches.length) * 100).toFixed(1);

  console.log(`\n--- DATABASE COMPLETENESS (LOBBY EXPOSURE) ---`);
  console.log(`Average Lobby Exposure: ${avgExposure}%`);
  console.log(`  - Meaning on average, ${Math.round(Number(avgExposure) / 100 * 8)} out of 8 players in any lobby have been directly crawled.`);
  console.log(`Low Exposure Matches  : ${lowExposureMatches} (${lowExposurePct}%)`);
  console.log(`  - Lobbies where <= 1 player was crawled (highly susceptible to missing historical context).`);

  // 4. Overall Health Grade
  const healthScore = Math.round(
    (Number(crawlCoveragePct) * 0.3) + 
    (((activePids.size - activeNeverCrawled) / activePids.size * 100) * 0.4) + 
    (Number(avgExposure) * 0.3)
  );

  let grade = 'F';
  if (healthScore >= 90) grade = 'A';
  else if (healthScore >= 80) grade = 'B';
  else if (healthScore >= 70) grade = 'C';
  else if (healthScore >= 60) grade = 'D';

  console.log(`\n============================================================`);
  console.log(`OVERALL DATABASE HEALTH GRADE: ${grade} (${healthScore}/100)`);
  console.log(`============================================================`);
}

main().catch(console.error);
