import type { Match, MatchPlayer } from './types.ts';

function normalizeMapName(mapName: string | undefined): string {
  return (mapName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isWin(resulttype: number): boolean {
  return resulttype === 1;
}

function isLoss(resulttype: number): boolean {
  return resulttype === 0 || resulttype === 2;
}

function sortedIds(players: MatchPlayer[]): number[] {
  return players
    .map(p => p.profile_id)
    .filter(id => Number.isFinite(id) && id > 0)
    .sort((a, b) => a - b);
}

export function buildMatchFingerprint(match: Pick<Match, 'startgametime' | 'mapname' | 'players'>): string {
  const players = match.players || [];
  const playerIds = sortedIds(players);
  const winnerIds = sortedIds(players.filter(p => isWin(p.resulttype)));
  const loserIds = sortedIds(players.filter(p => isLoss(p.resulttype)));

  return [
    'v1',
    `t:${match.startgametime || 0}`,
    `map:${normalizeMapName(match.mapname)}`,
    `p:${playerIds.join(',')}`,
    `w:${winnerIds.join(',')}`,
    `l:${loserIds.join(',')}`
  ].join('|');
}
