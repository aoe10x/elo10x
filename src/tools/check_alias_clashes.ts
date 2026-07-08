import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const jsonPath = path.join(process.cwd(), 'docs', 'data', 'leaderboard_combined.json');
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const players = data.players;

  const aliasMap = new Map<string, number[]>();
  for (const p of players) {
    if (!aliasMap.has(p.alias)) {
      aliasMap.set(p.alias, []);
    }
    aliasMap.get(p.alias)!.push(p.profile_id);
  }

  console.log('--- Alias Clashes (Same alias, different profile IDs) ---');
  let count = 0;
  for (const [alias, ids] of aliasMap.entries()) {
    if (ids.length > 1) {
      console.log(`Alias: "${alias}" -> Profile IDs: ${ids.join(', ')}`);
      count++;
    }
  }
  console.log(`Total clashes: ${count}`);
}

main().catch(console.error);
