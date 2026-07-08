/**
 * merge_deep_chunks.js
 *
 * Merges all scratch/deep_chunk_*.json files into docs/data/db.json.
 * - Filters for 10x games by lobby description
 * - Deduplicates by match ID and fingerprint
 * - Safe to run multiple times (idempotent)
 * - Works with any number of chunks (1-20)
 *
 * Usage: node --experimental-strip-types scratch/merge_deep_chunks.js
 */

import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { JsonDatabase } from '../src/db.ts';
import { buildMatchFingerprint } from '../src/match_fingerprint.ts';

const SCRATCH_DIR = path.resolve('scratch');

// 10x lobby name filter — same logic used elsewhere in the codebase
function is10xMatch(match) {
  const desc = (match.description ?? '').toLowerCase();
  return /10x/.test(desc);
}

async function run() {
  // Find all chunk files
  const allFiles = readdirSync(SCRATCH_DIR)
    .filter(f => /^deep_chunk_\d+\.json$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0], 10);
      const nb = parseInt(b.match(/\d+/)[0], 10);
      return na - nb;
    });

  if (allFiles.length === 0) {
    console.log('No deep_chunk_*.json files found in scratch/. Nothing to merge.');
    process.exit(0);
  }

  console.log(`Found ${allFiles.length} chunk file(s): ${allFiles.join(', ')}`);

  console.log('\nLoading database...');
  const db = new JsonDatabase();
  await db.load();
  console.log(`Current matches in db: ${db.getMatchesCount()}`);

  let totalRaw = 0;
  let totalSkipped10x = 0;
  let totalSkippedDup = 0;
  let totalAdded = 0;

  for (const file of allFiles) {
    const filePath = path.join(SCRATCH_DIR, file);
    let matches;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      matches = JSON.parse(content);
    } catch(e) {
      console.warn(`  ⚠️  Could not read ${file}: ${e.message}`);
      continue;
    }

    console.log(`\nProcessing ${file} — ${matches.length} raw matches...`);
    totalRaw += matches.length;

    let fileAdded = 0;

    for (const m of matches) {
      // Must be a 10x game
      if (!is10xMatch(m)) { totalSkipped10x++; continue; }

      // Deduplicate by match ID
      if (db.hasMatch(m.id)) { totalSkippedDup++; continue; }

      // Deduplicate by fingerprint (catches same game with different IDs)
      const fingerprint = buildMatchFingerprint(m);
      if (db.findMatchIdByFingerprint(fingerprint) !== undefined) {
        totalSkippedDup++;
        continue;
      }

      // Upsert player profiles (preserve existing country data)
      if (m.players) {
        for (const p of m.players) {
          const existing = db.getProfile(p.profile_id);
          db.addProfile({
            profile_id: p.profile_id,
            alias: p.alias,
            country: existing?.country || p.country || 'Unknown',
          });
        }
      }

      db.addMatch(m);
      fileAdded++;
      totalAdded++;
    }

    console.log(`  → added ${fileAdded} new unique 10x matches from ${file}`);
  }

  console.log('\n─────────────────────────────────────');
  console.log(`Raw matches processed : ${totalRaw}`);
  console.log(`Skipped (not 10x)     : ${totalSkipped10x}`);
  console.log(`Skipped (duplicate)   : ${totalSkippedDup}`);
  console.log(`New matches added     : ${totalAdded}`);
  console.log('─────────────────────────────────────');

  if (totalAdded > 0) {
    console.log('\nSaving database...');
    await db.save();
    console.log(`✅ Done! db.json now has ${db.getMatchesCount()} matches.`);
    console.log('\nNext step: pnpm run elo');
  } else {
    console.log('\nℹ️  No new matches to add — db.json unchanged.');
  }
}

run().catch(e => {
  console.error('Merge failed:', e);
  process.exit(1);
});
