import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type Metrics = {
  parser: 'mgz' | 'aoe2rec';
  attemptedByImporter: number;
  successfulLogged: number;
  alreadyExistsSkips: number;
  fingerprintDuplicateSkips: number;
  parseFailures: number;
  newImportsSummary: number;
};

function extractMetrics(parser: 'mgz' | 'aoe2rec', log: string): Metrics {
  const attemptedByImporter = Number((log.match(/Need to process\s+(\d+)\s+new replay file\(s\)/)?.[1] ?? '0'));
  const newImportsSummary = Number((log.match(/Database saved with\s+(\d+)\s+new match\(es\)/)?.[1] ?? '0'));

  return {
    parser,
    attemptedByImporter,
    successfulLogged: (log.match(/Successfully parsed, and logged 10x match/g) ?? []).length,
    alreadyExistsSkips: (log.match(/already exists in database/g) ?? []).length,
    fingerprintDuplicateSkips: (log.match(/Skipping duplicate-equivalent replay/g) ?? []).length,
    parseFailures: (log.match(/\[Skip\] Failed to process replay/g) ?? []).length,
    newImportsSummary,
  };
}

function createMarkdownReport(mgz: Metrics, aoe: Metrics): string {
  const lines: string[] = [];
  lines.push('# Full Local Reimport Comparison');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | mgz | aoe2rec |');
  lines.push('|---|---:|---:|');
  lines.push(`| attemptedByImporter | ${mgz.attemptedByImporter} | ${aoe.attemptedByImporter} |`);
  lines.push(`| successfulLogged | ${mgz.successfulLogged} | ${aoe.successfulLogged} |`);
  lines.push(`| alreadyExistsSkips | ${mgz.alreadyExistsSkips} | ${aoe.alreadyExistsSkips} |`);
  lines.push(`| fingerprintDuplicateSkips | ${mgz.fingerprintDuplicateSkips} | ${aoe.fingerprintDuplicateSkips} |`);
  lines.push(`| parseFailures | ${mgz.parseFailures} | ${aoe.parseFailures} |`);
  lines.push(`| newImportsSummary | ${mgz.newImportsSummary} | ${aoe.newImportsSummary} |`);
  lines.push('');
  lines.push('## Readout');
  lines.push('');
  lines.push(`- mgz successful imports: ${mgz.successfulLogged}`);
  lines.push(`- aoe2rec successful imports: ${aoe.successfulLogged}`);
  lines.push(`- mgz parse failures: ${mgz.parseFailures}`);
  lines.push(`- aoe2rec parse failures: ${aoe.parseFailures}`);
  lines.push(`- mgz net new imports summary: ${mgz.newImportsSummary}`);
  lines.push(`- aoe2rec net new imports summary: ${aoe.newImportsSummary}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const aoeLogPath = path.join(repoRoot, 'data', 'full_local_reimport_aoe2rec.log');
  const mgzLogPath = path.join(repoRoot, 'data', 'full_local_reimport_mgz.log');
  const outDir = path.join(repoRoot, 'scratch', 'results', 'parser-compare');

  const [aoeLog, mgzLog] = await Promise.all([
    fs.readFile(aoeLogPath, 'utf-8'),
    fs.readFile(mgzLogPath, 'utf-8'),
  ]);

  const aoe = extractMetrics('aoe2rec', aoeLog);
  const mgz = extractMetrics('mgz', mgzLog);

  const payload = {
    generatedAt: new Date().toISOString(),
    logs: {
      aoe2rec: 'data/full_local_reimport_aoe2rec.log',
      mgz: 'data/full_local_reimport_mgz.log',
    },
    metrics: { mgz, aoe2rec: aoe },
  };

  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `full-reimport-compare-${stamp}.json`);
  const mdPath = path.join(outDir, `full-reimport-compare-${stamp}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.writeFile(mdPath, createMarkdownReport(mgz, aoe), 'utf-8');

  console.log('Full reimport comparison generated.');
  console.log(`JSON: ${path.relative(repoRoot, jsonPath).replace(/\\/g, '/')}`);
  console.log(`Markdown: ${path.relative(repoRoot, mdPath).replace(/\\/g, '/')}`);
  console.log(JSON.stringify(payload.metrics, null, 2));
}

main().catch((err) => {
  console.error('summarize_full_reimport_compare failed:', err);
  process.exit(1);
});
