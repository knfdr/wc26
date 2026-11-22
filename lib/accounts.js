// Per-person data: each signed-in person's own Kalshi API key and their own bet-sizing settings.
//
// Stored in the USERS KV namespace, keyed by email:
//   kalshi:<email>    { iv, ct }  AES-GCM encrypted { keyId, privateKey, env, maxOrderDollars }
//   settings:<email>  JSON settings (base bets, grade bars, ...)
// The encryption key is derived (HKDF-SHA256) from the USER_KEYS_SECRET Pages secret, and the email is bound in as
// additional data, so a blob can't be read without the secret or moved onto someone else's account.
// Private keys are write-only: nothing here ever returns one to a browser.
//
// The owner's Kalshi key in the Pages env (KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY) is used for the owner only, and only
// when they haven't saved one of their own here. Nobody else's request is ever signed with it.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const storageReady = (env) => !!(env.USERS && env.USER_KEYS_SECRET);
const kv = (env) => env.USERS;

async function aesKey(env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.USER_KEYS_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("sharp-sim"), info: enc.encode("kalshi-creds-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function seal(env, email, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(email) }, await aesKey(env), enc.encode(JSON.stringify(obj)));
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
export async function unseal(env, email, box) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: enc.encode(email) }, await aesKey(env), unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

export const DEFAULT_MAX_ORDER = 25;
export const MAX_ORDER_LIMIT = 1000; // the most anyone can set their own per-bet cap to

// A person's own saved Kalshi key, decrypted, or null.
export async function savedKalshi(env, email) {
  if (!storageReady(env)) return null;
  const box = await kv(env).get("kalshi:" + email, "json");
  if (!box) return null;
  try { return await unseal(env, email, box); } catch (e) { return null; }
}
export async function saveKalshi(env, email, creds) { await kv(env).put("kalshi:" + email, JSON.stringify(await seal(env, email, creds))); }
export async function deleteKalshi(env, email) { await kv(env).delete("kalshi:" + email); }

// The Kalshi "env" to sign this person's requests with (the shape lib/kalshi.js expects), or null if they have no key.
// KALSHI_TRADING_ENABLED stays the site-wide kill switch for everyone.
export async function kalshiEnvFor(env, user) {
  if (!user || !user.role) return null;
  const own = await savedKalshi(env, user.email);
  if (own) return { source: "own", KALSHI_API_KEY_ID: own.keyId, KALSHI_PRIVATE_KEY: own.privateKey, KALSHI_ENV: own.env || "prod",
    KALSHI_MAX_ORDER_DOLLARS: String(own.maxOrderDollars || DEFAULT_MAX_ORDER), KALSHI_TRADING_ENABLED: env.KALSHI_TRADING_ENABLED };
  if (user.role === "owner" && (env.KALSHI_API_KEY_ID || env.KALSHI_API_KEY) && env.KALSHI_PRIVATE_KEY)
    return { source: "site", KALSHI_API_KEY_ID: env.KALSHI_API_KEY_ID || env.KALSHI_API_KEY, KALSHI_PRIVATE_KEY: env.KALSHI_PRIVATE_KEY,
      KALSHI_ENV: env.KALSHI_ENV || "prod", KALSHI_MAX_ORDER_DOLLARS: env.KALSHI_MAX_ORDER_DOLLARS || String(DEFAULT_MAX_ORDER), KALSHI_TRADING_ENABLED: env.KALSHI_TRADING_ENABLED };
  return null;
}

// Unsigned env for public market data when a person has no key (Kalshi's market endpoints are public).
export const publicKalshiEnv = (env) => ({ KALSHI_ENV: "prod" });

export async function readSettings(env, email) {
  if (!env.USERS) return null;
  return kv(env).get("settings:" + email, "json");
}
export async function writeSettings(env, email, s) { await kv(env).put("settings:" + email, JSON.stringify(s)); }
