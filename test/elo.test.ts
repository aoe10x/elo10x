import * as assert from 'node:assert';
import { test } from 'node:test';
import { EloCalculator } from '../src/elo.ts';
import type { Match, EloRanking, PlayerProfile } from '../src/types.ts';
import { resolveMergedCountry } from '../src/profile_utils.ts';

test('EloCalculator - Strict 4v4 Match Calculation', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: '10x 4v4',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  assert.strictEqual(ratingsMap.size, 8);
  for (let i = 1; i <= 4; i++) {
    const p = ratingsMap.get(i);
    assert.ok(p);
    assert.strictEqual(p.rating, 1016);
    assert.strictEqual(p.wins, 1);
  }
  for (let i = 5; i <= 8; i++) {
    const p = ratingsMap.get(i);
    assert.ok(p);
    assert.strictEqual(p.rating, 984);
    assert.strictEqual(p.losses, 1);
  }
});

test('EloCalculator - Rejects Non-4v4 Matches', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 2,
      matchtype_id: 6,
      description: '10x 1v1',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 2, resulttype: 0, civ_id: 2, alias: 'B1' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  assert.strictEqual(ratingsMap.size, 0);
});

test('EloCalculator - Rejects Team Reconstruction Cases', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  const match: Match = {
    id: 1,
    mapname: 'arena',
    maxplayers: 8,
    matchtype_id: 8,
    description: '10x bad teams',
    startgametime: 1700000000,
    completiontime: 1700000900,
    players: [
      { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
      { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A2' },
      { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A3' },
      { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A4' },
      { profile_id: 5, teamid: 1, resulttype: 0, civ_id: 1, alias: 'B1' },
      { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B2' },
      { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B3' },
      { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B4' }
    ]
  };

  const ratingsMap = calculator.calculate([match]);
  assert.strictEqual(ratingsMap.size, 0);
});

test('EloCalculator - Accepts Legacy Loss Code 2', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  const match: Match = {
    id: 1,
    mapname: 'black forest',
    maxplayers: 8,
    matchtype_id: 8,
    description: '10x loss code 2',
    startgametime: 1700000000,
    completiontime: 1700001200,
    players: [
      { profile_id: 1, teamid: 10, resulttype: 1, civ_id: 1, alias: 'A1' },
      { profile_id: 2, teamid: 10, resulttype: 1, civ_id: 1, alias: 'A2' },
      { profile_id: 3, teamid: 10, resulttype: 1, civ_id: 1, alias: 'A3' },
      { profile_id: 4, teamid: 10, resulttype: 1, civ_id: 1, alias: 'A4' },
      { profile_id: 5, teamid: 20, resulttype: 2, civ_id: 1, alias: 'B1' },
      { profile_id: 6, teamid: 20, resulttype: 2, civ_id: 1, alias: 'B2' },
      { profile_id: 7, teamid: 20, resulttype: 2, civ_id: 1, alias: 'B3' },
      { profile_id: 8, teamid: 20, resulttype: 2, civ_id: 1, alias: 'B4' }
    ]
  };

  const ratingsMap = calculator.calculate([match]);
  assert.strictEqual(ratingsMap.size, 8);

  const playerA = ratingsMap.get(1);
  const playerB = ratingsMap.get(5);

  assert.ok(playerA);
  assert.ok(playerB);
  assert.strictEqual(playerA.rating, 1016);
  assert.strictEqual(playerB.rating, 984);
});

test('EloCalculator - Filtering and Sorting', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 2
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arena',
      maxplayers: 8,
      matchtype_id: 8,
      description: '10x 4v4',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 1, alias: 'B4' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  
  // Every player only has 1 game.
  // minGamesForLeaderboard is 2.
  // getLeaderboard without showProvisional should return empty array
  const activeLeaderboard = calculator.getLeaderboard(ratingsMap, false);
  assert.strictEqual(activeLeaderboard.length, 0);

  // getLeaderboard with showProvisional = true should return all players sorted
  const provisionalLeaderboard = calculator.getLeaderboard(ratingsMap, true);
  assert.strictEqual(provisionalLeaderboard.length, 8);
  assert.strictEqual(provisionalLeaderboard[0].rating, 1016);
  assert.strictEqual(provisionalLeaderboard[7].rating, 984);
});

test('EloCalculator - Records ratingHistory chronologically', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: '10x Match 1',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    },
    {
      id: 2,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: '10x Match 2',
      startgametime: 1700002000,
      completiontime: 1700003000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  const p1 = ratingsMap.get(1);
  assert.ok(p1);
  assert.deepStrictEqual(p1.ratingHistory, [1000, 1016, 1031]);

  const p5 = ratingsMap.get(5);
  assert.ok(p5);
  assert.deepStrictEqual(p5.ratingHistory, [1000, 984, 969]);
});

test('EloCalculator - DE Algorithm 3 (Individual Elo vs Opposing Team Average)', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  // Setup match where player ratings are already initialized to different values.
  // We can achieve this by having player 1 win a match previously to reach 1016 Elo, or we can construct a sequence of matches.
  // Match 1: Player 1 wins in a 1v1? No, 1v1 matches are rejected by the strict 4v4 policy.
  // We must construct 4v4 matches.
  // Game 1: Team 1 (Players 1-4) wins against Team 2 (Players 5-8).
  // Ratings after Game 1:
  // Players 1-4: 1016
  // Players 5-8: 984
  
  // Game 2: Team A consists of Player 1 (1016), and Players 9, 10, 11 (all starting at 1000).
  // Team B consists of Players 12, 13, 14, 15 (all starting at 1000).
  // Team A average = (1016 + 1000 + 1000 + 1000) / 4 = 1004.
  // Team B average = 1000.
  // If Team A wins:
  // Player 1 (rating 1016): expected vs Team B avg (1000) = 1 / (1 + 10^((1000-1016)/400)) = 0.52298.
  // Player 1 delta = 32 * (1 - 0.52298) = 15.26 -> rounds to 15.
  // Player 1 new rating = 1016 + 15 = 1031.
  // Player 9 (rating 1000): expected vs Team B avg (1000) = 0.5.
  // Player 9 delta = 32 * (1 - 0.5) = 16.
  // Player 9 new rating = 1000 + 16 = 1016.
  
  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 1',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    },
    {
      id: 2,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 2',
      startgametime: 1700002000,
      completiontime: 1700003000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 9, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A9' },
        { profile_id: 10, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A10' },
        { profile_id: 11, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A11' },
        { profile_id: 12, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B12' },
        { profile_id: 13, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B13' },
        { profile_id: 14, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B14' },
        { profile_id: 15, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B15' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  
  // Verify Player 1 (starting at 1016) gained +15 (reaching 1031)
  const p1 = ratingsMap.get(1);
  assert.ok(p1);
  assert.strictEqual(p1.rating, 1031);
  
  // Verify Player 9 (starting at 1000) gained +16 (reaching 1016)
  const p9 = ratingsMap.get(9);
  assert.ok(p9);
  assert.strictEqual(p9.rating, 1016);
});

test('EloCalculator - Placement matches K-factor linear decay', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: true,
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: '10x Match 1',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  const p1 = ratingsMap.get(1);
  assert.ok(p1);
  // Game 1: n = 1.
  // playerK = 100 - 1 * (100 - 32) / 21 = 96.76.
  // expected outcome = 0.5.
  // delta = 96.76 * (1 - 0.5) = 48.38 -> rounds to 48.
  // new rating = 1000 + 48 = 1048.
  assert.strictEqual(p1.rating, 1048);
  assert.strictEqual(p1.ratingHistory?.[1], 1048);
});

test('EloCalculator - Step-by-step K-factor decay over 22 games', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: true,
    minGamesForLeaderboard: 1
  });

  // 1. Direct unit verification of getPlayerKFactor formula
  const getKFactor = (gamesCount: number): number => {
    return (calculator as any).getPlayerKFactor(gamesCount);
  };

  let previousK = getKFactor(0); // game 1: gamesCount = 0
  // Verify starting K-factor for game 1 matches expectations
  assert.strictEqual(previousK, 100 - 1 * (100 - 32) / 21); // ~96.7619

  // Verify K-factor scales down step-by-step from game 1 to game 21
  for (let game = 2; game <= 21; game++) {
    const gamesCount = game - 1;
    const currentK = getKFactor(gamesCount);
    assert.ok(currentK < previousK, `K-factor for game ${game} (${currentK}) should be less than game ${game - 1} (${previousK})`);
    previousK = currentK;
  }

  // Verify that game 21 (gamesCount = 20) is exactly the base K-factor (32)
  const kGame21 = getKFactor(20);
  assert.strictEqual(kGame21, 32);

  // Verify that game 22 (gamesCount = 21) remains exactly at 32
  const kGame22 = getKFactor(21);
  assert.strictEqual(kGame22, 32);

  // 2. Integration verification with simulated matches
  const player1ProfileId = 1;
  const matches: Match[] = [];
  
  // Helper to construct a match where Player 1 wins against opponent team of 1000 avg Elo
  const createMatch = (id: number, player1Won: boolean): Match => {
    const t1Players = [
      { profile_id: player1ProfileId, teamid: 1, resulttype: player1Won ? 1 : 0, civ_id: 1, alias: 'A1' },
      { profile_id: 100 + id * 10 + 1, teamid: 1, resulttype: player1Won ? 1 : 0, civ_id: 2, alias: `Teammate1_${id}` },
      { profile_id: 100 + id * 10 + 2, teamid: 1, resulttype: player1Won ? 1 : 0, civ_id: 3, alias: `Teammate2_${id}` },
      { profile_id: 100 + id * 10 + 3, teamid: 1, resulttype: player1Won ? 1 : 0, civ_id: 4, alias: `Teammate3_${id}` }
    ];
    const t2Players = [
      { profile_id: 100 + id * 10 + 4, teamid: 2, resulttype: player1Won ? 0 : 1, civ_id: 5, alias: `Opponent1_${id}` },
      { profile_id: 100 + id * 10 + 5, teamid: 2, resulttype: player1Won ? 0 : 1, civ_id: 6, alias: `Opponent2_${id}` },
      { profile_id: 100 + id * 10 + 7, teamid: 2, resulttype: player1Won ? 0 : 1, civ_id: 8, alias: `Opponent4_${id}` },
      { profile_id: 100 + id * 10 + 6, teamid: 2, resulttype: player1Won ? 0 : 1, civ_id: 7, alias: `Opponent3_${id}` }
    ];
    return {
      id,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: `Match ${id}`,
      startgametime: 1700000000 + id * 1000,
      completiontime: 1700000000 + id * 1000 + 500,
      players: [...t1Players, ...t2Players]
    };
  };

  for (let id = 1; id <= 22; id++) {
    matches.push(createMatch(id, true));
  }

  const ratingsMap = calculator.calculate(matches);
  const player1 = ratingsMap.get(player1ProfileId);
  assert.ok(player1);
  assert.strictEqual(player1.gamesCount, 22);
  assert.ok(player1.ratingHistory);
  assert.strictEqual(player1.ratingHistory.length, 23); // 1 (default) + 22 matches

  // Verify step-by-step ELO progression
  // Let's re-calculate rating step-by-step using the same logic to verify the history matches
  let currentRating = 1000;
  for (let game = 1; game <= 22; game++) {
    const gamesCount = game - 1;
    const playerK = getKFactor(gamesCount);
    // Opponent average is always 1000 since all opponents have only played 1 match and start at 1000 ELO.
    const opponentAvg = 1000;
    const expected = 1 / (1 + Math.pow(10, (opponentAvg - currentRating) / 400));
    const delta = playerK * (1 - expected);
    currentRating = Math.round(currentRating + delta);

    assert.strictEqual(player1.ratingHistory[game], currentRating, `Rating after game ${game} should match the expected decay calculation`);
  }
});

test('EloCalculator - Automagically merges players sharing identical final alias', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false, // Turn off decay to keep calculations simple (16 ELO change per game)
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 1',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'SameName' },
        { profile_id: 11, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 12, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 13, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    },
    {
      id: 2,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 2',
      startgametime: 1700002000,
      completiontime: 1700003000,
      players: [
        // Different profile ID (2), but identical alias ('SameName').
        // This player plays 2 matches, so this profile ID has more games and should be selected as the canonical ID.
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 1, alias: 'SameName' },
        { profile_id: 14, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A5' },
        { profile_id: 15, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A6' },
        { profile_id: 16, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A7' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    },
    {
      id: 3,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 3',
      startgametime: 1700004000,
      completiontime: 1700005000,
      players: [
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 1, alias: 'SameName' },
        { profile_id: 17, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A8' },
        { profile_id: 18, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A9' },
        { profile_id: 19, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A10' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);

  // Since profile ID 2 played 2 matches and profile ID 1 played 1 match,
  // profile ID 2 should be the canonical ID, and profile ID 1 should be redirected to it.
  
  // Profile ID 1 should NOT exist in the final map because it was merged into ID 2
  assert.strictEqual(ratingsMap.has(1), false);
  
  // Profile ID 2 should exist and have exactly 3 wins, 3 games count
  const mergedPlayer = ratingsMap.get(2);
  assert.ok(mergedPlayer);
  assert.strictEqual(mergedPlayer.gamesCount, 3);
  assert.strictEqual(mergedPlayer.wins, 3);
  // Verified ratings progression with cascading opponent rating decay:
  // Match 1: 1000 -> 1016 (Opponent Avg 1000, expected 0.5, delta +16)
  // Match 2: 1016 -> 1031 (Opponent Avg 984, expected 0.546, delta +15)
  // Match 3: 1031 -> 1044 (Opponent Avg 969, expected 0.588, delta +13)
  assert.strictEqual(mergedPlayer.rating, 1044);
  assert.deepStrictEqual(mergedPlayer.ratingHistory, [1000, 1016, 1031, 1044]);
});

test('EloCalculator - selects the most recently played profile ID as canonical', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    enablePlacementKDecay: false,
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 1',
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 1, alias: 'SameName' },
        { profile_id: 11, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A2' },
        { profile_id: 12, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A3' },
        { profile_id: 13, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    },
    {
      id: 2,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 2',
      startgametime: 1700002000,
      completiontime: 1700003000,
      players: [
        { profile_id: 2, teamid: 1, resulttype: 1, civ_id: 1, alias: 'SameName' },
        { profile_id: 14, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A5' },
        { profile_id: 15, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A6' },
        { profile_id: 16, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A7' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    },
    {
      id: 3,
      mapname: 'arabia',
      maxplayers: 8,
      matchtype_id: 8,
      description: 'Match 3',
      startgametime: 1700004000,
      completiontime: 1700005000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, civ_id: 1, alias: 'SameName' },
        { profile_id: 17, teamid: 1, resulttype: 1, civ_id: 2, alias: 'A8' },
        { profile_id: 18, teamid: 1, resulttype: 1, civ_id: 3, alias: 'A9' },
        { profile_id: 19, teamid: 1, resulttype: 1, civ_id: 4, alias: 'A10' },
        { profile_id: 5, teamid: 2, resulttype: 0, civ_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, civ_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, civ_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, civ_id: 8, alias: 'B4' }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);

  // Profile ID 2 should NOT exist in the final map
  assert.strictEqual(ratingsMap.has(2), false);

  // Profile ID 1 should exist
  const canonicalPlayer = ratingsMap.get(1);
  assert.ok(canonicalPlayer);
  assert.strictEqual(canonicalPlayer.gamesCount, 3);
  assert.strictEqual(canonicalPlayer.wins, 3);
});

test('resolveMergedCountry - selects canonical country if valid', () => {
  const p: Partial<EloRanking> = {
    profile_id: 1,
    merged_ids: [1, 2]
  };
  const profiles: Record<number, Partial<PlayerProfile>> = {
    1: { country: 'hk' },
    2: { country: 'cn' }
  };
  const country = resolveMergedCountry(p as EloRanking, id => profiles[id]);
  assert.strictEqual(country, 'hk');
});

test('resolveMergedCountry - falls back to other merged profile country if canonical is Unknown or empty', () => {
  const p: Partial<EloRanking> = {
    profile_id: 1,
    merged_ids: [1, 2]
  };
  const profiles: Record<number, Partial<PlayerProfile>> = {
    1: { country: 'Unknown' },
    2: { country: 'hk' }
  };
  const country = resolveMergedCountry(p as EloRanking, id => profiles[id]);
  assert.strictEqual(country, 'hk');
});

test('resolveMergedCountry - returns Unknown if no profiles have a country code', () => {
  const p: Partial<EloRanking> = {
    profile_id: 1,
    merged_ids: [1, 2]
  };
  const profiles: Record<number, Partial<PlayerProfile>> = {
    1: { country: 'Unknown' },
    2: {}
  };
  const country = resolveMergedCountry(p as EloRanking, id => profiles[id]);
  assert.strictEqual(country, 'Unknown');
});
