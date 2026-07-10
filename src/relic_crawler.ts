import type { JsonDatabase } from './db.ts';
import type { Lobby, Match, MatchPlayer, PlayerProfile } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

// Relic Link API endpoint config
const BASE_URL = 'https://aoe-api.worldsedgelink.com';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// No cooldown — always crawl fresh on every run

export class RelicCrawler {
  private db: JsonDatabase;
  private delayMs: number;

  constructor(db: JsonDatabase, delayMs: number = 250) {
    this.db = db;
    this.delayMs = delayMs;
  }

  /**
   * Seed the crawl queue from two time windows, deduped:
   *   - Most active players in the past 3 days  (hot/current players)
   *   - Most active players in the past 30 days (regular community members)
   * Both ranked by match count within their window. Combined list is deduped.
   */
  async seedFromActivePlayers(limit: number = 50): Promise<number[]> {
    const nowSecs = Math.floor(Date.now() / 1000);
    const day3ago  = nowSecs - 3  * 24 * 3600;
    const day30ago = nowSecs - 30 * 24 * 3600;

    const matches = this.db.getMatches();

    const counts3d  = new Map<number, number>();
    const counts30d = new Map<number, number>();

    for (const m of matches) {
      for (const p of (m.players ?? [])) {
        const id = p.profile_id;
        if (m.startgametime >= day3ago)  counts3d.set(id,  (counts3d.get(id)  ?? 0) + 1);
        if (m.startgametime >= day30ago) counts30d.set(id, (counts30d.get(id) ?? 0) + 1);
      }
    }

    const topN = (map: Map<number, number>, n: number) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);

    // Take up to half the limit from each window, then dedupe
    const half    = Math.ceil(limit / 2);
    const from3d  = topN(counts3d,  half);
    const from30d = topN(counts30d, half);

    // Merge: 3d first (higher priority), then 30d to fill remaining slots
    const seen  = new Set<number>(from3d);
    const seeds = [...from3d];
    for (const id of from30d) {
      if (!seen.has(id)) { seen.add(id); seeds.push(id); }
      if (seeds.length >= limit) break;
    }

    console.log(`Seeding ${seeds.length} players (${from3d.length} from last 3d, ${seeds.length - from3d.length} from last 30d, deduped).`);
    if (seeds.length > 0) this.db.addToCrawlQueue(seeds);
    return seeds;
  }

  /**
   * Seed the crawler queue by fetching active lobbies from aoe10x.com APIs
   */
  async seedFromLobbies(): Promise<number[]> {
    console.log('Seeding crawl queue from aoe10x.com active lobbies...');
    const seedIds: number[] = [];

    // Helper to extract profiles from aoe10x.com API responses
    const fetchProfiles = async (url: string): Promise<void> => {
      try {
        console.log(`Fetching seed profiles from ${url}...`);
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (AoE2 10x Elo Ranker)' }
        });
        if (!response.ok) {
          console.warn(`Failed to fetch lobbies from ${url}: ${response.statusText}`);
          return;
        }
        const data = await response.json() as any;
        
        // 1. Process lobbies structure
        if (data.lobbies && Array.isArray(data.lobbies)) {
          for (const lobby of data.lobbies as Lobby[]) {
            if (lobby.host && lobby.host.profileId) {
              seedIds.push(lobby.host.profileId);
              this.db.addProfile({
                profile_id: lobby.host.profileId,
                alias: lobby.host.name,
                country: lobby.host.country
              });
            }
            if (lobby.players && Array.isArray(lobby.players)) {
              for (const player of lobby.players) {
                if (player.profileId) {
                  seedIds.push(player.profileId);
                  this.db.addProfile({
                    profile_id: player.profileId,
                    alias: player.name,
                    country: player.country
                  });
                }
              }
            }
          }
        }

        // 2. Process alternative games list if present
        if (data.games && Array.isArray(data.games)) {
          for (const game of data.games) {
            if (game.players && Array.isArray(game.players)) {
              for (const p of game.players) {
                if (p.profileId) {
                  seedIds.push(p.profileId);
                  this.db.addProfile({
                    profile_id: p.profileId,
                    alias: p.name || `Player_${p.profileId}`,
                    country: p.country
                  });
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`Error during lobby seeding from ${url}:`, err.message);
      }
    };

    await fetchProfiles('https://www.aoe10x.com/api/lobbies');
    await fetchProfiles('https://www.aoe10x.com/api/live');

    // Add unique seeds to queue
    const uniqueSeeds = [...new Set(seedIds)];
    if (uniqueSeeds.length > 0) {
      console.log(`Adding ${uniqueSeeds.length} seed profile IDs to queue.`);
      this.db.addToCrawlQueue(uniqueSeeds);
      await this.db.save();
    } else {
      console.warn('No active lobbies found to seed. The queue will rely on existing database profiles.');
    }

    return uniqueSeeds;
  }

  /**
   * Crawl a single player's recent matches and add new player IDs to crawl queue
   */
  async crawlPlayer(profileId: number, cutoffTimestamp: number): Promise<boolean> {
    return this.crawlPlayersBatch([profileId], cutoffTimestamp);
  }

  /**
   * Crawl a batch of players' recent matches in a single request and add new player IDs to crawl queue
   */
  async crawlPlayersBatch(profileIds: number[], cutoffTimestamp: number): Promise<boolean> {
    if (profileIds.length === 0) return true;
    const url = `${BASE_URL}/community/leaderboard/getRecentMatchHistory?title=age2&profile_ids=[${profileIds.join(',')}]`;
    console.log(`Crawling match history for batch of ${profileIds.length} players...`);

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (response.status === 429) {
        console.warn('Rate limited (429). Backing off for 10 seconds...');
        await delay(10000);
        return false;
      }

      if (!response.ok) {
        console.warn(`Relic API returned error status ${response.status} for batch`);
        return false;
      }

      const data = await response.json() as any;

      // 1. Extract and cache all profile mappings found in this API response
      const profilesMap = new Map<number, PlayerProfile>();
      if (data.profiles && Array.isArray(data.profiles)) {
        for (const p of data.profiles) {
          const profile: PlayerProfile = {
            profile_id: p.profile_id,
            alias: p.alias || `Player_${p.profile_id}`,
            country: p.country
          };
          this.db.addProfile(profile);
          profilesMap.set(p.profile_id, profile);
        }
      }

      // If no matches, mark everyone as crawled and return
      if (!data.matchHistoryStats || !Array.isArray(data.matchHistoryStats)) {
        const nowSec = Math.round(Date.now() / 1000);
        for (const pId of profileIds) {
          this.db.updatePlayerManifest(pId, 'relic', {
            last_crawled_at: nowSec
          });
          this.db.markAsCrawled(pId);
        }
        return true;
      }

      // 2. Scan matches for 10x custom lobbies
      let matchCount = 0;
      let new10xMatchCount = 0;
      const playerNewestMatchIds = new Map<number, number>();

      for (const m of data.matchHistoryStats) {
        matchCount++;
        const lobbyTitle = m.description || '';
        const is10x = /10x/i.test(lobbyTitle);
        const isRecent = m.startgametime >= cutoffTimestamp;

        const participants: MatchPlayer[] = [];
        const candidatePlayerIds: number[] = [];

        if (m.matchhistoryreportresults && Array.isArray(m.matchhistoryreportresults)) {
          for (const r of m.matchhistoryreportresults) {
            const pId = r.profile_id;
            const cachedProfile = this.db.getProfile(pId) || profilesMap.get(pId);

            participants.push({
              profile_id: pId,
              teamid: r.teamid,
              resulttype: r.resulttype, // 1 = Win, 0 = Loss
              race_id: r.civilization_id,
              alias: cachedProfile?.alias || `Player_${pId}`
            });

            candidatePlayerIds.push(pId);

            // Track newest match ID for each queried profile
            if (profileIds.includes(pId)) {
              const currentNewest = playerNewestMatchIds.get(pId) || 0;
              if (m.id > currentNewest) {
                playerNewestMatchIds.set(pId, m.id);
              }
            }
          }
        }

        if (is10x && isRecent) {
          if (participants.length === 0) {
            continue;
          }

          const matchObj: Match = {
            id: m.id,
            source: 'relic_api',
            creator_profile_id: m.creator_profile_id,
            mapname: m.mapname || '',
            maxplayers: m.maxplayers || 8,
            matchtype_id: m.matchtype_id || 0,
            description: lobbyTitle,
            startgametime: m.startgametime,
            completiontime: m.completiontime,
            players: participants,
            gamemod_id: m.gamemod_id
          };

          const isExisting = this.db.hasMatch(m.id);
          this.db.addMatch(matchObj);

          if (!isExisting) {
            const fingerprint = buildMatchFingerprint(matchObj);
            const existingMatchId = this.db.findMatchIdByFingerprint(fingerprint);
            if (existingMatchId !== undefined) {
              console.log(`Skipping duplicate-equivalent match ${m.id}; equivalent to existing match ${existingMatchId}.`);
              continue;
            }

            new10xMatchCount++;
            // Add participants of this 10x game to crawl queue
            this.db.addToCrawlQueue(candidatePlayerIds);
          }
        }
      }

      if (new10xMatchCount > 0) {
        console.log(`✨ Analyzed ${matchCount} matches. Found ${new10xMatchCount} new 10x matches! 🔥`);
      } else {
        console.log(`💤 Checked ${matchCount} matches. Found 0 new 10x matches.`);
      }

      // Update manifests and mark all queried profiles as crawled
      const nowSec = Math.round(Date.now() / 1000);
      for (const pId of profileIds) {
        const newestMatchId = playerNewestMatchIds.get(pId) || 0;
        const prevManifest = this.db.getPlayerManifest(pId);
        const prevNewestId = prevManifest?.relic?.newest_match_id || 0;

        this.db.updatePlayerManifest(pId, 'relic', {
          last_crawled_at: nowSec,
          newest_match_id: Math.max(newestMatchId, prevNewestId)
        });
        this.db.markAsCrawled(pId);
      }

      return true;
    } catch (err: any) {
      console.error(`Error crawling batch of players:`, err.message);
      return false;
    }
  }

  /**
   * Seed the crawler queue with players who haven't been crawled in a long time (background refresh)
   */
  async seedOldestCrawledPlayers(limit: number = 20): Promise<void> {
    const profiles = this.db.getAllProfiles();
    const candidates = profiles.map(p => {
      const manifest = this.db.getPlayerManifest(p.profile_id);
      return {
        profileId: p.profile_id,
        lastCrawledAt: manifest?.relic?.last_crawled_at || 0
      };
    });

    candidates.sort((a, b) => a.lastCrawledAt - b.lastCrawledAt);

    const seeds = candidates.slice(0, limit).map(c => c.profileId);
    console.log(`Seeding ${seeds.length} oldest/never crawled players to queue.`);
    if (seeds.length > 0) {
      this.db.addToCrawlQueue(seeds);
    }
  }

  /**
   * Run a snowball crawl up to a limit of crawled players
   */
  async runCrawl(limitCount: number, monthsCutoff: number = 3): Promise<void> {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (monthsCutoff * 30 * 24 * 60 * 60);
    console.log(`Starting crawl. Filtering games after Unix timestamp: ${cutoffTimestamp} (${monthsCutoff} months ago)`);

    // Seed from live lobbies, active db players, and background refreshes
    console.log('Seeding crawl queue from live lobbies + active db players + oldest crawled...');
    const livePlayerIds = new Set(await this.seedFromLobbies());
    await this.seedFromActivePlayers(limitCount);
    await this.seedOldestCrawledPlayers(20);

    if (this.db.getCrawlQueueLength() === 0) {
      console.warn('Queue is empty after seeding. Cannot crawl.');
      return;
    }

    let crawledThisSession = 0;
    const batchSize = 40;

    while (this.db.getCrawlQueueLength() > 0 && crawledThisSession < limitCount) {
      const batchIds: number[] = [];
      const remainingLimit = limitCount - crawledThisSession;
      const currentBatchSize = Math.min(batchSize, remainingLimit);

      while (batchIds.length < currentBatchSize && this.db.getCrawlQueueLength() > 0) {
        const profileId = this.db.popFromCrawlQueue();
        if (!profileId) break;

        // Skip check:
        //   1. Currently live players (online now in lobbies) have 0 cooldown (always crawled).
        //   2. Other players have an 8-hour cooldown (ensures active players are crawled at least twice per day,
        //      capturing all recent games before they fall off the Relic API's recent match list).
        const isLive = livePlayerIds.has(profileId);
        const cooldownMs = isLive ? 0 : 8 * 60 * 60 * 1000;

        if (this.db.isCrawled(profileId, cooldownMs)) {
          continue;
        }
        batchIds.push(profileId);
      }

      if (batchIds.length === 0) {
        break;
      }

      const success = await this.crawlPlayersBatch(batchIds, cutoffTimestamp);
      if (success) {
        crawledThisSession += batchIds.length;
        console.log(`Progress: ${crawledThisSession}/${limitCount} players crawled this session. Queue length: ${this.db.getCrawlQueueLength()}`);
        await this.db.save();
      }

      // Respect rate limits
      await delay(Math.max(1000, this.delayMs * 4));
    }

    await this.db.save();
    console.log(`Crawl session finished. Crawled ${crawledThisSession} players. Total matches saved: ${this.db.getMatchesCount()}`);
  }
}
