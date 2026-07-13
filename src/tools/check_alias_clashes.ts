import { JsonDatabase } from '../db.ts';
import { fileURLToPath } from 'node:url';

async function main() {
  const db = new JsonDatabase();
  await db.load();
  const players = db.getAllProfiles();

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
