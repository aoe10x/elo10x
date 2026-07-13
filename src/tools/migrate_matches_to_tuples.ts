import { readJsonArrayLines, saveJsonArrayLines } from '../db.ts';
import { matchToTuple } from '../matches_tuple.ts';
import type { Match } from '../types.ts';
import * as path from 'node:path';

async function main() {
  const matchesPath = path.join(process.cwd(), 'data', 'matches.json');
  console.log(`Migrating matches at ${matchesPath}...`);

  const tuples: any[] = [];
  let count = 0;

  for await (const match of readJsonArrayLines<any>(matchesPath)) {
    if (match && match.id) {
      if (!Array.isArray(match)) {
        // If it's an old match object, convert to tuple
        tuples.push(matchToTuple(match as Match));
      } else {
        // Already a tuple, keep as is
        tuples.push(match);
      }
      count++;
    }
  }

  console.log(`Loaded ${count} matches. Saving in tuple format...`);
  await saveJsonArrayLines(matchesPath, tuples);
  console.log(`Migration complete!`);
}

main().catch(console.error);
