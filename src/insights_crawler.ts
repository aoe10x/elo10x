import { JsonDatabase } from './db.ts';
import type { Match, MatchPlayer } from './types.ts';

export class InsightsCrawler {
  private db: JsonDatabase;

  constructor(db: JsonDatabase) {
    this.db = db;
  }

  /**
   * Scrapes matches for a player from AoE2Insights by executing a scraper script in an open Chrome tab
   * via the Chrome DevTools Protocol.
   */
  async scrapePlayerHistory(profileId: number, startPage: number = 1, endPage: number = 20): Promise<{ scraped: number; added: number }> {
    console.log(`Connecting to local Chrome instance on port 9222...`);
    
    let targets: any[] = [];
    let success = false;
    let lastErrorMsg = "";
    
    const endpoints = [
      'http://127.0.0.1:9222/json',
      'http://127.0.0.1:9222/json/list',
      'http://localhost:9222/json',
      'http://localhost:9222/json/list'
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          targets = await res.json() as any[];
          success = true;
          break;
        } else {
          lastErrorMsg = `HTTP error ${res.status} from ${url}`;
        }
      } catch (e: any) {
        lastErrorMsg = `${e.message} from ${url}`;
      }
    }

    if (!success) {
      throw new Error(
        `Failed to connect to Chrome at http://127.0.0.1:9222/json. \n` +
        `Please ensure Chrome is running with remote debugging enabled. To start it, run:\n` +
        `Start-Process chrome.exe -ArgumentList "--remote-debugging-port=9222"\n` +
        `Original error: ${lastErrorMsg}`
      );
    }

    // Find tab running AoE2Insights
    const targetTab = targets.find(t => t.url && t.url.includes('aoe2insights.com'));
    if (!targetTab) {
      throw new Error(
        `Could not find any open Chrome tabs pointing to aoe2insights.com.\n` +
        `Please open Chrome and navigate to any page on https://www.aoe2insights.com/ first.`
      );
    }

    const wsUrl = targetTab.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error(`Target tab has no webSocketDebuggerUrl. Make sure you don't have multiple DevTools instances debugging it.`);
    }

    console.log(`Found active AoE2Insights tab: "${targetTab.title}"`);
    console.log(`Opening WebSocket connection to Chrome tab debugger...`);

    const ws = new WebSocket(wsUrl);

    const scrapedMatches = await new Promise<any[]>((resolve, reject) => {
      ws.onopen = () => {
        console.log(`Debugger connection established. Injecting scraper script for pages ${startPage} to ${endPage}...`);
        
        // Construct the JS script to evaluate
        const scriptExpression = `
          (async () => {
            const start = ${startPage};
            const end = ${endPage};
            const targetProfile = ${profileId};
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

            const results = [];
            const delay = ms => new Promise(res => setTimeout(res, ms));

            for (let page = start; page <= end; page++) {
              try {
                const url = '/user/' + targetProfile + '/matches/?page=' + page;
                const res = await fetch(url);
                if (!res.ok) continue;
                const html = await res.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                
                doc.querySelectorAll('.match-tile').forEach(tile => {
                  try {
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
                  } catch (e) {
                    // Ignore
                  }
                });
                await delay(150);
              } catch (e) {
                // Ignore page fetch errors
              }
            }
            return results;
          })()
        `;

        // Send evaluation command via Chrome DevTools Protocol
        const command = {
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: scriptExpression,
            awaitPromise: true,
            returnByValue: true
          }
        };
        ws.send(JSON.stringify(command));
      };

      ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data.toString());
          if (response.id === 1) {
            ws.close();
            if (response.error) {
              reject(new Error(`CDP command returned error: ${JSON.stringify(response.error)}`));
            } else if (response.result?.exceptionDetails) {
              reject(new Error(`JS evaluation threw an exception: ${response.result.exceptionDetails.exception.description}`));
            } else {
              resolve(response.result?.result?.value || []);
            }
          }
        } catch (e) {
          reject(e);
        }
      };

      ws.onerror = (err) => {
        reject(new Error(`WebSocket error: ${JSON.stringify(err)}`));
      };

      ws.onclose = () => {
        // Closed cleanly or after error
      };
    });

    console.log(`Scrape finished. Processing and merging ${scrapedMatches.length} raw matches...`);

    let filtered10xCount = 0;
    let addedCount = 0;

    for (const m of scrapedMatches) {
      // 1. Must be a 10x lobby
      if (!/10x/i.test(m.description)) {
        continue;
      }

      // 2. Must be exactly 8 players
      if (!m.players || m.players.length !== 8) {
        continue;
      }

      // 3. Must be a 4v4 team game
      const team0 = m.players.filter((p: any) => p.teamid === 0);
      const team1 = m.players.filter((p: any) => p.teamid === 1);
      if (team0.length !== 4 || team1.length !== 4) {
        continue;
      }

      filtered10xCount++;

      // 4. Duplicate Check
      if (this.db.hasMatch(m.id)) {
        continue;
      }

      // Update cached profiles
      for (const p of m.players) {
        if (!this.db.getProfile(p.profile_id)) {
          this.db.addProfile({
            profile_id: p.profile_id,
            alias: p.alias || `Player_${p.profile_id}`
          });
        }
      }

      // Insert match
      const newMatch: Match = {
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

      this.db.addMatch(newMatch);
      addedCount++;
    }

    if (addedCount > 0) {
      await this.db.save();
    }

    return { scraped: filtered10xCount, added: addedCount };
  }
}
