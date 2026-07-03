import { promises as fs } from 'node:fs';
import {readdirSync} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse_rec_summary } from 'aoe2rec-js';
import { JsonDatabase } from './db.ts';
import { EloCalculator } from './elo.ts';
import { MAP_NAMES } from './civ-data.ts';
import type { Match, MatchPlayer, MatchSource } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

const execFilePromise = promisify(execFile);

type ParserMode = 'mgz' | 'aoe2rec' | 'auto';

type ParsedReplay = {
  match_id?: string;
  lobby_name?: string;
  map_name?: string;
  start_time?: number;
  duration?: number;
  players?: Array<{
    profile_id?: number;
    alias?: string;
    civ_id?: number;
    team_id?: number | null;
    winner?: boolean;
  }>;
};

type ParserResult = {
  parsed: ParsedReplay;
  parserUsed: 'mgz' | 'aoe2rec';
};

// Helper to hash strings to a stable positive integer
function stringToHash(str: string): number {
  let hash = 0;
  if (str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function getParserMode(): ParserMode {
  const raw = (process.env.IMPORT_LOCAL_PARSER ?? 'auto').toLowerCase();
  if (raw === 'mgz' || raw === 'aoe2rec' || raw === 'auto') {
    return raw;
  }

  console.warn(`Invalid IMPORT_LOCAL_PARSER value "${raw}". Falling back to auto.`);
  return 'auto';
}

function shouldAssume10xWhenLobbyMissing(): boolean {
  const raw = (process.env.IMPORT_LOCAL_ASSUME_10X_WHEN_LOBBY_MISSING ?? '0').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function runWithSilencedConsoleError<T>(fn: () => T): T {
  const originalConsoleError = console.error;
  console.error = () => {
    // aoe2rec-js panic hooks emit very large stack traces on invalid data.
    // We intentionally silence these and handle errors via try/catch at callsite.
  };
  try {
    return fn();
  } finally {
    console.error = originalConsoleError;
  }
}

async function parseWithMgz(filePath: string): Promise<ParsedReplay> {
  const { stdout } = await execFilePromise('python', ['src/parse_replay.py', filePath]);
  return JSON.parse(stdout) as ParsedReplay;
}

async function parseWithAoe2rec(filePath: string): Promise<ParsedReplay> {
  const buffer = await fs.readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const summary = runWithSilencedConsoleError(() => parse_rec_summary(arrayBuffer));

  const teams = Array.isArray(summary?.teams) ? summary.teams : [];
  const players: ParsedReplay['players'] = [];

  for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
    const team = teams[teamIndex];
    const teamWinner = team?.winner === true;
    const teamPlayers = Array.isArray(team?.players) ? team.players : [];

    for (const p of teamPlayers) {
      players.push({
        profile_id: Number(p?.profile_id ?? 0),
        alias: String(p?.name ?? ''),
        civ_id: Number(p?.civ_id ?? 0),
        team_id: teamIndex,
        winner: teamWinner,
      });
    }
  }

  const mapId = Number(summary?.header?.game_settings?.resolved_map_id ?? -1);
  const mapName = MAP_NAMES[mapId] ?? `Map #${mapId}`;
  const startTime = Number(summary?.header?.timestamp ?? 0);
  const durationSec = Math.floor(Number(summary?.duration ?? 0) / 1000);

  return {
    match_id: undefined,
    lobby_name: '',
    map_name: mapName,
    start_time: startTime,
    duration: durationSec,
    players,
  };
}

async function parseReplayByMode(filePath: string, parserMode: ParserMode): Promise<ParserResult> {
  if (parserMode === 'mgz') {
    return { parsed: await parseWithMgz(filePath), parserUsed: 'mgz' };
  }

  if (parserMode === 'aoe2rec') {
    return { parsed: await parseWithAoe2rec(filePath), parserUsed: 'aoe2rec' };
  }

  try {
    return { parsed: await parseWithMgz(filePath), parserUsed: 'mgz' };
  } catch {
    return { parsed: await parseWithAoe2rec(filePath), parserUsed: 'aoe2rec' };
  }
}

async function locateReplaysDirs(): Promise<string[]> {
  const homeDir = os.homedir();
  const baseDir = path.join(homeDir, 'Games', 'Age of Empires 2 DE');
  const potentialDirs = new Set<string>();
  
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    // Find numeric directories (SteamIDs are digits)
    const steamIds = entries
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(entry => entry.name);
      
    for (const steamId of steamIds) {
      // Check for both 'savegame' and 'replays' directories
      for (const subDirName of ['savegame', 'replays','SAVEGAMEBACKUPofstufff']) {
        const potentialDir = path.join(baseDir, steamId, subDirName);
        try {
          console.log(potentialDir);
          const stat = await fs.stat(potentialDir);
          if (stat.isDirectory()) {
            // Check if there are any .aoe2record files inside it
            const files = await fs.readdir(potentialDir);
            const hasRecords = files.some(f => f.endsWith('.aoe2record'));
            if (hasRecords) {
              potentialDirs.add(potentialDir);
            }
          }
        } catch {
          // Ignore errors and keep searching
        }
      }
    }
    
    // Fallback: return the first folder found even if empty
    for (const steamId of steamIds) {
      for (const subDirName of ['savegame', 'replays']) {
        const potentialDir = path.join(baseDir, steamId, subDirName);
        try {
          const stat = await fs.stat(potentialDir);
          if (stat.isDirectory()) {
            potentialDirs.add(potentialDir);
          }
        } catch {}
      }
    }
  } catch (err: any) {
    console.warn(`Could not read games directory: ${err.message}`);
  }
  
  if (potentialDirs.size > 0) {
    return Array.from(potentialDirs);
  }

  throw new Error("Could not locate Age of Empires II DE savegame or replays directory.");
}

async function main(): Promise<void> {
let replaysDirs: string[];
  const parserMode = getParserMode();
  const assume10xWhenLobbyMissing = shouldAssume10xWhenLobbyMissing();
  try {
    replaysDirs = await locateReplaysDirs();
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  }

  console.log(`Replays folders located: ${replaysDirs}`);
  console.log(`Parser mode: ${parserMode}`);
  if (assume10xWhenLobbyMissing) {
    console.log('10x fallback enabled for missing lobby names.');
  }

  // Load database
  const db = new JsonDatabase();
  await db.load();

  // Load list of already imported replays (cache) to avoid re-parsing
  const importCachePath = path.join(process.cwd(), 'data', 'imported_replays.json');
  let importedFilenames = new Set<string>();
  try {
    const cacheContent = await fs.readFile(importCachePath, 'utf-8');
    const parsedCache = JSON.parse(cacheContent);
    if (Array.isArray(parsedCache)) {
      importedFilenames = new Set(parsedCache);
    }
  } catch (err: any) {
    // If file doesn't exist, we start with an empty set
  }

  // Scan replays folder for .aoe2record files
  let allFiles: string[] = [];
  try {
    const files = await Promise.all(replaysDirs.map(dir => readdirSync(dir).map(f => path.join(dir, f))));
    allFiles = files.flat().filter(f => f.endsWith('.aoe2record'));
  } catch (err: any) {
    console.error(`Error listing replays folder: ${err.message}`);
    process.exit(1);
  }

  console.log(`Found ${allFiles.length} replay file(s).`);

  const filesToProcess = allFiles.filter(f => !importedFilenames.has(path.basename(f)));
  console.log(`Need to process ${filesToProcess.length} new replay file(s).`);

  if (filesToProcess.length === 0) {
    console.log("No new replays to import.");
    return;
  }

  let dbUpdated = false;
  let newImportCount = 0;

  const CONCURRENCY = 8;
  let activeIndex = 0;
  let processedCount = 0;

  async function worker() {
    while (activeIndex < filesToProcess.length) {
      const index = activeIndex++;
      const filePath = filesToProcess[index];
      const filename = path.basename(filePath);

      const count = ++processedCount;
      const pct = ((count / filesToProcess.length) * 100).toFixed(1);
      console.log(`[${count}/${filesToProcess.length}] (${pct}%) Processing ${filename}...`);

      try {
        const { parsed: parsedJson, parserUsed } = await parseReplayByMode(filePath, parserMode);
        const matchSource: MatchSource = parserUsed === 'mgz' ? 'local_replay_mgz' : 'local_replay_aoe2rec';

        // Verify if the match is a "10x" game (lobby name contains "10x" case-insensitively)
        const lobbyTitle = parsedJson.lobby_name || '';
        let is10x = /10x/i.test(lobbyTitle);
        if (!is10x && parserUsed === 'aoe2rec' && !lobbyTitle && assume10xWhenLobbyMissing) {
          is10x = true;
        }

        if (!is10x) {
          if (parserUsed === 'aoe2rec' && !lobbyTitle) {
            console.log(`Skipping ${filename}: aoe2rec parser has no lobby name and 10x fallback is disabled.`);
          }
          // Not a 10x game, skip it but mark as processed to avoid re-parsing next time
          importedFilenames.add(filename);
          continue;
        }

        // Generate stable numeric ID
        let numericId: number;
        if (parsedJson.match_id) {
          numericId = stringToHash(parsedJson.match_id);
        } else {
          const playerKeys = (parsedJson.players || [])
            .map((p: any) => p.profile_id)
            .sort()
            .join(',');
          const uniqueString = `${parsedJson.start_time}_${playerKeys}_${parsedJson.map_name}`;
          numericId = stringToHash(uniqueString);
        }

        // Check if match is already in db.json
        if (db.hasMatch(numericId)) {
          console.log(`Match ${numericId} (${lobbyTitle}) already exists in database.`);
          importedFilenames.add(filename);
          continue;
        }

        // Map players
        const participants: MatchPlayer[] = [];
        const playersList = parsedJson.players || [];

        for (const p of playersList) {
          const pId = Number(p.profile_id);
          if (!pId || pId <= 0 || pId === 4294967295) {
            continue; // Skip invalid players/AIs/empty slots
          }

          const resulttype = p.winner === true ? 1 : 0;
          const teamid = p.team_id !== null && p.team_id !== undefined ? Number(p.team_id) : 0;

          participants.push({
            profile_id: pId,
            teamid: teamid,
            resulttype: resulttype,
            race_id: p.civ_id !== null && p.civ_id !== undefined ? Number(p.civ_id) : 0,
            alias: p.alias || `Player_${pId}`
          });

          // Add profile to DB profile list
          db.addProfile({
            profile_id: pId,
            alias: p.alias || `Player_${pId}`
          });
        }

        if (participants.length === 0) {
          console.log(`Skipping match ${numericId} because it has no valid human players.`);
          importedFilenames.add(filename);
          continue;
        }

        const matchObj: Match = {
          id: numericId,
          source: matchSource,
          mapname: parsedJson.map_name || 'Unknown Map',
          maxplayers: participants.length,
          matchtype_id: 0,
          description: lobbyTitle,
          startgametime: parsedJson.start_time || Math.floor(Date.now() / 1000),
          completiontime: (parsedJson.start_time || Math.floor(Date.now() / 1000)) + (parsedJson.duration || 0),
          players: participants
        };

        const fingerprint = buildMatchFingerprint(matchObj);
        const existingMatchId = db.findMatchIdByFingerprint(fingerprint);
        if (existingMatchId !== undefined) {
          console.log(`Skipping duplicate-equivalent replay ${filename}; equivalent to existing match ${existingMatchId}.`);
          importedFilenames.add(filename);
          continue;
        }

        db.addMatch(matchObj);
        console.log(`Successfully parsed, and logged 10x match [${numericId} / ${lobbyTitle}]`);
        dbUpdated = true;
        newImportCount++;

        importedFilenames.add(filename);
      } catch (err: any) {
        console.warn(`[Skip] Failed to process replay ${filename}: ${err.message.trim()}`);
        // Mark as imported to avoid constant retrying
        importedFilenames.add(filename);
      }
    }
  }

  // Start workers in parallel
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, filesToProcess.length) }, 
    () => worker()
  );
  await Promise.all(workers);

  // Save imported files cache
  try {
    await fs.writeFile(importCachePath, JSON.stringify(Array.from(importedFilenames), null, 2), 'utf-8');
  } catch (err: any) {
    console.error(`Error saving import cache: ${err.message}`);
  }

  if (dbUpdated) {
    // Save database
    await db.save();
    console.log(`Database saved with ${newImportCount} new match(es).`);

    // Recalculate ELO and update leaderboard
    const matches = db.getMatches();
    console.log(`Calculating ELO ratings for ${matches.length} matches...`);
    
    const calculator = new EloCalculator({
      kFactor: 32,
      minGamesForLeaderboard: 5
    });

    const ratingsMap = calculator.calculate(matches);
    const leaderboard = calculator.getLeaderboard(ratingsMap, false);

    const leaderboardPath = path.join(process.cwd(), 'data', 'leaderboard.json');
    await fs.mkdir(path.dirname(leaderboardPath), { recursive: true });
    
    const payload = {
      updatedAt: Date.now(),
      totalMatches: matches.length,
      totalPlayers: ratingsMap.size,
      leaderboardCount: leaderboard.length,
      config: { minGames: 5, kFactor: 32, provisional: false },
      players: leaderboard.map(p => ({
        ...p,
        country: db.getProfile(p.profile_id)?.country
      }))
    };
    
    await fs.writeFile(leaderboardPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`Leaderboard successfully recalculated and saved to ${leaderboardPath}`);
  } else {
    console.log('No new 10x matches imported. Leaderboard is already up to date.');
  }
}

main().catch(err => {
  console.error("Fatal Importer Error:", err);
  process.exit(1);
});
