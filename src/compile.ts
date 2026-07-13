import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { JsonDatabase } from './db.ts';
import { EloCalculator } from './elo.ts';
import type { EloRanking } from './types.ts';
import { resolveMergedCountry } from './profile_utils.ts';
import { Aoe2InsightsScraper } from './aoe2insights_scraper.ts';
import { generateCivWinratesReport } from './tools/calculate_civ_winrates.ts';

function escapeHtml(str: string | null | undefined): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function downsampleHistory(history: number[], maxPoints: number = 100): number[] {
  if (history.length <= maxPoints) return history;
  const sampled: number[] = [history[0]];
  const step = (history.length - 2) / (maxPoints - 2);
  for (let i = 1; i < maxPoints - 1; i++) {
    const idx = Math.round(i * step);
    sampled.push(history[idx]);
  }
  sampled.push(history[history.length - 1]);
  return sampled;
}

function generateSparkline(history: number[] | undefined, rating: number): string {
  const pointsHistory = history || [1000, rating];
  const lastGames = pointsHistory.slice(-30);
  
  if (lastGames.length <= 1) {
    return `<span style="color: var(--text-muted); font-size: 0.85rem;">Flat</span>`;
  }
  
  const width = 100;
  const height = 20;
  const padding = 2;
  
  const minVal = Math.min(1000, ...lastGames);
  const maxVal = Math.max(1000, ...lastGames);
  const valRange = maxVal - minVal || 1;
  
  const points = lastGames.map((val, idx) => {
    const x = padding + (idx / (lastGames.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (val - minVal) / valRange) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  
  const lastRating = lastGames[lastGames.length - 1];
  const lastRatingY = padding + (1 - (lastRating - minVal) / valRange) * (height - padding * 2);
  const y1000 = padding + (1 - (1000 - minVal) / valRange) * (height - padding * 2);
  
  return `
    <svg viewBox="0 0 ${width} ${height}">
      <line x1="${padding}" y1="${y1000.toFixed(1)}" x2="${width - padding}" y2="${y1000.toFixed(1)}" />
      <polyline points="${points}" />
      <circle cx="${width - padding}" cy="${lastRatingY.toFixed(1)}" />
    </svg>
  `;
}

function generateRowHtml(player: EloRanking, rank: number, maxSingleRecord: number, inactiveCutoff: number): string {
  const rankContent = `<span class="rank-other">${rank}</span>`;

  const hasValidCountry = player.country && player.country.trim().length === 2 && player.country.toLowerCase() !== 'un';
  let countryName = '';
  if (hasValidCountry) {
    try {
      const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
      countryName = regionNames.of(player.country!.toUpperCase()) || player.country!.toUpperCase();
    } catch {
      countryName = player.country!.toUpperCase();
    }
  }

  const eloDiff = player.rating - 1000;
  const eloBarWidth = Math.min(40, Math.round(Math.abs(eloDiff) * 0.1));
  let eloDirection = '';
  if (eloDiff > 0 && eloBarWidth > 0) {
    eloDirection = 'direction-right';
  } else if (eloDiff < 0 && eloBarWidth > 0) {
    eloDirection = 'direction-left';
  }
  const eloIndicatorHtml = eloDirection 
    ? `<div class="elo-bar ${eloDirection}"></div>` 
    : '';

  const winRateVal = player.winRate || 50;
  const wrDiff = winRateVal - 50;
  const wrWidth = Math.min(80, Math.round(Math.abs(wrDiff) * 1.6));
  let winrateDirection = '';
  if (wrDiff > 0 && wrWidth > 0) {
    winrateDirection = 'direction-right';
  } else if (wrDiff < 0 && wrWidth > 0) {
    winrateDirection = 'direction-left';
  }
  const winrateIndicatorHtml = winrateDirection 
    ? `<div class="winrate-indicator-bar ${winrateDirection}"></div>` 
    : '';

  const winWidth = Math.round((player.wins / maxSingleRecord) * 80);
  const lossWidth = Math.round((player.losses / maxSingleRecord) * 80);
  const sparklineHtml = generateSparkline(player.ratingHistory, player.rating);

  const isInactive = (player.lastPlayedAt || 0) < inactiveCutoff;

  const rowStyles = `--w: ${winWidth}px; --l: ${lossWidth}px; --wr: ${wrWidth}px; --e: ${eloBarWidth}px;`;
  const countryAttr = hasValidCountry ? ` data-country="${player.country!.toLowerCase()}"` : '';

  return `
    <tr class="player-row" data-profile-id="${player.profile_id}" data-alias="${escapeHtml(player.alias)}" data-inactive="${isInactive}" style="${rowStyles}">
      <td class="col-rank">${rankContent}</td>
      <td class="col-alias"><span class="alias-name"${countryAttr} title="${escapeHtml(player.alias)}">${escapeHtml(player.alias)}</span></td>
      <td class="col-elo">
        <div class="elo-container">
          <span class="elo-value">${player.rating}</span>
          <div class="elo-bar-center">
            ${eloIndicatorHtml}
          </div>
        </div>
      </td>
      <td class="col-trend">${sparklineHtml}</td>
      <td class="col-winrate">
        <div class="true-diverging-container" title="${player.wins} wins, ${player.losses} losses (${player.winRate}% win rate over ${player.gamesCount} total games)">
          <div class="losses-side">
            <span>${player.losses}L</span>
            <del></del>
          </div>
          <div class="center-divider-line">
            ${winrateIndicatorHtml}
          </div>
          <div class="wins-side">
            <ins></ins>
            <span>${player.wins}W</span>
            <span>(${player.winRate}%)</span>
          </div>
        </div>
      </td>
      <td class="col-last-played" data-timestamp="${player.lastPlayedAt || 0}">-</td>
    </tr>
  `;
}

export async function runCompile(db?: JsonDatabase): Promise<void> {
  if (!db) {
    db = new JsonDatabase();
    await db.load();
  }

  // Automatically merge any temporary scraped matches before calculations
  const crawler = new Aoe2InsightsScraper(db);
  await crawler.mergeScrapedData();

  console.log(`Loaded matches count: ${db.getMatchesCount()}`);
  const matches = db.getMatches();

  const minGames = 15;
  const kFactor = 32;

  const calculator = new EloCalculator({
    kFactor,
    minGamesForLeaderboard: minGames
  });

  // Compute 10x3x rating list
  const matches3x = matches.filter(m => m.description?.toLowerCase().includes('3x'));
  const ratings3x = calculator.calculate(matches3x);
  const leaderboard3x = calculator.getLeaderboard(ratings3x, false);

  // Compute Pure 10x rating list
  const matchesPure = matches.filter(m => {
    const desc = m.description?.toLowerCase() || '';
    return desc.includes('10x') && !desc.includes('3x');
  });
  const ratingsPure = calculator.calculate(matchesPure);
  const leaderboardPure = calculator.getLeaderboard(ratingsPure, false);

  // Compute Combined rating list
  const ratingsCombined = calculator.calculate(matches);
  const leaderboardCombined = calculator.getLeaderboard(ratingsCombined, false);

  // Decorate leaderboard entries with country metadata from database profiles
  const populateCountries = (list: EloRanking[]) => {
    for (const p of list) {
      p.country = resolveMergedCountry(p, (id) => db.getProfile(id));
    }
  };
  populateCountries(leaderboard3x);
  populateCountries(leaderboardPure);
  populateCountries(leaderboardCombined);

  // Generate flags.css dynamically
  const uniqueCountries = new Set<string>();
  const collectCountries = (list: EloRanking[]) => {
    for (const p of list) {
      if (p.country && p.country !== 'Unknown' && p.country.trim().length === 2) {
        uniqueCountries.add(p.country.toLowerCase());
      }
    }
  };
  collectCountries(leaderboard3x);
  collectCountries(leaderboardPure);
  collectCountries(leaderboardCombined);

  const outputDir = path.join(process.cwd(), 'dist');
  const playersDir = path.join(outputDir, 'data', 'players');
  await fs.mkdir(playersDir, { recursive: true });

  const flagsCssContent = Array.from(uniqueCountries)
    .sort()
    .map(cc => `.alias-name[data-country="${cc}"]::before { background-image: url('https://flagcdn.com/16x12/${cc}.png'); }`)
    .join('\n');
  await fs.writeFile(path.join(outputDir, 'flags.css'), flagsCssContent);

  // Copy style.css, .nojekyll, and CNAME from web/ to dist/
  await fs.copyFile(
    path.join(process.cwd(), 'web', 'style.css'),
    path.join(outputDir, 'style.css')
  );
  await fs.copyFile(
    path.join(process.cwd(), 'web', '.nojekyll'),
    path.join(outputDir, '.nojekyll')
  );
  await fs.copyFile(
    path.join(process.cwd(), 'web', 'CNAME'),
    path.join(outputDir, 'CNAME')
  );

  // Copy matches.json and profiles.json from data/ to dist/data/
  await fs.copyFile(
    path.join(process.cwd(), 'data', 'matches.json'),
    path.join(outputDir, 'data', 'matches.json')
  );
  await fs.copyFile(
    path.join(process.cwd(), 'data', 'profiles.json'),
    path.join(outputDir, 'data', 'profiles.json')
  );

  // Read Template
  const templatePath = path.join(process.cwd(), 'web', 'index.template.html');
  const templateHtml = await fs.readFile(templatePath, 'utf-8');

  const lastMatchTime = matches.reduce((max, m) => Math.max(max, m.startgametime || 0), 0);
  const updatedAt = lastMatchTime > 0 ? lastMatchTime * 1000 : Date.now();
  const updatedAtFormatted = new Date(updatedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // Helper to compile one page
  async function compilePage(
    filename: string,
    leaderboard: EloRanking[],
    allCalculatedMatchesCount: number,
    totalPlayers: number,
    activeTab: '3x' | 'pure' | 'combined'
  ) {
    const ratings = leaderboard.map(p => p.rating);
    const minRating = ratings.length > 0 ? Math.min(...ratings) : 1000;
    const maxRating = ratings.length > 0 ? Math.max(...ratings) : 1000;
    const eloRange = ratings.length > 0 ? `${minRating} - ${maxRating}` : '-';

    const maxSingleRecord = Math.max(...leaderboard.map(p => Math.max(p.wins, p.losses))) || 1;

    const activeCutoff = lastMatchTime - 180 * 24 * 60 * 60;
    const activeCount = leaderboard.filter(p => (p.lastPlayedAt || 0) >= activeCutoff).length;

    let rowsHtml = '';
    if (leaderboard.length === 0) {
      rowsHtml = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 3rem;">No active players currently qualified.</td></tr>`;
    } else {
      rowsHtml = leaderboard.map((p, idx) => generateRowHtml(p, idx + 1, maxSingleRecord, activeCutoff)).join('\n');
    }

    let compiled = templateHtml
      .replace('{{matchesCount}}', allCalculatedMatchesCount.toLocaleString())
      .replace('{{playersCount}}', activeCount.toLocaleString())
      .replace('{{eloRange}}', eloRange)
      .replace('{{updatedAt}}', updatedAt.toString())
      .replace('{{updatedAtFormatted}}', updatedAtFormatted)
      .replace('{{tabActive3x}}', activeTab === '3x' ? 'active' : '')
      .replace('{{tabActivePure}}', activeTab === 'pure' ? 'active' : '')
      .replace('{{tabActiveCombined}}', activeTab === 'combined' ? 'active' : '')
      .replace('<!-- LEADERBOARD_ROWS -->', rowsHtml);

    const outputPath = path.join(outputDir, filename);
    await fs.writeFile(outputPath, compiled, 'utf-8');
    console.log(`Saved pre-rendered static page: ${outputPath}`);
  }

  // Compile individual pages
  await compilePage('index.html', leaderboard3x, matches3x.length, Object.keys(ratings3x).length, '3x');
  await compilePage('pure.html', leaderboardPure, matchesPure.length, Object.keys(ratingsPure).length, 'pure');
  await compilePage('combined.html', leaderboardCombined, matches.length, Object.keys(ratingsCombined).length, 'combined');

  // Write player detail files for all leaderboard active players to prevent memory leaks
  const activePlayersMap = new Map<number, EloRanking>();
  for (const p of leaderboard3x) activePlayersMap.set(p.profile_id, p);
  for (const p of leaderboardPure) activePlayersMap.set(p.profile_id, p);
  for (const p of leaderboardCombined) activePlayersMap.set(p.profile_id, p);

  console.log(`Writing detail JSONs for ${activePlayersMap.size} unique active players...`);
  
  for (const p of activePlayersMap.values()) {
    const playerFile = path.join(playersDir, `${p.profile_id}.json`);
    const details = {
      profile_id: p.profile_id,
      alias: p.alias,
      rating: p.rating,
      wins: p.wins,
      losses: p.losses,
      gamesCount: p.gamesCount,
      winRate: p.winRate,
      lastPlayedAt: p.lastPlayedAt,
      country: p.country,
      merged_ids: p.merged_ids || [],
      ratingHistory: downsampleHistory(p.ratingHistory || [1000, p.rating]),
      recentMatches: p.recentMatches || []
    };
    await fs.writeFile(playerFile, JSON.stringify(details, null, 2), 'utf-8');
  }

  console.log('Generating civilization winrate reports...');
  await generateCivWinratesReport(db);

  console.log('Compilation success!');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runCompile().catch(console.error);
}
