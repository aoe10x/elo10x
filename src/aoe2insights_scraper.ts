import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import type { JsonDatabase } from './db.ts';
import type { Match, PlayerProfile } from './types.ts';

export class Aoe2InsightsScraper {
  private db: JsonDatabase;
  private scrapedDataDir: string;

  constructor(db: JsonDatabase) {
    this.db = db;
    this.scrapedDataDir = path.join(process.cwd(), 'scraped_data');
  }

  /**
   * Discovers the WebSocket debugger URL of the active AoE2Insights tab
   */
  private async discoverCdpUrl(): Promise<string | null> {
    let wsUrl: string | null = null;
    try {
      const browserWsUrl = 'ws://127.0.0.1:9222/devtools/browser';
      const ws = new WebSocket(browserWsUrl);

      const targetList = await new Promise<any[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timeout waiting for Target.getTargets response"));
        }, 3000);

        const cleanup = () => {
          clearTimeout(timeout);
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close();
            }
          } catch (e) {}
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data.toString());
            if (data.id === 1 && data.result && data.result.targetInfos) {
              cleanup();
              resolve(data.result.targetInfos);
            }
          } catch (e) {}
        };

        ws.onerror = (e) => {
          cleanup();
          reject(e);
        };
      });

      const aoe2insightsTab = targetList.find(t => t.type === 'page' && t.url && t.url.includes('aoe2insights.com'));
      if (aoe2insightsTab) {
        wsUrl = `ws://127.0.0.1:9222/devtools/page/${aoe2insightsTab.targetId}`;
      }
    } catch {
      // Fallback to traditional HTTP target list
    }

    if (!wsUrl) {
      try {
        const res = await fetch('http://127.0.0.1:9222/json');
        if (res.ok) {
          const targets = await res.json() as any[];
          const targetTab = targets.find(t => t.url && t.url.includes('aoe2insights.com'));
          if (targetTab) {
            wsUrl = targetTab.webSocketDebuggerUrl;
          }
        }
      } catch {}
    }
    return wsUrl;
  }

  /**
   * Scrapes matches for a list of players from AoE2Insights concurrently via a browser-side script
   */
  async scrapePlayersBatch(profileIds: number[], startPage: number = 1, endPage: number = 20): Promise<{ crawled: number; added: number }> {
    if (profileIds.length === 0) return { crawled: 0, added: 0 };

    await fs.mkdir(this.scrapedDataDir, { recursive: true });

    console.log(`Connecting to local Chrome instance on port 9222...`);
    const wsUrl = await this.discoverCdpUrl();
    if (!wsUrl) {
      throw new Error(
        `Could not find any open Chrome tabs pointing to aoe2insights.com.\n` +
        `Please open Chrome and navigate to any page on https://www.aoe2insights.com/ first.`
      );
    }

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
        const { playerId, matches, hitDepthLimit } = payload;
        crawledCount++;

        console.log(`[SCRAPER] Received player ${playerId}: ${matches.length} matches (depth limit hit: ${hitDepthLimit})`);

        // Save raw matches to temporary file under scraped_data/
        const tempFile = path.join(this.scrapedDataDir, `insights_scraped_${playerId}_${Date.now()}.json`);
        await fs.writeFile(tempFile, JSON.stringify({
          playerId,
          matches,
          hitDepthLimit
        }, null, 2), 'utf-8');

        // Update Manifest
        const dbMatches = this.db.getMatches().filter(m => m.players.some(p => p.profile_id === playerId));
        const allIds = [...dbMatches.map(m => m.id), ...matches.map((m: any) => m.id)];
        
        let playerNewestId = playerCutoffs[playerId].newest;
        let playerOldestId = playerCutoffs[playerId].oldest;
        if (allIds.length > 0) {
          playerNewestId = Math.max(...allIds);
          playerOldestId = Math.min(...allIds);
        }

        const reachedStart = playerCutoffs[playerId].hasReachedStart || !hitDepthLimit;

        this.db.updatePlayerManifest(playerId, 'insights', {
          last_crawled_at: Math.round(Date.now() / 1000),
          newest_match_id: playerNewestId,
          oldest_match_id: playerOldestId,
          has_reached_start: reachedStart
        });

        await this.db.save();
      }
    };

    return new Promise<{ crawled: number; added: number }>((resolve, reject) => {
      ws.onopen = async () => {
        try {
          resetLivenessTimer();
          console.log(`[SCRAPER] CDP session opened. Binding '${bindingName}'...`);
          await sendCdp('Runtime.enable');
          await sendCdp('Runtime.addBinding', { name: bindingName });

          console.log(`[SCRAPER] Injecting batch crawler script for ${profileIds.length} players...`);
          const evalRes = await sendCdp('Runtime.evaluate', {
            expression: script,
            awaitPromise: false,
            returnByValue: true
          });

          if (evalRes.exceptionDetails) {
            clearTimeout(livenessTimeout);
            ws.close();
            reject(new Error(`Injection failed: ${evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text}`));
            return;
          }
          console.log(`[SCRAPER] Batch scraper successfully initialized in Chrome tab.`);
        } catch (err) {
          clearTimeout(livenessTimeout);
          ws.close();
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
        console.log(`[SCRAPER] Connection closed. Merging temporary scraped files...`);
        const added = await this.mergeScrapedData();
        resolve({ crawled: crawledCount, added });
      };

      ws.onerror = (err) => {
        clearTimeout(livenessTimeout);
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

        const CIV_MAP = {
          "britons": 1, "franks": 2, "goths": 3, "teutons": 4, "japanese": 5, "chinese": 6, 
          "byzantines": 7, "persians": 8, "saracens": 9, "turks": 10, "vikings": 11, "mongols": 12, 
          "celts": 13, "spanish": 14, "aztecs": 15, "mayans": 16, "huns": 17, "koreans": 18, 
          "italians": 19, "indians": 20, "hindustanis": 20, "incas": 21, "magyars": 22, "slavs": 23, 
          "portuguese": 24, "ethiopians": 25, "malians": 26, "berbers": 27, "khmer": 28, "malay": 29, 
          "burmese": 30, "vietnamese": 31, "bulgarians": 32, "tatars": 33, "cumans": 34, "lithuanians": 35, 
          "burgundians": 36, "sicilians": 37, "poles": 38, "bohemians": 39, "dravidians": 40, 
          "bengalis": 41, "gurjaras": 42, "romans": 43, "armenians": 44, "georgians": 45,
          "achaemenids": 46, "athenians": 47, "spartans": 48, "shu": 49, "wu": 50, "wei": 51,
          "jurchens": 52, "khitans": 53, "macedonians": 54, "thracians": 55, "puru": 56,
          "muisca": 57, "mapuche": 58, "tupi": 59
        };

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

        async function scrapePlayer(playerId, limit, newestMatchId, oldestMatchId) {
          const results = [];
          let hitDepthLimit = true;

          for (let page = startPage; page <= limit; page++) {
            try {
              const url = '/user/' + playerId + '/matches/?page=' + page;
              const res = await safeFetch(url);
              if (!res.ok) {
                hitDepthLimit = false;
                break;
              }
              const html = await res.text();
              const doc = new DOMParser().parseFromString(html, 'text/html');
              
              const tiles = doc.querySelectorAll('.match-tile');
              if (tiles.length === 0) {
                hitDepthLimit = false;
                break;
              }

              let hitBoundary = false;
              tiles.forEach(tile => {
                if (hitBoundary) return;
                try {
                  const matchLink = tile.querySelector('header.match-title a');
                  if (!matchLink) return;
                  const matchId = parseInt(matchLink.href.match(/\\/match\\/(\\d+)\\//)[1], 10);

                  // Boundary check for overlap
                  if (newestMatchId > 0 && matchId <= newestMatchId && matchId >= oldestMatchId) {
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
                        const civName = civIcon ? civIcon.title.toLowerCase().trim() : '';
                        const race_id = CIV_MAP[civName] || 0;
                        players.push({
                          profile_id,
                          teamid: teamIndex,
                          resulttype: isWin ? 1 : 0,
                          race_id,
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
                break;
              }
              await delay(250);
            } catch (e) {
              hitDepthLimit = false;
              break;
            }
          }
          return { matches: results, hitDepthLimit };
        }

        const queue = [...profileIds];
        const worker = async () => {
          while (queue.length > 0) {
            const pid = queue.shift();
            const cutoff = playerCutoffs[pid];
            const limit = cutoff.hasReachedStart ? 1 : endPage;
            
            console.log('[BROWSER] Starting crawl for player ' + pid);
            try {
              const res = await scrapePlayer(pid, limit, cutoff.newest, cutoff.oldest);
              stream({
                type: 'player_done',
                playerId: pid,
                matches: res.matches,
                hitDepthLimit: res.hitDepthLimit
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
    if (!fsSync.existsSync(this.scrapedDataDir)) return 0;
    
    const files = await fs.readdir(this.scrapedDataDir);
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

          // 4. Duplicate Check
          if (this.db.hasMatch(m.id)) continue;

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
              race_id: p.race_id,
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
          addedCount++;
        }

        // Delete temporary file
        await fs.unlink(filePath);
      } catch (err: any) {
        console.error(`[MERGER] Failed to process/delete file ${file}:`, err.message);
      }
    }

    if (addedCount > 0) {
      await this.db.save();
      console.log(`[MERGER] Successfully merged ${addedCount} new matches into database.`);
    }

    return addedCount;
  }
}
