import { test } from 'node:test';
import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { JsonDatabase } from '../src/db.ts';
import { RelicCrawler } from '../src/relic_crawler.ts';
import type { Match } from '../src/types.ts';

const tempDbDir = path.join(process.cwd(), 'test', 'temp_relic_crawler_test');

async function cleanTempDb() {
  await fs.rm(tempDbDir, { recursive: true, force: true });
}

async function initTempDb(initial: {
  matches?: string;
  profiles?: string;
  state?: string;
  manifest?: string;
}) {
  await fs.mkdir(tempDbDir, { recursive: true });
  await fs.writeFile(path.join(tempDbDir, 'matches.json'), initial.matches || '[\n  null\n]\n');
  await fs.writeFile(path.join(tempDbDir, 'profiles.json'), initial.profiles || '[\n  null\n]\n');
  await fs.writeFile(path.join(tempDbDir, 'crawl_state.json'), initial.state || '{}');
  await fs.writeFile(path.join(tempDbDir, 'crawl_manifest.json'), initial.manifest || '{}');
}

const originalFetch = globalThis.fetch;

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await cleanTempDb();
});

test('RelicCrawler - duplicate-equivalent match detection and queue seeding', async () => {
  await cleanTempDb();
  
  // 1. Setup DB state with an existing match
  const initialMatches = `[
    {"id":1001,"source":"relic_api","mapname":"bamboo","maxplayers":8,"matchtype_id":0,"description":"10x 3x game","startgametime":1700000000,"completiontime":1700001000,"players":[{"profile_id":1,"teamid":0,"resulttype":1,"civ_id":4,"alias":"P1"},{"profile_id":2,"teamid":1,"resulttype":0,"civ_id":5,"alias":"P2"}]},
    null
  ]`;
  const initialProfiles = `[
    {"profile_id":1,"alias":"P1"},
    {"profile_id":2,"alias":"P2"},
    null
  ]`;
  
  await initTempDb({
    matches: initialMatches,
    profiles: initialProfiles
  });
  
  const db = new JsonDatabase(tempDbDir);
  await db.load();

  // Create crawler
  const crawler = new RelicCrawler(db);

  // 2. Setup mock fetch response returning:
  // - A brand new match (ID 1002, different fingerprint)
  // - A duplicate-equivalent match (ID 1003, same fingerprint as 1001 but different ID)
  const mockMatches = [
    {
      id: 1002,
      creator_profile_id: 1,
      mapname: "bamboo",
      maxplayers: 8,
      matchtype_id: 0,
      description: "10x 3x game new", // different description -> different fingerprint
      startgametime: 1700100000,
      completiontime: 1700101000,
      options: "",
      matchhistoryreportresults: [
        { profile_id: 1, teamid: 0, resulttype: 1, civilization_id: 4 },
        { profile_id: 3, teamid: 1, resulttype: 0, civilization_id: 6 }
      ]
    },
    {
      id: 1003,
      creator_profile_id: 1,
      mapname: "bamboo",
      maxplayers: 8,
      matchtype_id: 0,
      description: "10x 3x game", // identical description, map, players to 1001 -> duplicate fingerprint
      startgametime: 1700000000,
      completiontime: 1700001000,
      options: "",
      matchhistoryreportresults: [
        { profile_id: 1, teamid: 0, resulttype: 1, civilization_id: 4 },
        { profile_id: 2, teamid: 1, resulttype: 0, civilization_id: 5 }
      ]
    }
  ];

  const mockProfiles = [
    { profile_id: 1, alias: "P1" },
    { profile_id: 2, alias: "P2" },
    { profile_id: 3, alias: "P3" }
  ];

  globalThis.fetch = (async (url: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/api/lobbies') || urlStr.includes('/api/live')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ lobbies: [] })
      } as any;
    }
    if (urlStr.includes('getRecentMatchHistory')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: { code: 0, message: "Success" },
          matchHistoryStats: mockMatches,
          profiles: mockProfiles
        })
      } as any;
    }
    return { ok: false, status: 404 } as any;
  }) as any;

  // 3. Execute crawlPlayersBatch
  const result = await crawler.crawlPlayersBatch([1], 1600000000);

  // Assertions
  assert.ok(result.success, 'Crawl should succeed');
  // Only match 1002 is counted as a new match. Match 1003 is duplicate-equivalent to 1001.
  assert.strictEqual(result.newMatchesCount, 1, 'Should find exactly 1 new match (1002)');
  
  // Verify match 1002 was added to DB
  assert.ok(db.hasMatch(1002), 'Match 1002 should be in database');
  
  // Verify match 1003 (duplicate-equivalent) was NOT added to DB
  assert.ok(!db.hasMatch(1003), 'Match 1003 (duplicate-equivalent) should NOT be in database');

  // Verify player 3 (participant of new match 1002) was added to the crawl queue
  const queue = (db as any).crawlQueue;
  assert.ok(queue.includes(3), 'New participant 3 should be added to crawl queue');
  assert.ok(!queue.includes(2), 'Existing participant 2 (from duplicate match) should NOT be added to crawl queue');
});

test('RelicCrawler - priority queue only seeds active players', async () => {
  await cleanTempDb();

  const nowSecs = Math.floor(Date.now() / 1000);
  const day10ago = nowSecs - 10 * 24 * 60 * 60;
  const day40ago = nowSecs - 40 * 24 * 60 * 60;

  // 1. Setup DB state:
  // - Match 1 (recent: 10 days ago) played by active player 100 and 101.
  // - Match 2 (old: 40 days ago) played by inactive player 200 and 201.
  const matches = `[
    {"id":1,"source":"relic_api","mapname":"bamboo","maxplayers":8,"matchtype_id":0,"description":"10x","startgametime":${day10ago},"completiontime":${day10ago + 1000},"players":[{"profile_id":100,"teamid":0,"resulttype":1,"civ_id":4,"alias":"Active1"},{"profile_id":101,"teamid":1,"resulttype":0,"civ_id":5,"alias":"Active2"}]},
    {"id":2,"source":"relic_api","mapname":"bamboo","maxplayers":8,"matchtype_id":0,"description":"10x","startgametime":${day40ago},"completiontime":${day40ago + 1000},"players":[{"profile_id":200,"teamid":0,"resulttype":1,"civ_id":4,"alias":"Inactive1"},{"profile_id":201,"teamid":1,"resulttype":0,"civ_id":5,"alias":"Inactive2"}]},
    null
  ]`;

  const profiles = `[
    {"profile_id":100,"alias":"Active1"},
    {"profile_id":101,"alias":"Active2"},
    {"profile_id":200,"alias":"Inactive1"},
    {"profile_id":201,"alias":"Inactive2"},
    null
  ]`;

  // Stale state: last crawled 30 days ago (expired cooldowns for all)
  const lastCrawlSec = nowSecs - 30 * 24 * 3600;
  const manifest = JSON.stringify({
    "100": { relic: { last_crawled_at: lastCrawlSec } },
    "101": { relic: { last_crawled_at: lastCrawlSec } },
    "200": { relic: { last_crawled_at: lastCrawlSec } },
    "201": { relic: { last_crawled_at: lastCrawlSec } }
  });

  await initTempDb({
    matches,
    profiles,
    manifest
  });

  const db = new JsonDatabase(tempDbDir);
  await db.load();

  const crawler = new RelicCrawler(db);

  // 2. Run seedPriorityQueue
  const seeds = await crawler.seedPriorityQueue(10);

  // Assertions
  assert.ok(seeds.includes(100), 'Active player 100 should be seeded');
  assert.ok(seeds.includes(101), 'Active player 101 should be seeded');
  assert.ok(!seeds.includes(200), 'Inactive player 200 (no games in last 30d) should NOT be seeded');
  assert.ok(!seeds.includes(201), 'Inactive player 201 (no games in last 30d) should NOT be seeded');
});
