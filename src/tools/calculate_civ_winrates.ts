import { JsonDatabase } from '../db.ts';
import { CIV_NAMES } from '../civ-data.ts';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function generateCivWinratesReport(db: JsonDatabase): Promise<void> {
  const matches = db.getMatches();

  interface CivStats {
    picks: number;
    wins: number;
  }

  const scopes = [
    {
      name: 'All Maps (Combined)',
      filter: () => true,
      id: 'all'
    },
    {
      name: 'Bamboo Nothing_Paren_V4',
      filter: (m: any) => m.mapname === 'Bamboo Nothing_Paren_V4',
      id: 'paren_v4'
    },
    {
      name: 'Bamboo Nothing_Paren_V4_Nohills',
      filter: (m: any) => m.mapname === 'Bamboo Nothing_Paren_V4_Nohills',
      id: 'paren_v4_nohills'
    },
    {
      name: 'Amazon Tunnel',
      filter: (m: any) => m.mapname === 'Amazon Tunnel',
      id: 'amazon_tunnel'
    }
  ];

  let reportMarkdown = `# Civilization Winrate & Balance Report\n\n`;
  reportMarkdown += `*Generated on: ${new Date().toISOString().split('T')[0]}*\n`;
  reportMarkdown += `*Data source: elo10x matches database (${matches.length} total matches)*\n\n`;

  reportMarkdown += `## Table of Contents\n`;
  for (const scope of scopes) {
    const slug = `scope-${scope.name.toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '-')}`;
    reportMarkdown += `- [${scope.name}](#${slug})\n`;
  }
  reportMarkdown += `\n`;

  reportMarkdown += `> [!IMPORTANT]\n`;
  reportMarkdown += `> Civilization data is only available for matches where players uploaded their recorded game files to AoE2Insights, or for matches fetched from the Relic API (past 3 months). Overall, civilization data is available for **12.0%** of all player occurrences in the database. Interpret winrates with caution where sample sizes (drafts) are small.\n\n`;

  for (const scope of scopes) {
    const stats: Record<number, CivStats> = {};
    let totalMatchesInScope = 0;
    let matchesWithCivData = 0;

    for (const m of matches) {
      if (!scope.filter(m)) continue;
      totalMatchesInScope++;

      const hasCivData = m.players && m.players.some((p: any) => p.race_id && p.race_id > 0);
      if (hasCivData) {
        matchesWithCivData++;
      }

      if (m.players) {
        for (const p of m.players) {
          if (p.race_id && p.race_id > 0) {
            if (!stats[p.race_id]) {
              stats[p.race_id] = { picks: 0, wins: 0 };
            }
            stats[p.race_id].picks++;
            if (p.resulttype === 1) {
              stats[p.race_id].wins++;
            }
          }
        }
      }
    }

    reportMarkdown += `## Scope: ${scope.name}\n\n`;
    reportMarkdown += `* **Total Matches on map(s)**: ${totalMatchesInScope}\n`;
    reportMarkdown += `* **Matches with Civilization Data**: ${matchesWithCivData} (${((matchesWithCivData/totalMatchesInScope)*100).toFixed(2)}%)\n\n`;
    reportMarkdown += `| Rank | Civilization | Drafts | Wins | Winrate | Status |\n`;
    reportMarkdown += `| :--- | :--- | :---: | :---: | :---: | :---: |\n`;

    const sortedCivs = Object.entries(stats)
      .map(([id, s]) => ({
        id: parseInt(id, 10),
        name: CIV_NAMES[parseInt(id, 10)] || `Civ ${id}`,
        picks: s.picks,
        wins: s.wins,
        winrate: s.picks > 0 ? (s.wins / s.picks) * 100 : 0
      }))
      // Sort by winrate descending (secondary sort by picks)
      .sort((a, b) => b.winrate - a.winrate || b.picks - a.picks);

    let rank = 1;
    for (const civ of sortedCivs) {
      // Determine balance status indicator based on winrate and sample size
      let status = 'gray';
      if (civ.picks >= 15) {
        if (civ.winrate >= 55) status = '🔴 OP';
        else if (civ.winrate <= 45) status = '🔵 Weak';
        else status = '🟢 Balanced';
      } else {
        status = '⚪ Low Sample';
      }

      reportMarkdown += `| ${rank} | **${civ.name}** | ${civ.picks} | ${civ.wins} | **${civ.winrate.toFixed(2)}%** | ${status} |\n`;
      rank++;
    }
    reportMarkdown += `\n`;
  }

  const reportsDir = path.join(process.cwd(), 'docs', 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  
  const reportPath = path.join(reportsDir, 'civ_winrates.md');
  await fs.writeFile(reportPath, reportMarkdown, 'utf-8');
  console.log(`Report successfully written to: ${reportPath}`);
}

// Standalone execution support
if (process.argv[1]) {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === currentFilePath || process.argv[1].endsWith('calculate_civ_winrates.ts')) {
      const db = new JsonDatabase();
      await db.load();
      await generateCivWinratesReport(db);
    }
  } catch (err) {
    // Ignore URL file:// conversion errors if run in non-standard environments
  }
}
