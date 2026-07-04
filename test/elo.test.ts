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
