import * as assert from 'node:assert';
import { test } from 'node:test';
import { EloCalculator } from '../src/elo.ts';
import type { Match } from '../src/types.ts';

test('EloCalculator - Strict 4v4 Match Calculation', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, race_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, race_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, race_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, race_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, race_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, race_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, race_id: 8, alias: 'B4' }
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 2, resulttype: 0, race_id: 2, alias: 'B1' }
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
      { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
      { profile_id: 2, teamid: 1, resulttype: 1, race_id: 1, alias: 'A2' },
      { profile_id: 3, teamid: 1, resulttype: 1, race_id: 1, alias: 'A3' },
      { profile_id: 4, teamid: 1, resulttype: 1, race_id: 1, alias: 'A4' },
      { profile_id: 5, teamid: 1, resulttype: 0, race_id: 1, alias: 'B1' },
      { profile_id: 6, teamid: 2, resulttype: 0, race_id: 1, alias: 'B2' },
      { profile_id: 7, teamid: 2, resulttype: 0, race_id: 1, alias: 'B3' },
      { profile_id: 8, teamid: 2, resulttype: 0, race_id: 1, alias: 'B4' }
    ]
  };

  const ratingsMap = calculator.calculate([match]);
  assert.strictEqual(ratingsMap.size, 0);
});

test('EloCalculator - Accepts Legacy Loss Code 2', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
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
      { profile_id: 1, teamid: 10, resulttype: 1, race_id: 1, alias: 'A1' },
      { profile_id: 2, teamid: 10, resulttype: 1, race_id: 1, alias: 'A2' },
      { profile_id: 3, teamid: 10, resulttype: 1, race_id: 1, alias: 'A3' },
      { profile_id: 4, teamid: 10, resulttype: 1, race_id: 1, alias: 'A4' },
      { profile_id: 5, teamid: 20, resulttype: 2, race_id: 1, alias: 'B1' },
      { profile_id: 6, teamid: 20, resulttype: 2, race_id: 1, alias: 'B2' },
      { profile_id: 7, teamid: 20, resulttype: 2, race_id: 1, alias: 'B3' },
      { profile_id: 8, teamid: 20, resulttype: 2, race_id: 1, alias: 'B4' }
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, race_id: 1, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, race_id: 1, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, race_id: 1, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, race_id: 1, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, race_id: 1, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, race_id: 1, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, race_id: 1, alias: 'B4' }
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, race_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, race_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, race_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, race_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, race_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, race_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, race_id: 8, alias: 'B4' }
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, race_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, race_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, race_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, race_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, race_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, race_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, race_id: 8, alias: 'B4' }
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 2, teamid: 1, resulttype: 1, race_id: 2, alias: 'A2' },
        { profile_id: 3, teamid: 1, resulttype: 1, race_id: 3, alias: 'A3' },
        { profile_id: 4, teamid: 1, resulttype: 1, race_id: 4, alias: 'A4' },
        { profile_id: 5, teamid: 2, resulttype: 0, race_id: 5, alias: 'B1' },
        { profile_id: 6, teamid: 2, resulttype: 0, race_id: 6, alias: 'B2' },
        { profile_id: 7, teamid: 2, resulttype: 0, race_id: 7, alias: 'B3' },
        { profile_id: 8, teamid: 2, resulttype: 0, race_id: 8, alias: 'B4' }
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
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: 'A1' },
        { profile_id: 9, teamid: 1, resulttype: 1, race_id: 2, alias: 'A9' },
        { profile_id: 10, teamid: 1, resulttype: 1, race_id: 3, alias: 'A10' },
        { profile_id: 11, teamid: 1, resulttype: 1, race_id: 4, alias: 'A11' },
        { profile_id: 12, teamid: 2, resulttype: 0, race_id: 5, alias: 'B12' },
        { profile_id: 13, teamid: 2, resulttype: 0, race_id: 6, alias: 'B13' },
        { profile_id: 14, teamid: 2, resulttype: 0, race_id: 7, alias: 'B14' },
        { profile_id: 15, teamid: 2, resulttype: 0, race_id: 8, alias: 'B15' }
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
