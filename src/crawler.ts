import type { JsonDatabase } from './db.ts';
import type { Lobby, Match, MatchPlayer, PlayerProfile } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

// Relic Link API endpoint config
const BASE_URL = 'https://aoe-api.worldsedgelink.com';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class MatchCrawler {
  private db: JsonDatabase;
  private delayMs: number;

  constructor(db: JsonDatabase, delayMs: number = 250) {
    this.db = db;
    this.delayMs = delayMs;
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
    const url = `${BASE_URL}/community/leaderboard/getRecentMatchHistoryByProfileId?title=age2&profile_id=${profileId}`;
    console.log(`Crawling match history for player ID ${profileId}...`);

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (response.status === 429) {
        console.warn('Rate limited (429). Backing off for 5 seconds...');
        await delay(5000);
        return false;
      }

      if (!response.ok) {
        console.warn(`Relic API returned error status ${response.status} for player ${profileId}`);
        this.db.markAsCrawled(profileId); // Mark as done to prevent infinite loops on invalid profiles
        return false;
      }

      const data = await response.json() as any;
      if (!data.matchHistoryStats || !Array.isArray(data.matchHistoryStats)) {
        this.db.markAsCrawled(profileId);
        return true;
      }

      // 1. Extract and cache all profile mappings found in this API response
      const profilesMap = new Map<number, PlayerProfile>();
      if (data.profiles && Array.isArray(data.profiles)) {
        for (const p of data.profiles) {
          const profile: PlayerProfile = {
            profile_id: p.profile_id,
            alias: p.alias || `Player_${p.profile_id}`,
            xp: p.xp,
            level: p.level,
            country: p.country
          };
          this.db.addProfile(profile);
          profilesMap.set(p.profile_id, profile);
        }
      }

      // 2. Scan matches for 10x custom lobbies
      let matchCount = 0;
      let new10xMatchCount = 0;

      for (const m of data.matchHistoryStats) {
        matchCount++;
        const lobbyTitle = m.description || '';
        const is10x = /10x/i.test(lobbyTitle);

        // Filter: Match description contains "10x", and was started in the last 3 months
        if (is10x && m.startgametime >= cutoffTimestamp) {
          if (this.db.hasMatch(m.id)) {
            continue; // Already processed
          }

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
            }
          }

          // Skip matches that don't have participants mapped
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

          const fingerprint = buildMatchFingerprint(matchObj);
          const existingMatchId = this.db.findMatchIdByFingerprint(fingerprint);
          if (existingMatchId !== undefined) {
            console.log(`Skipping duplicate-equivalent match ${m.id}; equivalent to existing match ${existingMatchId}.`);
            continue;
          }

          this.db.addMatch(matchObj);
          new10xMatchCount++;

          // Add participants of this 10x game to crawl queue
          this.db.addToCrawlQueue(candidatePlayerIds);
        }
      }

      console.log(`Analyzed ${matchCount} matches. Found ${new10xMatchCount} new 10x matches.`);
      this.db.markAsCrawled(profileId);
      return true;
    } catch (err: any) {
      console.error(`Error crawling player ${profileId}:`, err.message);
      // Don't mark as crawled, we might want to retry later
      return false;
    }
  }

  /**
   * Run a snowball crawl up to a limit of crawled players
   */
  async runCrawl(limitCount: number, monthsCutoff: number = 3): Promise<void> {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (monthsCutoff * 30 * 24 * 60 * 60);
    console.log(`Starting crawl. Filtering games after Unix timestamp: ${cutoffTimestamp} (${monthsCutoff} months ago)`);

    // Ensure queue has at least some seeds, otherwise run seedFromLobbies
    if (this.db.getCrawlQueueLength() === 0) {
      console.log('Crawl queue is empty. Fetching initial seeds...');
      const seedIds = await this.seedFromLobbies();
      if (seedIds.length === 0) {
        console.warn('Queue remains empty after seeding. Cannot crawl. Add manual seeds or run when lobbies are online.');
        return;
      }
    }

    let crawledThisSession = 0;
    while (this.db.getCrawlQueueLength() > 0 && crawledThisSession < limitCount) {
      const profileId = this.db.popFromCrawlQueue();
      if (!profileId) break;

      if (this.db.isCrawled(profileId)) {
        continue;
      }

      const success = await this.crawlPlayer(profileId, cutoffTimestamp);
      if (success) {
        crawledThisSession++;
        console.log(`Progress: ${crawledThisSession}/${limitCount} players crawled this session. Queue length: ${this.db.getCrawlQueueLength()}`);
        
        // Periodic save to keep progress in case of crash or interrupt
        if (crawledThisSession % 5 === 0) {
          await this.db.save();
        }
      }

      // Respect rate limits
      await delay(this.delayMs);
    }

    await this.db.save();
    console.log(`Crawl session finished. Crawled ${crawledThisSession} players. Total matches saved: ${this.db.getMatchesCount()}`);
  }
}
