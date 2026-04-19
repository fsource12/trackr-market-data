#!/usr/bin/env node
/**
 * Trackr Market Scanner v3
 * - Searches by card name + human set name (not internal slugs)
 * - Removes price/name filters on pre-curated list
 * - Accepts any result with price data
 */

const https = require("https");
const fs    = require("fs");

const PT_KEY  = process.env.POKETRACE_KEY;
const PT_BASE = "https://api.poketrace.com/v1";
const DELAY   = 350;

if (!PT_KEY) { console.error("POKETRACE_KEY env var required"); process.exit(1); }

// ── Set code → human name (used in PokeTrace search) ──────────
const SET_NAMES = {
  "sv8pt5":    "Prismatic Evolutions",
  "sv3pt5":    "151",
  "sv8":       "Surging Sparks",
  "swsh7":     "Evolving Skies",
  "sv9":       "Mega Evolution",
  "sv9pt5":    "Ascended Heroes",
  "sv10":      "Perfect Order",
  "sv3":       "Obsidian Flames",
  "sv4":       "Paradox Rift",
  "sv1":       "Scarlet Violet",
  "sv4pt5":    "Paldean Fates",
  "sv5":       "Temporal Forces",
  "sv6":       "Twilight Masquerade",
  "sv6pt5":    "Shrouded Fable",
  "sv7":       "Stellar Crown",
  "swsh12pt5": "Crown Zenith",
  "swsh9":     "Brilliant Stars",
  "swsh11":    "Lost Origin",
  "swsh12":    "Silver Tempest",
  "swsh6":     "Chilling Reign",
  "swsh5":     "Battle Styles",
  "swshp":     "Sword Shield Promos",
  "base1":     "Base Set",
  "jungle":    "Jungle",
  "fossil":    "Fossil",
  "rocket":    "Team Rocket",
  "neo1":      "Neo Genesis",
  "neo2":      "Neo Discovery",
  "neo3":      "Neo Revelation",
  "exa":       "EX Deoxys",
  "exd":       "EX Delta Species",
  "exu":       "EX Unseen Forces",
};

const WEIGHTS = { liquidity:0.35, momentum:0.25, spread:0.20, grading:0.20 };

function httpGet(url, headers={}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent":"Trackr-Scanner/3.0", ...headers }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 429) { reject(new Error("RATE_LIMITED")); return; }
        if (res.statusCode >= 400)  { reject(new Error(`HTTP_${res.statusCode}`)); return; }
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error("PARSE_ERROR")); }
      });
    });
    req.on("error", e => reject(new Error("NET: " + e.message)));
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("TIMEOUT")); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchGBPRate() {
  try {
    const j = await httpGet("https://api.frankfurter.app/latest?from=USD&to=GBP");
    return j?.rates?.GBP || 0.79;
  } catch(e) { return 0.79; }
}

// ── Match card from results: number first, then name ──────────
function matchCard(data, name, number) {
  if (!Array.isArray(data) || !data.length) return null;
  const norm = s => (s||"").replace(/[\s\/\-]/g,"").toLowerCase();
  const num  = (number||"").split("/")?.[0]?.trim();
  const n1   = norm(name.split(" ")[0]); // first word e.g. "Umbreon"

  // 1. Exact card number match
  const exact = data.find(c => norm(c.cardNumber) === norm(num));
  if (exact) return exact;

  // 2. Number starts with same digits + name match
  const byNum = data.find(c =>
    norm(c.cardNumber).startsWith(norm(num)) &&
    norm(c.name||"").includes(n1)
  );
  if (byNum) return byNum;

  // 3. Best name match
  const byName = data.find(c => norm(c.name||"").includes(n1));
  if (byName) return byName;

  // 4. First result
  return data[0];
}

// ── Fetch card — search by "Name SetName" ─────────────────────
async function fetchCard(name, setCode, number) {
  const setName = SET_NAMES[setCode] || setCode;
  const search  = encodeURIComponent(`${name} ${setName}`.trim());
  const hdrs    = { "X-API-Key": PT_KEY };

  const [euJson, usJson] = await Promise.allSettled([
    httpGet(`${PT_BASE}/cards?search=${search}&market=EU&limit=8`, hdrs),
    httpGet(`${PT_BASE}/cards?search=${search}&market=US&limit=8`, hdrs),
  ]);

  const euData = euJson.status === "fulfilled" ? euJson.value?.data : null;
  const usData = usJson.status === "fulfilled" ? usJson.value?.data : null;

  return {
    euCard: matchCard(euData, name, number),
    usCard: matchCard(usData, name, number),
  };
}

// ── Extract prices ────────────────────────────────────────────
// EU: prices.cardmarket.{avg, avg7d, avg30d}  ← FLAT
//     prices.cardmarket_unsold.NEAR_MINT.{avg, low, saleCount}
// US: prices.ebay.NEAR_MINT.{avg, avg7d, avg30d, saleCount}
//     prices.ebay.PSA_10.{avg}
//     prices.tcgplayer.NEAR_MINT.{avg, avg7d, avg30d}

// ── Fetch price history for a card ID ────────────────────────
// Tries NEAR_MINT first (raw), falls back to AGGREGATED
// Returns array of { date, avg } sorted oldest→newest, or null
async function fetchHistory(cardId, market) {
  if (!cardId) return null;
  const hdrs = { "X-API-Key": PT_KEY };

  // For EU cards use NEAR_MINT (CardMarket condition tier)
  // For US cards use NEAR_MINT (eBay condition tier)
  const tier = "NEAR_MINT";

  try {
    const url = `${PT_BASE}/cards/${cardId}/prices/${tier}/history`;
    const json = await httpGet(url, hdrs);
    const data = json?.data;
    if (!Array.isArray(data) || !data.length) return null;

    // Normalise to { date: "YYYY-MM-DD", avg: number }
    const pts = data
      .filter(d => d.date && (d.avg || d.avg1d || d.avg7d))
      .map(d => ({
        date: d.date.substring(0, 10),
        avg:  Math.round(d.avg || d.avg7d || d.avg1d),
      }))
      .sort((a,b) => a.date.localeCompare(b.date));

    return pts.length >= 2 ? pts : null;
  } catch(e) {
    return null; // history not available — not fatal
  }
}

function extractPrices(euCard, usCard, gbpRate) {
  const eurToGbp = v => v ? +(v * 0.855).toFixed(2) : null;
  const usdToGbp = v => v ? +(v * gbpRate).toFixed(2) : null;

  // EU
  const cm   = euCard?.prices?.cardmarket         || {};
  const cmu  = euCard?.prices?.cardmarket_unsold   || {};
  const euNM = cmu["NEAR_MINT"] || cmu["EXCELLENT"] || cmu["LIGHTLY_PLAYED"] || {};

  // US
  const eb   = usCard?.prices?.ebay     || {};
  const tcg  = usCard?.prices?.tcgplayer|| {};
  const condKeys = ["NEAR_MINT","LIGHTLY_PLAYED","EXCELLENT","GOOD"];
  let ebNM = null;
  for (const k of condKeys) { if (eb[k]?.avg) { ebNM = eb[k]; break; } }
  const tcgNM  = tcg["NEAR_MINT"] || {};
  const psa10  = eb["PSA_10"] || {};

  const euMarket = eurToGbp(cm.avg  || euNM.avg || null);
  const usMarket = usdToGbp(ebNM?.avg || tcgNM.avg || null);

  return {
    marketPrice:    euMarket || usMarket,
    avg7d:          eurToGbp(cm.avg7d)  || usdToGbp(ebNM?.avg7d  || tcgNM.avg7d)  || null,
    avg30d:         eurToGbp(cm.avg30d) || usdToGbp(ebNM?.avg30d || tcgNM.avg30d) || null,
    lowestListing:  eurToGbp(euNM.low)  || usdToGbp(ebNM?.low)   || null,
    salesCount7d:  (euNM.saleCount || 0) + (ebNM?.saleCount || 0),
    psa10Price:     usdToGbp(psa10.avg) || null,
    rawPrice:       usMarket || euMarket,
  };
}

function scoreCard(prices) {
  const { avg7d, avg30d, salesCount7d, psa10Price, rawPrice, marketPrice, lowestListing } = prices;
  let momentumPct = 0;
  if (avg7d && avg30d && avg30d > 0)
    momentumPct = +((avg7d - avg30d) / avg30d * 100).toFixed(1);
  const momentumScore  = Math.min(Math.max(momentumPct / 25, -1), 1);
  const liquidityScore = Math.min((salesCount7d || 0) / 15, 1);
  let spreadScore = 0;
  if (lowestListing && marketPrice && marketPrice > 0)
    spreadScore = Math.min(((marketPrice - lowestListing) / marketPrice * 100) / 30, 1);
  let psaRatio = 0, gradingScore = 0;
  if (psa10Price && rawPrice && rawPrice > 0) {
    psaRatio     = +(psa10Price / rawPrice).toFixed(1);
    gradingScore = Math.min((psaRatio - 1) / 4, 1);
  }
  const totalScore =
    liquidityScore * WEIGHTS.liquidity +
    momentumScore  * WEIGHTS.momentum  +
    spreadScore    * WEIGHTS.spread    +
    gradingScore   * WEIGHTS.grading;
  return { totalScore: +totalScore.toFixed(3), momentumPct, psaRatio };
}

function classifyTriggers(prices, scores) {
  const t = [];
  if (scores.momentumPct >=  8) t.push("momentum_up");
  if (scores.momentumPct <= -8) t.push("momentum_down");
  if (scores.psaRatio >= 1.8)   t.push("grade_target");
  const spread = (prices.marketPrice||0) - (prices.lowestListing||0);
  if (spread >= 5)              t.push("flip_opportunity");
  return t;
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Trackr Market Scanner v3               ║");
  console.log(`║  ${new Date().toISOString().substring(0,10)}                            ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  const gbpRate = await fetchGBPRate();
  console.log(`USD→GBP: ${gbpRate}\n`);

  // ── Load existing price history ──────────────────────────────
  // { "Name|number|set": { lastFetched: "YYYY-MM-DD", pts: [{date,avg},...] } }
  let priceHistory = {};
  try {
    if (fs.existsSync("price-history.json")) {
      priceHistory = JSON.parse(fs.readFileSync("price-history.json", "utf8"));
      console.log(`Loaded price-history.json (${Object.keys(priceHistory).length} cards)\n`);
    }
  } catch(e) { console.warn("Could not read price-history.json:", e.message); }

  const today = new Date().toISOString().substring(0, 10);
  const HISTORY_TTL_DAYS = 7; // re-fetch full history weekly
  let histFetched = 0, histSkipped = 0, histFailed = 0;

  const scanList = JSON.parse(fs.readFileSync("scan-list.json","utf8"));
  const allCards = [];
  for (const [tier, sets] of Object.entries(scanList)) {
    if (tier.startsWith("_")) continue;
    for (const [setName, cards] of Object.entries(sets)) {
      if (setName.startsWith("_") || !Array.isArray(cards)) continue;
      cards.forEach(c => allCards.push({...c, tier, setGroup:setName}));
    }
  }

  console.log(`Scanning ${allCards.length} cards...\n`);

  const results = [];
  let ok=0, noData=0, failed=0;

  for (let i=0; i<allCards.length; i++) {
    const card = allCards[i];
    process.stdout.write(`\r[${i+1}/${allCards.length}] ${card.name.substring(0,20).padEnd(20)} | ok:${ok} nodata:${noData} fail:${failed}`);

    try {
      const { euCard, usCard } = await fetchCard(card.name, card.set, card.number);

      if (!euCard && !usCard) { noData++; await sleep(DELAY); continue; }

      const prices = extractPrices(euCard, usCard, gbpRate);

      // Only skip if absolutely no price at all
      if (!prices.marketPrice && !prices.rawPrice) {
        noData++;
        await sleep(DELAY);
        continue;
      }

      const scores   = scoreCard(prices);
      const triggers = classifyTriggers(prices, scores);
      const apiCard  = euCard || usCard;

      // ── Price history: fetch from API or use cached ──────────
      const _histKey = `${card.name}|${card.number}|${card.set}`;
      const _existing = priceHistory[_histKey];
      const _daysSinceFetch = _existing?.lastFetched
        ? Math.floor((Date.now() - new Date(_existing.lastFetched).getTime()) / 86400000)
        : 999;
      const _needsHistFetch = !_existing || _daysSinceFetch >= HISTORY_TTL_DAYS;

      let _histPts = _existing?.pts || [];

      if (_needsHistFetch && apiCard?.id) {
        await sleep(150); // small extra delay for history call
        const _fetched = await fetchHistory(apiCard.id, apiCard.market || "EU");
        if (_fetched) {
          _histPts = _fetched;
          priceHistory[_histKey] = { lastFetched: today, pts: _histPts };
          histFetched++;
        } else {
          histFailed++;
        }
      } else {
        histSkipped++;
      }

      // Always append today's price as the latest point
      if (prices.marketPrice || prices.rawPrice) {
        const _todayPrice = Math.round(prices.marketPrice || prices.rawPrice);
        const _lastPt = _histPts[_histPts.length - 1];
        if (!_lastPt || _lastPt.date !== today) {
          _histPts = [..._histPts, { date: today, avg: _todayPrice }];
        } else {
          // Update today's point with latest price
          _histPts = [..._histPts.slice(0, -1), { date: today, avg: _todayPrice }];
        }
        // Keep last 365 days
        _histPts = _histPts.sort((a,b) => a.date.localeCompare(b.date)).slice(-365);
        priceHistory[_histKey] = { lastFetched: _existing?.lastFetched || today, pts: _histPts };
      }

      results.push({
        card_id:        apiCard?.id || null,
        name:           card.name,
        number:         card.number,
        set:            card.set,
        set_name:       SET_NAMES[card.set] || card.set,
        friendly_name:  card.name,
        rarity:         apiCard?.rarity || null,
        tier:           card.tier,
        image:          apiCard?.image || null,
        approx_gbp:     card.approx_gbp || null,
        market_price:   prices.marketPrice ? Math.round(prices.marketPrice) : null,
        avg_price_7d:   prices.avg7d       ? Math.round(prices.avg7d)       : null,
        avg_price_30d:  prices.avg30d      ? Math.round(prices.avg30d)      : null,
        lowest_listing: prices.lowestListing ? Math.round(prices.lowestListing) : null,
        sales_count_7d: prices.salesCount7d || 0,
        psa10_price:    prices.psa10Price  ? Math.round(prices.psa10Price)  : null,
        raw_price:      prices.rawPrice    ? Math.round(prices.rawPrice)    : null,
        momentum_pct:   scores.momentumPct,
        psa_ratio:      scores.psaRatio,
        score:          scores.totalScore,
        triggers,
        last_updated:   new Date().toISOString(),
        history:        priceHistory[`${card.name}|${card.number}|${card.set}`]?.pts || [],
      });
      ok++;
    } catch(e) {
      failed++;
    }

    await sleep(DELAY);
  }

  process.stdout.write("\n\n");
  console.log(`Done: ${ok} tracked | ${noData} no data | ${failed} errors\n`);

  const sorted     = [...results].sort((a,b) => b.score - a.score);
  const mom_up     = results.filter(r=>r.triggers.includes("momentum_up"))
                            .sort((a,b)=>b.momentum_pct-a.momentum_pct).slice(0,50);
  const mom_dn     = results.filter(r=>r.triggers.includes("momentum_down"))
                            .sort((a,b)=>a.momentum_pct-b.momentum_pct).slice(0,50);
  const grade_tgts = results.filter(r=>r.triggers.includes("grade_target"))
                            .sort((a,b)=>b.psa_ratio-a.psa_ratio).slice(0,30);
  const flip_ops   = results.filter(r=>r.triggers.includes("flip_opportunity"))
                            .sort((a,b)=>((b.market_price||0)-(b.lowest_listing||0))-
                                         ((a.market_price||0)-(a.lowest_listing||0))).slice(0,30);

  const output = {
    generated:          new Date().toISOString(),
    generated_date:     new Date().toISOString().substring(0,10),
    cards_scanned:      allCards.length,
    cards_tracked:      results.length,
    gbp_rate:           gbpRate,
    momentum_up:        mom_up,
    momentum_down:      mom_dn,
    grade_targets:      grade_tgts,
    flip_opportunities: flip_ops,
    top_overall:        sorted.slice(0,50),
    all_tracked:        sorted,
  };

  fs.writeFileSync("daily-movers.json", JSON.stringify(output, null, 2));
  console.log(`✓ daily-movers.json written (${results.length} cards)\n`);

  // ── Save price history ───────────────────────────────────────
  fs.writeFileSync("price-history.json", JSON.stringify(priceHistory));
  const histCardCount = Object.keys(priceHistory).length;
  const avgPts = histCardCount
    ? Math.round(Object.values(priceHistory).reduce((a,v) => a + (v.pts?.length||0), 0) / histCardCount)
    : 0;
  console.log(`✓ price-history.json written (${histCardCount} cards, avg ${avgPts} pts/card)`);
  console.log(`  History: ${histFetched} fetched | ${histSkipped} cached | ${histFailed} failed\n`);

  if (mom_up.length) {
    console.log("📈 Top Rising:");
    mom_up.slice(0,5).forEach(c =>
      console.log(`  ${c.name.padEnd(28)} ▲${c.momentum_pct}%  £${c.market_price||"—"}`));
  } else {
    console.log("ℹ No momentum signals today");
    console.log("  All tracked cards:");
    sorted.slice(0,30).forEach(c =>
      console.log(`  ${c.name.padEnd(28)} £${c.market_price||c.approx_gbp||"—"}`));
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
