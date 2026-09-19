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
  const scan = { rows: [], at: 0, error: "", scanning: false, horizonMs: S.HORIZONS[0] };
  const drafts = {};                       // what the user has typed but not saved yet — survives any redraw
  const ui = { busy: null, formError: "", diag: null, diagRunning: false };
  let entryFails = 0, entryPausedUntil = 0;
  const REFRESH_MS = 10000, SCAN_MS = 5000, TICK_MS = 2000, COOLDOWN_MS = 10 * 60000;

  const saveCfg = () => store.set(CFG_KEY, cfg);
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
  async function fetchMarkets(horizonMs) {
    const q = { active: true, closed: false, limit: 100, endDateMax: new Date(Date.now() + horizonMs).toISOString() };
    let res;
    try { res = await PUB.markets({ ...q, orderBy: ["volume24hr"], orderDirection: "desc" }); }
    catch (e) { if (e.status !== 400) throw e; res = await PUB.markets(q); } // if the server dislikes the sort field, fall back to unsorted and sort locally
    const rows = (res?.markets || []).filter(m => String(m.category || "").toLowerCase() !== "crypto");
    return rows.sort((a, b) => (S.num(b.volume24hr) || 0) - (S.num(a.volume24hr) || 0));
  }
  // The strategy picks the time window: markets closing soon first, widening only when there are too few candidates.
  async function runScan() {
    scan.scanning = true;
    try {
      let rows = [], used = S.HORIZONS[0];
      for (const h of S.HORIZONS) {
        rows = await fetchMarkets(h); used = h;
        if (S.scanForEntries(rows, cfg, new Set(), h).length >= 3) break;
      }
      scan.rows = rows; scan.horizonMs = used; scan.at = Date.now(); scan.error = "";
    } catch (e) { scan.error = e.message; scan.at = Date.now(); }
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
  async function openTrade({ marketSlug, question, side, expectedPx, usd, manual }) {
    const t = { id: uid(), marketSlug, question, side, entry: expectedPx, quantity: null, stake: usd, openedAt: Date.now(), status: "pending", manual: !!manual };
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
    if (!scan.rows.length) { botNote = scan.error ? `Market data problem: ${scan.error}` : "Waiting for the first market scan…"; return; }
    const skip = new Set([
      ...trades.filter(openish).map(t => t.marketSlug),
      ...A.state.positions.map(p => p.slug), // never stack onto positions you opened yourself
      ...trades.filter(t => t.status === "closed" && now - t.closedAt < COOLDOWN_MS).map(t => t.marketSlug), // no instant re-entry after an exit
    ]);
    const cands = S.scanForEntries(scan.rows, cfg, skip, scan.horizonMs);
    if (!cands.length) { botNote = `Watching ${scan.rows.length} markets. Nothing worth buying right now.`; return; }
    let placed = 0, tried = 0, lastErr = "";
    for (const c of cands) {
      if (placed >= slots || tried >= slots + 2) break;
      const stake = S.stakeFor(cfg, A.state.buyingPower);
      if ((A.state.buyingPower ?? 0) < stake) { botNote = `Paused: buying power ${money(A.state.buyingPower)} is below the ${money(stake)} stake.`; return; }
      tried++;
      const q = await quotesFor(c.market.slug); // re-verify on a fresh quote and a live book right before spending money
      const fresh = q && S.sidesFromQuotes(q, cfg).find(s => s.side === c.side);
      if (!fresh || q.bidDepth === 0 || q.askDepth === 0) continue;
      try {
        const t = await openTrade({ marketSlug: c.market.slug, question: c.market.question || c.market.title || c.market.slug, side: c.side, expectedPx: fresh.price, usd: stake });
        placed++; entryFails = 0; A.state.buyingPower = (A.state.buyingPower ?? stake) - stake;
        toast(t.status === "open" ? `Bought ${c.side} ${label(t)} at ${cents(t.entry)}` : `Order sent for ${label(t)} — confirming…`, "good");
      } catch (e) {
        lastErr = `Skipped ${c.market.slug}: ${e.message}`;
        if (!e.transient) { entryFails++; if (entryFails >= 3) { entryFails = 0; entryPausedUntil = Date.now() + 60000; } }
      }
      await sleep(300);
    }
    botNote = placed ? `Opened ${placed} trade${placed > 1 ? "s" : ""}.` : lastErr || `Watching ${scan.rows.length} markets. None passed the live check.`;
  }

  /* ---------- the loop ---------- */
  async function tick() {
    const now = Date.now();
    if (A.isUnlocked() && now - A.state.lastRefresh > REFRESH_MS) await A.refresh().catch(() => {});
    if (((botOn && A.isUnlocked()) || view === "markets") && now - scan.at > SCAN_MS && !scan.scanning) { await runScan(); render(); }
    if (A.isUnlocked()) {
      await exclusive(async () => { await manageTrades(); await enterTrades(); });
      if (!botOn) botNote = trades.some(t => t.status === "open") ? "Bot is off — no new entries. Open trades still follow your exit rules." : "Bot is off.";
    } else botNote = A.state.status === "locked" ? "Unlock your account in Settings to run the bot." : "Connect a Polymarket US account in Settings.";
    render(); updateChrome();
  }
  async function loop() { try { await tick(); } catch (e) { console.error(e); } setTimeout(loop, TICK_MS); }

  /* ---------- views ---------- */
  const HORIZON_TEXT = { [S.HORIZONS[0]]: "closing within 3 hours", [S.HORIZONS[1]]: "closing within 24 hours", [S.HORIZONS[2]]: "closing within 7 days" };
  function autoLine() {
    const band = S.autoBand(S.scanForEntries(scan.rows, cfg, new Set(), scan.horizonMs));
    if (!scan.at) return "The strategy picks the prices, targets and timing for you. It will show its chosen range here once it has scanned.";
    return band ? `Strategy is buying between ${cents(band.min)} and ${cents(band.max)} right now, on markets ${HORIZON_TEXT[scan.horizonMs]}. Take-profit is set at 2× your stop loss.` : "Strategy is watching the market — nothing worth buying right now.";
  }
  function homeView() {
    const open = trades.filter(t => t.status === "open");
    const unreal = open.reduce((s, t) => s + (t.mark != null && t.quantity ? S.netPnl(t.entry, t.mark, t.quantity) : 0), 0);
    const pnl = todayPnl();
    const cta = A.isUnlocked() ? "" : `<div class="panel" style="margin-bottom:12px"><p class="hint" style="margin:0 0 4px">${A.state.status === "locked" ? "Your account is saved but locked." : "No account connected yet."}</p><a class="btn primary" href="#settings">${A.state.status === "locked" ? "Unlock account" : "Connect account"}</a></div>`;
    return `${cta}
      <div class="panel">
        <div class="block-head"><h2>Odds scalper</h2>
          <button class="btn small ${botOn ? "primary" : ""}" data-act="toggle-bot" aria-pressed="${botOn}">${botOn ? "Bot: ON" : "Bot: OFF"}</button>
        </div>
        <p class="hint" style="margin-top:0">${esc(botNote)}</p>
        <p class="hint auto">${autoLine()}</p>
        <div class="stat-grid">
          <div><span>Cash balance</span><b>${money(A.state.balance)}</b></div>
          <div><span>Buying power</span><b>${money(A.state.buyingPower)}</b></div>
          <div><span>Open trades</span><b>${open.length} / ${cfg.maxOpen}</b></div>
          <div><span>Today, closed</span><b class="${pnl >= 0 ? "gain" : "loss"}">${smoney(pnl)}</b></div>
        </div>
        ${open.length ? `<p class="hint">Unrealized on open trades: <b class="${unreal >= 0 ? "gain" : "loss"}">${smoney(unreal)}</b> (after estimated fees)</p>` : ""}
        ${A.isUnlocked() && A.state.health.ok === false ? `<p class="note bad">${esc(A.state.health.message)}</p>` : ""}
        <p class="hint" data-live="ago"></p>
        ${botOn ? `<p class="hint">Keep this screen open while the bot runs — phones pause web pages that are in the background.</p>` : ""}
      </div>`;
  }

  function marketsView() {
    const rows = S.scanForEntries(scan.rows, cfg, new Set(), scan.horizonMs).slice(0, 30);
    const held = new Set(trades.filter(openish).map(t => t.marketSlug));
    const status = scan.at && !scan.error ? `${scan.rows.length} live markets scanned · ${rows.length} the strategy would buy` : (scan.error ? "Couldn't load markets." : "Loading live markets…");
    const head = `<div class="panel"><p class="hint" style="margin:0">${esc(status)}</p>${scan.error ? `<p class="note bad">${esc(scan.error)}</p>` : ""}</div>`;
    if (!rows.length) return `${head}${scan.at && !scan.error ? `<div class="panel" style="margin-top:12px"><p class="hint" style="margin:0">Nothing is worth buying right now — the strategy skips markets where spread and fees would eat the profit.</p></div>` : ""}`;
    const stake = S.stakeFor(cfg, A.state.buyingPower);
    return `${head}<div class="market-grid" style="margin-top:12px">${rows.map(c => `
      <div class="market-card ${held.has(c.market.slug) ? "held" : ""}">
        <b>${esc(c.market.question || c.market.title || c.market.slug)}</b>
        <div class="row"><span>${c.side}</span><span>${cents(c.price)}</span><span>${Math.round(c.vol).toLocaleString()} traded/24h</span><span>spread ${cents(c.spread)}</span></div>
        ${A.isUnlocked() && !held.has(c.market.slug) ? `<button class="btn small" style="margin-top:10px" data-act="manual-buy" data-slug="${esc(c.market.slug)}" data-side="${c.side}" ${ui.busy ? "disabled" : ""}>Buy ${c.side} · ${money(stake)}</button>` : ""}
      </div>`).join("")}</div>`;
  }

  function tradeRow(t) {
    const live = t.status === "open";
    const unreal = live && t.mark != null && t.quantity ? S.netPnl(t.entry, t.mark, t.quantity) : null;
    const nums = live
      ? `<span>${t.side}</span><span>in ${cents(t.entry)}</span><span>now ${cents(t.mark)}</span><span class="${(unreal ?? 0) >= 0 ? "gain" : "loss"}">${smoney(unreal)}</span><span>${ago(t.openedAt)}</span>`
      : t.status === "pending"
        ? `<span>${t.side}</span><span>confirming with Polymarket…</span>`
        : `<span>${t.side}</span><span>in ${cents(t.entry)}</span><span>out ${cents(t.exit)}${t.est ? " (est.)" : ""}</span><span class="${(t.pnl ?? 0) >= 0 ? "gain" : "loss"}">${smoney(t.pnl)}</span><span>${esc(reasonText(t.reason))}</span>`;
    return `<div class="trade-row"><b>${esc(t.question || t.marketSlug)}</b><div class="row">${nums}</div>
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
        <div class="stat-grid">
          <div><span>Cash balance</span><b>${money(A.state.balance)}</b></div>
          <div><span>Buying power</span><b>${money(A.state.buyingPower)}</b></div>
        </div>
        ${h.ok === false ? `<p class="note bad">${esc(h.message)}</p>` : ""}
        <p class="hint" data-live="ago"></p>
        <p class="hint" style="margin-top:2px">Key ID ${esc(acc.keyId.slice(0, 8))}…${esc(acc.keyId.slice(-4))}</p>
        <div class="actions"><button class="btn small" data-act="refresh" ${busy ? "disabled" : ""}>Refresh now</button><button class="btn small" data-act="diag" ${busy || ui.diagRunning ? "disabled" : ""}>${ui.diagRunning ? "Testing…" : "Test connection"}</button><button class="btn small ghost" data-act="lock">Lock</button></div>
        ${diagBlock()}
      </div>`;
    }
    if (A.state.status === "locked") {
      return `<div class="panel settings-view">
        <div class="block-head"><h2>${esc(acc?.label || "Saved account")}</h2><span class="pill warn">Locked</span></div>
        <label class="fld"><span>Passcode</span>${textIn("passIn", "password", "Enter your passcode", "unlockPass", 'data-enter="unlock" enterkeyhint="go"')}</label>
        ${ui.formError ? `<p class="note bad">${esc(ui.formError)}</p>` : ""}
        <div class="actions"><button class="btn primary" data-act="unlock" ${busy ? "disabled" : ""}>${busy === "unlock" ? "Unlocking…" : "Unlock"}</button><button class="btn small danger" data-act="remove">Remove account</button></div>
        <p class="hint">Forgot the passcode? Remove the account and connect again with your Key ID and secret.</p>
        ${diagBlock()}
      </div>`;
    }
    return `<div class="panel settings-view">
      <div class="block-head"><h2>Connect Polymarket US</h2></div>
      <p class="hint" style="margin-top:0">Create an API key at polymarket.us/developer. It's encrypted on this device with a passcode you choose and only ever used to sign your own requests.</p>
      <label class="fld"><span>Label (optional)</span>${textIn("labelIn", "text", "e.g. Main account", "label")}</label>
      <label class="fld"><span>Key ID</span>${textIn("keyIdIn", "text", "Paste your Key ID", "keyId")}</label>
      <label class="fld"><span>Secret key</span>${textIn("secretIn", "password", "Paste your secret key", "secret")}</label>
      <label class="fld"><span>Choose a passcode</span>${textIn("passIn", "password", "4+ characters — you enter this each session", "passcode", 'data-enter="connect" enterkeyhint="go"')}</label>
      ${ui.formError ? `<p class="note bad">${esc(ui.formError)}</p>` : ""}
      <div class="actions"><button class="btn primary" data-act="connect" ${busy ? "disabled" : ""}>${busy === "connect" ? "Connecting…" : "Connect"}</button><button class="btn small" data-act="diag" ${ui.diagRunning ? "disabled" : ""}>${ui.diagRunning ? "Testing…" : "Test connection"}</button></div>
      ${diagBlock()}
    </div>`;
  }
  function settingsView() {
    return `${accountPanel()}
      <div class="panel" style="margin-top:12px">
        <div class="block-head"><h2>Risk settings</h2><button class="btn small ghost" data-act="reset-cfg">Reset</button></div>
        <div class="form-grid">${FIELDS.map(cfgField).join("")}</div>
        <p class="hint">Changes save when you tap out of a field. The strategy chooses which markets, what price range and when to sell.</p>
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
    try { const r = await PUB.markets({ limit: 1, active: true }); out.push({ ok: true, label: "Market data (gateway.polymarket.us)", detail: `Reachable — returned ${(r?.markets || []).length} market.` }); }
    catch (e) { out.push({ ok: false, label: "Market data (gateway.polymarket.us)", detail: e.message }); }
    if (A.isUnlocked()) {
      const sdk = A.client();
      try { const r = await sdk.balances(); const row = (r?.balances || [])[0]; out.push({ ok: true, label: "Signed request (api.polymarket.us)", detail: row ? `Cash ${money(S.num(row.currentBalance))}, buying power ${money(S.num(row.buyingPower))}.` : "Signed OK, but no balance rows were returned." }); }
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
      try { await A.save({ label: drafts.label, keyId: drafts.keyId, secretKey: drafts.secret, passcode: drafts.passcode }); for (const k of ["label", "keyId", "secret", "passcode"]) delete drafts[k]; botNote = "Bot is off."; toast("Connected.", "good"); location.hash = "#home"; }
      catch (e) { ui.formError = e.message; toast(e.message, "bad"); }
    }),
    unlock: () => guard("unlock", async () => {
      ui.formError = "";
      try { await A.unlock(null, drafts.unlockPass); delete drafts.unlockPass; botNote = "Bot is off."; toast("Unlocked.", "good"); }
      catch (e) { ui.formError = e.message; toast(e.message, "bad"); }
    }),
    lock: () => { botOn = false; releaseWake(); A.lock(); ui.diag = null; render(true); },
    remove: () => { if (!confirm("Remove the saved account from this device? You'll need your Key ID and secret to connect again.")) return; botOn = false; A.remove(); ui.diag = null; ui.formError = ""; render(true); },
    refresh: () => guard("refresh", async () => { await A.refresh(); toast(A.state.health.ok ? "Balance updated." : A.state.health.message, A.state.health.ok ? "good" : "bad"); }),
    diag: () => runDiagnostics(),
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
      const q = await quotesFor(slug), px = q ? S.entryPrice(q, side) : null;
      if (px == null) { toast("Couldn't get a live price for that market.", "bad"); return; }
      const stake = S.stakeFor(cfg, A.state.buyingPower);
      if ((A.state.buyingPower ?? 0) < stake) { toast(`Buying power ${money(A.state.buyingPower)} is below the ${money(stake)} stake.`, "bad"); return; }
      if (!confirm(`Buy ${side} for ${money(stake)}?\n\n${row.question || row.title || slug}\n\nAbout ${cents(px)} per contract, as a market order. The bot will manage the exit.`)) return;
      try { const t = await openTrade({ marketSlug: slug, question: row.question || row.title || slug, side, expectedPx: px, usd: stake, manual: true }); toast(t.status === "open" ? `Bought ${side} at ${cents(t.entry)}` : "Order sent — confirming…", "good"); }
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
  if (store.get("blueedgeus.debug", false)) window.__blueedge = { tick, get trades() { return trades; }, get cfg() { return cfg; }, get scan() { return scan; }, get botOn() { return botOn; }, set botOn(v) { botOn = v; }, drafts, exclusive, runScan, actions };
  route(); loop();
})();
