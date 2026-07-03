import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { parse_rec_summary } from 'aoe2rec-js';
import { MAP_NAMES } from '../src/civ-data.ts';

type AocPlayer = {
  profile_id?: number;
  alias?: string;
  civ_id?: number;
  team_id?: number | null;
  winner?: boolean;
};

type AocResult = {
  match_id?: string;
  lobby_name?: string;
  map_name?: string;
  start_time?: number;
  duration?: number;
  players?: AocPlayer[];
};

type NormalizedPlayer = {
  profileId: number;
  alias: string;
  civId: number;
  teamId: number;
  winner: boolean;
};

type NormalizedReplay = {
  fileName: string;
  parser: 'aoc-mgz' | 'aoe2rec-js';
  parseOk: boolean;
  error?: string;
  matchIdRaw: string;
  mapName: string;
  mapId?: number;
  lobbyName: string;
  startTime: number;
  durationSec: number;
  players: NormalizedPlayer[];
  derivedNumericId: number;
};

type ReplayComparison = {
  fileName: string;
  filePath: string;
  aoc: NormalizedReplay;
  aoe: NormalizedReplay;
  bothParsed: boolean;
  delta: {
    derivedIdChanged: boolean;
    mapChanged: boolean;
    startTimeChanged: boolean;
    durationChanged: boolean;
    playerSetChanged: boolean;
    teamAssignmentsChanged: boolean;
    winnerFlagsChanged: boolean;
  };
};

const execFilePromise = promisify(execFile);

function stringToHash(str: string): number {
  let hash = 0;
  if (str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash);
}

async function locateReplayDirs(): Promise<string[]> {
  const homeDir = os.homedir();
  const baseDir = path.join(homeDir, 'Games', 'Age of Empires 2 DE');
  const potentialDirs = new Set<string>();

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const steamIds = entries
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => entry.name);

  for (const steamId of steamIds) {
    for (const subDirName of ['savegame', 'replays']) {
      const replayDir = path.join(baseDir, steamId, subDirName);
      try {
        const stat = await fs.stat(replayDir);
        if (!stat.isDirectory()) continue;
        potentialDirs.add(replayDir);
      } catch {
        // ignore
      }
    }
  }

  if (potentialDirs.size === 0) {
    throw new Error('No replay folders found under Games/Age of Empires 2 DE');
  }

  return Array.from(potentialDirs);
}

async function loadImportedReplayFilenames(repoRoot: string): Promise<string[]> {
  const importListPath = path.join(repoRoot, 'data', 'imported_replays.json');
  const raw = await fs.readFile(importListPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('data/imported_replays.json is not an array');
  }
  return parsed.filter((v: unknown): v is string => typeof v === 'string');
}

async function resolveReplayPath(filename: string, replayDirs: string[]): Promise<string | null> {
  for (const replayDir of replayDirs) {
    const candidate = path.join(replayDir, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function normalizeAoc(fileName: string, source: AocResult, parseOk: boolean, error?: string): NormalizedReplay {
  const players = (source.players ?? [])
    .map((p): NormalizedPlayer | null => {
      const profileId = Number(p.profile_id);
      if (!profileId || profileId <= 0 || profileId === 4294967295) return null;
      return {
        profileId,
        alias: p.alias ?? `Player_${profileId}`,
        civId: p.civ_id != null ? Number(p.civ_id) : 0,
        teamId: p.team_id != null ? Number(p.team_id) : 0,
        winner: p.winner === true
      };
    })
    .filter((p): p is NormalizedPlayer => p !== null)
    .sort((a, b) => a.profileId - b.profileId);

  const mapName = source.map_name ?? '';
  const startTime = Number(source.start_time ?? 0);
  const durationSec = Number(source.duration ?? 0);
  const matchIdRaw = source.match_id ?? '';

  const derivedNumericId = matchIdRaw
    ? stringToHash(matchIdRaw)
    : stringToHash(`${startTime}_${players.map(p => p.profileId).join(',')}_${mapName}`);

  return {
    fileName,
    parser: 'aoc-mgz',
    parseOk,
    error,
    matchIdRaw,
    mapName,
    lobbyName: source.lobby_name ?? '',
    startTime,
    durationSec,
    players,
    derivedNumericId
  };
}

function normalizeAoe(fileName: string, summary: any, parseOk: boolean, error?: string): NormalizedReplay {
  if (!parseOk) {
    return {
      fileName,
      parser: 'aoe2rec-js',
      parseOk,
      error,
      matchIdRaw: '',
      mapName: '',
      lobbyName: '',
      startTime: 0,
      durationSec: 0,
      players: [],
      derivedNumericId: 0
    };
  }

  const mapId = Number(summary?.header?.game_settings?.resolved_map_id ?? -1);
  const mapName = MAP_NAMES[mapId] ?? `Map #${mapId}`;
  const startTime = Number(summary?.header?.timestamp ?? 0);
  const durationSec = Math.floor(Number(summary?.duration ?? 0) / 1000);

  const teams: any[] = Array.isArray(summary?.teams) ? summary.teams : [];
  const players: NormalizedPlayer[] = [];

  for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
    const team = teams[teamIndex];
    const teamWinner = team?.winner === true;
    const teamPlayers: any[] = Array.isArray(team?.players) ? team.players : [];
    for (const p of teamPlayers) {
      const profileId = Number(p?.profile_id ?? 0);
      if (!profileId || profileId <= 0 || profileId === 4294967295) continue;
      players.push({
        profileId,
        alias: String(p?.name ?? `Player_${profileId}`),
        civId: Number(p?.civ_id ?? 0),
        teamId: teamIndex,
        winner: teamWinner
      });
    }
  }

  players.sort((a, b) => a.profileId - b.profileId);

  const derivedNumericId = stringToHash(
    `${startTime}_${players.map(p => p.profileId).join(',')}_${mapName}`
  );

  return {
    fileName,
    parser: 'aoe2rec-js',
    parseOk,
    error,
    matchIdRaw: '',
    mapName,
    mapId,
    lobbyName: '',
    startTime,
    durationSec,
    players,
    derivedNumericId
  };
}

function compareReplays(fileName: string, filePath: string, aoc: NormalizedReplay, aoe: NormalizedReplay): ReplayComparison {
  const bothParsed = aoc.parseOk && aoe.parseOk;

  const aocIds = new Set(aoc.players.map(p => p.profileId));
  const aoeIds = new Set(aoe.players.map(p => p.profileId));
  const playerSetChanged = aocIds.size !== aoeIds.size || [...aocIds].some(id => !aoeIds.has(id));

  const teamAssignmentsChanged = (() => {
    const common = [...aocIds].filter(id => aoeIds.has(id));
    return common.some(id => {
      const ap = aoc.players.find(p => p.profileId === id);
      const bp = aoe.players.find(p => p.profileId === id);
      return ap?.teamId !== bp?.teamId;
    });
  })();

  const winnerFlagsChanged = (() => {
    const common = [...aocIds].filter(id => aoeIds.has(id));
    return common.some(id => {
      const ap = aoc.players.find(p => p.profileId === id);
      const bp = aoe.players.find(p => p.profileId === id);
      return ap?.winner !== bp?.winner;
    });
  })();

  return {
    fileName,
    filePath,
    aoc,
    aoe,
    bothParsed,
    delta: {
      derivedIdChanged: aoc.derivedNumericId !== aoe.derivedNumericId,
      mapChanged: aoc.mapName.trim().toLowerCase() !== aoe.mapName.trim().toLowerCase(),
      startTimeChanged: aoc.startTime !== aoe.startTime,
      durationChanged: aoc.durationSec !== aoe.durationSec,
      playerSetChanged,
      teamAssignmentsChanged,
      winnerFlagsChanged
    }
  };
}

async function parseWithAoc(filePath: string): Promise<AocResult> {
  const { stdout } = await execFilePromise('python', ['src/parse_replay.py', filePath]);
  return JSON.parse(stdout) as AocResult;
}

async function parseWithAoe(filePath: string): Promise<any> {
  const buffer = await fs.readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return parse_rec_summary(arrayBuffer);
}

function buildSummary(comparisons: ReplayComparison[]) {
  const total = comparisons.length;
  const aocSuccess = comparisons.filter(c => c.aoc.parseOk).length;
  const aoeSuccess = comparisons.filter(c => c.aoe.parseOk).length;
  const bothSuccess = comparisons.filter(c => c.bothParsed).length;
  const aoeOnly = comparisons.filter(c => !c.aoc.parseOk && c.aoe.parseOk).length;
  const aocOnly = comparisons.filter(c => c.aoc.parseOk && !c.aoe.parseOk).length;

  const deltaBase = comparisons.filter(c => c.bothParsed);

  return {
    total,
    aocSuccess,
    aoeSuccess,
    bothSuccess,
    aoeOnly,
    aocOnly,
    deltas: {
      derivedIdChanged: deltaBase.filter(c => c.delta.derivedIdChanged).length,
      mapChanged: deltaBase.filter(c => c.delta.mapChanged).length,
      startTimeChanged: deltaBase.filter(c => c.delta.startTimeChanged).length,
      durationChanged: deltaBase.filter(c => c.delta.durationChanged).length,
      playerSetChanged: deltaBase.filter(c => c.delta.playerSetChanged).length,
      teamAssignmentsChanged: deltaBase.filter(c => c.delta.teamAssignmentsChanged).length,
      winnerFlagsChanged: deltaBase.filter(c => c.delta.winnerFlagsChanged).length
    }
  };
}

function createMarkdownReport(summary: ReturnType<typeof buildSummary>, comparisons: ReplayComparison[], selectedFiles: string[]): string {
  const lines: string[] = [];
  lines.push('# Local Parser Comparison Report');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push(`- Sample size requested: ${selectedFiles.length}`);
  lines.push(`- Replays resolved and compared: ${comparisons.length}`);
  lines.push('');
  lines.push('## Parse Coverage');
  lines.push('');
  lines.push(`- aoc-mgz successes: ${summary.aocSuccess}/${summary.total}`);
  lines.push(`- aoe2rec-js successes: ${summary.aoeSuccess}/${summary.total}`);
  lines.push(`- both successful: ${summary.bothSuccess}/${summary.total}`);
  lines.push(`- aoe2rec-js only successful: ${summary.aoeOnly}`);
  lines.push(`- aoc-mgz only successful: ${summary.aocOnly}`);
  lines.push('');
  lines.push('## Delta Counts On Dual-Success Replays');
  lines.push('');
  lines.push(`- derived numeric id changed: ${summary.deltas.derivedIdChanged}`);
  lines.push(`- map changed: ${summary.deltas.mapChanged}`);
  lines.push(`- start time changed: ${summary.deltas.startTimeChanged}`);
  lines.push(`- duration changed: ${summary.deltas.durationChanged}`);
  lines.push(`- player set changed: ${summary.deltas.playerSetChanged}`);
  lines.push(`- team assignments changed: ${summary.deltas.teamAssignmentsChanged}`);
  lines.push(`- winner flags changed: ${summary.deltas.winnerFlagsChanged}`);
  lines.push('');
  lines.push('## Per Replay Results');
  lines.push('');
  lines.push('| File | aoc-mgz | aoe2rec-js | Both | Key Delta Flags |');
  lines.push('|---|---|---|---|---|');

  for (const c of comparisons) {
    const flags: string[] = [];
    if (c.delta.derivedIdChanged) flags.push('id');
    if (c.delta.mapChanged) flags.push('map');
    if (c.delta.playerSetChanged) flags.push('players');
    if (c.delta.teamAssignmentsChanged) flags.push('teams');
    if (c.delta.winnerFlagsChanged) flags.push('winner');
    if (c.delta.startTimeChanged) flags.push('start');
    if (c.delta.durationChanged) flags.push('dur');

    lines.push(`| ${c.fileName} | ${c.aoc.parseOk ? 'ok' : 'fail'} | ${c.aoe.parseOk ? 'ok' : 'fail'} | ${c.bothParsed ? 'yes' : 'no'} | ${flags.join(', ') || 'none'} |`);
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      sample: { type: 'string' },
      outdir: { type: 'string' }
    }
  });

  const sampleSize = args.values.sample ? Number(args.values.sample) : 20;
  const outDir = args.values.outdir ? String(args.values.outdir) : path.join('scratch', 'results', 'parser-compare');

  if (!Number.isFinite(sampleSize) || sampleSize <= 0) {
    throw new Error('sample must be a positive integer');
  }

  const repoRoot = process.cwd();
  const replayDirs = await locateReplayDirs();
  const importedFiles = await loadImportedReplayFilenames(repoRoot);
  const selectedFiles = importedFiles.slice(0, sampleSize);

  await fs.mkdir(outDir, { recursive: true });

  const comparisons: ReplayComparison[] = [];

  for (const fileName of selectedFiles) {
    const filePath = await resolveReplayPath(fileName, replayDirs);
    if (!filePath) continue;

    let aoc: NormalizedReplay;
    let aoe: NormalizedReplay;

    try {
      const aocRaw = await parseWithAoc(filePath);
      aoc = normalizeAoc(fileName, aocRaw, true);
    } catch (err: any) {
      aoc = normalizeAoc(fileName, {}, false, String(err?.message ?? err));
    }

    try {
      const aoeRaw = await parseWithAoe(filePath);
      aoe = normalizeAoe(fileName, aoeRaw, true);
    } catch (err: any) {
      aoe = normalizeAoe(fileName, {}, false, String(err?.message ?? err));
    }

    comparisons.push(compareReplays(fileName, filePath, aoc, aoe));
  }

  const summary = buildSummary(comparisons);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonPath = path.join(outDir, `comparison-${timestamp}.json`);
  const mdPath = path.join(outDir, `comparison-${timestamp}.md`);

  await fs.writeFile(jsonPath, JSON.stringify({ summary, comparisons }, null, 2), 'utf-8');
  await fs.writeFile(mdPath, createMarkdownReport(summary, comparisons, selectedFiles), 'utf-8');

  console.log('Local parser comparison finished.');
  console.log(`Sample requested: ${selectedFiles.length}`);
  console.log(`Replays resolved: ${comparisons.length}`);
  console.log(`aoc-mgz success: ${summary.aocSuccess}/${summary.total}`);
  console.log(`aoe2rec-js success: ${summary.aoeSuccess}/${summary.total}`);
  console.log(`Both success: ${summary.bothSuccess}/${summary.total}`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
}

main().catch((err) => {
  console.error('compare_local_parsers failed:', err);
  process.exit(1);
});
