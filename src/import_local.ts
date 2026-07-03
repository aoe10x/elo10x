import { promises as fs } from 'node:fs';
import {readdirSync} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonDatabase } from './db.ts';
import { EloCalculator } from './elo.ts';
import type { Match, MatchPlayer } from './types.ts';
import { buildMatchFingerprint } from './match_fingerprint.ts';

const execFilePromise = promisify(execFile);

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
  try {
    replaysDirs = await locateReplaysDirs();
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  }

  console.log(`Replays folders located: ${replaysDirs}`);

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
        // Spawn Python parser
        const { stdout } = await execFilePromise('python', ['src/parse_replay.py', filePath]);
        const parsedJson = JSON.parse(stdout);

        // Verify if the match is a "10x" game (lobby name contains "10x" case-insensitively)
        const lobbyTitle = parsedJson.lobby_name || '';
        const is10x = /10x/i.test(lobbyTitle);

        if (!is10x) {
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
