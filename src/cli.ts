import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { RelicCrawler } from './relic_crawler.ts';
import { JsonDatabase } from './db.ts';
import { EloCalculator } from './elo.ts';
import { Aoe2InsightsScraper } from './aoe2insights_scraper.ts';

function showHelp(): void {
  console.log(`
AoE2 10x Elo Ranking System CLI

Usage:
  node --experimental-strip-types src/cli.ts [options]

Options:
  --crawl                   Run a snowball crawler session to fetch 10x games.
  --limit <number>          Max number of player profiles to crawl in this session (default: 150).
  --months <number>         Cutoff months for games (default: 3).
  
  --scrape-insights <id|active|unscraped> Scrape history for player <id>, active players, or active unscraped players from AoE2Insights.
  --start-page <number>     Start page for AoE2Insights scraper (default: 1).
  --end-page <number>       End page for AoE2Insights scraper (default: 20).

  --elo                     Calculate ELO ratings based on crawled matches.
  --min-games <number>      Minimum games required to display on the leaderboard (default: 15).
  --k-factor <number>       K-Factor to use for ELO calculations (default: 32).
  --provisional             Include provisional players (fewer games than min-games).

  --help, -h                Show this help message.

Examples:
  # Crawl 10 players, then calculate Elo
  node --experimental-strip-types src/cli.ts --crawl --limit 10
  
  # Scrape Paulichromatic's match history (pages 1-20) from AoE2Insights
  node --experimental-strip-types src/cli.ts --scrape-insights 404483 --start-page 1 --end-page 20

  node --experimental-strip-types src/cli.ts --elo
`);
}

async function main(): Promise<void> {
  const options = {
    crawl: { type: 'boolean' as const },
    limit: { type: 'string' as const },
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
    const limit = values.limit ? parseInt(values.limit, 10) : 150;
    const months = values.months ? parseInt(values.months, 10) : 3;
    const crawler = new RelicCrawler(db);

    console.log(`Starting crawl session... (limit: ${limit} players, cutoff: ${months} months)`);
    
    await crawler.runCrawl(limit, months);
    console.log('Crawl session complete.');
    console.log(`Database state: ${db.getMatchesCount()} matches, ${db.getProfilesCount()} cached profiles, ${db.getCrawlQueueLength()} in crawl queue.`);
  }

  if (values['scrape-insights']) {
    let targetProfileIds: number[] = [];
    
    if (values['scrape-insights'] === 'active' || values['scrape-insights'] === 'unscraped') {
      const isUnscrapedOnly = values['scrape-insights'] === 'unscraped';
      console.log(isUnscrapedOnly ? 'Detecting active unscraped players in database...' : 'Detecting top active players in database...');
      
      const matches = db.getMatches();
      const playerCounts: Record<number, number> = {};
      const scrapedIds = new Set<number>();
      
      for (const m of matches) {
        if (m.players) {
          for (const p of m.players) {
            playerCounts[p.profile_id] = (playerCounts[p.profile_id] || 0) + 1;
            if (m.source === 'aoe2insights_scrape') {
              scrapedIds.add(p.profile_id);
            }
          }
        }
      }
      
      // Sort matches descending by startgametime to prioritize players from most recent games
      const sortedMatches = [...matches].sort((a, b) => b.startgametime - a.startgametime);
      const activeIds = new Set<number>();
      for (const m of sortedMatches) {
        if (m.players) {
          for (const p of m.players) {
            activeIds.add(p.profile_id);
          }
        }
      }

      // Exclude players we have already crawled thoroughly (only for the 'active' mode)
      const excludedIds = new Set<number>([
        404483,    // Paulichromatic
        3046506,   // NoAgendaPODCAST
        249997,    // Kumad
        295872,    // Myriad
        3309404,   // Parts
        17046544   // 田瘾犯了
      ]);

      const limit = values.limit ? parseInt(values.limit, 10) : 20;

      for (const pid of activeIds) {
        const isExcluded = isUnscrapedOnly ? scrapedIds.has(pid) : excludedIds.has(pid);
        if (!isExcluded) {
          targetProfileIds.push(pid);
          if (targetProfileIds.length >= limit) {
            break;
          }
        }
      }
      
      console.log(`Selected top ${targetProfileIds.length} players for crawling:`);
      for (const pid of targetProfileIds) {
        const alias = db.getProfile(pid)?.alias || `Player_${pid}`;
        console.log(`- ${alias} (ID ${pid}): ${playerCounts[pid] || 0} matches currently in DB`);
      }
    } else {
      const profileId = parseInt(values['scrape-insights'], 10);
      if (isNaN(profileId)) {
        console.error(`Invalid profile ID or option: ${values['scrape-insights']}`);
        process.exit(1);
      }
      targetProfileIds.push(profileId);
    }
    
    const startPage = values['start-page'] ? parseInt(values['start-page'], 10) : 1;
    const endPage = values['end-page'] ? parseInt(values['end-page'], 10) : 10; // default 10 pages for batch runs
    
    const scraper = new Aoe2InsightsScraper(db);
    console.log(`\n========================================`);
    console.log(`Starting Batch Crawl for ${targetProfileIds.length} players`);
    console.log(`========================================`);
    try {
      const stats = await scraper.scrapePlayersBatch(targetProfileIds, startPage, endPage);
      console.log(`\n========================================`);
      console.log(`Batch Scrape Complete! Crawled players: ${stats.crawled}, New 10x matches added/merged: ${stats.added}`);
      console.log(`========================================`);
    } catch (err: any) {
      console.error(`Batch scraper execution failed:`, err.message);
    }
  }

  if (values.elo) {
    const minGames = values['min-games'] ? parseInt(values['min-games'], 10) : 15;
    const kFactor = values['k-factor'] ? parseInt(values['k-factor'], 10) : 32;
    const provisional = !!values.provisional;

    const calculator = new EloCalculator({
      kFactor,
      minGamesForLeaderboard: minGames
    });

    const allMatches = db.getMatches();

    const modes = [
      {
        name: '10x3x',
        filter: (m: any) => /10x/i.test(m.description) && /3x/i.test(m.description),
        file: 'leaderboard_3x.json'
      },
      {
        name: 'Pure 10x',
        filter: (m: any) => /10x/i.test(m.description) && !/3x/i.test(m.description),
        file: 'leaderboard_pure.json'
      },
      {
        name: 'Combined',
        filter: (m: any) => /10x/i.test(m.description),
        file: 'leaderboard_combined.json'
      }
    ];

    for (const mode of modes) {
      const filteredMatches = allMatches.filter(mode.filter);
      const ratingsMap = calculator.calculate(filteredMatches);
      const leaderboard = calculator.getLeaderboard(ratingsMap, provisional);

      const leaderboardPath = path.join(process.cwd(), 'docs', 'data', mode.file);
      await fs.mkdir(path.dirname(leaderboardPath), { recursive: true });
      
      const lastMatchTime = filteredMatches.length > 0 
        ? Math.max(...filteredMatches.map(m => m.startgametime)) 
        : 0;

      const payload = {
        updatedAt: lastMatchTime * 1000,
        totalMatches: filteredMatches.length,
        totalPlayers: ratingsMap.size,
        leaderboardCount: leaderboard.length,
        config: { minGames, kFactor, provisional, mode: mode.name },
        players: leaderboard.map(p => {
          let country: string | undefined = undefined;
          const isValidCountry = (c: string | undefined) => 
            c && c.trim().length === 2 && c.toLowerCase() !== 'un';

          const canonicalCountry = db.getProfile(p.profile_id)?.country;
          if (isValidCountry(canonicalCountry)) {
            country = canonicalCountry;
          } else if (p.merged_ids && p.merged_ids.length > 0) {
            for (const id of p.merged_ids) {
              const mergedCountry = db.getProfile(id)?.country;
              if (isValidCountry(mergedCountry)) {
                country = mergedCountry;
                break;
              }
            }
          }

          return {
            ...p,
            country
          };
        })
      };
      
      await fs.writeFile(leaderboardPath, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`Saved ${mode.name} leaderboard (${filteredMatches.length} matches) to ${leaderboardPath}`);

      if (mode.name === '10x3x') {
        console.log('\n--- TOP 15 ELO RANKINGS (10x3x - DEFAULT) ---');
        console.log(
          String('Rank').padEnd(6) + 
          String('Alias').padEnd(25) + 
          String('Elo').padEnd(8) + 
          String('Record (W-L)').padEnd(15) + 
          String('Win %').padEnd(8) + 
          String('Profile ID')
        );
        console.log('-'.repeat(70));
        leaderboard.slice(0, 15).forEach((p, idx) => {
          const record = `${p.wins}-${p.losses}`;
          console.log(
            String(idx + 1).padEnd(6) + 
            String(p.alias).padEnd(25) + 
            String(p.rating).padEnd(8) + 
            String(record).padEnd(15) + 
            String(p.winRate + '%').padEnd(8) + 
            p.profile_id
          );
        });
        console.log('-'.repeat(70) + '\n');
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
