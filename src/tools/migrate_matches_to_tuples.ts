import { readJsonArrayLines, saveJsonArrayLines } from '../db.ts';
import { matchToTuple, type MatchTuple } from '../matches_tuple.ts';
import type { Match } from '../types.ts';
import * as path from 'node:path';

async function main() {
  const matchesPath = path.join(process.cwd(), 'data', 'matches.json');
  console.log(`Migrating matches at ${matchesPath}...`);

  const tuples: MatchTuple[] = [];
  let count = 0;

  for await (const match of readJsonArrayLines<Match | MatchTuple>(matchesPath)) {
    if (match) {
      if (Array.isArray(match)) {
        // Already a tuple, keep as is
        tuples.push(match);
        count++;
      } else if (match.id) {
        // If it's an old match object, convert to tuple
        tuples.push(matchToTuple(match));
        count++;
      }
    }
  }

  console.log(`Loaded ${count} matches. Saving in tuple format...`);
  await saveJsonArrayLines(matchesPath, tuples);
  console.log(`Migration complete!`);
}

main().catch(console.error);
