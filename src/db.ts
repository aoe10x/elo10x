import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSchema, Match, PlayerProfile } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

export class JsonDatabase {
  private filePath: string;
  private data!: DatabaseSchema;
  private isLoaded: boolean = false;

  constructor(filePath: string = path.join(process.cwd(), 'data', 'db.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    if (this.isLoaded) return;

    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory exists or couldn't be created
    }

    try {
      const fileContent = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(fileContent);
      // Ensure all fields are initialized in case of legacy formats
      this.data.matches = this.data.matches || {};
      this.data.match_fingerprints = this.data.match_fingerprints || {};
      this.data.profiles = this.data.profiles || {};
      this.data.crawled_profiles = this.data.crawled_profiles || {};
      this.data.crawl_queue = this.data.crawl_queue || [];
      this.backfillMatchSources();
      this.backfillMatchFingerprints();
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.data = {
          matches: {},
          match_fingerprints: {},
          profiles: {},
          crawled_profiles: {},
          crawl_queue: []
        };
        await this.save();
      } else {
        throw new Error(`Failed to read database: ${error.message}`);
      }
    }

    this.isLoaded = true;
  }

  pruneUnusedProfiles(): void {
    const referencedIds = new Set<number>();

    // 1. Collect profile IDs from matches
    for (const match of Object.values(this.data.matches)) {
      if (match.players) {
        for (const p of match.players) {
          referencedIds.add(p.profile_id);
        }
      }
      if (match.creator_profile_id) {
        referencedIds.add(match.creator_profile_id);
      }
    }

    // 2. Collect profile IDs from crawl queue
    for (const id of this.data.crawl_queue) {
      referencedIds.add(id);
    }

    // 3. Collect profile IDs from crawled profiles
    for (const id of Object.keys(this.data.crawled_profiles)) {
      referencedIds.add(Number(id));
    }

    // Purge unreferenced profiles
    const prunedProfiles: Record<number, PlayerProfile> = {};
    for (const [idStr, profile] of Object.entries(this.data.profiles)) {
      const id = Number(idStr);
      if (referencedIds.has(id)) {
        prunedProfiles[id] = profile;
      }
    }

    this.data.profiles = prunedProfiles;
  }

  async save(): Promise<void> {
    this.pruneUnusedProfiles();
    const tempPath = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      await fs.rename(tempPath, this.filePath);
    } catch (error: any) {
      throw new Error(`Failed to save database atomically: ${error.message}`);
    }
  }

  // Matches
  hasMatch(id: number): boolean {
    return !!this.data.matches[id];
  }

  hasMatchFingerprint(fingerprint: string): boolean {
    return this.data.match_fingerprints[fingerprint] !== undefined;
  }

  findMatchIdByFingerprint(fingerprint: string): number | undefined {
    return this.data.match_fingerprints[fingerprint];
  }

  addMatch(match: Match): void {
    this.data.matches[match.id] = match;
    const fingerprint = buildMatchFingerprint(match);
    if (!this.hasMatchFingerprint(fingerprint)) {
      this.data.match_fingerprints[fingerprint] = match.id;
    }
  }

  getMatches(): Match[] {
    return Object.values(this.data.matches);
  }

  getMatchesCount(): number {
    return Object.keys(this.data.matches).length;
  }

  private backfillMatchFingerprints(): void {
    for (const match of Object.values(this.data.matches)) {
      const fingerprint = buildMatchFingerprint(match);
      if (this.data.match_fingerprints[fingerprint] === undefined) {
        this.data.match_fingerprints[fingerprint] = match.id;
      }
    }
  }

  private backfillMatchSources(): void {
    for (const match of Object.values(this.data.matches)) {
      if (match.source) {
        continue;
      }

      // Relic API records usually include creator/gamemod metadata; local imports usually do not.
      if (match.creator_profile_id !== undefined || match.gamemod_id !== undefined) {
        match.source = 'relic_api';
      } else {
        match.source = 'local_replay_mgz';
      }
    }
  }

  // Profiles
  addProfile(profile: PlayerProfile): void {
    // Merge updates or create new profile
    const existing = this.data.profiles[profile.profile_id];
    if (existing) {
      this.data.profiles[profile.profile_id] = {
        ...existing,
        ...profile
      };
    } else {
      this.data.profiles[profile.profile_id] = profile;
    }
  }

  getProfile(profile_id: number): PlayerProfile | undefined {
    return this.data.profiles[profile_id];
  }

  getProfilesCount(): number {
    return Object.keys(this.data.profiles).length;
  }

  // Crawl Queue
  addToCrawlQueue(profile_ids: number[]): void {
    for (const id of profile_ids) {
      if (!this.isCrawled(id) && !this.data.crawl_queue.includes(id)) {
        this.data.crawl_queue.push(id);
      }
    }
  }

  popFromCrawlQueue(): number | undefined {
    return this.data.crawl_queue.shift();
  }

  getCrawlQueueLength(): number {
    return this.data.crawl_queue.length;
  }

  // Crawled Profiles
  markAsCrawled(profile_id: number): void {
    this.data.crawled_profiles[profile_id] = Date.now();
    // Remove from queue if present
    this.data.crawl_queue = this.data.crawl_queue.filter(id => id !== profile_id);
  }

  isCrawled(profile_id: number): boolean {
    return !!this.data.crawled_profiles[profile_id];
  }

  getCrawledCount(): number {
    return Object.keys(this.data.crawled_profiles).length;
  }
}
