export interface MatchPlayer {
  profile_id: number;
  teamid: number;
  resulttype: number; // 1 = Win, 0/2 = Loss
  civ_id: number;
  alias: string;
}

export type MatchSource =
  | 'relic_api'
  | 'aoe2insights_scrape'
  | 'merged'
  | 'unknown';

export interface Match {
  id: number;
  source?: MatchSource;
  creator_profile_id?: number;
  mapname: string;
  maxplayers: number;
  matchtype_id: number;
  description: string; // Lobby title
  startgametime: number; // Unix timestamp (seconds)
  completiontime: number; // Unix timestamp (seconds)
  players: MatchPlayer[];
  gamemod_id?: number;
}

export interface PlayerProfile {
  profile_id: number;
  alias: string;
  country?: string;
}

export interface RecentMatch {
  matchId: number;
  description: string;
  mapname: string;
  timestamp: number;
  outcome: 'win' | 'loss';
  preRating: number;
  postRating: number;
  eloChange: number;
  opponentAvgElo: number;
  civ?: string;
  teamAvgElo?: number;
  teammates?: string[];
  opponents?: string[];
}

export interface EloRanking {
  profile_id: number;
  alias: string;
  rating: number;
  wins: number;
  losses: number;
  gamesCount: number;
  winRate: number;
  lastPlayedAt: number;
  country?: string;
  ratingHistory?: number[];
  recentMatches?: RecentMatch[];
  merged_ids?: number[];
}


export interface Lobby {
  matchId: number;
  steamLobbyId: string;
  region: string;
  name: string;
  map: string;
  speed: string;
  popCap: number;
  turbo: boolean;
  passwordProtected: boolean;
  slotsTaken: number;
  slotsTotal: number;
  status: string;
  host: {
    profileId: number;
    name: string;
    elo: number | null;
    country: string;
    team: number;
    ready: boolean;
  };
  players: Array<{
    profileId: number;
    name: string;
    elo: number | null;
    country: string;
    team: number;
    ready: boolean;
  }>;
  observers: {
    count: number;
    max: number;
  };
  avgElo: number | null;
  joinUrl: string;
}


// types for aoe2rec instead of mgz thing.

/** Data parsed from a single .aoe2record file. */
export interface ParsedRecording {
  fileName: string;
  player1: string;
  player2: string;
  profileId1: number;
  profileId2: number;
  civ1: string;
  civ2: string;
  civId1: number;
  civId2: number;
  map: string;
  mapId: number;
  length: string;
  date: string;
  winner: 1 | 2 | null;
  guid: string;
  restored: boolean;
}

export interface UploadRecsPayload {
  gamesUrls: string[];
  restoredDataUrls: (string | null)[];
  matchId: string;
  uploader: string;
}

export interface InsightsCrawlManifest {
  last_crawled_at: number;
  newest_match_id: number;
  oldest_match_id: number;
  has_reached_start: boolean;
}

export interface RelicCrawlManifest {
  last_crawled_at: number;
  newest_match_id: number;
}

export interface PlayerCrawlManifest {
  insights?: InsightsCrawlManifest;
  relic?: RelicCrawlManifest;
}
