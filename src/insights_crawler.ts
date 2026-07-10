import type { JsonDatabase } from './db.ts';
import { Aoe2InsightsScraper } from './aoe2insights_scraper.ts';

export class InsightsCrawler {
  private db: JsonDatabase;
  private scraper: Aoe2InsightsScraper;

  constructor(db: JsonDatabase) {
    this.db = db;
    this.scraper = new Aoe2InsightsScraper(db);
  }

  async seedFromLobbies(): Promise<number[]> {
    const livePlayerIds: number[] = [];
    try {
      console.log('Fetching active profiles from aoe10x.com active lobbies...');
      const res1 = await fetch('https://www.aoe10x.com/api/lobbies', {
        headers: { 'User-Agent': 'Mozilla/5.0 (AoE2 10x Elo Ranker)' }
      });
      if (res1.ok) {
        const data = await res1.json() as any;
        if (data.lobbies && Array.isArray(data.lobbies)) {
          for (const lobby of data.lobbies) {
            if (lobby.players && Array.isArray(lobby.players)) {
              for (const p of lobby.players) {
                if (p.profileId) livePlayerIds.push(p.profileId);
              }
            }
          }
        }
      }
      
      console.log('Fetching active profiles from aoe10x.com live matches...');
      const res2 = await fetch('https://www.aoe10x.com/api/live', {
        headers: { 'User-Agent': 'Mozilla/5.0 (AoE2 10x Elo Ranker)' }
      });
      if (res2.ok) {
        const data = await res2.json() as any;
        if (data.live && Array.isArray(data.live)) {
          for (const game of data.live) {
            if (game.players && Array.isArray(game.players)) {
              for (const p of game.players) {
                if (p.profileId) livePlayerIds.push(p.profileId);
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to fetch live profiles:', err.message);
    }

    const uniqueLive = [...new Set(livePlayerIds)];
    console.log(`Adding ${uniqueLive.length} seed profile IDs to queue.`);
    if (uniqueLive.length > 0) {
      this.db.addToCrawlQueue(uniqueLive);
    }
    return uniqueLive;
  }

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

    const half = Math.floor(limit / 2);
    const seeds = [...new Set([...topN(counts3d, half), ...topN(counts30d, limit - half)])];
    console.log(`Seeding ${seeds.length} active players (deduped) to queue.`);
    if (seeds.length > 0) {
      this.db.addToCrawlQueue(seeds);
    }
    return seeds;
  }

  async seedOldestCrawledPlayers(limit: number = 20): Promise<void> {
    const profiles = this.db.getAllProfiles();
    const candidates = profiles.map(p => {
      const manifest = this.db.getPlayerManifest(p.profile_id);
      return {
        profileId: p.profile_id,
        lastCrawledAt: manifest?.insights?.last_crawled_at || 0
      };
    });

    candidates.sort((a, b) => a.lastCrawledAt - b.lastCrawledAt);

    const seeds = candidates.slice(0, limit).map(c => c.profileId);
    console.log(`Seeding ${seeds.length} oldest/never insights-crawled players to queue.`);
    if (seeds.length > 0) {
      this.db.addToCrawlQueue(seeds);
    }
  }

  async runCrawl(limitCount: number): Promise<void> {
    console.log('Starting Insights recent matches crawl session...');

    // Seed the crawl queue
    const livePlayerIds = new Set(await this.seedFromLobbies());
    await this.seedFromActivePlayers(limitCount);
    await this.seedOldestCrawledPlayers(20);

    const queueLength = this.db.getCrawlQueueLength();
    if (queueLength === 0) {
      console.warn('Queue is empty. Nothing to crawl.');
      return;
    }

    let crawledThisSession = 0;
    let totalNewMatchesAdded = 0;

    const eligibleProfileIds: number[] = [];
    const nowSecs = Math.floor(Date.now() / 1000);

    while (this.db.getCrawlQueueLength() > 0 && eligibleProfileIds.length < limitCount) {
      const profileId = this.db.popFromCrawlQueue();
      if (!profileId) break;

      const isLive = livePlayerIds.has(profileId);
      const cooldownSec = isLive ? 0 : 8 * 60 * 60; // 8 hours cooldown

      const manifest = this.db.getPlayerManifest(profileId);
      const lastCrawledSec = manifest?.insights?.last_crawled_at || 0;

      if (nowSecs - lastCrawledSec < cooldownSec) {
        continue;
      }

      eligibleProfileIds.push(profileId);
    }

    if (eligibleProfileIds.length === 0) {
      console.log('All players in queue are within cooldown. Crawl finished.');
      return;
    }

    console.log(`Found ${eligibleProfileIds.length} eligible players to crawl via AoE2Insights Scraper batch.`);
    
    try {
      // Scrape page 1 (recent matches) for all eligible players
      const result = await this.scraper.scrapePlayersBatch(eligibleProfileIds, 1, 1);
      crawledThisSession = result.crawled;
      totalNewMatchesAdded = result.added;
    } catch (err: any) {
      console.error('Error during Insights crawl session:', err.message);
    }

    await this.db.save();

    console.log(`\n========================================`);
    console.log(`Insights Crawl session finished!`);
    console.log(`- Crawled: ${crawledThisSession} players`);
    console.log(`- New 10x matches added: ${totalNewMatchesAdded}`);
    console.log(`- Total matches in DB: ${this.db.getMatchesCount()}`);
    console.log(`========================================`);
  }
}
