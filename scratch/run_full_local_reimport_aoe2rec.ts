import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

type Metrics = {
  cacheBefore: number;
  cacheAfterClear: number;
  attemptedByImporter: number;
  successfulLogged: number;
  alreadyExistsSkips: number;
  fingerprintDuplicateSkips: number;
  parseFailures: number;
  newImportsSummary: number;
  cacheRestored: boolean;
  logPath: string;
};

async function readJsonArrayLength(filePath: string): Promise<number> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON array`);
  }
  return parsed.length;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const cachePath = path.join(repoRoot, 'data', 'imported_replays.json');
  const backupPath = path.join(repoRoot, 'data', 'imported_replays.fullrun.backup.json');
  const logPath = path.join(repoRoot, 'data', 'full_local_reimport_aoe2rec.log');

  const cacheOriginal = await fs.readFile(cachePath, 'utf-8');
  await fs.writeFile(backupPath, cacheOriginal, 'utf-8');

  const cacheBefore = JSON.parse(cacheOriginal).length;
  await fs.writeFile(cachePath, '[]\n', 'utf-8');
  const cacheAfterClear = await readJsonArrayLength(cachePath);

  const header = [
    `Run started: ${new Date().toISOString()}`,
    `Cache count before clear: ${cacheBefore}`,
    `Cache count after clear: ${cacheAfterClear}`,
    'Parser mode: aoe2rec',
    'Assume 10x when lobby missing: true',
    ''
  ].join('\n');
  await fs.writeFile(logPath, header, 'utf-8');

  let cacheRestored = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', 'src/import_local.ts'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            IMPORT_LOCAL_PARSER: 'aoe2rec',
            IMPORT_LOCAL_ASSUME_10X_WHEN_LOBBY_MISSING: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      const logStreamPromise = fs.open(logPath, 'a');

      const writeChunk = async (chunk: Buffer | string) => {
        const fh = await logStreamPromise;
        await fh.appendFile(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      };

      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        void writeChunk(chunk);
      });

      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        void writeChunk(chunk);
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', async (code) => {
        const fh = await logStreamPromise;
        await fh.close();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`import_local exited with code ${code}`));
        }
      });
    });
  } finally {
    await fs.copyFile(backupPath, cachePath);
    cacheRestored = true;
  }

  const log = await fs.readFile(logPath, 'utf-8');

  const attemptedByImporter = Number((log.match(/Need to process\s+(\d+)\s+new replay file\(s\)/)?.[1] ?? '0'));
  const newImportsSummary = Number((log.match(/Database saved with\s+(\d+)\s+new match\(es\)/)?.[1] ?? '0'));

  const metrics: Metrics = {
    cacheBefore,
    cacheAfterClear,
    attemptedByImporter,
    successfulLogged: (log.match(/Successfully parsed, and logged 10x match/g) ?? []).length,
    alreadyExistsSkips: (log.match(/already exists in database/g) ?? []).length,
    fingerprintDuplicateSkips: (log.match(/Skipping duplicate-equivalent replay/g) ?? []).length,
    parseFailures: (log.match(/\[Skip\] Failed to process replay/g) ?? []).length,
    newImportsSummary,
    cacheRestored,
    logPath: path.relative(repoRoot, logPath).replace(/\\/g, '/'),
  };

  console.log('\n=== FULL REIMPORT METRICS ===');
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((err) => {
  console.error('run_full_local_reimport_aoe2rec failed:', err);
  process.exit(1);
});
