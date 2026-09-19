/* BlueEdge US account: Polymarket US API key (Key ID + Ed25519 secret), encrypted on this device
 * behind a passcode — same PBKDF2-SHA256 + AES-GCM pattern the previous BlueEdge build used for
 * wallet keys. The secret never leaves this device unencrypted and is never sent anywhere except
 * as a signature (see us-sdk.js) attached to Polymarket US's own API calls.
 */
window.BlueEdgeAccount = (() => {
  const STORE = "blueedgeus.accounts.v1";
  const ITER = 310000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  const state = {
    status: "none", message: "",             // none | locked | unlocked
    account: null,                            // {id,label,keyId,updatedAt}
    balance: null, buyingPower: null,
    positions: [], orders: [], closed: [],
    lastRefresh: 0, refreshing: false,
  };
  let sdk = null; // PolyUS.client(...) once unlocked
  const listeners = [];
  const on = fn => listeners.push(fn);
  const emit = () => listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } });

  /* ---------- store ---------- */
  function readStore() { let s; try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch {} if (!s) s = { active: null, list: [] }; s.list = Array.isArray(s.list) ? s.list : []; return s; }
  function writeStore(s) { localStorage.setItem(STORE, JSON.stringify(s)); }
  const metaOf = r => r && ({ id: r.id, label: r.label, keyId: r.keyId, updatedAt: r.updatedAt });
  const list = () => readStore().list.map(metaOf);
  const hasVault = () => readStore().list.length > 0;

  /* ---------- crypto (identical scheme to the crypto build's live.js) ---------- */
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
    catch { throw new Error("Wrong passcode for this account."); }
  }

  /* ---------- save / connect ---------- */
  async function save({ label, keyId, secretKey, passcode }) {
    keyId = String(keyId || "").trim();
    secretKey = String(secretKey || "").replace(/\s+/g, "");
    if (!keyId) throw new Error("Enter your Polymarket US Key ID.");
    if (!secretKey) throw new Error("Enter your Polymarket US secret key.");
    if (!passcode || passcode.length < 4) throw new Error("Choose a passcode (4+ characters) to encrypt this key on your device.");
    await PolyUS.importSecret(secretKey); // fail fast if it's not a usable Ed25519 secret, before we store anything
    const sealed = await seal({ keyId, secretKey }, passcode);
    const s = readStore();
    const id = "acc_" + Date.now().toString(36);
    const rec = { id, label: label || "Polymarket US", keyId, updatedAt: Date.now(), ...sealed };
    s.list.push(rec); s.active = id; writeStore(s);
    return unlock(id, passcode);
  }

  async function unlock(id, passcode) {
    const s = readStore();
    const rec = s.list.find(r => r.id === id) || s.list[0];
    if (!rec) throw new Error("No saved account. Connect one first.");
    const payload = await openRecord(rec, passcode);
    const cryptoKey = await PolyUS.importSecret(payload.secretKey);
    sdk = PolyUS.client(payload.keyId, cryptoKey);
    s.active = rec.id; writeStore(s);
    state.status = "unlocked"; state.account = metaOf(rec); state.message = "";
    emit();
    refresh().catch(() => {});
    return state.account;
  }

  function lock() { sdk = null; state.status = hasVault() ? "locked" : "none"; state.balance = null; state.positions = []; state.orders = []; emit(); }
  function remove(id) {
    const s = readStore(); s.list = s.list.filter(r => r.id !== id);
    if (s.active === id) s.active = s.list[0]?.id || null;
    writeStore(s);
    if (state.account?.id === id) lock();
  }
  const isUnlocked = () => state.status === "unlocked" && !!sdk;
  const canTrade = () => isUnlocked();

  /* ---------- refresh ---------- */
  async function refresh() {
    if (!isUnlocked() || state.refreshing) return;
    state.refreshing = true; emit();
    try {
      const [balRes, posRes, ordRes] = await Promise.allSettled([sdk.balances(), sdk.positions(), sdk.openOrders()]);
      if (balRes.status === "fulfilled") {
        const row = balRes.value?.balances?.[0];
        if (row) { state.balance = Number(row.currentBalance) || 0; state.buyingPower = Number(row.buyingPower) || 0; }
      } else state.message = balRes.reason?.message || "Couldn't load balance.";
      if (posRes.status === "fulfilled") state.positions = posRes.value?.positions || posRes.value?.data || [];
      if (ordRes.status === "fulfilled") state.orders = ordRes.value?.orders || ordRes.value?.data || [];
      state.lastRefresh = Date.now();
    } finally { state.refreshing = false; emit(); }
  }

  /* ---------- trading ---------- */
  // side: "YES" (long) or "NO" (short). usd: dollar stake for a market buy.
  async function buyMarket({ marketSlug, side, usd }) {
    if (!isUnlocked()) throw new Error("Unlock your Polymarket US account first.");
    const intent = side === "NO" ? "ORDER_INTENT_BUY_SHORT" : "ORDER_INTENT_BUY_LONG";
    return sdk.createOrder({
      marketSlug, intent, type: "ORDER_TYPE_MARKET",
      cashOrderQty: { value: String(usd), currency: "USD" },
      tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
      synchronousExecution: true, maxBlockTime: "5",
    });
  }
  // Resting limit sell at a target price — the actual "scalp": exit once odds have risen enough.
  async function sellLimit({ marketSlug, side, price, quantity }) {
    if (!isUnlocked()) throw new Error("Unlock your Polymarket US account first.");
    const intent = side === "NO" ? "ORDER_INTENT_SELL_SHORT" : "ORDER_INTENT_SELL_LONG";
    return sdk.createOrder({
      marketSlug, intent, type: "ORDER_TYPE_LIMIT",
      price: { value: String(price), currency: "USD" },
      quantity,
      tif: "TIME_IN_FORCE_GOOD_TILL_CANCEL",
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
    });
  }
  // Immediate market exit — used for stop-loss and max-hold timeouts, where getting out matters
  // more than the exact price.
  async function closeNow({ marketSlug, bips = 200 }) {
    if (!isUnlocked()) throw new Error("Unlock your Polymarket US account first.");
    return sdk.closePosition({ marketSlug, synchronousExecution: true, maxBlockTime: "5", slippageTolerance: { bips } });
  }
  async function cancelOrder(id) { if (!isUnlocked()) return; return sdk.cancelOrder(id); }
  function marketsScan(params) { if (!isUnlocked()) throw new Error("Unlock your Polymarket US account first."); return sdk.markets(params); }
  // Used when a held position's market has fallen out of the ranked scan window — we must always
  // be able to see a price for anything we're holding, so we can still act on stop-loss/timeout.
  function marketBySlug(slug) { if (!isUnlocked()) throw new Error("Unlock your Polymarket US account first."); return sdk.marketBySlug(slug); }

  // boot: if a saved account exists, sit "locked" until the passcode is entered
  state.status = hasVault() ? "locked" : "none";

  return {
    state, on, list, hasVault, save, unlock, lock, remove, refresh,
    buyMarket, sellLimit, closeNow, cancelOrder, marketsScan, marketBySlug,
    isUnlocked, canTrade,
  };
})();
