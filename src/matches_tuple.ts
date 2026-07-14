import type { Match, MatchPlayer, MatchSource } from './types.ts';

export type MatchPlayerTuple = [
  number, // 0: profile_id
  number, // 1: teamid
  number, // 2: resulttype
  number  // 3: civ_id
];

export type MatchTuple = [
  number,                     // 0: id
  number | null,              // 1: creator_profile_id
  string | null,              // 2: mapname
  number,                     // 3: startgametime
  number | null,              // 4: completiontime
  MatchPlayerTuple[],         // 5: players
  (number | null)?,           // 6: gamemod_id (null if 363188)
  (string | null)?,           // 7: description
  (string | null)?,           // 8: source (null if 'relic_api')
  (number | null)?,           // 9: maxplayers (null if 8)
  (number | null)?            // 10: matchtype_id (null if 0)
];

export function matchToTuple(m: Match): MatchTuple {
  const playersTuple = m.players.map(p => [
    p.profile_id,
    p.teamid,
    p.resulttype,
    p.civ_id
  ] as MatchPlayerTuple);

  const tuple: MatchTuple = [
    m.id,
    m.creator_profile_id ?? null,
    m.mapname ?? null,
    m.startgametime,
    m.completiontime ?? null,
    playersTuple,
    m.gamemod_id === 363188 ? null : (m.gamemod_id ?? null),
    m.description ?? null,
    m.source === 'relic_api' ? null : (m.source ?? null),
    m.maxplayers === 8 ? null : m.maxplayers,
    m.matchtype_id === 0 ? null : m.matchtype_id
  ];

  // Trim trailing nulls to save extra space
  const trimmed = [...tuple] as MatchTuple;
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === null) {
    trimmed.pop();
  }

  return trimmed;
}

export function tupleToMatch(tuple: MatchTuple, profileLookup?: (profileId: number) => string | undefined): Match {
  const players: MatchPlayer[] = (tuple[5] || []).map((p: MatchPlayerTuple) => {
    const profileId = p[0];
    const alias = (profileLookup ? profileLookup(profileId) : undefined) || `Player_${profileId}`;
    const player: MatchPlayer = {
      profile_id: profileId,
      teamid: p[1],
      resulttype: p[2],
      civ_id: p[3],
      alias: alias
    };
    return player;
  });

  return {
    id: tuple[0],
    creator_profile_id: tuple[1] ?? undefined,
    mapname: tuple[2] ?? '',
    startgametime: tuple[3],
    completiontime: tuple[4] ?? tuple[3],
    players: players,
    gamemod_id: tuple[6] ?? 363188,
    description: tuple[7] ?? '',
    source: (tuple[8] as MatchSource | null | undefined) ?? 'relic_api',
    maxplayers: tuple[9] ?? 8,
    matchtype_id: tuple[10] ?? 0
  };
}
