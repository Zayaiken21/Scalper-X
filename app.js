/* BlueEdge US app shell — odds scalper on Polymarket US. No crypto, no chart. */
(() => {
  const A = window.BlueEdgeAccount, S = window.BlueEdgeStrategy;
  const $ = sel => document.querySelector(sel);
  const money = v => v == null ? "—" : `$${Number(v).toFixed(2)}`;
  const pct = v => v == null ? "—" : `${(Number(v) * 100).toFixed(1)}¢`;
  const CFG_KEY = "blueedgeus.cfg", TRADES_KEY = "blueedgeus.trades", BOT_KEY = "blueedgeus.botOn";

  let cfg = { ...S.DEFAULTS, ...(JSON.parse(localStorage.getItem(CFG_KEY) || "null") || {}) };
  let trades = JSON.parse(localStorage.getItem(TRADES_KEY) || "[]");
  let botOn = localStorage.getItem(BOT_KEY) === "1";
  let view = "home", botNote = "Bot is off.", lastScan = [], scanning = false, busy = false;
  const saveCfg = () => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  const saveTrades = () => localStorage.setItem(TRADES_KEY, JSON.stringify(trades.slice(-200)));

  let toastEl = null, toastTimer = null;
  function toast(msg, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div"); toastEl.className = "toast"; toastEl.hidden = true;
      toastEl.style.cssText = "position:fixed;z-index:60;left:12px;right:12px;bottom:calc(var(--tab-h) + var(--safe-b) + 10px);";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.className = `toast ${kind || ""}`; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  /* ---------- odds scalper loop ---------- */
  let lastFullScan = 0, lastBalanceRefresh = 0;
  async function tick() {
    if (!A.isUnlocked()) { botNote = A.state.status === "locked" ? "Unlock your account in Settings to run the bot." : "Connect a Polymarket US account in Settings."; render(); return; }
    const now = Date.now();
    if (now - lastBalanceRefresh > 15000) { lastBalanceRefresh = now; A.refresh().catch(() => {}); }
    if (!botOn) { botNote = "Bot is off."; render(); return; }
    if (busy) return;
    busy = true;
    try {
      if (now - lastFullScan > 4000) {
        lastFullScan = now;
        scanning = true; render();
        try {
          const speed = S.SPEEDS[cfg.speed] || S.SPEEDS.quick;
          const res = await A.marketsScan({ active: true, closed: false, orderBy: ["volume24hr"], orderDirection: "desc", limit: 100, endDateMax: new Date(now + speed.horizonMs).toISOString() });
          const rows = (res?.markets || res?.data || []).filter(m => String(m.category || "").toLowerCase() !== "crypto");
          lastScan = rows;
        } catch (e) { botNote = e.message; }
        scanning = false;
      }

      const open = trades.filter(t => t.status === "open");
      const heldSlugs = new Set(open.map(t => t.marketSlug));

      // manage exits first — freeing a slot this tick lets a new entry use it right away
      for (const t of open) {
        let row = lastScan.find(m => m.slug === t.marketSlug);
        if (!row) { try { const r = await A.marketBySlug(t.marketSlug); row = r?.market || r; } catch { row = null; } }
        const price = row ? S.priceForSide(row, t.side) : null;
        const verdict = S.evaluateExit(t, price, cfg);
        if (verdict.action === "hold") continue;
        try {
          await A.closeNow({ marketSlug: t.marketSlug });
          t.status = "closed"; t.closedAt = Date.now(); t.exit = verdict.price; t.reason = verdict.action;
          t.pnl = t.exit != null ? Number(((t.exit - t.entry) * t.quantity).toFixed(2)) : null;
          saveTrades();
          toast(`Closed ${t.marketSlug} (${verdict.action}) ${t.pnl != null ? money(t.pnl) : ""}`, verdict.action === "stop" ? "bad" : "good");
        } catch (e) { botNote = `Couldn't close ${t.marketSlug}: ${e.message}`; }
        await new Promise(r => setTimeout(r, 250));
      }

      // then look for new entries in the remaining open slots
      const slots = cfg.maxOpen - trades.filter(t => t.status === "open").length;
      if (slots > 0 && lastScan.length) {
        const candidates = S.scanForEntries(lastScan, cfg, heldSlugs).slice(0, slots);
        const stake = S.stakeFor(cfg, A.state.buyingPower);
        for (const c of candidates) {
          if ((A.state.buyingPower ?? 0) < stake) { botNote = `Paused: buying power ${money(A.state.buyingPower)} is below the ${money(stake)} stake.`; break; }
          try {
            const res = await A.buyMarket({ marketSlug: c.market.slug, side: c.side, usd: stake });
            const fill = res?.executions?.[0];
            const entry = Number(fill?.lastPx?.value ?? c.price);
            const qty = Number(fill?.lastShares ?? (stake / entry).toFixed(4));
            trades.push({ id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), marketSlug: c.market.slug, question: c.market.question || c.market.title || c.market.slug, side: c.side, entry, quantity: qty, stake, openedAt: Date.now(), status: "open" });
            saveTrades();
            A.state.buyingPower = (A.state.buyingPower ?? stake) - stake;
            toast(`Bought ${c.side} on ${c.market.slug} at ${pct(entry)}`, "good");
          } catch (e) { botNote = `Skipped ${c.market.slug}: ${e.message}`; }
          await new Promise(r => setTimeout(r, 400));
        }
        if (!botNote.startsWith("Skipped") && !botNote.startsWith("Paused")) botNote = candidates.length ? `Working ${candidates.length} candidate${candidates.length > 1 ? "s" : ""}.` : `Watching ${lastScan.length} markets. None in range right now.`;
      }
    } finally { busy = false; render(); }
  }

  /* ---------- views ---------- */
  function speedChips() {
    return Object.entries(S.SPEEDS).map(([k, v]) => `<button aria-pressed="${cfg.speed === k}" data-act="speed" data-k="${k}">${v.label} · ${v.hint}</button>`).join("");
  }
  function homeView() {
    const openCount = trades.filter(t => t.status === "open").length;
    const closedToday = trades.filter(t => t.status === "closed" && Date.now() - t.closedAt < 86400000);
    const pnlToday = closedToday.reduce((s, t) => s + (t.pnl || 0), 0);
    return `
      <div class="panel">
        <div class="block-head"><h2>Odds scalper</h2>
          <button class="btn ${botOn ? "primary" : ""}" data-act="toggle-bot">${botOn ? "Bot: ON" : "Bot: OFF"}</button>
        </div>
        <p class="hint">${scanning ? "Scanning…" : botNote}</p>
        <div class="chips">${speedChips()}</div>
        <div class="stat-grid">
          <div><span>Balance</span><b>${money(A.state.balance)}</b></div>
          <div><span>Buying power</span><b>${money(A.state.buyingPower)}</b></div>
          <div><span>Open positions</span><b>${openCount} / ${cfg.maxOpen}</b></div>
          <div><span>Closed today</span><b class="${pnlToday >= 0 ? "gain" : "loss"}">${money(pnlToday)}</b></div>
        </div>
      </div>`;
  }
  function marketsView() {
    if (!lastScan.length) return `<div class="panel"><p class="hint">No scan yet — turn the bot on to start watching live US markets.</p></div>`;
    const held = new Set(trades.filter(t => t.status === "open").map(t => t.marketSlug));
    const rows = S.scanForEntries(lastScan, cfg, new Set()).slice(0, 30);
    return `<div class="market-grid">${rows.map(c => `
      <div class="market-card ${held.has(c.market.slug) ? "held" : ""}">
        <b>${esc(c.market.question || c.market.title || c.market.slug)}</b>
        <div class="row"><span>${c.side}</span><span>${pct(c.price)}</span><span>${money(c.vol)} vol</span></div>
      </div>`).join("")}</div>`;
  }
  function tradesView() {
    const open = trades.filter(t => t.status === "open").sort((a, b) => b.openedAt - a.openedAt);
    const closed = trades.filter(t => t.status === "closed").sort((a, b) => b.closedAt - a.closedAt).slice(0, 40);
    const row = t => `<div class="trade-row">
        <b>${esc(t.question || t.marketSlug)}</b>
        <div class="row"><span>${t.side}</span><span>entry ${pct(t.entry)}</span>${t.exit != null ? `<span>exit ${pct(t.exit)}</span><span class="${t.pnl >= 0 ? "gain" : "loss"}">${money(t.pnl)}</span>` : `<span>${money(t.stake)} staked</span>`}</div>
      </div>`;
    return `<div class="block"><div class="block-head"><h2>Open (${open.length})</h2></div>${open.map(row).join("") || `<p class="hint">No open positions.</p>`}</div>
            <div class="block"><div class="block-head"><h2>Recent closed</h2></div>${closed.map(row).join("") || `<p class="hint">Nothing closed yet.</p>`}</div>`;
  }
  function settingsView() {
    const acc = A.state.account;
    const unlockedBlock = A.isUnlocked() ? `
        <div class="panel"><b>${esc(acc.label)}</b> <span class="pill good">Unlocked</span>
          <p class="hint">Key ID: ${esc(acc.keyId)}</p>
          <button class="btn" data-act="lock">Lock</button>
        </div>` : A.state.status === "locked" ? `
        <div class="panel settings-view"><b>${esc(acc?.label || "Saved account")}</b> <span class="pill">Locked</span>
          <input id="passIn" type="password" placeholder="Passcode" />
          <button class="btn" data-act="unlock">Unlock</button>
        </div>` : `
        <div class="panel settings-view">
          <p class="hint">Connect your Polymarket US API key (create one at polymarket.us/developer). It's encrypted on this device with a passcode you choose — never sent anywhere except as a signature on your own requests.</p>
          <input id="labelIn" type="text" placeholder="Label (optional)" />
          <input id="keyIdIn" type="text" placeholder="Key ID" />
          <input id="secretIn" type="password" placeholder="Secret key" />
          <input id="passIn" type="password" placeholder="Choose a passcode" />
          <button class="btn" data-act="connect">Connect</button>
        </div>`;
    const num = (label, k, step = "0.01") => `<label>${label}<input type="number" step="${step}" data-cfg="${k}" value="${cfg[k]}" /></label>`;
    return `${unlockedBlock}
      <div class="panel">
        <div class="block-head"><h2>Risk settings</h2></div>
        <div class="form-grid">
          ${num("Min odds", "minOdds")}${num("Max odds", "maxOdds")}
          ${num("Target gain", "targetGain")}${num("Stop loss", "stopLoss")}
          ${num("Max hold (min)", "maxHoldMin", "1")}${num("Stake ($)", "stakeUsd", "1")}
          ${num("Max open", "maxOpen", "1")}${num("Min 24h volume ($)", "minVolume24h", "100")}
          ${num("Min liquidity ($)", "minLiquidity", "100")}${num("Max spread", "maxSpread")}
        </div>
      </div>`;
  }
  const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function draw() {
    $("#navTitle").textContent = { home: "Home", markets: "Live markets", trades: "Trades", settings: "Settings" }[view];
    $("#app").innerHTML = { home: homeView, markets: marketsView, trades: tradesView, settings: settingsView }[view]();
    document.querySelectorAll(".nav a").forEach(a => {
      if (a.getAttribute("href") === `#${view}`) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  function render() { requestAnimationFrame(draw); }
  function route() { const v = location.hash.slice(1); view = ["home", "markets", "trades", "settings"].includes(v) ? v : "home"; render(); }
  window.addEventListener("hashchange", route);

  document.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]"); if (!act) return;
    const a = act.dataset.act;
    if (a === "speed") { cfg.speed = act.dataset.k; saveCfg(); render(); }
    else if (a === "toggle-bot") { botOn = !botOn; localStorage.setItem(BOT_KEY, botOn ? "1" : "0"); botNote = botOn ? "Starting…" : "Bot is off."; render(); }
    else if (a === "connect") {
      const label = $("#labelIn").value, keyId = $("#keyIdIn").value, secretKey = $("#secretIn").value, passcode = $("#passIn").value;
      try { await A.save({ label, keyId, secretKey, passcode }); toast("Connected.", "good"); } catch (e) { toast(e.message, "bad"); }
    } else if (a === "unlock") {
      const passcode = $("#passIn").value;
      try { await A.unlock(null, passcode); toast("Unlocked.", "good"); } catch (e) { toast(e.message, "bad"); }
    } else if (a === "lock") { A.lock(); render(); }
  });
  document.addEventListener("change", e => {
    const k = e.target.dataset?.cfg; if (!k) return;
    cfg[k] = Number(e.target.value); saveCfg();
  });

  A.on(() => render());
  setInterval(tick, 2000);
  route();
})();
