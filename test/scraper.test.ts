import { test } from 'node:test';
import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { CIV_NAMES } from '../src/civ-data.ts';
import { getChromePath } from '../src/aoe2insights_scraper.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getAvailableTab(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (res.ok) {
    const targets = await res.json() as any[];
    return targets.find(t => t.type === 'page');
  }
  return null;
}

test('AoE2Insights Scraper - Matches List Parsing', async () => {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'user_matches.html');
  const rawHtml = await fs.readFile(fixturePath, 'utf-8');
  // Strip script tags to prevent ads and tracking scripts from executing and overwriting the DOM
  const fixtureHtml = rawHtml.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Construct CIV_MAP dynamically
  const civMap: Record<string, number> = {};
  for (const [idStr, name] of Object.entries(CIV_NAMES)) {
    const lower = name.toLowerCase().trim();
    civMap[lower] = parseInt(idStr, 10);
    if (lower === 'maya') civMap['mayans'] = parseInt(idStr, 10);
    if (lower === 'hindustanis') civMap['indians'] = parseInt(idStr, 10);
  }

  // Spawn headless Chrome
  const port = 19233;
  const userDataDir = path.join(process.cwd(), '.chrome-user-data-test');
  const chromePath = getChromePath();
  
  const chromeProcess = spawn(chromePath, [
    '--headless',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ]);

  // Wait for Chrome to boot
  let tab = null;
  for (let i = 0; i < 20; i++) {
    await delay(250);
    try {
      tab = await getAvailableTab(port);
      if (tab) break;
    } catch {}
  }

  if (!tab) {
    chromeProcess.kill();
    throw new Error('Failed to launch headless Chrome for testing');
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);

  const sendCdp = (method: string, params: any = {}) => {
    return new Promise<any>((resolve, reject) => {
      const id = Math.floor(Math.random() * 1000000);
      const handler = (event: MessageEvent) => {
        try {
          const res = JSON.parse(event.data.toString());
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            if (res.error) reject(new Error(res.error.message));
            else resolve(res.result);
          }
        } catch {}
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // Wait for WebSocket open
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });

  // Load the HTML fixture into the page
  await sendCdp('Runtime.evaluate', {
    expression: `document.open(); document.write(${JSON.stringify(fixtureHtml)}); document.close();`
  });

  // Poll until elements are found (up to 3 seconds)
  let elementsLoaded = false;
  for (let j = 0; j < 30; j++) {
    const checkRes = await sendCdp('Runtime.evaluate', {
      expression: `!!document.querySelector('.match-tile')`,
      returnByValue: true
    });
    if (checkRes.result?.value) {
      elementsLoaded = true;
      break;
    }
    await delay(100);
  }

  if (!elementsLoaded) {
    console.warn('[WARNING] .match-tile elements not detected via polling, proceeding anyway...');
  }

  // Run the parsing extraction script
  const parseExpression = `
    (() => {
      const CIV_MAP = ${JSON.stringify(civMap)};
      const results = [];
      const tiles = document.querySelectorAll('.match-tile');
      
      tiles.forEach(tile => {
        const matchLink = tile.querySelector('header.match-title a');
        if (!matchLink) return;
        const matchId = parseInt(matchLink.href.match(/\\/match\\/(\\d+)\\//)[1], 10);
        const title = matchLink.innerText.trim();
        const mapEl = tile.querySelector('.match-map');
        const mapname = mapEl ? mapEl.innerText.replace('Custom', '').trim() : '';

        const metaDivs = tile.querySelectorAll('.match-meta div');
        let duration = 0;
        if (metaDivs[0]) {
          const durText = metaDivs[0].innerText.trim();
          const durParts = durText.match(/(\\d+)m\\s*(\\d+)s/);
          if (durParts) {
            duration = parseInt(durParts[1], 10) * 60 + parseInt(durParts[2], 10);
          }
        }

        let startgametime = 0;
        if (metaDivs[1]) {
          const dateSpan = metaDivs[1].querySelector('span[title]');
          if (dateSpan) {
            const dateTitle = dateSpan.getAttribute('title');
            const cleanDateStr = dateTitle.replace(/\\./g, '').replace(/\\xa0/g, ' ').trim();
            startgametime = Math.round(Date.parse(cleanDateStr) / 1000);
          }
        }

        const players = [];
        const teamEls = tile.querySelectorAll('.teams .team');
        teamEls.forEach((teamEl, teamIndex) => {
          const isWin = teamEl.classList.contains('won');
          const playerEls = teamEl.querySelectorAll('.players li');
          playerEls.forEach(playerEl => {
            const a = playerEl.querySelector('a[href^="/user/"]');
            const civIcon = playerEl.querySelector('.image-icon');
            if (a) {
              const profile_id = parseInt(a.href.match(/\\/user\\/(\\d+)\\//)[1], 10);
              const alias = a.innerText.trim();
              const civName = civIcon ? (civIcon.getAttribute('data-tooltip-title') || civIcon.title || '').toLowerCase().trim() : '';
              const civ_id = CIV_MAP[civName] || 0;
              players.push({
                profile_id,
                teamid: teamIndex,
                resulttype: isWin ? 1 : 0,
                civ_id,
                alias
              });
            }
          });
        });

        results.push({
          id: matchId,
          mapname,
          description: title,
          startgametime,
          completiontime: startgametime + duration,
          players
        });
      });

      return results;
    })()
  `;

  const evalRes = await sendCdp('Runtime.evaluate', {
    expression: parseExpression,
    returnByValue: true
  });

  const parsedMatches = evalRes.result?.value as any[];

  // Clean up
  ws.close();
  chromeProcess.kill();
  try {
    await fs.rm(userDataDir, { recursive: true, force: true });
  } catch {}

  // Assertions
  assert.ok(Array.isArray(parsedMatches), 'Parsed matches should be an array');
  assert.ok(parsedMatches.length > 0, 'Should find and parse matches');

  // Verify first match details
  const match = parsedMatches[0];
  assert.ok(match.id > 0, 'Match ID should be positive number');
  assert.ok(match.mapname, 'Map name should not be empty');
  assert.ok(match.players.length > 0, 'Match players should not be empty');

  // Check if civilization data was resolved correctly (not 0)
  for (const player of match.players) {
    assert.ok(player.civ_id > 0, `Player ${player.alias} should have a resolved civilization ID (got ${player.civ_id})`);
    assert.ok(CIV_NAMES[player.civ_id], `Civilization ID ${player.civ_id} should be valid`);
  }

  console.log(`\n✅ Successfully tested matches list parsing. Found ${parsedMatches.length} matches with correct civ data.`);
});
