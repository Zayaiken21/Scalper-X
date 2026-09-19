/* BlueEdge US strategy: odds scalping.
 * Buy cheap ("low odds") YES or NO contracts on active, liquid US markets, then exit once the price has
 * moved up to a target — or cut the loss / bail on a timeout if it hasn't.
 *
 * Price model (docs.polymarket.us/concepts/orders): every market has ONE instrument, the YES side, and
 * NO = 1 − YES. So for a YES holder the exit price is the bid; for a NO holder the exit price is 1 − ask.
 * Entry is the opposite side of the book: YES pays the ask, NO pays 1 − bid.
 * Markets with more than two sides (3-way soccer, multi-runner props) are skipped rather than guessed at.
 *
 * Field names follow the real Markets schema: bestBidQuote / bestAskQuote (Amount objects), volume24hr in
 * CONTRACTS (not dollars), endDate, marketSides[]. There is no liquidity field on the list endpoint, so depth
 * is checked per-candidate from the BBO call just before buying.
 */
window.BlueEdgeStrategy = (() => {
  const TAKER_THETA = 0.0695; // fee = theta × contracts × p × (1−p), per docs.polymarket.us/fees (effective Sep 17, 2026)

  // The strategy decides the trade shape. The user only controls risk: stake, stop loss, how many trades, daily loss cap.
  const HORIZONS = [3 * 3600000, 24 * 3600000, 7 * 24 * 3600000]; // tries markets closing soon first, widens only if too few candidates
  const DEFAULTS = {
    stakeUsd: 5,          // dollars per entry
    stopLoss: 0.05,       // bail if the exit price falls this far below entry
    maxOpen: 4,           // concurrent bot positions
    dailyLossLimit: 15,   // stop opening new trades after losing this much today ($). 0 = off
  };
  const LIMITS = { stakeUsd: [1, 1000], stopLoss: [0.02, 0.2], maxOpen: [1, 10, true], dailyLossLimit: [0, 100000] };

  // Everything else is derived from the stop loss, so the numbers always agree with each other.
  const ODDS_FLOOR = 0.04, ODDS_CEIL = 0.40, MIN_VOLUME = 500, MAX_HOLD_MIN = 45, MAX_COST_RATIO = 0.5;
  function plan(cfg) {
    const stop = cfg.stopLoss;
    return { stop, target: Math.min(0.3, r4(stop * 2)),        // 2:1 reward-to-risk
      maxSpread: Math.min(0.04, Math.max(0.01, r4(stop * 0.6))), // you buy the ask and sell the bid, so the spread must stay well inside the stop
      maxHoldMin: MAX_HOLD_MIN, minVolume: MIN_VOLUME };
  }

  function sanitize(raw) {
    const cfg = { ...DEFAULTS };
    for (const [k, v] of Object.entries(raw || {})) {
      if (!LIMITS[k]) continue; // older saved settings (odds band, spread, speed...) are ignored: the strategy owns those now
      const n = Number(v); if (!Number.isFinite(n)) continue;
      const [lo, hi, int] = LIMITS[k];
      cfg[k] = Math.min(hi, Math.max(lo, int ? Math.round(n) : n));
    }
    return cfg;
  }
  // Returns {ok, value} or {ok:false, message} for a single field the user typed.
  function validateField(k, text) {
    const lim = LIMITS[k]; if (!lim) return { ok: false, message: "Unknown setting." };
    const t = String(text ?? "").trim().replace(",", ".");
    const n = Number(t);
    if (t === "" || !Number.isFinite(n)) return { ok: false, message: "Enter a number." };
    if (n < lim[0] || n > lim[1]) return { ok: false, message: `Use a value between ${lim[0]} and ${lim[1]}.` };
    return { ok: true, value: lim[2] ? Math.round(n) : n };
  }

  const num = v => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const amt = a => (a != null && typeof a === "object") ? num(a.value) : num(a); // {value:"0.12",currency:"USD"} or a bare number/string
  const r4 = x => Number(x.toFixed(4));
  const r2 = x => Math.round(x * 100) / 100;

  // Best bid/ask for the YES side from either a Markets row or a BBO response.
  function quotesOf(m) {
    const src = m?.marketData || m || {};
    const bid = amt(src.bestBidQuote) ?? amt(src.bestBid);
    const ask = amt(src.bestAskQuote) ?? amt(src.bestAsk);
    return { bid, ask, bidDepth: num(src.bidDepth), askDepth: num(src.askDepth) };
  }
  const validQuotes = q => q && q.bid != null && q.ask != null && q.bid > 0 && q.ask < 1 && q.ask > q.bid;

  const fee = (qty, price) => r2(TAKER_THETA * qty * price * (1 - price));
  const feeUnit = price => TAKER_THETA * price * (1 - price); // unrounded, per contract

  // Which sides (if any) are worth buying right now, given fresh YES-side quotes. A side qualifies when its stop and
  // target are both reachable and the round-trip cost (spread + taker fees on both legs) takes at most half the target.
  function sidesFromQuotes(q, cfg) {
    const pl = plan(cfg);
    if (!validQuotes(q) || q.ask - q.bid > pl.maxSpread + 1e-9) return [];
    const spread = q.ask - q.bid, out = [];
    for (const [side, price] of [["YES", q.ask], ["NO", 1 - q.bid]]) {
      if (price < ODDS_FLOOR || price > ODDS_CEIL) continue;
      if (price - pl.stop < 0.01 || price + pl.target > 0.97) continue;
      const cost = spread + feeUnit(price) + feeUnit(price + pl.target);
      const costRatio = cost / pl.target;
      if (costRatio <= MAX_COST_RATIO) out.push({ side, price: r4(price), costRatio });
    }
    return out;
  }

  // A market is only considered if it's genuinely tradeable: open, binary, closing inside the horizon, with enough
  // volume and a tight spread — noisy/illiquid markets make for bad fills however cheap the odds look.
  function candidateSides(m, cfg, horizonMs = HORIZONS[0]) {
    if (!m || !m.slug) return [];
    if (m.active === false || m.closed === true || m.archived === true || m.hidden === true) return [];
    if (Array.isArray(m.marketSides)) {
      if (m.marketSides.length > 2) return [];
      if (m.marketSides.some(s => s.tradable === false)) return [];
    }
    if (m.endDate) { const t = Date.parse(m.endDate); if (Number.isFinite(t) && t - Date.now() > horizonMs) return []; } // a past endDate is fine: live games can carry their scheduled time
    const vol = num(m.volume24hr);
    if (vol == null || vol < plan(cfg).minVolume) return [];
    const q = quotesOf(m);
    return sidesFromQuotes(q, cfg).map(s => ({ ...s, market: m, vol, spread: q.ask - q.bid, score: (1 - s.costRatio) * Math.log10(vol + 10) }));
  }

  // Rank buy candidates: cheapest round-trip cost relative to the target, weighted by how much the market trades.
  function scanForEntries(markets, cfg, excludeSlugs, horizonMs) {
    const skip = excludeSlugs instanceof Set ? excludeSlugs : new Set(excludeSlugs || []);
    const all = [];
    for (const m of markets || []) { if (skip.has(m.slug)) continue; for (const c of candidateSides(m, cfg, horizonMs)) all.push(c); }
    all.sort((a, b) => (b.score - a.score) || (b.vol - a.vol));
    return all;
  }
  // The price range the strategy is choosing from right now (its best candidates), for display.
  function autoBand(cands) {
    const top = (cands || []).slice(0, 10).map(c => c.price);
    return top.length ? { min: Math.min(...top), max: Math.max(...top) } : null;
  }

  // What you'd RECEIVE selling the side you hold, and what you'd PAY buying it.
  const exitPrice = (q, side) => !validQuotes(q) ? null : r4(side === "NO" ? 1 - q.ask : q.bid);
  const entryPrice = (q, side) => !validQuotes(q) ? null : r4(side === "NO" ? 1 - q.bid : q.ask);

  // Decide what to do with an open trade given the current exit price (null if we can't see one).
  function evaluateExit(trade, mark, cfg) {
    const pl = plan(cfg), heldMin = (Date.now() - trade.openedAt) / 60000;
    // The timeout must fire even when we've lost price visibility — nothing may sit open forever.
    if (heldMin >= pl.maxHoldMin) return { action: "timeout", price: mark ?? null };
    if (mark == null) return { action: "hold" };
    if (mark >= Math.min(trade.entry + pl.target, 0.99)) return { action: "target", price: mark };
    if (mark <= trade.entry - pl.stop) return { action: "stop", price: mark };
    return { action: "hold" };
  }

  // If the API reports a NO fill in YES terms, this picks whichever reading is closest to what we expected.
  function fillPxForSide(px, side, expected) {
    if (px == null) return null;
    if (side !== "NO" || expected == null) return px;
    return Math.abs(px - expected) <= Math.abs((1 - px) - expected) ? px : r4(1 - px);
  }

  // Net of taker fees on both legs (entry and exit are both market orders).
  const netPnl = (entry, exit, qty) => r2((exit - entry) * qty - fee(qty, entry) - fee(qty, exit));

  function stakeFor(cfg, buyingPower) {
    return Math.max(1, Math.min(cfg.stakeUsd, Math.floor((buyingPower ?? cfg.stakeUsd) * 0.9)));
  }

  return { HORIZONS, DEFAULTS, LIMITS, plan, sanitize, validateField, quotesOf, validQuotes, sidesFromQuotes, candidateSides, scanForEntries, autoBand, exitPrice, entryPrice, evaluateExit, fillPxForSide, fee, netPnl, stakeFor, amt, num };
})();
