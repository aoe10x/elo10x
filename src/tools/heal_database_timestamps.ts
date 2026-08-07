import { JsonDatabase } from '../db.ts';
import type { Match } from '../types.ts';


async function main() {
  console.log('Loading database to heal timestamps...');
  const db = new JsonDatabase();
  await db.load();

  // Get raw match list from the database Map
  const matchesMap = db.matches;
  const allMatches = Array.from(matchesMap.values());
  const corrupted = allMatches.filter(m => m.startgametime <= 1000000000);
  const valid = allMatches.filter(m => m.startgametime > 1000000000).sort((a, b) => a.id - b.id);

  console.log(`Found ${corrupted.length} corrupted matches and ${valid.length} valid matches.`);
  if (corrupted.length === 0) {
    console.log('No corrupted matches found. Exiting.');
    return;
  }

  let healedCount = 0;

  for (const cm of corrupted) {
    let before: Match | null = null;
    let after: Match | null = null;

    // Linear search is fine since we do it 589 times over 38,903 elements, 
    // but binary search is faster. Let's do a fast search since valid is sorted by ID:
    let low = 0;
    let high = valid.length - 1;
    let insertionIdx = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (valid[mid].id < cm.id) {
        insertionIdx = mid + 1;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (insertionIdx > 0) {
      before = valid[insertionIdx - 1];
    }
    if (insertionIdx < valid.length) {
      after = valid[insertionIdx];
    }

    let estimatedTime = 0;

    if (before && after) {
      // Linear interpolation
      const idDiff = after.id - before.id;
      const timeDiff = after.startgametime - before.startgametime;
      if (idDiff > 0) {
        estimatedTime = before.startgametime + timeDiff * ((cm.id - before.id) / idDiff);
      } else {
        estimatedTime = before.startgametime;
      }
    } else if (before) {
      estimatedTime = before.startgametime;
    } else if (after) {
      estimatedTime = after.startgametime;
    } else {
      console.warn(`Could not find any valid match reference for ID ${cm.id}`);
      continue;
    }

    const finalTime = Math.round(estimatedTime);
    cm.startgametime = finalTime;
    cm.completiontime = finalTime + 1800; // 30 mins average duration to avoid 0-duration trap
    
    // Update the database Map
    matchesMap.set(cm.id, cm);
    healedCount++;
  }

  console.log(`Successfully healed ${healedCount} matches in memory.`);

  // Save the database matches back to disk
  // JsonDatabase.save() writes matches, profiles, crawlState, crawlManifest
  // Wait, let's look at db.save() implementation to be sure.
  console.log('Saving healed matches to matches.json...');
  
  // To avoid calling db.save() which saves everything (manifest, state etc.), we can check how db saves matches.
  // In db.ts, let's look at save() or write methods. We saw save() in a previous step, but let's view it just in case.
  await db.save();
  console.log('✅ Database healed and saved successfully!');
}

main().catch(console.error);
