import fs from 'node:fs';

const db = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
const matches = Object.values(db.matches || {});
const profiles = Object.values(db.profiles || {});

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

const byFingerprint = new Map();
for (const match of matches) {
  const fp = fingerprint(match);
  if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
  byFingerprint.get(fp).push(match);
}

const duplicateGroups = Array.from(byFingerprint.values()).filter((g) => g.length > 1);

const pauliProfiles = profiles
  .filter((p) => (p.alias || '').toLowerCase().includes('paulichromatic'))
  .map((p) => ({ profile_id: p.profile_id, alias: p.alias }));

const pauliSet = new Set(pauliProfiles.map((p) => p.profile_id));

const pauliMatches = matches.filter((m) =>
  (m.players || []).some((p) => pauliSet.has(p.profile_id))
);

const pauliDuplicateGroups = duplicateGroups.filter((group) =>
  group.some((m) => (m.players || []).some((p) => pauliSet.has(p.profile_id)))
);

const samplePauliDupGroups = pauliDuplicateGroups.slice(0, 20).map((g) => ({
  size: g.length,
  matchIds: g.map((m) => m.id),
  startgametime: g[0]?.startgametime,
  mapname: g[0]?.mapname,
  descriptions: Array.from(new Set(g.map((m) => m.description || ''))).slice(0, 4),
  players: Array.from(
    new Set(
      g.flatMap((m) => (m.players || []).map((p) => `${p.profile_id}:${p.alias || ''}`))
    )
  ).slice(0, 20)
}));

const output = {
  totalMatches: matches.length,
  duplicateGroups: duplicateGroups.length,
  duplicateExtraMatches: duplicateGroups.reduce((n, g) => n + (g.length - 1), 0),
  pauliProfiles,
  pauliMatchCount: pauliMatches.length,
  pauliDuplicateGroups: pauliDuplicateGroups.length,
  pauliDuplicateExtraMatches: pauliDuplicateGroups.reduce((n, g) => n + (g.length - 1), 0),
  samplePauliDupGroups
};

console.log(JSON.stringify(output, null, 2));
