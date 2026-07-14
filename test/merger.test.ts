import { test } from 'node:test';
import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { JsonDatabase } from '../src/db.ts';
import { mergeDatabasesContent } from '../src/tools/merge_git_databases.ts';

const tempDbDir = path.join(process.cwd(), 'test', 'temp_database_test');

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

test('Database Merger Tool - Core Merging Logic', async () => {
  await cleanTempDb();

  // 1. Setup initial local DB state
  const initialMatches = `[
  {"id":101,"startgametime":1700000000,"source":"relic_api","players":[{"profile_id":1,"civ_id":4},{"profile_id":2,"civ_id":5}],"description":"10x 3x","mapname":"my map"},
  null
]`;
  const initialProfiles = `[
  {"profile_id":1,"alias":"PlayerOne","country":"US"},
  {"profile_id":2,"alias":"PlayerTwo","country":"Unknown"},
  null
]`;
  const initialCrawlState = JSON.stringify({
    crawl_queue: [3, 4],
    crawled_profiles: {
      "1": 1700000000,
      "2": 1700000000
    }
  });
  const initialCrawlManifest = JSON.stringify({
    "1": {
      relic: { last_crawled_at: 1700000000, newest_match_id: 101 },
      insights: { last_crawled_at: 1690000000, newest_match_id: 50, oldest_match_id: 50, has_reached_start: true }
    }
  });

  await initTempDb({
    matches: initialMatches,
    profiles: initialProfiles,
    state: initialCrawlState,
    manifest: initialCrawlManifest
  });

  const db = new JsonDatabase(tempDbDir);
  await db.load();

  // 2. Setup incoming DB state from Git (representing conflicts / new crawl updates)
  const incomingMatches = `[
  {"id":101,"startgametime":1700000000,"source":"aoe2insights_scrape","players":[{"profile_id":1,"civ_id":4},{"profile_id":2,"civ_id":5}],"description":"10x 3x","mapname":"Enclosed_Paren_V2"},
  {"id":102,"startgametime":1700100000,"source":"relic_api","players":[{"profile_id":1,"race_id":7},{"profile_id":3,"race_id":8}],"description":"10x"},
  null
]`;
  const incomingProfiles = `[
  {"profile_id":1,"alias":"PlayerOneUpdated","country":"US"},
  {"profile_id":2,"alias":"PlayerTwo","country":"FR"},
  {"profile_id":3,"alias":"PlayerThree","country":"DE"},
  null
]`;
  const incomingCrawlState = JSON.stringify({
    crawl_queue: [4, 5],
    crawled_profiles: {
      "1": 1700100000,
      "3": 1700100000
    }
  });
  const incomingCrawlManifest = JSON.stringify({
    "1": {
      relic: { last_crawled_at: 1700100000, newest_match_id: 102 },
      insights: { last_crawled_at: 1680000000, newest_match_id: 40, oldest_match_id: 40, has_reached_start: false }
    },
    "3": {
      relic: { last_crawled_at: 1700100000, newest_match_id: 102 }
    }
  });

  // 3. Execute merge logic
  const stats = mergeDatabasesContent(db, {
    matchesJson: incomingMatches,
    profilesJson: incomingProfiles,
    stateJson: incomingCrawlState,
    manifestJson: incomingCrawlManifest
  });

  // 4. Assertions on in-memory merged database
  assert.strictEqual(stats.addedMatches, 1, 'Should add exactly 1 new match (ID 102)');
  assert.strictEqual(db.getMatchesCount(), 2, 'Should have 2 matches total');

  // Verify match 101 was successfully merged (enriched with insights mapname and updated source)
  const match101 = (db as any).matches.get(101);
  assert.ok(match101);
  assert.strictEqual(match101.mapname, 'Enclosed_Paren_V2', 'Duplicate match map name should be updated');
  assert.strictEqual(match101.source, 'merged', 'Duplicate match source should be set to merged');

  // Verify match 102 was added and race_id was migrated to civ_id
  const match102 = (db as any).matches.get(102);
  assert.ok(match102);
  assert.strictEqual(match102.players?.[0].civ_id, 7, 'race_id should migrate to civ_id');
  assert.strictEqual((match102.players?.[0] as any).race_id, undefined, 'race_id property should be removed');

  // Verify profiles were merged
  const profile1 = db.getProfile(1);
  assert.strictEqual(profile1?.alias, 'PlayerOneUpdated', 'Profile alias should update to latest');
  
  const profile2 = db.getProfile(2);
  assert.strictEqual(profile2?.country, 'FR', 'Profile country should update from Unknown');

  const profile3 = db.getProfile(3);
  assert.ok(profile3, 'New profile 3 should be added');
  assert.strictEqual(profile3.alias, 'PlayerThree');

  // Verify crawl state merged (crawlQueue deduplicated)
  const localQueue = (db as any).crawlQueue;
  assert.deepStrictEqual(localQueue, [3, 4, 5]);

  // Verify crawled profiles timestamps merged (taking max)
  assert.strictEqual((db as any).crawledProfiles.get(1), 1700100000, 'Profile 1 crawled time should update');
  assert.strictEqual((db as any).crawledProfiles.get(2), 1700000000, 'Profile 2 crawled time should remain unchanged');
  assert.strictEqual((db as any).crawledProfiles.get(3), 1700100000, 'Profile 3 crawled time should be added');

  // Verify crawl manifest merged
  const manifest1 = db.getPlayerManifest(1);
  assert.ok(manifest1);
  // Relic: initial relic had last_crawled_at 1700000000, newest 101
  // Incoming relic had last_crawled_at 1700100000, newest 102
  // Merge relic should be: last_crawled_at 1700100000, newest 102
  assert.strictEqual(manifest1.relic?.last_crawled_at, 1700100000);
  assert.strictEqual(manifest1.relic?.newest_match_id, 102);

  // Insights: initial insights had last_crawled_at 1690000000, newest 50, oldest 50, has_reached_start true
  // Incoming insights had last_crawled_at 1680000000, newest 40, oldest 40, has_reached_start false
  // Merge insights should be: last_crawled_at 1690000000, newest 50, oldest 40, has_reached_start true
  assert.strictEqual(manifest1.insights?.last_crawled_at, 1690000000);
  assert.strictEqual(manifest1.insights?.newest_match_id, 50);
  assert.strictEqual(manifest1.insights?.oldest_match_id, 40);
  assert.strictEqual(manifest1.insights?.has_reached_start, true);

  const manifest3 = db.getPlayerManifest(3);
  assert.ok(manifest3);
  assert.strictEqual(manifest3.relic?.last_crawled_at, 1700100000);

  // 5. Test db.save() works with merged state
  await db.save();

  // Load from disk again to confirm file integrity
  const verifyDb = new JsonDatabase(tempDbDir);
  await verifyDb.load();

  assert.strictEqual(verifyDb.getMatchesCount(), 2);
  assert.strictEqual(verifyDb.getProfile(2)?.country, 'FR');
  assert.deepStrictEqual((verifyDb as any).crawlQueue, [3, 4, 5]);

  await cleanTempDb();
});

test('Database Merger Tool - Tuple Merging Logic', async () => {
  await cleanTempDb();

  // 1. Initial local DB state (Option B tuple format on disk)
  const initialMatches = `[
    [101, null, "my map", 1700000000, null, [[1, 0, 1, 4], [2, 1, 0, 5]], null, "10x 3x"],
    null
  ]`;
  const initialProfiles = `[
    {"profile_id":1,"alias":"PlayerOne","country":"US"},
    {"profile_id":2,"alias":"PlayerTwo","country":"Unknown"},
    null
  ]`;
  
  await initTempDb({
    matches: initialMatches,
    profiles: initialProfiles
  });

  const db = new JsonDatabase(tempDbDir);
  await db.load();

  // 2. Incoming database content from git (also in tuple format)
  const incomingMatches = `[
    [101, null, "my map", 1700000000, null, [[1, 0, 1, 4], [2, 1, 0, 5]], null, "10x 3x"],
    [102, null, "enclosed", 1700100000, null, [[1, 0, 1, 7], [3, 1, 0, 8]], null, "10x"],
    null
  ]`;
  const incomingProfiles = `[
    {"profile_id":1,"alias":"PlayerOneUpdated","country":"US"},
    {"profile_id":2,"alias":"PlayerTwo","country":"FR"},
    {"profile_id":3,"alias":"PlayerThree","country":"DE"},
    null
  ]`;

  // 3. Execute merge
  const stats = mergeDatabasesContent(db, {
    matchesJson: incomingMatches,
    profilesJson: incomingProfiles,
    stateJson: '{}',
    manifestJson: '{}'
  });

  assert.strictEqual(stats.addedMatches, 1, 'Should add exactly 1 new match (102)');
  assert.strictEqual(db.getMatchesCount(), 2, 'Total matches in db should be 2');

  // Verify match 102 was correctly merged and has resolved player aliases
  const m102 = db.getMatches().find(m => m.id === 102);
  assert.ok(m102);
  assert.strictEqual(m102.mapname, 'enclosed');
  assert.strictEqual(m102.players.length, 2);
  assert.strictEqual(m102.players[0].alias, 'PlayerOneUpdated', 'Alias should be resolved from merged profiles');
  assert.strictEqual(m102.players[1].alias, 'PlayerThree', 'Alias should be resolved from merged profiles');

  await cleanTempDb();
});

