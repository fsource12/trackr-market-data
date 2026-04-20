#!/usr/bin/env node
/**
 * Trackr Market Scanner v3
 * Outputs: daily-movers.json + price-history.json
 */

const https = require("https");
const fs    = require("fs");

const PT_KEY  = process.env.POKETRACE_KEY;
const PT_BASE = "https://api.poketrace.com/v1";
const DELAY   = 350;

if (!PT_KEY) { console.error("POKETRACE_KEY env var required"); process.exit(1); }

const SET_NAMES = {
  "sv8pt5":"Prismatic Evolutions","sv3pt5":"151","sv8":"Surging Sparks",
  "swsh7":"Evolving Skies","sv9":"Mega Evolution","sv9pt5":"Ascended Heroes",
  "sv10":"Perfect Order","sv10pt5":"Destined Rivals","sv11":"Journey Together",
  "sv3":"Obsidian Flames","sv4":"Paradox Rift","sv1":"Scarlet Violet",
  "sv4pt5":"Paldean Fates","sv5":"Temporal Forces","sv6":"Twilight Masquerade",
  "sv6pt5":"Shrouded Fable","sv7":"Stellar Crown","sv7pt5":"Phantasmal Flames",
  "swsh12pt5":"Crown Zenith","swsh9":"Brilliant Stars","swsh11":"Lost Origin",
  "swsh12":"Silver Tempest","swsh6":"Chilling Reign","swsh5":"Battle Styles",
  "swshp":"Sword Shield Promos","swsh10":"Astral Radiance",
  "sm12":"Cosmic Eclipse","sm11":"Unified Minds","sm10":"Unbroken Bonds",
  "sm9":"Team Up","sm35":"Shining Legends",
  "base1":"Base Set","jungle":"Jungle","fossil":"Fossil","rocket":"Team Rocket",
  "neo1":"Neo Genesis","neo2":"Neo Discovery","neo3":"Neo Revelation","neo4":"Neo Destiny",
  "exa":"EX Deoxys","exd":"EX Delta Species","exu":"EX Unseen Forces",
  "dp3":"Secret Wonders","pl1":"Platinum","hgss1":"HeartGold SoulSilver",
  "bw1":"Black White","bw9":"Plasma Freeze","bw11":"Legendary Treasures",
  "xy1":"XY","xy12":"Evolutions","g1":"Generations","xy7":"Ancient Origins",
  "xy8":"BREAKthrough","xy10":"Fates Collide","sm1":"Sun Moon",
  "sm3":"Burning Shadows","swsh35":"Champion's Path","swsh45":"Shining Fates",
  "pgo":"Pokemon GO","swsh8":"Fusion Strike",
};

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    opts.headers = { "User-Agent": "Trackr/3.0", ...headers };
    https.get(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 403 || res.statusCode === 401) {
          reject(new Error(`HTTP ${res.statusCode}`)); return;
        }
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error("JSON parse: " + d.substring(0,80))); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchGBPRate() {
  try {
    const j = await httpGet("https://api.exchangerate-api.com/v4/latest/USD", {});
    return { GBP: j?.rates?.GBP || 0.79, EUR: j?.rates?.EUR || 0.92, USD: 1 };
  } catch(e) { return { GBP: 0.79, EUR: 0.92, USD: 1 }; }
}

async function fetchCard(name, set, number) {
  const hdrs = { "X-API-Key": PT_KEY };
  const q = encodeURIComponent(`${name} ${SET_NAMES[set] || set}`);
  const [eu, us] = await Promise.allSettled([
    httpGet(`${PT_BASE}/cards?search=${q}&market=EU&limit=3`, hdrs),
    httpGet(`${PT_BASE}/cards?search=${q}&market=US&limit=3`, hdrs),
  ]);
  const pick = res => {
    if (res.status !== "fulfilled") return null;
    const cards = res.value?.data || [];
    if (!cards.length) return null;
    if (number) {
      const exact = cards.find(c =>
        (c.cardNumber||"").replace(/\s/g,"").toLowerCase() === number.replace(/\s/g,"").toLowerCase()
      );
      if (exact) return exact;
    }
    return cards[0];
  };
  return { euCard: pick(eu), usCard: pick(us) };
}

async function fetchHistory(cardId) {
  if (!cardId) return null;
  try {
    const j = await httpGet(`${PT_BASE}/cards/${cardId}/prices/NEAR_MINT/history`, { "X-API-Key": PT_KEY });
    const data = j?.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    const pts = data
      .filter(d => d.date && (d.avg || d.avg7d || d.avg1d))
      .map(d => ({ date: d.date.substring(0,10), avg: Math.round(d.avg || d.avg7d || d.avg1d) }))
      .sort((a,b) => a.date.localeCompare(b.date));
    return pts.length >= 2 ? pts : null;
  } catch(e) { return null; }
}

function extractPrices(euCard, usCard, fx) {
  const { GBP: gbp, EUR: eur } = fx;
  const cm    = euCard?.prices?.cardmarket;
  const cmu   = euCard?.prices?.cardmarket_unsold?.NEAR_MINT;
  const usNM  = usCard?.prices?.ebay?.NEAR_MINT;
  const usPsa = usCard?.prices?.ebay?.PSA_10;

  const cmAvg  = cm?.avg   ? Math.round(cm.avg   / eur * gbp) : null;
  const cmuAvg = cmu?.avg  ? Math.round(cmu.avg  / eur * gbp) : null;
  const usAvg  = usNM?.avg ? Math.round(usNM.avg * gbp) : null;
  const us7d   = usNM?.avg7d  ? Math.round(usNM.avg7d  * gbp) : null;
  const us30d  = usNM?.avg30d ? Math.round(usNM.avg30d * gbp) : null;
  const psa10  = usPsa?.avg ? Math.round(usPsa.avg * gbp) : null;

  return {
    marketPrice:    cmAvg || usAvg || cmuAvg || null,
    rawPrice:       usAvg || cmAvg || null,
    avg7d:          cm?.avg7d  ? Math.round(cm.avg7d  / eur * gbp) : us7d,
    avg30d:         cm?.avg30d ? Math.round(cm.avg30d / eur * gbp) : us30d,
    salesCount7d:   usNM?.saleCount || 0,
    lowestListing:  cmu?.low ? Math.round(cmu.low / eur * gbp) : null,
    psa10Price:     psa10,
  };
}

const WEIGHTS = { liquidity:0.35, momentum:0.25, spread:0.20, grading:0.20 };

function scoreCard(prices) {
  const { marketPrice, rawPrice, avg7d, avg30d, salesCount7d, lowestListing, psa10Price } = prices;
  const momentumPct    = (avg7d && avg30d && avg30d > 0) ? +((avg7d-avg30d)/avg30d*100).toFixed(1) : 0;
  const momentumScore  = Math.min(Math.max(momentumPct/25, -1), 1);
  const liquidityScore = Math.min((salesCount7d||0)/15, 1);
  let spreadScore = 0;
  if (marketPrice && lowestListing && marketPrice > 0)
    spreadScore = Math.min(((marketPrice-lowestListing)/marketPrice*100)/30, 1);
  let psaRatio = 0, gradingScore = 0;
  if (psa10Price && rawPrice && rawPrice > 0) {
    psaRatio = +(psa10Price/rawPrice).toFixed(2);
    if (psaRatio >= 1.8) gradingScore = Math.min((psaRatio-1)/4, 1);
  }
  const totalScore = liquidityScore*WEIGHTS.liquidity + momentumScore*WEIGHTS.momentum +
                     spreadScore*WEIGHTS.spread + gradingScore*WEIGHTS.grading;
  return { totalScore: +totalScore.toFixed(3), momentumPct, psaRatio };
}

function classifyTriggers(prices, scores) {
  const t = [];
  // Momentum only meaningful if both % AND abs £ move are significant
  // A 5% move on a £2 card = 10p — not worth flagging for a reseller
  const _absMove = prices.avg30d ? Math.abs(Math.round((prices.avg7d||0) - prices.avg30d)) : 0;
  if (scores.momentumPct >= 5  && _absMove >= 5)  t.push("momentum_up");
  if (scores.momentumPct <= -5 && _absMove >= 5)  t.push("momentum_down");
  if (scores.psaRatio >= 1.8)   t.push("grade_target");
  if (prices.lowestListing && prices.marketPrice && prices.lowestListing < prices.marketPrice*0.92)
    t.push("flip_opportunity");
  return t;
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Trackr Market Scanner v3               ║");
  console.log(`║  ${new Date().toISOString().substring(0,10)}                            ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  const fx = await fetchGBPRate();
  console.log(`USD→GBP: ${fx.GBP}  EUR→GBP: ${(fx.GBP/fx.EUR).toFixed(3)}\n`);

  // Load price history cache
  let priceHistory = {};
  try {
    if (fs.existsSync("price-history.json"))
      priceHistory = JSON.parse(fs.readFileSync("price-history.json","utf8"));
    console.log(`Loaded price-history.json (${Object.keys(priceHistory).length} cards)\n`);
  } catch(e) { console.warn("price-history.json not found — starting fresh"); }

  const today = new Date().toISOString().substring(0,10);
  let histFetched=0, histSkipped=0, histFailed=0;

  // Load scan list
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

  const results=[], ok_arr=[];
  let ok=0, noData=0, failed=0;

  for (let i=0; i<allCards.length; i++) {
    const card = allCards[i];
    process.stdout.write(`\r[${i+1}/${allCards.length}] ${card.name.substring(0,18).padEnd(18)} | ok:${ok} nodata:${noData} fail:${failed} hist:${histFetched}`);

    try {
      const { euCard, usCard } = await fetchCard(card.name, card.set, card.number);
      if (!euCard && !usCard) { noData++; await sleep(DELAY); continue; }

      const prices  = extractPrices(euCard, usCard, fx);
      if (!prices.marketPrice && !prices.rawPrice) { noData++; await sleep(DELAY); continue; }

      const scores   = scoreCard(prices);
      const triggers = classifyTriggers(prices, scores);
      const apiCard  = euCard || usCard;

      // History
      const _key  = `${card.name}|${card.number}|${card.set}`;
      const _hist = priceHistory[_key];
      const _age  = _hist?.lastFetched
        ? Math.floor((Date.now()-new Date(_hist.lastFetched).getTime())/86400000) : 999;
      let _pts    = _hist?.pts || [];

      if (_age >= 7 && apiCard?.id) {
        await sleep(150);
        const fetched = await fetchHistory(apiCard.id);
        if (fetched) { _pts = fetched; priceHistory[_key]={lastFetched:today,pts:_pts}; histFetched++; }
        else histFailed++;
      } else histSkipped++;

      // Append today
      const todayP = Math.round(prices.marketPrice || prices.rawPrice);
      const lastPt = _pts[_pts.length-1];
      _pts = lastPt?.date===today ? [..._pts.slice(0,-1),{date:today,avg:todayP}] : [..._pts,{date:today,avg:todayP}];
      _pts = _pts.sort((a,b)=>a.date.localeCompare(b.date)).slice(-365);
      priceHistory[_key] = { lastFetched: _hist?.lastFetched||today, pts:_pts };

      // profit_score
      const _p  = prices.marketPrice || prices.rawPrice || 0;
      const _m  = 1 + Math.max(0, scores.momentumPct) / 100;
      const _g  = scores.psaRatio >= 1.8 ? 1+(scores.psaRatio-1)*0.25 : 1;
      const pS  = Math.round(_p * _m * _g);

      results.push({
        card_id:        apiCard?.id||null,
        name:           apiCard?.name || card.name,
        number:         apiCard?.cardNumber || card.number,
        set:            card.set,
        set_name:       SET_NAMES[card.set]||card.set,
        friendly_name:  card.name,
        rarity:         apiCard?.rarity||null,
        tier:           card.tier,
        image:          euCard?.image||usCard?.image||null,
        approx_gbp:     card.approx_gbp||null,
        market_price:   prices.marketPrice ? Math.round(prices.marketPrice) : null,
        avg_price_7d:   prices.avg7d       ? Math.round(prices.avg7d)       : null,
        avg_price_30d:  prices.avg30d      ? Math.round(prices.avg30d)      : null,
        lowest_listing: prices.lowestListing ? Math.round(prices.lowestListing) : null,
        sales_count_7d: prices.salesCount7d||0,
        psa10_price:    prices.psa10Price ? Math.round(prices.psa10Price) : null,
        raw_price:      prices.rawPrice   ? Math.round(prices.rawPrice)   : null,
        momentum_pct:   scores.momentumPct,
        psa_ratio:      scores.psaRatio,
        score:          scores.totalScore,
        profit_score:   pS,
        triggers,
        last_updated:   new Date().toISOString(),
        history:        _pts,
      });
      ok++;
    } catch(e) { failed++; }
    await sleep(DELAY);
  }

  process.stdout.write("\n\n");
  console.log(`Done: ${ok} tracked | ${noData} no data | ${failed} errors`);
  console.log(`History: ${histFetched} fetched | ${histSkipped} cached | ${histFailed} failed\n`);

  const byProfit   = [...results].sort((a,b)=>b.profit_score-a.profit_score);
  const byMomentum = [...results].sort((a,b)=>b.momentum_pct-a.momentum_pct);

  const output = {
    generated:          new Date().toISOString(),
    generated_date:     new Date().toISOString().substring(0,10),
    cards_scanned:      allCards.length,
    cards_tracked:      results.length,
    gbp_rate:           fx.GBP,
    momentum_up:        byMomentum.filter(r=>r.triggers.includes("momentum_up")).slice(0,50),
    momentum_down:      [...byMomentum].reverse().filter(r=>r.triggers.includes("momentum_down")).slice(0,50),
    grade_targets:      [...results].filter(r=>r.triggers.includes("grade_target")).sort((a,b)=>b.psa_ratio-a.psa_ratio).slice(0,30),
    flip_opportunities: [...results].filter(r=>r.triggers.includes("flip_opportunity")).sort((a,b)=>((b.market_price||0)-(b.lowest_listing||0))-((a.market_price||0)-(a.lowest_listing||0))).slice(0,30),
    top_overall:        byProfit.slice(0,50),
    all_tracked:        byProfit,
  };

  fs.writeFileSync("daily-movers.json", JSON.stringify(output, null, 2));
  console.log(`✓ daily-movers.json (${results.length} cards)\n`);

  fs.writeFileSync("price-history.json", JSON.stringify(priceHistory));
  const hc = Object.keys(priceHistory).length;
  const ap = hc ? Math.round(Object.values(priceHistory).reduce((a,v)=>a+(v.pts?.length||0),0)/hc) : 0;
  console.log(`✓ price-history.json (${hc} cards, avg ${ap} pts/card)\n`);

  console.log("📊 Top by profit score:");
  byProfit.slice(0,8).forEach(c=>
    console.log(`  ${c.name.padEnd(28)} £${c.market_price||"—"}  p_score:${c.profit_score}`));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
