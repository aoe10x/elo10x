import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getChromePath } from '../aoe2insights_scraper.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ChromeDevToolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function main() {
  const chromePath = getChromePath();
  const userDataDir = path.join(process.cwd(), '.chrome-user-data-fixture');

  console.log('Launching headful Chrome...');
  const chromeProcess = spawn(chromePath, [
    '--remote-debugging-port=19222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://rank.10xshared.com/'
  ]);

  console.log('\n============================================================');
  console.log('1. Click or navigate to aoe2insights.com in the Chrome window.');
  console.log('2. Complete the Cloudflare Turnstile challenge.');
  console.log('3. Navigate to a player matches page OR a specific match page (e.g. /match/484288374/).');
  console.log('============================================================\n');
  console.log('Polling local debugger targets to detect the target page...');

  let targetTab: ChromeDevToolsTarget | null = null;
  let filename = 'user_matches.html';

  while (true) {
    try {
      const res = await fetch('http://127.0.0.1:19222/json');
      if (res.ok) {
        const targets = await res.json() as ChromeDevToolsTarget[];
        // Find tabs that match URL patterns
        const matchesTab = targets.find(t => t.url && t.url.includes('aoe2insights.com/user/') && t.url.includes('/matches'));
        const detailTab = targets.find(t => t.url && t.url.includes('aoe2insights.com/match/'));

        // Helper to check if tab is fully loaded and bypassed Cloudflare
        const isBypassed = (t: ChromeDevToolsTarget) => 
          t.title && 
          t.title.includes('AoE2 Insights') && 
          !t.title.includes('Just a moment') && 
          !t.title.includes('Cloudflare');

        if (matchesTab && isBypassed(matchesTab)) {
          targetTab = matchesTab;
          filename = 'user_matches.html';
          console.log(`\n🎉 Detected target match list page (Bypassed Cloudflare): ${targetTab.url}`);
          break;
        } else if (detailTab && isBypassed(detailTab)) {
          targetTab = detailTab;
          filename = 'match_details.html';
          console.log(`\n🎉 Detected target match details page (Bypassed Cloudflare): ${targetTab.url}`);
          break;
        }
      }
    } catch {}
    await delay(1000);
  }

  console.log('Waiting 3 seconds for page to fully load and settle...');
  await delay(3000);

  console.log('Connecting to tab debugger to extract HTML...');
  if (!targetTab) {
    throw new Error('Target tab is null');
  }
  const wsUrl = targetTab.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);

  const htmlContent = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timeout extracting HTML from target tab'));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: 'document.documentElement.outerHTML' }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        if (data.id === 1 && data.result && data.result.result) {
          clearTimeout(timeout);
          ws.close();
          resolve(data.result.result.value);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      ws.close();
      reject(err);
    };
  });

  // Kill Chrome process
  chromeProcess.kill();

  // Clean up user data dir
  try {
    await fs.rm(userDataDir, { recursive: true, force: true });
  } catch {}

  const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
  const fixturePath = path.join(fixturesDir, filename);
  await fs.writeFile(fixturePath, htmlContent, 'utf-8');

  console.log(`Successfully saved HTML fixture to: ${fixturePath}`);
}

import { fileURLToPath } from 'node:url';

if (process.argv[1]) {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === currentFilePath || process.argv[1].endsWith('download_match_fixture.ts')) {
      main().catch(console.error);
    }
  } catch (err) {}
}
