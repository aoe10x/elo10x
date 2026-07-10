import { execSync } from 'node:child_process';
import { JsonDatabase } from '../db.ts';
import type { Match, PlayerProfile, PlayerCrawlManifest } from '../types.ts';

function getGitFileContent(ref: string, relativePath: string): string {
  try {
    return execSync(`git show ${ref}:${relativePath}`, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
  } catch (err: any) {
    console.warn(`Warning: Could not read ${relativePath} from ${ref}: ${err.message}`);
    return '';
  }
}

function parseJsonArrayLines<T>(content: string): T[] {
  const items: T[] = [];
  if (!content) return items;
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[' || trimmed === ']' || !trimmed) continue;
    const cleanLine = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    if (cleanLine === 'null') continue;
    try {
      items.push(JSON.parse(cleanLine));
    } catch (err: any) {
      console.error('Failed to parse line:', cleanLine, err.message);
    }
  }
  return items;
}

async function main() {
  const ref = process.argv[2];
  if (!ref) {
    console.error('Usage: node src/tools/merge_git_databases.ts <git-ref> (e.g. origin/main)');
    process.exit(1);
  }

  console.log(`Loading local database...`);
  const db = new JsonDatabase();
  await db.load();

  console.log(`Fetching database files from Git ref "${ref}"...`);
  const matchesContent = getGitFileContent(ref, 'docs/data/matches.json');
  const profilesContent = getGitFileContent(ref, 'docs/data/profiles.json');
  const crawlStateContent = getGitFileContent(ref, 'docs/data/crawl_state.json');
  const crawlManifestContent = getGitFileContent(ref, 'docs/data/crawl_manifest.json');

  // 1. Merge matches
  const incomingMatches = parseJsonArrayLines<Match>(matchesContent);
  console.log(`Merging ${incomingMatches.length} matches from ${ref}...`);
  let incomingNewMatches = 0;
  for (const m of incomingMatches) {
    if (m.players) {
      for (const p of m.players) {
        if ((p as any).race_id !== undefined) {
          p.civ_id = p.civ_id || (p as any).race_id;
          delete (p as any).race_id;
        }
      }
    }

    const isNew = !db.hasMatch(m.id);
    db.addMatch(m);
    if (isNew) incomingNewMatches++;
  }
  console.log(`- New matches added: ${incomingNewMatches}`);

  // 2. Merge profiles
  const incomingProfiles = parseJsonArrayLines<PlayerProfile>(profilesContent);
  console.log(`Merging ${incomingProfiles.length} profiles from ${ref}...`);
  for (const p of incomingProfiles) {
    const existing = db.getProfile(p.profile_id);
    if (!existing) {
      db.addProfile(p);
    } else {
      if (p.alias && p.alias !== existing.alias) {
        existing.alias = p.alias;
      }
      if (p.country && p.country !== 'Unknown') {
        existing.country = p.country;
      }
    }
  }

  // 3. Merge crawl state
  if (crawlStateContent) {
    try {
      const state = JSON.parse(crawlStateContent);
      console.log(`Merging crawl state...`);
      
      if (state.crawl_queue) {
        db.addToCrawlQueue(state.crawl_queue);
      }
      
      if (state.crawled_profiles) {
        for (const [idStr, time] of Object.entries(state.crawled_profiles)) {
          const profileId = Number(idStr);
          const localTime = (db as any).crawledProfiles.get(profileId) || 0;
          const incomingTime = Number(time);
          if (incomingTime > localTime) {
            (db as any).crawledProfiles.set(profileId, incomingTime);
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to merge crawl state:', err.message);
    }
  }

  // 4. Merge crawl manifest
  if (crawlManifestContent) {
    try {
      const manifest = JSON.parse(crawlManifestContent) as Record<string, PlayerCrawlManifest>;
      console.log(`Merging crawl manifest...`);
      for (const [idStr, incomingPlayerManifest] of Object.entries(manifest)) {
        const profileId = Number(idStr);
        const localPlayerManifest = db.getPlayerManifest(profileId);

        if (!localPlayerManifest) {
          db.updatePlayerManifest(profileId, 'relic', incomingPlayerManifest.relic || {});
          db.updatePlayerManifest(profileId, 'insights', incomingPlayerManifest.insights || {});
        } else {
          if (incomingPlayerManifest.relic) {
            const localRelic = localPlayerManifest.relic || {};
            const incomingRelic = incomingPlayerManifest.relic;
            db.updatePlayerManifest(profileId, 'relic', {
              last_crawled_at: Math.max(localRelic.last_crawled_at || 0, incomingRelic.last_crawled_at || 0),
              newest_match_id: Math.max(localRelic.newest_match_id || 0, incomingRelic.newest_match_id || 0),
              oldest_match_id: localRelic.oldest_match_id && incomingRelic.oldest_match_id 
                ? Math.min(localRelic.oldest_match_id, incomingRelic.oldest_match_id)
                : (localRelic.oldest_match_id || incomingRelic.oldest_match_id || 0),
              has_reached_start: !!(localRelic.has_reached_start || incomingRelic.has_reached_start)
            });
          }

          if (incomingPlayerManifest.insights) {
            const localInsights = localPlayerManifest.insights || {};
            const incomingInsights = incomingPlayerManifest.insights;
            db.updatePlayerManifest(profileId, 'insights', {
              last_crawled_at: Math.max(localInsights.last_crawled_at || 0, incomingInsights.last_crawled_at || 0),
              newest_match_id: Math.max(localInsights.newest_match_id || 0, incomingInsights.newest_match_id || 0),
              oldest_match_id: localInsights.oldest_match_id && incomingInsights.oldest_match_id
                ? Math.min(localInsights.oldest_match_id, incomingInsights.oldest_match_id)
                : (localInsights.oldest_match_id || incomingInsights.oldest_match_id || 0),
              has_reached_start: !!(localInsights.has_reached_start || incomingInsights.has_reached_start)
            });
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to merge crawl manifest:', err.message);
    }
  }

  console.log(`Saving merged database...`);
  await db.save();
  console.log(`Database merged successfully!`);
}

main().catch(console.error);
