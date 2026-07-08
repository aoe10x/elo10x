import { promises as fs } from 'node:fs';
import * as path from 'node:path';

async function saveJsonArrayLines<T>(filePath: string, items: T[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  const fd = await fs.open(tempPath, 'w');
  
  // Write array opening
  await fd.write('[\n');
  const len = items.length;
  for (let i = 0; i < len; i++) {
    const isLast = i === len - 1;
    const comma = isLast ? '' : ',';
    await fd.write(`  ${JSON.stringify(items[i])}${comma}\n`);
  }
  // Write array closing
  await fd.write(']\n');
  await fd.close();

  await fs.rename(tempPath, filePath);
}

async function main() {
  const dataDir = path.join(process.cwd(), 'docs', 'data');
  const oldDbPath = path.join(dataDir, 'db.json');

  console.log(`Loading old database from: ${oldDbPath}`);
  const oldDb = JSON.parse(await fs.readFile(oldDbPath, 'utf-8'));

  // 1. Migrate Matches (sorted chronologically)
  const matchesList = Object.values(oldDb.matches || {}).sort((a: any, b: any) => {
    return (a.startgametime || 0) - (b.startgametime || 0);
  });
  const matchesPath = path.join(dataDir, 'matches.json');
  console.log(`Writing ${matchesList.length} matches to: ${matchesPath}`);
  await saveJsonArrayLines(matchesPath, matchesList);

  // 2. Migrate Profiles
  const profilesList = Object.values(oldDb.profiles || {});
  const profilesPath = path.join(dataDir, 'profiles.json');
  console.log(`Writing ${profilesList.length} profiles to: ${profilesPath}`);
  await saveJsonArrayLines(profilesPath, profilesList);

  // 3. Migrate Crawler state
  const crawlState = {
    match_fingerprints: oldDb.match_fingerprints || {},
    crawled_profiles: oldDb.crawled_profiles || {},
    crawl_queue: oldDb.crawl_queue || []
  };
  const crawlStatePath = path.join(dataDir, 'crawl_state.json');
  console.log(`Writing crawler state to: ${crawlStatePath}`);
  await fs.writeFile(crawlStatePath, JSON.stringify(crawlState, null, 2), 'utf-8');

  console.log('\nMigration complete! You can now safely delete the old db.json file.');
}

main().catch(console.error);
