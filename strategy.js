/* BlueEdge US strategy: odds scalping.
 * Buy cheap ("low odds") YES or NO contracts on fast-moving, high-volume live US markets, then
 * exit once the price has scalped up to a target — or cut losses / bail on a timeout if it hasn't.
 *
 * Simplification worth knowing: Polymarket US markets expose one set of bestBid/bestAsk/lastTradePrice
 * (the "long"/YES side). For ordinary binary (2-outcome) markets, the NO side's price is treated here
 * as the complement (1 − YES). Markets reporting more than 2 sides (3-way soccer, multi-runner props)
 * are skipped rather than guessed at.
 */
window.BlueEdgeStrategy = (() => {
  const SPEEDS = {
    quick: { label: "Quick", hint: "closes within ~3h", horizonMs: 3 * 3600000 },
    standard: { label: "Standard", hint: "closes within ~24h", horizonMs: 24 * 3600000 },
    wide: { label: "Wide", hint: "closes within ~7d", horizonMs: 7 * 24 * 3600000 },
  };

  const DEFAULTS = {
    speed: "quick",
    minOdds: 0.05, maxOdds: 0.25,       // "low odds" entry band
    targetGain: 0.10,                    // sell once price is this much above entry
    stopLoss: 0.05,                      // bail if price falls this much below entry
    maxHoldMin: 45,                      // force an exit after this long regardless
    stakeUsd: 5,                         // dollars per entry
    maxOpen: 4,                          // concurrent open positions
    minVolume24h: 2000,                  // USD
    minLiquidity: 500,                   // USD
    maxSpread: 0.05,                     // bestAsk - bestBid ceiling
  };

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  // A market is only considered if it's genuinely tradeable: open, binary, inside the chosen
  // time horizon, with enough volume/liquidity and a sane spread — noisy/illiquid markets make
  // for bad fills regardless of how cheap the odds look.
  function candidateSides(m, cfg) {
    if (!m || m.active === false || m.closed === true || m.archived === true) return [];
    if (Array.isArray(m.marketSides) && m.marketSides.length > 2) return [];
    const end = m.endDate || m.endDateIso || m.end_date_min || m.gameStartTime;
    if (end) { const t = Date.parse(end); if (Number.isFinite(t) && t - Date.now() > cfg.horizonMs) return []; }
    const vol = num(m.volume24hr ?? m.volumeNum ?? m.volume);
    const liq = num(m.liquidityNum ?? m.liquidity);
    if (vol == null || vol < cfg.minVolume24h) return [];
    if (liq == null || liq < cfg.minLiquidity) return [];
    const bid = num(m.bestBid), ask = num(m.bestAsk);
    if (bid == null || ask == null || ask <= bid) return [];
    if (ask - bid > cfg.maxSpread) return [];

    const out = [];
    if (ask >= cfg.minOdds && ask <= cfg.maxOdds) out.push({ side: "YES", price: ask });
    const noAsk = 1 - bid; // complement approximation, see file header
    if (noAsk >= cfg.minOdds && noAsk <= cfg.maxOdds) out.push({ side: "NO", price: Number(noAsk.toFixed(4)) });
    return out.map(s => ({ ...s, market: m, vol, liq, spread: ask - bid }));
  }

  // Rank scanned markets into buy candidates, best (highest volume, tightest spread) first.
  function scanForEntries(markets, cfg, alreadyHeldSlugs) {
    const held = alreadyHeldSlugs instanceof Set ? alreadyHeldSlugs : new Set(alreadyHeldSlugs || []);
    const all = [];
    for (const m of markets || []) {
      if (held.has(m.slug)) continue;
      for (const c of candidateSides(m, cfg)) all.push(c);
    }
    all.sort((a, b) => (b.vol - a.vol) || (a.spread - b.spread));
    return all;
  }

  // Given an open trade and the market's current price for the side we hold, decide what to do.
  function evaluateExit(trade, currentPrice, cfg) {
    const heldMin = (Date.now() - trade.openedAt) / 60000;
    // Timeout is a hard safety valve and must fire even if we've lost price visibility on this
    // market (e.g. it fell out of the top-100-by-volume scan window) — a position must never be
    // able to sit open forever just because we stopped seeing a fresh price for it.
    if (heldMin >= cfg.maxHoldMin) return { action: "timeout", price: currentPrice ?? null };
    if (currentPrice == null) return { action: "hold" };
    if (currentPrice >= trade.entry + cfg.targetGain) return { action: "target", price: currentPrice };
    if (currentPrice <= trade.entry - cfg.stopLoss) return { action: "stop", price: currentPrice };
    return { action: "hold" };
  }

  // Current price for whichever side a trade holds, from a fresh market row (same complement rule).
  function priceForSide(m, side) {
    const bid = num(m?.bestBid), ask = num(m?.bestAsk);
    if (bid == null || ask == null) return null;
    return side === "NO" ? Number((1 - ask).toFixed(4)) : ask; // exiting NO: buy back at YES's ask complement
  }

  function stakeFor(cfg, buyingPower) {
    return Math.max(1, Math.min(cfg.stakeUsd, Math.floor((buyingPower ?? cfg.stakeUsd) * 0.9)));
  }

  return { SPEEDS, DEFAULTS, candidateSides, scanForEntries, evaluateExit, priceForSide, stakeFor };
})();
