import { execSync } from 'node:child_process';
import { JsonDatabase } from '../db.ts';
import type { Match, PlayerProfile, PlayerCrawlManifest, MatchPlayer } from '../types.ts';
import { tupleToMatch, type MatchTuple } from '../matches_tuple.ts';

function getGitFileContent(ref: string, relativePath: string): string {
  try {
    return execSync(`git show ${ref}:${relativePath}`, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
  } catch (err) {
    console.warn(`Warning: Could not read ${relativePath} from ${ref}: ${(err as Error).message}`);
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
    } catch (err) {
      console.error('Failed to parse line:', cleanLine, (err as Error).message);
    }
  }
  return items;
}

export function mergeDatabasesContent(
  db: JsonDatabase,
  incoming: {
    matchesJson: string;
    profilesJson: string;
    stateJson: string;
    manifestJson: string;
  }
): { addedMatches: number } {
  // 1. Merge profiles first
  const incomingProfiles = parseJsonArrayLines<PlayerProfile>(incoming.profilesJson);
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

  interface LegacyMatchPlayer extends MatchPlayer {
    race_id?: number;
  }

  // 2. Merge matches second
  const incomingMatches = parseJsonArrayLines<Match | MatchTuple>(incoming.matchesJson);
  let incomingNewMatches = 0;
  for (const mData of incomingMatches) {
    let m: Match;
    if (Array.isArray(mData)) {
      m = tupleToMatch(mData, id => db.getProfile(id)?.alias);
    } else {
      m = mData;
      if (m.players) {
        for (const p of m.players) {
          const lp = p as LegacyMatchPlayer;
          if (lp.race_id !== undefined) {
            lp.civ_id = lp.civ_id || lp.race_id;
            delete lp.race_id;
          }
        }
      }
    }

    const isNew = !db.hasMatch(m.id);
    db.addMatch(m);
    if (isNew) incomingNewMatches++;
  }

  // 3. Merge crawl state
  if (incoming.stateJson) {
    try {
      const state = JSON.parse(incoming.stateJson);
      if (state.crawl_queue) {
        db.addToCrawlQueue(state.crawl_queue);
      }
      if (state.crawled_profiles) {
        for (const [idStr, time] of Object.entries(state.crawled_profiles)) {
          const profileId = Number(idStr);
          const localTime = db.crawledProfiles.get(profileId) || 0;
          const incomingTime = Number(time);
          if (incomingTime > localTime) {
            db.crawledProfiles.set(profileId, incomingTime);
          }
        }
      }
    } catch (err) {
      console.error('Failed to merge crawl state:', (err as Error).message);
    }
  }

  // 4. Merge crawl manifest
  if (incoming.manifestJson) {
    try {
      const manifest = JSON.parse(incoming.manifestJson) as Record<string, PlayerCrawlManifest>;
      for (const [idStr, incomingPlayerManifest] of Object.entries(manifest)) {
        const profileId = Number(idStr);
        const localPlayerManifest = db.getPlayerManifest(profileId);

        if (!localPlayerManifest) {
          db.updatePlayerManifest(profileId, 'relic', incomingPlayerManifest.relic || {});
          db.updatePlayerManifest(profileId, 'insights', incomingPlayerManifest.insights || {});
        } else {
          if (incomingPlayerManifest.relic) {
            const localRelic = localPlayerManifest.relic || { last_crawled_at: 0, newest_match_id: 0 };
            const incomingRelic = incomingPlayerManifest.relic;
            db.updatePlayerManifest(profileId, 'relic', {
              last_crawled_at: Math.max(localRelic.last_crawled_at, incomingRelic.last_crawled_at || 0),
              newest_match_id: Math.max(localRelic.newest_match_id, incomingRelic.newest_match_id || 0)
            });
          }

          if (incomingPlayerManifest.insights) {
            const localInsights = localPlayerManifest.insights || { last_crawled_at: 0, newest_match_id: 0, oldest_match_id: 0, has_reached_start: false };
            const incomingInsights = incomingPlayerManifest.insights;
            db.updatePlayerManifest(profileId, 'insights', {
              last_crawled_at: Math.max(localInsights.last_crawled_at, incomingInsights.last_crawled_at || 0),
              newest_match_id: Math.max(localInsights.newest_match_id, incomingInsights.newest_match_id || 0),
              oldest_match_id: localInsights.oldest_match_id && incomingInsights.oldest_match_id
                ? Math.min(localInsights.oldest_match_id, incomingInsights.oldest_match_id)
                : (localInsights.oldest_match_id || incomingInsights.oldest_match_id || 0),
              has_reached_start: !!(localInsights.has_reached_start || incomingInsights.has_reached_start)
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to merge crawl manifest:', (err as Error).message);
    }
  }

  return { addedMatches: incomingNewMatches };
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
  const matchesContent = getGitFileContent(ref, 'data/matches.json');
  const profilesContent = getGitFileContent(ref, 'data/profiles.json');
  const crawlStateContent = getGitFileContent(ref, 'data/crawl_state.json');
  const crawlManifestContent = getGitFileContent(ref, 'data/crawl_manifest.json');

  console.log(`Merging databases...`);
  const stats = mergeDatabasesContent(db, {
    matchesJson: matchesContent,
    profilesJson: profilesContent,
    stateJson: crawlStateContent,
    manifestJson: crawlManifestContent
  });

  console.log(`- New matches added: ${stats.addedMatches}`);
  console.log(`Saving merged database...`);
  await db.save();
  console.log(`Database merged successfully!`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(console.error);
}
