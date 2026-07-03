import type { EloRanking, Match } from './types.ts';

export interface EloConfig {
  defaultRating: number;
  kFactor: number;
  minGamesForLeaderboard: number;
}

const DEFAULT_CONFIG: EloConfig = {
  defaultRating: 1000,
  kFactor: 32,
  minGamesForLeaderboard: 5
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

  /**
   * Calculates ELO ratings over a set of matches.
   * Matches should be sorted chronologically before passing to this function.
   */
  calculate(matches: Match[]): Map<number, EloRanking> {
    const ratingsMap = new Map<number, EloRanking>();

    // 1. Sort matches chronologically to ensure ELO is updated in the correct order
    const sortedMatches = [...matches].sort((a, b) => a.startgametime - b.startgametime);

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
            lastPlayedAt: 0
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
      for (const p of team1) initPlayer(p.profile_id, p.alias);
      for (const p of team2) initPlayer(p.profile_id, p.alias);

      // Compute average rating of team 1
      const team1Avg = team1.reduce((sum, p) => sum + ratingsMap.get(p.profile_id)!.rating, 0) / team1.length;
      // Compute average rating of team 2
      const team2Avg = team2.reduce((sum, p) => sum + ratingsMap.get(p.profile_id)!.rating, 0) / team2.length;

      // Compute expected scores
      const expected1 = 1 / (1 + Math.pow(10, (team2Avg - team1Avg) / 400));
      const expected2 = 1 - expected1;

      // Calculate ELO updates
      const delta1 = this.config.kFactor * (team1Score - expected1);
      const delta2 = this.config.kFactor * (team2Score - expected2);

      // Apply updates to Team 1 players
      for (const p of team1) {
        const ratingObj = ratingsMap.get(p.profile_id)!;
        ratingObj.rating = Math.round(ratingObj.rating + delta1);
        if (team1Score === 1) {
          ratingObj.wins++;
        } else {
          ratingObj.losses++;
        }
        ratingObj.gamesCount++;
        ratingObj.winRate = Math.round((ratingObj.wins / ratingObj.gamesCount) * 100);
        ratingObj.lastPlayedAt = match.startgametime;
      }

      // Apply updates to Team 2 players
      for (const p of team2) {
        const ratingObj = ratingsMap.get(p.profile_id)!;
        ratingObj.rating = Math.round(ratingObj.rating + delta2);
        if (team2Score === 1) {
          ratingObj.wins++;
        } else {
          ratingObj.losses++;
        }
        ratingObj.gamesCount++;
        ratingObj.winRate = Math.round((ratingObj.wins / ratingObj.gamesCount) * 100);
        ratingObj.lastPlayedAt = match.startgametime;
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
