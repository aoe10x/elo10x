import { JsonDatabase } from '../db.ts';

async function main() {
  console.log('Loading database...');
  const db = new JsonDatabase();
  await db.load();

  const manifestData = db.crawlManifest;
  let totalInsightsProfiles = 0;
  let deadProfiles = 0;
  let activeReachableProfiles = 0;
  const suspiciousProfiles: { playerId: number; alias: string; dbMatchesCount: number; oldestMatchId: number }[] = [];

  for (const [playerId, entry] of manifestData.entries()) {
    const insights = entry.insights;
    if (!insights) continue;

    totalInsightsProfiles++;

    if (insights.has_reached_start) {
      if (insights.newest_match_id === 0) {
        deadProfiles++;
      } else {
        activeReachableProfiles++;
        
        // Count how many matches we actually have for this player in the database
        const dbMatches = db.getMatches().filter(m => m.players.some(p => p.profile_id === playerId));
        
        // If they are marked as having reached the start of history, but they have very few matches in our DB
        // and we scraped them, they are highly likely to have been cut off by an error
        if (dbMatches.length < 80) {
          const alias = db.getProfile(playerId)?.alias || `Player_${playerId}`;
          suspiciousProfiles.push({
            playerId,
            alias,
            dbMatchesCount: dbMatches.length,
            oldestMatchId: insights.oldest_match_id
          });
        }
      }
    }
  }

  console.log('\n--- Manifest Stats ---');
  console.log(`Total profiles with Insights history: ${totalInsightsProfiles}`);
  console.log(`- Dead/404 profiles: ${deadProfiles}`);
  console.log(`- Active profiles marked as reached start: ${activeReachableProfiles}`);
  console.log(`- Suspiciously short histories marked as reached start: ${suspiciousProfiles.length}`);

  if (suspiciousProfiles.length > 0) {
    console.log('\n--- Suspicious Profiles (To Be Healed) ---');
    for (const p of suspiciousProfiles.slice(0, 30)) {
      console.log(`- ${p.alias} (ID ${p.playerId}): has ${p.dbMatchesCount} matches, oldest ID ${p.oldestMatchId}`);
    }
    if (suspiciousProfiles.length > 30) {
      console.log(`... and ${suspiciousProfiles.length - 30} more.`);
    }

    console.log('\nHealing manifest: resetting has_reached_start = false for these profiles...');
    let healedCount = 0;
    for (const p of suspiciousProfiles) {
      const entry = manifestData.get(p.playerId);
      if (entry && entry.insights) {
        entry.insights.has_reached_start = false;
        healedCount++;
      }
    }
    
    await db.save();
    console.log(`✅ Healed ${healedCount} player manifest entries successfully!`);
  } else {
    console.log('No suspicious player boundaries found in manifest.');
  }
}

main().catch(console.error);
