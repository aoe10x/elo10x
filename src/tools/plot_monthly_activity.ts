import { JsonDatabase } from '../db.ts';

async function main() {
  console.log('Loading database...');
  const db = new JsonDatabase();
  await db.load();

  const matches = db.getMatches();
  console.log(`Loaded ${matches.length} matches.\n`);

  // Group matches by Year-Month
  const monthlyCounts = new Map<string, number>();
  let unknownCount = 0;
  
  for (const m of matches) {
    if (!m.startgametime || m.startgametime < 24 * 3600) {
      unknownCount++;
      continue;
    }
    
    // Convert Unix timestamp to Date object
    const date = new Date(m.startgametime * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const key = `${year}-${month}`;
    
    monthlyCounts.set(key, (monthlyCounts.get(key) || 0) + 1);
  }

  // Sort months chronologically
  const sortedMonths = Array.from(monthlyCounts.keys()).sort();

  if (sortedMonths.length === 0 && unknownCount === 0) {
    console.log('No matches found to plot.');
    return;
  }

  // Find max count for scaling the bar chart
  let maxCount = 0;
  for (const count of monthlyCounts.values()) {
    if (count > maxCount) maxCount = count;
  }
  if (unknownCount > maxCount) maxCount = unknownCount;

  const maxBarLength = 50; // Max characters for the bar
  console.log('============================================================');
  console.log('10X GAME ACTIVITY BY MONTH');
  console.log('============================================================');
  console.log('Month     | Match Count & Activity Bar');
  console.log('----------+-------------------------------------------------');

  for (const monthKey of sortedMonths) {
    const count = monthlyCounts.get(monthKey) || 0;
    const barLength = Math.round((count / maxCount) * maxBarLength);
    const bar = '█'.repeat(barLength);
    
    console.log(`${monthKey}   | ${String(count).padStart(5)} ${bar}`);
  }

  if (unknownCount > 0) {
    const barLength = Math.round((unknownCount / maxCount) * maxBarLength);
    const bar = '█'.repeat(barLength);
    console.log(`Unknown   | ${String(unknownCount).padStart(5)} ${bar}`);
  }
  console.log('============================================================');
  
  const avg = Math.round(matches.length / sortedMonths.length);
  console.log(`Total Matches: ${matches.length}`);
  console.log(`Months Tracked: ${sortedMonths.length}`);
  console.log(`Average Matches/Month: ${avg}`);
}

main().catch(console.error);
