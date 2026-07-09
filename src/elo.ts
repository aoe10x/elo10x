import type { EloRanking, Match } from './types.ts';

export interface EloConfig {
  defaultRating: number;
  kFactor: number;
  minGamesForLeaderboard: number;
  enablePlacementKDecay: boolean;
  placementStartingK: number;
  placementGames: number;
}

const DEFAULT_CONFIG: EloConfig = {
  defaultRating: 1000,
  kFactor: 32,
  minGamesForLeaderboard: 15,
  enablePlacementKDecay: true,
  placementStartingK: 100,
  placementGames: 21
};

const CIV_NAME_MAP: Record<number, string> = {
  1: "Britons", 2: "Franks", 3: "Goths", 4: "Teutons", 5: "Japanese", 6: "Chinese", 
  7: "Byzantines", 8: "Persians", 9: "Saracens", 10: "Turks", 11: "Vikings", 12: "Mongols", 
  13: "Celts", 14: "Spanish", 15: "Aztecs", 16: "Mayans", 17: "Huns", 18: "Koreans", 
  19: "Italians", 20: "Hindustanis", 21: "Incas", 22: "Magyars", 23: "Slavs", 
  24: "Portuguese", 25: "Ethiopians", 26: "Malians", 27: "Berbers", 28: "Khmer", 29: "Malay", 
  30: "Burmese", 31: "Vietnamese", 32: "Bulgarians", 33: "Tatars", 34: "Cumans", 35: "Lithuanians", 
  36: "Burgundians", 37: "Sicilians", 38: "Poles", 39: "Bohemians", 40: "Dravidians", 
  41: "Bengalis", 42: "Gurjaras", 43: "Romans", 44: "Armenians", 45: "Georgians",
  46: "Achaemenids", 47: "Athenians", 48: "Spartans", 49: "Shu", 50: "Wu", 51: "Wei",
  52: "Jurchens", 53: "Khitans", 54: "Macedonians", 55: "Thracians", 56: "Puru",
  57: "Muisca", 58: "Mapuche", 59: "Tupi"
};

function isWin(resulttype: number): boolean {
  return resulttype === 1;
}

function isLoss(resulttype: number): boolean {
  return resulttype === 0 || resulttype === 2;
}

export class EloCalculator {
  private config: EloConfig;

  constructor(config: Partial<EloConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getPlayerKFactor(gamesCount: number): number {
    if (!this.config.enablePlacementKDecay) {
      return this.config.kFactor;
    }
    const n = gamesCount + 1;
    if (n <= this.config.placementGames) {
      return this.config.placementStartingK - n * (this.config.placementStartingK - this.config.kFactor) / this.config.placementGames;
    }
    return this.config.kFactor;
  }

  /**
   * Calculates ELO ratings over a set of matches.
   * Matches should be sorted chronologically before passing to this function.
   */
  calculate(matches: Match[]): Map<number, EloRanking> {
    const ratingsMap = new Map<number, EloRanking>();

    // 1. Sort matches chronologically to ensure ELO is updated in the correct order
    const sortedMatches = [...matches].sort((a, b) => a.startgametime - b.startgametime);

    // 2. Pre-pass: Resolve final aliases and build profile redirection mapping
    const profileToFinalAlias = new Map<number, string>();
    const profileGameCounts = new Map<number, number>();
    const profileLastGameTime = new Map<number, number>();

    for (const match of sortedMatches) {
      if (Array.isArray(match.players)) {
        for (const p of match.players) {
          profileToFinalAlias.set(p.profile_id, p.alias);
          profileGameCounts.set(p.profile_id, (profileGameCounts.get(p.profile_id) || 0) + 1);
          const matchTime = match.startgametime || 0;
          const currentMax = profileLastGameTime.get(p.profile_id) || 0;
          if (matchTime > currentMax) {
            profileLastGameTime.set(p.profile_id, matchTime);
          }
        }
      }
    }

    const aliasToProfiles = new Map<string, number[]>();
    for (const [profileId, alias] of profileToFinalAlias.entries()) {
      if (!aliasToProfiles.has(alias)) {
        aliasToProfiles.set(alias, []);
      }
      aliasToProfiles.get(alias)!.push(profileId);
    }

    const profileRedirects = new Map<number, number>();
    for (const [alias, ids] of aliasToProfiles.entries()) {
      if (ids.length > 1) {
        // Sort ids by last game timestamp descending to choose the most recently played profile as canonical
        ids.sort((a, b) => (profileLastGameTime.get(b) || 0) - (profileLastGameTime.get(a) || 0));
        const canonicalId = ids[0];
        for (const id of ids) {
          profileRedirects.set(id, canonicalId);
        }
      }
    }

    const getCanonicalProfileId = (id: number): number => {
      return profileRedirects.get(id) || id;
    };

    for (const match of sortedMatches) {
      // Strict 4v4 policy: only process matches with exactly 8 tracked players.
      if (!Array.isArray(match.players) || match.players.length !== 8) {
        continue;
      }

      const winners = match.players.filter(p => isWin(p.resulttype));
      const losers = match.players.filter(p => isLoss(p.resulttype));
      // Require exactly 4 winners and 4 losers; skip unknown/ambiguous outcomes.
      if (winners.length !== 4 || losers.length !== 4) {
        continue;
      }

      // Group players by team ID
      let teamPlayers = new Map<number, typeof match.players>();
      for (const p of match.players) {
        if (!teamPlayers.has(p.teamid)) {
          teamPlayers.set(p.teamid, []);
        }
        teamPlayers.get(p.teamid)!.push(p);
      }

      // We only compute ELO for games with exactly 2 teams
      if (teamPlayers.size !== 2) {
        continue;
      }

      const teamIds = Array.from(teamPlayers.keys());
      const team1Id = teamIds[0];
      const team2Id = teamIds[1];

      const team1 = teamPlayers.get(team1Id)!;
      const team2 = teamPlayers.get(team2Id)!;

      // Strict 4v4 team integrity: exactly 4 players per team
      if (team1.length !== 4 || team2.length !== 4) {
        continue;
      }

      // Determine outcome: verify that team results are consistent
      // resulttype: 1 = Win, 0/2 = Loss
      const team1WinCount = team1.filter(p => isWin(p.resulttype)).length;
      const team1LossCount = team1.filter(p => isLoss(p.resulttype)).length;
      const team2WinCount = team2.filter(p => isWin(p.resulttype)).length;
      const team2LossCount = team2.filter(p => isLoss(p.resulttype)).length;

      let team1Score = 0.5; // Draw default, though draws are rare in AoE2
      let team2Score = 0.5;
      let validOutcome = false;

      if (team1WinCount === team1.length && team2LossCount === team2.length) {
        team1Score = 1;
        team2Score = 0;
        validOutcome = true;
      } else if (team1LossCount === team1.length && team2WinCount === team2.length) {
        team1Score = 0;
        team2Score = 1;
        validOutcome = true;
      }

      // Skip match if outcomes are inconsistent (e.g. draw or bugged report)
      if (!validOutcome) {
        continue;
      }

      // Map team1 and team2 players to their canonical profile IDs and deduplicate
      const canonicalTeam1Map = new Map<number, typeof team1[0]>();
      for (const p of team1) {
        const canonicalId = getCanonicalProfileId(p.profile_id);
        if (!canonicalTeam1Map.has(canonicalId)) {
          canonicalTeam1Map.set(canonicalId, { ...p, profile_id: canonicalId });
        }
      }
      const resolvedTeam1 = Array.from(canonicalTeam1Map.values());

      const canonicalTeam2Map = new Map<number, typeof team2[0]>();
      for (const p of team2) {
        const canonicalId = getCanonicalProfileId(p.profile_id);
        if (!canonicalTeam2Map.has(canonicalId)) {
          canonicalTeam2Map.set(canonicalId, { ...p, profile_id: canonicalId });
        }
      }
      const resolvedTeam2 = Array.from(canonicalTeam2Map.values());

      if (resolvedTeam1.length === 0 || resolvedTeam2.length === 0) {
        continue;
      }

      // Initialize ELO profiles for new players
      const initPlayer = (profileId: number, alias: string): EloRanking => {
        if (!ratingsMap.has(profileId)) {
          ratingsMap.set(profileId, {
            profile_id: profileId,
            alias: alias,
            rating: this.config.defaultRating,
            wins: 0,
            losses: 0,
            gamesCount: 0,
            winRate: 0,
            lastPlayedAt: 0,
            ratingHistory: [this.config.defaultRating]
          });
        } else {
          // Update alias if we see a new/different one
          const current = ratingsMap.get(profileId)!;
          if (alias && alias !== current.alias) {
            current.alias = alias;
          }
        }
        return ratingsMap.get(profileId)!;
      };

      // Ensure all players are initialized in the map
      for (const p of resolvedTeam1) initPlayer(p.profile_id, p.alias);
      for (const p of resolvedTeam2) initPlayer(p.profile_id, p.alias);

      // Compute average rating of team 1
      const team1Avg = resolvedTeam1.reduce((sum, p) => sum + ratingsMap.get(p.profile_id)!.rating, 0) / resolvedTeam1.length;
      // Compute average rating of team 2
      const team2Avg = resolvedTeam2.reduce((sum, p) => sum + ratingsMap.get(p.profile_id)!.rating, 0) / resolvedTeam2.length;

      // Apply updates to Team 1 players
      for (const p of resolvedTeam1) {
        const ratingObj = ratingsMap.get(p.profile_id)!;
        const preRating = ratingObj.rating;
        // Individual Elo vs Opposing Team Average (DE Algorithm 3)
        const expected = 1 / (1 + Math.pow(10, (team2Avg - ratingObj.rating) / 400));
        const playerK = this.getPlayerKFactor(ratingObj.gamesCount);
        const delta = playerK * (team1Score - expected);
        ratingObj.rating = Math.round(ratingObj.rating + delta);
        if (team1Score === 1) {
          ratingObj.wins++;
        } else {
          ratingObj.losses++;
        }
        ratingObj.gamesCount++;
        ratingObj.winRate = Math.round((ratingObj.wins / ratingObj.gamesCount) * 100);
        ratingObj.lastPlayedAt = match.startgametime;
        if (!ratingObj.ratingHistory) {
          ratingObj.ratingHistory = [this.config.defaultRating];
        }
        ratingObj.ratingHistory.push(ratingObj.rating);

        // Record recent match details
        ratingObj.recentMatches = ratingObj.recentMatches || [];
        ratingObj.recentMatches.push({
          matchId: match.id,
          description: match.description,
          mapname: match.mapname,
          timestamp: match.startgametime,
          outcome: team1Score === 1 ? 'win' : 'loss',
          preRating,
          postRating: ratingObj.rating,
          eloChange: ratingObj.rating - preRating,
          civ: CIV_NAME_MAP[p.race_id] || 'Unknown',
          teamAvgElo: Math.round(team1Avg),
          opponentAvgElo: Math.round(team2Avg),
          teammates: resolvedTeam1.filter(o => o.profile_id !== p.profile_id).map(o => o.alias),
          opponents: resolvedTeam2.map(o => o.alias)
        });
        if (ratingObj.recentMatches.length > 20) {
          ratingObj.recentMatches.shift();
        }
      }

      // Apply updates to Team 2 players
      for (const p of resolvedTeam2) {
        const ratingObj = ratingsMap.get(p.profile_id)!;
        const preRating = ratingObj.rating;
        // Individual Elo vs Opposing Team Average (DE Algorithm 3)
        const expected = 1 / (1 + Math.pow(10, (team1Avg - ratingObj.rating) / 400));
        const playerK = this.getPlayerKFactor(ratingObj.gamesCount);
        const delta = playerK * (team2Score - expected);
        ratingObj.rating = Math.round(ratingObj.rating + delta);
        if (team2Score === 1) {
          ratingObj.wins++;
        } else {
          ratingObj.losses++;
        }
        ratingObj.gamesCount++;
        ratingObj.winRate = Math.round((ratingObj.wins / ratingObj.gamesCount) * 100);
        ratingObj.lastPlayedAt = match.startgametime;
        if (!ratingObj.ratingHistory) {
          ratingObj.ratingHistory = [this.config.defaultRating];
        }
        ratingObj.ratingHistory.push(ratingObj.rating);

        // Record recent match details
        ratingObj.recentMatches = ratingObj.recentMatches || [];
        ratingObj.recentMatches.push({
          matchId: match.id,
          description: match.description,
          mapname: match.mapname,
          timestamp: match.startgametime,
          outcome: team2Score === 1 ? 'win' : 'loss',
          preRating,
          postRating: ratingObj.rating,
          eloChange: ratingObj.rating - preRating,
          civ: CIV_NAME_MAP[p.race_id] || 'Unknown',
          teamAvgElo: Math.round(team2Avg),
          opponentAvgElo: Math.round(team1Avg),
          teammates: resolvedTeam2.filter(o => o.profile_id !== p.profile_id).map(o => o.alias),
          opponents: resolvedTeam1.map(o => o.alias)
        });
        if (ratingObj.recentMatches.length > 20) {
          ratingObj.recentMatches.shift();
        }
      }
    }

    // 3. Attach merged profile IDs to each canonical rating object
    const canonicalToMergedIds = new Map<number, Set<number>>();
    for (const [id, canonicalId] of profileRedirects.entries()) {
      if (!canonicalToMergedIds.has(canonicalId)) {
        canonicalToMergedIds.set(canonicalId, new Set<number>());
      }
      canonicalToMergedIds.get(canonicalId)!.add(id);
    }

    for (const [canonicalId, ratingObj] of ratingsMap.entries()) {
      const mergedIdsSet = canonicalToMergedIds.get(canonicalId);
      if (mergedIdsSet && mergedIdsSet.size > 1) {
        ratingObj.merged_ids = Array.from(mergedIdsSet).sort((a, b) => a - b);
      }
    }

    return ratingsMap;
  }

  /**
   * Formats the map of ratings into a sorted array of EloRankings
   */
  getLeaderboard(ratingsMap: Map<number, EloRanking>, showProvisional: boolean = false): EloRanking[] {
    const list = Array.from(ratingsMap.values());
    
    const filtered = showProvisional 
      ? list 
      : list.filter(p => p.gamesCount >= this.config.minGamesForLeaderboard);

    // Sort by rating descending, then wins descending, then profile ID ascending
    return filtered.sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.profile_id - b.profile_id;
    });
  }
}
