import zlib from 'node:zlib';
import type { JsonDatabase } from './db.ts';
import type { Lobby, Match, MatchPlayer, PlayerProfile } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

// Relic Link API endpoint config
const BASE_URL = 'https://aoe-api.worldsedgelink.com';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// No cooldown — always crawl fresh on every run

function decodeOptions(optionsB64: string | undefined): Record<string, string> {
  if (!optionsB64) return {};
  try {
    const compressed = Buffer.from(optionsB64, 'base64');
    const decompressedStr = zlib.inflateSync(compressed).toString('utf8').trim();
    
    let rawStr = decompressedStr;
    if (rawStr.startsWith('"') && rawStr.endsWith('"')) {
      rawStr = rawStr.slice(1, -1);
    }
    
    const binaryBuffer = Buffer.from(rawStr, 'base64');
    if (binaryBuffer.length === 0) return {};
    
    const pairCount = binaryBuffer.readUInt8(0);
    const options: Record<string, string> = {};
    let offset = 1;
    
    for (let i = 0; i < pairCount; i++) {
      if (offset + 4 > binaryBuffer.length) break;
      const len = binaryBuffer.readInt32LE(offset);
      offset += 4;
      if (offset + len > binaryBuffer.length) break;
      const kvStr = binaryBuffer.toString('utf8', offset, offset + len);
      offset += len;
      
      const colonIndex = kvStr.indexOf(':');
      if (colonIndex !== -1) {
        options[kvStr.slice(0, colonIndex)] = kvStr.slice(colonIndex + 1);
      }
    }
    return options;
  } catch (err: any) {
    console.warn('Failed to parse match options string:', err.message);
    return {};
  }
}

export class RelicCrawler {
  private db: JsonDatabase;
  private delayMs: number;

  constructor(db: JsonDatabase, delayMs: number = 250) {
    this.db = db;
    this.delayMs = delayMs;
  }

  /**
   * Seeds the crawl queue using Unified Priority Seeding:
   * Priority = (Activity_30d + 0.5) * Staleness_Hours
   * This balances active player freshness and prevents inactive player starvation.
   */
  async seedPriorityQueue(limit: number): Promise<number[]> {
    const nowSecs = Math.floor(Date.now() / 1000);
    const day30Sec = 30 * 24 * 60 * 60;
    const day30ago = nowSecs - day30Sec;

    const rolling30d = new Map<number, number>();
    for (const m of this.db.getMatches()) {
      if (m.startgametime >= day30ago && m.players) {
        for (const p of m.players) {
          rolling30d.set(p.profile_id, (rolling30d.get(p.profile_id) || 0) + 1);
        }
      }
    }

    const profiles = this.db.getAllProfiles();
    const scored = profiles.map(p => {
      const pid = p.profile_id;
      const activity = rolling30d.get(pid) || 0;
      const manifest = this.db.getPlayerManifest(pid);
      
      // If never crawled, seed staleness to 30 days ago
      const lastCrawlSec = manifest?.relic?.last_crawled_at || (nowSecs - day30Sec);
      const stalenessSec = Math.max(0, nowSecs - lastCrawlSec);
      const stalenessHours = stalenessSec / 3600;

      // Priority = (Activity + 0.5) * Staleness_Hours
      const score = (activity + 0.5) * stalenessHours;
      return { pid, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const seeds = scored.slice(0, limit).map(s => s.pid);

    console.log(`Seeding queue with top ${seeds.length} players using Unified Priority Seeding (activity * staleness).`);
    if (seeds.length > 0) {
      this.db.addToCrawlQueue(seeds);
    }
    return seeds;
  }

  /**
   * Calculates a dynamic cooldown for player crawling based on their activity in the last 30 days
   */
  private getDynamicCooldownMs(profileId: number, counts30d: Map<number, number>, isLive: boolean): number {
    if (isLive) return 0; // Live players always have 0 cooldown
    
    const count = counts30d.get(profileId) || 0;
    
    if (count >= 80) {
      // Extremely active (e.g. 2.6+ games/day) -> Cooldown: 2 hours
      return 2 * 60 * 60 * 1000;
    }
    if (count >= 40) {
      // Very active (e.g. 1.3+ games/day) -> Cooldown: 4 hours
      return 4 * 60 * 60 * 1000;
    }
    if (count >= 15) {
      // Moderately active (e.g. 0.5+ games/day) -> Cooldown: 8 hours
      return 8 * 60 * 60 * 1000;
    }
    if (count >= 5) {
      // Semi-active -> Cooldown: 24 hours (1 day)
      return 24 * 60 * 60 * 1000;
    }
    // Inactive -> Cooldown: 72 hours (3 days)
    return 72 * 60 * 60 * 1000;
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
    const result = await this.crawlPlayersBatch([profileId], cutoffTimestamp);
    return result.success;
  }

  /**
   * Crawl a batch of players' recent matches in a single request and add new player IDs to crawl queue
   */
  async crawlPlayersBatch(profileIds: number[], cutoffTimestamp: number): Promise<{ success: boolean; newMatchesCount: number }> {
    if (profileIds.length === 0) return { success: true, newMatchesCount: 0 };
    const url = `${BASE_URL}/community/leaderboard/getRecentMatchHistory?title=age2&profile_ids=[${profileIds.join(',')}]`;
    console.log(`Crawling match history for batch of ${profileIds.length} players...`);

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (response.status === 429) {
        console.warn('Rate limited (429). Backing off for 10 seconds...');
        await delay(10000);
        return { success: false, newMatchesCount: 0 };
      }

      if (!response.ok) {
        console.warn(`Relic API returned error status ${response.status} for batch`);
        return { success: false, newMatchesCount: 0 };
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
        return { success: true, newMatchesCount: 0 };
      }

      // 2. Scan matches for 10x custom lobbies
      let matchCount = 0;
      let new10xMatchCount = 0;
      const playerNewestMatchIds = new Map<number, number>();

      for (const m of data.matchHistoryStats) {
        matchCount++;
        const parsedOptions = decodeOptions(m.options);
        
        const modId = parsedOptions['59'];
        const modName = parsedOptions['63'];
        const lobbyTitle = m.description || '';
        
        // 10x Classification:
        // - Mod ID 59 is official mod ID (e.g. 363188)
        // - Mod Name 63 contains "10x" or "3x"
        // - Or lobby title matches regex
        const isMod10x = modId === '363188' || (modName && /10x/i.test(modName)) || (modName && /3x/i.test(modName));
        const isTitle10x = /10x/i.test(lobbyTitle);
        const is10x = isMod10x || isTitle10x;
        
        const isRecent = m.startgametime >= cutoffTimestamp;

        // Custom map resolution:
        // - Key 11 contains custom map .rms script filename
        // - Fallback to API mapname
        let mapname = m.mapname || '';
        const customMap = parsedOptions['11'];
        if (customMap && customMap.endsWith('.rms')) {
          mapname = customMap.replace(/\.rms$/i, '').trim();
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
              civ_id: r.civilization_id,
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
            mapname: mapname,
            maxplayers: m.maxplayers || 8,
            matchtype_id: m.matchtype_id || 0,
            description: lobbyTitle,
            startgametime: m.startgametime,
            completiontime: m.completiontime,
            players: participants,
            gamemod_id: modId ? parseInt(modId, 10) : (m.gamemod_id || undefined)
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

      return { success: true, newMatchesCount: new10xMatchCount };
    } catch (err: any) {
      console.error(`Error crawling batch of players:`, err.message);
      return { success: false, newMatchesCount: 0 };
    }
  }



  /**
   * Run a snowball crawl up to a limit of crawled players
   */
  async runCrawl(limitCount: number, monthsCutoff: number = 3, force: boolean = false): Promise<void> {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (monthsCutoff * 30 * 24 * 60 * 60);
    console.log(`Starting crawl. Filtering games after Unix timestamp: ${cutoffTimestamp} (${monthsCutoff} months ago)`);

    // Calculate last 30 days activity once to compute dynamic player cooldowns
    const nowSecs = Math.floor(Date.now() / 1000);
    const day30ago = nowSecs - 30 * 24 * 3600;
    const counts30d = new Map<number, number>();
    for (const m of this.db.getMatches()) {
      if (m.startgametime >= day30ago && m.players) {
        for (const p of m.players) {
          counts30d.set(p.profile_id, (counts30d.get(p.profile_id) || 0) + 1);
        }
      }
    }

    // Seed from live lobbies and prioritized player queue
    console.log('Seeding crawl queue from live lobbies + prioritized player queue...');
    const livePlayerIds = new Set(await this.seedFromLobbies());
    await this.seedPriorityQueue(limitCount);

    if (this.db.getCrawlQueueLength() === 0) {
      console.warn('Queue is empty after seeding. Cannot crawl.');
      return;
    }

    let crawledThisSession = 0;
    let totalNewMatchesAdded = 0;
    const batchSize = 40;

    while (this.db.getCrawlQueueLength() > 0 && crawledThisSession < limitCount) {
      const batchIds: number[] = [];
      const remainingLimit = limitCount - crawledThisSession;
      const currentBatchSize = Math.min(batchSize, remainingLimit);

      while (batchIds.length < currentBatchSize && this.db.getCrawlQueueLength() > 0) {
        const profileId = this.db.popFromCrawlQueue();
        if (!profileId) break;

        if (!force) {
          // Dynamic Cooldown Strategy:
          // 1. Live players have 0 cooldown (always crawled).
          // 2. Active players cooldown scales dynamically between 2h and 72h based on their recent activity.
          const isLive = livePlayerIds.has(profileId);
          const cooldownMs = this.getDynamicCooldownMs(profileId, counts30d, isLive);

          if (this.db.isCrawled(profileId, cooldownMs)) {
            continue;
          }
        }
        batchIds.push(profileId);
      }

      if (batchIds.length === 0) {
        break;
      }

      const result = await this.crawlPlayersBatch(batchIds, cutoffTimestamp);
      if (result.success) {
        crawledThisSession += batchIds.length;
        totalNewMatchesAdded += result.newMatchesCount;
        console.log(`Progress: ${crawledThisSession}/${limitCount} players crawled this session. Queue length: ${this.db.getCrawlQueueLength()}`);
        await this.db.save();
      }

      // Respect rate limits
      await delay(Math.max(1000, this.delayMs * 4));
    }

    await this.db.save();
    console.log(`\n========================================`);
    console.log(`Crawl session finished!`);
    console.log(`- Crawled: ${crawledThisSession} players`);
    console.log(`- New 10x matches added: ${totalNewMatchesAdded}`);
    console.log(`- Total matches in DB: ${this.db.getMatchesCount()}`);
    console.log(`========================================`);
  }
}
