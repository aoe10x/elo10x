import fs from 'node:fs';

const db = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
const matches = Object.values(db.matches || {});

const normalizeMapName = (mapName) => (mapName || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isWin = (resulttype) => resulttype === 1;
const isLoss = (resulttype) => resulttype === 0 || resulttype === 2;

const sortedIds = (players) =>
  players
    .map((p) => p.profile_id)
    .filter((id) => Number.isFinite(id) && id > 0)
    .sort((a, b) => a - b);

const fingerprint = (match) => {
  const players = match.players || [];
  const playerIds = sortedIds(players).join(',');
  const winnerIds = sortedIds(players.filter((p) => isWin(p.resulttype))).join(',');
  const loserIds = sortedIds(players.filter((p) => isLoss(p.resulttype))).join(',');

  return [
    'v1',
    `t:${match.startgametime || 0}`,
    `map:${normalizeMapName(match.mapname)}`,
    `p:${playerIds}`,
    `w:${winnerIds}`,
    `l:${loserIds}`
  ].join('|');
};

const bySource = new Map();
for (const m of matches) {
  const src = m.source || 'unknown';
  bySource.set(src, (bySource.get(src) || 0) + 1);
}

const byFingerprint = new Map();
for (const match of matches) {
  const fp = fingerprint(match);
  if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
  byFingerprint.get(fp).push(match);
}

const dupGroups = Array.from(byFingerprint.values()).filter((g) => g.length > 1);
const crossSourceDupGroups = dupGroups.filter((g) => new Set(g.map((m) => m.source || 'unknown')).size > 1);

const pauliId = 404483;
const pauliMatches = matches.filter((m) => (m.players || []).some((p) => p.profile_id === pauliId));
const pauliBySource = new Map();
for (const m of pauliMatches) {
  const src = m.source || 'unknown';
  pauliBySource.set(src, (pauliBySource.get(src) || 0) + 1);
}

const result = {
  totalMatches: matches.length,
  matchesBySource: Object.fromEntries(Array.from(bySource.entries()).sort((a, b) => b[1] - a[1])),
  duplicateGroups: dupGroups.length,
  duplicateExtraMatches: dupGroups.reduce((n, g) => n + (g.length - 1), 0),
  crossSourceDuplicateGroups: crossSourceDupGroups.length,
  crossSourceDuplicateExtraMatches: crossSourceDupGroups.reduce((n, g) => n + (g.length - 1), 0),
  pauliProfileId: pauliId,
  pauliMatchCount: pauliMatches.length,
  pauliMatchesBySource: Object.fromEntries(Array.from(pauliBySource.entries()).sort((a, b) => b[1] - a[1]))
};

console.log(JSON.stringify(result, null, 2));
