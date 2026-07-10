import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as fsSync from 'node:fs';
import type { Match, PlayerProfile, PlayerCrawlManifest } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

/**
 * Generator that yields parsed JSON objects from a line-by-line JSON array file.
 * The file is assumed to start with '[' and end with ']', with each item on its own line ending with an optional comma.
 */
export async function* readJsonArrayLines<T>(filePath: string): AsyncGenerator<T> {
  if (!fsSync.existsSync(filePath)) return;

  const fileStream = fsSync.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    // Skip array opening/closing brackets
    if (trimmed === '[' || trimmed === ']') {
      continue;
    }
    if (!trimmed) continue;

    // Strip trailing comma if present
    const cleanLine = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    if (cleanLine === 'null') continue;
    
    try {
      yield JSON.parse(cleanLine) as T;
    } catch (e) {
      console.error(`Failed to parse JSON line in ${filePath}: "${cleanLine}"`, e);
    }
  }
}

export async function saveJsonArrayLines<T>(filePath: string, items: T[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  const fd = await fs.open(tempPath, 'w');
  
  await fd.write('[\n');
  const len = items.length;
  for (let i = 0; i < len; i++) {
    await fd.write(`  ${JSON.stringify(items[i])},\n`);
  }
  await fd.write('  null\n');
  await fd.write(']\n');
  await fd.close();

  await fs.rename(tempPath, filePath);
}

export class JsonDatabase {
  private dataDir: string;
  private matchesPath: string;
  private profilesPath: string;
  private crawlStatePath: string;
  private crawlManifestPath: string;

  private matches!: Map<number, Match>;
  private profiles!: Map<number, PlayerProfile>;
  private matchFingerprints!: Map<string, number>;
  private crawledProfiles!: Map<number, number>;
  private crawlQueue!: number[];
  private crawlManifest!: Map<number, PlayerCrawlManifest>;

  private isLoaded: boolean = false;

  constructor(dataDir: string = path.join(process.cwd(), 'docs', 'data')) {
    this.dataDir = dataDir;
    this.matchesPath = path.join(dataDir, 'matches.json');
    this.profilesPath = path.join(dataDir, 'profiles.json');
    this.crawlStatePath = path.join(dataDir, 'crawl_state.json');
    this.crawlManifestPath = path.join(dataDir, 'crawl_manifest.json');
  }

  async load(): Promise<void> {
    if (this.isLoaded) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch {
      // Directory exists or couldn't be created
    }

    // Load matches
    this.matches = new Map<number, Match>();
    for await (const match of readJsonArrayLines<Match>(this.matchesPath)) {
      this.matches.set(match.id, match);
    }

    // Load profiles
    this.profiles = new Map<number, PlayerProfile>();
    for await (const profile of readJsonArrayLines<PlayerProfile>(this.profilesPath)) {
      this.profiles.set(profile.profile_id, profile);
    }

    // Load crawl state
    try {
      const stateContent = await fs.readFile(this.crawlStatePath, 'utf-8');
      const state = JSON.parse(stateContent);
      this.matchFingerprints = new Map<string, number>(Object.entries(state.match_fingerprints || {}));
      
      this.crawledProfiles = new Map<number, number>();
      if (state.crawled_profiles) {
        for (const [idStr, time] of Object.entries(state.crawled_profiles)) {
          this.crawledProfiles.set(Number(idStr), Number(time));
        }
      }
      this.crawlQueue = state.crawl_queue || [];
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.matchFingerprints = new Map<string, number>();
        this.crawledProfiles = new Map<number, number>();
        this.crawlQueue = [];
      } else {
        throw new Error(`Failed to read crawler state: ${error.message}`);
      }
    }

    // Load crawl manifest
    this.crawlManifest = new Map<number, PlayerCrawlManifest>();
    try {
      const manifestContent = await fs.readFile(this.crawlManifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      for (const [idStr, data] of Object.entries(manifest)) {
        this.crawlManifest.set(Number(idStr), data as PlayerCrawlManifest);
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Failed to read crawl manifest: ${error.message}`);
      }
    }

    this.backfillMatchSources();
    this.backfillMatchFingerprints();
    this.migrateCrawlManifest();
    this.isLoaded = true;
  }

  pruneUnusedProfiles(): void {
    const referencedIds = new Set<number>();

    for (const match of this.matches.values()) {
      if (match.players) {
        for (const p of match.players) {
          referencedIds.add(p.profile_id);
        }
      }
      if (match.creator_profile_id) {
        referencedIds.add(match.creator_profile_id);
      }
    }

    for (const id of this.crawlQueue) {
      referencedIds.add(id);
    }

    for (const id of this.crawledProfiles.keys()) {
      referencedIds.add(id);
    }

    for (const id of this.profiles.keys()) {
      if (!referencedIds.has(id)) {
        this.profiles.delete(id);
      }
    }
  }

  async save(): Promise<void> {
    this.pruneUnusedProfiles();

    // Sort matches chronologically
    const sortedMatches = Array.from(this.matches.values()).sort((a, b) => {
      return (a.startgametime || 0) - (b.startgametime || 0);
    });

    // Sort profiles by ID for diff cleanliness and strip out any legacy properties (xp/level)
    const sortedProfiles = Array.from(this.profiles.values()).map(p => {
      const clean: PlayerProfile = {
        profile_id: p.profile_id,
        alias: p.alias
      };
      if (p.country) {
        clean.country = p.country;
      }
      return clean;
    }).sort((a, b) => {
      return a.profile_id - b.profile_id;
    });

    await saveJsonArrayLines(this.matchesPath, sortedMatches);
    await saveJsonArrayLines(this.profilesPath, sortedProfiles);

    // Sort fingerprints, crawled profiles, and the queue to keep files deterministic
    const sortedFingerprints = Object.fromEntries(
      Array.from(this.matchFingerprints.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );

    const sortedCrawled = Object.fromEntries(
      Array.from(this.crawledProfiles.entries()).sort((a, b) => a[0] - b[0])
    );

    const sortedQueue = [...this.crawlQueue].sort((a, b) => a - b);

    const crawlState = {
      match_fingerprints: sortedFingerprints,
      crawled_profiles: sortedCrawled,
      crawl_queue: sortedQueue
    };

    const tempStatePath = `${this.crawlStatePath}.tmp`;
    await fs.writeFile(tempStatePath, JSON.stringify(crawlState, null, 2), 'utf-8');
    await fs.rename(tempStatePath, this.crawlStatePath);

    // Sort manifest entries by profile ID ascending
    const sortedManifest = Object.fromEntries(
      Array.from(this.crawlManifest.entries()).sort((a, b) => a[0] - b[0])
    );
    const tempManifestPath = `${this.crawlManifestPath}.tmp`;
    await fs.writeFile(tempManifestPath, JSON.stringify(sortedManifest, null, 2), 'utf-8');
    await fs.rename(tempManifestPath, this.crawlManifestPath);
  }

  // Matches
  hasMatch(id: number): boolean {
    return this.matches.has(id);
  }

  hasMatchFingerprint(fingerprint: string): boolean {
    return this.matchFingerprints.has(fingerprint);
  }

  findMatchIdByFingerprint(fingerprint: string): number | undefined {
    return this.matchFingerprints.get(fingerprint);
  }

  addMatch(match: Match): void {
    const existing = this.matches.get(match.id);
    if (existing) {
      let updated = false;

      // 1. Merge map name if generic "my map"
      if ((existing.mapname === 'my map' || !existing.mapname) && match.mapname && match.mapname !== 'my map') {
        existing.mapname = match.mapname;
        updated = true;
      }

      // 2. Merge player civilization IDs (civ_id)
      if (existing.players && match.players) {
        for (const ep of existing.players) {
          const mp = match.players.find(p => p.profile_id === ep.profile_id);
          if (mp && (!ep.civ_id || ep.civ_id === 0) && mp.civ_id && mp.civ_id > 0) {
            ep.civ_id = mp.civ_id;
            updated = true;
          }
        }
      }

      // 3. Update source if merged
      if (updated && existing.source !== match.source && existing.source !== 'merged') {
        existing.source = 'merged';
      }
      return;
    }

    this.matches.set(match.id, match);
    const fingerprint = buildMatchFingerprint(match);
    if (!this.hasMatchFingerprint(fingerprint)) {
      this.matchFingerprints.set(fingerprint, match.id);
    }
  }

  getMatches(): Match[] {
    return Array.from(this.matches.values());
  }

  getMatchesCount(): number {
    return this.matches.size;
  }

  private backfillMatchFingerprints(): void {
    for (const match of this.matches.values()) {
      const fingerprint = buildMatchFingerprint(match);
      if (!this.matchFingerprints.has(fingerprint)) {
        this.matchFingerprints.set(fingerprint, match.id);
      }
    }
  }

  private backfillMatchSources(): void {
    for (const match of this.matches.values()) {
      if (match.source) {
        continue;
      }
      if (match.creator_profile_id !== undefined || match.gamemod_id !== undefined) {
        match.source = 'relic_api';
      } else {
        match.source = 'aoe2insights_scrape';
      }
    }
  }

  // Profiles
  addProfile(profile: PlayerProfile): void {
    const existing = this.profiles.get(profile.profile_id);
    
    let normalizedCountry = profile.country;
    if (normalizedCountry) {
      const trimmed = normalizedCountry.trim();
      if (trimmed.length !== 2 || trimmed.toLowerCase() === 'un' || trimmed.toLowerCase() === 'unknown') {
        normalizedCountry = undefined;
      }
    }

    if (existing) {
      const merged = { ...existing };
      if (profile.alias && !profile.alias.startsWith('Player_')) {
        merged.alias = profile.alias;
      }
      if (normalizedCountry !== undefined) {
        merged.country = normalizedCountry;
      }
      this.profiles.set(profile.profile_id, merged);
    } else {
      const newProfile = { ...profile };
      if (normalizedCountry !== undefined) {
        newProfile.country = normalizedCountry;
      } else {
        delete newProfile.country;
      }
      this.profiles.set(profile.profile_id, newProfile);
    }
  }

  getProfile(profile_id: number): PlayerProfile | undefined {
    return this.profiles.get(profile_id);
  }

  getAllProfiles(): PlayerProfile[] {
    return Array.from(this.profiles.values());
  }

  getPlayerManifest(profile_id: number): PlayerCrawlManifest | undefined {
    return this.crawlManifest.get(profile_id);
  }

  getProfilesCount(): number {
    return this.profiles.size;
  }

  // Crawl Queue
  addToCrawlQueue(profile_ids: number[]): void {
    for (const id of profile_ids) {
      if (!this.crawlQueue.includes(id)) {
        this.crawlQueue.push(id);
      }
    }
  }

  popFromCrawlQueue(): number | undefined {
    return this.crawlQueue.shift();
  }

  getCrawlQueueLength(): number {
    return this.crawlQueue.length;
  }

  // Crawled Profiles
  markAsCrawled(profile_id: number): void {
    this.crawledProfiles.set(profile_id, Date.now());
    this.crawlQueue = this.crawlQueue.filter(id => id !== profile_id);
  }

  isCrawled(profile_id: number, maxAgeMs?: number): boolean {
    const lastCrawled = this.crawledProfiles.get(profile_id);
    if (!lastCrawled) return false;
    if (maxAgeMs !== undefined) {
      return (Date.now() - lastCrawled) < maxAgeMs;
    }
    return true;
  }

  getCrawledCount(): number {
    return this.crawledProfiles.size;
  }



  updatePlayerManifest(profileId: number, source: 'insights' | 'relic', data: any): void {
    const existing = this.crawlManifest.get(profileId) || {};
    existing[source] = {
      ...existing[source],
      ...data
    };
    this.crawlManifest.set(profileId, existing);
  }

  migrateCrawlManifest(): void {
    for (const [profileId, data] of this.crawlManifest.entries()) {
      if (data.insights && ('hit_depth_limit' in (data.insights as any) || !('newest_match_id' in data.insights))) {
        const oldInsights = data.insights as any;
        const playerMatches = Array.from(this.matches.values())
          .filter(m => m.players.some(p => p.profile_id === profileId));
        
        let newestId = 0;
        let oldestId = 0;
        if (playerMatches.length > 0) {
          const ids = playerMatches.map(m => m.id);
          newestId = Math.max(...ids);
          oldestId = Math.min(...ids);
        }

        data.insights = {
          last_crawled_at: oldInsights.last_crawled_at,
          newest_match_id: newestId,
          oldest_match_id: oldestId,
          has_reached_start: oldInsights.hit_depth_limit === false
        };
      }
    }
  }
}
