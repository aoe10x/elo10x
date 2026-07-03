import * as assert from 'node:assert';
import { test } from 'node:test';
import { EloCalculator } from '../src/elo.ts';
import type { Match } from '../src/types.ts';

test('EloCalculator - 1v1 Match Calculation', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    minGamesForLeaderboard: 1
  });

  const matches: Match[] = [
    {
      id: 1,
      mapname: "arabia",
      maxplayers: 2,
      matchtype_id: 6,
      description: "10x Fun Game",
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        {
          profile_id: 1,
          teamid: 1,
          resulttype: 1, // Win
          race_id: 1,
          alias: "Player A"
        },
        {
          profile_id: 2,
          teamid: 2,
          resulttype: 0, // Loss
          race_id: 2,
          alias: "Player B"
        }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  const playerA = ratingsMap.get(1);
  const playerB = ratingsMap.get(2);

  assert.ok(playerA);
  assert.ok(playerB);

  // ELO calculation details:
  // Expected score A: 1 / (1 + 10^((1000 - 1000)/400)) = 0.5
  // Delta A: 32 * (1 - 0.5) = 16
  // New rating: 1000 + 16 = 1016
  assert.strictEqual(playerA.rating, 1016);
  assert.strictEqual(playerA.wins, 1);
  assert.strictEqual(playerA.losses, 0);
  assert.strictEqual(playerA.gamesCount, 1);
  assert.strictEqual(playerA.winRate, 100);

  // Expected score B: 0.5
  // Delta B: 32 * (0 - 0.5) = -16
  // New rating: 1000 - 16 = 984
  assert.strictEqual(playerB.rating, 984);
  assert.strictEqual(playerB.wins, 0);
  assert.strictEqual(playerB.losses, 1);
  assert.strictEqual(playerB.gamesCount, 1);
  assert.strictEqual(playerB.winRate, 0);
});

test('EloCalculator - Team Match Calculation', () => {
  const calculator = new EloCalculator({
    defaultRating: 1000,
    kFactor: 32,
    minGamesForLeaderboard: 1
  });

  // Let's run two sequential games:
  // Game 1: Player A vs Player B -> Player A wins.
  //   Rating A: 1016. Rating B: 984.
  // Game 2: {A, C} vs {B, D}. Team 1 {A, C} wins.
  //   Team 1 Avg: (1016 + 1000)/2 = 1008
  //   Team 2 Avg: (984 + 1000)/2 = 992
  //   Expected 1: 1 / (1 + 10^((992 - 1008)/400)) = 1 / (1 + 10^(-16/400))
  //   Expected 1 approx: 1 / (1 + 0.912) = 1 / 1.912 = 0.523
  //   Delta 1: 32 * (1 - 0.523) = 32 * 0.477 = 15.26 (rounds to 15)
  //   New rating A: 1016 + 15 = 1031
  //   New rating C: 1000 + 15 = 1015
  //   New rating B: 984 - 15 = 969
  //   New rating D: 1000 - 15 = 985
  const matches: Match[] = [
    {
      id: 1,
      mapname: "arabia",
      maxplayers: 2,
      matchtype_id: 6,
      description: "10x Game 1",
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: "Player A" },
        { profile_id: 2, teamid: 2, resulttype: 0, race_id: 2, alias: "Player B" }
      ]
    },
    {
      id: 2,
      mapname: "bamboo nothing",
      maxplayers: 4,
      matchtype_id: 8,
      description: "10x Game 2",
      startgametime: 1700002000,
      completiontime: 1700003000,
      players: [
        { profile_id: 1, teamid: 10, resulttype: 1, race_id: 1, alias: "Player A" },
        { profile_id: 3, teamid: 10, resulttype: 1, race_id: 3, alias: "Player C" },
        { profile_id: 2, teamid: 20, resulttype: 0, race_id: 2, alias: "Player B" },
        { profile_id: 4, teamid: 20, resulttype: 0, race_id: 4, alias: "Player D" }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);

  const playerA = ratingsMap.get(1);
  const playerB = ratingsMap.get(2);
  const playerC = ratingsMap.get(3);
  const playerD = ratingsMap.get(4);

  assert.ok(playerA);
  assert.ok(playerB);
  assert.ok(playerC);
  assert.ok(playerD);

  assert.strictEqual(playerA.rating, 1031);
  assert.strictEqual(playerC.rating, 1015);
  assert.strictEqual(playerB.rating, 969);
  assert.strictEqual(playerD.rating, 985);

  assert.strictEqual(playerA.gamesCount, 2);
  assert.strictEqual(playerB.gamesCount, 2);
  assert.strictEqual(playerC.gamesCount, 1);
  assert.strictEqual(playerD.gamesCount, 1);
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
      mapname: "arena",
      maxplayers: 2,
      matchtype_id: 6,
      description: "10x Match",
      startgametime: 1700000000,
      completiontime: 1700001000,
      players: [
        { profile_id: 1, teamid: 1, resulttype: 1, race_id: 1, alias: "Player A" },
        { profile_id: 2, teamid: 2, resulttype: 0, race_id: 2, alias: "Player B" }
      ]
    }
  ];

  const ratingsMap = calculator.calculate(matches);
  
  // Player A and Player B only have 1 game.
  // minGamesForLeaderboard is 2.
  // getLeaderboard without showProvisional should return empty array
  const activeLeaderboard = calculator.getLeaderboard(ratingsMap, false);
  assert.strictEqual(activeLeaderboard.length, 0);

  // getLeaderboard with showProvisional = true should return both players sorted
  const provisionalLeaderboard = calculator.getLeaderboard(ratingsMap, true);
  assert.strictEqual(provisionalLeaderboard.length, 2);
  assert.strictEqual(provisionalLeaderboard[0].profile_id, 1); // Player A (1016 rating)
  assert.strictEqual(provisionalLeaderboard[1].profile_id, 2); // Player B (984 rating)
});
