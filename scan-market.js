#!/usr/bin/env node
/**
 * Trackr Market Scanner
 * ─────────────────────────────────────────────────────────────────
 * Runs daily via GitHub Actions. Fetches PokeTrace data for all
 * cards in scan-list.json, applies filters, scores opportunities,
 * writes daily-movers.json to repo root for extension popup to fetch.
 *
 * Usage: node scan-market.js
 * Output: daily-movers.json
 *
 * GitHub Actions: runs at 06:00 UTC daily
 * Extension popup: fetches raw GitHub URL (free, no auth)
 */

const https = require("https");
const fs    = require("fs");

const PT_KEY  = process.env.POKETRACE_KEY;
const PT_BASE = "https://api.poketrace.com/v1";
const DELAY   = 250; // ms between requests (~4/s)

if (!PT_KEY) { console.error("POKETRACE_KEY env var required"); process.exit(1); }

// ── Filter config (from Trackr spec) ─────────────────────────────
const FILTERS = {
  min_price_gbp:      15,
  min_sales_7d:       3,   // lowered from 5 — PokeTrace EU counts are lower than US
  max_set_age_years:  10,
  rarity_whitelist: [
    "Special Illustration Rare", "Illustration Rare", "Hyper Rare",
    "Secret Rare", "Ultra Rare", "Full Art", "Trainer Gallery",
    "Galarian Gallery", "Promo", "Holo Rare", "Rare Holo",
    "Alternate Full Art", "Rainbow Rare", "Gold Rare",
    "Special Art Rare", "Art Rare"
  ],
  pokemon_whitelist: [
    "Charizard","Pikachu","Umbreon","Eevee","Mewtwo","Rayquaza",
    "Gengar","Lugia","Greninja","Mew","Snorlax","Dragonite",
    "Tyranitar","Blastoise","Venusaur","Lucario","Gardevoir",
    "Sylveon","Espeon","Leafeon","Glaceon","Jolteon","Flareon",
    "Vaporeon","Gyarados","Alakazam","Arcanine","Raichu",
    "Ninetales","Scyther","Giratina","Ho-Oh","Entei","Raikou",
    "Suicune","Celebi","Pichu","Togekiss","Zacian","Zamazenta",
    "Eternatus","Mimikyu","Dragapult","Ditto","Lapras","Dragonair",
    "Poliwhirl","Charmander","Squirtle","Bulbasaur"
  ],
  exclude_keywords: ["job lot","bundle","proxy","custom","fake","replica"],
};

// ── Event trigger thresholds ──────────────────────────────────────
const TRIGGERS = {
  momentum_up:      { threshold_pct: 10 },  // 7d avg > 30d avg by 10%+
  momentum_down:    { threshold_pct: -10 }, // 7d avg < 30d avg by 10%+
  volume_spike:     { multiplier: 1.8 },    // saleCount notably high
  grade_target:     { min_psa_ratio: 2.0 }, // PSA10 / raw >= 2x
  flip_opportunity: { min_spread_gbp: 8 },  // CM low vs eBay avg spread
};

// ── Scoring weights ───────────────────────────────────────────────
const WEIGHTS = {
  liquidity: 0.35,
  momentum:  0.25,
  spread:    0.20,
  grading:   0.20,
};

// ── HTTP helper ───────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "Trackr-Scanner/1.0", ...headers }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 429) { reject(new Error("RATE_LIMITED")); return; }
        if (res.statusCode >= 400) { reject(new Error(`HTTP_${res.statusCode}`)); return; }
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error("PARSE_ERROR")); }
      });
    });
    req.on("error", e => reject(new Error(`NET: ${e.message}`)));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("TIMEOUT")); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── USD → GBP conversion (approximate, updated daily) ────────────
async function fetchGBPRate() {
  try {
    const json = await httpGet("https://api.frankfurter.app/latest?from=USD&to=GBP");
    return json?.rates?.GBP || 0.79;
  } catch(e) {
    return 0.79; // fallback
  }
}

// ── Fetch card data from PokeTrace ───────────────────────────────
async function fetchCard(name, set, number) {
  const search = encodeURIComponent(`${name} ${set}`.trim());
  const url = `${PT_BASE}/cards?search=${search}&market=EU&limit=5`;
  try {
    const euJson = await httpGet(url, { "X-API-Key": PT_KEY });
    // Also fetch US for graded prices
    const urlUS = `${PT_BASE}/cards?search=${search}&market=US&limit=5`;
    const usJson = await httpGet(urlUS, { "X-API-Key": PT_KEY });

    const norm = s => (s || "").replace(/\s/g, "").toLowerCase();
    const matchCard = (data) => {
      if (!data?.length) return null;
      return data.find(c => norm(c.cardNumber) === norm(number?.split("/")[0]))
          || data.find(c => (c.name||"").toLowerCase().includes(name.toLowerCase().split(" ")[0]))
          || data[0];
    };

    const euCard = matchCard(euJson?.data);
    const usCard = matchCard(usJson?.data);
    return { euCard, usCard };
  } catch(e) {
    return { euCard: null, usCard: null };
  }
}

// ── Extract price data from card ──────────────────────────────────
function extractPrices(euCard, usCard, gbpRate) {
  const cm    = euCard?.prices?.cardmarket?.AGGREGATED || {};
  const ebUS  = usCard?.prices?.ebay?.NEAR_MINT || {};
  const tcg   = usCard?.prices?.tcgplayer?.NEAR_MINT || {};
  const psa10 = usCard?.prices?.ebay?.PSA_10 || {};

  const eurToGbp = (v) => v ? v * (gbpRate / 1.18) : null; // EUR → GBP approx via USD
  const usdToGbp = (v) => v ? v * gbpRate : null;

  return {
    market_price:         eurToGbp(cm.avg) || usdToGbp(ebUS.avg),
    avg_price_7d:         eurToGbp(cm.avg7d),
    avg_price_30d:        eurToGbp(cm.avg30d),
    lowest_listing:       eurToGbp(cm.low),
    sales_count_7d:       euCard?.totalSaleCount || usCard?.totalSaleCount || 0,
    psa10_price:          usdToGbp(psa10.avg),
    raw_price:            usdToGbp(ebUS.avg) || eurToGbp(cm.avg),
    rarity:               euCard?.rarity || usCard?.rarity || null,
    image:                euCard?.image || usCard?.image || null,
    card_id:              euCard?.id || usCard?.id || null,
    last_updated:         new Date().toISOString(),
  };
}

// ── Score a card ──────────────────────────────────────────────────
function scoreCard(prices) {
  const { avg_price_7d, avg_price_30d, sales_count_7d, psa10_price, raw_price, market_price, lowest_listing } = prices;

  // Momentum: 7d vs 30d
  let momentumScore = 0;
  let momentumPct   = 0;
  if (avg_price_7d && avg_price_30d && avg_price_30d > 0) {
    momentumPct   = ((avg_price_7d - avg_price_30d) / avg_price_30d) * 100;
    momentumScore = Math.min(Math.max(momentumPct / 20, -1), 1); // normalise -1 to +1
  }

  // Liquidity: sales count normalised (20+ sales = max)
  const liquidityScore = Math.min(sales_count_7d / 20, 1);

  // Spread: CM low vs market price
  let spreadScore = 0;
  if (lowest_listing && market_price && market_price > 0) {
    const spreadPct  = ((market_price - lowest_listing) / market_price) * 100;
    spreadScore      = Math.min(spreadPct / 30, 1);
  }

  // Grading upside: PSA10 / raw ratio
  let gradingScore = 0;
  let psaRatio     = 0;
  if (psa10_price && raw_price && raw_price > 0) {
    psaRatio     = psa10_price / raw_price;
    gradingScore = Math.min((psaRatio - 1) / 4, 1); // ratio of 5x = max score
  }

  const totalScore =
    (liquidityScore * WEIGHTS.liquidity) +
    (momentumScore  * WEIGHTS.momentum)  +
    (spreadScore    * WEIGHTS.spread)    +
    (gradingScore   * WEIGHTS.grading);

  return { totalScore, momentumPct, psaRatio, liquidityScore, spreadScore };
}

// ── Classify triggers ─────────────────────────────────────────────
function classifyTriggers(prices, scores) {
  const triggers = [];
  if (scores.momentumPct >= TRIGGERS.momentum_up.threshold_pct)
    triggers.push("momentum_up");
  if (scores.momentumPct <= TRIGGERS.momentum_down.threshold_pct)
    triggers.push("momentum_down");
  if (scores.psaRatio >= TRIGGERS.grade_target.min_psa_ratio)
    triggers.push("grade_target");
  const spread = prices.market_price && prices.lowest_listing
    ? prices.market_price - prices.lowest_listing : 0;
  if (spread >= TRIGGERS.flip_opportunity.min_spread_gbp)
    triggers.push("flip_opportunity");
  return triggers;
}

// ── Filter card ───────────────────────────────────────────────────
function passesFilter(card, prices) {
  if (!prices.market_price || prices.market_price < FILTERS.min_price_gbp) return false;
  if (prices.sales_count_7d < FILTERS.min_sales_7d) return false;
  const nameMatch = FILTERS.pokemon_whitelist.some(p =>
    (card.name || "").toLowerCase().includes(p.toLowerCase())
  );
  if (!nameMatch) return false;
  return true;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Trackr Market Scanner                  ║");
  console.log(`║  ${new Date().toISOString().substring(0, 10)}                            ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  const gbpRate = await fetchGBPRate();
  console.log(`GBP/USD rate: ${gbpRate}\n`);

  // Load scan list
  const scanList = JSON.parse(fs.readFileSync("scan-list.json", "utf8"));
  const allCards = [];

  // Flatten all cards from all tiers
  for (const [tier, sets] of Object.entries(scanList)) {
    if (tier.startsWith("_")) continue;
    for (const [setName, cards] of Object.entries(sets)) {
      if (setName.startsWith("_")) continue;
      if (Array.isArray(cards)) {
        cards.forEach(c => allCards.push({ ...c, tier, setGroup: setName }));
      }
    }
  }

  console.log(`Scanning ${allCards.length} cards...\n`);

  const results   = [];
  let fetched = 0, skipped = 0, failed = 0;

  for (let i = 0; i < allCards.length; i++) {
    const card = allCards[i];
    process.stdout.write(`\r[${i+1}/${allCards.length}] ${card.name.substring(0,20).padEnd(20)} | fetched:${fetched} skipped:${skipped} failed:${failed}`);

    try {
      const { euCard, usCard } = await fetchCard(card.name, card.set, card.number);

      if (!euCard && !usCard) { failed++; await sleep(DELAY); continue; }

      const prices = extractPrices(euCard, usCard, gbpRate);
      prices.name   = card.name;
      prices.number = card.number;
      prices.set    = card.set;
      prices.tier   = card.tier;

      if (!passesFilter(card, prices)) { skipped++; await sleep(DELAY); continue; }

      const scores   = scoreCard(prices);
      const triggers = classifyTriggers(prices, scores);

      results.push({
        card_id:       prices.card_id,
        name:          card.name,
        number:        card.number,
        set:           card.set,
        friendly_name: card.name,
        rarity:        prices.rarity,
        tier:          card.tier,
        image:         prices.image,
        market_price:  prices.market_price ? Math.round(prices.market_price) : null,
        avg_price_7d:  prices.avg_price_7d  ? Math.round(prices.avg_price_7d)  : null,
        avg_price_30d: prices.avg_price_30d ? Math.round(prices.avg_price_30d) : null,
        lowest_listing:prices.lowest_listing ? Math.round(prices.lowest_listing) : null,
        sales_count_7d: prices.sales_count_7d,
        psa10_price:   prices.psa10_price ? Math.round(prices.psa10_price) : null,
        raw_price:     prices.raw_price   ? Math.round(prices.raw_price)   : null,
        momentum_pct:  Math.round(scores.momentumPct * 10) / 10,
        psa_ratio:     Math.round(scores.psaRatio * 10) / 10,
        score:         Math.round(scores.totalScore * 1000) / 1000,
        triggers,
        last_updated:  prices.last_updated,
      });

      fetched++;
    } catch(e) {
      failed++;
    }

    await sleep(DELAY);
  }

  process.stdout.write("\n\n");
  console.log(`Fetched: ${fetched} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log(`Results: ${results.length} cards passed filters\n`);

  // ── Build output ──────────────────────────────────────────────
  const sorted       = [...results].sort((a, b) => b.score - a.score);
  const momentum_up  = results.filter(r => r.triggers.includes("momentum_up"))
                              .sort((a, b) => b.momentum_pct - a.momentum_pct)
                              .slice(0, 10);
  const momentum_dn  = results.filter(r => r.triggers.includes("momentum_down"))
                              .sort((a, b) => a.momentum_pct - b.momentum_pct)
                              .slice(0, 10);
  const grade_targets = results.filter(r => r.triggers.includes("grade_target"))
                               .sort((a, b) => b.psa_ratio - a.psa_ratio)
                               .slice(0, 8);
  const flip_ops     = results.filter(r => r.triggers.includes("flip_opportunity"))
                              .sort((a, b) => {
                                const sA = (a.market_price||0) - (a.lowest_listing||0);
                                const sB = (b.market_price||0) - (b.lowest_listing||0);
                                return sB - sA;
                              })
                              .slice(0, 8);

  const output = {
    generated:     new Date().toISOString(),
    generated_date: new Date().toISOString().substring(0, 10),
    cards_scanned: allCards.length,
    cards_tracked: results.length,
    gbp_rate:      gbpRate,
    momentum_up,
    momentum_down: momentum_dn,
    grade_targets,
    flip_opportunities: flip_ops,
    top_overall:   sorted.slice(0, 15),
    all_tracked:   sorted, // full dataset for advanced use
  };

  fs.writeFileSync("daily-movers.json", JSON.stringify(output, null, 2));
  console.log(`✓ Written daily-movers.json`);

  // Summary
  console.log(`\nTop 5 momentum cards:`);
  momentum_up.slice(0, 5).forEach(c =>
    console.log(`  ${c.name.padEnd(30)} ▲${c.momentum_pct.toFixed(1)}%  £${c.market_price||"—"}`)
  );
  if (momentum_dn.length) {
    console.log(`\nTop 3 falling cards:`);
    momentum_dn.slice(0, 3).forEach(c =>
      console.log(`  ${c.name.padEnd(30)} ▼${Math.abs(c.momentum_pct).toFixed(1)}%  £${c.market_price||"—"}`)
    );
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
