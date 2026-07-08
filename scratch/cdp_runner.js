/**
 * cdp_runner.js — per-player streaming scraper via Runtime.addBinding
 *
 * Streams each player's matches to Node immediately after scraping,
 * so a page navigation/crash loses at most ONE player's data.
 *
 * Node accumulates all player batches for a chunk and writes the full
 * chunk file when the chunk's "done" signal arrives.
 *
 * Usage:
 *   node scratch/cdp_runner.js [startChunk] [endChunk]
 *
 * Chunks already on disk are skipped automatically.
 *
 * Chunk→Player mapping (20 players/chunk):
 *   Chunk 1  = players 1-20    (tier 1, 80 pages max)
 *   Chunk 2  = players 21-40   (tier 1)
 *   Chunk 3  = players 41-60   (tier 1)
 *   Chunk 4  = players 61-80   (tier 1)
 *   Chunk 5  = players 81-100  (tier 1)
 *   Chunk 6+ = tier 2 players  (30 pages max)
 */

import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';

const START_CHUNK    = parseInt(process.argv[2] ?? '1', 10);
const END_CHUNK      = parseInt(process.argv[3] ?? '20', 10);
const TARGET_HOST    = '127.0.0.1:9222';
const BINDING_NAME   = 'streamPlayer'; // fires per player, not per chunk
const MANIFEST_PATH  = 'docs/data/crawl_manifest.json';
const TWO_YEARS_SECS = 2 * 365 * 24 * 3600;

// Load crawl manifest (per-player last-crawled timestamps)
let crawlManifest = {};
try {
  crawlManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  console.log(`[RUNNER] Loaded crawl manifest (${Object.keys(crawlManifest).length} players).`);
} catch(e) {
  console.log('[RUNNER] No crawl manifest found — will do full 2yr crawl for all players.');
}

const TIER1 = [3131673,2927513,695339,629925,12470113,12367371,17046544,2593089,5097015,2286522,9044833,1652676,476237,1712603,788484,1995208,12406329,522674,5344786,585864,15635878,834610,4227643,2926078,18908832,10012024,15734281,1726859,3358405,214405,355073,476764,621998,8510385,614168,5923657,227734,5815375,2936511,214027,2217383,853127,6419621,2119734,12732548,5409733,209858,12348768,277769,4565640,424184,235753,1575392,575054,1936696,446697,9598123,12872489,3396966,8037742,5077221,5451824,990684,6424607,13365498,217740,6487982,2385999,12412824,387674,13162446,390936,10768717,4586242,1099349,11704127,11257547,13213207,11663842,2751899,866857,426256,25438100,1849427,5055341,5892234,1978798,11667445,11279899,810381,1522990,24300464,2542625,229625,6686970,7648000,286336,2111578,9650928,17714652];
const TIER2 = [4254415,10149813,2356812,2167362,9195288,11382116,9496682,274205,779008,1345336,2565452,875722,299920,23538680,479514,364711,210702,396939,6410511,4009146,12997473,5115142,121936,289569,11699328,114625,10084147,318571,12664843,6634674,259404,3306782,5647686,12576991,306115,1767105,2800515,232606,2456567,11676742,9437235,3205414,13199953,12311790,12708471,1871942,12284292,17584382,12610847,370633,1115953,534022,11881836,1518715,6902491,1950569,12732909,244867,2622923,9159572,2983594,4767764,9723744,2387925,589142,2175202,2904011,360024,10500329,1856612,4603619,2060232,2167762,375711,12619163,11893926,204732,395812,806398,1975935,11811811,9399777,4933469,9391326,242461,2392026,1275319,404483,1863797,2869967,217165,646936,5231827,4750252,1820479,5658404,21357458,1802546,490967,2443824,1261033,3837994,3229728,11723377,13414701,12495723,278169,1061585,782537,401874,2583839,1052886,3635145,13661470,4361764,310310,5337523,711824,12177188,4032528,1496212,1279406,14667287,1516635,12301194,4250692,13050928,12717940,12325571,263390,12628022,2071982,838380,2984097,820921,1504925,4433446,6820724,8818274,3009689,2387444,286202,23939720,3549433,1699469,333935,3813755,1589318,1513413,21460158,3432985,2435210,3600092,4662409,5744693,2949734,5370428,405729,2461893,3545284,3966744,2581910,12544802,13215087,2161095,2940742,3301901,493653,224919,12888703,1222915,5719267,426598,22816054,6141894,13513930,4293979,13372827,13252771,314354,1859831,14768568,12703635,2412823,2894821,4611608,12544606,4474118,11765364,531247,11855997,13076760,4050639,1705772,6170317,12293781,4987337,4534478,288698,6495562,12842647,5644849,817292,496963,284148,609344,680839,278386,6746583,12321559,4832580,3786216,5083197,535465,7705834,12318486,3107781,834862,1772636,1170448,3137554,357877,1700069,259878,12470981,312003,10828901,799587,2473696,5884675,959452,1696986,332951,2912297,13388218,1437010,2715643,3309404,227280,23719467,1026130,2421889,11693822,12400252,12464607,965542,64605,2778745,3046506,13616675,6862891,219936,14958825,9835833,6509793,1523130,914034,13053538,772327,495646,8849657,5254390,722436,9443938,4771820,1108145,12665848,1175691,10733016,1954623,11379626,5251596,210321,2527343,12719478,327765,9892065,12891641,5789524,12215755,317071,1373813,2149004,8024487,14501294,566911,9625486,3408486,2502260,9954258,4160243,11353750,1753972,25190560,3918958,2981378,5235689,3458679,343244,1936639];

// ─── Browser script ────────────────────────────────────────────────────────

function buildBrowserScript(startChunk, endChunk, tier1, tier2, bindingName, playerCutoffs) {
  return `
(function() {
  const START_CHUNK  = ${startChunk};
  const END_CHUNK    = ${endChunk};
  const TIER1        = ${JSON.stringify(tier1)};
  const TIER2        = ${JSON.stringify(tier2)};
  const STREAM       = '${bindingName}';
  const CHUNK_SIZE   = 20;
  const CONCURRENCY  = 2;
  const TWO_YEARS    = Math.round(Date.now()/1000) - 2*365*24*3600;
  // Per-player cutoff times (from crawl manifest). Falls back to TWO_YEARS.
  const PLAYER_CUTOFFS = ${JSON.stringify(playerCutoffs)};
  const delay        = ms => new Promise(r => setTimeout(r, ms));

  const players = [
    ...TIER1.map(id => ({ id, limit: 80, tier: 1 })),
    ...TIER2.map(id => ({ id, limit: 30, tier: 2 }))
  ];

  window.scrapeProgress = { currentChunk: 0, totalChunks: END_CHUNK, status: 'running' };
  let rateLimited = false;

  async function safeFetch(url) {
    while (rateLimited) await delay(1000);
    try {
      const res = await fetch(url);
      if (res.status === 403 || res.status === 429) {
        if (!rateLimited) {
          rateLimited = true;
          console.warn('[CRAWL] Rate limited! Cooling 30s...');
          setTimeout(() => { rateLimited = false; console.log('[CRAWL] Resuming...'); }, 30000);
        }
        await delay(30500);
        return safeFetch(url);
      }
      return res;
    } catch(e) { await delay(5000); return safeFetch(url); }
  }

  async function scrapePlayer(id, limit) {
    const matches = [];
    // Use per-player cutoff from manifest, fall back to 2yr window
    const STOP_TIME = PLAYER_CUTOFFS[id] ?? TWO_YEARS;
    const isIncremental = !!PLAYER_CUTOFFS[id];
    if (isIncremental) console.log('[CRAWL] Player ' + id + ' incremental — stopping at ' + new Date(STOP_TIME*1000).toISOString().slice(0,10));
    let hitLimit = false;
    for (let page = 1; page <= limit; page++) {
      const res = await safeFetch('/user/' + id + '/matches/?page=' + page);
      if (!res.ok) { if (res.status === 404) break; continue; }
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const tiles = doc.querySelectorAll('.match-tile');
      if (!tiles.length) break;
      let pageHitLimit = false;
      tiles.forEach(tile => {
        try {
          const a = tile.querySelector('header.match-title a');
          if (!a) return;
          const matchId = parseInt(a.href.match(/\\/match\\/(\\d+)\\/$/)[1], 10);
          const mapEl   = tile.querySelector('.match-map');
          const mapname = mapEl ? mapEl.innerText.replace('Custom','').trim() : '';
          const metas   = tile.querySelectorAll('.match-meta div');
          let duration  = 0;
          if (metas[0]) {
            const m = metas[0].innerText.trim().match(/(\\d+)m\\s*(\\d+)s/);
            if (m) duration = parseInt(m[1])*60 + parseInt(m[2]);
          }
          let startgametime = 0;
          if (metas[1]) {
            const span = metas[1].querySelector('span[title]');
            if (span) {
              const clean = span.getAttribute('title').replace(/\\./g,'').replace(/\\xa0/g,' ').trim();
              startgametime = Math.round(Date.parse(clean)/1000);
            }
          }
          if (startgametime > 0 && startgametime < STOP_TIME) pageHitLimit = true;
          const pls = [];
          tile.querySelectorAll('.teams .team').forEach((team, ti) => {
            const won = team.classList.contains('won');
            team.querySelectorAll('.players li').forEach(li => {
              const pa  = li.querySelector('a[href^="/user/"]');
              const civ = li.querySelector('.image-icon');
              if (pa) pls.push({
                profile_id: parseInt(pa.href.match(/\\/user\\/(\\d+)\\/$/)[1], 10),
                teamid: ti, resulttype: won ? 1 : 0,
                civName: civ ? civ.title.toLowerCase().trim() : '',
                alias: pa.innerText.trim()
              });
            });
          });
          matches.push({ id: matchId, mapname, maxplayers: 8, matchtype_id: 0,
            description: a.innerText.trim(), startgametime,
            completiontime: startgametime + duration, players: pls,
            source: 'aoe2insights_scrape' });
        } catch(e) {}
      });
      if (pageHitLimit) {
        hitLimit = true;
        console.log('[CRAWL] Player ' + id + ' hit cutoff at page ' + page + (isIncremental ? ' (incremental)' : ' (2yr limit)'));
        break;
      }
      await delay(220);
    }
    // Compute oldest match time
    let oldestTime = null;
    for (const m of matches) {
      if (m.startgametime > 0 && (oldestTime === null || m.startgametime < oldestTime)) {
        oldestTime = m.startgametime;
      }
    }
    return { matches, hitDepthLimit: hitLimit, oldestMatchTime: oldestTime };
  }

  const chunks = [];
  for (let i = 0; i < players.length; i += CHUNK_SIZE) chunks.push(players.slice(i, i+CHUNK_SIZE));

  (async () => {
    console.log('[CRAWL] Chunks ' + START_CHUNK + '-' + END_CHUNK);
    for (let ci = START_CHUNK-1; ci < Math.min(END_CHUNK, chunks.length); ci++) {
      const chunkId = ci+1;
      window.scrapeProgress.currentChunk = chunkId;
      console.log('[CRAWL] Chunk ' + chunkId + ' starting...');

      const queue = [...chunks[ci]];
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          console.log('[CRAWL] -> player ' + p.id + ' (tier ' + p.tier + ')');
          const { matches, hitDepthLimit, oldestMatchTime } = await scrapePlayer(p.id, p.limit);
          // Stream this player's data immediately to Node
          window[STREAM](JSON.stringify({
            type: 'player',
            chunkId,
            playerId: p.id,
            tier: p.tier,
            pageLimit: p.limit,
            matchCount: matches.length,
            hitDepthLimit,
            oldestMatchTime,
            matches
          }));
          console.log('[CRAWL] streamed player ' + p.id + ' (' + matches.length + ' matches, incremental: ' + !!PLAYER_CUTOFFS[p.id] + ')');
        }
      };

      await Promise.all(Array.from({length: CONCURRENCY}, () => worker()));

      // Signal chunk done
      window[STREAM](JSON.stringify({ type: 'chunkDone', chunkId }));
      console.log('[CRAWL] Chunk ' + chunkId + ' signaled done. Cooling 3s...');
      await delay(3000);
    }
    window.scrapeProgress.status = 'completed';
    window[STREAM](JSON.stringify({ type: 'allDone' }));
    console.log('[CRAWL] All done!');
  })();

  return { status: 'spawned', startChunk: START_CHUNK, endChunk: END_CHUNK };
})()
`;
}

// ─── CDP WebSocket ─────────────────────────────────────────────────────────

let ws;
let msgId = 1;
const pending      = new Map();
const eventHandlers = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function on(method, handler) { eventHandlers.set(method, handler); }

async function connectChrome() {
  let tabs;
  try {
    const resp = await fetch(`http://${TARGET_HOST}/json`);
    tabs = await resp.json();
  } catch(e) {
    throw new Error(`Cannot reach Chrome at ${TARGET_HOST}. Is Chrome running with --remote-debugging-port=9222?`);
  }
  const tab = tabs.find(t => t.url?.includes('aoe2insights.com') && t.webSocketDebuggerUrl);
  if (!tab) {
    console.error('\nAvailable tabs:');
    tabs.forEach(t => console.error('  -', t.url));
    throw new Error('No aoe2insights.com tab found — open it in Chrome first!');
  }
  console.log(`[RUNNER] Tab: ${tab.title}`);
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', e => rej(new Error(`WS error: ${e.message ?? e}`)));
  });
  ws.addEventListener('message', evt => {
    const msg = JSON.parse(evt.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    if (msg.method) {
      const h = eventHandlers.get(msg.method);
      if (h) h(msg.params);
    }
  });
}

// ─── Per-player accumulator ─────────────────────────────────────────────────

// chunkBuffers[chunkId] = array of all matches received so far
const chunkBuffers = {};

async function handleMessage(payload) {
  const msg = JSON.parse(payload);

  if (msg.type === 'player') {
    const { chunkId, playerId, matchCount, matches, tier, pageLimit, hitDepthLimit, oldestMatchTime } = msg;
    if (!chunkBuffers[chunkId]) chunkBuffers[chunkId] = [];
    chunkBuffers[chunkId].push(...matches);
    console.log(`[RUNNER] player ${playerId} → ${matchCount} matches (chunk ${chunkId} running total: ${chunkBuffers[chunkId].length})`);

    // Update crawl manifest for this player immediately
    const nowSecs = Math.round(Date.now() / 1000);
    if (!crawlManifest[playerId]) crawlManifest[playerId] = {};
    crawlManifest[playerId].insights = {
      last_crawled_at:   nowSecs,
      chunk_id:          chunkId,
      tier:              tier,
      page_limit:        pageLimit,
      raw_match_count:   matchCount,
      oldest_match_time: oldestMatchTime,
      hit_depth_limit:   hitDepthLimit ?? false,
    };
    // Write manifest to disk after every player (cheap — it's small)
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(crawlManifest, null, 2), 'utf-8');
  }

  if (msg.type === 'chunkDone') {
    const { chunkId } = msg;
    const matches = chunkBuffers[chunkId] ?? [];
    const outPath = `scratch/deep_chunk_${chunkId}.json`;
    await fs.writeFile(outPath, JSON.stringify(matches), 'utf-8');
    console.log(`[RUNNER] ✅ Chunk ${chunkId} saved → ${outPath} (${matches.length} total matches)`);
    delete chunkBuffers[chunkId];
  }

  if (msg.type === 'allDone') {
    console.log('[RUNNER] 🎉 All chunks complete!');
    ws.close();
    process.exit(0);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Report skippable chunks
  const skip = [];
  for (let c = START_CHUNK; c <= END_CHUNK; c++) {
    if (existsSync(`scratch/deep_chunk_${c}.json`)) skip.push(c);
  }
  if (skip.length) {
    console.log(`[RUNNER] Already on disk (will overwrite): chunks ${skip.join(', ')}`);
  }

  await connectChrome();
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: BINDING_NAME });
  console.log(`[RUNNER] Binding '${BINDING_NAME}' registered.`);

  on('Runtime.bindingCalled', async ({ name, payload }) => {
    if (name !== BINDING_NAME) return;
    try { await handleMessage(payload); }
    catch(e) { console.error('[RUNNER] Error handling message:', e.message); }
  });

  on('Runtime.consoleAPICalled', ({ args }) => {
    const text = args.map(a => a.value ?? a.description ?? '').join(' ');
    if (text.includes('[CRAWL]')) process.stdout.write(`  [browser] ${text}\n`);
  });

  // Build per-player cutoff map { [profileId]: last_crawled_at }
  // Players not in manifest get no entry → browser falls back to TWO_YEARS
  const playerCutoffs = {};
  const incrementalCount = { yes: 0, no: 0 };
  for (const target of ALL_TARGETS) {
    const entry = crawlManifest[target.id]?.insights;
    if (entry?.last_crawled_at) {
      playerCutoffs[target.id] = entry.last_crawled_at;
      incrementalCount.yes++;
    } else {
      incrementalCount.no++;
    }
  }
  console.log(`[RUNNER] Incremental players: ${incrementalCount.yes}, full crawl: ${incrementalCount.no}`);

  const script = buildBrowserScript(START_CHUNK, END_CHUNK, TIER1, TIER2, BINDING_NAME, playerCutoffs);
  console.log(`[RUNNER] Injecting scraper for chunks ${START_CHUNK}–${END_CHUNK}...`);

  const result = await send('Runtime.evaluate', {
    expression: script,
    returnByValue: true,
    awaitPromise: false
  });

  if (result.exceptionDetails) {
    console.error('[RUNNER] Injection failed:', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    process.exit(1);
  }

  console.log('[RUNNER] Scraper spawned:', JSON.stringify(result.result?.value));
  console.log('[RUNNER] Each player streams to Node immediately. Safe against page navigation after any player completes.\n');

  // Heartbeat
  setInterval(async () => {
    try {
      const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.scrapeProgress)', returnByValue: true });
      const p = JSON.parse(r.result?.value ?? 'null');
      if (p) {
        const buffered = Object.entries(chunkBuffers).map(([k,v]) => `chunk${k}:${v.length}matches`).join(', ') || 'none';
        console.log(`[RUNNER] heartbeat — chunk ${p.currentChunk}/${p.totalChunks} (${p.status}) | buffered: ${buffered}`);
      }
    } catch(e) { /* ignore */ }
  }, 60_000);
}

main().catch(e => { console.error('[RUNNER] Fatal:', e.message); process.exit(1); });
