#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { RelicCrawler } from './relic_crawler.ts';
import { JsonDatabase } from './db.ts';
import { Aoe2InsightsScraper } from './aoe2insights_scraper.ts';
import { InsightsCrawler } from './insights_crawler.ts';
import { runCompile } from './compile.ts';

function showHelp(): void {
  console.log(`
AoE2 10x Elo Ranking System CLI

Usage:
  elo10x <subcommand> [options]

Subcommands:
  crawl                     Run a snowball crawler session to fetch recent matches.
  scrape <target>           Run the AoE2Insights scraper for targeted backfills.
                            Targets:
                              active     Scrape recent games for top active database players.
                              unscraped  Scrape recent games for active players never scraped.
                              <id>       Backfill historical matches for specific player ID.
  elo                       Calculate Elo ratings and pre-render leaderboard.

Options (crawl):
  --engine <relic|insights> Engine to crawl matches with (default: relic).
  --limit <number>          Max players to crawl (default: 150 for relic, 80 for insights).
  --months <number>         Cutoff months for games (relic only, default: 3).
  --force                   Bypass player cooldown checks.

Options (scrape):
  --limit <number>          Max active/unscraped players to scrape (default: 80).
  --start-page <number>     Start page for scraper (default: 1).
  --end-page <number>       End page for scraper (default: 1 for active/unscraped, 10 for ID).

Global Options:
  --help, -h                Show this help message.

Examples:
  # Crawl recent matches from Relic Link API (up to 50 players)
  elo10x crawl --limit 50

  # Crawl recent matches from Insights (bypassing cooldowns)
  elo10x crawl --engine insights --force

  # Backfill pages 1-10 for Clean (ID 11783175) from Insights
  elo10x scrape 11783175 --start-page 1 --end-page 10

  # Compute ELO and rebuild static site
  elo10x elo
`);
}

async function main(): Promise<void> {
  const options = {
    engine: { type: 'string' as const },
    limit: { type: 'string' as const },
    months: { type: 'string' as const },
    'start-page': { type: 'string' as const },
    'end-page': { type: 'string' as const },
    force: { type: 'boolean' as const },
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

  const { values, positionals } = parsed;
  const subcommand = positionals[0];

  if (values.help || !subcommand) {
    showHelp();
    return;
  }

  const db = new JsonDatabase();
  await db.load();

  if (subcommand === 'crawl') {
    const engine = values.engine || 'relic';
    const force = !!values.force;

    if (engine === 'relic') {
      const limit = values.limit ? parseInt(values.limit, 10) : 150;
      const months = values.months ? parseInt(values.months, 10) : 3;
      const crawler = new RelicCrawler(db);

      console.log(`Starting Relic crawl session... (limit: ${limit} players, cutoff: ${months} months, force: ${force})`);
      await crawler.runCrawl(limit, months, force);
      console.log('Crawl session complete.');
      console.log(`Database state: ${db.getMatchesCount()} matches, ${db.getProfilesCount()} cached profiles, ${db.getCrawlQueueLength()} in crawl queue.`);
    }
    else if (engine === 'insights') {
      const limit = values.limit ? parseInt(values.limit, 10) : 80;
      const crawler = new InsightsCrawler(db);

      console.log(`Starting Insights crawl session... (limit: ${limit} players, force: ${force})`);
      await crawler.runCrawl(limit, force);
      console.log('Insights crawl session complete.');
      console.log(`Database state: ${db.getMatchesCount()} matches, ${db.getProfilesCount()} cached profiles, ${db.getCrawlQueueLength()} in crawl queue.`);
    }
    else {
      console.error(`Error: Unknown crawl engine: ${engine}`);
      process.exit(1);
    }
  }
  else if (subcommand === 'scrape') {
    const target = positionals[1];
    if (!target) {
      console.error('Error: Please specify a target for scrape command (e.g., active, unscraped, or <profile_id>).');
      process.exit(1);
    }

    let targetProfileIds: number[] = [];
    const startPage = values['start-page'] ? parseInt(values['start-page'], 10) : 1;
    let defaultEndPage = 1;

    if (target === 'active' || target === 'unscraped') {
      const isUnscrapedOnly = target === 'unscraped';
      console.log(isUnscrapedOnly ? 'Detecting active unscraped players in database...' : 'Detecting top active players in database...');
      
      const matches = db.getMatches();
      const playerCounts: Record<number, number> = {};
      
      for (const m of matches) {
        if (m.players) {
          for (const p of m.players) {
            playerCounts[p.profile_id] = (playerCounts[p.profile_id] || 0) + 1;
          }
        }
      }
      
      const sortedMatches = [...matches].sort((a, b) => b.startgametime - a.startgametime);
      const activeIds = new Set<number>();
      for (const m of sortedMatches) {
        if (m.players) {
          for (const p of m.players) {
            activeIds.add(p.profile_id);
          }
        }
      }

      const excludedIds = new Set<number>([
        404483,    // Paulichromatic
        3046506,   // NoAgendaPODCAST
        249997,    // Kumad
        295872,    // Myriad
        3309404,   // Parts
        17046544   // 田瘾犯了
      ]);

      const limit = values.limit ? parseInt(values.limit, 10) : 80;
      const nowSec = Math.floor(Date.now() / 1000);
      const cooldownSec = 24 * 60 * 60; // 24 hours cooldown for target selection
      const force = !!values.force;

      for (const pid of activeIds) {
        const manifest = db.getPlayerManifest(pid);
        const lastCrawledSec = manifest?.insights?.last_crawled_at || 0;
        const hasBeenScraped = manifest?.insights !== undefined;
        const inCooldown = !force && (nowSec - lastCrawledSec < cooldownSec);

        const isExcluded = isUnscrapedOnly 
          ? hasBeenScraped 
          : (excludedIds.has(pid) || inCooldown);

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
    }
    else {
      const profileId = parseInt(target, 10);
      if (isNaN(profileId)) {
        console.error(`Invalid profile ID or target: ${target}`);
        process.exit(1);
      }
      targetProfileIds.push(profileId);
      defaultEndPage = 10;
    }
    
    const endPage = values['end-page'] ? parseInt(values['end-page'], 10) : defaultEndPage;
    const scraper = new Aoe2InsightsScraper(db);
    console.log(`\n========================================`);
    console.log(`Starting Batch Scrape for ${targetProfileIds.length} players`);
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
  else if (subcommand === 'elo') {
    console.log('Calculating Elo ratings and pre-rendering leaderboard pages...');
    await runCompile(db);
  }
  else {
    console.error(`Unknown subcommand: ${subcommand}`);
    showHelp();
    process.exit(1);
  }
}

main().catch(console.error);
