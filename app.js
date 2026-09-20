/* BlueEdge US app shell — odds scalper on Polymarket US. */
(() => {
  "use strict";
  const A = window.BlueEdgeAccount, S = window.BlueEdgeStrategy, PUB = window.PolyUS.publicClient();
  const $ = sel => document.querySelector(sel);
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = v => v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
  const smoney = v => v == null ? "—" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  const cents = v => v == null ? "—" : `${(v * 100).toFixed(1)}¢`;
  const CFG_KEY = "blueedgeus.cfg", TRADES_KEY = "blueedgeus.trades";
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  /* ---------- state ---------- */
  let cfg = S.sanitize(store.get(CFG_KEY, {}));
  let trades = (store.get(TRADES_KEY, []) || []).filter(t => t && t.marketSlug && t.status !== "failed");
  let botOn = false;                       // the bot always starts OFF after a reload — real money should never resume unattended
  let view = "home", botNote = "Bot is off.";
  const scan = { rows: [], at: 0, error: "", scanning: false, horizonMs: Infinity, games: 0, sum: null };
  const bboCache = new Map();              // slug -> { q, at }: per-market price lookups, reused for 15s
  const drafts = {};                       // what the user has typed but not saved yet — survives any redraw
  const ui = { busy: null, formError: "", diag: null, diagRunning: false, forgotOpen: false, connectNew: false, allowReset: true, reveal: {} };
  let entryFails = 0, entryPausedUntil = 0;
  const REFRESH_MS = 10000, SCAN_MS = 8000, TICK_MS = 2000, COOLDOWN_MS = 10 * 60000;
  // After any 429 the app halves its own polling for a minute, so it can never keep pushing against a limit.
  const slow = () => (Date.now() - window.PolyUS.rateInfo().last429 < 60000 ? 2 : 1);

  const saveCfg = () => store.set(CFG_KEY, { ...(store.get(CFG_KEY, {}) || {}), ...cfg }); // merges into what's already stored, so older saved settings are never dropped
  function saveTrades() {
    const done = trades.filter(t => t.status === "closed").slice(-150);
    trades = trades.filter(t => t.status === "open" || t.status === "pending" || done.includes(t)); // history pruning must never drop a live trade
    store.set(TRADES_KEY, trades.map(({ closing, ...t }) => t));
  }

  /* ---------- toasts ---------- */
  function toast(msg, kind) {
    const host = $("#toasts"); if (!host) return;
    const el = document.createElement("div"); el.className = `toast ${kind || ""}`;
    const span = document.createElement("span"); span.textContent = msg; el.appendChild(span);
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, kind === "bad" ? 6000 : 3500);
  }

  /* ---------- serialise everything that mutates trades (loop + manual taps) ---------- */
  let chain = Promise.resolve();
  const exclusive = fn => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- market data ---------- */
  const byVolume = (a, b) => (S.num(b.volume24hr) || 0) - (S.num(a.volume24hr) || 0);
  /* ---------- personalisation + live game state ---------- */
  const PREFS_KEY = "blueedgeus.prefs";
  const prefs = { leagues: [], skipBreaks: true, ...(store.get(PREFS_KEY, {}) || {}) };
  if (!Array.isArray(prefs.leagues)) prefs.leagues = [];
  const savePrefs = () => store.set(PREFS_KEY, { leagues: prefs.leagues, skipBreaks: !!prefs.skipBreaks });
  const leagueOk = m => !prefs.leagues.length || prefs.leagues.includes(m._league);
  const gameInfo = new Map();            // event slug -> latest live state {live, ended, score, period, clock, start, at}
  const BREAK_RE = /^(ht\b|half\s*-?\s*time|end\b|ft\b|final|break|intermission|delay|suspended|postponed|stopped)/i;
  const isBreak = p => BREAK_RE.test(String(p || "").trim());
  const PERIODS = { "1h": "1st half", "2h": "2nd half", ht: "Halftime", ft: "Final", "ft ot": "Final (OT)", "ft nr": "Final (no result)" };
  const periodText = p => { const t = String(p || "").trim(); return PERIODS[t.toLowerCase()] || t; };
  const scoreText = s => s == null ? "" : typeof s === "object" ? Object.values(s).filter(v => v != null && typeof v !== "object").join("–") : String(s).replace(/\s*-\s*/, "–");
  const stateOf = ev => ({ live: ev.live === true, ended: ev.ended === true, score: scoreText(ev.score), period: ev.period ? String(ev.period) : "", clock: ev.elapsed ? String(ev.elapsed) : (ev.clock ? String(ev.clock) : ""), start: Date.parse(ev.startTime || ev.startDate || "") || null, at: Date.now() });
  // Which team is YES: the side flagged long. Names are only used when both sides carry a team, so a label is never guessed.
  function sidesOf(m) {
    const ss = Array.isArray(m?.marketSides) ? m.marketSides : [];
    const long = ss.find(x => x.long === true), short = ss.find(x => x.long === false);
    const nm = x => String(x?.team?.name || x?.team?.safeName || x?.description || "").trim();
    return { yes: nm(long), no: nm(short), named: !!(long?.team && short?.team && nm(long) && nm(short)) };
  }
  const pickName = (m, side) => { const s = sidesOf(m); return s.named ? (side === "NO" ? s.no : s.yes) : side; };
  const leagueOf = (ev, m) => String((m.marketSides || []).map(x => x.team?.league).find(Boolean) || ev.seriesSlug || String(ev.slug || "").split("-")[0] || "Other").toUpperCase();
  function liveBadge(g) {
    if (!g) return "";
    if (g.ended) return `<span class="pill bad">Game over${g.score ? ` · ${esc(g.score)}` : ""}</span>`;
    if (!g.live) return `<span class="pill warn">Not live</span>`;
    const bits = [periodText(g.period), g.clock, g.score ? `Score ${g.score}` : ""].filter(Boolean).map(esc).join(" · ");
    return `<span class="pill live">● LIVE${bits ? ` · ${bits}` : ""}</span><span class="age" data-ts="${g.at}"></span>`;
  }

  // LIVE means a game being played right now — Polymarket's own "Live" tab (event.live === true) — never every market on the
  // platform. A live game lists 200+ markets (props, spreads, halves); only its main line is kept. One list request, cached.
  async function fetchLive() {
    const pull = async (params, offset) => (await PUB.events({ limit: 100, offset, ...params }))?.events || [];
    const all = []; let mode = { live: true, active: true, closed: false };
    for (let page = 0; page < 3; page++) {
      let evs;
      try { evs = await pull(mode, page * 100); }
      catch (e) {
        if (page === 0 && mode.closed !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) { mode = { live: true }; evs = await pull(mode, 0); }
        else throw e;
      }
      all.push(...evs); if (evs.length < 100) break;
    }
    // Fail closed: with no live flag on the events there is no way to know what is in play, so show and trade nothing.
    if (all.length && !all.some(e => typeof e.live === "boolean")) throw new Error("Polymarket's game list didn't say which games are live, so nothing is shown or traded.");
    const now = Date.now(), hidden = { future: 0, farEnd: 0 }, rows = [], seen = new Set(); let games = 0, sample = null;
    for (const ev of all) {
      if (ev.live !== true || ev.ended === true || String(ev.category || "").toLowerCase() === "crypto") continue;
      const g = stateOf(ev);
      if (g.start && g.start > now + 120000) { hidden.future++; continue; }      // flagged live but the start time is still ahead
      const mains = S.mainMarkets(ev.markets).filter(m => { const end = Date.parse(m.endDate || ""); if (Number.isFinite(end) && end - now > 36 * 3600000) { hidden.farEnd++; return false; } return true; }); // futures / later-dated lines are not today's game
      if (!mains.length) continue;
      games++; gameInfo.set(ev.slug, g);
      if (!sample && (ev.score || ev.period)) sample = { slug: ev.slug, live: ev.live, score: ev.score, period: ev.period, elapsed: ev.elapsed, startTime: ev.startTime, sides: (mains[0].marketSides || []).map(x => ({ team: x.team?.name || x.description, long: x.long, ordering: x.team?.ordering })) };
      for (const m of mains) {
        if (seen.has(m.slug)) continue; seen.add(m.slug);
        rows.push({ ...m, _live: true, _eventSlug: ev.slug, _league: leagueOf(ev, m), _event: ev.title || "" });
      }
    }
    return { rows: rows.sort(byVolume), games, hidden, sample };
  }
  async function fetchGame(slug) { // one game's fresh state (score, period, clock, live flag)
    const r = await PUB.eventBySlug(slug), ev = r?.event || r;
    if (!ev || typeof ev.live !== "boolean") throw new Error("no live flag in the reply");
    const g = stateOf(ev); gameInfo.set(slug, g); return g;
  }
  // The gate in front of every buy, bot or manual: the game must be live RIGHT NOW according to Polymarket, checked fresh.
  async function confirmLive(row, { manual } = {}) {
    const slug = row?._eventSlug;
    if (!slug) return { ok: false, why: "Couldn't identify the game for this market." };
    let g = gameInfo.get(slug);
    if (!g || Date.now() - g.at > 8000) { try { g = await fetchGame(slug); } catch (e) { return { ok: false, why: `Couldn't confirm the game is live (${e.message}).` }; } }
    if (g.ended) return { ok: false, why: "That game is over." };
    if (!g.live) return { ok: false, why: "That game isn't live right now." };
    if (g.start && g.start > Date.now() + 120000) return { ok: false, why: "That game hasn't started yet." };
    if (!manual && prefs.skipBreaks && isBreak(g.period)) return { ok: false, why: `Skipping the break (${periodText(g.period)}).`, soft: true };
    return { ok: true, g };
  }
  // Keeps score/period/clock current for the games you hold trades in (one small request per game, at most every 12s).
  async function refreshGames() {
    for (const slug of new Set(trades.filter(openish).map(t => t.eventSlug).filter(Boolean))) {
      const g = gameInfo.get(slug); if (g && Date.now() - g.at < 12000 * slow()) continue;
      try { await fetchGame(slug); } catch {}
    }
  }
  // The list endpoint doesn't always carry live prices. For the busiest markets missing them, ask for the best bid/offer
  // directly — capped per pass and cached, so this stays a handful of requests, never a flood.
  async function fillQuotes(rows) {
    let budget = 16;
    for (const m of rows) {
      if (S.validQuotes(S.quotesOf(m))) continue;
      let c = bboCache.get(m.slug);
      if (!c || Date.now() - c.at > 15000) {
        if (budget-- <= 0) continue;
        let q = null; try { const r = S.quotesOf(await PUB.bbo(m.slug)); if (S.validQuotes(r)) q = r; } catch {}
        c = { q, at: Date.now() }; bboCache.set(m.slug, c);
      }
      if (c.q) { m.bestBidQuote = c.q.bid; m.bestAskQuote = c.q.ask; if (c.q.bidDepth != null) m.bidDepth = c.q.bidDepth; if (c.q.askDepth != null) m.askDepth = c.q.askDepth; }
    }
  }
  const LIVE_MS = 30000, liveCache = { rows: [], games: 0, hidden: {}, sample: null, at: 0 };
  // The live-game list is the heavy request, so it is refreshed every 30s (twice as slowly after any 429); per-market
  // prices in between come from cached best-bid/offer lookups, and every buy is re-checked on a fresh quote first.
  async function runScan() {
    scan.scanning = true;
    try {
      if (!liveCache.at || Date.now() - liveCache.at > LIVE_MS * slow()) { const r = await fetchLive(); Object.assign(liveCache, { rows: r.rows, games: r.games, hidden: r.hidden, sample: r.sample, at: Date.now() }); }
      await fillQuotes(liveCache.rows);
      scan.rows = liveCache.rows; scan.games = liveCache.games; scan.horizonMs = Infinity; scan.at = Date.now(); scan.error = ""; scan.sum = S.summarize(scan.rows, cfg, Infinity);
    } catch (e) {
      scan.error = e.message; scan.at = Date.now();
      if (Date.now() - liveCache.at > 120000) scan.rows = []; // never keep trading off a list that has gone stale
    }
    scan.scanning = false;
  }
  // Fresh YES-side quotes for one market: BBO first, falling back to the latest scan row.
  async function quotesFor(slug) {
    try { const q = S.quotesOf(await PUB.bbo(slug)); if (S.validQuotes(q)) return q; } catch {}
    const row = scan.rows.find(m => m.slug === slug); const q = row && S.quotesOf(row);
    return S.validQuotes(q) ? q : null;
  }

  /* ---------- text helpers ---------- */
  const label = t => (t.question || t.marketSlug || "").slice(0, 48);
  const reasonText = r => ({ target: "target hit", stop: "stop loss", timeout: "time limit", manual: "closed by you", external: "closed elsewhere" }[r] || r || "closed");
  const ago = ms => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

  /* ---------- trade lifecycle ---------- */
  const openish = t => t.status === "open" || t.status === "pending";
  const todayPnl = () => trades.filter(t => t.status === "closed" && Date.now() - t.closedAt < 86400000).reduce((s, t) => s + (t.pnl || 0), 0);
  const uid = () => "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Compare the bot's books with the exchange's positions: settle trades that vanished, promote orders whose reply was lost.
  function reconcile() {
    if (!A.isUnlocked() || !A.state.positionsAt) return;
    const now = Date.now(), posAt = A.state.positionsAt, pos = new Map(A.state.positions.map(p => [p.slug, p]));
    for (const t of trades) {
      const p = pos.get(t.marketSlug);
      if (t.status === "pending") {
        if (posAt < t.openedAt + 4000) continue; // this positions list predates the order
        if (p) {
          t.status = "open"; t.quantity = p.qty;
          if (p.cost && p.qty) t.entry = S.fillPxForSide(Number((p.cost / p.qty).toFixed(4)), t.side, t.entry) ?? t.entry;
        } else if (now - t.openedAt > 45000) t.status = "failed";
      } else if (t.status === "open" && !t.closing) {
        if (posAt < t.openedAt + 8000) continue;
        if (!p) {
          const exit = t.pendingExit ?? t.mark ?? null;
          Object.assign(t, { status: "closed", closedAt: now, reason: t.pendingReason || "external", exit, est: true });
          t.pnl = exit != null && t.quantity ? Number((S.netPnl(t.entry, exit, t.quantity) + (t.partialPnl || 0)).toFixed(2)) : (t.partialPnl ?? null);
        } else if (Math.abs(p.qty - t.quantity) > 1e-6) t.quantity = p.qty;
      }
    }
    trades = trades.filter(t => t.status !== "failed");
    saveTrades();
  }

  async function closeTrade(t, reason, hintPx) {
    t.closing = true; t.pendingReason = reason; t.pendingExit = hintPx ?? null;
    try {
      const r = await A.closeNow({ marketSlug: t.marketSlug });
      if (r.rejected) throw new Error(r.reason || "Close order rejected.");
      if (r.filledQty > 0) {
        const px = S.fillPxForSide(r.avgPx, t.side, hintPx ?? t.mark) ?? hintPx ?? t.mark;
        const left = t.quantity - r.filledQty;
        if (left > Math.max(0.01, t.quantity * 0.02)) { // partial fill: bank it, keep managing the rest
          t.partialPnl = (t.partialPnl || 0) + S.netPnl(t.entry, px, r.filledQty); t.quantity = left; t.nextCloseAt = Date.now() + 2000;
        } else {
          Object.assign(t, { status: "closed", closedAt: Date.now(), exit: px, reason, est: false });
          t.pnl = Number(((t.partialPnl || 0) + S.netPnl(t.entry, px, r.filledQty)).toFixed(2));
          toast(`Closed ${label(t)} (${reasonText(reason)}) ${smoney(t.pnl)}`, t.pnl >= 0 ? "good" : "bad");
        }
        A.state.lastRefresh = 0; // pull a fresh balance next tick
      } else if (r.terminal || r.hadExecutions) {
        throw new Error("The close order didn't fill.");
      } else t.nextCloseAt = Date.now() + 4000; // no verdict from the exchange: reconcile() confirms via positions
    } catch (e) {
      t.closeErrors = (t.closeErrors || 0) + 1;
      t.nextCloseAt = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(t.closeErrors, 4));
      botNote = `Couldn't close ${label(t)}: ${e.message}`; toast(botNote, "bad");
    } finally { t.closing = false; saveTrades(); }
  }

  async function manageTrades() {
    reconcile();
    for (const t of trades.filter(x => x.status === "open" && !x.closing)) {
      if (t.nextCloseAt && Date.now() < t.nextCloseAt) continue;
      const q = await quotesFor(t.marketSlug);
      const mark = q ? S.exitPrice(q, t.side) : null;
      if (mark != null) { t.mark = mark; t.markAt = Date.now(); }
      const v = S.evaluateExit(t, mark, cfg);
      if (v.action !== "hold") await closeTrade(t, v.action, v.price);
    }
    saveTrades();
  }

  // Places one buy and tracks it write-ahead: the trade is recorded BEFORE the order goes out, so a lost reply
  // (network drop, timeout) can never leave an untracked position — reconcile() finds it from the exchange.
  async function openTrade({ marketSlug, question, side, expectedPx, usd, manual, eventSlug, pick, league }) {
    const t = { id: uid(), marketSlug, question, side, entry: expectedPx, quantity: null, stake: usd, openedAt: Date.now(), status: "pending", manual: !!manual, eventSlug: eventSlug || null, pick: pick || side, league: league || "" };
    trades.push(t); saveTrades();
    const drop = () => { trades = trades.filter(x => x !== t); saveTrades(); };
    try {
      const r = await A.buyMarket({ marketSlug, side, usd });
      if (r.rejected) { drop(); throw new Error(r.reason || "Order rejected."); }
      if (r.filledQty > 0) {
        t.status = "open"; t.quantity = r.filledQty;
        t.entry = S.fillPxForSide(r.avgPx, side, expectedPx) ?? expectedPx;
        t.stake = Number((t.entry * t.quantity).toFixed(2)); t.openedAt = Date.now();
        saveTrades(); A.state.lastRefresh = 0;
        return t;
      }
      if (r.terminal) { drop(); throw new Error("No fill — the market moved before the order matched."); }
      return t; // no verdict yet: stays pending until the exchange's positions confirm it
    } catch (e) {
      if (["network", "timeout", "server"].includes(e.kind)) { A.state.lastRefresh = 0; throw new Error(`${e.message} The order may have gone through — checking your positions.`); }
      if (trades.includes(t)) drop();
      throw e;
    }
  }

  async function enterTrades() {
    if (!botOn || !A.isUnlocked()) return;
    const now = Date.now();
    if (now < entryPausedUntil) { botNote = `Paused after repeated order errors — retrying in ${Math.ceil((entryPausedUntil - now) / 1000)}s.`; return; }
    if (cfg.dailyLossLimit > 0 && todayPnl() <= -cfg.dailyLossLimit) { botNote = `Daily loss limit reached (${money(todayPnl())}). No new entries today — open trades still exit normally.`; return; }
    const slots = cfg.maxOpen - trades.filter(openish).length;
    if (slots <= 0) { botNote = `Holding ${cfg.maxOpen} of ${cfg.maxOpen} positions.`; return; }
    const rows = scan.rows.filter(leagueOk);
    if (!rows.length) { botNote = scan.error ? `Market data problem: ${scan.error}` : !scan.at ? "Waiting for the first market scan…" : prefs.leagues.length ? `No live ${prefs.leagues.join(" / ")} games right now.` : "No games are being played right now."; return; }
    const skip = new Set([
      ...trades.filter(openish).map(t => t.marketSlug),
      ...A.state.positions.map(p => p.slug), // never stack onto positions you opened yourself
      ...trades.filter(t => t.status === "closed" && now - t.closedAt < COOLDOWN_MS).map(t => t.marketSlug), // no instant re-entry after an exit
    ]);
    const busyGames = new Set(trades.filter(openish).map(t => t.eventSlug).filter(Boolean)); // one trade per game at a time
    let cands = S.scanForEntries(rows, cfg, skip, scan.horizonMs).filter(c => !busyGames.has(c.market._eventSlug));
    if (prefs.skipBreaks) cands = cands.filter(c => { const g = gameInfo.get(c.market._eventSlug); return !(g && isBreak(g.period)); });
    if (!cands.length) { botNote = `Watching ${new Set(rows.map(m => m._eventSlug)).size} live games, none worth buying yet${scan.sum?.text ? ` (${scan.sum.text})` : ""}.`; return; }
    let placed = 0, tried = 0, lastErr = "";
    for (const c of cands) {
      if (placed >= slots || tried >= slots + 2) break;
      if (busyGames.has(c.market._eventSlug)) continue;
      const stake = S.stakeFor(cfg, A.state.buyingPower);
      if ((A.state.buyingPower ?? 0) < stake) { botNote = `Paused: buying power ${money(A.state.buyingPower)} is below the ${money(stake)} stake.`; return; }
      tried++;
      const q = await quotesFor(c.market.slug); // re-verify on a fresh quote and a live book right before spending money
      const fresh = q && S.sidesFromQuotes(q, cfg).find(s => s.side === c.side);
      if (!fresh || q.bidDepth === 0 || q.askDepth === 0) continue;
      const live = await confirmLive(c.market); // and confirm the game is being played right now
      if (!live.ok) { if (!live.soft) lastErr = `Skipped ${c.market._event || c.market.slug}: ${live.why}`; continue; }
      try {
        const pick = pickName(c.market, c.side);
        const t = await openTrade({ marketSlug: c.market.slug, question: c.market._event || c.market.question || c.market.title || c.market.slug, side: c.side, expectedPx: fresh.price, usd: stake, eventSlug: c.market._eventSlug, pick, league: c.market._league });
        placed++; entryFails = 0; busyGames.add(c.market._eventSlug); A.state.buyingPower = (A.state.buyingPower ?? stake) - stake;
        toast(t.status === "open" ? `Bought ${pick} in ${label(t)} at ${cents(t.entry)}` : `Order sent for ${pick} in ${label(t)} — confirming…`, "good");
      } catch (e) {
        lastErr = `Skipped ${c.market._event || c.market.slug}: ${e.message}`;
        if (!e.transient) { entryFails++; if (entryFails >= 3) { entryFails = 0; entryPausedUntil = Date.now() + 60000; } }
      }
      await sleep(300);
    }
    botNote = placed ? `Opened ${placed} trade${placed > 1 ? "s" : ""}.` : lastErr || `Watching live games. None passed the live check.`;
  }

  /* ---------- the loop ---------- */
  async function tick() {
    const now = Date.now();
    if (A.isUnlocked() && now - A.state.lastRefresh > REFRESH_MS * slow()) await A.refresh().catch(() => {});
    if (((botOn && A.isUnlocked()) || view === "markets") && now - scan.at > SCAN_MS * slow() && !scan.scanning) { await runScan(); render(); }
    if (A.isUnlocked()) {
      await refreshGames().catch(() => {});
      await exclusive(async () => { await manageTrades(); await enterTrades(); });
      if (!botOn) botNote = trades.some(t => t.status === "open") ? "Bot is off — no new entries. Open trades still follow your exit rules." : "Bot is off.";
    } else botNote = A.state.status === "locked" ? "Unlock your account in Settings to run the bot." : "Connect a Polymarket US account in Settings.";
    render(); updateChrome();
  }
  async function loop() { try { await tick(); } catch (e) { console.error(e); } setTimeout(loop, TICK_MS); }

  /* ---------- views ---------- */
  function autoLine() {
    const band = S.autoBand(S.scanForEntries(scan.rows, cfg, new Set(), scan.horizonMs));
    if (!scan.at) return "The strategy trades live games only and picks the prices, targets and timing for you. It will show its chosen range once it has scanned.";
    return band ? `Strategy is buying between ${cents(band.min)} and ${cents(band.max)} right now, on games being played now. Take-profit is set at 2× your stop loss.` : `Watching ${scan.games ?? 0} live games — nothing worth buying right now.`;
  }
  function homeView() {
    const open = trades.filter(t => t.status === "open");
    const unreal = open.reduce((s, t) => s + (t.mark != null && t.quantity ? S.netPnl(t.entry, t.mark, t.quantity) : 0), 0);
    const pnl = todayPnl(), bs = balSummary();
    const cta = A.isUnlocked() ? "" : `<div class="panel" style="margin-bottom:12px"><p class="hint" style="margin:0 0 4px">${A.state.status === "locked" ? "Your account is saved but locked." : "No account connected yet."}</p><a class="btn primary" href="#settings">${A.state.status === "locked" ? "Unlock account" : "Connect account"}</a></div>`;
    return `${cta}
      <div class="panel">
        <div class="block-head"><h2>Odds scalper</h2>
          <button class="btn small ${botOn ? "primary" : ""}" data-act="toggle-bot" aria-pressed="${botOn}">${botOn ? "Bot: ON" : "Bot: OFF"}</button>
        </div>
        <p class="hint" style="margin-top:0">${esc(botNote)}</p>
        <p class="hint auto">${autoLine()}</p>
        <div class="stat-grid">
          <div><span>Cash balance</span><b>${money(bs.cash)}</b></div>
          <div><span>Bonus balance</span><b>${money(bs.bonus)}</b></div>
          <div><span>Withdrawable balance</span><b>${money(bs.withdrawable)}</b></div>
          <div><span>Open trades</span><b>${open.length} / ${cfg.maxOpen}</b></div>
          <div><span>Today, closed</span><b class="${pnl >= 0 ? "gain" : "loss"}">${smoney(pnl)}</b></div>
        </div>
        ${open.length ? `<p class="hint">Unrealized on open trades: <b class="${unreal >= 0 ? "gain" : "loss"}">${smoney(unreal)}</b> (after estimated fees)</p>` : ""}
        ${A.isUnlocked() && A.state.health.ok === false ? `<p class="note bad">${esc(A.state.health.message)}</p>` : ""}
        <p class="hint" data-live="ago"></p>
        ${botOn ? `<p class="hint">Keep this screen open while the bot runs — phones pause web pages that are in the background.</p>` : ""}
      </div>`;
  }

  // Only three balances are shown: cash, bonus and withdrawable.
  function balSummary() {
    const b = A.state.bal;
    if (!b) return { cash: A.state.balance, bonus: null, withdrawable: null };
    return { cash: b.cash, bonus: b.bonus ? b.bonus.value : 0, withdrawable: b.withdrawableReported ? b.withdrawableReported.value : b.withdrawableEst };
  }
  function balanceDetails() {
    const s = balSummary(); if (!A.state.bal) return "";
    const row = (k, v, hint) => `<div class="balrow"><span>${esc(k)}<small>${esc(hint)}</small></span><b>${money(v)}</b></div>`;
    return `<div class="bal-table">
      ${row("Cash balance", s.cash, "Money in your account, not counting positions")}
      ${row("Bonus balance", s.bonus, "Shows $0.00 unless Polymarket reports a bonus on your account")}
      ${row("Withdrawable balance", s.withdrawable, "Cash not tied up in orders, unsettled funds or pending withdrawals")}
    </div>`;
  }

  function leagueCounts() {
    const per = new Map();
    for (const m of scan.rows) { if (!per.has(m._league)) per.set(m._league, new Set()); per.get(m._league).add(m._eventSlug); }
    return [...per.entries()].map(([k, v]) => [k, v.size]).sort((x, y) => y[1] - x[1]);
  }
  const leagueChips = () => `<div class="chips"><button class="chip ${prefs.leagues.length ? "" : "on"}" data-act="pick-league" data-league="">All ${new Set(scan.rows.map(m => m._eventSlug)).size}</button>${leagueCounts().map(([k, n]) => `<button class="chip ${prefs.leagues.includes(k) ? "on" : ""}" data-act="pick-league" data-league="${esc(k)}">${esc(k)} ${n}</button>`).join("")}</div>`;

  function marketRow(m, pick, held, stake) {
    const q = S.quotesOf(m), ok = S.validQuotes(q), vol = S.num(m.volume24hr), sd = sidesOf(m);
    const yesN = sd.named ? sd.yes : "YES", noN = sd.named ? sd.no : "NO";
    const prices = ok ? `<span>${esc(yesN)} ${cents(q.ask)}</span><span>${esc(noN)} ${cents(1 - q.bid)}</span><span>spread ${cents(q.ask - q.bid)}</span>` : `<span>price loading…</span>`;
    const buy = A.isUnlocked() && ok && !held ? `<div class="actions">${["YES", "NO"].map(side => `<button class="btn small ${pick?.side === side ? "primary" : ""}" data-act="manual-buy" data-slug="${esc(m.slug)}" data-side="${side}" ${ui.busy ? "disabled" : ""}>Buy ${esc(side === "YES" ? yesN : noN)} · ${money(stake)}</button>`).join("")}</div>` : "";
    const title = m._event || m.question || m.title || m.slug, sub = !sd.named && m.question && m.question !== m._event ? m.question : "";
    return `<div class="market-card ${held ? "held" : ""}"><b>${esc(title)}</b><span class="league">${esc(m._league || "")}</span>
      ${sub ? `<small class="q">${esc(sub)}</small>` : ""}
      ${liveBadge(gameInfo.get(m._eventSlug))}
      ${pick ? `<span class="pill good" style="margin:6px 0 2px">Strategy pick: ${esc(pickName(m, pick.side))} at ${cents(pick.price)}</span>` : ""}
      <div class="row">${prices}${vol != null ? `<span>${Math.round(vol).toLocaleString()} traded/24h</span>` : ""}</div>${buy}</div>`;
  }
  function marketsView() {
    const rows = scan.rows.filter(leagueOk);
    const picks = new Map();
    for (const c of S.scanForEntries(rows, cfg, new Set(), scan.horizonMs)) if (!picks.has(c.market.slug)) picks.set(c.market.slug, c);
    const held = new Set(trades.filter(openish).map(t => t.marketSlug));
    const sum = scan.sum, stake = S.stakeFor(cfg, A.state.buyingPower), hid = liveCache.hidden || {}, nHid = (hid.future || 0) + (hid.farEnd || 0);
    const status = scan.error && !scan.rows.length ? "Couldn't load live games." : scan.at ? `${new Set(rows.map(m => m._eventSlug)).size} games live now · ${rows.length} tradable lines · ${picks.size} the strategy would buy` : "Loading live games…";
    const head = `<div class="panel"><div class="block-head"><p class="hint" style="margin:0">${esc(status)}</p><button class="btn small" data-act="rescan" ${scan.scanning ? "disabled" : ""}>${scan.scanning ? "Loading…" : "Refresh"}</button></div>
      ${scan.error ? `<p class="note bad">${esc(scan.error)} <a href="#settings">Open Settings → Test connection</a> to see which step fails.</p>` : ""}
      ${scan.rows.length ? leagueChips() : ""}
      <p class="hint" style="margin-bottom:0">Only games being played right now, busiest first — one line per game. Scores and clocks refresh about every 30 seconds. The bot re-checks a game is live before every buy.${nHid ? ` ${nHid} line${nHid > 1 ? "s" : ""} hidden because they aren't today's live games.` : ""}</p>
      ${sum && rows.length && !picks.size ? `<p class="hint">Nothing worth buying right now${sum.text ? ` — skipped: ${esc(sum.text)}` : ""}. You can still buy any live game below by hand.</p>` : ""}</div>`;
    if (!rows.length) return `${head}${scan.at && !scan.error ? `<p class="hint" style="margin-top:12px">${prefs.leagues.length ? "No live games in your selected sports right now." : "No games are being played right now."}</p>` : ""}`;
    return `${head}<div class="market-grid" style="margin-top:12px">${rows.slice(0, 120).map(m => marketRow(m, picks.get(m.slug), held.has(m.slug), stake)).join("")}</div>`;
  }

  function tradeRow(t) {
    const live = t.status === "open", who = t.pick && t.pick !== t.side ? t.pick : t.side;
    const unreal = live && t.mark != null && t.quantity ? S.netPnl(t.entry, t.mark, t.quantity) : null;
    const nums = live
      ? `<span>${esc(who)}</span><span>in ${cents(t.entry)}</span><span>now ${cents(t.mark)}</span><span class="${(unreal ?? 0) >= 0 ? "gain" : "loss"}">${smoney(unreal)}</span><span>${ago(t.openedAt)}</span>`
      : t.status === "pending"
        ? `<span>${esc(who)}</span><span>confirming with Polymarket…</span>`
        : `<span>${esc(who)}</span><span>in ${cents(t.entry)}</span><span>out ${cents(t.exit)}${t.est ? " (est.)" : ""}</span><span class="${(t.pnl ?? 0) >= 0 ? "gain" : "loss"}">${smoney(t.pnl)}</span><span>${esc(reasonText(t.reason))}</span>`;
    const game = live || t.status === "pending" ? liveBadge(gameInfo.get(t.eventSlug)) : "";
    return `<div class="trade-row"><b>${esc(t.question || t.marketSlug)}</b>${t.league ? `<span class="league">${esc(t.league)}</span>` : ""}${game}<div class="row">${nums}</div>
      ${live ? `<div class="actions"><button class="btn small danger" data-act="close-trade" data-id="${esc(t.id)}" ${ui.busy ? "disabled" : ""}>Close now</button></div>` : ""}</div>`;
  }
  function tradesView() {
    const open = trades.filter(openish).sort((a, b) => b.openedAt - a.openedAt);
    const closed = trades.filter(t => t.status === "closed").sort((a, b) => b.closedAt - a.closedAt).slice(0, 40);
    const tracked = new Set(trades.filter(openish).map(t => t.marketSlug));
    const other = A.state.positions.filter(p => !tracked.has(p.slug));
    return `${open.length ? `<div class="actions"><button class="btn small danger" data-act="panic" ${ui.busy ? "disabled" : ""}>Stop bot &amp; close all bot trades</button></div>` : ""}
      <div class="block" style="margin-top:14px"><div class="block-head"><h2>Open (${open.length})</h2></div>${open.map(tradeRow).join("") || `<p class="hint">No open trades.</p>`}</div>
      ${other.length ? `<div class="block"><div class="block-head"><h2>Other positions</h2></div><p class="hint" style="margin:-6px 0 10px">On your account but not opened by the bot. The bot won't touch these.</p>
        ${other.map(p => `<div class="trade-row"><b>${esc(p.title)}</b><div class="row"><span>${p.side}</span><span>${p.qty} contracts</span>${p.cashValue != null ? `<span class="${p.cashValue >= 0 ? "gain" : "loss"}">${smoney(p.cashValue)}</span>` : ""}</div>
        <div class="actions"><button class="btn small danger" data-act="close-slug" data-slug="${esc(p.slug)}" ${ui.busy ? "disabled" : ""}>Close position</button></div></div>`).join("")}</div>` : ""}
      <div class="block"><div class="block-head"><h2>Recent closed</h2></div>${closed.map(tradeRow).join("") || `<p class="hint">Nothing closed yet.</p>`}</div>`;
  }

  // Numeric fields are text inputs with a decimal keypad: type="number" fights partial input like "0." on phones.
  const FIELDS = [
    ["stakeUsd", "Stake per trade ($)", "Money put into each trade. Minimum 1.", "decimal"],
    ["stopLoss", "Stop loss", "Sell if a trade falls this far. 0.05 = 5¢. Take-profit is set automatically at 2× this.", "decimal"],
    ["maxOpen", "Max open trades", "How many trades can run at once. 1 to 10.", "numeric"],
    ["dailyLossLimit", "Daily loss limit ($)", "The bot stops opening trades after losing this much today. 0 = no limit.", "decimal"],
  ];
  const cfgField = ([k, name, help, mode]) => {
    const v = drafts["cfg:" + k] ?? String(cfg[k]);
    return `<label class="fld"><span>${esc(name)}</span><input type="text" inputmode="${mode}" enterkeyhint="done" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-cfg="${k}" value="${esc(v)}"><small>${esc(help)}</small></label>`;
  };
  const textIn = (id, type, ph, draftKey, extra = "") => `<input id="${id}" type="${type}" placeholder="${esc(ph)}" value="${esc(drafts[draftKey] ?? "")}" data-draft="${draftKey}" autocomplete="${type === "password" ? "new-password" : "off"}" autocapitalize="off" autocorrect="off" spellcheck="false" ${extra}>`;

  // Passcode/secret fields: Show and Clear buttons sit inside the field, so whatever is typed can always be wiped or checked.
  const secretIn = (id, ph, draftKey, extra = "") => {
    const shown = !!ui.reveal[draftKey];
    return `<div class="reveal-wrap"><input id="${id}" type="${shown ? "text" : "password"}" placeholder="${esc(ph)}" value="${esc(drafts[draftKey] ?? "")}" data-draft="${draftKey}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" ${extra}>
      <button type="button" class="eye clear" data-act="clear-field" data-target="${id}" data-key="${draftKey}" aria-label="Clear">Clear</button>
      <button type="button" class="eye" data-act="toggle-reveal" data-target="${id}" data-key="${draftKey}" aria-label="${shown ? "Hide" : "Show"}">${shown ? "Hide" : "Show"}</button></div>`;
  };

  function diagBlock() {
    if (!ui.diag) return "";
    return `<ul class="diag">${ui.diag.map(d => `<li class="${d.ok ? "ok" : "bad"}"><b>${d.ok ? "✓" : "✕"} ${esc(d.label)}</b><span>${esc(d.detail)}</span></li>`).join("")}</ul>`;
  }
  function accountPanel() {
    const acc = A.state.account, busy = ui.busy;
    if (A.isUnlocked()) {
      const h = A.state.health;
      return `<div class="panel">
        <div class="block-head"><h2>${esc(acc.label)}</h2><span class="pill ${h.ok === false ? "bad" : "good"}">${h.ok === false ? "Problem" : h.ok ? "Connected" : "Connecting"}</span></div>
        ${h.ok === false ? `<p class="note bad">${esc(h.message)}</p>` : ""}
        <p class="hint" data-live="ago"></p>
        ${balanceDetails()}
        <p class="hint" style="margin-top:8px">Key ID ${esc(acc.keyId.slice(0, 8))}…${esc(acc.keyId.slice(-4))}</p>
        <div class="actions"><button class="btn small" data-act="refresh" ${busy ? "disabled" : ""}>Refresh now</button><button class="btn small" data-act="diag" ${busy || ui.diagRunning ? "disabled" : ""}>${ui.diagRunning ? "Testing…" : "Test connection"}</button><button class="btn small ghost" data-act="lock">Lock</button></div>
        ${diagBlock()}
      </div>`;
    }
    if (A.state.status === "locked" && !ui.connectNew) {
      return `<div class="panel settings-view">
        <div class="block-head"><h2>${esc(acc?.label || "Saved account")}</h2><span class="pill warn">Locked</span></div>
        <label class="fld"><span>Passcode</span>${secretIn("passIn", "Enter your passcode", "unlockPass", 'data-enter="unlock" enterkeyhint="go"')}</label>
        ${ui.formError ? `<p class="note bad">${esc(ui.formError)}</p>` : ""}
        <div class="actions"><button class="btn primary" data-act="unlock" ${busy ? "disabled" : ""}>${busy === "unlock" ? "Unlocking…" : "Unlock"}</button><button class="btn small danger" data-act="remove">Remove account</button></div>
        <details class="forgot" id="forgot" ${ui.forgotOpen ? "open" : ""}><summary>Forgot your passcode?</summary>
          <p class="hint">Type the account name shown above and choose a new passcode. Your Key ID and secret key stay saved — nothing to re-enter.</p>
          <label class="fld"><span>Account name</span>${textIn("resetIn", "text", "Type the account name", "resetName")}</label>
          <label class="fld"><span>New passcode</span>${secretIn("newPassIn", "4+ characters", "newPass", 'data-enter="reset-pass" enterkeyhint="go"')}</label>
          <div class="actions"><button class="btn small danger" data-act="reset-pass" ${busy ? "disabled" : ""}>${busy === "reset" ? "Resetting…" : "Reset & unlock"}</button></div>
        </details>
        ${diagBlock()}
      </div>`;
    }
    return `<div class="panel settings-view">
      <div class="block-head"><h2>Connect Polymarket US</h2></div>
      <p class="hint" style="margin-top:0">Create an API key at polymarket.us/developer. It's encrypted on this device with a passcode you choose and only ever used to sign your own requests.</p>
      <label class="fld"><span>Label (optional)</span>${textIn("labelIn", "text", "e.g. Main account", "label")}</label>
      <label class="fld"><span>Key ID</span>${textIn("keyIdIn", "text", "Paste your Key ID", "keyId")}</label>
      <label class="fld"><span>Secret key</span>${secretIn("secretIn", "Paste your secret key", "secret")}</label>
      <label class="fld"><span>Choose a passcode</span>${secretIn("passIn", "4+ characters — you enter this each session", "passcode", 'data-enter="connect" enterkeyhint="go"')}</label>
      <label class="toggle-row"><input type="checkbox" data-act="toggle-allow-reset" ${ui.allowReset ? "checked" : ""}> Allow passcode reset with the account name</label>
      <p class="hint" style="margin-top:0">${ui.allowReset ? "If you forget the passcode you can set a new one by typing this account's name. Anyone who can open this app on your device and knows the name could do the same — turn this off on a shared device." : "With this off, a forgotten passcode means removing the account and re-entering your Key ID and secret."}</p>
      ${ui.formError ? `<p class="note bad">${esc(ui.formError)}</p>` : ""}
      <div class="actions"><button class="btn primary" data-act="connect" ${busy ? "disabled" : ""}>${busy === "connect" ? "Connecting…" : "Connect"}</button>${ui.connectNew && A.hasVault() ? `<button class="btn small ghost" data-act="back-locked">Back</button>` : ""}<button class="btn small" data-act="diag" ${ui.diagRunning ? "disabled" : ""}>${ui.diagRunning ? "Testing…" : "Test connection"}</button></div>
      ${diagBlock()}
    </div>`;
  }
  function settingsView() {
    return `${accountPanel()}
      <div class="panel" style="margin-top:12px">
        <div class="block-head"><h2>Risk settings</h2><button class="btn small ghost" data-act="reset-cfg">Reset</button></div>
        <div class="form-grid">${FIELDS.map(cfgField).join("")}</div>
        <p class="hint">Changes save when you tap out of a field. The strategy chooses which markets, what price range and when to sell.</p>
      </div>
      <div class="panel" style="margin-top:12px">
        <div class="block-head"><h2>Your trading style</h2></div>
        <p class="hint" style="margin-top:0">Sports: <b>${prefs.leagues.length ? esc(prefs.leagues.join(", ")) : "all live sports"}</b>. Pick them with the chips at the top of the Markets tab — the bot only enters games in those sports.</p>
        <label class="toggle-row"><input type="checkbox" data-act="toggle-breaks" ${prefs.skipBreaks ? "checked" : ""}> Don't enter during halftime or other breaks</label>
        <p class="hint">Always on: the bot only buys a game Polymarket confirms is live at the moment of the buy, and holds one trade per game at a time.</p>
      </div>`;
  }

  /* ---------- rendering: redraw only when something changed, never under the user's finger ---------- */
  const VIEWS = { home: homeView, markets: marketsView, trades: tradesView, settings: settingsView };
  const TITLES = { home: "Home", markets: "Live markets", trades: "Trades", settings: "Settings" };
  let lastHtml = "", lastView = null, pointerDown = false, drawQueued = false;

  const typingInApp = () => { const el = document.activeElement; return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && $("#app").contains(el); };
  function draw(force) {
    const changedView = view !== lastView;
    if (!force && !changedView && (pointerDown || typingInApp())) return; // never yank the DOM out from under a tap or a keystroke
    const html = VIEWS[view]();
    if (!force && !changedView && html === lastHtml) return;
    const y = window.scrollY;
    $("#navTitle").textContent = TITLES[view];
    $("#app").innerHTML = html;
    lastHtml = html; lastView = view;
    document.querySelectorAll(".nav a").forEach(a => a.getAttribute("href") === `#${view}` ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
    if (!changedView) window.scrollTo(0, y);
    updateChrome();
  }
  function render(force) {
    if (force) { draw(true); return; }
    if (drawQueued) return; drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(false); });
  }

  function updateChrome() {
    const chip = $("#balChip"), s = A.state;
    if (chip) {
      const text = s.status === "unlocked" ? (s.balance == null ? "Loading…" : money(s.balance)) : s.status === "locked" ? "Unlock" : "Connect";
      if (chip.textContent !== text) chip.textContent = text;
      chip.classList.toggle("bad", s.status === "unlocked" && s.health.ok === false);
      chip.classList.toggle("live", s.status === "unlocked" && s.health.ok === true);
    }
    const txt = !A.isUnlocked() || s.health.ok === false ? "" : s.lastOk ? `Live · balance updated ${ago(s.lastOk)} ago` : "Connecting…";
    document.querySelectorAll('[data-live="ago"]').forEach(el => { if (el.textContent !== txt) el.textContent = txt; });
    document.querySelectorAll(".age[data-ts]").forEach(el => { const t = ` updated ${ago(Number(el.dataset.ts))} ago`; if (el.textContent !== t) el.textContent = t; });
  }

  function route() {
    const v = location.hash.slice(1), next = VIEWS[v] ? v : "home";
    if (next !== view) { view = next; window.scrollTo(0, 0); }
    render(true);
    if (view === "markets" && !scan.scanning) runScan().then(() => render()); // open Markets → scan right away
  }
  window.addEventListener("hashchange", route);

  /* ---------- diagnostics: shows exactly which step fails (network, market data, signing, balance) ---------- */
  async function runDiagnostics() {
    ui.diagRunning = true; ui.diag = null; render(true);
    const out = [];
    try { const r = await PUB.markets({ limit: 1, active: true }); const m0 = (r?.markets || [])[0]; const qq = m0 && S.quotesOf(m0); out.push({ ok: true, label: "Market data (gateway.polymarket.us)", detail: m0 ? `Reachable. Sample market has ${Object.keys(m0).length} fields (${Object.keys(m0).slice(0, 12).join(", ")}…); live prices ${S.validQuotes(qq) ? "included" : "not in the list, fetched per market"}.` : "Reachable, but returned no markets." }); }
    catch (e) { out.push({ ok: false, label: "Market data (gateway.polymarket.us)", detail: e.message }); }
    try {
      const r = await fetchLive(), kinds = [...new Set(r.rows.map(m => S.typeOf(m) || "untyped"))].slice(0, 6).join(", ");
      out.push({ ok: true, label: "Live games (events, live=true)", detail: `${r.games} games live now → ${r.rows.length} main lines kept. Market types: ${kinds || "none"}.${r.hidden.future || r.hidden.farEnd ? ` Hidden: ${r.hidden.future} not started, ${r.hidden.farEnd} dated beyond today.` : ""}` });
      if (r.sample) out.push({ ok: true, label: "Sample live game (raw)", detail: JSON.stringify(r.sample).slice(0, 500) });
    }
    catch (e) { out.push({ ok: false, label: "Live games (events, live=true)", detail: e.message }); }
    if (A.isUnlocked()) {
      const sdk = A.client();
      try { const r = await sdk.balances(); const row = (r?.balances || [])[0]; out.push({ ok: true, label: "Signed request (api.polymarket.us)", detail: row ? `Cash ${money(S.num(row.currentBalance))}.` : "Signed OK, but no balance rows were returned." }); }
      catch (e) { out.push({ ok: false, label: "Signed request (api.polymarket.us)", detail: e.message }); }
      try { const r = await sdk.positions(); out.push({ ok: true, label: "Positions", detail: `${A.normalisePositions(r?.positions).length} open position(s) on your account.` }); }
      catch (e) { out.push({ ok: false, label: "Positions", detail: e.message }); }
    } else out.push({ ok: true, label: "Signed requests", detail: "Connect or unlock an account to test balance and orders." });
    out.push({ ok: !!window.crypto?.subtle, label: "Secure context", detail: window.crypto?.subtle ? "HTTPS OK — signing available." : "Not HTTPS — signing and storage are disabled." });
    ui.diag = out; ui.diagRunning = false; render(true);
  }

  /* ---------- actions ---------- */
  const guard = async (name, fn) => { if (ui.busy) return; ui.busy = name; render(true); try { await fn(); } finally { ui.busy = null; render(true); } };
  const actions = {
    "toggle-bot": async () => {
      if (!botOn && !A.isUnlocked()) { toast(A.state.status === "locked" ? "Unlock your account first." : "Connect your account first.", "bad"); location.hash = "#settings"; return; }
      botOn = !botOn; botNote = botOn ? "Starting…" : "Bot is off."; entryFails = 0; entryPausedUntil = 0; scan.at = 0;
      if (botOn) await requestWake(); else releaseWake();
      render(true);
    },
    connect: () => guard("connect", async () => {
      ui.formError = "";
      try { await A.save({ label: drafts.label, keyId: drafts.keyId, secretKey: drafts.secret, passcode: drafts.passcode, allowReset: ui.allowReset }); ui.connectNew = false; ui.reveal = {}; for (const k of ["label", "keyId", "secret", "passcode"]) delete drafts[k]; botNote = "Bot is off."; toast("Connected.", "good"); location.hash = "#home"; }
      catch (e) { ui.formError = e.message; toast(e.message, "bad"); }
    }),
    unlock: () => guard("unlock", async () => {
      ui.formError = "";
      try { await A.unlock(null, drafts.unlockPass); delete drafts.unlockPass; botNote = "Bot is off."; toast("Unlocked.", "good"); }
      catch (e) { ui.formError = e.message; toast(e.message, "bad"); }
    }),
    "reset-pass": () => guard("reset", async () => {
      const name = drafts.resetName, pass = drafts.newPass;
      try {
        await A.resetPasscode(name, pass);
        botOn = false; botNote = "Bot is off.";
        for (const k of ["resetName", "newPass", "unlockPass"]) delete drafts[k];
        Object.assign(ui, { forgotOpen: false, formError: "", reveal: {} });
        toast("New passcode set. You're unlocked.", "good");
      } catch (e) {
        if (e.code !== "NO_RECOVERY") { toast(e.message, "bad"); return; }
        // Saved before name-reset existed (or with it turned off): the only safe way back is re-entering the secret.
        try {
          const rec = A.resetByName(name);
          Object.assign(drafts, { label: rec.label, keyId: rec.keyId }); for (const k of ["resetName", "newPass", "unlockPass", "secret", "passcode"]) delete drafts[k];
          Object.assign(ui, { connectNew: true, forgotOpen: false, formError: "", diag: null, reveal: {} });
          toast("This account has no reset copy, so paste your secret key once and choose a new passcode.", "bad");
        } catch (e2) { toast(e2.message, "bad"); }
      }
    }),
    "pick-league": el => { const k = el.dataset.league; prefs.leagues = !k ? [] : prefs.leagues.includes(k) ? prefs.leagues.filter(x => x !== k) : [...prefs.leagues, k]; savePrefs(); render(true); },
    "toggle-breaks": () => { prefs.skipBreaks = !prefs.skipBreaks; savePrefs(); render(true); },
    "toggle-allow-reset": () => { ui.allowReset = !ui.allowReset; render(true); },
    "back-locked": () => { ui.connectNew = false; ui.formError = ""; render(true); },
    "toggle-reveal": el => { const k = el.dataset.key; ui.reveal[k] = !ui.reveal[k]; render(true); document.getElementById(el.dataset.target)?.focus(); },
    "clear-field": el => { drafts[el.dataset.key] = ""; render(true); document.getElementById(el.dataset.target)?.focus(); },
    lock: () => { botOn = false; releaseWake(); ui.connectNew = false; ui.reveal = {}; A.lock(); ui.diag = null; render(true); },
    remove: () => { if (!confirm("Remove the saved account from this device? You'll need your Key ID and secret to connect again.")) return; botOn = false; A.remove(); ui.connectNew = false; ui.diag = null; ui.formError = ""; render(true); },
    refresh: () => guard("refresh", async () => { await A.refresh(); toast(A.state.health.ok ? "Balance updated." : A.state.health.message, A.state.health.ok ? "good" : "bad"); }),
    diag: () => runDiagnostics(),
    rescan: async () => { bboCache.clear(); liveCache.at = 0; await runScan(); render(true); },
    "reset-cfg": () => { cfg = S.sanitize({}); for (const k of Object.keys(drafts)) if (k.startsWith("cfg:")) delete drafts[k]; saveCfg(); render(true); toast("Settings reset to defaults.", "good"); },
    "close-trade": el => guard("close", () => exclusive(async () => {
      const t = trades.find(x => x.id === el.dataset.id); if (!t || t.status !== "open") return;
      t.nextCloseAt = 0; await closeTrade(t, "manual", t.mark);
    })),
    "close-slug": el => guard("close", async () => {
      if (!confirm("Close this whole position at market price?")) return;
      try { const r = await A.closeNow({ marketSlug: el.dataset.slug }); toast(r.filledQty > 0 ? "Position closed." : "Close order sent.", "good"); A.state.lastRefresh = 0; await A.refresh(); }
      catch (e) { toast(e.message, "bad"); }
    }),
    "manual-buy": el => guard("buy", () => exclusive(async () => {
      const slug = el.dataset.slug, side = el.dataset.side;
      const row = scan.rows.find(m => m.slug === slug); if (!row) return;
      const live = await confirmLive(row, { manual: true });
      if (!live.ok) { toast(live.why, "bad"); return; }
      const q = await quotesFor(slug), px = q ? S.entryPrice(q, side) : null;
      if (px == null) { toast("Couldn't get a live price for that market.", "bad"); return; }
      const stake = S.stakeFor(cfg, A.state.buyingPower);
      if ((A.state.buyingPower ?? 0) < stake) { toast(`Buying power ${money(A.state.buyingPower)} is below the ${money(stake)} stake.`, "bad"); return; }
      const minQty = S.num(row.minimumTradeQty);
      if (minQty && stake / px < minQty) { toast(`This market needs at least ${minQty} contracts; ${money(stake)} buys about ${(stake / px).toFixed(1)}. Raise your stake.`, "bad"); return; }
      const pick = pickName(row, side), g = live.g, gs = [periodText(g.period), g.clock, g.score && `Score ${g.score}`].filter(Boolean).join(" · ");
      if (!confirm(`Buy ${pick} for ${money(stake)}?\n\n${row._event || row.question || slug}\nLIVE${gs ? ` · ${gs}` : ""}\n\nAbout ${cents(px)} per contract, as a market order. The bot will manage the exit.`)) return;
      try { const t = await openTrade({ marketSlug: slug, question: row._event || row.question || row.title || slug, side, expectedPx: px, usd: stake, manual: true, eventSlug: row._eventSlug, pick, league: row._league }); toast(t.status === "open" ? `Bought ${pick} at ${cents(t.entry)}` : "Order sent — confirming…", "good"); }
      catch (e) { toast(e.message, "bad"); }
    })),
    panic: () => guard("panic", async () => {
      if (!confirm("Turn the bot off and sell every trade the bot opened, at market price?")) return;
      botOn = false; releaseWake();
      await exclusive(async () => { for (const t of trades.filter(x => x.status === "open")) { t.nextCloseAt = 0; await closeTrade(t, "manual", t.mark); } });
      try { await A.cancelAllOpen(); } catch {}
      await A.refresh();
    }),
  };

  document.addEventListener("click", e => {
    const el = e.target.closest("[data-act]"); if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) Promise.resolve(fn(el)).catch(err => { console.error(err); toast(err.message || "Something went wrong.", "bad"); });
  });
  // remember whatever is typed, so no redraw can ever lose it
  document.addEventListener("input", e => {
    const d = e.target.dataset || {};
    if (d.draft) drafts[d.draft] = e.target.value; else if (d.cfg) drafts["cfg:" + d.cfg] = e.target.value;
  });
  document.addEventListener("change", e => {
    const k = e.target.dataset?.cfg; if (!k) return;
    const v = S.validateField(k, e.target.value);
    if (v.ok) { cfg = S.sanitize({ ...cfg, [k]: v.value }); saveCfg(); toast("Saved.", "good"); }
    else toast(`${FIELDS.find(f => f[0] === k)?.[1] || k}: ${v.message}`, "bad");
    delete drafts["cfg:" + k];
    e.target.value = String(cfg[k]); // show the saved (or reverted) value right away, without rebuilding the page
    setTimeout(() => render(false), 150);
  });
  document.addEventListener("toggle", e => { if (e.target?.id === "forgot") ui.forgotOpen = e.target.open; }, true);
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    const t = e.target;
    if (t.dataset.enter) { e.preventDefault(); const b = document.querySelector(`[data-act="${t.dataset.enter}"]`); if (b && !b.disabled) b.click(); }
    else if (t.dataset.cfg) { e.preventDefault(); t.blur(); }
  });
  // After a field loses focus, catch up on anything that changed while the user was typing.
  document.addEventListener("focusout", () => setTimeout(() => { if (!typingInApp()) render(false); }, 150));
  window.addEventListener("pointerdown", () => { pointerDown = true; }, true);
  const pointerUp = () => { pointerDown = false; setTimeout(() => render(false), 80); };
  window.addEventListener("pointerup", pointerUp, true); window.addEventListener("pointercancel", pointerUp, true);

  /* ---------- keep the screen awake while the bot runs (phones suspend background pages) ---------- */
  let wake = null;
  async function requestWake() { try { if ("wakeLock" in navigator && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } } catch {} }
  function releaseWake() { try { wake?.release(); } catch {} wake = null; }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (botOn) requestWake();
    if (A.isUnlocked()) { A.state.lastRefresh = 0; scan.at = 0; }
  });

  A.on(() => { render(); updateChrome(); });
  if (store.get("blueedgeus.debug", false)) window.__blueedge = { tick, get trades() { return trades; }, get cfg() { return cfg; }, get scan() { return scan; }, get botOn() { return botOn; }, set botOn(v) { botOn = v; }, drafts, exclusive, runScan, actions, fetchLive, confirmLive, gameInfo, prefs, VIEWS, render, enterTrades, liveCache };
  route(); loop();
})();
