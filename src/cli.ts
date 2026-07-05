import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { MatchCrawler } from './crawler.ts';
import { JsonDatabase } from './db.ts';
import { EloCalculator } from './elo.ts';
import { InsightsCrawler } from './insights_crawler.ts';

function showHelp(): void {
  console.log(`
AoE2 10x Elo Ranking System CLI

Usage:
  node --experimental-strip-types src/cli.ts [options]

Options:
  --crawl                   Run a snowball crawler session to fetch 10x games.
  --limit <number>          Max number of player profiles to crawl in this session (default: 50).
  --seed                    Force a fetch of online lobbies on aoe10x.com to seed crawler queue.
  --months <number>         Cutoff months for games (default: 3).
  
  --scrape-insights <id>    Scrape match history for player <id> from AoE2Insights via Chrome DevTools.
  --start-page <number>     Start page for AoE2Insights scraper (default: 1).
  --end-page <number>       End page for AoE2Insights scraper (default: 20).

  --elo                     Calculate ELO ratings based on crawled matches.
  --min-games <number>      Minimum games required to display on the leaderboard (default: 5).
  --k-factor <number>       K-Factor to use for ELO calculations (default: 32).
  --provisional             Include provisional players (fewer games than min-games).

  --help, -h                Show this help message.

Examples:
  # Seed queue and crawl 10 players, then calculate Elo
  node --experimental-strip-types src/cli.ts --crawl --seed --limit 10
  
  # Scrape Paulichromatic's match history (pages 1-20) from AoE2Insights
  node --experimental-strip-types src/cli.ts --scrape-insights 404483 --start-page 1 --end-page 20

  node --experimental-strip-types src/cli.ts --elo
`);
}

async function main(): Promise<void> {
  const options = {
    crawl: { type: 'boolean' as const },
    limit: { type: 'string' as const },
    seed: { type: 'boolean' as const },
    months: { type: 'string' as const },
    'scrape-insights': { type: 'string' as const },
    'start-page': { type: 'string' as const },
    'end-page': { type: 'string' as const },
    elo: { type: 'boolean' as const },
    'min-games': { type: 'string' as const },
    'k-factor': { type: 'string' as const },
    provisional: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' as const }
  };

  let parsed: any;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });
  } catch (err: any) {
    console.error(`Error parsing arguments: ${err.message}`);
    showHelp();
    process.exit(1);
  }

  const { values } = parsed;

  if (values.help || Object.keys(values).length === 0) {
    showHelp();
    return;
  }

  const db = new JsonDatabase();
  await db.load();

  if (values.crawl) {
    const limit = values.limit ? parseInt(values.limit, 10) : 50;
    const months = values.months ? parseInt(values.months, 10) : 3;
    const crawler = new MatchCrawler(db);

    console.log(`Starting crawl session... (limit: ${limit} players, cutoff: ${months} months)`);
    
    if (values.seed) {
      await crawler.seedFromLobbies();
    }

    await crawler.runCrawl(limit, months);
    console.log('Crawl session complete.');
    console.log(`Database state: ${db.getMatchesCount()} matches, ${db.getProfilesCount()} cached profiles, ${db.getCrawlQueueLength()} in crawl queue.`);
  }

  if (values['scrape-insights']) {
    let targetProfileIds: number[] = [];
    
    if (values['scrape-insights'] === 'active') {
      console.log('Detecting top active players in database...');
      const matches = db.getMatches();
      const playerCounts: Record<number, number> = {};
      for (const m of matches) {
        if (m.players) {
          for (const p of m.players) {
            playerCounts[p.profile_id] = (playerCounts[p.profile_id] || 0) + 1;
          }
        }
      }
      
      // Sort by frequency descending
      const sortedPlayers = Object.entries(playerCounts)
        .map(([pid, count]) => ({ profileId: parseInt(pid, 10), count }))
        .sort((a, b) => b.count - a.count);
         
      // Exclude players we have already crawled thoroughly
      const excludedIds = new Set<number>([
        404483,    // Paulichromatic
        3046506,   // NoAgendaPODCAST
        249997,    // Kumad
        295872,    // Myriad
        3309404,   // Parts
        17046544   // 田瘾犯了
      ]);
      
      const limit = values.limit ? parseInt(values.limit, 10) : 20;
      
      for (const p of sortedPlayers) {
        if (!excludedIds.has(p.profileId)) {
          targetProfileIds.push(p.profileId);
          if (targetProfileIds.length >= limit) {
            break;
          }
        }
      }
      
      console.log(`Selected next top ${targetProfileIds.length} active players for crawling:`);
      for (const pid of targetProfileIds) {
        const alias = db.getProfile(pid)?.alias || `Player_${pid}`;
        console.log(`- ${alias} (ID ${pid}): ${playerCounts[pid]} matches currently in DB`);
      }
    } else {
      const profileId = parseInt(values['scrape-insights'], 10);
      if (isNaN(profileId)) {
        console.error(`Invalid profile ID: ${values['scrape-insights']}`);
        process.exit(1);
      }
      targetProfileIds.push(profileId);
    }
    
    const startPage = values['start-page'] ? parseInt(values['start-page'], 10) : 1;
    const endPage = values['end-page'] ? parseInt(values['end-page'], 10) : 10; // default 10 pages for batch runs
    
    const scraper = new InsightsCrawler(db);
    
    let totalScraped = 0;
    let totalAdded = 0;
    
    for (const pid of targetProfileIds) {
      const alias = db.getProfile(pid)?.alias || `Player_${pid}`;
      console.log(`\n========================================`);
      console.log(`Scraping history for player: ${alias} (ID ${pid})`);
      console.log(`========================================`);
      
      try {
        const stats = await scraper.scrapePlayerHistory(pid, startPage, endPage);
        console.log(`Success: processed ${stats.scraped} matches, added ${stats.added} new matches.`);
        totalScraped += stats.scraped;
        totalAdded += stats.added;
        
        // Save progress after each player to protect against crashes
        await db.save();
      } catch (e: any) {
        console.error(`Scraper failed for player ${alias}:`, e.message);
        // Continue to next player in batch instead of hard crash
      }
    }
    
    console.log(`\nBatch Scrape Complete! Total processed 10x games: ${totalScraped}, Total new games added: ${totalAdded}`);
  }

  if (values.elo) {
    const minGames = values['min-games'] ? parseInt(values['min-games'], 10) : 5;
    const kFactor = values['k-factor'] ? parseInt(values['k-factor'], 10) : 32;
    const provisional = !!values.provisional;

    const matches = db.getMatches();
    console.log(`Calculating ELO ratings for ${matches.length} matches...`);
    
    const calculator = new EloCalculator({
      kFactor,
      minGamesForLeaderboard: minGames
    });

    const ratingsMap = calculator.calculate(matches);
    const leaderboard = calculator.getLeaderboard(ratingsMap, provisional);

    // Write leaderboard data to data/leaderboard.json for the web dashboard to consume
    const leaderboardPath = path.join(process.cwd(), 'data', 'leaderboard.json');
    await fs.mkdir(path.dirname(leaderboardPath), { recursive: true });
    
    // Also save metadata about the ELO runs
    const payload = {
      updatedAt: Date.now(),
      totalMatches: matches.length,
      totalPlayers: ratingsMap.size,
      leaderboardCount: leaderboard.length,
      config: { minGames, kFactor, provisional },
      players: leaderboard.map(p => ({
        ...p,
        country: db.getProfile(p.profile_id)?.country
      }))
    };
    
    await fs.writeFile(leaderboardPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`Leaderboard saved to ${leaderboardPath}`);

    // Print top 15 players in console
    console.log('\n--- TOP 15 ELO RANKINGS ---');
    console.log(
      String('Rank').padEnd(6) + 
      String('Alias').padEnd(25) + 
      String('Elo').padEnd(8) + 
      String('Record (W-L)').padEnd(15) + 
      String('Win %').padEnd(8) + 
      String('Profile ID')
    );
    console.log('-'.repeat(70));
    
    leaderboard.slice(0, 15).forEach((p, index) => {
      console.log(
        String(index + 1).padEnd(6) + 
        String(p.alias.slice(0, 24)).padEnd(25) + 
        String(p.rating).padEnd(8) + 
        String(`${p.wins}-${p.losses}`).padEnd(15) + 
        String(`${p.winRate}%`).padEnd(8) + 
        String(p.profile_id)
      );
    });
    console.log('---------------------------\n');
  }
}

main().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
