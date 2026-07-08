import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { JsonDatabase } from './db.ts';
import { EloCalculator } from './elo.ts';
import type { EloRanking } from './types.ts';
import { resolveMergedCountry } from './profile_utils.ts';
import { InsightsCrawler } from './insights_crawler.ts';

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
    <div class="sparkline-wrapper" title="Elo trend over last ${lastGames.length} matches (min: ${minVal}, max: ${maxVal}, current: ${lastRating})">
      <svg width="${width}" height="${height}">
        <line x1="${padding}" y1="${y1000.toFixed(1)}" x2="${width - padding}" y2="${y1000.toFixed(1)}" stroke="rgba(255, 255, 255, 0.15)" stroke-width="0.75" stroke-dasharray="1,1" />
        <polyline points="${points}" fill="none" stroke="rgba(255, 255, 255, 0.4)" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${width - padding}" cy="${lastRatingY.toFixed(1)}" r="1.75" fill="#d4af37" />
      </svg>
    </div>
  `;
}

function generateRowHtml(player: EloRanking, rank: number, maxSingleRecord: number): string {
  let rankContent = '';
  if (rank === 1) rankContent = '<span class="rank-badge rank-1">1</span>';
  else if (rank === 2) rankContent = '<span class="rank-badge rank-2">2</span>';
  else if (rank === 3) rankContent = '<span class="rank-badge rank-3">3</span>';
  else rankContent = `<span class="rank-other">${rank}</span>`;

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
  const flagHtml = hasValidCountry 
    ? `<img src="https://flagcdn.com/24x18/${player.country!.toLowerCase()}.png" width="22" height="16" alt="${player.country!.toUpperCase()}" class="flag-icon" title="${escapeHtml(countryName)}">` 
    : `<span class="flag-placeholder">🏳️</span>`;

  const eloDiff = player.rating - 1000;
  const eloBarWidth = Math.min(40, Math.round(Math.abs(eloDiff) * 0.1));
  let eloIndicatorHtml = '';
  if (eloDiff > 0 && eloBarWidth > 0) {
    eloIndicatorHtml = `<div class="elo-bar direction-right" style="width: ${eloBarWidth}px;"></div>`;
  } else if (eloDiff < 0 && eloBarWidth > 0) {
    eloIndicatorHtml = `<div class="elo-bar direction-left" style="width: ${eloBarWidth}px;"></div>`;
  }

  const winRateVal = player.winRate || 50;
  const wrDiff = winRateVal - 50;
  const wrWidth = Math.min(80, Math.round(Math.abs(wrDiff) * 1.6));
  let winrateIndicatorHtml = '';
  if (wrDiff > 0 && wrWidth > 0) {
    winrateIndicatorHtml = `<div class="winrate-indicator-bar direction-right" style="width: ${wrWidth}px;"></div>`;
  } else if (wrDiff < 0 && wrWidth > 0) {
    winrateIndicatorHtml = `<div class="winrate-indicator-bar direction-left" style="width: ${wrWidth}px;"></div>`;
  }

  const winWidth = Math.round((player.wins / maxSingleRecord) * 80);
  const lossWidth = Math.round((player.losses / maxSingleRecord) * 80);
  const sparklineHtml = generateSparkline(player.ratingHistory, player.rating);

  return `
    <tr class="player-row" data-profile-id="${player.profile_id}" data-alias="${escapeHtml(player.alias)}">
      <td class="col-rank">${rankContent}</td>
      <td class="col-alias"><div class="alias-container">${flagHtml}<span class="alias-name" title="${escapeHtml(player.alias)}">${escapeHtml(player.alias)}</span></div></td>
      <td class="col-elo">
        <div class="elo-container">
          <span class="elo-value">${player.rating}</span>
          <div class="elo-bar-wrapper">
            <div class="elo-bar-center">
              ${eloIndicatorHtml}
            </div>
          </div>
        </div>
      </td>
      <td class="col-trend">${sparklineHtml}</td>
      <td class="col-winrate">
        <div class="true-diverging-container" title="${player.wins} wins, ${player.losses} losses (${player.winRate}% win rate over ${player.gamesCount} total games)">
          <div class="losses-side">
            <span class="record-label-losses">${player.losses}L</span>
            <div class="bar-grow-left">
              <div class="table-losses-bar" style="width: ${lossWidth}px;"></div>
            </div>
          </div>
          <div class="center-divider-line">
            ${winrateIndicatorHtml}
          </div>
          <div class="wins-side">
            <div class="bar-grow-right">
              <div class="table-wins-bar" style="width: ${winWidth}px;"></div>
            </div>
            <span class="record-label-wins">${player.wins}W</span>
            <span class="record-winrate-percentage">(${player.winRate}%)</span>
          </div>
        </div>
      </td>
      <td class="col-last-played" data-timestamp="${player.lastPlayedAt || 0}">-</td>
    </tr>
    <tr class="details-row" id="details-row-${player.profile_id}" style="display: none;">
      <td colspan="6" id="details-cell-${player.profile_id}"></td>
    </tr>
  `;
}

async function main() {
  const db = new JsonDatabase();
  await db.load();

  // Automatically merge any temporary scraped matches before calculations
  const crawler = new InsightsCrawler(db);
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

  // Read Template
  const templatePath = path.join(process.cwd(), 'docs', 'index.template.html');
  const templateHtml = await fs.readFile(templatePath, 'utf-8');

  const outputDir = path.join(process.cwd(), 'docs');
  const playersDir = path.join(outputDir, 'data', 'players');
  await fs.mkdir(playersDir, { recursive: true });

  const lastMatchTime = matches.reduce((max, m) => Math.max(max, m.startgametime || 0), 0);
  const updatedAt = lastMatchTime > 0 ? lastMatchTime * 1000 : Date.now();

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

    let rowsHtml = '';
    if (leaderboard.length === 0) {
      rowsHtml = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 3rem;">No active players currently qualified.</td></tr>`;
    } else {
      rowsHtml = leaderboard.map((p, idx) => generateRowHtml(p, idx + 1, maxSingleRecord)).join('\n');
    }

    let compiled = templateHtml
      .replace('{{matchesCount}}', allCalculatedMatchesCount.toLocaleString())
      .replace('{{playersCount}}', leaderboard.length.toLocaleString())
      .replace('{{eloRange}}', eloRange)
      .replace('{{updatedAt}}', updatedAt.toString())
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

  console.log('Compilation success!');
}

main().catch(console.error);
