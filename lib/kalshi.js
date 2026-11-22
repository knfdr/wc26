// Kalshi Trade API v2 client for Cloudflare Pages Functions.
// Auth: every request is signed with the account's private key:
//   KALSHI-ACCESS-KEY       = key id
//   KALSHI-ACCESS-TIMESTAMP = unix ms
//   KALSHI-ACCESS-SIGNATURE = base64(sign(timestamp + METHOD + path-without-query))
// Supports Ed25519 keys (PKCS#8) and RSA keys (PKCS#1 "BEGIN RSA PRIVATE KEY" or PKCS#8), RSA-PSS SHA-256.
//
// Env (Cloudflare Pages → Settings → Environment variables, as secrets):
//   KALSHI_API_KEY_ID        key id (uuid)
//   KALSHI_PRIVATE_KEY       the PEM text Kalshi gave you (literal "\n" sequences are fine)
//   KALSHI_ENV               "prod" (default) or "demo"
//   KALSHI_TRADING_ENABLED   must be "1" for any order to be sent (server-side kill switch)
//   KALSHI_MAX_ORDER_DOLLARS max cost of a single opening order (default 25)

export const BASES = {
  prod: "https://api.elections.kalshi.com",
  demo: "https://demo-api.kalshi.co",
};
export const PREFIX = "/trade-api/v2";
export const WS_PATH = "/trade-api/ws/v2";

function pemToDer(pem) {
  const text = pem.replace(/\\n/g, "\n");
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(text);
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, isPkcs1 };
}

function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = []; while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
// Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo so WebCrypto can import it.
function pkcs1ToPkcs8(pkcs1) {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const bodyLen = version.length + algId.length + octet.length + pkcs1.length;
  const out = new Uint8Array(1 + derLen(bodyLen).length + bodyLen);
  let o = 0;
  for (const b of [0x30, ...derLen(bodyLen), ...version, ...algId, ...octet]) out[o++] = b;
  out.set(pkcs1, o);
  return out;
}

let _keyCache = null;
async function getKey(env) {
  const pem = env.KALSHI_PRIVATE_KEY;
  if (!pem) throw new Error("KALSHI_PRIVATE_KEY not configured");
  if (_keyCache && _keyCache.pem === pem) return _keyCache;
  const { der, isPkcs1 } = pemToDer(pem);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;
  let key = null, alg = null;
  if (!isPkcs1) {
    try { key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]); alg = { name: "Ed25519" }; }
    catch (e) { key = null; }
  }
  if (!key) {
    key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    alg = { name: "RSA-PSS", saltLength: 32 };
  }
  _keyCache = { pem, key, alg };
  return _keyCache;
}

function b64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function hasCredentials(env) {
  return !!((env.KALSHI_API_KEY_ID || env.KALSHI_API_KEY) && env.KALSHI_PRIVATE_KEY);
}

export async function signedHeaders(env, method, fullPath) {
  const keyId = env.KALSHI_API_KEY_ID || env.KALSHI_API_KEY;
  if (!keyId) throw new Error("KALSHI_API_KEY_ID not configured");
  const { key, alg } = await getKey(env);
  const ts = String(Date.now());
  const pathOnly = fullPath.split("?")[0];
  const sig = await crypto.subtle.sign(alg, key, new TextEncoder().encode(ts + method.toUpperCase() + pathOnly));
  return { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": b64(sig) };
}

// path: relative to /trade-api/v2, e.g. "/portfolio/positions?limit=100"
export async function kalshiFetch(env, method, path, body, { sign = true } = {}) {
  const base = BASES[(env.KALSHI_ENV || "prod").toLowerCase()] || BASES.prod;
  const fullPath = PREFIX + path;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (sign) Object.assign(headers, await signedHeaders(env, method, fullPath));
  const r = await fetch(base + fullPath, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers };
}

// Server-side guard for order writes. Returns an error string, or null if the order may be sent.
export function checkOrder(env, order) {
  if (env.KALSHI_TRADING_ENABLED !== "1") return "Trading disabled on the server (set KALSHI_TRADING_ENABLED=1)";
  if (!order || typeof order !== "object") return "Missing order";
  const { ticker, side, count, price, time_in_force } = order;
  if (!ticker || !/^KX[A-Z0-9-]+$/.test(ticker)) return "Bad ticker";
  if (side !== "bid" && side !== "ask") return "side must be bid or ask";
  const n = parseFloat(count), p = parseFloat(price);
  if (!(n > 0) || !(p > 0 && p < 1)) return "Bad count/price";
  if (!["fill_or_kill", "good_till_canceled", "immediate_or_cancel"].includes(time_in_force)) return "Bad time_in_force";
  if (!order.reduce_only && !order.closing) {
    const cost = side === "bid" ? n * p : n * (1 - p);
    const max = parseFloat(env.KALSHI_MAX_ORDER_DOLLARS || "25");
    if (cost > max + 1e-9) return `Order cost $${cost.toFixed(2)} exceeds server cap $${max}`;
  }
  return null;
}

// Open an authenticated upstream WebSocket to Kalshi (Workers: fetch with Upgrade header).
export async function openKalshiSocket(env) {
  const base = BASES[(env.KALSHI_ENV || "prod").toLowerCase()] || BASES.prod;
  const headers = { Upgrade: "websocket", ...(await signedHeaders(env, "GET", WS_PATH)) };
  const resp = await fetch(base + WS_PATH, { headers });
  if (resp.status !== 101 || !resp.webSocket) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Kalshi WebSocket handshake failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  resp.webSocket.accept();
  return resp.webSocket;
}
