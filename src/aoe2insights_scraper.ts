import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { spawn } from 'node:child_process';
import type { JsonDatabase } from './db.ts';
import type { Match, PlayerProfile } from './types.ts';
import { CIV_NAMES } from './civ-data.ts';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function getChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fsSync.existsSync(macPath)) return macPath;
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].find(p => fsSync.existsSync(p)) || 'google-chrome';
}

export class Aoe2InsightsScraper {
  private db: JsonDatabase;
  private scrapedDataDir: string;

  constructor(db: JsonDatabase) {
    this.db = db;
    this.scrapedDataDir = path.join(process.cwd(), 'scraped_data');
  }

  /**
   * Launches headful Chrome and waits for the user to solve Cloudflare on aoe2insights.com
   */
  private async launchChromeAndWaitForBypass(port: number, userDataDir: string): Promise<{ wsUrl: string; chromeProcess: any }> {
    const chromePath = getChromePath();
    
    console.log(`[BROWSER] Launching headful Chrome on port ${port}...`);
    const chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://rank.10xshared.com/'
    ]);

    console.log('\n============================================================');
    console.log('1. Click or navigate to aoe2insights.com in the Chrome window.');
    console.log('2. Complete the Cloudflare Turnstile challenge if it appears.');
    console.log('============================================================\n');
    console.log('Polling local debugger targets to detect bypassed AoE2Insights tab...');

    let targetTab: any = null;

    while (true) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        if (res.ok) {
          const targets = await res.json() as any[];
          const aoe2insightsTab = targets.find(t => 
            t.url && 
            t.url.includes('aoe2insights.com') && 
            t.title && 
            t.title.includes('AoE2 Insights') && 
            !t.title.includes('Just a moment') && 
            !t.title.includes('Cloudflare')
          );
          
          if (aoe2insightsTab) {
            targetTab = aoe2insightsTab;
            console.log(`\n🎉 Detected bypassed AoE2Insights tab: ${targetTab.url}`);
            break;
          }
        }
      } catch {}
      await delay(1000);
    }

    console.log('Waiting 3 seconds for page load to fully settle...');
    await delay(3000);

    return {
      wsUrl: targetTab.webSocketDebuggerUrl,
      chromeProcess
    };
  }

  /**
   * Injects a full-screen semi-transparent click-shield overlay to block accidental human interaction during scraping
   */
  private async injectClickShield(sendCdp: (method: string, params?: any) => Promise<any>): Promise<void> {
    const expression = `
      (() => {
        if (document.getElementById('scraping-click-shield')) return;
        const shield = document.createElement('div');
        shield.id = 'scraping-click-shield';
        shield.style.position = 'fixed';
        shield.style.top = '0';
        shield.style.left = '0';
        shield.style.width = '100vw';
        shield.style.height = '100vh';
        shield.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
        shield.style.zIndex = '999999';
        shield.style.display = 'flex';
        shield.style.alignItems = 'center';
        shield.style.justifyContent = 'center';
        shield.style.pointerEvents = 'all';
        shield.innerHTML = '<div style="color: white; font-family: sans-serif; font-size: 20px; font-weight: bold; padding: 15px 30px; background: rgba(0,0,0,0.85); border-radius: 8px; border: 1px solid #444; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">Scraping in progress... Please do not click!</div>';
        document.body.appendChild(shield);
      })()
    `;
    await sendCdp('Runtime.evaluate', { expression });
  }

  /**
   * Scrapes matches for a list of players from AoE2Insights concurrently via a browser-side script
   */
  async scrapePlayersBatch(profileIds: number[], startPage: number = 1, endPage: number = 20): Promise<{ crawled: number; added: number }> {
    if (profileIds.length === 0) return { crawled: 0, added: 0 };

    await fs.mkdir(this.scrapedDataDir, { recursive: true });

    const port = 19222;
    const userDataDir = path.join(process.cwd(), '.chrome-user-data-scraper');
    const { wsUrl, chromeProcess } = await this.launchChromeAndWaitForBypass(port, userDataDir);

    console.log(`Opening WebSocket connection to Chrome tab debugger: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    const bindingName = 'streamScrapeResult';
    let msgId = 1;
    const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

    const sendCdp = (method: string, params: any = {}) => {
      return new Promise<any>((resolve, reject) => {
        const id = msgId++;
        pendingRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const playerCutoffs: Record<number, { newest: number; oldest: number; hasReachedStart: boolean }> = {};
    for (const pid of profileIds) {
      const manifest = this.db.getPlayerManifest(pid);
      playerCutoffs[pid] = {
        newest: manifest?.insights?.newest_match_id || 0,
        oldest: manifest?.insights?.oldest_match_id || 0,
        hasReachedStart: manifest?.insights?.has_reached_start || false
      };
    }

    const script = this.buildBrowserBatchScript(profileIds, startPage, endPage, bindingName, playerCutoffs);

    let livenessTimeout: NodeJS.Timeout;
    const resetLivenessTimer = () => {
      clearTimeout(livenessTimeout);
      livenessTimeout = setTimeout(() => {
        console.error(`\n[SCRAPER] Liveness timeout: No heartbeat or progress received for 45s. Closing connection...`);
        ws.close();
      }, 45000);
    };

    let crawledCount = 0;

    const handleScraperMessage = async (payloadStr: string) => {
      resetLivenessTimer();
      const payload = JSON.parse(payloadStr);

      if (payload.type === 'heartbeat') return;

      if (payload.type === 'player_done') {
        const { playerId, matches, reachedStartOfHistory } = payload;
        crawledCount++;

        // Save raw matches to temporary file under scraped_data/
        const tempFile = path.join(this.scrapedDataDir, `insights_scraped_${playerId}_${Date.now()}.json`);
        await fs.writeFile(tempFile, JSON.stringify({
          playerId,
          matches,
          reachedStartOfHistory
        }, null, 2), 'utf-8');

        const relPath = path.relative(process.cwd(), tempFile);
        const percent = Math.round((crawledCount / profileIds.length) * 100);
        console.log(`[SCRAPER] [Progress: ${crawledCount}/${profileIds.length} (${percent}%)] Received player ${playerId}: ${matches.length} matches. Saved to ${relPath} (reached start: ${reachedStartOfHistory})`);

        // Update Manifest
        const dbMatches = this.db.getMatches().filter(m => m.players.some(p => p.profile_id === playerId));
        const allIds = [...dbMatches.map(m => m.id), ...matches.map((m: any) => m.id)];
        
        let playerNewestId = playerCutoffs[playerId].newest;
        let playerOldestId = playerCutoffs[playerId].oldest;
        if (allIds.length > 0) {
          playerNewestId = Math.max(...allIds);
          playerOldestId = Math.min(...allIds);
        }

        const reachedStart = playerCutoffs[playerId].hasReachedStart || reachedStartOfHistory;

        this.db.updatePlayerManifest(playerId, 'insights', {
          last_crawled_at: Math.round(Date.now() / 1000),
          newest_match_id: playerNewestId,
          oldest_match_id: playerOldestId,
          has_reached_start: reachedStart
        });
      }
    };

    return new Promise<{ crawled: number; added: number }>((resolve, reject) => {
      const cleanupBrowser = async () => {
        chromeProcess.kill();
        try {
          await fs.rm(userDataDir, { recursive: true, force: true });
        } catch {}
      };

      ws.onopen = async () => {
        try {
          resetLivenessTimer();

          console.log(`[SCRAPER] Navigating tab to robots.txt to disable ads & tracking scripts...`);
          await sendCdp('Page.navigate', { url: 'https://www.aoe2insights.com/robots.txt' });
          await delay(2000); // Wait for navigation to settle

          console.log(`[SCRAPER] CDP session opened. Binding '${bindingName}'...`);
          await sendCdp('Runtime.enable');
          await sendCdp('Runtime.addBinding', { name: bindingName });

          console.log(`[SCRAPER] Injecting click shield overlay...`);
          await this.injectClickShield(sendCdp);

          console.log(`[SCRAPER] Injecting batch crawler script for ${profileIds.length} players...`);
          const evalRes = await sendCdp('Runtime.evaluate', {
            expression: script,
            awaitPromise: false,
            returnByValue: true
          });

          if (evalRes.exceptionDetails) {
            clearTimeout(livenessTimeout);
            ws.close();
            await cleanupBrowser();
            reject(new Error(`Injection failed: ${evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text}`));
            return;
          }
          console.log(`[SCRAPER] Batch scraper successfully initialized in Chrome tab.`);
        } catch (err) {
          clearTimeout(livenessTimeout);
          ws.close();
          await cleanupBrowser();
          reject(err);
        }
      };

      ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data.toString());
          if (response.id !== undefined && pendingRequests.has(response.id)) {
            const { resolve: res, reject: rej } = pendingRequests.get(response.id)!;
            pendingRequests.delete(response.id);
            if (response.error) rej(new Error(response.error.message));
            else res(response.result);
          }

          if (response.method === 'Runtime.bindingCalled') {
            const { name, payload } = response.params;
            if (name === bindingName) {
              if (payload === 'ALL_DONE') {
                console.log(`[SCRAPER] Scraper signaled completion of all targets.`);
                clearTimeout(livenessTimeout);
                ws.close();
              } else {
                handleScraperMessage(payload).catch(console.error);
              }
            }
          }

          if (response.method === 'Runtime.consoleAPICalled') {
            const text = response.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ');
            if (text.includes('[BROWSER]')) {
              process.stdout.write(`  [Chrome] ${text}\n`);
            }
          }
        } catch (e: any) {
          console.error(`[SCRAPER] Message processing error:`, e.message);
        }
      };

      ws.onclose = async () => {
        clearTimeout(livenessTimeout);
        await cleanupBrowser();
        console.log(`[SCRAPER] Connection closed. Merging temporary scraped files...`);
        const added = await this.mergeScrapedData();
        await this.db.save(); // Unconditionally save database once after all changes are merged
        resolve({ crawled: crawledCount, added });
      };

      ws.onerror = async (err) => {
        clearTimeout(livenessTimeout);
        await cleanupBrowser();
        reject(err);
      };
    });
  }

  /**
   * Browser-side scraping execution script injected in the Chrome tab
   */
  private buildBrowserBatchScript(
    profileIds: number[],
    startPage: number,
    endPage: number,
    bindingName: string,
    playerCutoffs: Record<number, { newest: number; oldest: number; hasReachedStart: boolean }>
  ): string {
    const civMap: Record<string, number> = {};
    for (const [idStr, name] of Object.entries(CIV_NAMES)) {
      const lower = name.toLowerCase().trim();
      civMap[lower] = parseInt(idStr, 10);
      if (lower === 'maya') civMap['mayans'] = parseInt(idStr, 10);
      if (lower === 'hindustanis') civMap['indians'] = parseInt(idStr, 10);
    }

    return `
      (async () => {
        const profileIds = ${JSON.stringify(profileIds)};
        const startPage = ${startPage};
        const endPage = ${endPage};
        const bindingName = '${bindingName}';
        const playerCutoffs = ${JSON.stringify(playerCutoffs)};
        const CONCURRENCY = 2;

        const delay = ms => new Promise(r => setTimeout(r, ms));
        const stream = (data) => window[bindingName](JSON.stringify(data));

        // Periodical heartbeat liveness signals
        const heartbeatInterval = setInterval(() => {
          stream({ type: 'heartbeat' });
        }, 10000);

        const CIV_MAP = ${JSON.stringify(civMap)};

        let rateLimited = false;
        async function safeFetch(url) {
          while (rateLimited) await delay(1000);
          try {
            const res = await fetch(url);
            if (res.status === 403 || res.status === 429) {
              if (!rateLimited) {
                rateLimited = true;
                console.warn('[BROWSER] Rate limited! Cooling 30s...');
                setTimeout(() => { rateLimited = false; }, 30000);
              }
              await delay(30500);
              return safeFetch(url);
            }
            return res;
          } catch(e) { 
            await delay(5000); 
            return safeFetch(url); 
          }
        }

        async function scrapePlayer(playerId, limit, newestMatchId, oldestMatchId, hasReachedStart) {
          const results = [];
          let reachedStartOfHistory = false;

          for (let page = startPage; page <= limit; page++) {
            try {
               const url = '/user/' + playerId + '/matches/?page=' + page;
              const res = await safeFetch(url);
              if (!res.ok) {
                if (res.status === 404) {
                  reachedStartOfHistory = true;
                }
                break;
              }
              const html = await res.text();
              const doc = new DOMParser().parseFromString(html, 'text/html');
              
              const tiles = doc.querySelectorAll('.match-tile');
              if (tiles.length === 0) {
                reachedStartOfHistory = true;
                break;
              }

              let hitBoundary = false;
              tiles.forEach(tile => {
                if (hitBoundary) return;
                try {
                  const matchLink = tile.querySelector('header.match-title a');
                  if (!matchLink) return;
                  const matchId = parseInt(matchLink.href.match(/\\/match\\/(\\d+)\\//)[1], 10);

                  // Boundary check for overlap (only if we previously reached the start of history)
                  if (hasReachedStart && newestMatchId > 0 && matchId <= newestMatchId && matchId >= oldestMatchId) {
                    hitBoundary = true;
                    hitDepthLimit = false;
                    return;
                  }

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
                    maxplayers: 8,
                    matchtype_id: 0,
                    description: title,
                    startgametime,
                    completiontime: startgametime + duration,
                    players,
                    source: 'aoe2insights_scrape'
                  });
                } catch (e) { }
              });

              if (hitBoundary) {
                reachedStartOfHistory = true;
                break;
              }
              await delay(250);
            } catch (e) {
              console.error('[BROWSER] Error processing page ' + page + ' for player ' + playerId + ':', e.message || e);
              break;
            }
          }
          return { matches: results, reachedStartOfHistory };
        }

        const queue = [...profileIds];
        const worker = async () => {
          while (queue.length > 0) {
            const pid = queue.shift();
            const cutoff = playerCutoffs[pid];
            const limit = cutoff.hasReachedStart ? 1 : endPage;
            
            console.log('[BROWSER] Starting crawl for player ' + pid);
            try {
              const res = await scrapePlayer(pid, limit, cutoff.newest, cutoff.oldest, cutoff.hasReachedStart);
              stream({
                type: 'player_done',
                playerId: pid,
                matches: res.matches,
                reachedStartOfHistory: res.reachedStartOfHistory
              });
              console.log('[BROWSER] Finished crawl for player ' + pid + ' (scraped ' + res.matches.length + ' matches)');
            } catch (err) {
              console.error('[BROWSER] Error crawling player ' + pid + ':', err.message);
            }
            await delay(1000);
          }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
        
        clearInterval(heartbeatInterval);
        window[bindingName]('ALL_DONE');
      })();
    `;
  }

  /**
   * Merges temporary scraped player files from scraped_data/ into the main database
   */
  async mergeScrapedData(): Promise<number> {
    let files: string[];
    try {
      files = await fs.readdir(this.scrapedDataDir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    const insightsFiles = files.filter(f => f.startsWith('insights_scraped_') && f.endsWith('.json'));
    
    if (insightsFiles.length === 0) return 0;

    console.log(`[MERGER] Found ${insightsFiles.length} temporary scraped files to merge.`);

    let addedCount = 0;

    for (const file of insightsFiles) {
      const filePath = path.join(this.scrapedDataDir, file);
      try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const payload = JSON.parse(fileContent);
        const matches = payload.matches || [];

        for (const m of matches) {
          // 1. Must be a 10x lobby
          if (!/10x/i.test(m.description)) continue;

          // 2. Must be exactly 8 players
          if (!m.players || m.players.length !== 8) continue;

          // 3. Must be a 4v4 team game
          const team0 = m.players.filter((p: any) => p.teamid === 0);
          const team1 = m.players.filter((p: any) => p.teamid === 1);
          if (team0.length !== 4 || team1.length !== 4) continue;

          // 4. Duplicate Check & Smart Merge
          const isExisting = this.db.hasMatch(m.id);

          // 5. Build clean Match object
          const matchObj: Match = {
            id: m.id,
            source: 'aoe2insights_scrape',
            mapname: m.mapname,
            maxplayers: 8,
            matchtype_id: 0,
            description: m.description,
            startgametime: m.startgametime || m.completiontime - 1800,
            completiontime: m.completiontime,
            players: m.players.map((p: any) => ({
              profile_id: p.profile_id,
              teamid: p.teamid,
              resulttype: p.resulttype,
              civ_id: p.civ_id || p.race_id || 0,
              alias: p.alias
            }))
          };

          // Update cached profiles
          for (const p of m.players) {
            if (!this.db.getProfile(p.profile_id)) {
              this.db.addProfile({
                profile_id: p.profile_id,
                alias: p.alias || `Player_${p.profile_id}`
              });
            }
          }

          this.db.addMatch(matchObj);
          if (!isExisting) {
            addedCount++;
          }
        }

        // Delete temporary file
        await fs.unlink(filePath);
      } catch (err: any) {
        console.error(`[MERGER] Failed to process/delete file ${file}:`, err.message);
      }
    }

    if (addedCount > 0) {
      console.log(`[MERGER] Successfully merged ${addedCount} new matches into database.`);
    }

    return addedCount;
  }
}
