/* Polymarket US (api.polymarket.us) client — Ed25519-signed REST only.
 *
 * Why no WebSocket: their real-time feeds (/v1/ws/private, /v1/ws/markets) authenticate by
 * requiring X-PM-Access-Key / X-PM-Timestamp / X-PM-Signature headers ON THE WEBSOCKET HANDSHAKE
 * ITSELF. Browsers do not let JavaScript set custom headers on a WebSocket upgrade request — that's
 * a platform limitation, not something fixable here — so a static, backend-less page like this one
 * cannot use either stream. Everything below is careful, throttled REST polling instead, kept well
 * under their published 20 req/s per-key limit (see RateLimiter).
 *
 * Auth: every authenticated request needs three headers. The signature is
 * base64(Ed25519.sign(secretKey, timestamp + method + path)) — path only, no query string, per
 * Polymarket US's own docs and example code.
 */
window.PolyUS = (() => {
  const BASE = "https://api.polymarket.us";

  /* ---------- Ed25519 signing via native WebCrypto ---------- */
  const enc = new TextEncoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  // Fixed 16-byte PKCS8 header for an Ed25519 private key (OID 1.3.101.112), so we can hand
  // WebCrypto a plain 32-byte seed without a full ASN.1 encoder.
  const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

  async function importSecret(secretKeyB64) {
    if (!window.crypto?.subtle) throw new Error("Signing needs HTTPS. Open this app from its https:// address.");
    const raw = unb64(String(secretKeyB64 || "").trim());
    if (raw.length < 32) throw new Error("That doesn't look like a Polymarket US secret key.");
    const seed = raw.slice(0, 32); // the 64-byte key is seed(32) + public key(32); we only need the seed
    const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    der.set(PKCS8_ED25519_PREFIX, 0); der.set(seed, PKCS8_ED25519_PREFIX.length);
    try { return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "Ed25519" }, false, ["sign"]); }
    catch (e) { throw new Error("This browser can't do Ed25519 signing yet — update Chrome/Safari and try again."); }
  }

  async function sign(cryptoKey, method, path) {
    const timestamp = String(Date.now());
    const message = `${timestamp}${method}${path}`;
    const sig = await crypto.subtle.sign("Ed25519", cryptoKey, enc.encode(message));
    return { timestamp, signature: b64(sig) };
  }

  /* ---------- rate limiter: token bucket, well under the documented 20 req/s per key ---------- */
  const RATE = 7, BURST = 10; // ~7/s sustained, 10 burst — leaves wide headroom under their 20/s cap
  let tokens = BURST, lastFill = Date.now();
  const queue = [];
  function pump() {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - lastFill) / 1000) * RATE);
    lastFill = now;
    while (queue.length && tokens >= 1) { tokens -= 1; queue.shift()(); }
    if (queue.length) setTimeout(pump, 120);
  }
  function throttled() { return new Promise(res => { queue.push(res); pump(); }); }

  /* ---------- core request ---------- */
  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      for (const item of Array.isArray(v) ? v : [v]) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
  }

  async function request(cryptoKey, keyId, method, path, { query, body, retries = 2 } = {}) {
    await throttled();
    const { timestamp, signature } = await sign(cryptoKey, method, path);
    const url = BASE + path + qs(query);
    const headers = { "X-PM-Access-Key": keyId, "X-PM-Timestamp": timestamp, "X-PM-Signature": signature };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try { res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error("Couldn't reach Polymarket US — check your connection."); }
    if (res.status === 429) {
      if (retries <= 0) throw new Error("Polymarket US is rate-limiting us. Try again in a moment.");
      await new Promise(r => setTimeout(r, 800 + Math.random() * 800));
      return request(cryptoKey, keyId, method, path, { query, body, retries: retries - 1 });
    }
    if (res.status === 401) throw new Error("Polymarket US rejected these credentials (401). Re-check your Key ID/secret.");
    let json = null; try { json = await res.json(); } catch {}
    if (!res.ok) throw new Error(json?.message || json?.error || `Polymarket US returned ${res.status}`);
    return json;
  }

  /* ---------- public surface: pass {keyId, cryptoKey} as the first arg (see account.js) ---------- */
  function client(keyId, cryptoKey) {
    const call = (method, path, opts) => request(cryptoKey, keyId, method, path, opts);
    return {
      // Markets — a single list call carries bestBid/bestAsk/lastTradePrice/volume for many markets
      // at once, which is why the scanner in strategy.js never needs to poll per-market BBO.
      markets: params => call("GET", "/v1/markets", { query: params }),
      marketBySlug: slug => call("GET", `/v1/market/slug/${encodeURIComponent(slug)}`),
      book: slug => call("GET", `/v1/markets/${encodeURIComponent(slug)}/book`),
      bbo: slug => call("GET", `/v1/markets/${encodeURIComponent(slug)}/bbo`),

      // Account / portfolio
      balances: () => call("GET", "/v1/account/balances"),
      positions: (marketSlug) => call("GET", "/v1/portfolio/positions", { query: marketSlug ? { marketSlug } : undefined }),

      // Orders
      openOrders: () => call("GET", "/v1/orders/open"),
      order: id => call("GET", `/v1/order/${encodeURIComponent(id)}`),
      createOrder: payload => call("POST", "/v1/orders", { body: payload }),
      cancelOrder: id => call("POST", `/v1/order/${encodeURIComponent(id)}/cancel`),
      cancelAllOpen: () => call("POST", "/v1/orders/open/cancel"),
      closePosition: payload => call("POST", "/v1/order/close-position", { body: payload }),
    };
  }

  return { importSecret, client, BASE };
})();
