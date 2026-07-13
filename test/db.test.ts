import { test } from 'node:test';
import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { JsonDatabase } from '../src/db.ts';

const tempDbDir = path.join(process.cwd(), 'test', 'temp_db_format_test');

async function cleanTempDb() {
  await fs.rm(tempDbDir, { recursive: true, force: true });
}

async function initTempDb(initial: {
  matches: string;
  profiles: string;
}) {
  await fs.mkdir(tempDbDir, { recursive: true });
  await fs.writeFile(path.join(tempDbDir, 'matches.json'), initial.matches);
  await fs.writeFile(path.join(tempDbDir, 'profiles.json'), initial.profiles);
}

test('JsonDatabase - Loads and saves tuple-based matches.json with resolved aliases', async () => {
  await cleanTempDb();

  // 1. Initial database file in Option B (tuple) format:
  // Match tuple format:
  // [id, creator_profile_id, mapname, startgametime, completiontime, [[profile_id, teamid, resulttype, civ_id], ...], gamemod_id, description, source, maxplayers, matchtype_id]
  const tupleMatches = `[
    [4001, 1, "bamboo", 1700000000, 1700001000, [[1, 0, 1, 4], [2, 1, 0, 5]], null, "10x 3x game"],
    null
  ]`;

  const profiles = `[
    {"profile_id":1,"alias":"PlayerOne","country":"US"},
    {"profile_id":2,"alias":"PlayerTwo","country":"CA"},
    null
  ]`;

  await initTempDb({
    matches: tupleMatches,
    profiles: profiles
  });

  const db = new JsonDatabase(tempDbDir);
  await db.load();

  // Assert match was loaded and mapped back to the standard Match object
  const matches = db.getMatches();
  assert.strictEqual(matches.length, 1, 'Should load exactly 1 match');
  
  const m = matches[0];
  assert.strictEqual(m.id, 4001);
  assert.strictEqual(m.creator_profile_id, 1);
  assert.strictEqual(m.mapname, 'bamboo');
  assert.strictEqual(m.startgametime, 1700000000);
  assert.strictEqual(m.completiontime, 1700001000);
  assert.strictEqual(m.gamemod_id, 363188, 'Should default gamemod_id to 363188');
  assert.strictEqual(m.description, '10x 3x game');
  assert.strictEqual(m.source, 'relic_api', 'Should default source to relic_api');
  assert.strictEqual(m.maxplayers, 8, 'Should default maxplayers to 8');
  assert.strictEqual(m.matchtype_id, 0, 'Should default matchtype_id to 0');

  // Assert player details & aliases were resolved from profiles
  assert.strictEqual(m.players.length, 2);
  
  const p1 = m.players[0];
  assert.strictEqual(p1.profile_id, 1);
  assert.strictEqual(p1.teamid, 0);
  assert.strictEqual(p1.resulttype, 1);
  assert.strictEqual(p1.civ_id, 4);
  assert.strictEqual(p1.alias, 'PlayerOne', 'Should resolve alias from profiles.json');

  const p2 = m.players[1];
  assert.strictEqual(p2.profile_id, 2);
  assert.strictEqual(p2.alias, 'PlayerTwo', 'Should resolve alias from profiles.json');

  // Save the database back to disk
  await db.save();

  // Read matches.json file directly and assert it is in tuple format
  const rawMatches = await fs.readFile(path.join(tempDbDir, 'matches.json'), 'utf-8');
  assert.ok(!rawMatches.includes('"id":'), 'Saved matches.json should NOT contain keys like "id"');
  assert.ok(rawMatches.includes('[4001,1,"bamboo",1700000000'), 'Saved matches.json should be formatted as tuples');

  await cleanTempDb();
});
