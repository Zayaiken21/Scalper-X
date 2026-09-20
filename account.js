/* BlueEdge US account: Polymarket US API key (Key ID + Ed25519 secret), encrypted on this device behind a
 * passcode (PBKDF2-SHA256 → AES-GCM). The secret never leaves this device unencrypted and is only ever used
 * to sign requests to Polymarket US.
 */
window.BlueEdgeAccount = (() => {
  const STORE = "blueedgeus.accounts.v1";
  const ITER = 310000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const num = v => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const amt = a => (a != null && typeof a === "object") ? num(a.value) : num(a);

  const state = {
    status: "none",                       // none | locked | unlocked
    account: null,                        // {id,label,keyId,updatedAt}
    balance: null, buyingPower: null, assetValue: null,
    bal: null,                            // full parsed balance breakdown (see parseBalance)
    positions: [],                        // normalised: [{slug, qty, side, cost, cashValue, title}]
    positionsAt: 0,                       // when positions were last fetched OK (used to reconcile bot trades)
    orders: [],
    health: { ok: null, message: "" },    // last refresh outcome
    lastRefresh: 0, lastOk: 0,
  };
  let sdk = null, inflight = null;
  const listeners = [];
  const on = fn => listeners.push(fn);
  const emit = () => listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });

  /* ---------- store ---------- */
  function readStore() { let s = null; try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch {} if (!s) s = { active: null, list: [] }; s.list = Array.isArray(s.list) ? s.list : []; return s; }
  function writeStore(s) { localStorage.setItem(STORE, JSON.stringify(s)); }
  const metaOf = r => r && ({ id: r.id, label: r.label, keyId: r.keyId, updatedAt: r.updatedAt });
  const hasVault = () => readStore().list.length > 0;
  function savedMeta() { const s = readStore(); return metaOf(s.list.find(r => r.id === s.active) || s.list[0]) || null; }

  /* ---------- crypto ---------- */
  function needCrypto() { if (!window.crypto?.subtle) throw new Error("Secure storage needs HTTPS. Open BlueEdge US from its https:// address."); }
  async function deriveKey(passcode, salt) {
    needCrypto();
    const base = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(payload, passcode) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passcode, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
    return { kdf: { name: "PBKDF2-SHA256", iter: ITER, salt: b64(salt) }, iv: b64(iv), ct: b64(ct) };
  }
  async function openRecord(r, passcode) {
    const key = await deriveKey(passcode, unb64(r.kdf.salt));
    try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv) }, key, unb64(r.ct)))); }
    catch { throw new Error("Wrong passcode."); }
  }

  /* ---------- save / unlock ---------- */
  async function save({ label, keyId, secretKey, passcode }) {
    keyId = String(keyId || "").trim();
    secretKey = String(secretKey || "").replace(/\s+/g, "");
    if (!keyId) throw new Error("Enter your Polymarket US Key ID.");
    if (!secretKey) throw new Error("Enter your Polymarket US secret key.");
    if (!passcode || passcode.length < 4) throw new Error("Choose a passcode (4+ characters) to encrypt this key on your device.");
    await PolyUS.importSecret(secretKey); // fail fast on an unusable secret, before anything is stored
    const sealed = await seal({ keyId, secretKey }, passcode);
    const id = "acc_" + Date.now().toString(36);
    // Never discard a saved account: only a record with the SAME Key ID is replaced (re-saving with a new passcode); any others are kept.
    const prior = readStore();
    writeStore({ active: id, list: [...prior.list.filter(r => r.keyId !== keyId), { id, label: String(label || "").trim() || "Polymarket US", keyId, updatedAt: Date.now(), ...sealed }] });
    return unlock(id, passcode);
  }

  async function unlock(id, passcode) {
    const s = readStore();
    const rec = s.list.find(r => r.id === (id || s.active)) || s.list[0];
    if (!rec) throw new Error("No saved account. Connect one first.");
    if (!passcode) throw new Error("Enter your passcode.");
    const payload = await openRecord(rec, passcode);
    const cryptoKey = await PolyUS.importSecret(payload.secretKey);
    sdk = PolyUS.client(payload.keyId, cryptoKey);
    s.active = rec.id; writeStore(s);
    state.status = "unlocked"; state.account = metaOf(rec);
    state.health = { ok: null, message: "Connecting…" };
    emit();
    await refresh().catch(() => {}); // first balance read happens before we return, so the UI shows real numbers immediately
    return state.account;
  }

  function lock() {
    sdk = null; state.status = hasVault() ? "locked" : "none";
    state.account = savedMeta();
    Object.assign(state, { balance: null, buyingPower: null, assetValue: null, bal: null, positions: [], positionsAt: 0, orders: [], lastRefresh: 0, lastOk: 0, health: { ok: null, message: "" } });
    emit();
  }
  function remove() {
    writeStore({ active: null, list: [] });
    lock(); state.status = "none"; state.account = null; emit();
  }
  const isUnlocked = () => state.status === "unlocked" && !!sdk;
  const client = () => sdk;

  /* ---------- parsing helpers ---------- */
  // The API returns positions as a map {marketSlug: position}; tolerate an array too.
  function normalisePositions(raw) {
    const entries = Array.isArray(raw) ? raw.map(p => [p?.marketMetadata?.slug || p?.marketSlug || p?.slug, p]) : Object.entries(raw || {});
    const out = [];
    for (const [slug, p] of entries) {
      if (!slug || !p) continue;
      const net = num(p.netPositionDecimal) ?? num(p.netPosition);
      if (!net || Math.abs(net) < 1e-9 || p.expired) continue;
      out.push({ slug, qty: Math.abs(net), side: net > 0 ? "YES" : "NO", cost: amt(p.cost), cashValue: amt(p.cashValue), title: p.marketMetadata?.title || p.marketMetadata?.outcome || slug });
    }
    return out;
  }

  // Turns a create-order / close-position response into something the bot can act on. A synchronous response
  // holds several executions (NEW, then FILL...), so fills are summed rather than reading just the first.
  function parseOrderResult(res) {
    const ex = Array.isArray(res?.executions) ? res.executions : [];
    const fills = ex.filter(e => /FILL$/.test(e.type || "") && num(e.lastShares) > 0);
    const qty = fills.reduce((s, e) => s + num(e.lastShares), 0);
    const px = qty > 0 ? fills.reduce((s, e) => s + num(e.lastShares) * (amt(e.lastPx) ?? 0), 0) / qty : null;
    const rej = ex.find(e => e.type === "EXECUTION_TYPE_REJECTED");
    const terminal = ex.some(e => /CANCELED|EXPIRED|REJECTED|DONE_FOR_DAY/.test(e.type || ""));
    return {
      id: res?.id || null, filledQty: qty, avgPx: px && px > 0 ? px : null,
      rejected: !!rej, reason: rej ? (rej.text || (rej.orderRejectReason || "").replace("ORD_REJECT_REASON_", "").replace(/_/g, " ").toLowerCase() || "rejected") : "",
      terminal, hadExecutions: ex.length > 0,
    };
  }

  // Polymarket US documents these balance fields. There is NO documented bonus or withdrawable field, so anything extra
  // the API returns is kept and shown under its own name, and "withdrawable" is offered only as a labelled estimate.
  const KNOWN = new Set(["currentBalance", "currency", "lastUpdated", "buyingPower", "assetNotional", "assetAvailable", "pendingCredit", "openOrders", "unsettledFunds", "pendingWithdrawals", "marginRequirement", "balanceReservation"]);
  function parseBalance(row) {
    const n = k => num(row?.[k]);
    const cash = n("currentBalance") ?? 0;
    const wds = Array.isArray(row?.pendingWithdrawals) ? row.pendingWithdrawals : [];
    const wdTotal = wds.reduce((s, w) => s + (amt(w?.balance) ?? 0), 0);
    const openOrders = n("openOrders") ?? 0, unsettled = n("unsettledFunds") ?? 0, reservation = n("balanceReservation") ?? 0;
    const extras = {};
    for (const [k, v] of Object.entries(row || {})) {
      if (KNOWN.has(k)) continue;
      const val = (v && typeof v === "object" && "value" in v) ? v.value : v;
      if ((typeof val === "number" || (typeof val === "string" && val !== "")) && typeof v !== "boolean") extras[k] = val;
    }
    const pick = re => { for (const [k, v] of Object.entries(extras)) if (re.test(k) && num(v) != null) return { key: k, value: num(v) }; return null; };
    return {
      cash, buyingPower: n("buyingPower") ?? 0, assetNotional: n("assetNotional"), assetAvailable: n("assetAvailable"),
      pendingCredit: n("pendingCredit"), openOrders, unsettled, margin: n("marginRequirement"), reservation,
      pendingWithdrawals: wdTotal, extras, bonus: pick(/bonus|promo|reward/i), withdrawableReported: pick(/withdraw/i),
      withdrawableEst: Math.max(0, Number((cash - openOrders - unsettled - wdTotal - reservation).toFixed(2))),
      lastUpdated: row?.lastUpdated || null, raw: row,
    };
  }

  /* ---------- refresh (balance, positions, open orders) ---------- */
  function refresh() {
    if (!isUnlocked()) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const [balRes, posRes, ordRes] = await Promise.allSettled([sdk.balances(), sdk.positions(), sdk.openOrders()]);
        state.lastRefresh = Date.now();
        if (balRes.status === "fulfilled") {
          const rows = balRes.value?.balances || [];
          const row = rows.find(b => !b.currency || b.currency === "USD") || rows[0];
          if (row) { const b = parseBalance(row); state.bal = b; state.balance = b.cash; state.buyingPower = b.buyingPower; state.assetValue = b.assetNotional; }
          state.lastOk = Date.now(); state.health = { ok: true, message: "" };
        } else {
          state.health = { ok: false, message: balRes.reason?.message || "Couldn't load balance." };
        }
        if (posRes.status === "fulfilled") { state.positions = normalisePositions(posRes.value?.positions); state.positionsAt = Date.now(); }
        if (ordRes.status === "fulfilled") state.orders = ordRes.value?.orders || [];
      } finally { inflight = null; emit(); }
    })();
    return inflight;
  }

  /* ---------- trading ---------- */
  function need() { if (!isUnlocked()) throw new Error("Unlock your Polymarket US account first."); }
  // side: "YES" (long) or "NO" (short). usd: dollar stake. Market order, immediate-or-cancel, blocks until it resolves.
  async function buyMarket({ marketSlug, side, usd }) {
    need();
    const res = await sdk.createOrder({
      marketSlug, intent: side === "NO" ? "ORDER_INTENT_BUY_SHORT" : "ORDER_INTENT_BUY_LONG", type: "ORDER_TYPE_MARKET",
      cashOrderQty: { value: String(usd), currency: "USD" }, tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC", synchronousExecution: true, maxBlockTime: "5",
    });
    return parseOrderResult(res);
  }
  // Sells the entire position in a market at market price (stop-loss, timeout, target hit, or manual close).
  async function closeNow({ marketSlug }) {
    need();
    const res = await sdk.closePosition({ marketSlug, manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC", synchronousExecution: true, maxBlockTime: "5" });
    return parseOrderResult(res);
  }
  async function cancelAllOpen() { need(); return sdk.cancelAllOpen(); }

  state.status = hasVault() ? "locked" : "none";
  state.account = savedMeta();

  return { state, on, savedMeta, hasVault, save, unlock, lock, remove, refresh, buyMarket, closeNow, cancelAllOpen, isUnlocked, client, parseOrderResult, normalisePositions, parseBalance };
})();
