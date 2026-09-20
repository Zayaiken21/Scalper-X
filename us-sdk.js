/* Polymarket US client — Ed25519-signed REST for trading, plain REST for market data.
 *
 * Two hosts, per Polymarket US's docs (docs.polymarket.us/api-reference/introduction):
 *   api.polymarket.us      AUTHENTICATED  orders, portfolio, account balances   (signed requests)
 *   gateway.polymarket.us  PUBLIC         markets, order book, BBO              (no key needed)
 *
 * Why REST polling and not WebSockets: their streams (/v1/ws/private, /v1/ws/markets) authenticate with
 * X-PM-* headers on the WebSocket handshake. Browsers can't set custom headers on a WebSocket upgrade, so
 * a static page can't use them. Everything here is throttled polling that stays well under the published
 * limit of 20 requests/second per API key.
 *
 * Signing: base64(Ed25519.sign(secretSeed, timestampMs + METHOD + path)) — path only, no query string.
 * The timestamp must be within 30 seconds of Polymarket's clock.
 */
window.PolyUS = (() => {
  const API = "https://api.polymarket.us";
  const GATEWAY = "https://gateway.polymarket.us";

  class PolyError extends Error {
    constructor(message, kind, status) { super(message); this.name = "PolyError"; this.kind = kind || "http"; this.status = status || 0; }
  }

  /* ---------- Ed25519 signing via native WebCrypto ---------- */
  const enc = new TextEncoder();
  const bytesToB64 = buf => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
  function b64ToBytes(input) {
    let s = String(input || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
    catch { throw new PolyError("That secret isn't valid base64. Copy it again from polymarket.us/developer.", "input"); }
  }
  // Fixed 16-byte PKCS8 header for an Ed25519 private key (OID 1.3.101.112) so WebCrypto accepts a bare 32-byte seed.
  const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

  async function importSecret(secretKeyB64) {
    if (!window.crypto?.subtle) throw new PolyError("Signing needs HTTPS. Open this app from its https:// address.", "input");
    const raw = b64ToBytes(secretKeyB64);
    if (raw.length !== 32 && raw.length !== 64) throw new PolyError(`That doesn't look like a Polymarket US secret key (decoded to ${raw.length} bytes; expected 64).`, "input");
    const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32); // 64-byte key = seed(32) + public key(32); only the seed is needed
    der.set(PKCS8_ED25519_PREFIX, 0); der.set(raw.slice(0, 32), PKCS8_ED25519_PREFIX.length);
    try { return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "Ed25519" }, false, ["sign"]); }
    catch { throw new PolyError("This browser can't do Ed25519 signing yet — update Chrome/Safari (Safari 17+, Chrome 137+) and try again.", "input"); }
  }
  async function sign(cryptoKey, keyId, method, path) {
    const timestamp = String(Date.now());
    const sig = await crypto.subtle.sign("Ed25519", cryptoKey, enc.encode(`${timestamp}${method}${path}`));
    return { "X-PM-Access-Key": keyId, "X-PM-Timestamp": timestamp, "X-PM-Signature": bytesToB64(sig) };
  }

  /* ---------- shared rate limiter: token bucket, ~6 req/s sustained, bursts of 4 (limit is 20/s), plus a global cool-down on 429 ---------- */
  const RATE = 6, BURST = 4;
  let tokens = BURST, lastFill = Date.now(), cooldownUntil = 0, pumping = false, last429 = 0;
  const queue = [];
  function pump() {
    if (pumping) return; pumping = true;
    const step = () => {
      const now = Date.now();
      if (now < cooldownUntil) return void setTimeout(step, cooldownUntil - now);
      tokens = Math.min(BURST, tokens + ((now - lastFill) / 1000) * RATE); lastFill = now;
      while (queue.length && tokens >= 1) { tokens -= 1; queue.shift()(); }
      if (queue.length) setTimeout(step, 100); else pumping = false;
    };
    step();
  }
  const acquire = () => new Promise(res => { queue.push(res); pump(); });

  /* ---------- core request ---------- */
  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      for (const item of Array.isArray(v) ? v : [v]) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
  }
  const hostOf = base => base.replace("https://", "");

  async function http(base, method, path, { query, body, signer, retries = 3, timeoutMs = 12000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      const headers = signer ? await signer(method, path) : {}; // fresh timestamp on every attempt
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(base + path + qs(query), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store", signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        if (e?.name === "AbortError") throw new PolyError(`${hostOf(base)} didn't answer within ${Math.round(timeoutMs / 1000)}s.`, "timeout");
        if (navigator.onLine === false) throw new PolyError("You're offline.", "network");
        throw new PolyError(`Couldn't reach ${hostOf(base)}. If your connection is fine, the browser may be blocking the request (CORS).`, "network");
      }
      clearTimeout(timer);
      if (res.status === 429) { // rejected, not processed — safe to retry. Docs: wait >= 1s, then exponential backoff.
        if (attempt >= retries) throw new PolyError("Polymarket US is rate-limiting requests. The app will retry shortly.", "rate", 429);
        last429 = Date.now(); cooldownUntil = Date.now() + 1000 * 2 ** attempt + Math.random() * 400;
        continue;
      }
      let json = null; try { const t = await res.text(); json = t ? JSON.parse(t) : null; } catch {}
      if (res.ok) return json;
      const msg = (json && (json.message || json.error)) || `Polymarket US returned ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new PolyError(`Polymarket US rejected the request (${res.status}). Check the Key ID and secret, that your phone's date & time are set to automatic (signatures must be within 30 seconds of their clock), and that you're in a supported US location.`, "auth", res.status);
      }
      const err = new PolyError(msg, res.status >= 500 ? "server" : "http", res.status);
      // Their 5-second latency stopgap rejects with this text but is NOT a real rate limit (per their docs).
      err.transient = /Global Rate Limit Exceeded/i.test(String(msg));
      throw err;
    }
  }

  /* ---------- public surface ---------- */
  const enc1 = encodeURIComponent;
  function publicClient() {
    const get = (path, query) => http(GATEWAY, "GET", path, { query });
    return {
      markets: params => get("/v1/markets", params),
      marketBySlug: slug => get(`/v1/market/slug/${enc1(slug)}`),
      bbo: slug => get(`/v1/markets/${enc1(slug)}/bbo`),
    };
  }
  function client(keyId, cryptoKey) {
    const signer = (method, path) => sign(cryptoKey, keyId, method, path);
    const call = (method, path, opts) => http(API, method, path, { ...opts, signer });
    return {
      ...publicClient(),
      balances: () => call("GET", "/v1/account/balances"),
      positions: market => call("GET", "/v1/portfolio/positions", { query: market ? { market } : undefined }),
      openOrders: () => call("GET", "/v1/orders/open"),
      createOrder: payload => call("POST", "/v1/orders", { body: payload, retries: 2, timeoutMs: 20000 }),
      cancelOrder: (id, marketSlug) => call("POST", `/v1/order/${enc1(id)}/cancel`, { body: { marketSlug } }),
      cancelAllOpen: () => call("POST", "/v1/orders/open/cancel", { body: {} }),
      closePosition: payload => call("POST", "/v1/order/close-position", { body: payload, retries: 2, timeoutMs: 20000 }),
    };
  }

  const rateInfo = () => ({ last429 });
  return { PolyError, importSecret, client, publicClient, rateInfo, API, GATEWAY };
})();
