import { JsonDatabase } from '../db.ts';
import { fileURLToPath } from 'node:url';

async function main() {
  const db = new JsonDatabase();
  await db.load();
  const matches = db.getMatches();

  // First build final alias mapping
  const profileToFinalAlias = new Map<number, string>();
  for (const m of matches) {
    for (const p of m.players) {
      profileToFinalAlias.set(p.profile_id, p.alias);
    }
  }

  // Find clashing aliases
  const aliasToProfiles = new Map<string, number[]>();
  for (const [profileId, alias] of profileToFinalAlias.entries()) {
    if (!aliasToProfiles.has(alias)) {
      aliasToProfiles.set(alias, []);
    }
    aliasToProfiles.get(alias)!.push(profileId);
  }

  const clashingAliases = new Set<string>();
  for (const [alias, ids] of aliasToProfiles.entries()) {
    if (ids.length > 1) {
      clashingAliases.add(alias);
    }
  }

  console.log(`Checking ${matches.length} matches for clashing alias co-occurrences...`);
  
  let conflictCount = 0;
  for (const m of matches) {
    const visibleAliases = m.players.map((p: any) => p.alias);
    
    // Check if any clashing alias appears multiple times in this match
    // either via different profile IDs or same profile ID
    const aliasCounts = new Map<string, number>();
    for (const p of m.players) {
      const alias = profileToFinalAlias.get(p.profile_id);
      if (alias && clashingAliases.has(alias)) {
        aliasCounts.set(alias, (aliasCounts.get(alias) || 0) + 1);
      }
    }

    for (const [alias, count] of aliasCounts.entries()) {
      if (count > 1) {
        console.log(`Conflict in Match ${m.id} (${m.description}): Alias "${alias}" appears ${count} times!`);
        conflictCount++;
      }
    }
  }

  console.log(`Total conflict matches: ${conflictCount}`);
}

if (process.argv[1]) {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === currentFilePath || process.argv[1].endsWith('check_match_clashes.ts')) {
      main().catch(console.error);
    }
  } catch (err) {}
}
