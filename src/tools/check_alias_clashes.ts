import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (process.argv[1]) {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === currentFilePath || process.argv[1].endsWith('check_alias_clashes.ts')) {
      main().catch(console.error);
    }
  } catch (err) {}
}
