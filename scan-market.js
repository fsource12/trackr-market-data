#!/usr/bin/env node
/**
 * Trackr Market Scanner v2
 * Fixed price extraction to match actual PokeTrace API response structure
 */

const https = require("https");
const fs    = require("fs");

const PT_KEY  = process.env.POKETRACE_KEY;
const PT_BASE = "https://api.poketrace.com/v1";
const DELAY   = 300;

if (!PT_KEY) { console.error("POKETRACE_KEY env var required"); process.exit(1); }

const FILTERS = {
  min_price_gbp: 8,    // lowered — EU prices often come back lower
  min_sales_7d:  1,    // lowered — EU saleCount is often 0 even for active cards
  pokemon_whitelist: [
    "Charizard","Pikachu","Umbreon","Eevee","Mewtwo","Rayquaza",
    "Gengar","Lugia","Greninja","Mew","Snorlax","Dragonite",
    "Tyranitar","Blastoise","Venusaur","Lucario","Gardevoir",
    "Sylveon","Espeon","Leafeon","Glaceon","Jolteon","Flareon",
    "Vaporeon","Gyarados","Alakazam","Arcanine","Raichu",
    "Ninetales","Scyther","Giratina","Ho-Oh","Entei","Raikou",
    "Suicune","Celebi","Pichu","Togekiss","Zacian","Zamazenta",
    "Eternatus","Mimikyu","Dragapult","Ditto","Lapras","Dragonair",
    "Poliwhirl","Charmander","Squirtle","Bulbasaur","Mega",
    "Starmie","Kangaskhan","Zygarde","Greninja","Floette",
  ],
};

const WEIGHTS = { liquidity:0.35, momentum:0.25, spread:0.20, grading:0.20 };

function httpGet(url, headers={}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers:{"User-Agent":"Trackr-Scanner/2.0",...headers} }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 429) { reject(new Error("RATE_LIMITED")); return; }
        if (res.statusCode >= 400) { reject(new Error(`HTTP_${res.statusCode}`)); return; }
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error("PARSE_ERROR: " + d.substring(0,100))); }
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

// ── Extract prices from PokeTrace card object ─────────────────
// EU structure: prices.cardmarket.{avg, avg1d, avg7d, avg30d}
//               prices.cardmarket_unsold.NEAR_MINT.{avg, low, saleCount}
// US structure: prices.ebay.NEAR_MINT.{avg, avg7d, avg30d, saleCount}
//               prices.ebay.PSA_10.{avg, avg7d}
//               prices.tcgplayer.NEAR_MINT.{avg, avg7d, avg30d}
function extractPricesFromCard(card, gbpRate, isUS) {
  if (!card) return {};
  const prices = card.prices || {};
  const eurToGbp = v => v ? +(v * 0.855).toFixed(2) : null;
  const usdToGbp = v => v ? +(v * gbpRate).toFixed(2) : null;

  if (!isUS) {
    // ── EU (CardMarket) ─────────────────────────────────────────
    const cm   = prices.cardmarket || {};            // flat: avg, avg7d, avg30d
    const cmu  = prices.cardmarket_unsold || {};      // nested: NEAR_MINT, PSA_10 etc
    const nmData = cmu["NEAR_MINT"] || cmu["EXCELLENT"] || cmu["LIGHTLY_PLAYED"] || {};
    const psa10  = cmu["PSA_10"] || {};

    return {
      marketPrice:    eurToGbp(cm.avg   || nmData.avg || null),
      avg7d:          eurToGbp(cm.avg7d  || null),
      avg30d:         eurToGbp(cm.avg30d || null),
      lowestListing:  eurToGbp(nmData.low || null),
      salesCount7d:   nmData.saleCount || 0,
      psa10Price:     eurToGbp(psa10.avg || null),
      rawPrice:       eurToGbp(cm.avg || nmData.avg || null),
    };
  } else {
    // ── US (eBay + TCGPlayer) ───────────────────────────────────
    const eb  = prices.ebay || {};
    const tcg = prices.tcgplayer || {};
    const condKeys = ["NEAR_MINT","LIGHTLY_PLAYED","EXCELLENT","GOOD"];
    let ebNM = null;
    for (const k of condKeys) { if (eb[k]?.avg) { ebNM = eb[k]; break; } }
    const tcgNM  = tcg["NEAR_MINT"] || {};
    const psa10  = eb["PSA_10"] || {};

    return {
      marketPrice:    usdToGbp(ebNM?.avg || tcgNM.avg || null),
      avg7d:          usdToGbp(ebNM?.avg7d  || tcgNM.avg7d  || null),
      avg30d:         usdToGbp(ebNM?.avg30d || tcgNM.avg30d || null),
      lowestListing:  usdToGbp(ebNM?.low || null),
      salesCount7d:   ebNM?.saleCount || 0,
      psa10Price:     usdToGbp(psa10.avg || null),
      rawPrice:       usdToGbp(ebNM?.avg || null),
    };
  }
}

// ── Match a card from API results ─────────────────────────────
function matchCard(data, name, number) {
  if (!Array.isArray(data) || !data.length) return null;
  const norm   = s => (s||"").replace(/[\s\/]/g,"").toLowerCase();
  const num    = number?.split("/")?.[0];          // numerator only
  const nameLow = name.toLowerCase().split(" ")[0]; // first word of name

  // Try exact card number match first
  const byNum = data.find(c => norm(c.cardNumber) === norm(num));
  if (byNum) return byNum;

  // Try name + approximate number
  const byNameNum = data.find(c =>
    (c.name||"").toLowerCase().includes(nameLow) &&
    norm(c.cardNumber).startsWith(norm(num).substring(0,3))
  );
  if (byNameNum) return byNameNum;

  // Fall back to best name match
  return data.find(c => (c.name||"").toLowerCase().includes(nameLow)) || data[0];
}

async function fetchCard(name, set, number) {
  const search = encodeURIComponent(`${name} ${set}`.trim());
  const hdrs   = { "X-API-Key": PT_KEY };

  try {
    const [euJson, usJson] = await Promise.all([
      httpGet(`${PT_BASE}/cards?search=${search}&market=EU&limit=8`, hdrs).catch(() => null),
      httpGet(`${PT_BASE}/cards?search=${search}&market=US&limit=8`, hdrs).catch(() => null),
    ]);

    const euCard = matchCard(euJson?.data, name, number);
    const usCard = matchCard(usJson?.data, name, number);
    return { euCard, usCard };
  } catch(e) {
    return { euCard:null, usCard:null };
  }
}

function scoreCard(prices) {
  const { avg7d, avg30d, salesCount7d, psa10Price, rawPrice, marketPrice, lowestListing } = prices;

  let momentumPct = 0;
  if (avg7d && avg30d && avg30d > 0) {
    momentumPct = +((avg7d - avg30d) / avg30d * 100).toFixed(1);
  }
  const momentumScore  = Math.min(Math.max(momentumPct/25, -1), 1);
  const liquidityScore = Math.min(salesCount7d / 15, 1);

  let spreadScore = 0;
  if (lowestListing && marketPrice && marketPrice > 0) {
    spreadScore = Math.min(((marketPrice - lowestListing) / marketPrice * 100) / 30, 1);
  }

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
  if (scores.momentumPct >=  8)  t.push("momentum_up");
  if (scores.momentumPct <= -8)  t.push("momentum_down");
  if (scores.psaRatio >= 1.8)    t.push("grade_target");
  const spread = (prices.marketPrice||0) - (prices.lowestListing||0);
  if (spread >= 6)               t.push("flip_opportunity");
  return t;
}

function passesFilter(card, prices) {
  // Must have some price data
  if (!prices.marketPrice && !prices.rawPrice) return false;
  const price = prices.marketPrice || prices.rawPrice;
  if (price < FILTERS.min_price_gbp) return false;
  // Must be a tracked Pokémon (name whitelist)
  const nameMatch = FILTERS.pokemon_whitelist.some(p =>
    (card.name||"").toLowerCase().includes(p.toLowerCase())
  );
  return nameMatch;
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Trackr Market Scanner v2               ║");
  console.log(`║  ${new Date().toISOString().substring(0,10)}                            ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  const gbpRate = await fetchGBPRate();
  console.log(`USD→GBP rate: ${gbpRate}\n`);

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
  let fetched=0, skipped=0, failed=0, noPrice=0;

  for (let i=0; i<allCards.length; i++) {
    const card = allCards[i];
    process.stdout.write(`\r[${i+1}/${allCards.length}] ${card.name.substring(0,18).padEnd(18)} | ok:${fetched} skip:${skipped} noprice:${noPrice} fail:${failed}`);

    try {
      const { euCard, usCard } = await fetchCard(card.name, card.set, card.number);

      if (!euCard && !usCard) { failed++; await sleep(DELAY); continue; }

      // Extract from both, prefer EU (CM) prices
      const euPrices = extractPricesFromCard(euCard, gbpRate, false);
      const usPrices = extractPricesFromCard(usCard, gbpRate, true);

      // Merge: EU avg7d/avg30d preferred, US as fallback for market price and PSA
      const prices = {
        marketPrice:   euPrices.marketPrice  || usPrices.marketPrice,
        avg7d:         euPrices.avg7d        || usPrices.avg7d,
        avg30d:        euPrices.avg30d       || usPrices.avg30d,
        lowestListing: euPrices.lowestListing|| usPrices.lowestListing,
        salesCount7d:  euPrices.salesCount7d + usPrices.salesCount7d,
        psa10Price:    usPrices.psa10Price   || euPrices.psa10Price,
        rawPrice:      usPrices.rawPrice     || euPrices.rawPrice,
      };

      if (!passesFilter(card, prices)) {
        if (!prices.marketPrice && !prices.rawPrice) noPrice++;
        else skipped++;
        await sleep(DELAY);
        continue;
      }

      const scores   = scoreCard(prices);
      const triggers = classifyTriggers(prices, scores);
      const apiCard  = euCard || usCard;

      results.push({
        card_id:        apiCard?.id || null,
        name:           card.name,
        number:         card.number,
        set:            card.set,
        friendly_name:  card.name,
        rarity:         apiCard?.rarity || null,
        tier:           card.tier,
        image:          apiCard?.image || null,
        market_price:   prices.marketPrice ? Math.round(prices.marketPrice) : null,
        avg_price_7d:   prices.avg7d       ? Math.round(prices.avg7d)       : null,
        avg_price_30d:  prices.avg30d      ? Math.round(prices.avg30d)      : null,
        lowest_listing: prices.lowestListing ? Math.round(prices.lowestListing) : null,
        sales_count_7d: prices.salesCount7d,
        psa10_price:    prices.psa10Price  ? Math.round(prices.psa10Price)  : null,
        raw_price:      prices.rawPrice    ? Math.round(prices.rawPrice)    : null,
        momentum_pct:   scores.momentumPct,
        psa_ratio:      scores.psaRatio,
        score:          scores.totalScore,
        triggers,
        last_updated:   new Date().toISOString(),
      });

      fetched++;
    } catch(e) {
      failed++;
    }

    await sleep(DELAY);
  }

  process.stdout.write("\n\n");
  console.log(`Results: ${results.length} tracked | ${skipped} skipped | ${noPrice} no-price | ${failed} failed\n`);

  const sorted     = [...results].sort((a,b) => b.score - a.score);
  const mom_up     = results.filter(r=>r.triggers.includes("momentum_up"))
                            .sort((a,b)=>b.momentum_pct-a.momentum_pct).slice(0,10);
  const mom_dn     = results.filter(r=>r.triggers.includes("momentum_down"))
                            .sort((a,b)=>a.momentum_pct-b.momentum_pct).slice(0,10);
  const grade_tgts = results.filter(r=>r.triggers.includes("grade_target"))
                            .sort((a,b)=>b.psa_ratio-a.psa_ratio).slice(0,8);
  const flip_ops   = results.filter(r=>r.triggers.includes("flip_opportunity"))
                            .sort((a,b)=>((b.market_price||0)-(b.lowest_listing||0))-((a.market_price||0)-(a.lowest_listing||0))).slice(0,8);

  const output = {
    generated:      new Date().toISOString(),
    generated_date: new Date().toISOString().substring(0,10),
    cards_scanned:  allCards.length,
    cards_tracked:  results.length,
    gbp_rate:       gbpRate,
    momentum_up:    mom_up,
    momentum_down:  mom_dn,
    grade_targets:  grade_tgts,
    flip_opportunities: flip_ops,
    top_overall:    sorted.slice(0,15),
    all_tracked:    sorted,
  };

  fs.writeFileSync("daily-movers.json", JSON.stringify(output, null, 2));
  console.log(`✓ Written daily-movers.json (${results.length} cards)\n`);

  if (mom_up.length) {
    console.log("Top Rising:");
    mom_up.slice(0,5).forEach(c =>
      console.log(`  ${c.name.padEnd(28)} ▲${c.momentum_pct}%  £${c.market_price||"—"}`));
  }

  if (!results.length) {
    console.log("⚠  No cards tracked — check PokeTrace API response format");
    console.log("   Hint: Add console.log(JSON.stringify(euCard,null,2)) after fetchCard to debug");
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
